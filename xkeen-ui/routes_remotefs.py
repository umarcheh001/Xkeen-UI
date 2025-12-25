"""Remote file manager backend (SFTP/FTP/FTPS) via lftp.

Designed for router UI usage:
- No credentials on disk (sessions live only in RAM)
- Capability gating (can be disabled on unsupported arch)
- Streaming download, upload via temp file

This is an MVP foundation for a full file manager.
"""

from __future__ import annotations

import os
import stat
import re
import time
import json
import uuid
import shutil
import subprocess
import threading
import queue
import secrets
from urllib.parse import quote as _url_quote
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple
from pathlib import Path

from flask import Blueprint, request, jsonify, current_app, Response, send_file

import zipfile


# Optional gevent sleep (for WS streaming without blocking the server)
try:  # pragma: no cover
    from gevent import sleep as _ws_sleep  # type: ignore
except Exception:  # pragma: no cover
    def _ws_sleep(seconds: float) -> None:
        time.sleep(seconds)


# --------------------------- Helpers ---------------------------

def error_response(message: str, status: int = 400, *, ok: bool | None = None, **extra: Any) -> Any:
    payload: Dict[str, Any] = {"error": message}
    if ok is not None:
        payload["ok"] = ok
    payload.update(extra)
    return jsonify(payload), status


def _now() -> float:
    return time.time()


def _gen_id(prefix: str = "rf") -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def _lftp_quote(s: str) -> str:
    """Quote a value for lftp command language.

    We avoid shell=True and pass the whole script as a single argument to -c,
    but lftp still parses its own quoting.
    """
    s = "" if s is None else str(s)
    # Use double quotes + backslash escaping for common specials.
    s = s.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{s}"'


def _zip_directory(src_dir: str, zip_path: str, *, root_name: str) -> None:
    """Create ZIP archive from a directory.

    - `root_name` becomes the top-level folder in the archive.
    - Symlinks are skipped for safety/stability on embedded systems.
    """
    src_dir = os.path.abspath(src_dir)
    root_name = (root_name or 'download').strip().strip('/') or 'download'
    # ZIP_DEFLATED requires zlib; on some embedded Python builds it may be missing.
    try:
        import zlib  # noqa: F401
        comp = zipfile.ZIP_DEFLATED
    except Exception:
        comp = zipfile.ZIP_STORED

    # Ensure parent exists
    os.makedirs(os.path.dirname(zip_path) or '.', exist_ok=True)

    with zipfile.ZipFile(zip_path, 'w', compression=comp, allowZip64=True) as zf:
        # Add empty root dir entry (some unzip tools show it nicely)
        try:
            zf.writestr(root_name.rstrip('/') + '/', b'')
        except Exception:
            pass

        for dirpath, dirnames, filenames in os.walk(src_dir, topdown=True, followlinks=False):
            # Skip symlinked directories (os.walk won't follow, but entries are in dirnames)
            safe_dirnames = []
            for d in list(dirnames):
                full = os.path.join(dirpath, d)
                try:
                    if os.path.islink(full):
                        continue
                except Exception:
                    continue
                safe_dirnames.append(d)
            dirnames[:] = safe_dirnames

            rel_dir = os.path.relpath(dirpath, src_dir)
            rel_dir = '' if rel_dir == '.' else rel_dir

            # Preserve empty directories
            if not filenames and not dirnames:
                arc_dir = os.path.join(root_name, rel_dir).replace(os.sep, '/')
                if not arc_dir.endswith('/'):
                    arc_dir += '/'
                try:
                    zf.writestr(arc_dir, b'')
                except Exception:
                    pass

            for fn in filenames:
                fp = os.path.join(dirpath, fn)
                try:
                    if os.path.islink(fp):
                        continue
                except Exception:
                    continue
                arc = os.path.join(root_name, rel_dir, fn).replace(os.sep, '/')
                try:
                    zf.write(fp, arc)
                except Exception:
                    # Best-effort: skip unreadable files
                    continue

def _zip_add_dir_to_zip(zf: zipfile.ZipFile, src_dir: str, arc_root: str) -> None:
    """Add directory tree into an open ZipFile under arc_root.

    Symlinks are skipped for safety/stability on embedded systems.
    """
    src_dir = os.path.abspath(src_dir)
    arc_root = (arc_root or 'download').strip().strip('/') or 'download'

    # Add root dir entry
    try:
        zf.writestr(arc_root.rstrip('/') + '/', b'')
    except Exception:
        pass

    for dirpath, dirnames, filenames in os.walk(src_dir, topdown=True, followlinks=False):
        # Skip symlinked directories
        safe_dirnames = []
        for d in list(dirnames):
            full = os.path.join(dirpath, d)
            try:
                if os.path.islink(full):
                    continue
            except Exception:
                continue
            safe_dirnames.append(d)
        dirnames[:] = safe_dirnames

        rel_dir = os.path.relpath(dirpath, src_dir)
        rel_dir = '' if rel_dir == '.' else rel_dir

        # Preserve empty directories
        if not filenames and not dirnames:
            arc_dir = os.path.join(arc_root, rel_dir).replace(os.sep, '/')
            if not arc_dir.endswith('/'):
                arc_dir += '/'
            try:
                zf.writestr(arc_dir, b'')
            except Exception:
                pass

        for fn in filenames:
            fp = os.path.join(dirpath, fn)
            try:
                if os.path.islink(fp):
                    continue
            except Exception:
                continue
            arc = os.path.join(arc_root, rel_dir, fn).replace(os.sep, '/')
            try:
                zf.write(fp, arc)
            except Exception:
                continue


def _zip_add_path(zf: zipfile.ZipFile, src_path: str, arc_name: str) -> None:
    """Add a file or directory to an open ZipFile under arc_name."""
    src_path = os.path.abspath(src_path)
    arc_name = (arc_name or 'item').strip().strip('/') or 'item'
    # Avoid weird absolute paths inside archive
    arc_name = arc_name.replace('..', '_').lstrip('/').lstrip('\\')
    if os.path.isdir(src_path):
        _zip_add_dir_to_zip(zf, src_path, arc_name)
        return
    if os.path.isfile(src_path):
        try:
            if os.path.islink(src_path):
                return
        except Exception:
            pass
        try:
            zf.write(src_path, arc_name.replace(os.sep, '/'))
        except Exception:
            pass
        return


def _zip_selection_local(resolved: List[Tuple[str, str]], zip_path: str, *, root_name: str) -> None:
    """Create a ZIP of multiple resolved local paths.

    `resolved` is a list of (real_path, display_name).
    The archive will contain a top-level folder `root_name`.
    """
    root_name = (root_name or 'selection').strip().strip('/') or 'selection'

    try:
        import zlib  # noqa: F401
        comp = zipfile.ZIP_DEFLATED
    except Exception:
        comp = zipfile.ZIP_STORED

    os.makedirs(os.path.dirname(zip_path) or '.', exist_ok=True)

    used: set[str] = set()
    with zipfile.ZipFile(zip_path, 'w', compression=comp, allowZip64=True) as zf:
        # Add root dir entry
        try:
            zf.writestr(root_name.rstrip('/') + '/', b'')
        except Exception:
            pass

        for rp, name in resolved:
            base = os.path.basename(name.rstrip('/')) or os.path.basename(rp.rstrip('/')) or 'item'
            base = base.replace('..', '_').replace('/', '_').replace('\\', '_') or 'item'
            arc = f"{root_name}/{base}"
            # Ensure unique
            if arc in used:
                n = 2
                while f"{arc}_{n}" in used:
                    n += 1
                arc = f"{arc}_{n}"
            used.add(arc)
            _zip_add_path(zf, rp, arc)

# --------------------------- Security helpers (SFTP host keys / FTPS TLS) ---------------------------

_HOSTKEY_POLICIES = ("accept_new", "reject_new", "accept_any")
_TLS_VERIFY_MODES = ("strict", "ca", "none")


def _ensure_writable_dir(path: str) -> str:
    """Ensure directory exists and is writable; raise on failure."""
    os.makedirs(path, exist_ok=True)
    test = os.path.join(path, '.writetest')
    with open(test, 'w', encoding='utf-8') as f:
        f.write('')
    os.remove(test)
    return path


def _choose_state_dir(tmp_dir: str) -> str:
    """Pick a persistent state dir for remotefs (known_hosts, etc.).

    Preference:
      1) XKEEN_REMOTEFM_STATE_DIR
      2) /opt/var/lib/xkeen-ui/remotefs
      3) <tmp_dir>/xkeen-ui-remotefs
    """
    env = (os.getenv('XKEEN_REMOTEFM_STATE_DIR', '') or '').strip()
    candidates = []
    if env:
        candidates.append(env)
    candidates.append('/opt/var/lib/xkeen-ui/remotefs')
    candidates.append(os.path.join(tmp_dir or '/tmp', 'xkeen-ui-remotefs'))
    last_err = None
    for c in candidates:
        try:
            return _ensure_writable_dir(c)
        except Exception as e:
            last_err = e
            continue
    # last resort: current dir
    fallback = os.path.abspath('./xkeen-ui-remotefs')
    try:
        return _ensure_writable_dir(fallback)
    except Exception as e:
        raise RuntimeError('state_dir_unwritable') from (last_err or e)


def _ensure_known_hosts_file(path: str) -> str:
    """Ensure known_hosts exists and is private (0600)."""
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    if not os.path.exists(path):
        with open(path, 'w', encoding='utf-8') as f:
            f.write('')
    try:
        os.chmod(path, 0o600)
    except Exception:
        pass
    return path


def _detect_default_ca_bundle() -> str | None:
    """Best-effort CA bundle discovery for FTPS verification."""
    env = (os.getenv('XKEEN_REMOTEFM_CA_FILE', '') or '').strip()
    if env and os.path.isfile(env):
        return env
    candidates = [
        '/etc/ssl/certs/ca-certificates.crt',
        '/etc/ssl/cert.pem',
        '/opt/etc/ssl/certs/ca-certificates.crt',
        '/opt/etc/ssl/cert.pem',
    ]
    for c in candidates:
        try:
            if os.path.isfile(c):
                return c
        except Exception:
            pass
    return None


def _normalize_security_options(protocol: str, options: Dict[str, Any], *, known_hosts_path: str, default_ca_file: str | None) -> tuple[Dict[str, Any], Dict[str, Any], List[str]]:
    """Normalize security options and return (options, effective, warnings)."""
    opt = dict(options or {})
    warnings: List[str] = []
    effective: Dict[str, Any] = {}

    # --- SFTP host key policy ---
    hostkey_policy = str(opt.get('hostkey_policy', 'accept_new') or 'accept_new').strip().lower()
    if hostkey_policy not in _HOSTKEY_POLICIES:
        hostkey_policy = 'accept_new'
    if protocol == 'sftp':
        kh = str(opt.get('known_hosts_path') or known_hosts_path or '').strip()
        if not kh:
            kh = known_hosts_path
        _ensure_known_hosts_file(kh)
        opt['known_hosts_path'] = kh
        opt['hostkey_policy'] = hostkey_policy
        effective['hostkey_policy'] = hostkey_policy
        effective['known_hosts_path'] = kh
        if hostkey_policy == 'accept_any':
            warnings.append('SFTP: проверка host key отключена (accept_any). Возможна атака MITM.')
        elif hostkey_policy == 'accept_new':
            warnings.append(f'SFTP: новые host key будут автоматически добавляться в known_hosts: {kh}')
        else:
            warnings.append(f'SFTP: будут приниматься только уже известные host key из {kh} (reject_new).')
    else:
        # not applicable
        opt.pop('known_hosts_path', None)
        opt.pop('hostkey_policy', None)

    # --- FTPS TLS verification ---
    tls_mode: str
    tls_raw = opt.get('tls_verify', opt.get('tls', None))
    if isinstance(tls_raw, dict):
        tls_mode = str(tls_raw.get('verify', 'none') or 'none').strip().lower()
        ca_file = tls_raw.get('ca_file')
    else:
        # backward compat: bool
        if isinstance(tls_raw, bool):
            tls_mode = 'strict' if tls_raw else 'none'
        else:
            tls_mode = str(tls_raw or 'none').strip().lower()
        ca_file = opt.get('ca_file')

    if tls_mode not in _TLS_VERIFY_MODES:
        tls_mode = 'none'

    if protocol == 'ftps':
        if ca_file and isinstance(ca_file, str) and os.path.isfile(ca_file):
            ca = ca_file
        else:
            ca = default_ca_file
        opt['tls_verify_mode'] = tls_mode
        opt['tls_ca_file'] = ca
        effective['tls_verify_mode'] = tls_mode
        effective['tls_ca_file'] = ca
        if tls_mode == 'none':
            warnings.append('FTPS: проверка TLS-сертификата отключена (verify=none). Возможна атака MITM.')
        else:
            if not ca:
                warnings.append('FTPS: включена проверка сертификата, но CA bundle не найден. Укажите tls.ca_file или XKEEN_REMOTEFM_CA_FILE.')
            else:
                warnings.append(f'FTPS: проверка сертификата включена (verify={tls_mode}), CA: {ca}')
    else:
        opt.pop('tls_verify_mode', None)
        opt.pop('tls_ca_file', None)

    return opt, effective, warnings


def _classify_connect_error(stderr: str) -> Dict[str, Any]:
    """Try to classify common SSH host key / TLS issues for UI."""
    s = (stderr or '').strip()
    low = s.lower()
    out: Dict[str, Any] = {}

    # SSH host key problems
    if 'remote host identification has changed' in low or 'host key verification failed' in low:
        out['kind'] = 'hostkey_changed'
        out['hint'] = 'Ключ сервера изменился. Проверьте, что это ожидаемо, затем удалите старую запись из known_hosts.'
        return out
    if 'are you sure you want to continue connecting' in low or 'authenticity of host' in low:
        out['kind'] = 'hostkey_unknown'
        out['hint'] = 'Ключ сервера неизвестен. Выберите hostkey_policy=accept_new (или accept_any) либо добавьте ключ в known_hosts.'
        return out
    if 'bad configuration option' in low and 'accept-new' in low:
        out['kind'] = 'hostkey_policy_unsupported'
        out['hint'] = 'ssh на устройстве не поддерживает StrictHostKeyChecking=accept-new. Используйте accept_any или обновите ssh.'
        return out

    # TLS verification problems
    if 'certificate' in low and ('verify' in low or 'verification' in low or 'not trusted' in low):
        out['kind'] = 'tls_verify_failed'
        out['hint'] = 'Проверка TLS-сертификата не прошла. Проверьте CA bundle/цепочку сертификатов или отключите verify=none (не рекомендуется).'
        return out

    out['kind'] = 'connect_failed'
    return out



_MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}


def _parse_ls_line(line: str, *, now_ts: Optional[float] = None) -> Optional[Dict[str, Any]]:
    """Best-effort parse of an ls -l style line produced by lftp `cls -l`.

    FTP/SFTP listings vary across servers. We use a forgiving token-based parser:
    - Detect permissions token (e.g. drwxr-xr-x)
    - Find month token (Jan/Feb/...) in the line
    - Treat the token right before month as size
    - Everything after (month day time|year) is the name (may include spaces)
    """
    s = (line or "").rstrip("\n").strip()
    if not s or s.startswith("total "):
        return None

    parts = s.split()
    if len(parts) < 6:
        return None

    perm = parts[0]
    # Must start with a file type char + 9 mode chars
    if not re.match(r"^[bcdlps-][rwxStTs-]{9}$", perm):
        return None

    # Locate month token
    month_idx = -1
    for i, tok in enumerate(parts):
        if tok.lower() in _MONTHS:
            month_idx = i
            break
    if month_idx < 0:
        return None

    # Need at least: <mon> <day> <time|year> <name...>
    if month_idx + 3 >= len(parts):
        return None

    # Size usually sits right before month token, but may be missing / non-numeric on some servers.
    size = 0
    try:
        size = int(parts[month_idx - 1]) if month_idx - 1 >= 1 else 0
    except Exception:
        size = 0

    mon_s = parts[month_idx].lower()
    try:
        day = int(parts[month_idx + 1])
    except Exception:
        return None
    ty = parts[month_idx + 2]

    name_rest = " ".join(parts[month_idx + 3:]) if (month_idx + 3) < len(parts) else ""
    if not name_rest:
        return None

    ftype = "other"
    if perm.startswith("d"):
        ftype = "dir"
    elif perm.startswith("-"):
        ftype = "file"
    elif perm.startswith("l"):
        ftype = "link"

    name = name_rest
    link_target = None
    if ftype == "link" and " -> " in name_rest:
        name, link_target = name_rest.split(" -> ", 1)

    mtime = None
    if mon_s in _MONTHS:
        mon = _MONTHS[mon_s]
        if now_ts is None:
            now_ts = _now()
        lt = time.localtime(now_ts)
        year = lt.tm_year
        if ":" in ty:
            try:
                hh, mm = ty.split(":", 1)
                hh_i = int(hh)
                mm_i = int(mm)
            except Exception:
                hh_i = 0
                mm_i = 0
            # Heuristic: if month/day is ahead of today, assume previous year.
            if (mon, day) > (lt.tm_mon, lt.tm_mday):
                year -= 1
            try:
                mtime = int(time.mktime((year, mon, day, hh_i, mm_i, 0, 0, 0, -1)))
            except Exception:
                mtime = None
        else:
            try:
                year = int(ty)
                mtime = int(time.mktime((year, mon, day, 0, 0, 0, 0, 0, -1)))
            except Exception:
                mtime = None

    item: Dict[str, Any] = {
        "name": name,
        "type": ftype,
        "size": size,
        "perm": perm,
        "mtime": mtime,
    }
    if link_target is not None:
        item["link_target"] = link_target
    return item



# --------------------------- Local FS helpers (two-panel manager) ---------------------------


def _local_allowed_roots() -> List[str]:
    # Colon-separated list of allowed roots. Defaults are safe-ish for router UI.
    env = (os.getenv('XKEEN_LOCALFM_ROOTS', '') or '').strip()
    if env:
        roots = [r for r in env.split(':') if r.strip()]
    else:
        roots = ['/opt/var', '/tmp']
    out: List[str] = []
    for r in roots:
        try:
            rp = os.path.realpath(r).rstrip('/')
            if rp:
                out.append(rp)
        except Exception:
            continue
    # de-dup
    return sorted(set(out))


def _local_is_allowed(real_path: str, roots: List[str]) -> bool:
    try:
        rp = os.path.realpath(real_path)
    except Exception:
        rp = real_path
    for root in roots:
        try:
            if os.path.commonpath([rp, root]) == root:
                return True
        except Exception:
            continue
    return False


