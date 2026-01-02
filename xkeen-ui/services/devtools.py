"""DevTools service helpers.

This module is intentionally conservative:

* Only a *whitelisted* set of environment variables can be read/changed.
* Only a *whitelisted* set of log targets can be tailed/cleared.
* UI service control is done via init-script (when present).

The env values are persisted in a shell-compatible file (default: ``devtools.env``)
so that init script can `source` it before launching the UI.
"""

from __future__ import annotations

import os
import sys
import re
import subprocess
import base64
import json
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Mapping, Optional, Tuple

from services.xray_logs import tail_lines_fast, read_new_lines


# ---------------------------------------------------------------------------
# Safe defaults / allow-lists
# ---------------------------------------------------------------------------


ENV_WHITELIST: Tuple[str, ...] = (
    # UI/server
    "XKEEN_UI_STATE_DIR",
    "XKEEN_UI_SECRET_KEY",  # shown as "(set)" only
    "XKEEN_RESTART_LOG_FILE",
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
)


ENV_READONLY: Tuple[str, ...] = (
    "XKEEN_UI_ENV_FILE",
)


def _ui_state_dir() -> str:
    # Keep in sync with app.py defaults
    return (
        (os.environ.get("XKEEN_UI_STATE_DIR") or os.environ.get("XKEEN_UI_DIR") or "/opt/etc/xkeen-ui").strip()
        or "/opt/etc/xkeen-ui"
    )


def _restart_log_path() -> str:
    return (os.environ.get("XKEEN_RESTART_LOG_FILE") or os.path.join(_ui_state_dir(), "restart.log")).strip()


def _log_dir() -> str:
    # Keep in sync with services/logging_setup.py and app.py
    return (os.environ.get("XKEEN_LOG_DIR") or "/opt/var/log/xkeen-ui").strip() or "/opt/var/log/xkeen-ui"


def _log_targets() -> Mapping[str, str]:
    """Return available log targets.

    Prefer the real paths from services/logging_setup (it knows the actual
    configured directory, including dev fallbacks). Fall back to legacy
    /opt/var paths when logging_setup isn't available.
    """
    try:
        from services import logging_setup as _ls  # local import to keep logging optional

        core, access, ws = _ls.get_paths()  # type: ignore[attr-defined]
        d = os.path.dirname(core)
        return {
            "core": core,
            "access": access,
            "ws": ws,
            "stdout": os.path.join(d, "stdout.log"),
            "stderr": os.path.join(d, "stderr.log"),
            "restart": _restart_log_path(),
            # Legacy single-file log (old init script)
            "xkeen-ui": "/opt/var/log/xkeen-ui.log",
        }
    except Exception:
        d = _log_dir()
        return {
            # Split logs (recommended)
            "core": os.path.join(d, "core.log"),
            "access": os.path.join(d, "access.log"),
            "ws": os.path.join(d, "ws.log"),
            "stdout": os.path.join(d, "stdout.log"),
            "stderr": os.path.join(d, "stderr.log"),
            "restart": _restart_log_path(),
            # Legacy single-file log (old init script)
            "xkeen-ui": "/opt/var/log/xkeen-ui.log",
        }



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

    if k == "XKEEN_RESTART_LOG_FILE":
        # app.py uses <UI_STATE_DIR>/restart.log
        return os.path.join(ui_state_dir, "restart.log")

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
        return "1"

    # Xray/Mihomo log timezone offset default (+3, see app.py).
    if k == "XKEEN_XRAY_LOG_TZ_OFFSET":
        return "3"

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


def _resolve_log_path(name: str) -> Optional[str]:
    targets = dict(_log_targets())
    if name in targets:
        return targets.get(name)

    m = re.match(r"^([A-Za-z0-9_-]+)\.(\d+)$", str(name or ""))
    if not m:
        return None
    base = m.group(1)
    idx = m.group(2)
    base_path = targets.get(base)
    if not base_path:
        return None
    cand = f"{base_path}.{idx}"
    if os.path.isfile(cand):
        return cand
    return None


def _stat_log(path: str) -> Dict[str, Any]:
    try:
        st = os.stat(path)
        return {
            "size": int(getattr(st, "st_size", 0) or 0),
            "mtime": float(getattr(st, "st_mtime", 0.0) or 0.0),
            "ino": int(getattr(st, "st_ino", 0) or 0),
        }
    except Exception:
        return {"size": 0, "mtime": 0.0, "ino": 0}


def _b64e(b: bytes) -> str:
    if not b:
        return ""
    return base64.urlsafe_b64encode(b).decode("ascii")


def _b64d(s: str) -> bytes:
    if not s:
        return b""
    try:
        return base64.urlsafe_b64decode(s.encode("ascii"))
    except Exception:
        try:
            pad = "=" * (-len(s) % 4)
            return base64.urlsafe_b64decode((s + pad).encode("ascii"))
        except Exception:
            return b""


def _encode_cursor(obj: Dict[str, Any]) -> str:
    try:
        raw = json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        return base64.urlsafe_b64encode(raw).decode("ascii")
    except Exception:
        return ""


def _decode_cursor(cur: Optional[str]) -> Optional[Dict[str, Any]]:
    if not cur:
        return None
    try:
        raw = base64.urlsafe_b64decode(cur.encode("ascii"))
    except Exception:
        try:
            pad = "=" * (-len(cur) % 4)
            raw = base64.urlsafe_b64decode((cur + pad).encode("ascii"))
        except Exception:
            return None
    try:
        obj = json.loads(raw.decode("utf-8", "ignore"))
        return obj if isinstance(obj, dict) else None
    except Exception:
        return None


def list_logs() -> List[Dict[str, Any]]:
    """List known logs (whitelisted) with basic metadata.

    Includes rotated files like core.1, core.2 when present.

    Notes:
      - Base targets (core/access/ws/stdout/stderr/restart/...) are always returned
        even if the file doesn't exist yet (exists=false), so UI can keep a stable list.
      - Rotated files are returned only when present.
    """
    targets = dict(_log_targets())
    order = ["core", "access", "ws", "stdout", "stderr", "restart", "xkeen-ui"]
    out: List[Dict[str, Any]] = []

    def _add(name: str, path: str, exists: bool) -> None:
        st = _stat_log(path) if exists else {"size": 0, "mtime": 0.0, "ino": 0}
        out.append({"name": name, "path": path, "exists": bool(exists), **st})

    for base in order:
        p = targets.get(base)
        if p:
            ex = os.path.isfile(p)
            _add(base, p, ex)
            # Rotated: only existing files
            for i in range(1, 11):
                rp = f"{p}.{i}"
                if os.path.isfile(rp):
                    _add(f"{base}.{i}", rp, True)

    for base, p in sorted(targets.items()):
        if base in order:
            continue
        ex = os.path.isfile(p)
        _add(base, p, ex)

    return out


