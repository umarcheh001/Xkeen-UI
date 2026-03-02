"""Backend capabilities detection.

PR17: extracted from app.py.

The frontend uses /api/capabilities to conditionally enable features.
The JSON payload shape is treated as an API contract.

Design notes
- Do not raise: the endpoint should be best-effort.
- Keep output keys stable.
- WebSocket runtime is detected via env var XKEEN_WS_RUNTIME=1
  (set by app.set_ws_runtime called from run_server.py).
"""

from __future__ import annotations

import os
import sys
from typing import Callable, Dict, Optional

from core.paths import UI_STATE_DIR, BASE_ETC_DIR, BASE_VAR_DIR
from core.mihomo_paths import init_mihomo_paths
from mihomo_server_core import CONFIG_PATH
from services.logging_setup import get_log_dir
from services.xray_config_files import ROUTING_FILE, INBOUNDS_FILE, OUTBOUNDS_FILE, XRAY_CONFIGS_DIR


def _env_bool(env: Dict[str, str], name: str, default: bool = False) -> bool:
    v = env.get(name)
    if v is None:
        return default
    s = str(v).strip().lower()
    if s in ("1", "true", "yes", "on", "y"):
        return True
    if s in ("0", "false", "no", "off", "n", "-"):
        return False
    return default


def _env_int(env: Dict[str, str], name: str, default: int) -> int:
    v = env.get(name)
    if v is None:
        return default
    try:
        return int(str(v).strip())
    except Exception:
        return default


def _detect_machine_arch() -> str:
    try:
        return (os.uname().machine or "").strip()
    except Exception:
        try:
            import platform

            return (platform.machine() or "").strip()
        except Exception:
            return ""


def _is_mips_arch(machine: str) -> bool:
    m = (machine or "").lower()
    return m.startswith("mips")


def _which_lftp(which: Callable[[str], Optional[str]]) -> Optional[str]:
    """Resolve lftp binary path.

    Prefer Entware location, then common system paths, then PATH via provided `which`.
    """
    candidates = ["/opt/bin/lftp", "/usr/bin/lftp", "/bin/lftp"]
    for c in candidates:
        try:
            if os.path.isfile(c) and os.access(c, os.X_OK):
                return c
        except Exception:
            pass

    # Ensure /opt/bin is on PATH for which() resolution.
    try:
        path = os.environ.get("PATH", "")
        if "/opt/bin" not in path.split(":"):
            os.environ["PATH"] = "/opt/bin:" + path
    except Exception:
        pass

    try:
        return which("lftp")
    except Exception:
        return None


def detect_remotefs_state(
    env: Dict[str, str],
    *,
    which: Callable[[str], Optional[str]] = __import__("shutil").which,
) -> Dict[str, object]:
    """Detect RemoteFS availability.

    Returns a dict with internal details (may include keys not present in /api/capabilities).
    """
    machine_arch = _detect_machine_arch()
    lftp_bin = _which_lftp(which)
    supported = bool(lftp_bin) and (not _is_mips_arch(machine_arch))
    enabled = supported and _env_bool(env, "XKEEN_REMOTEFM_ENABLE", True)

    reason = None
    if not lftp_bin:
        reason = "lftp_missing"
    elif _is_mips_arch(machine_arch):
        reason = "arch_mips_disabled"
    elif not enabled:
        reason = "disabled"

    return {
        "enabled": bool(enabled),
        "supported": bool(supported),
        "arch": machine_arch,
        "lftp_bin": lftp_bin,
        "reason": reason,
    }


def _detect_runtime_mode(env: Dict[str, str]) -> str:
    # Can be overridden by env: XKEEN_RUNTIME=router|dev
    rt_env = (env.get("XKEEN_RUNTIME") or env.get("XKEEN_ENV") or "").strip().lower()
    if rt_env in ("router", "dev", "desktop", "mac"):
        return "router" if rt_env == "router" else "dev"

    try:
        is_darwin = sys.platform == "darwin"
    except Exception:
        is_darwin = False
    if is_darwin:
        return "dev"

    # /proc/ndm and ndmc are common on Keenetic; opkg indicates Entware
    try:
        has_ndm = os.path.exists("/proc/ndm") or os.path.exists("/opt/etc/ndm")
    except Exception:
        has_ndm = False
    try:
        import shutil as _sh

        has_ndmc = bool(_sh.which("ndmc"))
    except Exception:
        has_ndmc = False
    try:
        has_opkg = os.path.exists("/opt/bin/opkg")
    except Exception:
        has_opkg = False

    try:
        is_opt = str(BASE_ETC_DIR).startswith("/opt/")
    except Exception:
        is_opt = False

    return "router" if (has_ndm or has_ndmc or has_opkg or is_opt) else "dev"


