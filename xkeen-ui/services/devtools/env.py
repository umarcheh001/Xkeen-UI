"""DevTools ENV editor (split from services.devtools).

This module contains the ENV allow-list, parsing/writing of the shell-compatible
`devtools.env` file, and helper functions used by the DevTools API.

IMPORTANT: Public names are re-exported by `services.devtools` to preserve
backwards-compatible imports.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Mapping, Optional, Tuple


ENV_WHITELIST: Tuple[str, ...] = (
    # UI/server
    "XKEEN_UI_STATE_DIR",
    "XKEEN_UI_ENV_FILE",  # read-only (path to devtools.env)
    "XKEEN_UI_SECRET_KEY",  # shown as "(set)" only
    "XKEEN_AUTH_LOGIN_WINDOW_SECONDS",
    "XKEEN_AUTH_LOGIN_MAX_ATTEMPTS",
    "XKEEN_AUTH_LOGIN_LOCKOUT_SECONDS",
    "XKEEN_INIT_SCRIPT",
    "XKEEN_RESTART_LOG_FILE",
    # self-update (GitHub)
    "XKEEN_UI_UPDATE_REPO",
    "XKEEN_UI_UPDATE_CHANNEL",
    "XKEEN_UI_UPDATE_BRANCH",
    "XKEEN_UI_UPDATE_ASSET_NAME",
    "XKEEN_UI_UPDATE_ALLOW_HOSTS",
    "XKEEN_UI_UPDATE_ALLOW_HTTP",
    "XKEEN_UI_UPDATE_MAX_BYTES",
    "XKEEN_UI_UPDATE_MAX_CHECKSUM_BYTES",
    "XKEEN_UI_UPDATE_CONNECT_TIMEOUT",
    "XKEEN_UI_UPDATE_DOWNLOAD_TIMEOUT",
    "XKEEN_UI_UPDATE_API_TIMEOUT",
    "XKEEN_UI_UPDATE_SHA_STRICT",
    "XKEEN_UI_UPDATE_REQUIRE_SHA",
    # UI layout/visibility (optional)
    "XKEEN_UI_PANEL_SECTIONS_WHITELIST",
    "XKEEN_UI_DEVTOOLS_SECTIONS_WHITELIST",
    # UI logging (core/access/ws)
    "XKEEN_LOG_DIR",
    "XKEEN_LOG_CORE_ENABLE",
    "XKEEN_LOG_CORE_LEVEL",
    "XKEEN_LOG_ACCESS_ENABLE",
    "XKEEN_LOG_WS_ENABLE",
    "XKEEN_LOG_ROTATE_MAX_MB",
    "XKEEN_LOG_ROTATE_BACKUPS",
    # GitHub import
    "XKEEN_GITHUB_OWNER",
    "XKEEN_GITHUB_REPO",
    "XKEEN_GITHUB_BRANCH",
    "XKEEN_GITHUB_REPO_URL",
    # config server
    "XKEEN_CONFIG_SERVER_BASE",
    # terminal (run_server.py)
    "XKEEN_PTY_MAX_BUF_CHARS",
    "XKEEN_PTY_IDLE_TTL_SECONDS",
    # local+remote file manager & file ops
    "XKEEN_REMOTEFM_ENABLE",
    "XKEEN_REMOTEFM_MAX_SESSIONS",
    "XKEEN_REMOTEFM_SESSION_TTL",
    "XKEEN_REMOTEFM_MAX_UPLOAD_MB",
    "XKEEN_REMOTEFM_TMP_DIR",
    "XKEEN_REMOTEFM_STATE_DIR",
    "XKEEN_REMOTEFM_CA_FILE",
    "XKEEN_REMOTEFM_KNOWN_HOSTS",
    "XKEEN_LOCALFM_ROOTS",
    "XKEEN_PROTECT_MNT_LABELS",
    "XKEEN_PROTECTED_MNT_ROOT",
    "XKEEN_TRASH_DIR",
    "XKEEN_TRASH_MAX_BYTES",
    "XKEEN_TRASH_MAX_GB",
    "XKEEN_TRASH_TTL_DAYS",
    "XKEEN_TRASH_WARN_RATIO",
    "XKEEN_TRASH_STATS_CACHE_SECONDS",
    "XKEEN_TRASH_PURGE_INTERVAL_SECONDS",
    "XKEEN_FILEOPS_WORKERS",
    "XKEEN_FILEOPS_MAX_JOBS",
    "XKEEN_FILEOPS_JOB_TTL",
    "XKEEN_FILEOPS_REMOTE2REMOTE_DIRECT",
    "XKEEN_FILEOPS_FXP",
    "XKEEN_FILEOPS_SPOOL_DIR",
    "XKEEN_FILEOPS_SPOOL_MAX_MB",
    "XKEEN_FILEOPS_SPOOL_CLEANUP_AGE",
    # zip limits
    "XKEEN_MAX_ZIP_MB",
    "XKEEN_MAX_ZIP_ESTIMATE_ITEMS",
    # misc
    "XKEEN_ALLOW_SHELL",
    "XKEEN_XRAY_LOG_TZ_OFFSET",

    # Xray fragment paths (routing/inbounds/outbounds)
    "XKEEN_XRAY_CONFIGS_DIR",
    "XKEEN_XRAY_JSONC_DIR",
    "XKEEN_XRAY_ROUTING_FILE",
    "XKEEN_XRAY_INBOUNDS_FILE",
    "XKEEN_XRAY_OUTBOUNDS_FILE",
    "XKEEN_XRAY_ROUTING_FILE_RAW",

    # Xkeen lists (ports / excludes)
    "XKEEN_PORT_PROXYING_FILE",
    "XKEEN_PORT_EXCLUDE_FILE",
    "XKEEN_IP_EXCLUDE_FILE",
    "XKEEN_CONFIG_FILE",
)


ENV_READONLY: Tuple[str, ...] = (
    "XKEEN_UI_ENV_FILE",
)



_SENSITIVE_KEYS = {
    "XKEEN_UI_SECRET_KEY",
}


@dataclass
class EnvItem:
    key: str
    current: Optional[str]
    configured: Optional[str]
    effective: Optional[str]
    is_sensitive: bool = False
    readonly: bool = False


def _default_effective_value(
    key: str,
    ui_state_dir: str,
    *,
    resolve: Optional[Callable[[str], Optional[str]]] = None,
) -> Optional[str]:
    """Return a conservative default value for a whitelisted env var.

    These defaults mirror the UI/runtime defaults used across the project so the
    DevTools ENV editor can show meaningful initial values even when variables
    are not explicitly set.

    Important: This only affects UI display ("effective" value). Nothing is
    written unless the user presses Save.
    """
    k = (key or "").strip()
    if not k:
        return None

    # Helper readers (keep conservative; defaults must match runtime code).
    def _env_str(name: str) -> Optional[str]:
        v = os.environ.get(name)
        if v is None:
            return None
        s = str(v).strip()
        return s if s != "" else None

    def _eff_str(name: str) -> Optional[str]:
        """Effective value for dependent defaults.

        Prefer the caller-provided resolver (which can include env-file values)
        and fall back to the live process environment.
        """
        if resolve is not None:
            try:
                v = resolve(name)
                if v is not None:
                    s = str(v).strip()
                    if s != "":
                        return s
            except Exception:
                pass
        return _env_str(name)

    def _env_int(name: str, default: int) -> int:
        try:
            v = _eff_str(name)
            if v is None:
                return int(default)
            return int(float(v))
        except Exception:
            return int(default)

    def _choose_base_dir(default_dir: str, fallback_dir: str) -> str:
        """Mimic app.py _choose_base_dir (writable check), best-effort."""
        try:
            os.makedirs(default_dir, exist_ok=True)
            test_path = os.path.join(default_dir, ".writetest")
            with open(test_path, "w", encoding="utf-8") as f:
                f.write("")
            os.remove(test_path)
            return default_dir
        except Exception:
            try:
                os.makedirs(fallback_dir, exist_ok=True)
            except Exception:
                pass
            return fallback_dir

    # UI/server
    if k == "XKEEN_UI_STATE_DIR":
        # Reflect the actual directory the UI is running with.
        return ui_state_dir

    # Note: legacy XKEEN_UI_DIR is intentionally hidden from DevTools ENV editor.
    # Runtime still supports it for backward compatibility (see app.py).

    if k == "XKEEN_UI_SECRET_KEY":
        # Secret key is usually auto-generated and stored on disk (UI_STATE_DIR/secret.key).
        # Never reveal it here; only indicate that a value exists.
        try:
            secret_path = os.path.join(ui_state_dir, "secret.key")
            if os.path.isfile(secret_path):
                return "(generated)"
        except Exception:
            pass
        return "(generated)"

    if k == "XKEEN_UI_ENV_FILE":
        # Path to the persisted env file used by the init script.
        return os.path.join(ui_state_dir, "devtools.env")

    if k == "XKEEN_INIT_SCRIPT":
        # Keep DevTools aligned with the runtime resolver for old/new XKeen init.d names.
        try:
            from services.xkeen_commands_catalog import resolve_xkeen_init_script

            return resolve_xkeen_init_script() or "/opt/etc/init.d/S05xkeen"
        except Exception:
            return "/opt/etc/init.d/S05xkeen"

    if k == "XKEEN_RESTART_LOG_FILE":
        # app.py uses <UI_STATE_DIR>/restart.log
        return os.path.join(ui_state_dir, "restart.log")

    if k == "XKEEN_AUTH_LOGIN_WINDOW_SECONDS":
        return "300"
    if k == "XKEEN_AUTH_LOGIN_MAX_ATTEMPTS":
        return "5"
    if k == "XKEEN_AUTH_LOGIN_LOCKOUT_SECONDS":
        return "900"

    # Self-update defaults
    if k == "XKEEN_UI_UPDATE_REPO":
        return "umarcheh001/Xkeen-UI"
    if k == "XKEEN_UI_UPDATE_CHANNEL":
        return "stable"
    if k == "XKEEN_UI_UPDATE_BRANCH":
        return "main"
    if k == "XKEEN_UI_UPDATE_ASSET_NAME":
        # Default project convention (stable). For main channel this is ignored.
        return "xkeen-ui-routing.tar.gz"
    if k == "XKEEN_UI_UPDATE_ALLOW_HOSTS":
        return "github.com,objects.githubusercontent.com,codeload.github.com"
    if k == "XKEEN_UI_UPDATE_ALLOW_HTTP":
        return "0"
    if k == "XKEEN_UI_UPDATE_MAX_BYTES":
        return str(60 * 1024 * 1024)
    if k == "XKEEN_UI_UPDATE_MAX_CHECKSUM_BYTES":
        return str(1024 * 1024)
    if k == "XKEEN_UI_UPDATE_CONNECT_TIMEOUT":
        return "10"
    if k == "XKEEN_UI_UPDATE_DOWNLOAD_TIMEOUT":
        return "300"
    if k == "XKEEN_UI_UPDATE_API_TIMEOUT":
        return "10"
    if k == "XKEEN_UI_UPDATE_SHA_STRICT":
        return "1"
    if k == "XKEEN_UI_UPDATE_REQUIRE_SHA":
        return "0"

    # Logging defaults (services/logging_setup.py + app.py fallback on non-router dev).
    if k == "XKEEN_LOG_DIR":
        base_var = _choose_base_dir("/opt/var", os.path.join(ui_state_dir, "var"))
        return os.path.join(base_var, "log", "xkeen-ui")
    if k == "XKEEN_LOG_CORE_ENABLE":
        return "1"
    if k == "XKEEN_LOG_CORE_LEVEL":
        return "INFO"
    if k in ("XKEEN_LOG_ACCESS_ENABLE", "XKEEN_LOG_WS_ENABLE"):
        return "0"
    if k == "XKEEN_LOG_ROTATE_MAX_MB":
        return "2"
    if k == "XKEEN_LOG_ROTATE_BACKUPS":
        return "3"

    # GitHub import defaults (app.py)
    if k == "XKEEN_GITHUB_OWNER":
        return "umarcheh001"
    if k == "XKEEN_GITHUB_REPO":
        return "xkeen-community-configs"
    if k == "XKEEN_GITHUB_BRANCH":
        return "main"
    if k == "XKEEN_GITHUB_REPO_URL":
        # app.py default: https://github.com/{owner}/{repo}
        owner = _eff_str("XKEEN_GITHUB_OWNER") or "umarcheh001"
        repo = _eff_str("XKEEN_GITHUB_REPO") or "xkeen-community-configs"
        return f"https://github.com/{owner}/{repo}"

    # Config server (app.py)
    if k == "XKEEN_CONFIG_SERVER_BASE":
        return "http://144.31.17.58:8000"

    # Terminal (run_server.py)
    if k == "XKEEN_PTY_MAX_BUF_CHARS":
        return "65536"
    if k == "XKEEN_PTY_IDLE_TTL_SECONDS":
        return "1800"

    # RemoteFM / File manager / FileOps defaults (app.py + routes_remotefs.py)
    if k == "XKEEN_REMOTEFM_ENABLE":
        return "1"
    if k == "XKEEN_REMOTEFM_MAX_SESSIONS":
        return "6"
    if k == "XKEEN_REMOTEFM_SESSION_TTL":
        return "900"
    if k == "XKEEN_REMOTEFM_MAX_UPLOAD_MB":
        return "200"
    if k == "XKEEN_REMOTEFM_TMP_DIR":
        return "/tmp"
    if k == "XKEEN_REMOTEFM_STATE_DIR":
        # routes_remotefs.py prefers /opt/var/lib/xkeen-ui/remotefs
        return "/opt/var/lib/xkeen-ui/remotefs"
    if k == "XKEEN_REMOTEFM_KNOWN_HOSTS":
        state_dir = _eff_str("XKEEN_REMOTEFM_STATE_DIR") or "/opt/var/lib/xkeen-ui/remotefs"
        return os.path.join(state_dir, "known_hosts")
    if k == "XKEEN_REMOTEFM_CA_FILE":
        # Keep the best-known Entware location as a reasonable default hint.
        # routes_remotefs.py also checks /etc/ssl/... and /opt/etc/ssl/...
        return "/opt/etc/ssl/certs/ca-certificates.crt"

    if k == "XKEEN_LOCALFM_ROOTS":
        return "/opt/etc:/opt/var:/tmp"

    if k == "XKEEN_PROTECT_MNT_LABELS":
        return "1"
    if k == "XKEEN_PROTECTED_MNT_ROOT":
        return "/tmp/mnt"

    if k == "XKEEN_TRASH_DIR":
        return "/opt/var/trash"
    if k == "XKEEN_TRASH_MAX_BYTES":
        return str(3 * 1024 * 1024 * 1024)
    if k == "XKEEN_TRASH_MAX_GB":
        return "3"
    if k == "XKEEN_TRASH_TTL_DAYS":
        return "30"
    if k == "XKEEN_TRASH_WARN_RATIO":
        return "0.9"
    if k == "XKEEN_TRASH_STATS_CACHE_SECONDS":
        return "10"
    if k == "XKEEN_TRASH_PURGE_INTERVAL_SECONDS":
        return "3600"

    if k == "XKEEN_FILEOPS_WORKERS":
        return "1"
    if k == "XKEEN_FILEOPS_MAX_JOBS":
        return "100"
    if k == "XKEEN_FILEOPS_JOB_TTL":
        return "3600"
    if k == "XKEEN_FILEOPS_REMOTE2REMOTE_DIRECT":
        return "1"
    if k == "XKEEN_FILEOPS_FXP":
        return "1"
    if k == "XKEEN_FILEOPS_SPOOL_DIR":
        tmp_dir = _eff_str("XKEEN_REMOTEFM_TMP_DIR") or "/tmp"
        return os.path.join(tmp_dir, "xkeen_fileops_spool")
    if k == "XKEEN_FILEOPS_SPOOL_MAX_MB":
        # routes_remotefs.py default: max_upload_mb, minimum 16
        try:
            max_upload = int(float(_eff_str("XKEEN_REMOTEFM_MAX_UPLOAD_MB") or "200"))
        except Exception:
            max_upload = 200
        return str(max(16, max_upload))
    if k == "XKEEN_FILEOPS_SPOOL_CLEANUP_AGE":
        return "21600"

    # ZIP limits (routes_fs.py)
    if k == "XKEEN_MAX_ZIP_MB":
        return "0"
    if k == "XKEEN_MAX_ZIP_ESTIMATE_ITEMS":
        return "200000"

    # Misc
    if k == "XKEEN_ALLOW_SHELL":
        return "0"

    # Xray/Mihomo log timezone offset default (+3, see app.py).
    if k == "XKEEN_XRAY_LOG_TZ_OFFSET":
        return "3"

    # Xray fragment/config paths (keep in sync with app.py).
    if k == "XKEEN_XRAY_CONFIGS_DIR":
        return "/opt/etc/xray/configs"
    if k == "XKEEN_XRAY_JSONC_DIR":
        # UI stores raw JSONC sidecars here (must be outside XRAY_CONFIGS_DIR).
        return os.path.join(ui_state_dir, "xray-jsonc")
    if k == "XKEEN_XRAY_ROUTING_FILE":
        # Basename is relative to XKEEN_XRAY_CONFIGS_DIR.
        return "05_routing.json"
    if k == "XKEEN_XRAY_INBOUNDS_FILE":
        return "03_inbounds.json"
    if k == "XKEEN_XRAY_OUTBOUNDS_FILE":
        return "04_outbounds.json"
    if k == "XKEEN_XRAY_ROUTING_FILE_RAW":
        # Show resolved/actual path (relative overrides are treated as relative to XKEEN_XRAY_JSONC_DIR).
        try:
            configs_dir = _eff_str("XKEEN_XRAY_CONFIGS_DIR") or "/opt/etc/xray/configs"
            jsonc_dir = _eff_str("XKEEN_XRAY_JSONC_DIR") or os.path.join(ui_state_dir, "xray-jsonc")
            routing = _eff_str("XKEEN_XRAY_ROUTING_FILE") or "05_routing.json"
            main_abs = routing if routing.startswith("/") else os.path.join(configs_dir, routing)
            base = os.path.basename(main_abs)
            if base.lower().endswith(".jsonc"):
                jsonc_base = base
            elif base.lower().endswith(".json"):
                jsonc_base = base + "c"  # 05_routing*.json -> 05_routing*.jsonc
            else:
                jsonc_base = base + ".jsonc"
            return os.path.join(jsonc_dir, jsonc_base)
        except Exception:
            return os.path.join(ui_state_dir, "xray-jsonc", "05_routing.jsonc")

    # XKeen list paths
    if k == "XKEEN_PORT_PROXYING_FILE":
        return "/opt/etc/xkeen/port_proxying.lst"
    if k == "XKEEN_PORT_EXCLUDE_FILE":
        return "/opt/etc/xkeen/port_exclude.lst"
    if k == "XKEEN_IP_EXCLUDE_FILE":
        return "/opt/etc/xkeen/ip_exclude.lst"
    if k == "XKEEN_CONFIG_FILE":
        return "/opt/etc/xkeen/xkeen.json"

    return None


def _env_file_path(ui_state_dir: str) -> str:
    """Resolve env-file path.

    Override with ``XKEEN_UI_ENV_FILE``.
    """
    p = (os.getenv("XKEEN_UI_ENV_FILE") or "").strip()
    if p:
        return p
    return os.path.join(ui_state_dir, "devtools.env")


_LINE_RE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$")


def _unquote_shell_value(raw: str) -> str:
    s = raw.strip()
    if not s:
        return ""
    if (s.startswith("'") and s.endswith("'")) or (s.startswith('"') and s.endswith('"')):
        s2 = s[1:-1]
        # Minimal unescape for "..." (we keep it conservative)
        if raw.strip().startswith('"'):
            s2 = s2.replace("\\\"", '"').replace("\\\\", "\\")
        return s2
    return s


def read_env_file(path: str) -> Dict[str, str]:
    """Parse shell-compatible env file into dict."""
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            lines = f.readlines()
    except FileNotFoundError:
        return {}
    except OSError:
        return {}

    out: Dict[str, str] = {}
    for line in lines:
        ln = line.strip()
        if not ln or ln.startswith("#"):
            continue
        m = _LINE_RE.match(line)
        if not m:
            continue
        k = m.group(1)
        v_raw = m.group(2)
        out[k] = _unquote_shell_value(v_raw)
    return out


def _shell_quote_single(s: str) -> str:
    """Quote a value for safe single-quoted shell assignment."""
    # ' -> '\'' pattern
    return "'" + s.replace("'", "'\"'\"'") + "'"


def write_env_file(path: str, values: Mapping[str, str]) -> None:
    """Write env file with `export KEY='value'` lines."""
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("# Generated by Xkeen UI DevTools\n")
        f.write("# Format: export KEY='value'\n\n")
        for k in sorted(values.keys()):
            v = values.get(k, "")
            f.write(f"export {k}={_shell_quote_single(str(v))}\n")
    try:
        os.replace(tmp, path)
    except Exception:
        # last resort
        try:
            with open(path, "w", encoding="utf-8") as f2:
                with open(tmp, "r", encoding="utf-8") as f1:
                    f2.write(f1.read())
        finally:
            try:
                os.remove(tmp)
            except Exception:
                pass


def get_env_items(ui_state_dir: str, whitelist: Tuple[str, ...] = ENV_WHITELIST) -> List[EnvItem]:
    env_path = _env_file_path(ui_state_dir)
    cfg = read_env_file(env_path)

    # Two-pass render:
    # 1) gather current/configured values
    # 2) fill missing values with defaults that may depend on other effective values
    base_effective: Dict[str, Optional[str]] = {}
    rows: List[Dict[str, Any]] = []

    for k in whitelist:
        cur = os.environ.get(k)
        conf = cfg.get(k)

        # Backward-compatibility: XKEEN_UI_DIR was a legacy alias for
        # XKEEN_UI_STATE_DIR. DevTools no longer exposes XKEEN_UI_DIR, but we
        # still show its value under XKEEN_UI_STATE_DIR so users can migrate.
        if k == "XKEEN_UI_STATE_DIR":
            if cur is None:
                cur = os.environ.get("XKEEN_UI_DIR")
            if conf is None:
                conf = cfg.get("XKEEN_UI_DIR")
        is_sensitive = k in _SENSITIVE_KEYS
        if is_sensitive:
            # Never leak secrets
            cur_disp = "(set)" if cur else None
            conf_disp = "(set)" if conf else None
            eff0 = cur_disp if cur_disp is not None else conf_disp
            rows.append({
                "key": k,
                "current": cur_disp,
                "configured": conf_disp,
                "effective0": eff0,
                "is_sensitive": True,
                "readonly": (k in set(ENV_READONLY)),
            })
            base_effective[k] = eff0
        else:
            eff0 = cur if cur is not None else conf
            rows.append({
                "key": k,
                "current": cur,
                "configured": conf,
                "effective0": eff0,
                "is_sensitive": False,
                "readonly": (k in set(ENV_READONLY)),
            })
            base_effective[k] = eff0

    def _resolve(name: str) -> Optional[str]:
        try:
            v = base_effective.get(name)
            if v is None:
                return None
            s = str(v).strip()
            return s if s != "" else None
        except Exception:
            return None

    items: List[EnvItem] = []
    for r in rows:
        k = str(r.get("key") or "")
        eff = r.get("effective0")
        if eff is None:
            eff = _default_effective_value(k, ui_state_dir, resolve=_resolve)
        items.append(
            EnvItem(
                key=k,
                current=r.get("current"),
                configured=r.get("configured"),
                effective=eff,
                is_sensitive=bool(r.get("is_sensitive")),
                readonly=bool(r.get("readonly")),
            )
        )

    # Post-process: show resolved/actual path for the routing JSONC sidecar.
    # Runtime resolves relative XKEEN_XRAY_ROUTING_FILE_RAW against XKEEN_XRAY_JSONC_DIR.
    try:
        m = {it.key: it for it in items}
        it_raw = m.get("XKEEN_XRAY_ROUTING_FILE_RAW")
        if it_raw and not it_raw.is_sensitive:
            cfg_dir = (m.get("XKEEN_XRAY_CONFIGS_DIR").effective if m.get("XKEEN_XRAY_CONFIGS_DIR") else None) or "/opt/etc/xray/configs"
            jsonc_dir = (m.get("XKEEN_XRAY_JSONC_DIR").effective if m.get("XKEEN_XRAY_JSONC_DIR") else None) or os.path.join(ui_state_dir, "xray-jsonc")
            routing = (m.get("XKEEN_XRAY_ROUTING_FILE").effective if m.get("XKEEN_XRAY_ROUTING_FILE") else None) or "05_routing.json"

            try:
                cfg_dir = str(cfg_dir).strip() or "/opt/etc/xray/configs"
            except Exception:
                cfg_dir = "/opt/etc/xray/configs"
            try:
                jsonc_dir = str(jsonc_dir).strip() or os.path.join(ui_state_dir, "xray-jsonc")
            except Exception:
                jsonc_dir = os.path.join(ui_state_dir, "xray-jsonc")
            try:
                routing = str(routing).strip() or "05_routing.json"
            except Exception:
                routing = "05_routing.json"

            main_abs = routing if routing.startswith("/") else os.path.join(cfg_dir, routing)
            base = os.path.basename(main_abs)
            if base.lower().endswith(".jsonc"):
                jsonc_base = base
            elif base.lower().endswith(".json"):
                jsonc_base = base + "c"
            else:
                jsonc_base = base + ".jsonc"

            # If user configured an override, resolve it; otherwise use canonical mapping.
            override = None
            try:
                if it_raw.current is not None and str(it_raw.current).strip() != "":
                    override = str(it_raw.current).strip()
                elif it_raw.configured is not None and str(it_raw.configured).strip() != "":
                    override = str(it_raw.configured).strip()
            except Exception:
                override = None

            if override:
                it_raw.effective = override if override.startswith("/") else os.path.join(jsonc_dir, override)
            else:
                it_raw.effective = os.path.join(jsonc_dir, jsonc_base)
    except Exception:
        pass

    return items


def set_env(ui_state_dir: str, updates: Mapping[str, Optional[str]], whitelist: Tuple[str, ...] = ENV_WHITELIST) -> List[EnvItem]:
    """Apply whitelisted env updates and persist to env-file.

    ``updates``: key -> value (None/"" to unset).
    """
    allowed = set(whitelist)
    env_path = _env_file_path(ui_state_dir)
    cfg = read_env_file(env_path)

    changed = False
    for k, v in updates.items():
        if k not in allowed:
            continue
        if k in set(ENV_READONLY):
            continue
        if k in _SENSITIVE_KEYS:
            # We do allow setting secret, but we never show it back.
            pass

        # Migration: XKEEN_UI_DIR is a legacy alias for XKEEN_UI_STATE_DIR.
        # It is hidden from the DevTools ENV editor, but we still clean it up
        # when the user updates/unsets XKEEN_UI_STATE_DIR so there is no
        # confusing duplication in the persisted env file.
        if k == "XKEEN_UI_STATE_DIR":
            if "XKEEN_UI_DIR" in cfg:
                cfg.pop("XKEEN_UI_DIR", None)
                changed = True
            try:
                os.environ.pop("XKEEN_UI_DIR", None)
            except Exception:
                pass

        if v is None or str(v) == "":
            if k in cfg:
                cfg.pop(k, None)
                changed = True
            try:
                os.environ.pop(k, None)
            except Exception:
                pass
            continue

        vv = str(v)
        if cfg.get(k) != vv:
            cfg[k] = vv
            changed = True
        try:
            os.environ[k] = vv
        except Exception:
            pass

    if changed:
        write_env_file(env_path, cfg)

    return get_env_items(ui_state_dir, whitelist=whitelist)