def tail_log(name: str, *, lines: int = 400, cursor: Optional[str] = None) -> Tuple[str, List[str], Optional[str], str]:
    """Tail log with optional incremental cursor.

    Returns: (path, lines, new_cursor, mode)
      mode = "full" | "append"
    """
    path = _resolve_log_path(name)
    if not path:
        raise ValueError("unknown_log")

    max_lines = max(1, min(5000, int(lines or 400)))
    st = _stat_log(path)
    ino = int(st.get("ino", 0) or 0)
    size = int(st.get("size", 0) or 0)

    cur = _decode_cursor(cursor)
    if cur and int(cur.get("ino", -1)) == ino:
        try:
            off = int(cur.get("off", 0) or 0)
        except Exception:
            off = 0
        if 0 <= off <= size:
            carry = _b64d(str(cur.get("carry", "")))
            new_lines, new_off, new_carry = read_new_lines(path, off, carry=carry, max_bytes=128 * 1024)
            new_cur = _encode_cursor({"ino": ino, "off": int(new_off), "carry": _b64e(new_carry)})
            return path, new_lines, new_cur, "append"

    lns = tail_lines_fast(path, max_lines=max_lines, max_bytes=256 * 1024)
    new_cur = _encode_cursor({"ino": ino, "off": size, "carry": ""})
    return path, lns, new_cur, "full"


def truncate_log(name: str) -> str:
    if re.match(r"^.+\.\d+$", str(name or "")):
        raise ValueError("unknown_log")
    path = _resolve_log_path(name)
    if not path:
        raise ValueError("unknown_log")
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8"):
        pass
    return path

# ---------------------------------------------------------------------------
# UI service control
# ---------------------------------------------------------------------------


UI_INIT_SCRIPT = os.environ.get("XKEEN_UI_INIT_SCRIPT", "/opt/etc/init.d/S99xkeen-ui")
UI_PID_FILE = os.environ.get("XKEEN_UI_PID_FILE", "/opt/var/run/xkeen-ui.pid")
# Optional: custom command to control UI in dev (e.g. launchctl/systemd). Supports "{action}" placeholder.
UI_CONTROL_CMD = os.environ.get("XKEEN_UI_CONTROL_CMD") or os.environ.get("XKEEN_UI_RESTART_CMD")


def _runtime_mode() -> str:
    rt_env = (os.environ.get("XKEEN_RUNTIME") or os.environ.get("XKEEN_ENV") or "").strip().lower()
    if rt_env in ("router", "dev", "desktop", "mac"):
        return "router" if rt_env == "router" else "dev"
    if sys.platform == "darwin":
        return "dev"
    # Router markers (best-effort)
    try:
        has_ndm = os.path.exists("/proc/ndm") or os.path.exists("/opt/etc/ndm")
    except Exception:
        has_ndm = False
    try:
        has_opkg = os.path.exists("/opt/bin/opkg")
    except Exception:
        has_opkg = False
    return "router" if (has_ndm or has_opkg) else "dev"


def ui_status() -> Dict[str, Any]:
    # In dev mode UI is often managed externally (IDE run, docker, etc.)
    if _runtime_mode() != "router" and not (os.path.isfile(UI_INIT_SCRIPT) and os.access(UI_INIT_SCRIPT, os.X_OK)):
        return {"running": None, "pid": None, "managed": "external"}

    pid = None
    running = False
    try:
        if os.path.isfile(UI_PID_FILE):
            with open(UI_PID_FILE, "r", encoding="utf-8", errors="ignore") as f:
                s = (f.read() or "").strip()
            if s.isdigit():
                pid = int(s)
                try:
                    os.kill(pid, 0)
                    running = True
                except Exception:
                    running = False
    except Exception:
        pass
    return {"running": running, "pid": pid}