def _local_resolve(path: str, roots: List[str]) -> str:
    if not roots:
        raise PermissionError('no_local_roots')
    p = (path or '').strip()
    if not p:
        p = roots[0]
    if not p.startswith('/'):
        # treat relative as relative to first root
        p = os.path.join(roots[0], p)
    rp = os.path.realpath(p)
    if not _local_is_allowed(rp, roots):
        raise PermissionError('path_not_allowed')
    return rp


def _local_item_from_stat(name: str, st: os.stat_result, *, is_dir: bool, is_link: bool, link_dir: bool = False) -> Dict[str, Any]:
    ftype = 'other'
    if is_dir:
        ftype = 'dir'
    elif is_link:
        ftype = 'link'
    else:
        ftype = 'file'
    try:
        perm = stat.filemode(st.st_mode)
    except Exception:
        perm = None
    return {
        'name': name,
        'type': ftype,
        'size': int(getattr(st, 'st_size', 0) or 0),
        'perm': perm,
        'mtime': int(getattr(st, 'st_mtime', 0) or 0),
            'link_dir': bool(link_dir) if is_link else False,
    }

@dataclass
class RemoteFsSession:
    session_id: str
    protocol: str
    host: str
    port: int
    username: str
    auth_type: str
    password: str
    options: Dict[str, Any]
    created_ts: float
    last_used_ts: float