def detect_capabilities(
    env: Dict[str, str],
    *,
    which: Callable[[str], Optional[str]] = __import__("shutil").which,
) -> Dict[str, object]:
    """Detect backend capabilities.

    Returns dict ready to be returned as JSON by /api/capabilities.
    """
    # WS runtime marker (set by app.set_ws_runtime called from run_server.py).
    ws_runtime = _env_bool(env, "XKEEN_WS_RUNTIME", False)

    rt_mode = _detect_runtime_mode(env)

    # Log dir used by UI logging setup (best-effort, no side effects).
    default_log_dir = os.path.join(str(BASE_VAR_DIR), "log", "xkeen-ui")
    ui_log_dir = get_log_dir(default_log_dir)

    mihomo_config_file, mihomo_root_dir, _tmpl_dir, _default_tmpl = init_mihomo_paths(CONFIG_PATH)

    runtime = {
        "mode": rt_mode,
        "platform": sys.platform,
        "ws_runtime": bool(ws_runtime),
        "ui_state_dir": UI_STATE_DIR,
        "base_etc_dir": BASE_ETC_DIR,
        "base_var_dir": BASE_VAR_DIR,
        "ui_log_dir": ui_log_dir,
        "mihomo_root_dir": mihomo_root_dir,
        "mihomo_config_file": mihomo_config_file,
    }

    restart_log_file = env.get("XKEEN_RESTART_LOG_FILE") or os.path.join(UI_STATE_DIR, "restart.log")

    files = {
        "routing": ROUTING_FILE,
        "inbounds": INBOUNDS_FILE,
        "outbounds": OUTBOUNDS_FILE,
        "mihomo": mihomo_config_file,
        "restart_log": restart_log_file,
    }

    # RemoteFS
    r = detect_remotefs_state(env, which=which)
    arch = str(r.get("arch") or "")
    lftp_bin = r.get("lftp_bin")
    enabled = bool(r.get("enabled"))

    remote = {
        "enabled": bool(enabled),
        "supported": bool(r.get("supported")),
        "arch": arch,
        "backend": "lftp" if lftp_bin else None,
        "reason": r.get("reason"),
        "protocols": {
            "sftp": bool(lftp_bin) and not _is_mips_arch(arch),
            "ftp": bool(lftp_bin) and not _is_mips_arch(arch),
            "ftps": bool(lftp_bin) and not _is_mips_arch(arch),
        },
        "limits": {
            "max_sessions": _env_int(env, "XKEEN_REMOTEFM_MAX_SESSIONS", 6),
            "session_ttl_seconds": _env_int(env, "XKEEN_REMOTEFM_SESSION_TTL", 900),
            "max_upload_mb": _env_int(env, "XKEEN_REMOTEFM_MAX_UPLOAD_MB", 200),
        },
        "fileops": {
            "enabled": bool(enabled),
            "ws": bool(ws_runtime and enabled),
            "workers": _env_int(env, "XKEEN_FILEOPS_WORKERS", 1),
            "max_jobs": _env_int(env, "XKEEN_FILEOPS_MAX_JOBS", 100),
            "job_ttl_seconds": _env_int(env, "XKEEN_FILEOPS_JOB_TTL", 3600),
            "ops": ["copy", "move", "delete"],
            "remote_to_remote": bool(enabled),
            "remote_to_remote_direct": _env_bool(env, "XKEEN_FILEOPS_REMOTE2REMOTE_DIRECT", True),
            "fxp": _env_bool(env, "XKEEN_FILEOPS_FXP", True),
            "spool_max_mb": _env_int(
                env,
                "XKEEN_FILEOPS_SPOOL_MAX_MB",
                _env_int(env, "XKEEN_REMOTEFM_MAX_UPLOAD_MB", 200),
            ),
            "overwrite_modes": ["replace", "skip", "ask"],
            "supports_dry_run": True,
            "supports_decisions": True,
        },
        "fs_admin": {
            "local": {"chmod": True, "chown": True, "touch": True, "stat_batch": True},
            "remote": {
                "chmod": True,
                "chown": True,
                "chown_protocols": ["sftp"],
                "touch": True,
                "stat_batch": True,
            },
        },
    }

    # USB storage (ndmc show usb + system mount/no mount)
    ndmc_bin = None
    try:
        ndmc_bin = which("ndmc")
    except Exception:
        ndmc_bin = None

    storage_usb = {
        "enabled": bool(ndmc_bin),
        "supported": bool(ndmc_bin),
        "reason": None if ndmc_bin else "ndmc_missing",
    }

    return {
        "websocket": bool(ws_runtime),
        "runtime": runtime,
        "files": files,
        "remoteFs": remote,
        "storageUsb": storage_usb,
    }