def ui_action(action: str) -> Dict[str, Any]:
    action = (action or "").strip().lower()
    if action not in ("start", "stop", "restart", "status"):
        raise ValueError("bad_action")

    if action == "status":
        st = ui_status()
        return {"ok": True, "action": action, **st}

    # Prefer init script when present.
    if os.path.isfile(UI_INIT_SCRIPT) and os.access(UI_INIT_SCRIPT, os.X_OK):
        # For stop/restart we run in background to increase chances that HTTP response is sent.
        if action in ("stop", "restart"):
            try:
                subprocess.Popen([UI_INIT_SCRIPT, action], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except Exception as e:
                return {"ok": False, "action": action, "error": str(e)}
            return {"ok": True, "action": action, "scheduled": True, "mode": "initd"}

        try:
            subprocess.check_call([UI_INIT_SCRIPT, action], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return {"ok": True, "action": action, "mode": "initd"}
        except Exception as e:
            return {"ok": False, "action": action, "error": str(e), "mode": "initd"}

    # Dev/desktop: allow custom control command if provided.
    if UI_CONTROL_CMD:
        try:
            cmd = str(UI_CONTROL_CMD)
            if "{action}" in cmd:
                cmd = cmd.replace("{action}", action)
            elif action != "restart":
                # Without placeholder we only support restart to avoid surprises.
                return {"ok": False, "action": action, "error": "control_cmd_restart_only"}
            subprocess.Popen(cmd if isinstance(cmd, str) else str(cmd), shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return {"ok": True, "action": action, "scheduled": True, "mode": "cmd"}
        except Exception as e:
            return {"ok": False, "action": action, "error": str(e), "mode": "cmd"}

    # No supported mechanism in this environment.
    if _runtime_mode() != "router":
        return {"ok": False, "action": action, "error": "managed_externally"}
    return {"ok": False, "action": action, "error": "init_script_missing"}



# ---------------------------------------------------------------------------
# Global theme editor (safe CSS variables)
# ---------------------------------------------------------------------------

THEME_CONFIG_JSON = "custom_theme.json"
THEME_CONFIG_CSS = "custom_theme.css"

# Defaults match the built-in dark/light palettes in static/styles.css.
_DEFAULT_THEME_CONFIG: Dict[str, Any] = {
    # Global typography (applies to both themes)
    "font_scale": 1.00,
    "mono_scale": 1.00,
    "dark": {
        "bg": "#0f172a",
        "card_bg": "#020617",
        "text": "#e5e7eb",
        "muted": "#9ca3af",
        "accent": "#60a5fa",
        "border": "#1f2937",
        # Semantic colors (levels, states)
        "sem_success": "#22c55e",
        "sem_info": "#93c5fd",
        "sem_warning": "#fbbf24",
        "sem_error": "#f87171",
        "sem_debug": "#a1a1aa",
        # Xray logs highlight (token colors)
        "log_ts": "#94a3b8",
        "log_ip": "#fde68a",
        "log_domain": "#6ee7b7",
        "log_proto": "#7dd3fc",
        "log_port": "#fb923c",
        "log_uuid": "#f472b6",
        "log_email": "#22d3ee",
        "log_inbound": "#818cf8",
        "log_outbound": "#f0abfc",
        "log_method": "#fbbf24",
        "log_path": "#bef264",
        "log_sni": "#5eead4",
        "log_alpn": "#93c5fd",
        "log_route_tproxy_vless": "#22c55e",
        "log_route_redirect_vless": "#38bdf8",
        "log_route_redirect_direct": "#a855f7",
        "log_route_reject": "#f97373",
        # Editor/action buttons (Save/Backup/Restore/etc.)
        "editor_btn_bg": "#020617",
        "editor_btn_text": "#e5e7eb",
        "editor_btn_border": "#1f2937",
        "editor_btn_hover_bg": "#020617",
        "editor_btn_hover_text": "#e5e7eb",
        "editor_btn_hover_border": "#4b5563",
        "editor_btn_active_from": "#1d4ed8",
        "editor_btn_active_to": "#2563eb",
        "header_btn_bg": "#020617",
        "header_btn_text": "#e5e7eb",
        "header_btn_border": "#374151",
        "header_btn_hover_bg": "#020617",
        "header_btn_hover_text": "#e5e7eb",
        "header_btn_hover_border": "#374151",
        # Modals
        "modal_overlay": "#0f172abf",
        "modal_bg": "#020617",
        "modal_text": "#e5e7eb",
        "modal_muted": "#9ca3af",
        # Body area inside modal (optional separate surface)
        "modal_body_bg": "#020617",
        "modal_body_border": "#1f2937",
        # Tables inside modals
        "modal_table_head_bg": "#0b1220",
        "modal_table_head_text": "#9ca3af",
        "modal_table_border": "#1f2937",
        "modal_table_row_hover_bg": "#0b1220",
        # Lists inside modals
        "modal_list_marker": "#9ca3af",
        "modal_border": "#334155",
        "modal_header_border": "#1f2937",
        "modal_close": "#9ca3af",
        "modal_close_hover": "#e5e7eb",
        "header_tab_bg": "#020617",
        "header_tab_text": "#e5e7eb",
        "header_tab_border": "#1f2937",
        "header_tab_active_bg": "#2563eb",
        "header_tab_active_text": "#ffffff",
        "radius": 12,
        "shadow": 0.40,
        "density": 1.00,
        "contrast": 1.00,
    },
    "light": {
        "bg": "#f5f5f7",
        "card_bg": "#ffffff",
        "text": "#111827",
        "muted": "#4b5563",
        "accent": "#0a84ff",
        "border": "#d1d5db",
        # Semantic colors (levels, states)
        "sem_success": "#16a34a",
        "sem_info": "#2563eb",
        "sem_warning": "#b45309",
        "sem_error": "#dc2626",
        "sem_debug": "#6b7280",
        # Xray logs highlight (token colors)
        "log_ts": "#64748b",
        "log_ip": "#a16207",
        "log_domain": "#047857",
        "log_proto": "#0369a1",
        "log_port": "#c2410c",
        "log_uuid": "#be185d",
        "log_email": "#0e7490",
        "log_inbound": "#4338ca",
        "log_outbound": "#a21caf",
        "log_method": "#92400e",
        "log_path": "#3f6212",
        "log_sni": "#0f766e",
        "log_alpn": "#1d4ed8",
        "log_route_tproxy_vless": "#16a34a",
        "log_route_redirect_vless": "#0284c7",
        "log_route_redirect_direct": "#7c3aed",
        "log_route_reject": "#dc2626",
        # Editor/action buttons (Save/Backup/Restore/etc.)
        "editor_btn_bg": "#ffffff",
        "editor_btn_text": "#111827",
        "editor_btn_border": "#d1d5db",
        "editor_btn_hover_bg": "#ffffff",
        "editor_btn_hover_text": "#111827",
        "editor_btn_hover_border": "#4b5563",
        "editor_btn_active_from": "#1d4ed8",
        "editor_btn_active_to": "#2563eb",
        "header_btn_bg": "#ffffff",
        "header_btn_text": "#111827",
        "header_btn_border": "#d1d5db",
        "header_btn_hover_bg": "#ffffff",
        "header_btn_hover_text": "#111827",
        "header_btn_hover_border": "#d1d5db",
        # Modals
        "modal_overlay": "#0f172a59",
        "modal_bg": "#ffffff",
        "modal_text": "#111827",
        "modal_muted": "#6b7280",
        # Body area inside modal (optional separate surface)
        "modal_body_bg": "#f9fafb",
        "modal_body_border": "#e5e7eb",
        # Tables inside modals
        "modal_table_head_bg": "#f3f4f6",
        "modal_table_head_text": "#6b7280",
        "modal_table_border": "#e5e7eb",
        "modal_table_row_hover_bg": "#eff6ff",
        # Lists inside modals
        "modal_list_marker": "#6b7280",
        "modal_border": "#d1d5db",
        "modal_header_border": "#e5e7eb",
        "modal_close": "#6b7280",
        "modal_close_hover": "#111827",
        "header_tab_bg": "#ffffff",
        "header_tab_text": "#111827",
        "header_tab_border": "#d1d5db",
        "header_tab_active_bg": "#0a84ff",
        "header_tab_active_text": "#ffffff",
        "radius": 12,
        "shadow": 0.08,
        "density": 1.00,
        "contrast": 1.00,
    },
}

_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?([0-9a-fA-F]{2})?$")


def _theme_json_path(ui_state_dir: str) -> str:
    return os.path.join(ui_state_dir, THEME_CONFIG_JSON)


def _theme_css_path(ui_state_dir: str) -> str:
    return os.path.join(ui_state_dir, THEME_CONFIG_CSS)


def _expand_short_hex(c: str) -> str:
    c = (c or "").strip()
    if len(c) == 4 and c.startswith("#"):
        # #RGB -> #RRGGBB
        r, g, b = c[1], c[2], c[3]
        return f"#{r}{r}{g}{g}{b}{b}".lower()
    return c.lower()


def _sanitize_color(v: Any, fallback: str) -> str:
    s = str(v or "").strip()
    if not s:
        return fallback
    if not s.startswith("#"):
        return fallback
    if not _COLOR_RE.match(s):
        return fallback
    s = _expand_short_hex(s)
    # Normalize #RRGGBB or #RRGGBBAA
    if len(s) in (7, 9):
        return s
    return fallback


def _clamp_float(v: Any, lo: float, hi: float, fallback: float) -> float:
    try:
        x = float(v)
    except Exception:
        return fallback
    if x < lo:
        return lo
    if x > hi:
        return hi
    return x


def _clamp_int(v: Any, lo: int, hi: int, fallback: int) -> int:
    try:
        x = int(float(v))
    except Exception:
        return fallback
    if x < lo:
        return lo
    if x > hi:
        return hi
    return x


def _sanitize_theme_config(cfg_in: Any) -> Dict[str, Any]:
    """Sanitize incoming config.

    NOTE: Keep it very conservative – allow only hex colors + numeric knobs.
    """
    cfg: Dict[str, Any] = json.loads(json.dumps(_DEFAULT_THEME_CONFIG))

    if not isinstance(cfg_in, dict):
        return cfg

    # Global typography (0.85..1.50)
    if isinstance(cfg_in.get("font_scale"), (int, float, str)):
        cfg["font_scale"] = round(_clamp_float(cfg_in.get("font_scale"), 0.85, 1.50, float(cfg.get("font_scale") or 1.0)), 3)
    if isinstance(cfg_in.get("mono_scale"), (int, float, str)):
        cfg["mono_scale"] = round(_clamp_float(cfg_in.get("mono_scale"), 0.85, 1.50, float(cfg.get("mono_scale") or 1.0)), 3)

    for theme in ("dark", "light"):
        src = cfg_in.get(theme)
        if not isinstance(src, dict):
            continue
        dst = cfg.get(theme, {})

        dst["bg"] = _sanitize_color(src.get("bg"), dst["bg"])
        dst["card_bg"] = _sanitize_color(src.get("card_bg"), dst["card_bg"])
        dst["text"] = _sanitize_color(src.get("text"), dst["text"])
        dst["muted"] = _sanitize_color(src.get("muted"), dst["muted"])
        dst["accent"] = _sanitize_color(src.get("accent"), dst["accent"])
        dst["border"] = _sanitize_color(src.get("border"), dst["border"])
        dst["sem_success"] = _sanitize_color(src.get("sem_success"), dst["sem_success"])
        dst["sem_info"] = _sanitize_color(src.get("sem_info"), dst["sem_info"])
        dst["sem_warning"] = _sanitize_color(src.get("sem_warning"), dst["sem_warning"])
        dst["sem_error"] = _sanitize_color(src.get("sem_error"), dst["sem_error"])
        dst["sem_debug"] = _sanitize_color(src.get("sem_debug"), dst["sem_debug"])
        # Xray logs highlight (token colors)
        dst["log_ts"] = _sanitize_color(src.get("log_ts"), dst["log_ts"])
        dst["log_ip"] = _sanitize_color(src.get("log_ip"), dst["log_ip"])
        dst["log_domain"] = _sanitize_color(src.get("log_domain"), dst["log_domain"])
        dst["log_proto"] = _sanitize_color(src.get("log_proto"), dst["log_proto"])
        dst["log_port"] = _sanitize_color(src.get("log_port"), dst["log_port"])
        dst["log_uuid"] = _sanitize_color(src.get("log_uuid"), dst["log_uuid"])
        dst["log_email"] = _sanitize_color(src.get("log_email"), dst["log_email"])
        dst["log_inbound"] = _sanitize_color(src.get("log_inbound"), dst["log_inbound"])
        dst["log_outbound"] = _sanitize_color(src.get("log_outbound"), dst["log_outbound"])
        dst["log_method"] = _sanitize_color(src.get("log_method"), dst["log_method"])
        dst["log_path"] = _sanitize_color(src.get("log_path"), dst["log_path"])
        dst["log_sni"] = _sanitize_color(src.get("log_sni"), dst["log_sni"])
        dst["log_alpn"] = _sanitize_color(src.get("log_alpn"), dst["log_alpn"])
        dst["log_route_tproxy_vless"] = _sanitize_color(src.get("log_route_tproxy_vless"), dst["log_route_tproxy_vless"])
        dst["log_route_redirect_vless"] = _sanitize_color(src.get("log_route_redirect_vless"), dst["log_route_redirect_vless"])
        dst["log_route_redirect_direct"] = _sanitize_color(src.get("log_route_redirect_direct"), dst["log_route_redirect_direct"])
        dst["log_route_reject"] = _sanitize_color(src.get("log_route_reject"), dst["log_route_reject"])
        dst["editor_btn_bg"] = _sanitize_color(src.get("editor_btn_bg"), dst["editor_btn_bg"])
        dst["editor_btn_text"] = _sanitize_color(src.get("editor_btn_text"), dst["editor_btn_text"])
        dst["editor_btn_border"] = _sanitize_color(src.get("editor_btn_border"), dst["editor_btn_border"])
        dst["editor_btn_hover_bg"] = _sanitize_color(src.get("editor_btn_hover_bg"), dst["editor_btn_hover_bg"])
        dst["editor_btn_hover_text"] = _sanitize_color(src.get("editor_btn_hover_text"), dst["editor_btn_hover_text"])
        dst["editor_btn_hover_border"] = _sanitize_color(src.get("editor_btn_hover_border"), dst["editor_btn_hover_border"])
        dst["editor_btn_active_from"] = _sanitize_color(src.get("editor_btn_active_from"), dst["editor_btn_active_from"])
        dst["editor_btn_active_to"] = _sanitize_color(src.get("editor_btn_active_to"), dst["editor_btn_active_to"])
        dst["header_btn_bg"] = _sanitize_color(src.get("header_btn_bg"), dst["header_btn_bg"])
        dst["header_btn_text"] = _sanitize_color(src.get("header_btn_text"), dst["header_btn_text"])
        dst["header_btn_border"] = _sanitize_color(src.get("header_btn_border"), dst["header_btn_border"])
        dst["header_btn_hover_bg"] = _sanitize_color(src.get("header_btn_hover_bg"), dst["header_btn_hover_bg"])
        dst["header_btn_hover_text"] = _sanitize_color(src.get("header_btn_hover_text"), dst["header_btn_hover_text"])
        dst["header_btn_hover_border"] = _sanitize_color(src.get("header_btn_hover_border"), dst["header_btn_hover_border"])
        dst["modal_overlay"] = _sanitize_color(src.get("modal_overlay"), dst["modal_overlay"])
        dst["modal_bg"] = _sanitize_color(src.get("modal_bg"), dst["modal_bg"])
        dst["modal_text"] = _sanitize_color(src.get("modal_text"), dst["modal_text"])
        dst["modal_muted"] = _sanitize_color(src.get("modal_muted"), dst["modal_muted"])
        dst["modal_body_bg"] = _sanitize_color(src.get("modal_body_bg"), dst["modal_body_bg"])
        dst["modal_body_border"] = _sanitize_color(src.get("modal_body_border"), dst["modal_body_border"])
        dst["modal_table_head_bg"] = _sanitize_color(src.get("modal_table_head_bg"), dst["modal_table_head_bg"])
        dst["modal_table_head_text"] = _sanitize_color(src.get("modal_table_head_text"), dst["modal_table_head_text"])
        dst["modal_table_border"] = _sanitize_color(src.get("modal_table_border"), dst["modal_table_border"])
        dst["modal_table_row_hover_bg"] = _sanitize_color(src.get("modal_table_row_hover_bg"), dst["modal_table_row_hover_bg"])
        dst["modal_list_marker"] = _sanitize_color(src.get("modal_list_marker"), dst["modal_list_marker"])
        dst["modal_border"] = _sanitize_color(src.get("modal_border"), dst["modal_border"])
        dst["modal_header_border"] = _sanitize_color(src.get("modal_header_border"), dst["modal_header_border"])
        dst["modal_close"] = _sanitize_color(src.get("modal_close"), dst["modal_close"])
        dst["modal_close_hover"] = _sanitize_color(src.get("modal_close_hover"), dst["modal_close_hover"])
        dst["header_tab_bg"] = _sanitize_color(src.get("header_tab_bg"), dst["header_tab_bg"])
        dst["header_tab_text"] = _sanitize_color(src.get("header_tab_text"), dst["header_tab_text"])
        dst["header_tab_border"] = _sanitize_color(src.get("header_tab_border"), dst["header_tab_border"])
        dst["header_tab_active_bg"] = _sanitize_color(src.get("header_tab_active_bg"), dst["header_tab_active_bg"])
        dst["header_tab_active_text"] = _sanitize_color(src.get("header_tab_active_text"), dst["header_tab_active_text"])

        dst["radius"] = _clamp_int(src.get("radius"), 0, 32, int(dst["radius"]))
        # shadow is alpha (0..0.7)
        dst["shadow"] = round(_clamp_float(src.get("shadow"), 0.0, 0.7, float(dst["shadow"])), 3)
        # density: compact/spacious (0.75..1.35)
        dst["density"] = round(_clamp_float(src.get("density"), 0.75, 1.35, float(dst["density"])), 3)
        # contrast: (0.85..1.25)
        dst["contrast"] = round(_clamp_float(src.get("contrast"), 0.85, 1.25, float(dst["contrast"])), 3)

        cfg[theme] = dst

    return cfg


def _theme_css_from_config(cfg: Dict[str, Any]) -> str:
    """Generate safe CSS overrides.

    The file is loaded on every page after styles.css.
    """

    def _radius_sm(r: int) -> int:
        try:
            return max(4, min(24, int(round(r * 0.75))))
        except Exception:
            return 8

    dark = cfg.get("dark") or {}
    light = cfg.get("light") or {}

    # Global typography
    font_scale = float(cfg.get("font_scale") or 1.0)
    mono_scale = float(cfg.get("mono_scale") or 1.0)

    dark_rs = _radius_sm(int(dark.get("radius") or 12))
    light_rs = _radius_sm(int(light.get("radius") or 12))

    css: List[str] = []
    css.append("/* Generated by Xkeen UI DevTools — Theme editor */")
    css.append("/* Safe override layer: only CSS variables + a few core selectors. */")
    css.append("")

    # Fallback (no data-theme attribute -> behave like dark)
    css.append(":root {")
    css.append(f"  --xk-font-scale: {font_scale};")
    css.append(f"  --xk-mono-font-scale: {mono_scale};")
    css.append(f"  --bg: {dark.get('bg')};")
    css.append(f"  --card-bg: {dark.get('card_bg')};")
    css.append(f"  --text: {dark.get('text')};")
    css.append(f"  --muted: {dark.get('muted')};")
    css.append(f"  --accent: {dark.get('accent')};")
    css.append(f"  --border: {dark.get('border')};")
    css.append(f"  --sem-success: {dark.get('sem_success')};")
    css.append(f"  --sem-info: {dark.get('sem_info')};")
    css.append(f"  --sem-warning: {dark.get('sem_warning')};")
    css.append(f"  --sem-error: {dark.get('sem_error')};")
    css.append(f"  --sem-debug: {dark.get('sem_debug')};")
    css.append(f"  --log-ts: {dark.get('log_ts')};")
    css.append(f"  --log-ip: {dark.get('log_ip')};")
    css.append(f"  --log-domain: {dark.get('log_domain')};")
    css.append(f"  --log-proto: {dark.get('log_proto')};")
    css.append(f"  --log-port: {dark.get('log_port')};")
    css.append(f"  --log-uuid: {dark.get('log_uuid')};")
    css.append(f"  --log-email: {dark.get('log_email')};")
    css.append(f"  --log-inbound: {dark.get('log_inbound')};")
    css.append(f"  --log-outbound: {dark.get('log_outbound')};")
    css.append(f"  --log-method: {dark.get('log_method')};")
    css.append(f"  --log-path: {dark.get('log_path')};")
    css.append(f"  --log-sni: {dark.get('log_sni')};")
    css.append(f"  --log-alpn: {dark.get('log_alpn')};")
    css.append(f"  --log-route-tproxy-vless: {dark.get('log_route_tproxy_vless')};")
    css.append(f"  --log-route-redirect-vless: {dark.get('log_route_redirect_vless')};")
    css.append(f"  --log-route-redirect-direct: {dark.get('log_route_redirect_direct')};")
    css.append(f"  --log-route-reject: {dark.get('log_route_reject')};")
    css.append(f"  --editor-btn-bg: {dark.get('editor_btn_bg')};")
    css.append(f"  --editor-btn-text: {dark.get('editor_btn_text')};")
    css.append(f"  --editor-btn-border: {dark.get('editor_btn_border')};")
    css.append(f"  --editor-btn-hover-bg: {dark.get('editor_btn_hover_bg')};")
    css.append(f"  --editor-btn-hover-text: {dark.get('editor_btn_hover_text')};")
    css.append(f"  --editor-btn-hover-border: {dark.get('editor_btn_hover_border')};")
    # Back-compat alias used by core button styles (styles.css)
    css.append(f"  --editor-btn-border-hover: {dark.get('editor_btn_hover_border')};")
    css.append(f"  --editor-btn-active-from: {dark.get('editor_btn_active_from')};")
    css.append(f"  --editor-btn-active-to: {dark.get('editor_btn_active_to')};")
    css.append(f"  --header-btn-bg: {dark.get('header_btn_bg')};")
    css.append(f"  --header-btn-text: {dark.get('header_btn_text')};")
    css.append(f"  --header-btn-border: {dark.get('header_btn_border')};")
    css.append(f"  --header-btn-hover-bg: {dark.get('header_btn_hover_bg')};")
    css.append(f"  --header-btn-hover-text: {dark.get('header_btn_hover_text')};")
    css.append(f"  --header-btn-hover-border: {dark.get('header_btn_hover_border')};")
    css.append(f"  --modal-overlay: {dark.get('modal_overlay')};")
    css.append(f"  --modal-bg: {dark.get('modal_bg')};")
    css.append(f"  --modal-text: {dark.get('modal_text')};")
    css.append(f"  --modal-muted: {dark.get('modal_muted')};")
    css.append(f"  --modal-body-bg: {dark.get('modal_body_bg')};")
    css.append(f"  --modal-body-border: {dark.get('modal_body_border')};")
    css.append(f"  --modal-table-head-bg: {dark.get('modal_table_head_bg')};")
    css.append(f"  --modal-table-head-text: {dark.get('modal_table_head_text')};")
    css.append(f"  --modal-table-border: {dark.get('modal_table_border')};")
    css.append(f"  --modal-table-row-hover-bg: {dark.get('modal_table_row_hover_bg')};")
    css.append(f"  --modal-list-marker: {dark.get('modal_list_marker')};")
    css.append(f"  --modal-border: {dark.get('modal_border')};")
    css.append(f"  --modal-header-border: {dark.get('modal_header_border')};")
    css.append(f"  --modal-close: {dark.get('modal_close')};")
    css.append(f"  --modal-close-hover: {dark.get('modal_close_hover')};")
    css.append(f"  --header-tab-bg: {dark.get('header_tab_bg')};")
    css.append(f"  --header-tab-text: {dark.get('header_tab_text')};")
    css.append(f"  --header-tab-border: {dark.get('header_tab_border')};")
    css.append(f"  --header-tab-active-bg: {dark.get('header_tab_active_bg')};")
    css.append(f"  --header-tab-active-text: {dark.get('header_tab_active_text')};")
    css.append(f"  --radius: {int(dark.get('radius') or 12)}px;")
    css.append(f"  --radius-sm: {dark_rs}px;")
    css.append(f"  --shadow: {float(dark.get('shadow') or 0.4)};")
    css.append("  --shadow-rgb: 0, 0, 0;")
    css.append(f"  --density: {float(dark.get('density') or 1.0)};")
    css.append(f"  --contrast: {float(dark.get('contrast') or 1.0)};")
    css.append("}")
    css.append("")

    css.append('html[data-theme="dark"] {')
    css.append(f"  --bg: {dark.get('bg')};")
    css.append(f"  --card-bg: {dark.get('card_bg')};")
    css.append(f"  --text: {dark.get('text')};")
    css.append(f"  --muted: {dark.get('muted')};")
    css.append(f"  --accent: {dark.get('accent')};")
    css.append(f"  --border: {dark.get('border')};")
    css.append(f"  --sem-success: {dark.get('sem_success')};")
    css.append(f"  --sem-info: {dark.get('sem_info')};")
    css.append(f"  --sem-warning: {dark.get('sem_warning')};")
    css.append(f"  --sem-error: {dark.get('sem_error')};")
    css.append(f"  --sem-debug: {dark.get('sem_debug')};")
    css.append(f"  --log-ts: {dark.get('log_ts')};")
    css.append(f"  --log-ip: {dark.get('log_ip')};")
    css.append(f"  --log-domain: {dark.get('log_domain')};")
    css.append(f"  --log-proto: {dark.get('log_proto')};")
    css.append(f"  --log-port: {dark.get('log_port')};")
    css.append(f"  --log-uuid: {dark.get('log_uuid')};")
    css.append(f"  --log-email: {dark.get('log_email')};")
    css.append(f"  --log-inbound: {dark.get('log_inbound')};")
    css.append(f"  --log-outbound: {dark.get('log_outbound')};")
    css.append(f"  --log-method: {dark.get('log_method')};")
    css.append(f"  --log-path: {dark.get('log_path')};")
    css.append(f"  --log-sni: {dark.get('log_sni')};")
    css.append(f"  --log-alpn: {dark.get('log_alpn')};")
    css.append(f"  --log-route-tproxy-vless: {dark.get('log_route_tproxy_vless')};")
    css.append(f"  --log-route-redirect-vless: {dark.get('log_route_redirect_vless')};")
    css.append(f"  --log-route-redirect-direct: {dark.get('log_route_redirect_direct')};")
    css.append(f"  --log-route-reject: {dark.get('log_route_reject')};")
    css.append(f"  --editor-btn-bg: {dark.get('editor_btn_bg')};")
    css.append(f"  --editor-btn-text: {dark.get('editor_btn_text')};")
    css.append(f"  --editor-btn-border: {dark.get('editor_btn_border')};")
    css.append(f"  --editor-btn-hover-bg: {dark.get('editor_btn_hover_bg')};")
    css.append(f"  --editor-btn-hover-text: {dark.get('editor_btn_hover_text')};")
    css.append(f"  --editor-btn-hover-border: {dark.get('editor_btn_hover_border')};")
    css.append(f"  --editor-btn-border-hover: {dark.get('editor_btn_hover_border')};")
    css.append(f"  --editor-btn-active-from: {dark.get('editor_btn_active_from')};")
    css.append(f"  --editor-btn-active-to: {dark.get('editor_btn_active_to')};")
    css.append(f"  --header-btn-bg: {dark.get('header_btn_bg')};")
    css.append(f"  --header-btn-text: {dark.get('header_btn_text')};")
    css.append(f"  --header-btn-border: {dark.get('header_btn_border')};")
    css.append(f"  --header-btn-hover-bg: {dark.get('header_btn_hover_bg')};")
    css.append(f"  --header-btn-hover-text: {dark.get('header_btn_hover_text')};")
    css.append(f"  --header-btn-hover-border: {dark.get('header_btn_hover_border')};")
    css.append(f"  --modal-overlay: {dark.get('modal_overlay')};")
    css.append(f"  --modal-bg: {dark.get('modal_bg')};")
    css.append(f"  --modal-text: {dark.get('modal_text')};")
    css.append(f"  --modal-muted: {dark.get('modal_muted')};")
    css.append(f"  --modal-body-bg: {dark.get('modal_body_bg')};")
    css.append(f"  --modal-body-border: {dark.get('modal_body_border')};")
    css.append(f"  --modal-table-head-bg: {dark.get('modal_table_head_bg')};")
    css.append(f"  --modal-table-head-text: {dark.get('modal_table_head_text')};")
    css.append(f"  --modal-table-border: {dark.get('modal_table_border')};")
    css.append(f"  --modal-table-row-hover-bg: {dark.get('modal_table_row_hover_bg')};")
    css.append(f"  --modal-list-marker: {dark.get('modal_list_marker')};")
    css.append(f"  --modal-border: {dark.get('modal_border')};")
    css.append(f"  --modal-header-border: {dark.get('modal_header_border')};")
    css.append(f"  --modal-close: {dark.get('modal_close')};")
    css.append(f"  --modal-close-hover: {dark.get('modal_close_hover')};")
    css.append(f"  --header-tab-bg: {dark.get('header_tab_bg')};")
    css.append(f"  --header-tab-text: {dark.get('header_tab_text')};")
    css.append(f"  --header-tab-border: {dark.get('header_tab_border')};")
    css.append(f"  --header-tab-active-bg: {dark.get('header_tab_active_bg')};")
    css.append(f"  --header-tab-active-text: {dark.get('header_tab_active_text')};")
    css.append(f"  --radius: {int(dark.get('radius') or 12)}px;")
    css.append(f"  --radius-sm: {dark_rs}px;")
    css.append(f"  --shadow: {float(dark.get('shadow') or 0.4)};")
    css.append("  --shadow-rgb: 0, 0, 0;")
    css.append(f"  --density: {float(dark.get('density') or 1.0)};")
    css.append(f"  --contrast: {float(dark.get('contrast') or 1.0)};")
    css.append("}")
    css.append("")

    css.append('html[data-theme="light"] {')
    css.append(f"  --bg: {light.get('bg')};")
    css.append(f"  --card-bg: {light.get('card_bg')};")
    css.append(f"  --text: {light.get('text')};")
    css.append(f"  --muted: {light.get('muted')};")
    css.append(f"  --accent: {light.get('accent')};")
    css.append(f"  --border: {light.get('border')};")
    css.append(f"  --sem-success: {light.get('sem_success')};")
    css.append(f"  --sem-info: {light.get('sem_info')};")
    css.append(f"  --sem-warning: {light.get('sem_warning')};")
    css.append(f"  --sem-error: {light.get('sem_error')};")
    css.append(f"  --sem-debug: {light.get('sem_debug')};")
    css.append(f"  --log-ts: {light.get('log_ts')};")
    css.append(f"  --log-ip: {light.get('log_ip')};")
    css.append(f"  --log-domain: {light.get('log_domain')};")
    css.append(f"  --log-proto: {light.get('log_proto')};")
    css.append(f"  --log-port: {light.get('log_port')};")
    css.append(f"  --log-uuid: {light.get('log_uuid')};")
    css.append(f"  --log-email: {light.get('log_email')};")
    css.append(f"  --log-inbound: {light.get('log_inbound')};")
    css.append(f"  --log-outbound: {light.get('log_outbound')};")
    css.append(f"  --log-method: {light.get('log_method')};")
    css.append(f"  --log-path: {light.get('log_path')};")
    css.append(f"  --log-sni: {light.get('log_sni')};")
    css.append(f"  --log-alpn: {light.get('log_alpn')};")
    css.append(f"  --log-route-tproxy-vless: {light.get('log_route_tproxy_vless')};")
    css.append(f"  --log-route-redirect-vless: {light.get('log_route_redirect_vless')};")
    css.append(f"  --log-route-redirect-direct: {light.get('log_route_redirect_direct')};")
    css.append(f"  --log-route-reject: {light.get('log_route_reject')};")
    css.append(f"  --editor-btn-bg: {light.get('editor_btn_bg')};")
    css.append(f"  --editor-btn-text: {light.get('editor_btn_text')};")
    css.append(f"  --editor-btn-border: {light.get('editor_btn_border')};")
    css.append(f"  --editor-btn-hover-bg: {light.get('editor_btn_hover_bg')};")
    css.append(f"  --editor-btn-hover-text: {light.get('editor_btn_hover_text')};")
    css.append(f"  --editor-btn-hover-border: {light.get('editor_btn_hover_border')};")
    css.append(f"  --editor-btn-border-hover: {light.get('editor_btn_hover_border')};")
    css.append(f"  --editor-btn-active-from: {light.get('editor_btn_active_from')};")
    css.append(f"  --editor-btn-active-to: {light.get('editor_btn_active_to')};")
    css.append(f"  --header-btn-bg: {light.get('header_btn_bg')};")
    css.append(f"  --header-btn-text: {light.get('header_btn_text')};")
    css.append(f"  --header-btn-border: {light.get('header_btn_border')};")
    css.append(f"  --header-btn-hover-bg: {light.get('header_btn_hover_bg')};")
    css.append(f"  --header-btn-hover-text: {light.get('header_btn_hover_text')};")
    css.append(f"  --header-btn-hover-border: {light.get('header_btn_hover_border')};")
    css.append(f"  --modal-overlay: {light.get('modal_overlay')};")
    css.append(f"  --modal-bg: {light.get('modal_bg')};")
    css.append(f"  --modal-text: {light.get('modal_text')};")
    css.append(f"  --modal-muted: {light.get('modal_muted')};")
    css.append(f"  --modal-body-bg: {light.get('modal_body_bg')};")
    css.append(f"  --modal-body-border: {light.get('modal_body_border')};")
    css.append(f"  --modal-table-head-bg: {light.get('modal_table_head_bg')};")
    css.append(f"  --modal-table-head-text: {light.get('modal_table_head_text')};")
    css.append(f"  --modal-table-border: {light.get('modal_table_border')};")
    css.append(f"  --modal-table-row-hover-bg: {light.get('modal_table_row_hover_bg')};")
    css.append(f"  --modal-list-marker: {light.get('modal_list_marker')};")
    css.append(f"  --modal-border: {light.get('modal_border')};")
    css.append(f"  --modal-header-border: {light.get('modal_header_border')};")
    css.append(f"  --modal-close: {light.get('modal_close')};")
    css.append(f"  --modal-close-hover: {light.get('modal_close_hover')};")
    css.append(f"  --header-tab-bg: {light.get('header_tab_bg')};")
    css.append(f"  --header-tab-text: {light.get('header_tab_text')};")
    css.append(f"  --header-tab-border: {light.get('header_tab_border')};")
    css.append(f"  --header-tab-active-bg: {light.get('header_tab_active_bg')};")
    css.append(f"  --header-tab-active-text: {light.get('header_tab_active_text')};")
    css.append(f"  --radius: {int(light.get('radius') or 12)}px;")
    css.append(f"  --radius-sm: {light_rs}px;")
    css.append(f"  --shadow: {float(light.get('shadow') or 0.08)};")
    css.append("  --shadow-rgb: 15, 23, 42;")
    css.append(f"  --density: {float(light.get('density') or 1.0)};")
    css.append(f"  --contrast: {float(light.get('contrast') or 1.0)};")
    css.append("}")
    css.append("")

    css.append("/* Core surfaces */")
    css.append("body {")
    css.append("  background: var(--bg) !important;")
    css.append("  color: var(--text) !important;")
    css.append("  filter: contrast(var(--contrast));")
    css.append("}")
    css.append("a { color: var(--accent) !important; }")
    css.append("header p, .card p, .hint, .modal-hint, .small { color: var(--muted) !important; }")
    css.append("")

    css.append(".container { padding: calc(24px * var(--density)) !important; }")
    css.append(".card {")
    css.append("  background: var(--card-bg) !important;")
    css.append("  border-color: var(--border) !important;")
    css.append("  border-radius: var(--radius) !important;")
    css.append("  padding: calc(16px * var(--density)) calc(16px * var(--density)) calc(20px * var(--density)) !important;")
    css.append("  box-shadow: 0 10px 30px rgba(var(--shadow-rgb), var(--shadow)) !important;")
    css.append("}")
    css.append(".modal {")
    css.append("  background: var(--modal-overlay) !important;")
    css.append("}")
    css.append(".modal-content {")
    css.append("  background: var(--modal-bg) !important;")
    css.append("  color: var(--modal-text) !important;")
    css.append("  border-color: var(--modal-border) !important;")
    css.append("  border-radius: var(--radius) !important;")
    css.append("  box-shadow: 0 10px 30px rgba(var(--shadow-rgb), var(--shadow)) !important;")
    css.append("}")
    css.append(".modal-header { border-bottom-color: var(--modal-header-border) !important; }")
    css.append(".modal-close { color: var(--modal-close) !important; }")
    css.append(".modal-close:hover { color: var(--modal-close-hover) !important; }")
    css.append(".modal-content .modal-hint, .modal-content .hint, .modal-content .small { color: var(--modal-muted) !important; }")
    css.append(".modal-body { background: var(--modal-body-bg) !important; }")
    css.append(".modal-body-logs { background: var(--modal-body-bg) !important; border: 1px solid var(--modal-body-border) !important; border-radius: var(--radius-sm) !important; padding: calc(8px * var(--density)) !important; }")
    css.append(".modal-content table { background: transparent !important; color: var(--modal-text) !important; }")
    css.append(".modal-content thead { background: var(--modal-table-head-bg) !important; }")
    css.append(".modal-content th { color: var(--modal-table-head-text) !important; border-bottom-color: var(--modal-table-border) !important; }")
    css.append(".modal-content td { border-bottom-color: var(--modal-table-border) !important; }")
    css.append(".modal-content tbody tr:hover { background: var(--modal-table-row-hover-bg) !important; }")
    css.append(".modal-content ul li::marker, .modal-content ol li::marker { color: var(--modal-list-marker) !important; }")
    css.append("")

    css.append("input, select, textarea, .xkeen-textarea, .CodeMirror {")
    css.append("  border-color: var(--border) !important;")
    css.append("  border-radius: var(--radius-sm) !important;")
    css.append("  background: var(--card-bg) !important;")
    css.append("  color: var(--text) !important;")
    css.append("}")
    css.append("button { border-radius: var(--radius-sm) !important; }")

    css.append("")
    css.append("/* Header buttons / tabs */")
    css.append("header .service-core-text, header .theme-toggle-btn.theme-toggle-header, header .header-actions .btn-link { background: var(--header-btn-bg) !important; border-color: var(--header-btn-border) !important; color: var(--header-btn-text) !important; }")
    css.append("header .service-core-text:hover, header .theme-toggle-btn.theme-toggle-header:hover, header .header-actions .btn-link:hover { background: var(--header-btn-hover-bg) !important; border-color: var(--header-btn-hover-border) !important; color: var(--header-btn-hover-text) !important; }")
    css.append("header .top-tabs.header-tabs .top-tab-btn { background: var(--header-tab-bg) !important; border-color: var(--header-tab-border) !important; color: var(--header-tab-text) !important; }")
    css.append("header .top-tabs.header-tabs .top-tab-btn:hover, header .top-tabs.header-tabs .top-tab-btn.active { background: var(--header-tab-active-bg) !important; border-color: var(--header-tab-active-bg) !important; color: var(--header-tab-active-text) !important; }")

    css.append("")
    return "\n".join(css) + "\n"


def _atomic_write_text(path: str, text: str, mode: int = 0o644) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", errors="ignore") as f:
        f.write(text)
    try:
        os.chmod(tmp, mode)
    except Exception:
        pass
    os.replace(tmp, path)


def theme_get(ui_state_dir: str) -> Dict[str, Any]:
    """Load current theme config (or defaults)."""
    cfg = json.loads(json.dumps(_DEFAULT_THEME_CONFIG))
    exists = False
    jpath = _theme_json_path(ui_state_dir)
    cpath = _theme_css_path(ui_state_dir)

    try:
        if os.path.isfile(jpath):
            with open(jpath, "r", encoding="utf-8", errors="ignore") as f:
                raw = json.load(f)
            cfg = _sanitize_theme_config(raw)
            exists = True
        elif os.path.isfile(cpath):
            # If only CSS exists (older version), still report exists.
            exists = True
    except Exception:
        cfg = json.loads(json.dumps(_DEFAULT_THEME_CONFIG))

    version = 0
    try:
        if os.path.isfile(cpath):
            version = int(os.path.getmtime(cpath) or 0)
    except Exception:
        version = 0

    return {
        "config": cfg,
        "exists": bool(exists),
        "version": version,
        "css_file": cpath,
        "json_file": jpath,
    }


def theme_set(ui_state_dir: str, cfg_in: Any) -> Dict[str, Any]:
    """Validate + persist theme config as JSON + generated CSS."""
    cfg = _sanitize_theme_config(cfg_in)
    jpath = _theme_json_path(ui_state_dir)
    cpath = _theme_css_path(ui_state_dir)

    _atomic_write_text(jpath, json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", mode=0o600)
    _atomic_write_text(cpath, _theme_css_from_config(cfg), mode=0o644)

    version = 0
    try:
        version = int(os.path.getmtime(cpath) or 0)
    except Exception:
        version = 0

    return {
        "config": cfg,
        "exists": True,
        "version": version,
        "css_file": cpath,
        "json_file": jpath,
    }


def theme_reset(ui_state_dir: str) -> Dict[str, Any]:
    """Remove saved custom theme (JSON + CSS)."""
    jpath = _theme_json_path(ui_state_dir)
    cpath = _theme_css_path(ui_state_dir)

    for fp in (jpath, cpath):
        try:
            if os.path.exists(fp):
                os.remove(fp)
        except Exception:
            pass

    return theme_get(ui_state_dir)


# ---------------------------------------------------------------------------
# Custom CSS editor (DevTools) — UI_STATE_DIR/custom.css (+ disable flag)
# ---------------------------------------------------------------------------


def _custom_css_path(ui_state_dir: str) -> str:
    return os.path.join(ui_state_dir, "custom.css")


def _custom_css_disabled_flag(ui_state_dir: str) -> str:
    return os.path.join(ui_state_dir, "custom_css.disabled")


_CUSTOM_CSS_MAX_CHARS = 250_000


def _sanitize_custom_css(text: Any) -> str:
    """Best-effort safety: accept only CSS, reject obvious JS vectors.

    Notes:
      - This is an admin-only feature, so the goal is to prevent accidental
        injection like pasting a <script> block or javascript: URLs.
      - CSS can still do a lot visually; safe-mode is the recovery mechanism.
    """
    s = "" if text is None else str(text)
    if len(s) > _CUSTOM_CSS_MAX_CHARS:
        raise ValueError("too_large")

    # Normalize line endings and strip BOM.
    try:
        s = s.replace("\r\n", "\n").replace("\r", "\n")
        if s.startswith("\ufeff"):
            s = s.lstrip("\ufeff")
    except Exception:
        pass

    # Reject common non-CSS pastes.
    lowered = s.lower()
    if "<script" in lowered or "</script" in lowered:
        raise ValueError("unsafe_css")

    # Reject javascript: URLs (including inside url(...)).
    if re.search(r"javascript\s*:", lowered, re.IGNORECASE):
        raise ValueError("unsafe_css")

    # Legacy IE-only JS execution inside CSS.
    if re.search(r"expression\s*\(", lowered, re.IGNORECASE):
        raise ValueError("unsafe_css")

    return s


def custom_css_get(ui_state_dir: str) -> Dict[str, Any]:
    """Load current custom.css content + meta (enabled/exists/version)."""
    css_path = _custom_css_path(ui_state_dir)
    disabled_flag = _custom_css_disabled_flag(ui_state_dir)

    enabled = False
    exists = False
    version = 0
    size = 0
    content = ""
    truncated = False

    try:
        if os.path.isfile(css_path):
            exists = True
            try:
                version = int(os.path.getmtime(css_path) or 0)
            except Exception:
                version = 0

            try:
                size = int(os.path.getsize(css_path) or 0)
            except Exception:
                size = 0

            # Read with a hard cap to avoid huge payloads.
            try:
                with open(css_path, "r", encoding="utf-8", errors="ignore") as f:
                    content = f.read(_CUSTOM_CSS_MAX_CHARS + 1)
                if len(content) > _CUSTOM_CSS_MAX_CHARS:
                    content = content[:_CUSTOM_CSS_MAX_CHARS]
                    truncated = True
            except Exception:
                content = ""

        enabled = exists and (not os.path.isfile(disabled_flag))
    except Exception:
        enabled = False
        exists = False

    return {
        "enabled": bool(enabled),
        "exists": bool(exists),
        "version": int(version or 0),
        "size": int(size or 0),
        "truncated": bool(truncated),
        "css": content,
        "css_file": css_path,
        "disabled_flag": disabled_flag,
        "max_chars": int(_CUSTOM_CSS_MAX_CHARS),
    }


def custom_css_set(ui_state_dir: str, css_text: Any) -> Dict[str, Any]:
    """Persist custom.css and enable it."""
    css_path = _custom_css_path(ui_state_dir)
    disabled_flag = _custom_css_disabled_flag(ui_state_dir)

    css = _sanitize_custom_css(css_text)
    _atomic_write_text(css_path, css if css.endswith("\n") else (css + "\n"), mode=0o644)

    # Enable by removing disable flag.
    try:
        if os.path.exists(disabled_flag):
            os.remove(disabled_flag)
    except Exception:
        pass

    return custom_css_get(ui_state_dir)


def custom_css_disable(ui_state_dir: str) -> Dict[str, Any]:
    """Disable custom CSS without deleting the file."""
    disabled_flag = _custom_css_disabled_flag(ui_state_dir)
    try:
        _atomic_write_text(disabled_flag, "disabled\n", mode=0o644)
    except Exception:
        pass
    return custom_css_get(ui_state_dir)


def custom_css_reset(ui_state_dir: str) -> Dict[str, Any]:
    """Delete custom.css and disable flag."""
    css_path = _custom_css_path(ui_state_dir)
    disabled_flag = _custom_css_disabled_flag(ui_state_dir)

    for fp in (css_path, disabled_flag):
        try:
            if os.path.exists(fp):
                os.remove(fp)
        except Exception:
            pass

    return custom_css_get(ui_state_dir)
