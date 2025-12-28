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

