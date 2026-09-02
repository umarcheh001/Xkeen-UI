"""UI settings storage (persisted in UI_STATE_DIR).

This module provides a small, safe infrastructure for storing UI preferences
(server-side) without changing existing UI behavior yet.

Intended usage (next commits):
- GET /api/ui-settings -> load_settings()
- PATCH /api/ui-settings -> patch_settings()

Storage file:
  UI_STATE_DIR/ui-settings.json

Defaults are kept minimal and backward-compatible.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

from core.paths import UI_STATE_DIR
from services.io import read_json, safe_write_text
from utils.deep_merge import deep_merge


log = logging.getLogger(__name__)


SCHEMA_VERSION = 2

# Keep the file small and predictable on router flash.
_MAX_FILE_CHARS = 64 * 1024

# Keep user-provided "view" prefs bounded. This prevents accidentally persisting
# large objects (e.g. whole logs, huge tables, etc.).
_MAX_VIEW_KEYS = 80
_MAX_VIEW_KEY_LEN = 64
_MAX_VIEW_VALUE_CHARS = 8 * 1024
_MAX_VIEW_NESTED_KEYS = 50
_MAX_MIHOMO_COLLAPSED_GROUPS = 256
_MAX_MIHOMO_GROUP_NAME_LEN = 256


DEFAULTS: Dict[str, Any] = {
    "schemaVersion": SCHEMA_VERSION,
    "editor": {
        # Supported engines (today): 'codemirror'. Future: 'monaco'.
        "engine": "codemirror",
        # Per-editor font scale. 100 keeps existing defaults,
        # lower values make text smaller, higher values make it larger.
        "codemirrorFontScale": 100,
        "monacoFontScale": 100,
        # Show JSON Schema hover popups in CodeMirror editors. Validation,
        # lint markers and autocomplete stay enabled when this is off.
        "schemaHoverEnabled": True,
        # Beginner-friendly hover mode (Phase 5): enriches hover and diagnostics
        # with plain-language explanations, typical use cases, short examples
        # and common-mistake warnings sourced from `x-ui-*` metadata in schemas.
        "beginnerModeEnabled": True,
        # Expert mode disables Xkeen editor assistance layers and quick-fix UI.
        "expertModeEnabled": False,
    },
    "format": {
        # Prefer browser-side formatting (Prettier) where available.
        # Default OFF to preserve current behavior.
        "preferPrettier": False,
        # Prettier formatting options (optional)
        "tabWidth": 2,
        "printWidth": 80,
    },
    "logs": {
        # Render ANSI colors in UI (future feature flag).
        "ansi": False,
        # Use new WS2 protocol endpoint when available.
        # Default OFF to preserve current behavior.
        "ws2": False,
        # Xray logs view preferences (migrated from localStorage in Commit 14).
        # Keep empty by default so we can detect "unset" state and seed from legacy
        # client storage on first use.
        "view": {},
    },
    "routing": {
        # Show extra GUI layer for routing rules card.
        # Default OFF: this is optional UI sugar and can be heavier on weak devices.
        "guiEnabled": False,
        # Auto-apply routing card edits back into the JSON editor.
        # Default OFF: let users opt in to the extra sync work explicitly.
        "autoApply": False,
        # Show runtime-selected outbound in the 04_outbounds proxy card.
        # Default OFF: it depends on Xray logs and adds polling while the card is open.
        "showActiveOutbound": False,
        # Show the routing scenario helper card.
        # Default ON to preserve the existing panel layout.
        "showScenarioCard": True,
        # Раскладка окна DNS-over-VLESS: "auto" — две колонки, если помещаются,
        # "single" — всегда одна, "split" — всегда две. Ниже 1100 px любая
        # раскладка схлопывается в одну колонку: на планшете двух колонок нет.
        "dnsOverVlessLayout": "auto",
    },
    "mihomo": {
        # Hide nodes only after Mihomo itself reports a stable run of timeout
        # samples.  The samples remain in Mihomo's in-memory delay history;
        # ui-settings persists only these two preferences.
        "hideUnavailable": False,
        "consecutiveTimeouts": 3,
        # Clash API workspace presentation preferences. Latency history stays
        # in Mihomo; only bounded UI state is written to panel settings.
        "proxySortOrder": "config",
        "collapsedGroups": {},
        # The browser sends only an allow-listed preset id, never a custom URL.
        "latencyPreset": "auto",
        # Keep point-in-time latency useful without presenting it as live.
        # ``auto`` follows the provider/group health-check interval exposed by
        # the safe Clash DTO and falls back to five minutes.
        "latencyFreshness": "auto",
        # Router-safe per-node probing remains the default. Operators can opt
        # into Mihomo's one-request group endpoint for large groups.
        "latencyTestMode": "safe",
        # Match Zashboard's cutoffs: VLESS hops routinely land in the 300-700ms
        # band, which the previous 250/650 pair painted as slow or unusable.
        "latencyLowMs": 400,
        "latencyMediumMs": 800,
    },
}


@dataclass
class SettingsReport:
    warnings: List[Dict[str, str]]
    errors: List[Dict[str, str]]
    changed: bool = False


class UISettingsValidationError(ValueError):
    """Raised when PATCH payload is structurally invalid or fully rejected."""

    def __init__(self, message: str, *, errors: Optional[List[Dict[str, str]]] = None):
        super().__init__(message)
        self.errors = errors or []


def _is_int(v: Any) -> bool:
    # bool is a subclass of int; treat it as not an int here.
    return isinstance(v, int) and not isinstance(v, bool)


def _is_bool(v: Any) -> bool:
    return isinstance(v, bool)


def _as_lower_str(v: Any) -> Optional[str]:
    if not isinstance(v, str):
        return None
    s = v.strip().lower()
    return s if s else None


def _json_chars(v: Any) -> int:
    try:
        return len(json.dumps(v, ensure_ascii=False))
    except Exception:
        return 10**9


def _canonical_empty() -> Dict[str, Any]:
    """Create a canonical defaults dict with stable key ordering."""

    return {
        "schemaVersion": SCHEMA_VERSION,
        "editor": {
            "engine": DEFAULTS["editor"]["engine"],
            "codemirrorFontScale": int(DEFAULTS["editor"]["codemirrorFontScale"]),
            "monacoFontScale": int(DEFAULTS["editor"]["monacoFontScale"]),
            "schemaHoverEnabled": bool(DEFAULTS["editor"]["schemaHoverEnabled"]),
            "beginnerModeEnabled": bool(DEFAULTS["editor"]["beginnerModeEnabled"]),
            "expertModeEnabled": bool(DEFAULTS["editor"]["expertModeEnabled"]),
        },
        "format": {
            "preferPrettier": bool(DEFAULTS["format"]["preferPrettier"]),
            "tabWidth": int(DEFAULTS["format"]["tabWidth"]),
            "printWidth": int(DEFAULTS["format"]["printWidth"]),
        },
        "logs": {
            "ansi": bool(DEFAULTS["logs"]["ansi"]),
            "ws2": bool(DEFAULTS["logs"]["ws2"]),
            "view": {},
        },
        "routing": {
            "guiEnabled": bool(DEFAULTS["routing"]["guiEnabled"]),
            "autoApply": bool(DEFAULTS["routing"]["autoApply"]),
            "showActiveOutbound": bool(DEFAULTS["routing"]["showActiveOutbound"]),
            "showScenarioCard": bool(DEFAULTS["routing"]["showScenarioCard"]),
            "dnsOverVlessLayout": str(DEFAULTS["routing"]["dnsOverVlessLayout"]),
        },
        "mihomo": {
            "hideUnavailable": bool(DEFAULTS["mihomo"]["hideUnavailable"]),
            "consecutiveTimeouts": int(DEFAULTS["mihomo"]["consecutiveTimeouts"]),
            "proxySortOrder": str(DEFAULTS["mihomo"]["proxySortOrder"]),
            "collapsedGroups": {},
            "latencyPreset": str(DEFAULTS["mihomo"]["latencyPreset"]),
            "latencyFreshness": str(DEFAULTS["mihomo"]["latencyFreshness"]),
            "latencyTestMode": str(DEFAULTS["mihomo"]["latencyTestMode"]),
            "latencyLowMs": int(DEFAULTS["mihomo"]["latencyLowMs"]),
            "latencyMediumMs": int(DEFAULTS["mihomo"]["latencyMediumMs"]),
        },
    }


def _sanitize_mihomo_collapsed_groups(
    value: Any,
    *,
    report: SettingsReport,
    patch: bool = False,
) -> Dict[str, bool] | None:
    """Return a bounded group-name -> collapsed mapping."""

    if not isinstance(value, dict):
        if patch:
            report.errors.append({"path": "mihomo.collapsedGroups", "error": "must be an object"})
            return None
        report.warnings.append({"path": "mihomo.collapsedGroups", "warning": "must be an object"})
        report.changed = True
        return {}

    out: Dict[str, bool] = {}
    for raw_name, collapsed in list(value.items())[:_MAX_MIHOMO_COLLAPSED_GROUPS]:
        if not isinstance(raw_name, str):
            report.warnings.append({"path": "mihomo.collapsedGroups", "warning": "non-string group dropped"})
            report.changed = True
            continue
        name = raw_name.replace("\x00", "").strip()
        if not name or len(name) > _MAX_MIHOMO_GROUP_NAME_LEN or not _is_bool(collapsed):
            report.warnings.append({"path": "mihomo.collapsedGroups", "warning": "invalid group state dropped"})
            report.changed = True
            continue
        out[name] = bool(collapsed)
    if len(value) > _MAX_MIHOMO_COLLAPSED_GROUPS:
        report.warnings.append({"path": "mihomo.collapsedGroups", "warning": "too many groups; truncated"})
        report.changed = True
    return out


def _sanitize_view(view_in: Any, *, report: SettingsReport) -> Dict[str, Any]:
    """Allow a bounded JSON object for logs.view."""

    if view_in is None:
        return {}
    if not isinstance(view_in, dict):
        report.errors.append({"path": "logs.view", "error": "must be an object"})
        report.changed = True
        return {}

    out: Dict[str, Any] = {}

    # Cap keys to keep it small.
    items = list(view_in.items())
    if len(items) > _MAX_VIEW_KEYS:
        report.errors.append({"path": "logs.view", "error": "too many keys"})
        report.changed = True
        items = items[:_MAX_VIEW_KEYS]

    for k, v in items:
        if not isinstance(k, str):
            report.warnings.append({"path": "logs.view", "warning": "non-string key dropped"})
            report.changed = True
            continue
        kk = k.strip()
        if not kk:
            report.warnings.append({"path": "logs.view", "warning": "empty key dropped"})
            report.changed = True
            continue
        if len(kk) > _MAX_VIEW_KEY_LEN:
            report.warnings.append({"path": f"logs.view.{kk[:16]}…", "warning": "key too long"})
            report.changed = True
            continue

        # Allow primitives. Disallow lists/arrays to avoid accidental huge payloads.
        if v is None or isinstance(v, (str, int, float, bool)):
            out[kk] = v
            continue

        # Allow a small dict with primitive values (depth <= 2).
        if isinstance(v, dict):
            if len(v) > _MAX_VIEW_NESTED_KEYS:
                report.warnings.append({"path": f"logs.view.{kk}", "warning": "nested object too large"})
                report.changed = True
                continue
            nested: Dict[str, Any] = {}
            ok_nested = True
            for nk, nv in v.items():
                if not isinstance(nk, str) or not nk.strip():
                    ok_nested = False
                    break
                if nv is None or isinstance(nv, (str, int, float, bool)):
                    nested[nk.strip()] = nv
                else:
                    ok_nested = False
                    break
            if not ok_nested:
                report.warnings.append({"path": f"logs.view.{kk}", "warning": "nested value type rejected"})
                report.changed = True
                continue
            out[kk] = nested
            continue

        report.warnings.append({"path": f"logs.view.{kk}", "warning": "unsupported value type dropped"})
        report.changed = True

    if _json_chars(out) > _MAX_VIEW_VALUE_CHARS:
        report.errors.append({"path": "logs.view", "error": "object too large"})
        report.changed = True
        return {}

    return out


def _sanitize_full(raw: Any) -> Tuple[Dict[str, Any], SettingsReport]:
    """Normalize an on-disk config to the latest schema and allowlist."""

    rep = SettingsReport(warnings=[], errors=[], changed=False)

    if not isinstance(raw, dict):
        rep.warnings.append({"path": "<root>", "warning": "root is not an object; reset to defaults"})
        rep.changed = True
        raw = {}

    out = _canonical_empty()

    # ---- schemaVersion ----
    sv = raw.get("schemaVersion")
    if sv is None:
        # v0 -> v1 migration: simply add schemaVersion.
        rep.changed = True
    elif not _is_int(sv):
        rep.warnings.append({"path": "schemaVersion", "warning": "invalid type; reset"})
        rep.changed = True
    else:
        # Even if someone writes a higher version, we normalize to the current schema.
        if int(sv) != SCHEMA_VERSION:
            rep.changed = True
        out["schemaVersion"] = SCHEMA_VERSION

    # ---- editor ----
    editor = raw.get("editor")
    if editor is None:
        pass
    elif not isinstance(editor, dict):
        rep.warnings.append({"path": "editor", "warning": "must be an object; reset"})
        rep.changed = True
    else:
        engine = _as_lower_str(editor.get("engine"))
        if engine is None:
            pass
        else:
            allowed = {"codemirror", "monaco"}
            if engine not in allowed:
                rep.warnings.append({"path": "editor.engine", "warning": "unsupported engine; reset"})
                rep.changed = True
            else:
                out["editor"]["engine"] = engine

        legacy_font_scale = None
        if "fontScale" in editor:
            font_scale = editor.get("fontScale")
            if _is_int(font_scale) and 75 <= int(font_scale) <= 200:
                legacy_font_scale = int(font_scale)
                rep.changed = True
            else:
                rep.warnings.append({"path": "editor.fontScale", "warning": "invalid value; ignored"})
                rep.changed = True

        cm_scale_present = "codemirrorFontScale" in editor
        if cm_scale_present:
            cm_scale = editor.get("codemirrorFontScale")
            if _is_int(cm_scale) and 75 <= int(cm_scale) <= 200:
                out["editor"]["codemirrorFontScale"] = int(cm_scale)
            else:
                rep.warnings.append({"path": "editor.codemirrorFontScale", "warning": "invalid value; ignored"})
                rep.changed = True
        elif legacy_font_scale is not None:
            out["editor"]["codemirrorFontScale"] = int(legacy_font_scale)
            rep.changed = True

        monaco_scale_present = "monacoFontScale" in editor
        if monaco_scale_present:
            monaco_scale = editor.get("monacoFontScale")
            if _is_int(monaco_scale) and 75 <= int(monaco_scale) <= 200:
                out["editor"]["monacoFontScale"] = int(monaco_scale)
            else:
                rep.warnings.append({"path": "editor.monacoFontScale", "warning": "invalid value; ignored"})
                rep.changed = True
        elif legacy_font_scale is not None:
            out["editor"]["monacoFontScale"] = int(legacy_font_scale)
            rep.changed = True

        schema_hover_enabled = editor.get("schemaHoverEnabled")
        if schema_hover_enabled is not None:
            if _is_bool(schema_hover_enabled):
                out["editor"]["schemaHoverEnabled"] = bool(schema_hover_enabled)
            else:
                rep.warnings.append({"path": "editor.schemaHoverEnabled", "warning": "invalid type; ignored"})
                rep.changed = True

        beginner_mode_enabled = editor.get("beginnerModeEnabled")
        if beginner_mode_enabled is not None:
            if _is_bool(beginner_mode_enabled):
                out["editor"]["beginnerModeEnabled"] = bool(beginner_mode_enabled)
            else:
                rep.warnings.append({"path": "editor.beginnerModeEnabled", "warning": "invalid type; ignored"})
                rep.changed = True

        expert_mode_enabled = editor.get("expertModeEnabled")
        if expert_mode_enabled is not None:
            if _is_bool(expert_mode_enabled):
                out["editor"]["expertModeEnabled"] = bool(expert_mode_enabled)
            else:
                rep.warnings.append({"path": "editor.expertModeEnabled", "warning": "invalid type; ignored"})
                rep.changed = True

        for k in editor.keys():
            if k not in ("engine", "fontScale", "codemirrorFontScale", "monacoFontScale", "schemaHoverEnabled", "beginnerModeEnabled", "expertModeEnabled"):
                rep.warnings.append({"path": f"editor.{k}", "warning": "unknown key dropped"})
                rep.changed = True

    # ---- format ----
    fmt = raw.get("format")
    if fmt is None:
        pass
    elif not isinstance(fmt, dict):
        rep.warnings.append({"path": "format", "warning": "must be an object; reset"})
        rep.changed = True
    else:
        pp = fmt.get("preferPrettier")
        if pp is not None:
            if _is_bool(pp):
                out["format"]["preferPrettier"] = bool(pp)
            else:
                rep.warnings.append({"path": "format.preferPrettier", "warning": "invalid type; ignored"})
                rep.changed = True

        tw = fmt.get("tabWidth")
        if tw is not None:
            if _is_int(tw) and 1 <= int(tw) <= 8:
                out["format"]["tabWidth"] = int(tw)
            else:
                rep.warnings.append({"path": "format.tabWidth", "warning": "invalid value; ignored"})
                rep.changed = True

        pw = fmt.get("printWidth")
        if pw is not None:
            if _is_int(pw) and 40 <= int(pw) <= 200:
                out["format"]["printWidth"] = int(pw)
            else:
                rep.warnings.append({"path": "format.printWidth", "warning": "invalid value; ignored"})
                rep.changed = True

        for k in fmt.keys():
            if k not in ("preferPrettier", "tabWidth", "printWidth"):
                rep.warnings.append({"path": f"format.{k}", "warning": "unknown key dropped"})
                rep.changed = True

    # ---- logs ----
    logs_raw = raw.get("logs")
    if logs_raw is None:
        pass
    elif not isinstance(logs_raw, dict):
        rep.warnings.append({"path": "logs", "warning": "must be an object; reset"})
        rep.changed = True
    else:
        ansi = logs_raw.get("ansi")
        if ansi is not None:
            if _is_bool(ansi):
                out["logs"]["ansi"] = bool(ansi)
            else:
                rep.warnings.append({"path": "logs.ansi", "warning": "invalid type; ignored"})
                rep.changed = True

        ws2 = logs_raw.get("ws2")
        if ws2 is not None:
            if _is_bool(ws2):
                out["logs"]["ws2"] = bool(ws2)
            else:
                rep.warnings.append({"path": "logs.ws2", "warning": "invalid type; ignored"})
                rep.changed = True

        if "view" in logs_raw:
            out["logs"]["view"] = _sanitize_view(logs_raw.get("view"), report=rep)

        for k in logs_raw.keys():
            if k not in ("ansi", "ws2", "view"):
                rep.warnings.append({"path": f"logs.{k}", "warning": "unknown key dropped"})
                rep.changed = True

    # ---- routing ----
    routing_raw = raw.get("routing")
    if routing_raw is None:
        pass
    elif not isinstance(routing_raw, dict):
        rep.warnings.append({"path": "routing", "warning": "must be an object; reset"})
        rep.changed = True
    else:
        gui_enabled = routing_raw.get("guiEnabled")
        if gui_enabled is not None:
            if _is_bool(gui_enabled):
                out["routing"]["guiEnabled"] = bool(gui_enabled)
            else:
                rep.warnings.append({"path": "routing.guiEnabled", "warning": "invalid type; ignored"})
                rep.changed = True

        auto_apply = routing_raw.get("autoApply")
        if auto_apply is not None:
            if _is_bool(auto_apply):
                out["routing"]["autoApply"] = bool(auto_apply)
            else:
                rep.warnings.append({"path": "routing.autoApply", "warning": "invalid type; ignored"})
                rep.changed = True

        show_active_outbound = routing_raw.get("showActiveOutbound")
        if show_active_outbound is not None:
            if _is_bool(show_active_outbound):
                out["routing"]["showActiveOutbound"] = bool(show_active_outbound)
            else:
                rep.warnings.append({"path": "routing.showActiveOutbound", "warning": "invalid type; ignored"})
                rep.changed = True

        show_scenario_card = routing_raw.get("showScenarioCard")
        if show_scenario_card is not None:
            if _is_bool(show_scenario_card):
                out["routing"]["showScenarioCard"] = bool(show_scenario_card)
            else:
                rep.warnings.append({"path": "routing.showScenarioCard", "warning": "invalid type; ignored"})
                rep.changed = True

        dns_layout = routing_raw.get("dnsOverVlessLayout")
        if dns_layout is not None:
            value = _as_lower_str(dns_layout)
            if value in ("auto", "single", "split"):
                out["routing"]["dnsOverVlessLayout"] = value
            else:
                # Неизвестная раскладка — это чаще всего настройка из будущей
                # версии. Откатываемся к auto, а не роняем весь блок routing.
                rep.warnings.append(
                    {"path": "routing.dnsOverVlessLayout", "warning": "unknown value; reset to auto"}
                )
                rep.changed = True

        for k in routing_raw.keys():
            if k not in ("guiEnabled", "autoApply", "showActiveOutbound", "showScenarioCard", "dnsOverVlessLayout"):
                rep.warnings.append({"path": f"routing.{k}", "warning": "unknown key dropped"})
                rep.changed = True

    # ---- mihomo ----
    mihomo_raw = raw.get("mihomo")
    if mihomo_raw is None:
        pass
    elif not isinstance(mihomo_raw, dict):
        rep.warnings.append({"path": "mihomo", "warning": "must be an object; reset"})
        rep.changed = True
    else:
        hide_unavailable = mihomo_raw.get("hideUnavailable")
        if hide_unavailable is not None:
            if _is_bool(hide_unavailable):
                out["mihomo"]["hideUnavailable"] = bool(hide_unavailable)
            else:
                rep.warnings.append({"path": "mihomo.hideUnavailable", "warning": "invalid type; ignored"})
                rep.changed = True

        consecutive_timeouts = mihomo_raw.get("consecutiveTimeouts")
        if consecutive_timeouts is not None:
            if _is_int(consecutive_timeouts) and 1 <= int(consecutive_timeouts) <= 10:
                out["mihomo"]["consecutiveTimeouts"] = int(consecutive_timeouts)
            else:
                rep.warnings.append({"path": "mihomo.consecutiveTimeouts", "warning": "invalid value; ignored"})
                rep.changed = True

        proxy_sort_order = mihomo_raw.get("proxySortOrder")
        if proxy_sort_order is not None:
            normalized_sort_order = _as_lower_str(proxy_sort_order)
            if normalized_sort_order in {"config", "name", "delay", "availability"}:
                out["mihomo"]["proxySortOrder"] = normalized_sort_order
            else:
                rep.warnings.append({"path": "mihomo.proxySortOrder", "warning": "invalid value; ignored"})
                rep.changed = True

        if "collapsedGroups" in mihomo_raw:
            collapsed_groups = _sanitize_mihomo_collapsed_groups(
                mihomo_raw.get("collapsedGroups"),
                report=rep,
            )
            if collapsed_groups is not None:
                out["mihomo"]["collapsedGroups"] = collapsed_groups

        latency_preset = mihomo_raw.get("latencyPreset")
        if latency_preset is not None:
            normalized_latency_preset = _as_lower_str(latency_preset)
            if normalized_latency_preset in {"auto", "google", "cloudflare"}:
                out["mihomo"]["latencyPreset"] = normalized_latency_preset
            else:
                rep.warnings.append({"path": "mihomo.latencyPreset", "warning": "invalid value; ignored"})
                rep.changed = True

        latency_freshness = mihomo_raw.get("latencyFreshness")
        if latency_freshness is not None:
            normalized_freshness = _as_lower_str(latency_freshness)
            if normalized_freshness in {"auto", "5", "15", "30"}:
                out["mihomo"]["latencyFreshness"] = normalized_freshness
            else:
                rep.warnings.append({"path": "mihomo.latencyFreshness", "warning": "invalid value; ignored"})
                rep.changed = True

        latency_test_mode = mihomo_raw.get("latencyTestMode")
        if latency_test_mode is not None:
            normalized_test_mode = _as_lower_str(latency_test_mode)
            if normalized_test_mode in {"safe", "core"}:
                out["mihomo"]["latencyTestMode"] = normalized_test_mode
            else:
                rep.warnings.append({"path": "mihomo.latencyTestMode", "warning": "invalid value; ignored"})
                rep.changed = True

        latency_low_ms = mihomo_raw.get("latencyLowMs")
        if latency_low_ms is not None:
            if _is_int(latency_low_ms) and 50 <= int(latency_low_ms) <= 5000:
                out["mihomo"]["latencyLowMs"] = int(latency_low_ms)
            else:
                rep.warnings.append({"path": "mihomo.latencyLowMs", "warning": "invalid value; ignored"})
                rep.changed = True

        latency_medium_ms = mihomo_raw.get("latencyMediumMs")
        if latency_medium_ms is not None:
            if _is_int(latency_medium_ms) and 100 <= int(latency_medium_ms) <= 10000:
                out["mihomo"]["latencyMediumMs"] = int(latency_medium_ms)
            else:
                rep.warnings.append({"path": "mihomo.latencyMediumMs", "warning": "invalid value; ignored"})
                rep.changed = True

        for k in mihomo_raw.keys():
            if k not in (
                "hideUnavailable",
                "consecutiveTimeouts",
                "proxySortOrder",
                "collapsedGroups",
                "latencyPreset",
                "latencyFreshness",
                "latencyTestMode",
                "latencyLowMs",
                "latencyMediumMs",
            ):
                rep.warnings.append({"path": f"mihomo.{k}", "warning": "unknown key dropped"})
                rep.changed = True

    # ---- top-level unknown keys ----
    for k in raw.keys():
        if k not in ("schemaVersion", "editor", "format", "logs", "routing", "mihomo"):
            rep.warnings.append({"path": k, "warning": "unknown key dropped"})
            rep.changed = True

    if _json_chars(out) > _MAX_FILE_CHARS:
        # This should not happen with our caps, but keep it safe.
        rep.errors.append({"path": "<root>", "error": "settings too large; reset"})
        rep.changed = True
        out = _canonical_empty()

    return out, rep


def _sanitize_patch(patch: Any) -> Tuple[Dict[str, Any], SettingsReport]:
    """Allowlist+types for PATCH payload (partial update)."""

    rep = SettingsReport(warnings=[], errors=[], changed=False)
    out: Dict[str, Any] = {}

    if patch is None:
        rep.errors.append({"path": "<root>", "error": "empty payload"})
        return out, rep
    if not isinstance(patch, dict) or isinstance(patch, list):
        rep.errors.append({"path": "<root>", "error": "payload must be an object"})
        return out, rep

    # schemaVersion is server-owned.
    if "schemaVersion" in patch:
        rep.warnings.append({"path": "schemaVersion", "warning": "read-only; ignored"})

    # editor
    if "editor" in patch:
        editor = patch.get("editor")
        if not isinstance(editor, dict):
            rep.errors.append({"path": "editor", "error": "must be an object"})
        else:
            p: Dict[str, Any] = {}
            if "engine" in editor:
                engine = _as_lower_str(editor.get("engine"))
                if engine is None:
                    rep.errors.append({"path": "editor.engine", "error": "must be a non-empty string"})
                else:
                    allowed = {"codemirror", "monaco"}
                    if engine not in allowed:
                        rep.errors.append({"path": "editor.engine", "error": "unsupported engine"})
                    else:
                        p["engine"] = engine

            if "fontScale" in editor:
                v = editor.get("fontScale")
                if _is_int(v) and 75 <= int(v) <= 200:
                    p["codemirrorFontScale"] = int(v)
                    p["monacoFontScale"] = int(v)
                else:
                    rep.errors.append({"path": "editor.fontScale", "error": "must be int 75..200"})

            if "codemirrorFontScale" in editor:
                v = editor.get("codemirrorFontScale")
                if _is_int(v) and 75 <= int(v) <= 200:
                    p["codemirrorFontScale"] = int(v)
                else:
                    rep.errors.append({"path": "editor.codemirrorFontScale", "error": "must be int 75..200"})

            if "monacoFontScale" in editor:
                v = editor.get("monacoFontScale")
                if _is_int(v) and 75 <= int(v) <= 200:
                    p["monacoFontScale"] = int(v)
                else:
                    rep.errors.append({"path": "editor.monacoFontScale", "error": "must be int 75..200"})

            if "schemaHoverEnabled" in editor:
                v = editor.get("schemaHoverEnabled")
                if _is_bool(v):
                    p["schemaHoverEnabled"] = bool(v)
                else:
                    rep.errors.append({"path": "editor.schemaHoverEnabled", "error": "must be boolean"})

            if "beginnerModeEnabled" in editor:
                v = editor.get("beginnerModeEnabled")
                if _is_bool(v):
                    p["beginnerModeEnabled"] = bool(v)
                else:
                    rep.errors.append({"path": "editor.beginnerModeEnabled", "error": "must be boolean"})

            if "expertModeEnabled" in editor:
                v = editor.get("expertModeEnabled")
                if _is_bool(v):
                    p["expertModeEnabled"] = bool(v)
                else:
                    rep.errors.append({"path": "editor.expertModeEnabled", "error": "must be boolean"})

            for k in editor.keys():
                if k not in ("engine", "fontScale", "codemirrorFontScale", "monacoFontScale", "schemaHoverEnabled", "beginnerModeEnabled", "expertModeEnabled"):
                    rep.warnings.append({"path": f"editor.{k}", "warning": "unknown key dropped"})

            if p:
                out["editor"] = p

    # format
    if "format" in patch:
        fmt = patch.get("format")
        if not isinstance(fmt, dict):
            rep.errors.append({"path": "format", "error": "must be an object"})
        else:
            p = {}
            if "preferPrettier" in fmt:
                v = fmt.get("preferPrettier")
                if _is_bool(v):
                    p["preferPrettier"] = bool(v)
                else:
                    rep.errors.append({"path": "format.preferPrettier", "error": "must be boolean"})

            if "tabWidth" in fmt:
                v = fmt.get("tabWidth")
                if _is_int(v) and 1 <= int(v) <= 8:
                    p["tabWidth"] = int(v)
                else:
                    rep.errors.append({"path": "format.tabWidth", "error": "must be int 1..8"})

            if "printWidth" in fmt:
                v = fmt.get("printWidth")
                if _is_int(v) and 40 <= int(v) <= 200:
                    p["printWidth"] = int(v)
                else:
                    rep.errors.append({"path": "format.printWidth", "error": "must be int 40..200"})

            for k in fmt.keys():
                if k not in ("preferPrettier", "tabWidth", "printWidth"):
                    rep.warnings.append({"path": f"format.{k}", "warning": "unknown key dropped"})

            if p:
                out["format"] = p

    # logs
    if "logs" in patch:
        logs_patch = patch.get("logs")
        if not isinstance(logs_patch, dict):
            rep.errors.append({"path": "logs", "error": "must be an object"})
        else:
            p: Dict[str, Any] = {}
            if "ansi" in logs_patch:
                v = logs_patch.get("ansi")
                if _is_bool(v):
                    p["ansi"] = bool(v)
                else:
                    rep.errors.append({"path": "logs.ansi", "error": "must be boolean"})

            if "ws2" in logs_patch:
                v = logs_patch.get("ws2")
                if _is_bool(v):
                    p["ws2"] = bool(v)
                else:
                    rep.errors.append({"path": "logs.ws2", "error": "must be boolean"})

            if "view" in logs_patch:
                # Allow replacing/setting view (bounded). If it's invalid/too large,
                # we record an error and ignore it.
                view_clean = _sanitize_view(logs_patch.get("view"), report=rep)
                if view_clean or logs_patch.get("view") == {}:
                    p["view"] = view_clean

            for k in logs_patch.keys():
                if k not in ("ansi", "ws2", "view"):
                    rep.warnings.append({"path": f"logs.{k}", "warning": "unknown key dropped"})

            if p:
                out["logs"] = p

    # routing
    if "routing" in patch:
        routing_patch = patch.get("routing")
        if not isinstance(routing_patch, dict):
            rep.errors.append({"path": "routing", "error": "must be an object"})
        else:
            p: Dict[str, Any] = {}
            if "guiEnabled" in routing_patch:
                v = routing_patch.get("guiEnabled")
                if _is_bool(v):
                    p["guiEnabled"] = bool(v)
                else:
                    rep.errors.append({"path": "routing.guiEnabled", "error": "must be boolean"})

            if "autoApply" in routing_patch:
                v = routing_patch.get("autoApply")
                if _is_bool(v):
                    p["autoApply"] = bool(v)
                else:
                    rep.errors.append({"path": "routing.autoApply", "error": "must be boolean"})

            if "showActiveOutbound" in routing_patch:
                v = routing_patch.get("showActiveOutbound")
                if _is_bool(v):
                    p["showActiveOutbound"] = bool(v)
                else:
                    rep.errors.append({"path": "routing.showActiveOutbound", "error": "must be boolean"})

            if "showScenarioCard" in routing_patch:
                v = routing_patch.get("showScenarioCard")
                if _is_bool(v):
                    p["showScenarioCard"] = bool(v)
                else:
                    rep.errors.append({"path": "routing.showScenarioCard", "error": "must be boolean"})

            for k in routing_patch.keys():
                if k not in ("guiEnabled", "autoApply", "showActiveOutbound", "showScenarioCard"):
                    rep.warnings.append({"path": f"routing.{k}", "warning": "unknown key dropped"})

            if p:
                out["routing"] = p

    # mihomo
    if "mihomo" in patch:
        mihomo_patch = patch.get("mihomo")
        if not isinstance(mihomo_patch, dict):
            rep.errors.append({"path": "mihomo", "error": "must be an object"})
        else:
            p: Dict[str, Any] = {}
            if "hideUnavailable" in mihomo_patch:
                v = mihomo_patch.get("hideUnavailable")
                if _is_bool(v):
                    p["hideUnavailable"] = bool(v)
                else:
                    rep.errors.append({"path": "mihomo.hideUnavailable", "error": "must be boolean"})

            if "consecutiveTimeouts" in mihomo_patch:
                v = mihomo_patch.get("consecutiveTimeouts")
                if _is_int(v) and 1 <= int(v) <= 10:
                    p["consecutiveTimeouts"] = int(v)
                else:
                    rep.errors.append({"path": "mihomo.consecutiveTimeouts", "error": "must be int 1..10"})

            if "proxySortOrder" in mihomo_patch:
                v = _as_lower_str(mihomo_patch.get("proxySortOrder"))
                if v in {"config", "name", "delay", "availability"}:
                    p["proxySortOrder"] = v
                else:
                    rep.errors.append({"path": "mihomo.proxySortOrder", "error": "unsupported sort order"})

            if "collapsedGroups" in mihomo_patch:
                v = _sanitize_mihomo_collapsed_groups(
                    mihomo_patch.get("collapsedGroups"),
                    report=rep,
                    patch=True,
                )
                if v is not None:
                    p["collapsedGroups"] = v

            if "latencyPreset" in mihomo_patch:
                v = _as_lower_str(mihomo_patch.get("latencyPreset"))
                if v in {"auto", "google", "cloudflare"}:
                    p["latencyPreset"] = v
                else:
                    rep.errors.append({"path": "mihomo.latencyPreset", "error": "unsupported preset"})

            if "latencyFreshness" in mihomo_patch:
                v = _as_lower_str(mihomo_patch.get("latencyFreshness"))
                if v in {"auto", "5", "15", "30"}:
                    p["latencyFreshness"] = v
                else:
                    rep.errors.append({"path": "mihomo.latencyFreshness", "error": "unsupported freshness"})

            if "latencyTestMode" in mihomo_patch:
                v = _as_lower_str(mihomo_patch.get("latencyTestMode"))
                if v in {"safe", "core"}:
                    p["latencyTestMode"] = v
                else:
                    rep.errors.append({"path": "mihomo.latencyTestMode", "error": "unsupported test mode"})

            if "latencyLowMs" in mihomo_patch:
                v = mihomo_patch.get("latencyLowMs")
                if _is_int(v) and 50 <= int(v) <= 5000:
                    p["latencyLowMs"] = int(v)
                else:
                    rep.errors.append({"path": "mihomo.latencyLowMs", "error": "must be int 50..5000"})

            if "latencyMediumMs" in mihomo_patch:
                v = mihomo_patch.get("latencyMediumMs")
                if _is_int(v) and 100 <= int(v) <= 10000:
                    p["latencyMediumMs"] = int(v)
                else:
                    rep.errors.append({"path": "mihomo.latencyMediumMs", "error": "must be int 100..10000"})

            for k in mihomo_patch.keys():
                if k not in (
                    "hideUnavailable",
                    "consecutiveTimeouts",
                    "proxySortOrder",
                    "collapsedGroups",
                    "latencyPreset",
                    "latencyFreshness",
                    "latencyTestMode",
                    "latencyLowMs",
                    "latencyMediumMs",
                ):
                    rep.warnings.append({"path": f"mihomo.{k}", "warning": "unknown key dropped"})

            if p:
                out["mihomo"] = p

    for k in patch.keys():
        if k not in ("schemaVersion", "editor", "format", "logs", "routing", "mihomo"):
            rep.warnings.append({"path": k, "warning": "unknown key dropped"})

    return out, rep


def _settings_path(ui_state_dir: str) -> str:
    return os.path.join(ui_state_dir, "ui-settings.json")


def load_settings(ui_state_dir: str = UI_STATE_DIR) -> Dict[str, Any]:
    """Load UI settings from disk and merge with defaults.

    Returns defaults if file is missing/corrupted.
    """
    path = _settings_path(ui_state_dir)
    raw: Any = read_json(path, default={}) if os.path.isfile(path) else {}

    cfg, rep = _sanitize_full(raw)

    # If file exists and needed normalization/migration, persist back.
    if os.path.isfile(path) and rep.changed:
        try:
            save_settings(cfg, ui_state_dir)
        except Exception:
            # Best-effort; do not block UI.
            log.warning("ui-settings: failed to write normalized config", exc_info=True)

    # Ensure we always return a dict.
    return cfg if isinstance(cfg, dict) else _canonical_empty()


def save_settings(cfg_in: Any, ui_state_dir: str = UI_STATE_DIR) -> Dict[str, Any]:
    """Save the given config (merged with defaults) to disk.

    Returns the effective saved config.
    """
    # Normalize using server allowlist (drop unknown keys/types) and ensure
    # canonical schema ordering.
    cfg, rep = _sanitize_full(cfg_in)

    # Keep output identical to previous implementation: utf-8, ensure_ascii=False,
    # indent=2, trailing newline. Do NOT sort keys: we keep stable canonical order.
    txt = json.dumps(cfg, ensure_ascii=False, indent=2) + "\n"
    if len(txt) > _MAX_FILE_CHARS:
        raise UISettingsValidationError(
            "settings too large",
            errors=[{"path": "<root>", "error": "settings too large"}],
        )

    path = _settings_path(ui_state_dir)
    safe_write_text(path, txt, mode=0o644)

    # Log normalization only when it matters for support.
    if rep.warnings or rep.errors:
        # Keep the log compact.
        w = rep.warnings[:10]
        e = rep.errors[:10]
        log.warning(
            "ui-settings: normalized on save (warnings=%s, errors=%s)",
            w,
            e,
        )

    return cfg


def patch_settings(patch: Any, ui_state_dir: str = UI_STATE_DIR) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """Apply a partial update (deep-merge), validate, and save to disk.

    Returns (settings, report) where report contains warnings/errors that were
    detected while sanitizing the patch.
    """

    current = load_settings(ui_state_dir)

    patch_clean, rep = _sanitize_patch(patch)

    # No valid keys at all -> reject as a bad patch (predictable 400).
    if not patch_clean and (rep.errors or rep.warnings):
        errs = list(rep.errors)
        if not errs:
            # Convert warnings into client-visible errors for predictable UX.
            for w in rep.warnings:
                errs.append({"path": w.get("path", "<root>"), "error": w.get("warning", "invalid")})
        raise UISettingsValidationError(
            "bad patch",
            errors=errs,
        )

    merged = deep_merge(current, patch_clean)

    # Enforce server-owned schemaVersion.
    if isinstance(merged, dict):
        merged["schemaVersion"] = SCHEMA_VERSION

    saved = save_settings(merged, ui_state_dir)

    # Emit a single compact warning for diagnostics (no per-key spam).
    if rep.errors or rep.warnings:
        log.warning(
            "ui-settings: PATCH sanitized (errors=%s, warnings=%s)",
            rep.errors[:10],
            rep.warnings[:10],
        )

    report_out = {
        "warnings": rep.warnings,
        "errors": rep.errors,
    }
    return saved, report_out
