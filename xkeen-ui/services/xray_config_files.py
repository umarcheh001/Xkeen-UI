"""Xray config fragments path resolution and fragment selection helpers.

Centralizes:
- XRAY_CONFIGS_DIR (+ realpath)
- XRAY_JSONC_DIR (+ realpath) — UI sidecar dir for JSONC files (comments)
- JSONC sidecar path mapping helpers (jsonc_path_for / legacy_jsonc_path_for)
- auto-pick logic for routing/inbounds/outbounds fragments
- safe fragment selection via ?file= (keeps selection inside XRAY_CONFIGS_DIR)
- listing fragment files for dropdowns

Extracted from app.py as part of PR14 refactor (no behavior change).
"""

from __future__ import annotations

import os
import shutil
import time

from core.paths import BASE_ETC_DIR, UI_STATE_DIR


# ---- Xray config files (auto-mode + env overrides)
#
# Supports env:
#   XKEEN_XRAY_CONFIGS_DIR   — xray configs dir (default: /opt/etc/xray/configs)
#   XKEEN_XRAY_JSONC_DIR     — UI sidecar dir for JSONC comments (default: <UI_STATE_DIR>/xray-jsonc)
#   XKEEN_XRAY_ROUTING_FILE  — routing fragment file (auto-pick by default)
#   XKEEN_XRAY_INBOUNDS_FILE — inbounds fragment file (auto-pick by default)
#   XKEEN_XRAY_OUTBOUNDS_FILE— outbounds fragment file (auto-pick by default)
#   XKEEN_XRAY_ROUTING_FILE_RAW — raw JSONC routing file (default: <routing>.jsonc)

_XRAY_CONFIGS_DIR_DEFAULT = os.path.join(BASE_ETC_DIR, "xray", "configs")
XRAY_CONFIGS_DIR = os.environ.get("XKEEN_XRAY_CONFIGS_DIR", _XRAY_CONFIGS_DIR_DEFAULT)

# Real path of XRAY config fragments dir (for safe file selection via ?file=...)
try:
    XRAY_CONFIGS_DIR_REAL = os.path.realpath(XRAY_CONFIGS_DIR)
except Exception:
    XRAY_CONFIGS_DIR_REAL = XRAY_CONFIGS_DIR


# ---- JSONC sidecar dir (UI-owned)
#
# IMPORTANT:
#   Xray may parse extra files from -confdir (including *.jsonc). Therefore JSONC
#   sidecar files produced by the UI must NOT live in XRAY_CONFIGS_DIR.
#
# This module introduces XRAY_JSONC_DIR and path mapping helpers. Existing code
# will be switched to use these helpers in follow-up stages.

_XRAY_JSONC_DIR_DEFAULT = os.path.join(UI_STATE_DIR, "xray-jsonc")
XRAY_JSONC_DIR = os.environ.get("XKEEN_XRAY_JSONC_DIR", _XRAY_JSONC_DIR_DEFAULT)

try:
    XRAY_JSONC_DIR_REAL = os.path.realpath(XRAY_JSONC_DIR)
except Exception:
    XRAY_JSONC_DIR_REAL = XRAY_JSONC_DIR


def ensure_xray_jsonc_dir() -> None:
    """Best-effort ensure XRAY_JSONC_DIR exists."""
    try:
        if XRAY_JSONC_DIR and not os.path.isdir(XRAY_JSONC_DIR):
            os.makedirs(XRAY_JSONC_DIR, exist_ok=True)
    except Exception:
        # Never fail import-time.
        pass


def _unique_suffix_path(path: str) -> str:
    """Return a non-existing path by appending a numeric suffix if needed."""
    if not path:
        return path
    if not os.path.exists(path):
        return path
    base = path
    i = 1
    while True:
        cand = f"{base}.{i}"
        if not os.path.exists(cand):
            return cand
        i += 1