class RemoteFsManager:
    def __init__(
        self,
        *,
        enabled: bool,
        lftp_bin: str,
        ttl_seconds: int = 1800,
        max_sessions: int = 6,
        tmp_dir: str = "/tmp",
        max_upload_mb: int = 200,
        state_dir: str | None = None,
        known_hosts_path: str | None = None,
        default_ca_file: str | None = None,
    ) -> None:
        self.enabled = enabled
        self.lftp_bin = lftp_bin
        self.ttl_seconds = ttl_seconds
        self.max_sessions = max_sessions
        self.tmp_dir = tmp_dir
        self.max_upload_mb = max_upload_mb
        self.state_dir = state_dir or tmp_dir
        self.known_hosts_path = known_hosts_path
        self.default_ca_file = default_ca_file
        self._lock = threading.Lock()
        self._sessions: Dict[str, RemoteFsSession] = {}

    def cleanup(self) -> None:
        if not self.enabled:
            return
        now = _now()
        with self._lock:
            dead = [sid for sid, s in self._sessions.items() if (now - s.last_used_ts) > self.ttl_seconds]
            for sid in dead:
                self._sessions.pop(sid, None)

    def _touch(self, sid: str) -> None:
        with self._lock:
            s = self._sessions.get(sid)
            if s:
                s.last_used_ts = _now()

    def get(self, sid: str) -> Optional[RemoteFsSession]:
        self.cleanup()
        with self._lock:
            return self._sessions.get(sid)

    def create(self, protocol: str, host: str, port: int, username: str, auth_type: str, password: str, options: Dict[str, Any]) -> RemoteFsSession:
        if not self.enabled:
            raise RuntimeError("feature_disabled")
        self.cleanup()
        with self._lock:
            if len(self._sessions) >= self.max_sessions:
                raise RuntimeError("too_many_sessions")
            sid = _gen_id("rfs")
            s = RemoteFsSession(
                session_id=sid,
                protocol=protocol,
                host=host,
                port=port,
                username=username,
                auth_type=auth_type,
                password=password,
                options=options,
                created_ts=_now(),
                last_used_ts=_now(),
            )
            self._sessions[sid] = s
            return s

    def close(self, sid: str) -> bool:
        with self._lock:
            return self._sessions.pop(sid, None) is not None

    # --------------------------- lftp runner ---------------------------

    def _build_lftp_script(self, s: RemoteFsSession, commands: List[str]) -> str:
        timeout = int(s.options.get("timeout_sec", 10) or 10)

        url = f"{s.protocol}://{s.host}:{int(s.port)}"

        parts: List[str] = [
            "set cmd:fail-exit yes",
            f"set net:timeout {timeout}",
            "set net:max-retries 1",
            "set net:persist-retries 0",
            # keep output stable for parsing
            "set cmd:interactive false",
        ]

        # --- SFTP host key policy ---
        if s.protocol == "sftp":
            hostkey_policy = str(s.options.get("hostkey_policy", "accept_new") or "accept_new").lower()
            if hostkey_policy not in _HOSTKEY_POLICIES:
                hostkey_policy = "accept_new"
            kh = str(s.options.get("known_hosts_path") or self.known_hosts_path or "").strip()
            if kh:
                _ensure_known_hosts_file(kh)

            # sftp:auto-confirm answers yes/no to ssh prompts about new host keys.
            parts.append(f"set sftp:auto-confirm {'yes' if hostkey_policy in ('accept_new','accept_any') else 'no'}")

            # Prefer to rely on ssh's StrictHostKeyChecking policy.
            # We force a dedicated known_hosts file so the UI can manage it.
            strict = "accept-new" if hostkey_policy == "accept_new" else ("yes" if hostkey_policy == "reject_new" else "no")
            if kh:
                # lftp will add -l/-p itself; connect-program must support them.
                connect_prog = "ssh -a -x -oLogLevel=ERROR "                                f"-oUserKnownHostsFile={kh} -oGlobalKnownHostsFile=/dev/null -oStrictHostKeyChecking={strict}"
                parts.append(f"set sftp:connect-program {_lftp_quote(connect_prog)}")

        # --- FTPS TLS verification ---
        if s.protocol in ("ftps",):
            mode = str(s.options.get('tls_verify_mode') or 'none').strip().lower()
            if mode not in _TLS_VERIFY_MODES:
                mode = 'none'
            ca_file = s.options.get('tls_ca_file') or self.default_ca_file
            parts.append("set ftp:ssl-force yes")
            parts.append("set ftp:ssl-protect-data yes")
            parts.append(f"set ssl:verify-certificate {'yes' if mode != 'none' else 'no'}")
            parts.append(f"set ssl:check-hostname {'yes' if mode == 'strict' else 'no'}")
            if ca_file:
                parts.append(f"set ssl:ca-file {_lftp_quote(str(ca_file))}")

        # open
        if s.auth_type != "password":
            raise RuntimeError("unsupported_auth")
        parts.append(
            f"open -u {_lftp_quote(s.username)},{_lftp_quote(s.password)} {url}"
        )

        parts.extend(commands)
        parts.append("bye")
        return "; ".join(parts)

    def _run_lftp(self, s: RemoteFsSession, commands: List[str], *, capture: bool = True) -> Tuple[int, bytes, bytes]:
        script = self._build_lftp_script(s, commands)
        env = os.environ.copy()
        env.setdefault("LC_ALL", "C")
        env.setdefault("LANG", "C")

        # NOTE: do not log script (contains password)
        p = subprocess.Popen(
            [self.lftp_bin, "-c", script],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
        out, err = p.communicate()
        return int(p.returncode or 0), out or b"", err or b""

    def _popen_lftp(self, s: RemoteFsSession, commands: List[str]) -> subprocess.Popen:
        script = self._build_lftp_script(s, commands)
        env = os.environ.copy()
        env.setdefault("LC_ALL", "C")
        env.setdefault("LANG", "C")
        p = subprocess.Popen(
            [self.lftp_bin, "-c", script],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            bufsize=0,
        )
        return p


# --------------------------- Blueprint ---------------------------


def create_remotefs_blueprint(
    *,
    enabled: bool,
    lftp_bin: str,
    ttl_seconds: int = 1800,
    max_sessions: int = 6,
    tmp_dir: str = "/tmp",
    max_upload_mb: int = 200,
) -> Blueprint:
    bp = Blueprint("remotefs", __name__)

    # Persistent state for security material (known_hosts, CA bundle reference)
    STATE_DIR = _choose_state_dir(tmp_dir)
    KNOWN_HOSTS_PATH = _ensure_known_hosts_file(
        (os.getenv('XKEEN_REMOTEFM_KNOWN_HOSTS', '') or '').strip() or os.path.join(STATE_DIR, 'known_hosts')
    )
    DEFAULT_CA_FILE = _detect_default_ca_bundle()

    mgr = RemoteFsManager(
        enabled=enabled,
        lftp_bin=lftp_bin,
        ttl_seconds=ttl_seconds,
        max_sessions=max_sessions,
        tmp_dir=tmp_dir,
        max_upload_mb=max_upload_mb,
        state_dir=STATE_DIR,
        known_hosts_path=KNOWN_HOSTS_PATH,
        default_ca_file=DEFAULT_CA_FILE,
    )

    # ---- FileOps spooling (used for remote→remote transfers) ----
    # Keep spool inside tmp_dir (RAM) by default. Can be overridden.
    FILEOPS_SPOOL_DIR = os.getenv('XKEEN_FILEOPS_SPOOL_DIR', os.path.join(tmp_dir, 'xkeen_fileops_spool'))
    try:
        FILEOPS_SPOOL_MAX_MB = int(os.getenv('XKEEN_FILEOPS_SPOOL_MAX_MB', str(max_upload_mb)) or str(max_upload_mb))
    except Exception:
        FILEOPS_SPOOL_MAX_MB = int(max_upload_mb)
    if FILEOPS_SPOOL_MAX_MB < 16:
        FILEOPS_SPOOL_MAX_MB = 16
    FILEOPS_SPOOL_MAX_BYTES = FILEOPS_SPOOL_MAX_MB * 1024 * 1024

    # Cleanup old spool items (best-effort). Helps avoid leftovers after crashes/reboots.
    try:
        FILEOPS_SPOOL_CLEANUP_AGE_SECONDS = int(os.getenv('XKEEN_FILEOPS_SPOOL_CLEANUP_AGE', '21600') or '21600')
    except Exception:
        FILEOPS_SPOOL_CLEANUP_AGE_SECONDS = 21600
    if FILEOPS_SPOOL_CLEANUP_AGE_SECONDS < 600:
        FILEOPS_SPOOL_CLEANUP_AGE_SECONDS = 600

    # Remote→remote direct copy via lftp URL form. For FTP/FTPS this can use FXP.
    # Can be disabled (e.g. if you want to force spooling behavior).
    def _env_bool(name: str, default: bool = True) -> bool:
        v = (os.getenv(name, '') or '').strip().lower()
        if not v:
            return bool(default)
        if v in ('1', 'true', 'yes', 'on', '+'):
            return True
        if v in ('0', 'false', 'no', 'off', '-'):
            return False
        return bool(default)

    FILEOPS_REMOTE2REMOTE_DIRECT = _env_bool('XKEEN_FILEOPS_REMOTE2REMOTE_DIRECT', True)
    FILEOPS_FXP_ENABLED = _env_bool('XKEEN_FILEOPS_FXP', True)

    def _require_enabled() -> Optional[Any]:
        if not mgr.enabled:
            return error_response("feature_disabled", 404, ok=False)
        return None

    def _get_session_or_404(sid: str) -> Tuple[Optional[RemoteFsSession], Optional[Any]]:
        if (resp := _require_enabled()) is not None:
            return None, resp
        s = mgr.get(sid)
        if not s:
            return None, error_response("session_not_found", 404, ok=False)
        mgr._touch(sid)
        return s, None

    

    @bp.get("/api/remotefs/capabilities")
    def api_remotefs_capabilities() -> Any:
        """Capabilities for the remote file manager (security defaults, modes)."""
        if (resp := _require_enabled()) is not None:
            return resp
        return jsonify({
            "ok": True,
            "security": {
                "sftp": {
                    "hostkey_policies": list(_HOSTKEY_POLICIES),
                    "default_policy": "accept_new",
                    "known_hosts_path": mgr.known_hosts_path,
                },
                "ftps": {
                    "tls_verify_modes": list(_TLS_VERIFY_MODES),
                    "default_mode": "none",
                    "default_ca_file": mgr.default_ca_file,
                },
            },
            "fileops": {
                "overwrite_modes": ["replace", "skip", "ask"],
                "supports_dry_run": True,
                "supports_decisions": True,
            },
            "fs_admin": {
                "local": {
                    "chmod": True,
                    "chown": True,
                    "touch": True,
                    "stat_batch": True,
                },
                "remote": {
                    "chmod": True,
                    "chown": False,
                    "touch": True,
                    "stat_batch": True,
                },
            },
        })

    @bp.post("/api/remotefs/sessions")
    def api_remotefs_create_session() -> Any:
        if (resp := _require_enabled()) is not None:
            return resp

        data = request.get_json(silent=True) or {}
        protocol = str(data.get("protocol", "")).strip().lower()
        if protocol not in ("sftp", "ftp", "ftps"):
            return error_response("unsupported_protocol", 400, ok=False)

        host = str(data.get("host", "")).strip()
        if not host:
            return error_response("host_required", 400, ok=False)

        port = int(data.get("port") or (22 if protocol == "sftp" else 21))
        username = str(data.get("username", "")).strip()
        if not username:
            return error_response("username_required", 400, ok=False)

        auth = data.get("auth") or {}
        auth_type = str(auth.get("type", "password")).strip().lower()
        password = str(auth.get("password", ""))
        if auth_type != "password":
            return error_response("unsupported_auth", 400, ok=False)
        if not password:
            return error_response("password_required", 400, ok=False)

        options = data.get("options") or {}
        if not isinstance(options, dict):
            options = {}

        # Normalize security options and produce warnings for UI.
        options, effective_sec, warnings = _normalize_security_options(
            protocol,
            options,
            known_hosts_path=mgr.known_hosts_path or '',
            default_ca_file=mgr.default_ca_file,
        )

        try:
            s = mgr.create(protocol, host, port, username, auth_type, password, options)
        except RuntimeError as e:
            msg = str(e)
            if msg == "too_many_sessions":
                return error_response("too_many_sessions", 429, ok=False)
            if msg == "feature_disabled":
                return error_response("feature_disabled", 404, ok=False)
            return error_response("create_failed", 400, ok=False)

        # light connectivity check: `pwd` (cheap and also validates credentials)
        rc, out, err = mgr._run_lftp(s, ["pwd"], capture=True)
        if rc != 0:
            mgr.close(s.session_id)
            tail = (err.decode("utf-8", errors="replace")[-800:]).strip()
            info = _classify_connect_error(tail)
            # Provide extra context for UI.
            return error_response(
                "connect_failed",
                400,
                ok=False,
                details=tail[-400:],
                kind=info.get('kind'),
                hint=info.get('hint'),
                security={
                    **(effective_sec or {}),
                    "protocol": protocol,
                },
                warnings=warnings,
            )

        return jsonify({
            "ok": True,
            "session_id": s.session_id,
            "protocol": s.protocol,
            "host": s.host,
            "port": s.port,
            "username": s.username,
            "features": {"stream_download": True, "upload": True},
            "security": {
                **(effective_sec or {}),
                "protocol": protocol,
            },
            "warnings": warnings,
        })

    @bp.delete("/api/remotefs/sessions/<sid>")
    def api_remotefs_close_session(sid: str) -> Any:
        if (resp := _require_enabled()) is not None:
            return resp
        closed = mgr.close(sid)
        return jsonify({"ok": True, "closed": bool(closed)})

    @bp.get("/api/remotefs/sessions/<sid>/list")
    def api_remotefs_list(sid: str) -> Any:
        s, resp = _get_session_or_404(sid)
        if resp is not None:
            return resp
        path = str(request.args.get("path", ".") or ".")
        path = path.strip()
        path_q = _lftp_quote(path)

        # Use cls -l for parseable-ish output.
        # NOTE: Avoid '--' here for broader lftp compatibility across builds.
        cmd = "cls -l" if (not path or path in (".",)) else f"cls -l {path_q}"
        rc, out, err = mgr._run_lftp(s, [cmd], capture=True)
        if rc != 0:
            tail = (err.decode("utf-8", errors="replace")[-400:]).strip()
            return error_response("list_failed", 400, ok=False, details=tail)

        text = out.decode("utf-8", errors="replace")
        items: List[Dict[str, Any]] = []
        for line in text.splitlines():
            item = _parse_ls_line(line)
            if item is not None:
                items.append(item)
        return jsonify({"ok": True, "path": path, "items": items})

    @bp.get("/api/remotefs/sessions/<sid>/stat")
    def api_remotefs_stat(sid: str) -> Any:
        s, resp = _get_session_or_404(sid)
        if resp is not None:
            return resp
        path = request.args.get("path", "")
        if not path:
            return error_response("path_required", 400, ok=False)
        path_q = _lftp_quote(path)

        # NOTE: Avoid '--' here for broader lftp compatibility across builds.
        rc, out, err = mgr._run_lftp(s, [f"cls -ld {path_q}"], capture=True)
        if rc != 0:
            tail = (err.decode("utf-8", errors="replace")[-400:]).strip()
            return error_response("stat_failed", 400, ok=False, details=tail)

        text = out.decode("utf-8", errors="replace")
        first = None
        for line in text.splitlines():
            first = _parse_ls_line(line)
            if first:
                break
        if not first:
            return error_response("stat_unavailable", 404, ok=False)
        return jsonify({"ok": True, "path": path, "item": first})

    @bp.post("/api/remotefs/sessions/<sid>/mkdir")
    def api_remotefs_mkdir(sid: str) -> Any:
        s, resp = _get_session_or_404(sid)
        if resp is not None:
            return resp
        data = request.get_json(silent=True) or {}
        path = str(data.get("path", "")).strip()
        if not path:
            return error_response("path_required", 400, ok=False)
        parents = bool(data.get("parents", False))
        cmd = f"mkdir {'-p ' if parents else ''}{_lftp_quote(path)}"
        rc, out, err = mgr._run_lftp(s, [cmd], capture=True)
        if rc != 0:
            tail = (err.decode("utf-8", errors="replace")[-400:]).strip()
            return error_response("mkdir_failed", 400, ok=False, details=tail)
        return jsonify({"ok": True})

    @bp.post("/api/remotefs/sessions/<sid>/rename")
    def api_remotefs_rename(sid: str) -> Any:
        s, resp = _get_session_or_404(sid)
        if resp is not None:
            return resp
        data = request.get_json(silent=True) or {}
        src = str(data.get("src", "")).strip()
        dst = str(data.get("dst", "")).strip()
        if not src or not dst:
            return error_response("src_dst_required", 400, ok=False)
        rc, out, err = mgr._run_lftp(s, [f"mv {_lftp_quote(src)} {_lftp_quote(dst)}"], capture=True)
        if rc != 0:
            tail = (err.decode("utf-8", errors="replace")[-400:]).strip()
            return error_response("rename_failed", 400, ok=False, details=tail)
        return jsonify({"ok": True})

    @bp.delete("/api/remotefs/sessions/<sid>/remove")
    def api_remotefs_remove(sid: str) -> Any:
        s, resp = _get_session_or_404(sid)
        if resp is not None:
            return resp
        path = request.args.get("path", "")
        if not path:
            return error_response("path_required", 400, ok=False)
        recursive = request.args.get("recursive", "0") in ("1", "true", "yes", "on")

        if recursive:
            cmds = [f"rm -r {_lftp_quote(path)}"]
            rc, out, err = mgr._run_lftp(s, cmds, capture=True)
            if rc != 0:
                tail = (err.decode("utf-8", errors="replace")[-400:]).strip()
                return error_response("remove_failed", 400, ok=False, details=tail)
            return jsonify({"ok": True})

        # non-recursive: try rm then rmdir
        rc, out, err = mgr._run_lftp(s, [f"rm {_lftp_quote(path)}"], capture=True)
        if rc == 0:
            return jsonify({"ok": True})
        rc2, out2, err2 = mgr._run_lftp(s, [f"rmdir {_lftp_quote(path)}"], capture=True)
        if rc2 != 0:
            tail = (err2.decode("utf-8", errors="replace")[-400:]).strip()
            return error_response("remove_failed", 400, ok=False, details=tail)
        return jsonify({"ok": True})

    @bp.get("/api/remotefs/sessions/<sid>/download")
    def api_remotefs_download(sid: str) -> Any:
        s, resp = _get_session_or_404(sid)
        if resp is not None:
            return resp
        path = request.args.get("path", "")
        if not path:
            return error_response("path_required", 400, ok=False)

        # Preflight stat to fail early with JSON (before streaming headers are sent)
        # Also try to extract Content-Length for client-side progress.
        rc, out, err = mgr._run_lftp(s, [f"cls -ld {_lftp_quote(path)}"], capture=True)
        if rc != 0:
            tail = (err.decode("utf-8", errors="replace")[-400:]).strip()
            return error_response("not_found", 404, ok=False, details=tail)

        size_bytes: int | None = None
        try:
            text = (out or b'').decode('utf-8', errors='replace')
            for line in text.splitlines():
                item = _parse_ls_line(line)
                if not item:
                    continue
                if str(item.get('type') or '') == 'dir':
                    return error_response('not_a_file', 400, ok=False)
                sz = item.get('size', None)
                if isinstance(sz, int) and sz >= 0:
                    size_bytes = int(sz)
                else:
                    try:
                        size_bytes = int(sz)
                    except Exception:
                        size_bytes = None
                break
        except Exception:
            size_bytes = None

        # Stream via `cat`.
        p = mgr._popen_lftp(s, [f"cat {_lftp_quote(path)}"])
        stdout = p.stdout
        stderr = p.stderr

        def _gen():
            try:
                assert stdout is not None
                while True:
                    chunk = stdout.read(64 * 1024)
                    if not chunk:
                        break
                    yield chunk
            finally:
                try:
                    if stdout:
                        stdout.close()
                except Exception:
                    pass
                try:
                    if stderr:
                        stderr.close()
                except Exception:
                    pass
                try:
                    p.wait(timeout=1)
                except Exception:
                    pass

        filename = os.path.basename(path.rstrip("/")) or "download"
        headers = {
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
        }
        if isinstance(size_bytes, int) and size_bytes >= 0:
            headers["Content-Length"] = str(size_bytes)
        return Response(_gen(), mimetype="application/octet-stream", headers=headers)

    @bp.post("/api/remotefs/sessions/<sid>/upload")
    def api_remotefs_upload(sid: str) -> Any:
        s, resp = _get_session_or_404(sid)
        if resp is not None:
            return resp

        # remote path (full path including filename)
        remote_path = request.args.get("path", "")
        if not remote_path:
            return error_response("path_required", 400, ok=False)

        if "file" not in request.files:
            return error_response("file_required", 400, ok=False)

        f = request.files["file"]
        if not f:
            return error_response("file_required", 400, ok=False)

        # Size limit (best-effort): read stream into temp file, counting bytes.
        max_bytes = int(mgr.max_upload_mb) * 1024 * 1024
        os.makedirs(mgr.tmp_dir, exist_ok=True)
        tmp_path = os.path.join(mgr.tmp_dir, f"xkeen_upload_{sid}_{uuid.uuid4().hex}.tmp")

        total = 0
        try:
            with open(tmp_path, "wb") as outfp:
                while True:
                    chunk = f.stream.read(64 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > max_bytes:
                        raise ValueError("too_large")
                    outfp.write(chunk)
        except ValueError as e:
            try:
                os.remove(tmp_path)
            except Exception:
                pass
            if str(e) == "too_large":
                return error_response("upload_too_large", 413, ok=False, max_mb=mgr.max_upload_mb)
            return error_response("upload_failed", 400, ok=False)
        except Exception:
            try:
                os.remove(tmp_path)
            except Exception:
                pass
            return error_response("upload_failed", 400, ok=False)

        try:
            rc, out, err = mgr._run_lftp(
                s,
                [f"put {_lftp_quote(tmp_path)} -o {_lftp_quote(remote_path)}"],
                capture=True,
            )
            if rc != 0:
                tail = (err.decode("utf-8", errors="replace")[-400:]).strip()
                return error_response("remote_put_failed", 400, ok=False, details=tail)
            return jsonify({"ok": True, "bytes": total})
        finally:
            try:
                os.remove(tmp_path)
            except Exception:
                pass


    # --------------------------- Two-panel file operations (MVP iteration 1) ---------------------------


    # --------------------------- FileOps WS tokens (one-time) ---------------------------

    FILEOPS_WS_TOKENS: Dict[str, float] = {}  # token -> expires_ts

    def issue_fileops_ws_token(ttl_seconds: int = 60) -> str:
        token = secrets.token_urlsafe(24)
        FILEOPS_WS_TOKENS[token] = _now() + int(ttl_seconds)
        return token

    def validate_fileops_ws_token(token: str) -> bool:
        try:
            token = (token or '').strip()
        except Exception:
            token = ''
        if not token:
            return False
        exp = FILEOPS_WS_TOKENS.get(token)
        if not exp:
            return False
        if _now() > float(exp):
            FILEOPS_WS_TOKENS.pop(token, None)
            return False
        # one-time
        FILEOPS_WS_TOKENS.pop(token, None)
        return True

    LOCALFS_ROOTS = _local_allowed_roots()

    # Resolve spool directory under the allowed local roots.
    try:
        _SPOOL_BASE = _local_resolve(FILEOPS_SPOOL_DIR, LOCALFS_ROOTS)
    except Exception:
        # fall back to tmp_dir
        try:
            _SPOOL_BASE = _local_resolve(os.path.join(tmp_dir, 'xkeen_fileops_spool'), LOCALFS_ROOTS)
        except Exception:
            _SPOOL_BASE = os.path.join(tmp_dir, 'xkeen_fileops_spool')

    def _spool_ensure_dir() -> str:
        try:
            os.makedirs(_SPOOL_BASE, exist_ok=True)
        except Exception:
            pass
        return _SPOOL_BASE

    def _spool_tmp_file(*, ext: str = '') -> str:
        base = _spool_ensure_dir()
        name = f"spool_{uuid.uuid4().hex[:10]}"
        if ext:
            if not ext.startswith('.'):
                ext = '.' + ext
            name += ext
        return os.path.join(base, name)

    def _spool_tmp_dir() -> str:
        base = _spool_ensure_dir()
        p = os.path.join(base, f"spooldir_{uuid.uuid4().hex[:10]}")
        try:
            os.makedirs(p, exist_ok=True)
        except Exception:
            pass
        return p

    def _dir_size_bytes(path: str, *, stop_after: int | None = None) -> int:
        """Compute directory/file size in bytes (best-effort).

        stop_after: if provided, returns a value > stop_after as soon as it is exceeded.
        """
        total = 0
        p = path
        try:
            if os.path.isfile(p):
                return int(os.path.getsize(p))
        except Exception:
            return 0

        stack: List[str] = [p]
        while stack:
            cur = stack.pop()
            try:
                with os.scandir(cur) as it:
                    for entry in it:
                        try:
                            if entry.is_symlink():
                                continue
                            if entry.is_dir(follow_symlinks=False):
                                stack.append(entry.path)
                                continue
                            if entry.is_file(follow_symlinks=False):
                                try:
                                    total += int(entry.stat(follow_symlinks=False).st_size or 0)
                                except Exception:
                                    pass
                                if stop_after is not None and total > stop_after:
                                    return total
                        except Exception:
                            continue
            except Exception:
                continue
        return total

    def _spool_cleanup_stale() -> None:
        """Best-effort cleanup of stale spool items left after crashes."""
        if not FILEOPS_SPOOL_CLEANUP_AGE_SECONDS:
            return
        base = _spool_ensure_dir()
        cutoff = _now() - float(FILEOPS_SPOOL_CLEANUP_AGE_SECONDS)
        try:
            with os.scandir(base) as it:
                for entry in it:
                    name = entry.name
                    if not (name.startswith('spool_') or name.startswith('spooldir_')):
                        continue
                    try:
                        st = entry.stat(follow_symlinks=False)
                        if float(st.st_mtime) > cutoff:
                            continue
                    except Exception:
                        continue
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            shutil.rmtree(entry.path)
                        else:
                            os.remove(entry.path)
                    except Exception:
                        pass
        except Exception:
            pass

    # Cleanup stale items at startup (best-effort). Also called at the start of each job.
    _spool_cleanup_stale()

    def _spool_check_limit(size_bytes: int) -> None:
        if size_bytes <= 0:
            return
        if size_bytes > FILEOPS_SPOOL_MAX_BYTES:
            raise RuntimeError('spool_limit_exceeded')

    @dataclass
    class FileOpJob:
        job_id: str
        op: str
        created_ts: float
        state: str = 'queued'
        rev: int = 0
        started_ts: float | None = None
        finished_ts: float | None = None
        progress: Dict[str, Any] = None  # type: ignore
        error: str | None = None
        cancel_flag: threading.Event = None  # type: ignore
        _proc: subprocess.Popen | None = None

        def to_dict(self) -> Dict[str, Any]:
            return {
                'job_id': self.job_id,
                'op': self.op,
                'state': self.state,
                'created_ts': self.created_ts,
                'started_ts': self.started_ts,
                'finished_ts': self.finished_ts,
                'progress': self.progress or {},
                'error': self.error,
            }

    class FileOpJobManager:
        def __init__(self, *, max_jobs: int = 100, ttl_seconds: int = 3600, workers: int = 1) -> None:
            self.max_jobs = max_jobs
            self.ttl_seconds = ttl_seconds
            self.workers = max(1, min(4, int(workers or 1)))
            self._lock = threading.Lock()
            self._jobs: Dict[str, FileOpJob] = {}

            # queued execution (iteration 2)
            self._queue: "queue.Queue[tuple[str, Any, Any]]" = queue.Queue()
            self._workers_started = False
            self._workers: List[threading.Thread] = []

        @staticmethod
        def _bump(job: FileOpJob) -> None:
            try:
                job.rev = int(getattr(job, 'rev', 0) or 0) + 1
            except Exception:
                pass

        def cleanup(self) -> None:
            now = _now()
            with self._lock:
                dead = [jid for jid, j in self._jobs.items() if j.finished_ts and (now - j.finished_ts) > self.ttl_seconds]
                for jid in dead:
                    self._jobs.pop(jid, None)

        def create(self, op: str) -> FileOpJob:
            self.cleanup()
            with self._lock:
                if len(self._jobs) >= self.max_jobs:
                    finished = [(jid, j.finished_ts or 0) for jid, j in self._jobs.items()]
                    finished.sort(key=lambda t: t[1])
                    for jid, _ in finished[: max(1, len(self._jobs) - self.max_jobs + 1)]:
                        self._jobs.pop(jid, None)

                jid = _gen_id('job')
                job = FileOpJob(
                    job_id=jid,
                    op=op,
                    created_ts=_now(),
                    progress={'files_done': 0, 'files_total': 0, 'bytes_done': 0, 'bytes_total': 0, 'current': None},
                    cancel_flag=threading.Event(),
                )
                self._jobs[jid] = job
                self._bump(job)
                return job

        def get(self, jid: str) -> FileOpJob | None:
            self.cleanup()
            with self._lock:
                return self._jobs.get(jid)

        def _start_workers(self) -> None:
            with self._lock:
                if self._workers_started:
                    return
                self._workers_started = True
                for i in range(self.workers):
                    t = threading.Thread(target=self._worker_loop, name=f'fileops-worker-{i}', daemon=True)
                    t.start()
                    self._workers.append(t)

        def submit(self, job: FileOpJob, runner: Any, spec: Any) -> None:
            self._start_workers()
            # keep job queued
            try:
                job.state = 'queued'
                self._bump(job)
            except Exception:
                pass
            self._queue.put((job.job_id, runner, spec))

        def cancel(self, jid: str) -> bool:
            job = self.get(jid)
            if not job:
                return False
            job.cancel_flag.set()

            # If queued, mark immediately
            if job.state == 'queued':
                job.error = None
                _job_set_state(job, 'canceled')
                job.finished_ts = _now()
                self._bump(job)
                return True

            try:
                if job._proc is not None and job.state == 'running':
                    job._proc.terminate()
            except Exception:
                pass
            self._bump(job)
            return True

        def _worker_loop(self) -> None:
            while True:
                try:
                    jid, runner, spec = self._queue.get()
                except Exception:
                    continue

                job = self.get(jid)
                if not job:
                    try:
                        self._queue.task_done()
                    except Exception:
                        pass
                    continue

                # Job was canceled while waiting in queue
                if job.cancel_flag.is_set() and job.state == 'canceled':
                    try:
                        self._queue.task_done()
                    except Exception:
                        pass
                    continue

                # If queued but cancel_flag set: mark canceled
                if job.cancel_flag.is_set() and job.state == 'queued':
                    job.state = 'canceled'
                    job.error = None
                    job.finished_ts = _now()
                    self._bump(job)
                    try:
                        self._queue.task_done()
                    except Exception:
                        pass
                    continue

                try:
                    runner(job, spec)
                except Exception:
                    if job.state not in ('done', 'error', 'canceled'):
                        job.state = 'error'
                        job.error = 'worker_error'
                        job.finished_ts = _now()
                        self._bump(job)
                finally:
                    try:
                        self._queue.task_done()
                    except Exception:
                        pass
    jobmgr = FileOpJobManager(
        max_jobs=int(os.getenv('XKEEN_FILEOPS_MAX_JOBS', '100') or '100'),
        ttl_seconds=int(os.getenv('XKEEN_FILEOPS_JOB_TTL', '3600') or '3600'),
        workers=int(os.getenv('XKEEN_FILEOPS_WORKERS', '1') or '1'),
    )


    _SENTINEL = object()

    def _job_bump(job: FileOpJob) -> None:
        try:
            job.rev = int(getattr(job, 'rev', 0) or 0) + 1
        except Exception:
            pass

    def _job_set_state(job: FileOpJob, state: str, *, error: Any = _SENTINEL) -> None:
        job.state = state
        if error is not _SENTINEL:
            # allow clearing error by passing None
            job.error = error
        _job_bump(job)

    def _progress_set(job: FileOpJob, **kw: Any) -> None:
        try:
            if job.progress is None:
                job.progress = {}
            job.progress.update(kw)
            _job_bump(job)
        except Exception:
            pass

    def _ensure_local_path_allowed(path: str) -> str:
        try:
            return _local_resolve(path, LOCALFS_ROOTS)
        except PermissionError as e:
            raise RuntimeError(str(e))

    def _remote_stat_size(sess: RemoteFsSession, rpath: str) -> int | None:
        rc, out, err = mgr._run_lftp(sess, [f"cls -ld {_lftp_quote(rpath)}"], capture=True)
        if rc != 0:
            return None
        text = out.decode('utf-8', errors='replace')
        for line in text.splitlines():
            item = _parse_ls_line(line)
            if item:
                try:
                    return int(item.get('size') or 0)
                except Exception:
                    return None
        return None

    def _remote_is_dir(sess: RemoteFsSession, rpath: str) -> bool | None:
        rc, out, err = mgr._run_lftp(sess, [f"cls -ld {_lftp_quote(rpath)}"], capture=True)
        if rc != 0:
            return None
        text = out.decode('utf-8', errors='replace')
        for line in text.splitlines():
            item = _parse_ls_line(line)
            if item:
                return item.get('type') == 'dir'
        return None

    def _remote_exists(sess: RemoteFsSession, rpath: str) -> bool:
        return _remote_is_dir(sess, rpath) is not None

    def _url_for_session_path(sess: RemoteFsSession, path: str) -> str:
        """Build a URL with embedded credentials for lftp URL-style commands.

        Used for remote→remote transfers (mirror/get -o) so lftp can initiate FXP when possible.
        Credentials never touch disk and are not logged.
        """
        p = (path or '').strip() or '/'
        if not p.startswith('/'):
            p = '/' + p
        user = _url_quote(sess.username or '', safe='')
        pwd = _url_quote(sess.password or '', safe='')
        host = sess.host
        port = int(sess.port)
        # Keep slashes in path, escape everything else
        p_enc = _url_quote(p, safe='/')
        return f"{sess.protocol}://{user}:{pwd}@{host}:{port}{p_enc}"

    def _run_lftp_raw(script: str) -> Tuple[int, bytes, bytes]:
        env = os.environ.copy()
        env.setdefault('LC_ALL', 'C')
        env.setdefault('LANG', 'C')
        p = subprocess.Popen([mgr.lftp_bin, '-c', script], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        out, err = p.communicate()
        return int(p.returncode or 0), out or b'', err or b''

    def _popen_lftp_raw(script: str) -> subprocess.Popen:
        env = os.environ.copy()
        env.setdefault('LC_ALL', 'C')
        env.setdefault('LANG', 'C')
        return subprocess.Popen([mgr.lftp_bin, '-c', script], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, bufsize=0)

    def _popen_lftp_quiet(sess: RemoteFsSession, commands: List[str]) -> subprocess.Popen:
        """Run lftp with stdout suppressed to avoid pipe buffer deadlocks.

        Useful for long-running mirror operations where we want to poll/cancel/limit spool size.
        """
        script = mgr._build_lftp_script(sess, commands)
        env = os.environ.copy()
        env.setdefault('LC_ALL', 'C')
        env.setdefault('LANG', 'C')
        return subprocess.Popen([mgr.lftp_bin, '-c', script], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, env=env, bufsize=0)

    def _terminate_proc(proc: subprocess.Popen) -> None:
        try:
            proc.terminate()
        except Exception:
            pass
        time.sleep(0.2)
        try:
            if proc.poll() is None:
                proc.kill()
        except Exception:
            pass

    def _build_lftp_url_script(src_sess: RemoteFsSession, dst_sess: RemoteFsSession, commands: List[str]) -> str:
        # Conservative settings for router usage
        timeout = max(int(src_sess.options.get('timeout_sec', 10) or 10), int(dst_sess.options.get('timeout_sec', 10) or 10))

        def _mode(sess: RemoteFsSession) -> str:
            m = str(sess.options.get('tls_verify_mode') or 'none').strip().lower()
            return m if m in _TLS_VERIFY_MODES else 'none'

        m1 = _mode(src_sess)
        m2 = _mode(dst_sess)
        tls_verify = (m1 != 'none') and (m2 != 'none')
        strict_host = (m1 == 'strict') and (m2 == 'strict')
        ca_file = src_sess.options.get('tls_ca_file') or dst_sess.options.get('tls_ca_file')

        parts = [
            'set cmd:fail-exit yes',
            'set cmd:interactive false',
            f'set net:timeout {timeout}',
            'set net:max-retries 1',
            'set net:persist-retries 0',
        ]
        # Enable FXP for FTP/FTPS pairs (lftp will fallback to client-side copy if FXP is not possible).
        parts.append(f"set ftp:use-fxp {'yes' if FILEOPS_FXP_ENABLED else 'no'}")
        # TLS verification settings for FTPS URLs
        parts.append(f"set ssl:verify-certificate {'yes' if tls_verify else 'no'}")
        parts.append(f"set ssl:check-hostname {'yes' if strict_host else 'no'}")
        if ca_file:
            parts.append(f"set ssl:ca-file {_lftp_quote(str(ca_file))}")
        parts.extend(commands)
        parts.append('bye')
        return '; '.join(parts)

    def _run_job_copy_move(job: FileOpJob, spec: Dict[str, Any]) -> None:
        # spec is validated at API layer; this function runs in background.
        _job_set_state(job, 'running')
        job.started_ts = _now()

        # --- local helpers for safety ---
        def _same_local(a: str, b: str) -> bool:
            """Best-effort check whether two local paths point to the same inode."""
            try:
                if os.path.exists(a) and os.path.exists(b):
                    return os.path.samefile(a, b)
            except Exception:
                pass
            try:
                return os.path.realpath(a) == os.path.realpath(b)
            except Exception:
                return False

        def _next_copy_path_local(dst_path: str) -> str:
            """Return a non-existing path for duplicating a file/dir in the same folder.

            Example: file.bin -> file (2).bin -> file (3).bin
            """
            ddir = os.path.dirname(dst_path) or '.'
            base = os.path.basename(dst_path)
            # split ext for files; dirs keep ext=''
            stem, ext = os.path.splitext(base)
            # If stem already ends with " (N)", strip it before adding a new one.
            m = re.match(r"^(.*)\s\((\d+)\)$", stem)
            if m:
                stem = m.group(1)
            for i in range(2, 10000):
                cand = os.path.join(ddir, f"{stem} ({i}){ext}")
                if not os.path.exists(cand):
                    return cand
            raise RuntimeError('dst_name_exhausted')

        # Best-effort cleanup of stale spool items left after crashes.
        # (This runs quickly if the directory is empty.)
        try:
            _spool_cleanup_stale()
        except Exception:
            pass

        src = spec['src']
        dst = spec['dst']
        opts = spec.get('options') or {}
        overwrite = str(opts.get('overwrite', 'replace') or 'replace').strip().lower()
        if overwrite not in ('replace', 'skip', 'ask'):
            overwrite = 'replace'
        decisions = opts.get('decisions') if isinstance(opts.get('decisions'), dict) else {}
        default_action = str(opts.get('default_action') or opts.get('overwrite_default') or '').strip().lower() or None
        if default_action not in (None, 'replace', 'skip'):
            default_action = None

        src_target = src['target']
        dst_target = dst['target']

        # normalized list of source entries: [{'path':..., 'name':..., 'is_dir':bool}]
        sources = spec['sources']
        _progress_set(job, files_total=len(sources), files_done=0, bytes_done=0, bytes_total=spec.get('bytes_total') or 0)

        def mark_done():
            _progress_set(job, files_done=(job.progress.get('files_done', 0) or 0) + 1)

        def _decide_overwrite_action(*, spath: str, sname: str, dpath: str) -> str:
            """Return 'replace' or 'skip' when destination exists."""
            if overwrite in ('replace', 'skip'):
                return overwrite
            # overwrite == 'ask'
            action = None
            try:
                if isinstance(decisions, dict):
                    action = decisions.get(spath) or decisions.get(dpath) or decisions.get(sname)
            except Exception:
                action = None
            if not action and default_action:
                action = default_action
            action_s = str(action or '').strip().lower()
            if action_s not in ('replace', 'skip'):
                raise RuntimeError('conflict_needs_decision')
            return action_s

        try:
            for ent in sources:
                if job.cancel_flag.is_set():
                    raise RuntimeError('canceled')
                spath = ent['path']
                sname = ent['name']
                is_dir = bool(ent.get('is_dir'))
                _progress_set(job, current={'path': spath, 'name': sname, 'phase': 'copy', 'is_dir': is_dir})

                # determine destination path (TC-like): if destination is treated as a directory, create it if missing.
                dst_path = dst['path']
                dst_is_dir = bool(dst.get('is_dir')) or dst_path.endswith('/') or len(sources) > 1
                if dst_is_dir:
                    if dst_target == 'local':
                        ddir = _ensure_local_path_allowed(dst_path)
                        try:
                            os.makedirs(ddir, exist_ok=True)
                        except Exception:
                            raise RuntimeError('dst_not_dir')
                        dpath = os.path.join(ddir, sname)
                    else:
                        ddir = dst_path.rstrip('/')
                        if not ddir:
                            ddir = '/'
                        # best-effort create directory on remote
                        ds0 = mgr.get(dst.get('sid'))
                        if not ds0:
                            raise RuntimeError('session_not_found')
                        if ddir != '/':
                            mgr._run_lftp(ds0, [f"mkdir -p {_lftp_quote(ddir)}"], capture=True)
                        dpath = (ddir.rstrip('/') + '/' + sname) if ddir != '/' else ('/' + sname)
                else:
                    dpath = dst_path
                    # ensure parent exists
                    if dst_target == 'local':
                        dp0 = _ensure_local_path_allowed(dpath)
                        os.makedirs(os.path.dirname(dp0) or '/tmp', exist_ok=True)
                        dpath = dp0
                    else:
                        ds0 = mgr.get(dst.get('sid'))
                        if not ds0:
                            raise RuntimeError('session_not_found')
                        parent = os.path.dirname(dpath.rstrip('/'))
                        if parent and parent not in ('', '.'):
                            mgr._run_lftp(ds0, [f"mkdir -p {_lftp_quote(parent)}"], capture=True)

                # --- same-target fast path for move ---
                if job.op == 'move' and src_target == dst_target:
                    if src_target == 'local':
                        sp = _ensure_local_path_allowed(spath)
                        dp = _ensure_local_path_allowed(dpath)

                        # Moving onto itself is a no-op; never delete the source.
                        if _same_local(sp, dp):
                            mark_done();
                            continue

                        if os.path.exists(dp):
                            action = _decide_overwrite_action(spath=sp, sname=sname, dpath=dp)
                            if action == 'skip':
                                mark_done();
                                continue
                            try:
                                if os.path.isdir(dp):
                                    shutil.rmtree(dp)
                                else:
                                    os.remove(dp)
                            except Exception:
                                pass
                        # shutil.move uses os.rename when possible, but also supports cross-device moves (EXDEV)
                        shutil.move(sp, dp)
                        mark_done();
                        continue
                    if src_target == 'remote':
                        ss = mgr.get(src['sid'])
                        if not ss:
                            raise RuntimeError('session_not_found')

                        # Remote move onto itself is a no-op.
                        if str(spath) == str(dpath):
                            mark_done();
                            continue

                        if _remote_exists(ss, dpath):
                            action = _decide_overwrite_action(spath=str(spath), sname=str(sname), dpath=str(dpath))
                            if action == 'skip':
                                mark_done();
                                continue
                            mgr._run_lftp(ss, [f"rm -r {_lftp_quote(dpath)}"], capture=True)
                        rc, out, err = mgr._run_lftp(ss, [f"mv {_lftp_quote(spath)} {_lftp_quote(dpath)}"], capture=True)
                        if rc != 0:
                            raise RuntimeError('remote_move_failed')
                        mark_done();
                        continue

                # --- copy routes ---
                if src_target == 'remote' and dst_target == 'local':
                    ss = mgr.get(src['sid'])
                    if not ss:
                        raise RuntimeError('session_not_found')
                    dp = _ensure_local_path_allowed(dpath)
                    # overwrite policy
                    if os.path.exists(dp):
                        action = _decide_overwrite_action(spath=str(spath), sname=str(sname), dpath=str(dp))
                        if action == 'skip':
                            mark_done();
                            continue
                        try:
                            if os.path.isdir(dp):
                                shutil.rmtree(dp)
                            else:
                                os.remove(dp)
                        except Exception:
                            pass
                    # directory: mirror; file: cat stream
                    if is_dir:
                        os.makedirs(dp, exist_ok=True)
                        cmd = f"mirror --verbose -- {_lftp_quote(spath)} {_lftp_quote(dp)}"
                        proc = mgr._popen_lftp(ss, [cmd])
                        job._proc = proc
                        out, err = proc.communicate()
                        if proc.returncode != 0:
                            raise RuntimeError('mirror_failed')
                        mark_done();
                    else:
                        os.makedirs(os.path.dirname(dp) or '/tmp', exist_ok=True)
                        tmp = dp + '.part.' + uuid.uuid4().hex[:6]
                        size_total = _remote_stat_size(ss, spath) or 0
                        # update bytes_total incrementally
                        if (job.progress.get('bytes_total', 0) or 0) == 0 and size_total:
                            _progress_set(job, bytes_total=int(size_total))
                        proc = mgr._popen_lftp(ss, [f"cat {_lftp_quote(spath)}"])
                        job._proc = proc
                        stdout = proc.stdout
                        stderr = proc.stderr
                        done = 0
                        try:
                            with open(tmp, 'wb') as fp:
                                while True:
                                    if job.cancel_flag.is_set():
                                        raise RuntimeError('canceled')
                                    chunk = stdout.read(64*1024) if stdout else b''
                                    if not chunk:
                                        break
                                    fp.write(chunk)
                                    done += len(chunk)
                                    _progress_set(job, bytes_done=(job.progress.get('bytes_done', 0) or 0) + len(chunk))
                            rc = proc.wait()
                            if rc != 0:
                                raise RuntimeError('download_failed')
                            os.rename(tmp, dp)
                        finally:
                            try:
                                if stdout: stdout.close()
                            except Exception:
                                pass
                            try:
                                if stderr: stderr.close()
                            except Exception:
                                pass
                            try:
                                if os.path.exists(tmp):
                                    os.remove(tmp)
                            except Exception:
                                pass
                        mark_done();

                elif src_target == 'local' and dst_target == 'remote':
                    ds = mgr.get(dst['sid'])
                    if not ds:
                        raise RuntimeError('session_not_found')
                    sp = _ensure_local_path_allowed(spath)
                    if is_dir:
                        # mirror -R local_dir -> remote_dir
                        cmd = f"mirror -R --verbose -- {_lftp_quote(sp)} {_lftp_quote(dpath)}"
                        proc = mgr._popen_lftp(ds, [cmd])
                        job._proc = proc
                        out, err = proc.communicate()
                        if proc.returncode != 0:
                            raise RuntimeError('mirror_failed')
                        mark_done();
                    else:
                        try:
                            st = os.stat(sp)
                            size_total = int(st.st_size or 0)
                        except Exception:
                            size_total = 0
                        if (job.progress.get('bytes_total', 0) or 0) == 0 and size_total:
                            _progress_set(job, bytes_total=int(size_total))
                        # overwrite policy (best-effort)
                        if _remote_exists(ds, dpath):
                            action = _decide_overwrite_action(spath=str(spath), sname=str(sname), dpath=str(dpath))
                            if action == 'skip':
                                mark_done();
                                continue
                            mgr._run_lftp(ds, [f"rm -r {_lftp_quote(dpath)}"], capture=True)
                        proc = mgr._popen_lftp(ds, [f"put {_lftp_quote(sp)} -o {_lftp_quote(dpath)}"])
                        job._proc = proc
                        out, err = proc.communicate()
                        if proc.returncode != 0:
                            raise RuntimeError('upload_failed')
                        # No reliable per-byte progress here without parsing; mark done at end.
                        _progress_set(job, bytes_done=(job.progress.get('bytes_done', 0) or 0) + size_total)
                        mark_done();

                elif src_target == 'local' and dst_target == 'local':
                    sp = _ensure_local_path_allowed(spath)
                    dp = _ensure_local_path_allowed(dpath)

                    # COPY onto itself is a common UX case when both panels point to the same dir.
                    # Never delete the source; instead, auto-pick a free "(2)/(3)…" name.
                    if _same_local(sp, dp):
                        dp = _next_copy_path_local(dp)

                    if os.path.exists(dp):
                        action = _decide_overwrite_action(spath=str(spath), sname=str(sname), dpath=str(dp))
                        if action == 'skip':
                            mark_done();
                            continue
                        try:
                            if os.path.isdir(dp):
                                shutil.rmtree(dp)
                            else:
                                os.remove(dp)
                        except Exception:
                            pass
                    if is_dir:
                        shutil.copytree(sp, dp, dirs_exist_ok=True)
                        mark_done();
                    else:
                        os.makedirs(os.path.dirname(dp) or '/tmp', exist_ok=True)
                        size_total = 0
                        try:
                            size_total = os.stat(sp).st_size
                        except Exception:
                            pass
                        if (job.progress.get('bytes_total', 0) or 0) == 0 and size_total:
                            _progress_set(job, bytes_total=int(size_total or 0))
                        with open(sp, 'rb') as r, open(dp + '.part.' + uuid.uuid4().hex[:6], 'wb') as w:
                            tmp = w.name
                            while True:
                                if job.cancel_flag.is_set():
                                    raise RuntimeError('canceled')
                                chunk = r.read(64*1024)
                                if not chunk:
                                    break
                                w.write(chunk)
                                _progress_set(job, bytes_done=(job.progress.get('bytes_done', 0) or 0) + len(chunk))
                        os.rename(tmp, dp)
                        try:
                            if os.path.exists(tmp):
                                os.remove(tmp)
                        except Exception:
                            pass
                        mark_done();

                elif src_target == 'remote' and dst_target == 'remote':
                    ss = mgr.get(src['sid'])
                    ds = mgr.get(dst['sid'])
                    if not ss or not ds:
                        raise RuntimeError('session_not_found')

                    # COPY onto itself on the same remote session could otherwise delete the source
                    # when overwrite=replace (we remove destination first). Auto-pick a free name.
                    if job.op == 'copy' and src.get('sid') == dst.get('sid') and str(spath) == str(dpath):
                        base = os.path.basename(str(dpath).rstrip('/'))
                        parent = os.path.dirname(str(dpath).rstrip('/')) or '/'
                        stem, ext = os.path.splitext(base)
                        m = re.match(r"^(.*)\s\((\d+)\)$", stem)
                        if m:
                            stem = m.group(1)
                        picked = None
                        for i in range(2, 10000):
                            nm = f"{stem} ({i}){ext}"
                            cand = (parent.rstrip('/') + '/' + nm) if parent != '/' else ('/' + nm)
                            if not _remote_exists(ds, cand):
                                picked = cand
                                break
                        if picked:
                            dpath = picked

                    # overwrite policy on destination
                    if _remote_exists(ds, dpath):
                        action = _decide_overwrite_action(spath=str(spath), sname=str(sname), dpath=str(dpath))
                        if action == 'skip':
                            mark_done();
                            continue
                        # best-effort remove
                        mgr._run_lftp(ds, [f"rm -r {_lftp_quote(dpath)}"], capture=True)

                    if not is_dir:
                        # First try server-side copy if same session.
                        if src.get('sid') == dst.get('sid'):
                            rc, out, err = mgr._run_lftp(ss, [f"cp {_lftp_quote(spath)} {_lftp_quote(dpath)}"], capture=True)
                            if rc == 0:
                                # No bytes streamed; still advance progress to keep UI consistent.
                                sz = _remote_stat_size(ss, spath) or 0
                                if sz:
                                    _progress_set(job, bytes_done=(job.progress.get('bytes_done', 0) or 0) + int(sz))
                                mark_done();
                                continue

                        # For FTP/FTPS pairs try lftp URL-form copy first (FXP when possible).
                        if FILEOPS_REMOTE2REMOTE_DIRECT and ss.protocol in ('ftp', 'ftps') and ds.protocol in ('ftp', 'ftps'):
                            try:
                                src_url = _url_for_session_path(ss, spath)
                                dst_url = _url_for_session_path(ds, dpath)
                                _progress_set(job, current={'path': spath, 'name': sname, 'phase': 'fxp', 'is_dir': False})
                                script = _build_lftp_url_script(ss, ds, [f"get {_lftp_quote(src_url)} -o {_lftp_quote(dst_url)}"])
                                proc = _popen_lftp_raw(script)
                                job._proc = proc
                                try:
                                    while proc.poll() is None:
                                        if job.cancel_flag.is_set():
                                            try:
                                                proc.terminate()
                                            except Exception:
                                                pass
                                            time.sleep(0.2)
                                            try:
                                                if proc.poll() is None:
                                                    proc.kill()
                                            except Exception:
                                                pass
                                            raise RuntimeError('canceled')
                                        time.sleep(0.2)
                                    out, err = proc.communicate()
                                    if proc.returncode == 0:
                                        sz = _remote_stat_size(ss, spath) or 0
                                        if sz:
                                            _progress_set(job, bytes_done=(job.progress.get('bytes_done', 0) or 0) + int(sz))
                                        mark_done();
                                        continue
                                finally:
                                    job._proc = None
                            except RuntimeError:
                                raise
                            except Exception:
                                # fall back to spooling route; clean up possible partial dest
                                try:
                                    mgr._run_lftp(ds, [f"rm -r {_lftp_quote(dpath)}"], capture=True)
                                except Exception:
                                    pass
                                pass

                        # Fallback: spool to local tmp then upload.
                        base_usage = 0
                        if FILEOPS_SPOOL_MAX_BYTES:
                            # account for existing spool usage (other jobs/leftovers)
                            base_usage = _dir_size_bytes(_SPOOL_BASE, stop_after=FILEOPS_SPOOL_MAX_BYTES + 1)
                        size_total = _remote_stat_size(ss, spath) or 0
                        if FILEOPS_SPOOL_MAX_BYTES and size_total:
                            _spool_check_limit(int(base_usage + int(size_total)))
                        tmp = _spool_tmp_file(ext='bin')
                        try:
                            _progress_set(job, current={'path': spath, 'name': sname, 'phase': 'download', 'is_dir': False})
                            done = 0
                            proc = mgr._popen_lftp(ss, [f"cat {_lftp_quote(spath)}"])
                            job._proc = proc
                            stdout = proc.stdout
                            stderr = proc.stderr
                            try:
                                with open(tmp, 'wb') as fp:
                                    while True:
                                        if job.cancel_flag.is_set():
                                            raise RuntimeError('canceled')
                                        chunk = stdout.read(64*1024) if stdout else b''
                                        if not chunk:
                                            break
                                        fp.write(chunk)
                                        done += len(chunk)
                                        if FILEOPS_SPOOL_MAX_BYTES and (base_usage + done) > FILEOPS_SPOOL_MAX_BYTES:
                                            try:
                                                _terminate_proc(proc)
                                            except Exception:
                                                pass
                                            raise RuntimeError('spool_limit_exceeded')
                                        _progress_set(job, bytes_done=(job.progress.get('bytes_done', 0) or 0) + len(chunk))
                                rc = proc.wait()
                                if rc != 0:
                                    raise RuntimeError('download_failed')
                            finally:
                                try:
                                    if stdout:
                                        stdout.close()
                                except Exception:
                                    pass
                                try:
                                    if stderr:
                                        stderr.close()
                                except Exception:
                                    pass
                                job._proc = None

                            _progress_set(job, current={'path': spath, 'name': sname, 'phase': 'upload', 'is_dir': False})
                            proc2 = mgr._popen_lftp(ds, [f"put {_lftp_quote(tmp)} -o {_lftp_quote(dpath)}"])
                            job._proc = proc2
                            try:
                                out, err = proc2.communicate()
                                if proc2.returncode != 0:
                                    raise RuntimeError('upload_failed')
                            finally:
                                job._proc = None
                        finally:
                            try:
                                if os.path.exists(tmp):
                                    os.remove(tmp)
                            except Exception:
                                pass
                        mark_done();

                    else:
                        # For FTP/FTPS pairs try lftp URL-form mirror first (FXP when possible).
                        if FILEOPS_REMOTE2REMOTE_DIRECT and ss.protocol in ('ftp', 'ftps') and ds.protocol in ('ftp', 'ftps'):
                            try:
                                src_url = _url_for_session_path(ss, spath)
                                dst_url = _url_for_session_path(ds, dpath)
                                _progress_set(job, current={'path': spath, 'name': sname, 'phase': 'fxp', 'is_dir': True})
                                script = _build_lftp_url_script(ss, ds, [f"mirror --verbose -- {_lftp_quote(src_url)} {_lftp_quote(dst_url)}"])
                                proc = _popen_lftp_raw(script)
                                job._proc = proc
                                try:
                                    while proc.poll() is None:
                                        if job.cancel_flag.is_set():
                                            try:
                                                proc.terminate()
                                            except Exception:
                                                pass
                                            time.sleep(0.2)
                                            try:
                                                if proc.poll() is None:
                                                    proc.kill()
                                            except Exception:
                                                pass
                                            raise RuntimeError('canceled')
                                        time.sleep(0.2)
                                    out, err = proc.communicate()
                                    if proc.returncode == 0:
                                        mark_done();
                                        continue
                                finally:
                                    job._proc = None
                            except RuntimeError:
                                raise
                            except Exception:
                                # fall back to spooling route; clean up possible partial dest
                                try:
                                    mgr._run_lftp(ds, [f"rm -r {_lftp_quote(dpath)}"], capture=True)
                                except Exception:
                                    pass
                                pass

                        # Directory copy fallback: mirror down to spool dir then mirror -R up.
                        tmpd = _spool_tmp_dir()
                        try:
                            _progress_set(job, current={'path': spath, 'name': sname, 'phase': 'download', 'is_dir': True})
                            base_usage = 0
                            if FILEOPS_SPOOL_MAX_BYTES:
                                base_usage = _dir_size_bytes(_SPOOL_BASE, stop_after=FILEOPS_SPOOL_MAX_BYTES + 1)
                                if base_usage >= FILEOPS_SPOOL_MAX_BYTES:
                                    raise RuntimeError('spool_limit_exceeded')
                            remaining = max(0, FILEOPS_SPOOL_MAX_BYTES - base_usage) if FILEOPS_SPOOL_MAX_BYTES else 0
                            last_sz = 0

                            proc1 = _popen_lftp_quiet(ss, [f"mirror -- {_lftp_quote(spath)} {_lftp_quote(tmpd)}"])
                            job._proc = proc1
                            try:
                                while proc1.poll() is None:
                                    if job.cancel_flag.is_set():
                                        _terminate_proc(proc1)
                                        raise RuntimeError('canceled')

                                    if FILEOPS_SPOOL_MAX_BYTES:
                                        sz = _dir_size_bytes(tmpd, stop_after=remaining + 1)
                                        if sz > remaining:
                                            _terminate_proc(proc1)
                                            raise RuntimeError('spool_limit_exceeded')
                                        if sz > last_sz:
                                            _progress_set(job, bytes_done=(job.progress.get('bytes_done', 0) or 0) + int(sz - last_sz))
                                            last_sz = sz

                                    time.sleep(0.5)

                                # Drain stderr to avoid leaving pipes open
                                try:
                                    if proc1.stderr:
                                        proc1.stderr.read()
                                except Exception:
                                    pass

                                if proc1.returncode != 0:
                                    raise RuntimeError('mirror_failed')
                            finally:
                                try:
                                    if proc1.stderr:
                                        proc1.stderr.close()
                                except Exception:
                                    pass
                                job._proc = None

                            _progress_set(job, current={'path': spath, 'name': sname, 'phase': 'upload', 'is_dir': True})
                            proc2 = _popen_lftp_quiet(ds, [f"mirror -R -- {_lftp_quote(tmpd)} {_lftp_quote(dpath)}"])
                            job._proc = proc2
                            try:
                                while proc2.poll() is None:
                                    if job.cancel_flag.is_set():
                                        _terminate_proc(proc2)
                                        raise RuntimeError('canceled')
                                    time.sleep(0.5)
                                try:
                                    if proc2.stderr:
                                        proc2.stderr.read()
                                except Exception:
                                    pass
                                if proc2.returncode != 0:
                                    raise RuntimeError('mirror_failed')
                            finally:
                                try:
                                    if proc2.stderr:
                                        proc2.stderr.close()
                                except Exception:
                                    pass
                                job._proc = None
                        finally:
                            job._proc = None
                            try:
                                shutil.rmtree(tmpd)
                            except Exception:
                                pass
                        mark_done();

                else:
                    raise RuntimeError('route_not_supported')

                # If move across targets (or across different remote sessions): delete source after copy
                if job.op == 'move' and (src_target != dst_target or (src_target == 'remote' and src.get('sid') != dst.get('sid'))):
                    if src_target == 'local':
                        sp = _ensure_local_path_allowed(spath)
                        try:
                            if os.path.isdir(sp):
                                shutil.rmtree(sp)
                            else:
                                os.remove(sp)
                        except Exception:
                            pass
                    else:
                        ss = mgr.get(src['sid'])
                        if ss:
                            mgr._run_lftp(ss, [f"rm -r {_lftp_quote(spath)}"], capture=True)

            _job_set_state(job, 'done')
            job.finished_ts = _now()
            job._proc = None
        except RuntimeError as e:
            if str(e) == 'canceled' or job.cancel_flag.is_set():
                _job_set_state(job, 'canceled', error=None)
            else:
                _job_set_state(job, 'error', error=str(e))
            job.finished_ts = _now()
            try:
                if job._proc is not None:
                    job._proc.terminate()
            except Exception:
                pass
            job._proc = None
        except Exception as e:
            _job_set_state(job, 'error', error='unexpected_error')
            job.finished_ts = _now()
            try:
                if job._proc is not None:
                    job._proc.terminate()
            except Exception:
                pass
            job._proc = None


    def _run_job_delete(job: FileOpJob, spec: Dict[str, Any]) -> None:
        # spec validated at API layer; runs in background.
        _job_set_state(job, 'running')
        job.started_ts = _now()

        src = spec['src']
        sources = spec['sources']
        src_target = src['target']

        _progress_set(job, files_total=len(sources), files_done=0, bytes_done=0, bytes_total=0)

        def mark_done():
            _progress_set(job, files_done=(job.progress.get('files_done', 0) or 0) + 1)

        try:
            for ent in sources:
                if job.cancel_flag.is_set():
                    raise RuntimeError('canceled')

                spath = ent['path']
                sname = ent.get('name') or ''
                is_dir = bool(ent.get('is_dir'))

                _progress_set(job, current={'path': spath, 'name': sname, 'phase': 'delete', 'is_dir': is_dir})

                if src_target == 'local':
                    sp = _ensure_local_path_allowed(spath)
                    try:
                        if os.path.isdir(sp):
                            shutil.rmtree(sp)
                        else:
                            os.remove(sp)
                    except FileNotFoundError:
                        pass
                    except Exception:
                        pass
                    mark_done();
                else:
                    ss = mgr.get(src['sid'])
                    if not ss:
                        raise RuntimeError('session_not_found')
                    # best-effort remote delete
                    if is_dir:
                        mgr._run_lftp(ss, [f"rm -r {_lftp_quote(spath)}"], capture=True)
                    else:
                        mgr._run_lftp(ss, [f"rm {_lftp_quote(spath)}"], capture=True)
                    mark_done();

            _job_set_state(job, 'done')
            job.finished_ts = _now()
            job._proc = None

        except RuntimeError as e:
            if str(e) == 'canceled' or job.cancel_flag.is_set():
                _job_set_state(job, 'canceled', error=None)
            else:
                _job_set_state(job, 'error', error=str(e))
            job.finished_ts = _now()
            try:
                if job._proc is not None:
                    job._proc.terminate()
            except Exception:
                pass
            job._proc = None

        except Exception:
            _job_set_state(job, 'error', error='unexpected_error')
            job.finished_ts = _now()
            try:
                if job._proc is not None:
                    job._proc.terminate()
            except Exception:
                pass
            job._proc = None


    def _normalize_sources(spec: Dict[str, Any]) -> None:
        # Mutates spec: adds spec['sources'] and spec['bytes_total']
        src = spec.get('src') or {}
        dst = spec.get('dst') or {}
        if not isinstance(src, dict) or not isinstance(dst, dict):
            raise RuntimeError('bad_request')
        src_target = str(src.get('target') or '').strip().lower()
        dst_target = str(dst.get('target') or '').strip().lower()
        if src_target not in ('local', 'remote') or dst_target not in ('local', 'remote'):
            raise RuntimeError('bad_target')
        src['target'] = src_target
        dst['target'] = dst_target

        # remote sessions
        if src_target == 'remote':
            sid = str(src.get('sid') or '').strip()
            if not sid:
                raise RuntimeError('sid_required')
            src['sid'] = sid
        if dst_target == 'remote':
            sid = str(dst.get('sid') or '').strip()
            if not sid:
                raise RuntimeError('sid_required')
            dst['sid'] = sid

        # sources list
        sources: List[Dict[str, Any]] = []
        if isinstance(src.get('paths'), list):
            cwd = str(src.get('cwd') or '').strip() or ''
            for n in src.get('paths'):
                nm = str(n or '').strip()
                if not nm:
                    continue
                full = (cwd.rstrip('/') + '/' + nm) if (src_target == 'remote') else os.path.join(cwd or '', nm)
                sources.append({'path': full, 'name': os.path.basename(nm.rstrip('/')) or nm, 'is_dir': nm.endswith('/')})
        else:
            spath = str(src.get('path') or '').strip()
            if not spath:
                raise RuntimeError('path_required')
            sources.append({'path': spath, 'name': os.path.basename(spath.rstrip('/')) or spath, 'is_dir': spath.endswith('/')})

        if not sources:
            raise RuntimeError('no_sources')

        # dst path
        dpath = str(dst.get('path') or '').strip()
        if not dpath:
            raise RuntimeError('path_required')
        dst['path'] = dpath

        # Determine is_dir flags if not explicit
        dst_is_dir_explicit = bool(dst.get('is_dir'))
        dst_is_dir = dst_is_dir_explicit or dpath.endswith('/') or len(sources) > 1

        # If not explicitly a directory destination, but the destination exists and is a directory,
        # treat it as a directory destination (TC-like behavior).
        if not dst_is_dir and not dst_is_dir_explicit:
            try:
                if dst_target == 'local':
                    rp = _ensure_local_path_allowed(dpath)
                    if os.path.isdir(rp):
                        dst_is_dir = True
                else:
                    ds = mgr.get(dst.get('sid'))
                    if not ds:
                        raise RuntimeError('session_not_found')
                    if _remote_is_dir(ds, dpath) is True:
                        dst_is_dir = True
            except PermissionError:
                raise
            except RuntimeError:
                raise
            except Exception:
                pass

        dst['is_dir'] = dst_is_dir

        # Enrich source is_dir where possible
        bytes_total = 0
        if src_target == 'local':
            for ent in sources:
                rp = _ensure_local_path_allowed(ent['path'])
                ent['path'] = rp
                try:
                    st = os.lstat(rp)
                    ent['is_dir'] = os.path.isdir(rp)
                    if os.path.isfile(rp):
                        bytes_total += int(st.st_size or 0)
                except Exception:
                    pass
        else:
            ss = mgr.get(src['sid'])
            if not ss:
                raise RuntimeError('session_not_found')
            for ent in sources:
                rpath = ent['path']
                is_dir = _remote_is_dir(ss, rpath)
                if is_dir is True:
                    ent['is_dir'] = True
                elif is_dir is False:
                    ent['is_dir'] = False
                    sz = _remote_stat_size(ss, rpath)
                    if sz:
                        bytes_total += int(sz)
                # if None: leave as-is

        spec['src'] = src
        spec['dst'] = dst
        spec['sources'] = sources
        spec['bytes_total'] = bytes_total


    def _compute_dst_path_for_entry(dst: Dict[str, Any], dst_target: str, sources: List[Dict[str, Any]], ent: Dict[str, Any]) -> str:
        """Compute destination path for a given source entry.

        Does not create anything; just returns the resolved path string.
        """
        dst_path = str(dst.get('path') or '')
        sname = str(ent.get('name') or '')
        dst_is_dir = bool(dst.get('is_dir'))
        if dst_is_dir or dst_path.endswith('/') or len(sources) > 1:
            if dst_target == 'local':
                ddir = _ensure_local_path_allowed(dst_path)
                return os.path.join(ddir, sname)
            ddir = dst_path.rstrip('/')
            if not ddir:
                ddir = '/'
            return (ddir.rstrip('/') + '/' + sname) if ddir != '/' else ('/' + sname)
        return dst_path


    def _compute_copy_move_conflicts(spec: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Return a list of conflicting entries for copy/move (destination exists)."""
        src = spec.get('src') or {}
        dst = spec.get('dst') or {}
        sources = spec.get('sources') or []
        if not isinstance(src, dict) or not isinstance(dst, dict) or not isinstance(sources, list):
            return []
        src_target = src.get('target')
        dst_target = dst.get('target')

        ds = None
        if dst_target == 'remote':
            ds = mgr.get(dst.get('sid'))

        conflicts: List[Dict[str, Any]] = []
        for ent in sources:
            try:
                dpath = _compute_dst_path_for_entry(dst, dst_target, sources, ent)
            except Exception:
                continue
            exists = False
            try:
                if dst_target == 'local':
                    dp = _ensure_local_path_allowed(dpath)
                    exists = os.path.exists(dp)
                    dpath_resolved = dp
                else:
                    if not ds:
                        raise RuntimeError('session_not_found')
                    exists = bool(_remote_exists(ds, dpath))
                    dpath_resolved = dpath
            except Exception:
                dpath_resolved = dpath
                exists = False

            if exists:
                conflicts.append({
                    'kind': 'exists',
                    'src_path': ent.get('path'),
                    'src_name': ent.get('name'),
                    'dst_path': dpath_resolved,
                    'is_dir': bool(ent.get('is_dir')),
                })
        return conflicts

    def _normalize_delete(spec: Dict[str, Any]) -> None:
        # Mutates spec: adds spec['sources']
        src = spec.get('src') or {}
        if not isinstance(src, dict):
            raise RuntimeError('bad_request')

        src_target = str(src.get('target') or '').strip().lower()
        if src_target not in ('local', 'remote'):
            raise RuntimeError('bad_target')
        src['target'] = src_target

        if src_target == 'remote':
            sid = str(src.get('sid') or '').strip()
            if not sid:
                raise RuntimeError('sid_required')
            src['sid'] = sid

        # sources list
        sources = []
        if isinstance(src.get('paths'), list):
            cwd = str(src.get('cwd') or '').strip() or ''
            for n in src.get('paths'):
                nm = str(n or '').strip()
                if not nm:
                    continue
                full = (cwd.rstrip('/') + '/' + nm) if (src_target == 'remote') else os.path.join(cwd or '', nm)
                sources.append({'path': full, 'name': os.path.basename(nm.rstrip('/')) or nm, 'is_dir': nm.endswith('/')})
        else:
            spath = str(src.get('path') or '').strip()
            if not spath:
                raise RuntimeError('path_required')
            sources.append({'path': spath, 'name': os.path.basename(spath.rstrip('/')) or spath, 'is_dir': spath.endswith('/')})

        if not sources:
            raise RuntimeError('no_sources')

        # Enrich is_dir where possible
        if src_target == 'local':
            for ent in sources:
                rp = _ensure_local_path_allowed(ent['path'])
                ent['path'] = rp
                try:
                    ent['is_dir'] = os.path.isdir(rp)
                except Exception:
                    pass
        else:
            ss = mgr.get(src['sid'])
            if not ss:
                raise RuntimeError('session_not_found')
            for ent in sources:
                rpath = ent['path']
                is_dir = _remote_is_dir(ss, rpath)
                if is_dir is True:
                    ent['is_dir'] = True
                elif is_dir is False:
                    ent['is_dir'] = False

        spec['src'] = src
        spec['sources'] = sources


    @bp.get('/api/fs/list')
    def api_fs_list() -> Any:
        if (resp := _require_enabled()) is not None:
            return resp
        target = str(request.args.get('target', '') or '').strip().lower()
        if target not in ('local', 'remote'):
            return error_response('bad_target', 400, ok=False)

        if target == 'local':
            path = request.args.get('path', '')
            try:
                rp = _local_resolve(path, LOCALFS_ROOTS)
            except PermissionError as e:
                return error_response(str(e), 403, ok=False)
            if not os.path.isdir(rp):
                return error_response('not_a_directory', 400, ok=False)
            # Special UX for Keenetic mounts: /tmp/mnt contains both
            #  - real mountpoint folders (often UUID-like)
            #  - symlinks with user-friendly volume labels pointing to them
            # In the UI we want to show labels, not raw UUID folders.
            is_tmp_mnt_root = os.path.normpath(rp) == '/tmp/mnt'

            def _looks_like_uuid(name: str) -> bool:
                try:
                    n = str(name or '')
                    # Canonical UUID with dashes
                    if re.match(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', n):
                        return True
                    # Some systems may expose long hex-only mount ids
                    if re.match(r'^[0-9a-fA-F]{24,}$', n):
                        return True
                except Exception:
                    return False
                return False

            items_all: List[Dict[str, Any]] = []
            mnt_uuid_dirs: List[Dict[str, Any]] = []
            disk_labels: List[Dict[str, Any]] = []
            try:
                with os.scandir(rp) as it:
                    for entry in it:
                        try:
                            st = entry.stat(follow_symlinks=False)
                            is_link = entry.is_symlink()
                            is_dir = entry.is_dir(follow_symlinks=False)
                            link_dir = False
                            if is_link:
                                # If a symlink points to a directory (e.g. /tmp/mnt/LABEL -> /tmp/mnt/<uuid>),
                                # expose it as a "directory-like link" for the UI, but keep type="link".
                                try:
                                    target_real = os.path.realpath(os.path.join(rp, entry.name))
                                    if _local_is_allowed(target_real, LOCALFS_ROOTS) and os.path.isdir(target_real):
                                        link_dir = True
                                except Exception:
                                    link_dir = False
                            item = _local_item_from_stat(entry.name, st, is_dir=is_dir, is_link=is_link, link_dir=link_dir)

                            if is_tmp_mnt_root:
                                # Collect for later filtering.
                                if is_link and link_dir:
                                    disk_labels.append(item)
                                elif (not is_link) and is_dir and _looks_like_uuid(entry.name):
                                    mnt_uuid_dirs.append(item)
                                else:
                                    items_all.append(item)
                            else:
                                items_all.append(item)
                        except Exception:
                            continue
            except Exception:
                return error_response('list_failed', 400, ok=False)

            items: List[Dict[str, Any]]
            if is_tmp_mnt_root and disk_labels:
                # Show friendly labels; hide raw UUID mount folders.
                items = disk_labels + items_all
            else:
                # If there are no labels, don't hide anything.
                items = mnt_uuid_dirs + disk_labels + items_all

            return jsonify({'ok': True, 'target': 'local', 'path': rp, 'roots': LOCALFS_ROOTS, 'items': items})

        # remote
        sid = str(request.args.get('sid') or '').strip()
        if not sid:
            return error_response('sid_required', 400, ok=False)
        s, resp = _get_session_or_404(sid)
        if resp is not None:
            return resp
        rpath = str(request.args.get('path', '.') or '.').strip()
        # Normalize remote path for stability: collapse duplicate slashes and strip trailing slashes.
        if rpath not in ('.', '/'): 
            try:
                rpath = re.sub(r'/+', '/', rpath).rstrip('/') or '/'
            except Exception:
                pass

        cmd = "cls -l" if (not rpath or rpath in ('.',)) else f"cls -l {_lftp_quote(rpath)}"
        rc, out, err = mgr._run_lftp(s, [cmd], capture=True)
        if rc != 0:
            tail = (err.decode('utf-8', errors='replace')[-400:]).strip()
            return error_response('list_failed', 400, ok=False, details=tail)
        text = out.decode('utf-8', errors='replace')
        items: List[Dict[str, Any]] = []
        for line in text.splitlines():
            item = _parse_ls_line(line)
            if item is not None:
                items.append(item)
        return jsonify({'ok': True, 'target': 'remote', 'sid': sid, 'path': rpath, 'items': items})


    @bp.get('/api/fs/download')
    def api_fs_download() -> Any:
        """Download a file from local sandbox or remote session.

        Query params:
          target=local|remote
          path=<full path>
          sid=<remote session id> (for target=remote)
        """
        if (resp := _require_enabled()) is not None:
            return resp
        target = str(request.args.get('target', '') or '').strip().lower()
        path = str(request.args.get('path', '') or '').strip()
        archive = str(request.args.get('archive', '') or request.args.get('as', '') or '').strip().lower()
        want_zip = archive in ('zip', '1', 'true', 'yes', 'on')
        if target not in ('local', 'remote'):
            return error_response('bad_target', 400, ok=False)
        if not path:
            return error_response('path_required', 400, ok=False)

        if target == 'local':
            try:
                rp = _local_resolve(path, LOCALFS_ROOTS)
            except PermissionError as e:
                return error_response(str(e), 403, ok=False)
            if os.path.isdir(rp):
                if not want_zip:
                    return error_response('not_a_file', 400, ok=False)

                # Create zip in tmp and stream it back, then cleanup.
                base = os.path.basename(rp.rstrip('/')) or 'download'
                zip_name = base + '.zip'
                tmp_zip = os.path.join(mgr.tmp_dir, f"xkeen_zip_local_{uuid.uuid4().hex}.zip")
                try:
                    _zip_directory(rp, tmp_zip, root_name=base)
                    size_bytes = None
                    try:
                        size_bytes = int(os.path.getsize(tmp_zip))
                    except Exception:
                        size_bytes = None

                    def _gen_zip_local():
                        fp = None
                        try:
                            fp = open(tmp_zip, 'rb')
                            while True:
                                chunk = fp.read(64 * 1024)
                                if not chunk:
                                    break
                                yield chunk
                        finally:
                            try:
                                if fp:
                                    fp.close()
                            except Exception:
                                pass
                            try:
                                if os.path.exists(tmp_zip):
                                    os.remove(tmp_zip)
                            except Exception:
                                pass

                    headers = {
                        'Content-Disposition': f'attachment; filename="{zip_name}"',
                        'Cache-Control': 'no-store',
                    }
                    if isinstance(size_bytes, int) and size_bytes >= 0:
                        headers['Content-Length'] = str(size_bytes)
                    return Response(_gen_zip_local(), mimetype='application/zip', headers=headers)
                except Exception as e:
                    try:
                        if os.path.exists(tmp_zip):
                            os.remove(tmp_zip)
                    except Exception:
                        pass
                    return error_response('zip_failed', 400, ok=False)

            # file
            if not os.path.isfile(rp):
                return error_response('not_a_file', 400, ok=False)
            resp2 = send_file(rp, as_attachment=True, download_name=os.path.basename(rp), mimetype='application/octet-stream', conditional=True)
            try:
                resp2.headers['Cache-Control'] = 'no-store'
            except Exception:
                pass
            return resp2

        # remote
        sid = str(request.args.get('sid') or '').strip()
        if not sid:
            return error_response('sid_required', 400, ok=False)
        s, resp = _get_session_or_404(sid)
        if resp is not None:
            return resp

        # Mirror /api/remotefs/sessions/<sid>/download
        # (kept here for unified client API).
        rc, out, err = mgr._run_lftp(s, [f"cls -ld {_lftp_quote(path)}"], capture=True)
        if rc != 0:
            tail = (err.decode('utf-8', errors='replace')[-400:]).strip()
            return error_response('not_found', 404, ok=False, details=tail)

        is_dir = False
        size_bytes: int | None = None
        try:
            text = (out or b'').decode('utf-8', errors='replace')
            for line in text.splitlines():
                item = _parse_ls_line(line)
                if not item:
                    continue
                is_dir = (str(item.get('type') or '') == 'dir')
                sz = item.get('size', None)
                try:
                    size_bytes = int(sz)
                except Exception:
                    size_bytes = None
                break
        except Exception:
            is_dir = False
            size_bytes = None

        if is_dir:
            if not want_zip:
                return error_response('not_a_file', 400, ok=False)

            base = os.path.basename(path.rstrip('/')) or 'download'
            zip_name = base + '.zip'
            tmp_root = os.path.join(mgr.tmp_dir, f"xkeen_zip_remote_{sid}_{uuid.uuid4().hex}")
            tmp_dir = os.path.join(tmp_root, base)
            tmp_zip = os.path.join(mgr.tmp_dir, f"xkeen_zip_remote_{sid}_{uuid.uuid4().hex}.zip")
            try:
                os.makedirs(tmp_dir, exist_ok=True)

                # Use lftp mirror to fetch the folder into tmp_dir.
                cmd = f"mirror --verbose -- {_lftp_quote(path)} {_lftp_quote(tmp_dir)}"
                script = mgr._build_lftp_script(s, [cmd])
                env = os.environ.copy()
                env.setdefault('LC_ALL', 'C')
                env.setdefault('LANG', 'C')
                proc = subprocess.Popen([mgr.lftp_bin, '-c', script], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, env=env, bufsize=0)
                _out, _err = proc.communicate()
                if int(proc.returncode or 0) != 0:
                    tail = ((_err or b'').decode('utf-8', errors='replace')[-400:]).strip()
                    raise RuntimeError('mirror_failed:' + tail)

                _zip_directory(tmp_dir, tmp_zip, root_name=base)
                zsize = None
                try:
                    zsize = int(os.path.getsize(tmp_zip))
                except Exception:
                    zsize = None

                def _gen_zip_remote():
                    fp = None
                    try:
                        fp = open(tmp_zip, 'rb')
                        while True:
                            chunk = fp.read(64 * 1024)
                            if not chunk:
                                break
                            yield chunk
                    finally:
                        try:
                            if fp:
                                fp.close()
                        except Exception:
                            pass
                        try:
                            if os.path.exists(tmp_zip):
                                os.remove(tmp_zip)
                        except Exception:
                            pass
                        try:
                            shutil.rmtree(tmp_root, ignore_errors=True)
                        except Exception:
                            pass

                headers = {
                    'Content-Disposition': f'attachment; filename="{zip_name}"',
                    'Cache-Control': 'no-store',
                }
                if isinstance(zsize, int) and zsize >= 0:
                    headers['Content-Length'] = str(zsize)
                return Response(_gen_zip_remote(), mimetype='application/zip', headers=headers)

            except Exception as e:
                try:
                    if os.path.exists(tmp_zip):
                        os.remove(tmp_zip)
                except Exception:
                    pass
                try:
                    shutil.rmtree(tmp_root, ignore_errors=True)
                except Exception:
                    pass
                # Best-effort: include tail in details if available
                msg = str(e)
                det = None
                if 'mirror_failed:' in msg:
                    det = msg.split('mirror_failed:', 1)[1].strip()[-400:]
                return error_response('zip_failed', 400, ok=False, details=det)

        p = mgr._popen_lftp(s, [f"cat {_lftp_quote(path)}"])
        stdout = p.stdout
        stderr = p.stderr

        def _gen():
            try:
                assert stdout is not None
                while True:
                    chunk = stdout.read(64 * 1024)
                    if not chunk:
                        break
                    yield chunk
            finally:
                try:
                    if stdout:
                        stdout.close()
                except Exception:
                    pass
                try:
                    if stderr:
                        stderr.close()
                except Exception:
                    pass
                try:
                    p.wait(timeout=1)
                except Exception:
                    pass

        filename = os.path.basename(path.rstrip('/')) or 'download'
        headers = {
            'Content-Disposition': f'attachment; filename="{filename}"',
            'Cache-Control': 'no-store',
        }
        if isinstance(size_bytes, int) and size_bytes >= 0:
            headers['Content-Length'] = str(size_bytes)
        return Response(_gen(), mimetype='application/octet-stream', headers=headers)


    
    @bp.get('/api/fs/read')
    def api_fs_read() -> Any:
        """Read a text file (UTF-8) from local sandbox or remote session.

        Query params:
          target=local|remote
          path=<full path>
          sid=<remote session id> (for target=remote)

        Returns JSON:
          { ok: true, text: "...", truncated: bool, size: int|null }
        """
        if (resp := _require_enabled()) is not None:
            return resp

        target = str(request.args.get('target', '') or '').strip().lower()
        path = str(request.args.get('path', '') or '').strip()
        if target not in ('local', 'remote'):
            return error_response('bad_target', 400, ok=False)
        if not path:
            return error_response('path_required', 400, ok=False)

        # Keep reads bounded to protect embedded devices.
        MAX_BYTES = 1024 * 1024  # 1 MiB
        size_bytes: Optional[int] = None
        truncated = False

        def _decode_utf8_or_415(raw: bytes) -> Any:
            # Heuristic: if NUL byte exists -> binary
            if b'\x00' in raw:
                return None
            try:
                return raw.decode('utf-8')
            except Exception:
                return None

        if target == 'local':
            try:
                rp = _local_resolve(path, LOCALFS_ROOTS)
            except PermissionError as e:
                return error_response(str(e), 403, ok=False)

            if os.path.isdir(rp):
                return error_response('not_a_file', 400, ok=False)
            if not os.path.isfile(rp):
                return error_response('not_found', 404, ok=False)

            try:
                size_bytes = int(os.path.getsize(rp))
            except Exception:
                size_bytes = None

            try:
                with open(rp, 'rb') as fp:
                    raw = fp.read(MAX_BYTES + 1)
            except Exception:
                return error_response('read_failed', 400, ok=False)

            if len(raw) > MAX_BYTES:
                raw = raw[:MAX_BYTES]
                truncated = True

            text = _decode_utf8_or_415(raw)
            if text is None:
                return error_response('not_text', 415, ok=False, binary=True, size=size_bytes)

            return jsonify({'ok': True, 'target': 'local', 'path': rp, 'text': text, 'truncated': truncated, 'size': size_bytes})

        # remote
        sid = str(request.args.get('sid') or '').strip()
        if not sid:
            return error_response('sid_required', 400, ok=False)
        s, resp = _get_session_or_404(sid)
        if resp is not None:
            return resp

        # Best-effort size + dir detection via `cls -l`
        is_dir = False
        try:
            rc, out, err = mgr._run_lftp(s, [f"cls -l {_lftp_quote(path)}"], capture=True)
            if rc == 0:
                text_ls = (out or b'').decode('utf-8', errors='replace')
                for line in text_ls.splitlines():
                    item = _parse_ls_line(line)
                    if not item:
                        continue
                    is_dir = (str(item.get('type') or '') == 'dir')
                    try:
                        size_bytes = int(item.get('size'))  # type: ignore[arg-type]
                    except Exception:
                        size_bytes = None
                    break
        except Exception:
            is_dir = False

        if is_dir:
            return error_response('not_a_file', 400, ok=False)

        # Stream cat and stop after MAX_BYTES
        raw = b''
        p2 = None
        stdout = None
        stderr = None
        try:
            p2 = mgr._popen_lftp(s, [f"cat {_lftp_quote(path)}"])
            stdout = p2.stdout
            stderr = p2.stderr
            if stdout is None:
                raise RuntimeError('no_stdout')
            chunks = []
            total = 0
            while True:
                chunk = stdout.read(64 * 1024)
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
                if total > MAX_BYTES:
                    truncated = True
                    break
            raw = b''.join(chunks)
            if truncated and len(raw) > MAX_BYTES:
                raw = raw[:MAX_BYTES]
        except Exception:
            return error_response('read_failed', 400, ok=False)
        finally:
            try:
                if stdout:
                    stdout.close()
            except Exception:
                pass
            try:
                if stderr:
                    stderr.close()
            except Exception:
                pass
            try:
                if p2:
                    # If truncated, terminate quickly.
                    if truncated:
                        try:
                            p2.terminate()
                        except Exception:
                            pass
                    try:
                        p2.wait(timeout=1)
                    except Exception:
                        pass
            except Exception:
                pass

        text = _decode_utf8_or_415(raw)
        if text is None:
            return error_response('not_text', 415, ok=False, binary=True, size=size_bytes)

        return jsonify({'ok': True, 'target': 'remote', 'sid': sid, 'path': path, 'text': text, 'truncated': truncated, 'size': size_bytes})


    @bp.post('/api/fs/write')
    def api_fs_write() -> Any:
        """Write a text file (UTF-8) to local sandbox or remote session.

        JSON body:
          {
            "target": "local"|"remote",
            "path": "...",
            "sid": "..." (for remote),
            "text": "..."
          }
        """
        if (resp := _require_enabled()) is not None:
            return resp

        data = request.get_json(silent=True) or {}
        target = str(data.get('target') or '').strip().lower()
        path_s = str(data.get('path') or '').strip()
        text = data.get('text', None)

        if target not in ('local', 'remote'):
            return error_response('bad_target', 400, ok=False)
        if not path_s:
            return error_response('path_required', 400, ok=False)
        if not isinstance(text, str):
            return error_response('text_required', 400, ok=False)

        # Keep writes bounded.
        MAX_WRITE = 2 * 1024 * 1024  # 2 MiB
        raw = text.encode('utf-8', errors='strict')
        if len(raw) > MAX_WRITE:
            return error_response('too_large', 413, ok=False, max_bytes=MAX_WRITE)

        os.makedirs(mgr.tmp_dir, exist_ok=True)

        if target == 'local':
            try:
                rp = _local_resolve(path_s, LOCALFS_ROOTS)
            except PermissionError as e:
                return error_response(str(e), 403, ok=False)

            if os.path.isdir(rp):
                return error_response('not_a_file', 400, ok=False)

            parent = os.path.dirname(rp)
            if parent and not os.path.isdir(parent):
                return error_response('parent_not_found', 400, ok=False)

            tmp_path = os.path.join(mgr.tmp_dir, f"xkeen_write_local_{uuid.uuid4().hex}.tmp")
            try:
                with open(tmp_path, 'wb') as fp:
                    fp.write(raw)
                try:
                    os.replace(tmp_path, rp)
                except Exception:
                    shutil.move(tmp_path, rp)
            except Exception:
                try:
                    if os.path.exists(tmp_path):
                        os.remove(tmp_path)
                except Exception:
                    pass
                return error_response('write_failed', 400, ok=False)

            return jsonify({'ok': True, 'bytes': len(raw)})

        # remote
        sid = str(data.get('sid') or '').strip()
        if not sid:
            return error_response('sid_required', 400, ok=False)
        s, resp = _get_session_or_404(sid)
        if resp is not None:
            return resp

        tmp_path = os.path.join(mgr.tmp_dir, f"xkeen_write_remote_{sid}_{uuid.uuid4().hex}.tmp")
        try:
            with open(tmp_path, 'wb') as fp:
                fp.write(raw)
            rc, out, err = mgr._run_lftp(
                s,
                [f"put {_lftp_quote(tmp_path)} -o {_lftp_quote(path_s)}"],
                capture=True,
            )
            if rc != 0:
                tail = (err.decode('utf-8', errors='replace')[-400:]).strip()
                return error_response('remote_put_failed', 400, ok=False, details=tail)
            return jsonify({'ok': True, 'bytes': len(raw)})
        except Exception:
            return error_response('write_failed', 400, ok=False)
        finally:
            try:
                os.remove(tmp_path)
            except Exception:
                pass


    @bp.post('/api/fs/archive')
    def api_fs_archive() -> Any:
        """Download multiple selected files/folders as a ZIP archive.

        Query params:
          target=local|remote
          sid=<remote session id> (for target=remote)

        JSON body:
          {
            "items": [{"path": "...", "name": "...", "is_dir": true|false}, ...],
            "zip_name": "something.zip",
            "root_name": "folder_inside_zip"
          }
        """
        if (resp := _require_enabled()) is not None:
            return resp

        target = str(request.args.get('target', '') or '').strip().lower()
        if target not in ('local', 'remote'):
            return error_response('bad_target', 400, ok=False)

        data = request.get_json(silent=True) or {}
        items_raw = data.get('items', None)
        if items_raw is None:
            items_raw = data.get('paths', None)
        if not isinstance(items_raw, list) or not items_raw:
            return error_response('items_required', 400, ok=False)

        # Limit to avoid accidental huge archives on routers.
        if len(items_raw) > 200:
            return error_response('too_many_items', 400, ok=False, max_items=200)

        def _sanitize_zip_filename(name: str) -> str:
            n = os.path.basename(str(name or '').strip()) or 'selection.zip'
            # remove quotes / odd chars
            n = n.replace('"', '').replace("'", '')
            if not n.lower().endswith('.zip'):
                n += '.zip'
            return n

        def _sanitize_root_name(name: str) -> str:
            s = str(name or '').strip()
            if not s:
                return 'selection'
            s = s.replace('\\', '/')
            s = s.strip('/').strip()
            # single folder name
            s = os.path.basename(s) or 'selection'
            s = re.sub(r'[^0-9A-Za-z._-]+', '_', s)[:64] or 'selection'
            return s

        zip_name = _sanitize_zip_filename(data.get('zip_name') or data.get('name') or 'selection.zip')
        root_name = _sanitize_root_name(data.get('root_name') or os.path.splitext(zip_name)[0] or 'selection')

        # Normalize item list
        items: List[Dict[str, Any]] = []
        for it in items_raw:
            if isinstance(it, str):
                path = str(it).strip()
                if not path:
                    continue
                items.append({'path': path, 'name': os.path.basename(path.rstrip('/')) or path, 'is_dir': None})
            elif isinstance(it, dict):
                path = str(it.get('path') or '').strip()
                if not path:
                    continue
                name = str(it.get('name') or os.path.basename(path.rstrip('/')) or path).strip()
                is_dir = it.get('is_dir', None)
                if isinstance(is_dir, str):
                    is_dir = is_dir.strip().lower() in ('1', 'true', 'yes', 'on')
                elif not isinstance(is_dir, bool):
                    is_dir = None
                items.append({'path': path, 'name': name, 'is_dir': is_dir})
        if not items:
            return error_response('items_required', 400, ok=False)

        os.makedirs(mgr.tmp_dir, exist_ok=True)
        tmp_zip = os.path.join(mgr.tmp_dir, f"xkeen_zip_selection_{uuid.uuid4().hex}.zip")

        if target == 'local':
            resolved: List[Tuple[str, str]] = []
            try:
                for it in items:
                    try:
                        rp = _local_resolve(it['path'], LOCALFS_ROOTS)
                    except PermissionError as e:
                        raise RuntimeError(str(e))
                    if not os.path.exists(rp):
                        raise RuntimeError('not_found')
                    resolved.append((rp, str(it.get('name') or it['path'])))
                _zip_selection_local(resolved, tmp_zip, root_name=root_name)
                zsize = None
                try:
                    zsize = int(os.path.getsize(tmp_zip))
                except Exception:
                    zsize = None

                def _gen_zip_local_sel():
                    fp = None
                    try:
                        fp = open(tmp_zip, 'rb')
                        while True:
                            chunk = fp.read(64 * 1024)
                            if not chunk:
                                break
                            yield chunk
                    finally:
                        try:
                            if fp:
                                fp.close()
                        except Exception:
                            pass
                        try:
                            if os.path.exists(tmp_zip):
                                os.remove(tmp_zip)
                        except Exception:
                            pass

                headers = {
                    'Content-Disposition': f'attachment; filename="{zip_name}"',
                    'Cache-Control': 'no-store',
                }
                if isinstance(zsize, int) and zsize >= 0:
                    headers['Content-Length'] = str(zsize)
                return Response(_gen_zip_local_sel(), mimetype='application/zip', headers=headers)

            except Exception as e:
                try:
                    if os.path.exists(tmp_zip):
                        os.remove(tmp_zip)
                except Exception:
                    pass
                msg = str(e) or 'zip_failed'
                if 'Permission' in msg or 'forbidden' in msg:
                    return error_response(msg, 403, ok=False)
                if msg == 'not_found':
                    return error_response('not_found', 404, ok=False)
                return error_response('zip_failed', 400, ok=False)

        # remote
        sid = str(request.args.get('sid') or '').strip()
        if not sid:
            try:
                if os.path.exists(tmp_zip):
                    os.remove(tmp_zip)
            except Exception:
                pass
            return error_response('sid_required', 400, ok=False)
        s, resp = _get_session_or_404(sid)
        if resp is not None:
            try:
                if os.path.exists(tmp_zip):
                    os.remove(tmp_zip)
            except Exception:
                pass
            return resp

        tmp_root = os.path.join(mgr.tmp_dir, f"xkeen_zip_multi_{sid}_{uuid.uuid4().hex}")
        tmp_payload = os.path.join(tmp_root, root_name)
        try:
            os.makedirs(tmp_payload, exist_ok=True)

            # Download each item into tmp_payload (dir: mirror, file: cat stream)
            for it in items:
                rpath = str(it.get('path') or '').strip()
                if not rpath:
                    continue
                # normalize remote path a bit
                if rpath not in ('.', '/'):
                    try:
                        rpath = re.sub(r'/+', '/', rpath).rstrip('/') or '/'
                    except Exception:
                        pass
                base = os.path.basename(str(it.get('name') or '').strip() or rpath.rstrip('/')) or 'item'
                base = base.replace('..', '_').replace('/', '_').replace('\\', '_') or 'item'
                dest = os.path.join(tmp_payload, base)

                is_dir = it.get('is_dir', None)
                if is_dir is None:
                    # fallback stat
                    v = _remote_is_dir(s, rpath)
                    if v is None:
                        raise RuntimeError('not_found')
                    is_dir = bool(v)

                if is_dir:
                    os.makedirs(dest, exist_ok=True)
                    cmd = f"mirror --verbose -- {_lftp_quote(rpath)} {_lftp_quote(dest)}"
                    script = mgr._build_lftp_script(s, [cmd])
                    env = os.environ.copy()
                    env.setdefault('LC_ALL', 'C')
                    env.setdefault('LANG', 'C')
                    proc = subprocess.Popen([mgr.lftp_bin, '-c', script], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, env=env, bufsize=0)
                    _out, _err = proc.communicate()
                    if int(proc.returncode or 0) != 0:
                        tail = ((_err or b'').decode('utf-8', errors='replace')[-400:]).strip()
                        raise RuntimeError('mirror_failed:' + tail)
                else:
                    os.makedirs(os.path.dirname(dest) or tmp_payload, exist_ok=True)
                    tmp_part = dest + '.part.' + uuid.uuid4().hex[:6]
                    p2 = mgr._popen_lftp(s, [f"cat {_lftp_quote(rpath)}"])
                    stdout = p2.stdout
                    stderr = p2.stderr
                    try:
                        with open(tmp_part, 'wb') as fp:
                            while True:
                                chunk = stdout.read(64 * 1024) if stdout else b''
                                if not chunk:
                                    break
                                fp.write(chunk)
                        rc = p2.wait()
                        if int(rc or 0) != 0:
                            raise RuntimeError('download_failed')
                        os.replace(tmp_part, dest)
                    finally:
                        try:
                            if stdout: stdout.close()
                        except Exception:
                            pass
                        try:
                            if stderr: stderr.close()
                        except Exception:
                            pass
                        try:
                            if os.path.exists(tmp_part):
                                os.remove(tmp_part)
                        except Exception:
                            pass

            _zip_directory(tmp_payload, tmp_zip, root_name=root_name)
            zsize = None
            try:
                zsize = int(os.path.getsize(tmp_zip))
            except Exception:
                zsize = None

            def _gen_zip_remote_sel():
                fp = None
                try:
                    fp = open(tmp_zip, 'rb')
                    while True:
                        chunk = fp.read(64 * 1024)
                        if not chunk:
                            break
                        yield chunk
                finally:
                    try:
                        if fp:
                            fp.close()
                    except Exception:
                        pass
                    try:
                        if os.path.exists(tmp_zip):
                            os.remove(tmp_zip)
                    except Exception:
                        pass
                    try:
                        shutil.rmtree(tmp_root, ignore_errors=True)
                    except Exception:
                        pass

            headers = {
                'Content-Disposition': f'attachment; filename="{zip_name}"',
                'Cache-Control': 'no-store',
            }
            if isinstance(zsize, int) and zsize >= 0:
                headers['Content-Length'] = str(zsize)
            return Response(_gen_zip_remote_sel(), mimetype='application/zip', headers=headers)

        except Exception as e:
            try:
                if os.path.exists(tmp_zip):
                    os.remove(tmp_zip)
            except Exception:
                pass
            try:
                shutil.rmtree(tmp_root, ignore_errors=True)
            except Exception:
                pass
            msg = str(e) or ''
            det = None
            if 'mirror_failed:' in msg:
                det = msg.split('mirror_failed:', 1)[1].strip()[-400:]
                return error_response('zip_failed', 400, ok=False, details=det)
            if msg == 'not_found':
                return error_response('not_found', 404, ok=False)
            return error_response('zip_failed', 400, ok=False)

    @bp.post('/api/fs/upload')
    def api_fs_upload() -> Any:
        """Upload a file to local sandbox or remote session.

        Query params:
          target=local|remote
          path=<full destination path (including filename) OR directory>
          sid=<remote session id> (for target=remote)

        multipart: file=<file>
        """
        if (resp := _require_enabled()) is not None:
            return resp

        target = str(request.args.get('target', '') or '').strip().lower()
        path = str(request.args.get('path', '') or '').strip()
        if target not in ('local', 'remote'):
            return error_response('bad_target', 400, ok=False)
        if not path:
            return error_response('path_required', 400, ok=False)
        if 'file' not in request.files:
            return error_response('file_required', 400, ok=False)
        f = request.files['file']
        if not f:
            return error_response('file_required', 400, ok=False)

        # Normalize filename for directory uploads
        raw_name = str(getattr(f, 'filename', '') or '').strip()
        safe_fn = os.path.basename(raw_name) if raw_name else 'upload.bin'
        if not safe_fn:
            safe_fn = 'upload.bin'

        max_bytes = int(mgr.max_upload_mb) * 1024 * 1024
        os.makedirs(mgr.tmp_dir, exist_ok=True)

        if target == 'local':
            # If user passed a directory, append file name.
            dest = path
            if dest.endswith('/'):
                dest = dest.rstrip('/') + '/' + safe_fn
            else:
                try:
                    # If dest exists and is directory.
                    rp_probe = _local_resolve(dest, LOCALFS_ROOTS)
                    if os.path.isdir(rp_probe):
                        dest = os.path.join(dest, safe_fn)
                except Exception:
                    pass

            try:
                rp = _local_resolve(dest, LOCALFS_ROOTS)
            except PermissionError as e:
                return error_response(str(e), 403, ok=False)

            parent = os.path.dirname(rp)
            if parent and not os.path.isdir(parent):
                return error_response('parent_not_found', 400, ok=False)

            tmp_path = os.path.join(mgr.tmp_dir, f"xkeen_upload_local_{uuid.uuid4().hex}.tmp")
            total = 0
            try:
                with open(tmp_path, 'wb') as outfp:
                    while True:
                        chunk = f.stream.read(64 * 1024)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > max_bytes:
                            raise ValueError('too_large')
                        outfp.write(chunk)
            except ValueError as e:
                try:
                    os.remove(tmp_path)
                except Exception:
                    pass
                if str(e) == 'too_large':
                    return error_response('upload_too_large', 413, ok=False, max_mb=mgr.max_upload_mb)
                return error_response('upload_failed', 400, ok=False)
            except Exception:
                try:
                    os.remove(tmp_path)
                except Exception:
                    pass
                return error_response('upload_failed', 400, ok=False)

            try:
                # Try atomic replace
                os.replace(tmp_path, rp)
            except Exception:
                try:
                    shutil.move(tmp_path, rp)
                except Exception:
                    try:
                        os.remove(tmp_path)
                    except Exception:
                        pass
                    return error_response('upload_failed', 400, ok=False)
            return jsonify({'ok': True, 'bytes': total, 'path': rp})

        # remote
        sid = str(request.args.get('sid') or '').strip()
        if not sid:
            return error_response('sid_required', 400, ok=False)
        s, resp = _get_session_or_404(sid)
        if resp is not None:
            return resp

        remote_path = path
        if remote_path.endswith('/'):
            remote_path = remote_path.rstrip('/') + '/' + safe_fn

        tmp_path = os.path.join(mgr.tmp_dir, f"xkeen_upload_{sid}_{uuid.uuid4().hex}.tmp")
        total = 0
        try:
            with open(tmp_path, 'wb') as outfp:
                while True:
                    chunk = f.stream.read(64 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > max_bytes:
                        raise ValueError('too_large')
                    outfp.write(chunk)
        except ValueError as e:
            try:
                os.remove(tmp_path)
            except Exception:
                pass
            if str(e) == 'too_large':
                return error_response('upload_too_large', 413, ok=False, max_mb=mgr.max_upload_mb)
            return error_response('upload_failed', 400, ok=False)
        except Exception:
            try:
                os.remove(tmp_path)
            except Exception:
                pass
            return error_response('upload_failed', 400, ok=False)

        try:
            rc, out, err = mgr._run_lftp(
                s,
                [f"put {_lftp_quote(tmp_path)} -o {_lftp_quote(remote_path)}"],
                capture=True,
            )
            if rc != 0:
                tail = (err.decode('utf-8', errors='replace')[-400:]).strip()
                return error_response('remote_put_failed', 400, ok=False, details=tail)
            return jsonify({'ok': True, 'bytes': total})
        finally:
            try:
                os.remove(tmp_path)
            except Exception:
                pass


    @bp.post('/api/fs/mkdir')
    def api_fs_mkdir() -> Any:
        if (resp := _require_enabled()) is not None:
            return resp
        data = request.get_json(silent=True) or {}
        target = str(data.get('target') or '').strip().lower()
        path_s = str(data.get('path') or '').strip()
        parents = bool(data.get('parents', False))
        if target not in ('local', 'remote'):
            return error_response('bad_target', 400, ok=False)
        if not path_s:
            return error_response('path_required', 400, ok=False)

        if target == 'local':
            try:
                rp = _local_resolve(path_s, LOCALFS_ROOTS)
            except PermissionError as e:
                return error_response(str(e), 403, ok=False)
            try:
                if parents:
                    os.makedirs(rp, exist_ok=True)
                else:
                    os.mkdir(rp)
            except FileExistsError:
                return error_response('exists', 409, ok=False)
            except Exception:
                return error_response('mkdir_failed', 400, ok=False)
            return jsonify({'ok': True})

        sid = str(data.get('sid') or '').strip()
        if not sid:
            return error_response('sid_required', 400, ok=False)
        s, resp = _get_session_or_404(sid)
        if resp is not None:
            return resp
        cmd = f"mkdir {'-p ' if parents else ''}{_lftp_quote(path_s)}"
        rc, out, err = mgr._run_lftp(s, [cmd], capture=True)
        if rc != 0:
            tail = (err.decode('utf-8', errors='replace')[-400:]).strip()
            return error_response('mkdir_failed', 400, ok=False, details=tail)
        return jsonify({'ok': True})


    @bp.post('/api/fs/rename')
    def api_fs_rename() -> Any:
        if (resp := _require_enabled()) is not None:
            return resp
        data = request.get_json(silent=True) or {}
        target = str(data.get('target') or '').strip().lower()
        src_p = str(data.get('src') or '').strip()
        dst_p = str(data.get('dst') or '').strip()
        if target not in ('local', 'remote'):
            return error_response('bad_target', 400, ok=False)
        if not src_p or not dst_p:
            return error_response('src_dst_required', 400, ok=False)

        if target == 'local':
            try:
                sp = _local_resolve(src_p, LOCALFS_ROOTS)
                dp = _local_resolve(dst_p, LOCALFS_ROOTS)
            except PermissionError as e:
                return error_response(str(e), 403, ok=False)
            try:
                os.rename(sp, dp)
            except FileNotFoundError:
                return error_response('not_found', 404, ok=False)
            except Exception:
                return error_response('rename_failed', 400, ok=False)
            return jsonify({'ok': True})

        sid = str(data.get('sid') or '').strip()
        if not sid:
            return error_response('sid_required', 400, ok=False)
        s, resp = _get_session_or_404(sid)
        if resp is not None:
            return resp
        rc, out, err = mgr._run_lftp(s, [f"mv {_lftp_quote(src_p)} {_lftp_quote(dst_p)}"], capture=True)
        if rc != 0:
            tail = (err.decode('utf-8', errors='replace')[-400:]).strip()
            return error_response('rename_failed', 400, ok=False, details=tail)
        return jsonify({'ok': True})


    @bp.delete('/api/fs/remove')
    def api_fs_remove() -> Any:
        if (resp := _require_enabled()) is not None:
            return resp
        target = str(request.args.get('target') or '').strip().lower()
        path_s = str(request.args.get('path') or '').strip()
        recursive = (request.args.get('recursive', '0') or '') in ('1', 'true', 'yes', 'on')
        if target not in ('local', 'remote'):
            return error_response('bad_target', 400, ok=False)
        if not path_s:
            return error_response('path_required', 400, ok=False)

        if target == 'local':
            try:
                rp = _local_resolve(path_s, LOCALFS_ROOTS)
            except PermissionError as e:
                return error_response(str(e), 403, ok=False)
            if not os.path.exists(rp):
                return error_response('not_found', 404, ok=False)
            try:
                if os.path.isdir(rp) and not os.path.islink(rp):
                    if not recursive:
                        os.rmdir(rp)
                    else:
                        shutil.rmtree(rp)
                else:
                    os.remove(rp)
            except Exception:
                return error_response('remove_failed', 400, ok=False)
            return jsonify({'ok': True})

        sid = str(request.args.get('sid') or '').strip()
        if not sid:
            return error_response('sid_required', 400, ok=False)
        s, resp = _get_session_or_404(sid)
        if resp is not None:
            return resp
        if recursive:
            rc, out, err = mgr._run_lftp(s, [f"rm -r {_lftp_quote(path_s)}"], capture=True)
            if rc != 0:
                tail = (err.decode('utf-8', errors='replace')[-400:]).strip()
                return error_response('remove_failed', 400, ok=False, details=tail)
            return jsonify({'ok': True})
        rc, out, err = mgr._run_lftp(s, [f"rm {_lftp_quote(path_s)}"], capture=True)
        if rc == 0:
            return jsonify({'ok': True})
        rc2, out2, err2 = mgr._run_lftp(s, [f"rmdir {_lftp_quote(path_s)}"], capture=True)
        if rc2 != 0:
            tail = (err2.decode('utf-8', errors='replace')[-400:]).strip()
            return error_response('remove_failed', 400, ok=False, details=tail)
        return jsonify({'ok': True})


    def _parse_mode_value(mode_v: Any) -> int:
        if mode_v is None:
            raise RuntimeError('mode_required')
        if isinstance(mode_v, int):
            return int(mode_v)
        s = str(mode_v).strip().lower()
        if not s:
            raise RuntimeError('mode_required')
        # common: "644" / "0755" / "0o755"
        if s.startswith('0o'):
            return int(s, 8)
        if re.match(r'^[0-7]{3,4}$', s):
            return int(s, 8)
        return int(s, 10)


    @bp.post('/api/fs/chmod')
    def api_fs_chmod() -> Any:
        if (resp := _require_enabled()) is not None:
            return resp
        data = request.get_json(silent=True) or {}
        target = str(data.get('target') or '').strip().lower()
        path_s = str(data.get('path') or '').strip()
        if target not in ('local', 'remote'):
            return error_response('bad_target', 400, ok=False)
        if not path_s:
            return error_response('path_required', 400, ok=False)
        try:
            mode_i = _parse_mode_value(data.get('mode'))
        except RuntimeError as e:
            return error_response(str(e), 400, ok=False)
        except Exception:
            return error_response('bad_mode', 400, ok=False)

        if target == 'local':
            try:
                rp = _local_resolve(path_s, LOCALFS_ROOTS)
            except PermissionError as e:
                return error_response(str(e), 403, ok=False)
            try:
                os.chmod(rp, mode_i)
            except Exception:
                return error_response('chmod_failed', 400, ok=False)
            return jsonify({'ok': True, 'target': 'local', 'path': rp, 'mode': mode_i})

        sid = str(data.get('sid') or '').strip()
        if not sid:
            return error_response('sid_required', 400, ok=False)
        s, resp = _get_session_or_404(sid)
        if resp is not None:
            return resp
        rc, out, err = mgr._run_lftp(s, [f"chmod {mode_i:o} {_lftp_quote(path_s)}"], capture=True)
        if rc != 0:
            tail = (err.decode('utf-8', errors='replace')[-400:]).strip()
            return error_response('chmod_failed', 400, ok=False, details=tail)
        return jsonify({'ok': True, 'target': 'remote', 'sid': sid, 'path': path_s, 'mode': mode_i})


    @bp.post('/api/fs/chown')
    def api_fs_chown() -> Any:
        if (resp := _require_enabled()) is not None:
            return resp
        data = request.get_json(silent=True) or {}
        target = str(data.get('target') or '').strip().lower()
        path_s = str(data.get('path') or '').strip()
        if target not in ('local', 'remote'):
            return error_response('bad_target', 400, ok=False)
        if not path_s:
            return error_response('path_required', 400, ok=False)
        uid = data.get('uid')
        gid = data.get('gid')
        try:
            uid_i = int(uid)
            gid_i = int(gid) if gid is not None else -1
        except Exception:
            return error_response('bad_owner', 400, ok=False)

        if target == 'local':
            try:
                rp = _local_resolve(path_s, LOCALFS_ROOTS)
            except PermissionError as e:
                return error_response(str(e), 403, ok=False)
            try:
                os.chown(rp, uid_i, gid_i)
            except Exception:
                return error_response('chown_failed', 400, ok=False)
            return jsonify({'ok': True, 'target': 'local', 'path': rp, 'uid': uid_i, 'gid': gid_i})

        # Remote chown is protocol-dependent; we only attempt it for SFTP (best-effort).
        sid = str(data.get('sid') or '').strip()
        if not sid:
            return error_response('sid_required', 400, ok=False)
        s, resp = _get_session_or_404(sid)
        if resp is not None:
            return resp
        if getattr(s, 'protocol', None) != 'sftp':
            return error_response('not_supported', 400, ok=False)
        owner = f"{uid_i}:{gid_i}" if gid_i >= 0 else str(uid_i)
        rc, out, err = mgr._run_lftp(s, [f"chown {owner} {_lftp_quote(path_s)}"], capture=True)
        if rc != 0:
            tail = (err.decode('utf-8', errors='replace')[-400:]).strip()
            return error_response('chown_failed', 400, ok=False, details=tail)
        return jsonify({'ok': True, 'target': 'remote', 'sid': sid, 'path': path_s, 'uid': uid_i, 'gid': gid_i})


    @bp.post('/api/fs/touch')
    def api_fs_touch() -> Any:
        if (resp := _require_enabled()) is not None:
            return resp
        data = request.get_json(silent=True) or {}
        target = str(data.get('target') or '').strip().lower()
        path_s = str(data.get('path') or '').strip()
        create_parents = bool(data.get('parents', True))
        create_only = bool(data.get('create_only', True))
        if target not in ('local', 'remote'):
            return error_response('bad_target', 400, ok=False)
        if not path_s:
            return error_response('path_required', 400, ok=False)

        if target == 'local':
            try:
                rp = _local_resolve(path_s, LOCALFS_ROOTS)
            except PermissionError as e:
                return error_response(str(e), 403, ok=False)
            try:
                if create_parents:
                    os.makedirs(os.path.dirname(rp) or '/tmp', exist_ok=True)
                # "touch" is used by the web UI to create empty files.
                # In "create_only" mode we MUST NOT modify an existing file.
                if create_only and os.path.exists(rp):
                    return jsonify({'ok': True, 'target': 'local', 'path': rp, 'skipped': True})
                if not os.path.exists(rp):
                    with open(rp, 'a', encoding='utf-8'):
                        pass
                os.utime(rp, None)
            except Exception:
                return error_response('touch_failed', 400, ok=False)
            return jsonify({'ok': True, 'target': 'local', 'path': rp})

        sid = str(data.get('sid') or '').strip()
        if not sid:
            return error_response('sid_required', 400, ok=False)
        s, resp = _get_session_or_404(sid)
        if resp is not None:
            return resp

        # Avoid destructive overwrite by default.
        if create_only and _remote_exists(s, path_s):
            return jsonify({'ok': True, 'target': 'remote', 'sid': sid, 'path': path_s, 'skipped': True})
        if create_parents:
            parent = os.path.dirname(path_s.rstrip('/'))
            if parent and parent not in ('', '.'):
                mgr._run_lftp(s, [f"mkdir -p {_lftp_quote(parent)}"], capture=True)
        # Create an empty file via uploading /dev/null
        rc, out, err = mgr._run_lftp(s, [f"put /dev/null -o {_lftp_quote(path_s)}"], capture=True)
        if rc != 0:
            tail = (err.decode('utf-8', errors='replace')[-400:]).strip()
            return error_response('touch_failed', 400, ok=False, details=tail)
        return jsonify({'ok': True, 'target': 'remote', 'sid': sid, 'path': path_s})


    @bp.post('/api/fs/stat-batch')
    def api_fs_stat_batch() -> Any:
        if (resp := _require_enabled()) is not None:
            return resp
        data = request.get_json(silent=True) or {}
        target = str(data.get('target') or '').strip().lower()
        if target not in ('local', 'remote'):
            return error_response('bad_target', 400, ok=False)

        paths: List[str] = []
        if isinstance(data.get('paths'), list):
            cwd = str(data.get('cwd') or '').strip() or ''
            for n in data.get('paths'):
                nm = str(n or '').strip()
                if not nm:
                    continue
                if cwd:
                    full = (cwd.rstrip('/') + '/' + nm) if target == 'remote' else os.path.join(cwd, nm)
                else:
                    full = nm
                paths.append(full)
        elif data.get('path'):
            paths = [str(data.get('path') or '').strip()]
        if not paths:
            return error_response('no_paths', 400, ok=False)
        if len(paths) > 200:
            return error_response('too_many_paths', 400, ok=False)

        if target == 'local':
            out_items: List[Dict[str, Any]] = []
            for p in paths:
                try:
                    rp = _local_resolve(p, LOCALFS_ROOTS)
                except PermissionError:
                    out_items.append({'path': p, 'exists': False, 'error': 'forbidden'})
                    continue
                if not os.path.exists(rp):
                    out_items.append({'path': rp, 'exists': False})
                    continue
                try:
                    st = os.lstat(rp)
                    out_items.append({
                        'path': rp,
                        'exists': True,
                        'type': 'dir' if os.path.isdir(rp) else ('link' if os.path.islink(rp) else 'file'),
                        'size': int(getattr(st, 'st_size', 0) or 0),
                        'mode': int(getattr(st, 'st_mode', 0) or 0),
                        'uid': int(getattr(st, 'st_uid', -1) or -1),
                        'gid': int(getattr(st, 'st_gid', -1) or -1),
                        'mtime': int(getattr(st, 'st_mtime', 0) or 0),
                        'atime': int(getattr(st, 'st_atime', 0) or 0),
                    })
                except Exception:
                    out_items.append({'path': rp, 'exists': False, 'error': 'stat_failed'})
            return jsonify({'ok': True, 'target': 'local', 'items': out_items})

        sid = str(data.get('sid') or '').strip()
        if not sid:
            return error_response('sid_required', 400, ok=False)
        s, resp = _get_session_or_404(sid)
        if resp is not None:
            return resp
        out_items: List[Dict[str, Any]] = []
        for p in paths:
            rc, out, err = mgr._run_lftp(s, [f"cls -ld {_lftp_quote(p)}"], capture=True)
            if rc != 0:
                out_items.append({'path': p, 'exists': False})
                continue
            text = out.decode('utf-8', errors='replace').strip().splitlines()
            line = text[-1] if text else ''
            item = _parse_ls_line(line)
            if not item:
                out_items.append({'path': p, 'exists': True})
                continue
            out_items.append({
                'path': p,
                'exists': True,
                'type': item.get('type'),
                'size': item.get('size'),
                'perm': item.get('perm'),
                'mtime': item.get('mtime'),
            })
        return jsonify({'ok': True, 'target': 'remote', 'sid': sid, 'items': out_items})




    @bp.post('/api/fileops/ws-token')
    def api_fileops_ws_token() -> Any:
        if (resp := _require_enabled()) is not None:
            return resp
        ttl = 60
        try:
            data = request.get_json(silent=True) or {}
            if isinstance(data, dict) and data.get('ttl'):
                ttl = max(10, min(300, int(data.get('ttl'))))
        except Exception:
            ttl = 60
        token = issue_fileops_ws_token(ttl_seconds=ttl)
        return jsonify({'ok': True, 'token': token, 'ttl': ttl})


    @bp.route('/ws/fileops')
    def ws_fileops() -> Any:
        """WebSocket progress stream for fileops jobs.

        query: token=<one-time token>, job_id=<job_id>

        Server messages:
          {type:'init', job:{...}}
          {type:'update', job:{...}}
          {type:'done', job:{...}}
          {type:'error', message:'...'}
        """
        if (resp := _require_enabled()) is not None:
            return resp

        ws = request.environ.get('wsgi.websocket')
        if ws is None:
            return 'Expected WebSocket', 400

        token = (request.args.get('token') or '').strip()
        job_id = (request.args.get('job_id') or '').strip()
        if not token or not job_id:
            try:
                ws.send(json.dumps({'type': 'error', 'message': 'token and job_id are required'}, ensure_ascii=False))
            except Exception:
                pass
            try:
                ws.close()
            except Exception:
                pass
            return ''

        if not validate_fileops_ws_token(token):
            try:
                ws.send(json.dumps({'type': 'error', 'message': 'bad_token'}, ensure_ascii=False))
            except Exception:
                pass
            try:
                ws.close()
            except Exception:
                pass
            return ''

        last_rev = -1
        try:
            while True:
                job = jobmgr.get(job_id)
                if job is None:
                    try:
                        ws.send(json.dumps({'type': 'error', 'message': 'job_not_found'}, ensure_ascii=False))
                    except Exception:
                        pass
                    break

                rev = int(getattr(job, 'rev', 0) or 0)
                if last_rev < 0:
                    last_rev = rev
                    ws.send(json.dumps({'type': 'init', 'job': job.to_dict()}, ensure_ascii=False))
                elif rev != last_rev:
                    last_rev = rev
                    ws.send(json.dumps({'type': 'update', 'job': job.to_dict()}, ensure_ascii=False))

                if job.state in ('done', 'error', 'canceled'):
                    ws.send(json.dumps({'type': 'done', 'job': job.to_dict()}, ensure_ascii=False))
                    break

                _ws_sleep(0.2)
        except Exception:
            # client likely disconnected
            pass
        finally:
            try:
                ws.close()
            except Exception:
                pass
        return ''
    @bp.post('/api/fileops/jobs')
    def api_fileops_create_job() -> Any:
        if (resp := _require_enabled()) is not None:
            return resp
        data = request.get_json(silent=True) or {}
        op = str(data.get('op') or 'copy').strip().lower()
        if op not in ('copy', 'move', 'delete'):
            return error_response('unsupported_op', 400, ok=False)
        try:
            if op == 'delete':
                _normalize_delete(data)
            else:
                _normalize_sources(data)
        except RuntimeError as e:
            return error_response(str(e), 400, ok=False)
        except Exception:
            return error_response('bad_request', 400, ok=False)

        # Optional dry-run / conflict planning for copy/move
        if op in ('copy', 'move'):
            opts = (data.get('options') or {}) if isinstance(data.get('options'), dict) else {}
            overwrite = str(opts.get('overwrite', 'replace') or 'replace').strip().lower()
            dry_run = bool(opts.get('dry_run'))
            decisions = opts.get('decisions') if isinstance(opts.get('decisions'), dict) else {}
            default_action = str(opts.get('default_action') or opts.get('overwrite_default') or '').strip().lower() or None
            if default_action not in (None, 'replace', 'skip'):
                default_action = None

            conflicts = _compute_copy_move_conflicts(data)
            if dry_run:
                return jsonify({
                    'ok': True,
                    'dry_run': True,
                    'op': op,
                    'src': data.get('src') or {},
                    'dst': data.get('dst') or {},
                    'sources': data.get('sources') or [],
                    'bytes_total': data.get('bytes_total') or 0,
                    'conflicts': conflicts,
                })

            if overwrite == 'ask' and not decisions and not default_action and conflicts:
                return jsonify({'ok': False, 'error': 'conflicts', 'conflicts': conflicts}), 409

        job = jobmgr.create(op)
        # store normalized spec in closure
        if op == 'delete':
            spec = {'src': data['src'], 'sources': data['sources'], 'options': data.get('options') or {}}
            _progress_set(job, files_total=len(spec['sources']))
            jobmgr.submit(job, _run_job_delete, spec)
        else:
            spec = {'src': data['src'], 'dst': data['dst'], 'sources': data['sources'], 'options': data.get('options') or {}, 'bytes_total': data.get('bytes_total') or 0}
            _progress_set(job, bytes_total=spec['bytes_total'], files_total=len(spec['sources']))
            jobmgr.submit(job, _run_job_copy_move, spec)

        return jsonify({'ok': True, 'job_id': job.job_id, 'job': job.to_dict()})


    @bp.get('/api/fileops/jobs')
    def api_fileops_list_jobs() -> Any:
        if (resp := _require_enabled()) is not None:
            return resp
        try:
            limit = int(request.args.get('limit', '20') or '20')
        except Exception:
            limit = 20
        limit = max(1, min(100, limit))
        try:
            with jobmgr._lock:
                jobs = list(jobmgr._jobs.values())
        except Exception:
            jobs = []
        jobs.sort(key=lambda j: float(getattr(j, 'created_ts', 0) or 0), reverse=True)
        return jsonify({'ok': True, 'jobs': [j.to_dict() for j in jobs[:limit]]})


    @bp.get('/api/fileops/jobs/<job_id>')
    def api_fileops_get_job(job_id: str) -> Any:
        if (resp := _require_enabled()) is not None:
            return resp
        job = jobmgr.get(job_id)
        if not job:
            return error_response('job_not_found', 404, ok=False)
        return jsonify({'ok': True, 'job': job.to_dict()})


    @bp.post('/api/fileops/jobs/<job_id>/cancel')
    def api_fileops_cancel_job(job_id: str) -> Any:
        if (resp := _require_enabled()) is not None:
            return resp
        ok = jobmgr.cancel(job_id)
        if not ok:
            return error_response('job_not_found', 404, ok=False)
        return jsonify({'ok': True, 'canceled': True})


    return bp
