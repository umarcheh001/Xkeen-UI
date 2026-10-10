"""UI page routes extracted from app.py.

We register routes directly on the Flask app (not via Blueprint) to preserve
endpoint names referenced from templates via url_for(...).
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass

from flask import Flask, make_response, redirect, render_template, url_for
from services.capabilities import detect_terminal_state
from services.cores import detect_available_cores
from services.module_registry import EDITOR_CAPABILITIES, EDITOR_VARIANTS, MODULE_IDS


@dataclass(frozen=True, slots=True)
class PanelCompositionEntry:
    """One allow-listed optional partial and every module required to render it."""

    collection: str
    owners: tuple[str, ...]
    template: str


@dataclass(frozen=True, slots=True)
class PanelNavigationEntry:
    """One top-level panel navigation item owned by the active module set."""

    owners: tuple[str, ...]
    section: str
    label: str
    class_name: str
    view: str | None = None
    element_id: str | None = None
    href_endpoint: str | None = None
    top_nav: bool = False


@dataclass(frozen=True, slots=True)
class PanelFrontendModule:
    """Allow-listed frontend bundle metadata for one module-owned boundary."""

    key: str
    owners: tuple[str, ...]
    load_mode: str
    views: tuple[str, ...]
    dom_roots: tuple[str, ...]
    api_prefixes: tuple[str, ...]
    ws_prefixes: tuple[str, ...]
    css_keys: tuple[str, ...] = ()
    capabilities: tuple[str, ...] = ()

    def as_payload(self) -> dict[str, object]:
        # Keep this JSON-safe and declarative. The browser always resolves the
        # key through its local import allow-list; no import path is published.
        payload = {
            "key": self.key,
            "moduleId": self.owners[0],
            "loadMode": self.load_mode,
            "views": list(self.views),
            "domRoots": list(self.dom_roots),
            "apiPrefixes": list(self.api_prefixes),
            "wsPrefixes": list(self.ws_prefixes),
            "cssKeys": list(self.css_keys),
        }
        if self.capabilities:
            payload["capabilities"] = list(self.capabilities)
        return payload


PANEL_COMPOSITION: tuple[PanelCompositionEntry, ...] = (
    PanelCompositionEntry("header_badge_partials", ("engine.xray",), "panel/slots/xray_badge.html"),
    PanelCompositionEntry("header_summary_partials", ("tool.advanced-diagnostics",), "panel/slots/diagnostics_summary.html"),
    PanelCompositionEntry("header_action_partials", ("tool.advanced-diagnostics",), "panel/slots/diagnostics_actions.html"),
    PanelCompositionEntry("control_partials", ("engine.xray",), "panel/slots/routing_focus.html"),
    # The backup API belongs to tool.backups, so the routing screen gets its
    # backup card and buttons only together with that module.
    PanelCompositionEntry("routing_inbounds_action_partials", ("engine.xray", "tool.backups"), "panel/slots/backups_inbounds_actions.html"),
    PanelCompositionEntry("routing_outbounds_action_partials", ("engine.xray", "tool.backups"), "panel/slots/backups_outbounds_actions.html"),
    PanelCompositionEntry("routing_side_card_partials", ("engine.xray", "tool.backups"), "panel/slots/backups_xray_card.html"),
    PanelCompositionEntry("routing_file_action_partials", ("engine.xray", "tool.backups"), "panel/slots/backups_routing_actions.html"),
    PanelCompositionEntry("screen_partials", ("engine.xray",), "panel/screens/routing.html"),
    PanelCompositionEntry("screen_partials", ("engine.mihomo",), "panel/screens/mihomo.html"),
    PanelCompositionEntry("screen_partials", ("core",), "panel/screens/xkeen.html"),
    PanelCompositionEntry("screen_partials", ("tool.terminal",), "panel/screens/commands.html"),
    PanelCompositionEntry("screen_partials", ("tool.files",), "panel/screens/files.html"),
    PanelCompositionEntry("screen_partials", ("engine.xray",), "panel/screens/xray_logs.html"),
    PanelCompositionEntry("pre_screen_modal_partials", ("tool.advanced-diagnostics",), "panel/modals/diagnostics.html"),
    PanelCompositionEntry("modal_partials", ("engine.xray",), "panel/modals/routing.html"),
    PanelCompositionEntry("modal_partials", ("tool.terminal",), "panel/modals/commands.html"),
    PanelCompositionEntry("modal_partials", ("core",), "panel/modals/shared.html"),
    # The core-source API is registered per engine module, so the controls
    # inside the shared core dialog and their dialogs follow the engine. The
    # dialogs stay right after shared.html to open above the core dialog.
    PanelCompositionEntry("core_source_control_partials", ("engine.xray",), "panel/slots/core_source_xray.html"),
    PanelCompositionEntry("core_source_control_partials", ("engine.mihomo",), "panel/slots/core_source_mihomo.html"),
    PanelCompositionEntry("modal_partials", ("engine.xray",), "panel/modals/core_source_xray.html"),
    PanelCompositionEntry("modal_partials", ("engine.mihomo",), "panel/modals/core_source_mihomo.html"),
    PanelCompositionEntry("modal_partials", ("engine.mihomo",), "panel/modals/mihomo.html"),
    PanelCompositionEntry("modal_partials", ("integration.happ", "engine.mihomo"), "panel/modals/happ.html"),
    PanelCompositionEntry("modal_partials", ("tool.files",), "panel/modals/files.html"),
    PanelCompositionEntry("modal_partials", ("tool.files", "tool.editor"), "panel/modals/files_editor.html"),
    PanelCompositionEntry("modal_partials", ("tool.editor",), "panel/modals/editor.html"),
)

PANEL_COMPOSITION_PARTIALS = tuple(entry.template for entry in PANEL_COMPOSITION)

PANEL_NAVIGATION: tuple[PanelNavigationEntry, ...] = (
    PanelNavigationEntry(("engine.xray",), "routing", "Роутинг Xray", "top-tab-btn xk-top-tab xk-top-tab-routing", view="routing"),
    PanelNavigationEntry(("engine.mihomo",), "mihomo", "Роутинг Mihomo", "top-tab-btn xk-top-tab xk-top-tab-mihomo", view="mihomo"),
    PanelNavigationEntry(("core",), "xkeen", "Порты и исключения", "top-tab-btn xk-top-tab xk-top-tab-xkeen", view="xkeen"),
    PanelNavigationEntry(("engine.xray",), "xray-logs", "Логи Xray", "top-tab-btn xk-top-tab xk-top-tab-logs", view="xray-logs"),
    PanelNavigationEntry(("tool.terminal",), "commands", "Команды", "top-tab-btn xk-top-tab xk-top-tab-commands", view="commands"),
    PanelNavigationEntry(("tool.files",), "files", "Файлы", "top-tab-btn xk-top-tab xk-top-tab-files", view="files", element_id="top-tab-files"),
    PanelNavigationEntry(("engine.mihomo",), "mihomo-generator", "Mihomo Генератор", "top-tab-btn xk-top-tab xk-top-tab-generator", element_id="top-tab-mihomo-generator", href_endpoint="mihomo_generator_page", top_nav=True),
    PanelNavigationEntry(("core",), "donate", "Поддержать", "top-tab-btn xk-top-tab xk-top-tab-donate", element_id="top-tab-donate"),
)


PANEL_FRONTEND_MODULES: tuple[PanelFrontendModule, ...] = (
    PanelFrontendModule(
        "panel-core",
        ("core",),
        "startup",
        ("xkeen",),
        ("view-xkeen",),
        ("/api/",),
        ("/ws/events",),
    ),
    PanelFrontendModule(
        "panel-routing",
        ("engine.xray",),
        "startup",
        ("routing", "xray-logs"),
        ("view-routing", "view-xray-logs"),
        ("/api/routing", "/api/xray", "/routing/"),
        ("/ws/xray-logs",),
    ),
    PanelFrontendModule(
        "panel-mihomo",
        ("engine.mihomo",),
        "startup",
        ("mihomo",),
        ("view-mihomo",),
        ("/api/mihomo", "/api/mihomo-clash"),
        ("/ws/mihomo-clash",),
    ),
    PanelFrontendModule(
        "terminal-lazy",
        ("tool.terminal",),
        "view",
        ("commands",),
        ("view-commands", "terminal-overlay"),
        ("/api/terminal", "/api/capabilities"),
        ("/ws/pty",),
        ("xterm",),
    ),
    PanelFrontendModule(
        "file-manager-lazy",
        ("tool.files",),
        "view",
        ("files",),
        ("view-files",),
        ("/fs/", "/remotefs/", "/fileops/", "/api/storage"),
        (),
    ),
    PanelFrontendModule(
        "diagnostics-panel",
        ("tool.advanced-diagnostics",),
        "after-paint",
        (),
        ("xk-resource-monitor", "xk-resource-dashboard-modal"),
        ("/api/system",),
        (),
    ),
    PanelFrontendModule(
        "editor-runtime",
        ("tool.editor",),
        # The screens with an editor ask for it before they initialise.
        "view",
        (),
        ("json-editor-modal", "fm-editor-modal", "routing-editor", "mihomo-editor"),
        (),
        (),
    ),
    PanelFrontendModule(
        "editor-codemirror",
        ("tool.editor",),
        "view",
        (),
        (),
        (),
        (),
        capabilities=("codemirror",),
    ),
    PanelFrontendModule(
        "editor-monaco",
        ("tool.editor",),
        "interaction",
        (),
        (),
        (),
        (),
        capabilities=("monaco",),
    ),
    PanelFrontendModule(
        "editor-diff",
        ("tool.editor",),
        "interaction",
        (),
        (),
        (),
        (),
        capabilities=("diff",),
    ),
    PanelFrontendModule(
        "editor-enhancements",
        ("tool.editor",),
        "interaction",
        (),
        (),
        (),
        (),
        capabilities=("prettier", "quick-fix", "schema-extended"),
    ),
)


def build_panel_frontend_modules(
    active_module_ids: set[str] | None,
    *,
    editor_variant: str | None = None,
    editor_capabilities: list[str] | tuple[str, ...] | None = None,
) -> dict[str, object]:
    """Return the client-safe frontend activation descriptor for the panel."""

    active = frozenset(MODULE_IDS if active_module_ids is None else active_module_ids)
    requested_variant = str(editor_variant or "").strip().lower()
    if requested_variant not in EDITOR_VARIANTS:
        requested_variant = (
            "full"
            if active_module_ids is None
            or {"engine.xray", "engine.mihomo"} <= set(active)
            else "light"
        )
    capabilities = tuple(
        str(capability).strip()
        for capability in (
            editor_capabilities
            if editor_capabilities is not None
            else EDITOR_CAPABILITIES[requested_variant]
        )
        if str(capability).strip()
    )
    capability_set = set(capabilities)
    bundles = [
        entry.as_payload()
        for entry in PANEL_FRONTEND_MODULES
        if set(entry.owners) <= active
        and set(entry.capabilities) <= capability_set
    ]
    return {
        "version": 1,
        "activeModuleIds": sorted(active),
        "editor": {
            "variant": requested_variant,
            "capabilities": list(capabilities),
            "availableVariants": list(EDITOR_VARIANTS),
        },
        "bundles": bundles,
    }


def _build_panel_page_context(active_module_ids: set[str] | None) -> dict[str, object]:
    """Select server-owned panel surfaces from the Stage 3 activation result."""

    active = None if active_module_ids is None else frozenset(str(module_id) for module_id in active_module_ids)

    def is_allowed(owners: tuple[str, ...]) -> bool:
        return active is None or set(owners) <= active

    context: dict[str, object] = {
        "active_module_ids": [] if active is None else sorted(active),
        "legacy_fallback": active is None,
        "navigation_items": [],
        "header_badge_partials": [],
        "header_summary_partials": [],
        "header_action_partials": [],
        "control_partials": [],
        "routing_inbounds_action_partials": [],
        "routing_outbounds_action_partials": [],
        "routing_side_card_partials": [],
        "routing_file_action_partials": [],
        "core_source_control_partials": [],
        "pre_screen_modal_partials": [],
        "screen_partials": [],
        "modal_partials": [],
    }
    for entry in PANEL_COMPOSITION:
        if is_allowed(entry.owners):
            context[entry.collection].append(entry.template)

    navigation_items: list[dict[str, object]] = []
    active_view_selected = False
    for entry in PANEL_NAVIGATION:
        if not is_allowed(entry.owners):
            continue
        item = {
            "section": entry.section,
            "label": entry.label,
            "class_name": entry.class_name,
            "view": entry.view,
            "element_id": entry.element_id,
            "href_endpoint": entry.href_endpoint,
            "top_nav": entry.top_nav,
            "active": bool(entry.view) and not active_view_selected,
        }
        if entry.view:
            active_view_selected = True
        navigation_items.append(item)
    context["navigation_items"] = navigation_items
    # Every screen but routing is hidden in its markup unless it is this one,
    # so a set without routing is not blank before scripts run.  Routing
    # needs no switch: it leads the navigation whenever it is composed.
    context["initial_view"] = next(
        (item["view"] for item in navigation_items if item["active"]), None
    )
    return context


def _parse_sections_whitelist(raw: str | None) -> set[str] | None:
    s = str(raw or "").strip().lower()
    if not s or s in {"*", "all", "any"}:
        return None
    return {
        token
        for token in re.split(r"[\s,;]+", s)
        if token and token not in {"*", "all", "any"}
    }


def _effective_panel_sections(supported_sections: list[str]) -> list[str]:
    requested_sections = _parse_sections_whitelist(
        os.environ.get("XKEEN_UI_PANEL_SECTIONS_WHITELIST")
    )
    if requested_sections is None:
        return supported_sections
    if not any(section in requested_sections for section in supported_sections):
        return supported_sections
    return [section for section in supported_sections if section in requested_sections]


def _detect_panel_core_ui(active_module_ids: set[str] | None = None) -> dict[str, object]:
    """Build panel visibility from runtime-gated modules when supplied."""

    if active_module_ids is not None:
        has_xray = "engine.xray" in active_module_ids
        has_mihomo = "engine.mihomo" in active_module_ids
        has_terminal = "tool.terminal" in active_module_ids
        has_files = "tool.files" in active_module_ids
        has_diagnostics = "tool.advanced-diagnostics" in active_module_ids
        has_editor = "tool.editor" in active_module_ids
        has_happ = "integration.happ" in active_module_ids
        available_cores = [
            core
            for core, module_id in (("xray", "engine.xray"), ("mihomo", "engine.mihomo"))
            if module_id in active_module_ids
        ]
        supported_sections: list[str] = []
        if has_xray:
            supported_sections.extend(["routing", "xray-logs"])
        if has_mihomo:
            supported_sections.extend(["mihomo", "mihomo-generator"])
        supported_sections.append("xkeen")
        if has_terminal:
            supported_sections.append("commands")
        if has_files:
            supported_sections.append("files")
        if has_diagnostics:
            supported_sections.append("devtools")
        supported_sections.append("donate")

        effective_sections = _effective_panel_sections(supported_sections)
        # The core watcher compares "detected" with /api/xkeen/core, which
        # reports installed binaries.  Active engines are a different set
        # (legacy-full keeps both), so publishing them as "detected" made a
        # single-core router reload the panel every few seconds.
        detected_cores = list(detect_available_cores())
        return {
            "available_cores": available_cores,
            "detected_cores": detected_cores,
            "core_ui_fallback": not detected_cores,
            "has_xray": has_xray,
            "has_mihomo": has_mihomo,
            "has_terminal": has_terminal,
            "has_files": has_files,
            "has_diagnostics": has_diagnostics,
            "has_editor": has_editor,
            "has_happ": has_happ,
            "multi_core": len(available_cores) > 1,
            "panel_sections_whitelist": ",".join(effective_sections) if effective_sections else "__none__",
        }

    detected_cores = list(detect_available_cores())
    available_cores = list(detected_cores)
    core_ui_fallback = False
    if not available_cores:
        # In dev/desktop environments there may be no /opt/sbin/* binaries at all.
        # Keep the full UI visible there instead of hiding both core-specific areas.
        available_cores = ["xray", "mihomo"]
        core_ui_fallback = True
    has_xray = "xray" in available_cores
    has_mihomo = "mihomo" in available_cores

    supported_sections: list[str] = []
    if has_xray:
        supported_sections.append("routing")
    if has_mihomo:
        supported_sections.append("mihomo")
    supported_sections.extend(["xkeen"])
    if has_xray:
        supported_sections.append("xray-logs")
    supported_sections.extend(["commands", "files"])
    if has_mihomo:
        supported_sections.append("mihomo-generator")
    supported_sections.append("donate")

    effective_sections = _effective_panel_sections(supported_sections)

    return {
        "available_cores": available_cores,
        "detected_cores": detected_cores,
        "core_ui_fallback": core_ui_fallback,
        "has_xray": has_xray,
        "has_mihomo": has_mihomo,
        "has_terminal": True,
        "has_files": True,
        "has_diagnostics": True,
        "has_editor": True,
        "has_happ": True,
        "multi_core": len(available_cores) > 1,
        "panel_sections_whitelist": ",".join(effective_sections) if effective_sections else "__none__",
    }


def _no_cache(resp):
    """Apply no-cache headers for HTML pages.

    This helps ensure that after self-update users get the new HTML that points
    at updated static assets, without requiring Ctrl+F5.
    """
    try:
        resp.headers["Cache-Control"] = "no-store, max-age=0"
        resp.headers["Pragma"] = "no-cache"
    except Exception:
        pass
    return resp


def register_pages_routes(
    app: Flask,
    *,
    module_activation: dict[str, object] | None = None,
    ROUTING_FILE: str,
    MIHOMO_CONFIG_FILE: str,
    INBOUNDS_FILE: str,
    OUTBOUNDS_FILE: str,
    BACKUP_DIR: str,
    COMMAND_GROUPS,
    GITHUB_REPO_URL: str,
) -> None:
    """Register UI page routes on the app."""

    active_module_ids = (
        {str(module_id) for module_id in module_activation.get("active_module_ids", [])}
        if isinstance(module_activation, dict)
        else None
    )

    def _frontend_modules_descriptor() -> dict[str, object]:
        editor_descriptor = module_activation.get("editor") if isinstance(module_activation, dict) else None
        if not isinstance(editor_descriptor, dict):
            editor_descriptor = {}
        return build_panel_frontend_modules(
            active_module_ids,
            editor_variant=editor_descriptor.get("variant"),
            editor_capabilities=editor_descriptor.get("capabilities"),
        )

    @app.context_processor
    def _standalone_page_context() -> dict[str, object]:
        # The pages outside the panel shell load no panel bundles, but their
        # editors obey the same policy: what the installed variant offers.
        descriptor = _frontend_modules_descriptor()
        return {
            "standalone_frontend_modules": {
                key: descriptor[key] for key in ("version", "activeModuleIds", "editor")
            }
        }

    @app.get("/")
    def index():
        # machine info for conditional UI (e.g. hide Files tab on MIPS)
        try:
            _machine = os.uname().machine
        except Exception:
            _machine = ""
        _is_mips = str(_machine).lower().startswith("mips")
        try:
            _terminal_supports_pty = bool(detect_terminal_state(os.environ).get("pty"))
        except Exception:
            _terminal_supports_pty = not _is_mips

        # Detect active Xray profile/variant for UI hints.
        try:
            _xray_profile = "hys2" if "_hys2" in os.path.basename(ROUTING_FILE) else "classic"
        except Exception:
            _xray_profile = "classic"

        # File Manager defaults: /tmp/mnt exists on routers with mounted storage,
        # but may be absent on dev machines (and should not spam console with 403/404).
        try:
            _fm_right_default = "/tmp/mnt" if os.path.isdir("/tmp/mnt") else "/tmp"
        except Exception:
            _fm_right_default = "/tmp/mnt"

        _core_ui = _detect_panel_core_ui(active_module_ids)
        page_context = _build_panel_page_context(active_module_ids)
        panel_frontend_modules = _frontend_modules_descriptor()
        _websocket_runtime = str(os.environ.get("XKEEN_WS_RUNTIME", "")).strip().lower() in {"1", "true", "yes", "on"}
        page_ctx = {
            "machine": _machine,
            "is_mips": _is_mips,
            "terminal_supports_pty": _terminal_supports_pty,
            "xkeen_runtime_debug": str(os.environ.get("XKEEN_DEV", "")).strip().lower() in {"1", "true", "yes", "on"},
            "xkeen_runtime_websocket": _websocket_runtime,
            "xkeen_terminal_enable_optional_addons": str(os.environ.get("XKEEN_ENABLE_XTERM_OPTIONAL_ADDONS", "")).strip().lower() in {"1", "true", "yes", "on"},
            "xray_profile": _xray_profile,
            "routing_file": ROUTING_FILE,
            "routing_name": os.path.basename(ROUTING_FILE),
            "mihomo_config_file": MIHOMO_CONFIG_FILE,
            "mihomo_config_exists": os.path.exists(MIHOMO_CONFIG_FILE),
            "inbounds_file": INBOUNDS_FILE,
            "inbounds_name": os.path.basename(INBOUNDS_FILE),
            "outbounds_file": OUTBOUNDS_FILE,
            "outbounds_name": os.path.basename(OUTBOUNDS_FILE),
            "backup_dir": BACKUP_DIR,
            "command_groups": COMMAND_GROUPS,
            "github_repo_url": GITHUB_REPO_URL,
            "fm_right_default": _fm_right_default,
            "page_context": page_context,
            "panel_frontend_modules": panel_frontend_modules,
            **_core_ui,
        }

        try:
            resp = make_response(render_template("panel.html", **page_ctx))
            return _no_cache(resp)
        except Exception:
            # Fallback to previous behaviour.
            return render_template("panel.html", **page_ctx)

    @app.get("/xkeen")
    def xkeen_page():
        try:
            return _no_cache(make_response(render_template("xkeen.html")))
        except Exception:
            return render_template("xkeen.html")

    @app.get("/modules")
    def modules_page():
        try:
            return _no_cache(make_response(render_template("modules.html")))
        except Exception:
            return render_template("modules.html")

    if active_module_ids is None or "engine.mihomo" in active_module_ids:

        @app.get("/mihomo_generator")
        def mihomo_generator_page():
            try:
                return _no_cache(make_response(render_template("mihomo_generator.html")))
            except Exception:
                return render_template("mihomo_generator.html")

    if active_module_ids is None or "tool.advanced-diagnostics" in active_module_ids:

        @app.get("/devtools")
        def devtools_page():
            # The card's API is registered only together with its module.
            page_ctx = {
                "devtools_link_utility_card": active_module_ids is None
                or "integration.happ" in active_module_ids,
            }
            # Avoid stale cached HTML holding on to old static asset versions
            try:
                resp = make_response(render_template("devtools.html", **page_ctx))
                return _no_cache(resp)
            except Exception:
                return render_template("devtools.html", **page_ctx)