def migrate_jsonc_sidecars_from_configs() -> dict:
    """Migrate legacy *.jsonc files from XRAY_CONFIGS_DIR into XRAY_JSONC_DIR.

    Older UI versions stored JSONC sidecars next to *.json in XRAY_CONFIGS_DIR.
    Some Xray builds may parse *.jsonc from -confdir, so we must evacuate them.

    Behavior:
      - For every *.jsonc inside XRAY_CONFIGS_DIR (top-level only):
        * Move it to XRAY_JSONC_DIR keeping the same basename.
        * If destination exists:
            - keep the newer file as the main sidecar
            - move the older one as <dst>.old-<ts> (and ensure uniqueness)
        * After successful migration, remove legacy file from XRAY_CONFIGS_DIR.
      - Best-effort: never raises.

    Returns summary dict for logging/debug.
    """
    summary = {
        "found": 0,
        "moved": 0,
        "moved_as_old": 0,
        "replaced": 0,
        "disabled_in_place": 0,
        "errors": 0,
    }

    try:
        # Avoid any surprises if dirs are misconfigured.
        if not XRAY_CONFIGS_DIR or not XRAY_JSONC_DIR:
            return summary

        try:
            cfg_real = os.path.realpath(XRAY_CONFIGS_DIR)
        except Exception:
            cfg_real = XRAY_CONFIGS_DIR
        try:
            jsonc_real = os.path.realpath(XRAY_JSONC_DIR)
        except Exception:
            jsonc_real = XRAY_JSONC_DIR
        if cfg_real == jsonc_real:
            return summary

        if not os.path.isdir(XRAY_CONFIGS_DIR):
            return summary

        ensure_xray_jsonc_dir()

        now = int(time.time())

        for name in os.listdir(XRAY_CONFIGS_DIR):
            lname = str(name or "").lower()
            if not lname.endswith(".jsonc"):
                continue
            src = os.path.join(XRAY_CONFIGS_DIR, name)
            if not os.path.isfile(src):
                continue

            summary["found"] += 1

            dst = os.path.join(XRAY_JSONC_DIR, os.path.basename(name))
            dst_old = _unique_suffix_path(f"{dst}.old-{now}")

            try:
                if not os.path.exists(dst):
                    # Simple case: no conflicts.
                    shutil.move(src, dst)
                    summary["moved"] += 1
                    continue

                # Conflict: keep the newer one as dst.
                try:
                    src_m = os.stat(src).st_mtime
                except Exception:
                    src_m = 0
                try:
                    dst_m = os.stat(dst).st_mtime
                except Exception:
                    dst_m = 0

                if src_m > dst_m:
                    # Existing dst is older -> archive it, replace with src.
                    shutil.move(dst, dst_old)
                    shutil.move(src, dst)
                    summary["replaced"] += 1
                else:
                    # Src is older -> keep dst, store src as an old copy.
                    shutil.move(src, dst_old)
                    summary["moved_as_old"] += 1
            except Exception:
                # Last resort: try to rename legacy file so Xray won't pick it up.
                try:
                    disabled = _unique_suffix_path(f"{src}.old-{now}")
                    os.replace(src, disabled)
                    summary["disabled_in_place"] += 1
                except Exception:
                    summary["errors"] += 1
                    continue
    except Exception:
        summary["errors"] += 1
    return summary


def _jsonc_name_for(main_path: str) -> str:
    """Return JSONC sidecar filename (basename only) for a given main file."""
    try:
        name = os.path.basename(str(main_path or ""))
    except Exception:
        name = ""
    if not name:
        return ""
    lname = name.lower()
    if lname.endswith(".jsonc"):
        return name
    if lname.endswith(".json"):
        return name + "c"  # 05_routing.json -> 05_routing.jsonc
    return name + ".jsonc"


def jsonc_path_for(main_json_abs_path: str) -> str:
    """Return canonical JSONC sidecar path for a given main JSON file.

    The sidecar always lives in XRAY_JSONC_DIR and uses the same basename:
      <basename>.json  ->  <XRAY_JSONC_DIR>/<basename>.jsonc

    Note: this does NOT check for file existence.
    """
    name = _jsonc_name_for(main_json_abs_path)
    if not name:
        return os.path.join(XRAY_JSONC_DIR, "")
    return os.path.join(XRAY_JSONC_DIR, name)


def legacy_jsonc_path_for(main_json_abs_path: str) -> str:
    """Return legacy JSONC path (sidecar next to main file).

    This is kept for migration/backward compatibility.
    """
    try:
        p = str(main_json_abs_path or "")
    except Exception:
        p = ""
    if not p:
        return ""
    lp = p.lower()
    if lp.endswith(".json"):
        return p + "c"
    if lp.endswith(".jsonc"):
        return p
    return p + ".jsonc"


def resolve_jsonc_path(raw_override: str, *, main_json_abs_path: str) -> str:
    """Resolve JSONC path using override + canonical mapping.

    Rules:
      - absolute override: used as-is
      - relative override: resolved relative to XRAY_JSONC_DIR
      - empty override: canonical jsonc_path_for(main_json_abs_path)
    """
    try:
        v = str(raw_override or "").strip()
    except Exception:
        v = ""
    if v:
        if v.startswith("/"):
            return v
        return os.path.join(XRAY_JSONC_DIR, v)
    return jsonc_path_for(main_json_abs_path)


def _pick_xray_config_file(default_name: str, alt_name: str) -> str:
    """Pick config fragment file path.

    Priority:
      1) default_name if exists
      2) alt_name (e.g. *_hys2.json) if exists
      3) another prefixed routing variant (e.g. 05_routing-2.json)
      4) default_name (for new installs)
    """
    default_path = os.path.join(XRAY_CONFIGS_DIR, default_name)
    alt_path = os.path.join(XRAY_CONFIGS_DIR, alt_name)
    try:
        if os.path.exists(default_path):
            return default_path
        if os.path.exists(alt_path):
            return alt_path
        default_stem = os.path.splitext(os.path.basename(default_name))[0]
        if default_stem == "05_routing":
            candidates = []
            for name in os.listdir(XRAY_CONFIGS_DIR):
                if not str(name).lower().endswith(".json"):
                    continue
                if name in {default_name, alt_name}:
                    continue
                stem = os.path.splitext(name)[0]
                if not stem.startswith(default_stem):
                    continue
                suffix = stem[len(default_stem) :]
                if not suffix or suffix[0] not in {"-", "_", "(", " "}:
                    continue
                cand = os.path.join(XRAY_CONFIGS_DIR, name)
                if os.path.isfile(cand):
                    candidates.append(cand)
            if candidates:
                candidates.sort(key=lambda path: (len(os.path.basename(path)), os.path.basename(path).lower()))
                return candidates[0]
    except Exception:
        # Any failure -> fall back to default
        pass
    return default_path


def _resolve_path_in_dir(base_dir: str, p: str) -> str:
    """Resolve user-provided file path.

    - absolute paths are used as-is
    - relative paths are treated as relative to base_dir
    """
    try:
        v = str(p or "").strip()
    except Exception:
        v = ""
    if not v:
        return ""
    if v.startswith("/"):
        return v
    return os.path.join(base_dir, v)


def env_or_auto_pick(env_key: str, default_name: str, alt_name: str) -> str:
    """Pick xray fragment file, optionally overridden via env."""
    v = os.environ.get(env_key, "")
    if v and str(v).strip():
        return _resolve_path_in_dir(XRAY_CONFIGS_DIR, v)
    return _pick_xray_config_file(default_name, alt_name)


ROUTING_FILE = env_or_auto_pick("XKEEN_XRAY_ROUTING_FILE", "05_routing.json", "05_routing_hys2.json")
INBOUNDS_FILE = env_or_auto_pick("XKEEN_XRAY_INBOUNDS_FILE", "03_inbounds.json", "03_inbounds_hys2.json")
OUTBOUNDS_FILE = env_or_auto_pick("XKEEN_XRAY_OUTBOUNDS_FILE", "04_outbounds.json", "04_outbounds_hys2.json")

# JSONC routing sidecar (with comments) lives in XRAY_JSONC_DIR by default.
# It must be outside XRAY_CONFIGS_DIR so Xray won't accidentally pick it up.
try:
    _raw_override = os.environ.get("XKEEN_XRAY_ROUTING_FILE_RAW", "")
    if _raw_override and str(_raw_override).strip():
        v = str(_raw_override).strip()
        if v.startswith("/"):
            ROUTING_FILE_RAW = v
        else:
            ROUTING_FILE_RAW = os.path.join(XRAY_JSONC_DIR, v)
    else:
        ROUTING_FILE_RAW = jsonc_path_for(ROUTING_FILE)
except Exception:
    ROUTING_FILE_RAW = os.path.join(XRAY_JSONC_DIR, "05_routing.jsonc")


def resolve_xray_fragment_file(file_arg: str, *, kind: str, default_path: str) -> str:
    """Resolve a selectable fragment file inside XRAY_CONFIGS_DIR (safe).

    Args:
        file_arg: value of ?file= query param (usually basename like 05_routing.json)
        kind: one of "routing" | "inbounds" | "outbounds" (used for mild validation)
        default_path: fallback absolute path used when file_arg is empty/invalid.

    Returns:
        Absolute real path to a .json/.jsonc file inside XRAY_CONFIGS_DIR.
    """
    try:
        v = str(file_arg or "").strip()
    except Exception:
        v = ""
    if not v:
        return default_path

    # Allow either basename or absolute path, but keep it inside XRAY_CONFIGS_DIR.
    try:
        if v.startswith("/"):
            cand = v
        else:
            # Disallow nested paths to avoid directory traversal.
            if "/" in v or "\\" in v:
                raise ValueError("invalid filename")
            cand = os.path.join(XRAY_CONFIGS_DIR, v)

        cand_real = os.path.realpath(cand)
        base = XRAY_CONFIGS_DIR_REAL
        if not (cand_real == base or cand_real.startswith(base + os.sep)):
            raise ValueError("outside configs dir")

        if not (cand_real.endswith(".json") or cand_real.endswith(".jsonc")):
            raise ValueError("unsupported extension")

        # Mild validation: keep the user inside the right family of fragments.
        try:
            lname = os.path.basename(cand_real).lower()
            if kind and kind not in lname:
                raise ValueError("kind mismatch")
        except Exception:
            raise

        return cand_real
    except Exception:
        return default_path


def is_sensitive_xray_fragment_name(name: str, *, kind: str = "") -> bool:
    """Best-effort sensitivity flag for config fragments.

    This is intentionally conservative and currently marks:
      - Hysteria2 companion fragments (``*_hys2.json``)
      - explicitly named secret/auth/token/password/private fragments
    """
    try:
        raw = os.path.basename(str(name or "")).lower()
    except Exception:
        raw = ""
    if not raw:
        return False
    if "_hys2" in raw:
        return True
    markers = ("secret", "token", "password", "passwd", "private", "credential", "auth")
    return any(marker in raw for marker in markers)


def list_xray_fragments(kind: str) -> list[dict]:
    """List fragment files in XRAY_CONFIGS_DIR by keyword."""
    items: list[dict] = []
    try:
        if not os.path.isdir(XRAY_CONFIGS_DIR):
            return items
        for name in os.listdir(XRAY_CONFIGS_DIR):
            lname = str(name or "").lower()
            if not lname.endswith(".json"):
                continue
            if kind and kind not in lname:
                continue
            full = os.path.join(XRAY_CONFIGS_DIR, name)
            if not os.path.isfile(full):
                continue
            try:
                st = os.stat(full)
                items.append(
                    {
                        "name": name,
                        "size": int(getattr(st, "st_size", 0) or 0),
                        "mtime": int(getattr(st, "st_mtime", 0) or 0),
                        "hys2": ("_hys2" in lname),
                        "sensitive": is_sensitive_xray_fragment_name(name, kind=kind),
                    }
                )
            except Exception:
                items.append({
                    "name": name,
                    "hys2": ("_hys2" in lname),
                    "sensitive": is_sensitive_xray_fragment_name(name, kind=kind),
                })
    except Exception:
        items = []
    try:
        items.sort(key=lambda it: str(it.get("name") or "").lower())
    except Exception:
        pass
    return items
