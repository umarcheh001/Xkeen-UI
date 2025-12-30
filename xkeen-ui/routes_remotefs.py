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
import base64
import hashlib
import shlex
import threading
import queue
import secrets
from urllib.parse import quote as _url_quote
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple
from pathlib import Path

from flask import Blueprint, request, jsonify, current_app, Response, send_file

# --- core.log helpers (never fail) ---
try:
    from services.logging_setup import core_logger as _get_core_logger
    _CORE_LOGGER = _get_core_logger()
except Exception:
    _CORE_LOGGER = None


def _core_log(level: str, msg: str, **extra) -> None:
    if _CORE_LOGGER is None:
        return
    try:
        if extra:
            try:
                tail = ", ".join(f"{k}={v}" for k, v in extra.items())
            except Exception:
                tail = repr(extra)
            full = f"{msg} | {tail}"
        else:
            full = msg
        fn = getattr(_CORE_LOGGER, str(level or "info").lower(), None)
        if callable(fn):
            fn(full)
        else:
            _CORE_LOGGER.info(full)
    except Exception:
        pass


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
    # Strip ASCII control characters that could break lftp scripts (e.g. CR/LF).
    s = re.sub(r'[\x00-\x1f\x7f]', '', s)
    # Use double quotes + backslash escaping for common specials.
    s = s.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{s}"'


def _sanitize_download_filename(name: str, *, default: str = "download") -> str:
    """Sanitize filename for Content-Disposition header (prevent header injection)."""
    s = (name or "").strip()
    try:
        s = os.path.basename(s)
    except Exception:
        pass
    # Strip header-breaking characters.
    s = s.replace("\r", "").replace("\n", "").replace('"', "")
    if not s:
        s = default
    # Keep header reasonably small.
    if len(s) > 180:
        s = s[:180]
    return s


def _content_disposition_attachment(filename: str) -> str:
    """Build a safe Content-Disposition attachment header value."""
    fn = _sanitize_download_filename(filename)
    # RFC 5987 filename* improves UTF-8 handling in modern browsers.
    try:
        fn_star = _url_quote(fn, safe='')
        return f'attachment; filename="{fn}"; filename*=UTF-8\'\'{fn_star}'
    except Exception:
        return f'attachment; filename="{fn}"'


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
    if tls_raw is None:
        tls_raw = opt.get('tls_verify_mode', None)
    if isinstance(tls_raw, dict):
        tls_mode = str(tls_raw.get('verify', 'none') or 'none').strip().lower()
        ca_file = tls_raw.get('ca_file') or tls_raw.get('tls_ca_file')
    else:
        # backward compat: bool
        if isinstance(tls_raw, bool):
            tls_mode = 'strict' if tls_raw else 'none'
        else:
            tls_mode = str(tls_raw or 'none').strip().lower()
        ca_file = opt.get('tls_ca_file') or opt.get('ca_file')

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
    if not re.match(r"^[bcdlps-][rwxStTs-]{9}[@+.]?$", perm):
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
        # Default allowlist:
        # - /opt/etc : configs (xray/mihomo) and other Entware settings
        # - /opt/var : runtime/cache/logs
        # - /tmp     : RAM disk and mount points (/tmp/mnt)
        roots = ['/opt/etc', '/opt/var', '/tmp']
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
    """Check whether a *resolved* path stays inside one of the allowed roots."""
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


def _local_norm_abs(path: str, roots: List[str]) -> str:
    """Normalize user-supplied local path to an absolute path without resolving symlinks.

    We still enforce a *lexical* containment check (commonpath) against allowed roots
    to prevent obvious `..` escapes. Symlink-escape prevention is handled separately.
    """
    if not roots:
        raise PermissionError('no_local_roots')

    p = (path or '').strip()
    if not p:
        p = roots[0]
    if not p.startswith('/'):
        # treat relative as relative to first root
        p = os.path.join(roots[0], p)

    # Collapse /./ and /../ safely (lexical only; does not resolve symlinks).
    p = os.path.normpath(p)

    # Ensure lexical containment in allowed roots.
    allowed = False
    for root in roots:
        try:
            if os.path.commonpath([p, root]) == root:
                allowed = True
                break
        except Exception:
            continue
    if not allowed:
        raise PermissionError('path_not_allowed')

    return p


def _local_resolve_follow(path: str, roots: List[str]) -> str:
    """Resolve a local path *following* symlinks (realpath), ensuring it stays in roots."""
    ap = _local_norm_abs(path, roots)
    rp = os.path.realpath(ap)
    if not _local_is_allowed(rp, roots):
        raise PermissionError('path_not_allowed')
    return rp


def _local_resolve_nofollow(path: str, roots: List[str]) -> str:
    """Resolve a local path without following the final component.

    Returns a normalized absolute path (no realpath on the final component), while still
    preventing symlink escapes via parent directories:
      - lexical containment check (abs path within roots)
      - realpath(parent) containment check (parents cannot escape via symlinks)

    This is appropriate for operations that must act on the entry itself (rename/unlink),
    not on the symlink target.
    """
    ap = _local_norm_abs(path, roots)

    # If the entry itself is a root, allow (parent would be '/', which may be outside roots).
    for root in roots:
        if ap == root:
            return ap

    parent = os.path.dirname(ap) or '/'
    pr = os.path.realpath(parent)
    if not _local_is_allowed(pr, roots):
        raise PermissionError('path_not_allowed')
    return ap


# --- protected paths (Keenetic /tmp/mnt mount labels) ---
# /tmp/mnt usually contains auto-created mountpoint directories and/or label symlinks.
# Even with safe symlink handling, deleting/renaming these top-level entries is almost
# always a footgun (it can break disk labels in UI and confuse users).
#
# Set XKEEN_PROTECT_MNT_LABELS=0 to disable this protection.
_PROTECT_MNT_LABELS = str(os.getenv('XKEEN_PROTECT_MNT_LABELS', '1') or '1').strip().lower() not in ('0', 'false', 'no', 'off')
_PROTECTED_MNT_ROOT = str(os.getenv('XKEEN_PROTECTED_MNT_ROOT', '/tmp/mnt') or '/tmp/mnt').strip() or '/tmp/mnt'

def _local_is_protected_entry_abs(ap: str) -> bool:
    """Return True if `ap` is a protected mount-label entry (or /tmp/mnt itself)."""
    if not _PROTECT_MNT_LABELS:
        return False
    try:
        apn = os.path.normpath(ap)
    except Exception:
        apn = ap
    try:
        mroot = os.path.normpath(_PROTECTED_MNT_ROOT)
    except Exception:
        mroot = _PROTECTED_MNT_ROOT
    if apn == mroot:
        return True
    try:
        if os.path.dirname(apn) == mroot:
            return True
    except Exception:
        pass
    return False




# Backwards-compatible name used across the codebase: follow symlinks.
def _local_resolve(path: str, roots: List[str]) -> str:
    return _local_resolve_follow(path, roots)
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



def _local_remove_entry(path: str, roots: List[str], *, recursive: bool = True) -> None:
    """Remove a local filesystem entry safely.

    - If `path` is a symlink: remove the symlink itself (never the target).
    - If `path` is a directory: refuse to delete mountpoints; otherwise rmdir/rmtree.
    - Otherwise: unlink the file.

    `roots` enforcement:
      - lexical check for `path` within roots (via _local_norm_abs)
      - realpath(parent) check (prevents symlink escapes in parent components)
      - for non-symlink files/dirs, realpath(path) must also stay within roots.
    """
    ap = _local_resolve_nofollow(path, roots)

    if _local_is_protected_entry_abs(ap):
        raise PermissionError('protected_path')

    try:
        st = os.lstat(ap)
    except FileNotFoundError:
        return

    # Symlink: delete the link itself (do NOT follow).
    try:
        if stat.S_ISLNK(st.st_mode):
            os.unlink(ap)
            return
    except Exception:
        # fall through to best-effort handling
        pass

    # Directory: guard mountpoints.
    try:
        if stat.S_ISDIR(st.st_mode):
            rp = os.path.realpath(ap)
            if not _local_is_allowed(rp, roots):
                raise PermissionError('path_not_allowed')
            try:
                if os.path.ismount(rp):
                    raise PermissionError('refuse_delete_mountpoint')
            except PermissionError:
                raise
            except Exception:
                pass
            if recursive:
                shutil.rmtree(ap)
            else:
                os.rmdir(ap)
            return
    except PermissionError:
        raise
    except Exception:
        # fall through to unlink
        pass

    # File/other: ensure resolved target stays in roots.
    rp = os.path.realpath(ap)
    if not _local_is_allowed(rp, roots):
        raise PermissionError('path_not_allowed')
    os.unlink(ap)


# --- local trash (recycle bin) support ---
# By default, local deletes are *soft* deletes: the entry is moved into TRASH_DIR
# ("Корзина") with a small metadata file that stores the original location.
# When deleting inside the trash directory, we perform a hard delete.

_TRASH_DIR = str(os.getenv('XKEEN_TRASH_DIR', '/opt/var/trash') or '/opt/var/trash').strip() or '/opt/var/trash'
_TRASH_META_DIRNAME = '.xkeen_trashinfo'


# Trash policy:
# - Default max size: 3 GiB (configurable)
# - Auto-purge: delete items older than 30 days (configurable)
# - Never allow overflow: if trash is full or the item is larger than max size,
#   the delete operation becomes a hard delete for that item.
#
# Environment overrides:
#   XKEEN_TRASH_MAX_BYTES / XKEEN_TRASH_MAX_GB
#   XKEEN_TRASH_TTL_DAYS
#   XKEEN_TRASH_WARN_RATIO          (e.g. 0.9)
#   XKEEN_TRASH_STATS_CACHE_SECONDS (e.g. 10)
#   XKEEN_TRASH_PURGE_INTERVAL_SECONDS (e.g. 3600)

_TRASH_MAX_BYTES_DEFAULT = 3 * 1024 * 1024 * 1024
_TRASH_TTL_DAYS_DEFAULT = 30
_TRASH_WARN_RATIO_DEFAULT = 0.90
_TRASH_STATS_CACHE_SECONDS_DEFAULT = 10
_TRASH_PURGE_INTERVAL_SECONDS_DEFAULT = 3600

_TRASH_MAINT_LOCK = threading.Lock()
_TRASH_LAST_PURGE_TS = 0.0
_TRASH_STATS_CACHE: Dict[str, Any] = {'ts': 0.0, 'data': None}

def _read_int_env(name: str, default: int) -> int:
    try:
        v = str(os.getenv(name, '') or '').strip()
        if not v:
            return int(default)
        return int(float(v))
    except Exception:
        return int(default)

def _read_float_env(name: str, default: float) -> float:
    try:
        v = str(os.getenv(name, '') or '').strip()
        if not v:
            return float(default)
        return float(v)
    except Exception:
        return float(default)

def _trash_cfg() -> Dict[str, Any]:
    max_bytes = None
    # Prefer explicit bytes.
    try:
        b = str(os.getenv('XKEEN_TRASH_MAX_BYTES', '') or '').strip()
        if b:
            max_bytes = max(0, int(float(b)))
    except Exception:
        max_bytes = None
    # Fallback: GB
    if max_bytes is None:
        try:
            gb = str(os.getenv('XKEEN_TRASH_MAX_GB', '') or '').strip()
            if gb:
                max_bytes = max(0, int(float(gb) * 1024 * 1024 * 1024))
        except Exception:
            max_bytes = None
    if max_bytes is None or max_bytes <= 0:
        max_bytes = int(_TRASH_MAX_BYTES_DEFAULT)

    ttl_days = _read_int_env('XKEEN_TRASH_TTL_DAYS', _TRASH_TTL_DAYS_DEFAULT)
    if ttl_days < 0:
        ttl_days = 0

    warn_ratio = _read_float_env('XKEEN_TRASH_WARN_RATIO', _TRASH_WARN_RATIO_DEFAULT)
    if warn_ratio <= 0 or warn_ratio > 1.0:
        warn_ratio = float(_TRASH_WARN_RATIO_DEFAULT)

    stats_cache_s = _read_int_env('XKEEN_TRASH_STATS_CACHE_SECONDS', _TRASH_STATS_CACHE_SECONDS_DEFAULT)
    if stats_cache_s < 0:
        stats_cache_s = _TRASH_STATS_CACHE_SECONDS_DEFAULT

    purge_interval_s = _read_int_env('XKEEN_TRASH_PURGE_INTERVAL_SECONDS', _TRASH_PURGE_INTERVAL_SECONDS_DEFAULT)
    if purge_interval_s < 60:
        purge_interval_s = max(60, _TRASH_PURGE_INTERVAL_SECONDS_DEFAULT)

    return {
        'max_bytes': int(max_bytes),
        'ttl_days': int(ttl_days),
        'warn_ratio': float(warn_ratio),
        'stats_cache_seconds': int(stats_cache_s),
        'purge_interval_seconds': int(purge_interval_s),
    }

def _tree_size_bytes(path: str, *, max_items: int = 250_000) -> tuple[int | None, bool]:
    """Best-effort size for a local entry (no symlink following).

    Returns (bytes|None, truncated). If truncated=True or bytes is None, treat as unknown.
    """
    try:
        st = os.lstat(path)
    except Exception:
        return None, True

    try:
        if stat.S_ISREG(st.st_mode) or stat.S_ISLNK(st.st_mode) or stat.S_ISCHR(st.st_mode) or stat.S_ISBLK(st.st_mode) or stat.S_ISFIFO(st.st_mode) or stat.S_ISSOCK(st.st_mode):
            return int(getattr(st, 'st_size', 0) or 0), False
    except Exception:
        pass

    if not stat.S_ISDIR(st.st_mode):
        try:
            return int(getattr(st, 'st_size', 0) or 0), False
        except Exception:
            return None, True

    total = 0
    items = 0
    truncated = False

    def _scan_dir(d: str) -> None:
        nonlocal total, items, truncated
        if truncated:
            return
        try:
            with os.scandir(d) as it:
                for entry in it:
                    if truncated:
                        return
                    items += 1
                    if items > max_items:
                        truncated = True
                        return
                    try:
                        st2 = entry.stat(follow_symlinks=False)
                    except Exception:
                        continue
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            _scan_dir(entry.path)
                        else:
                            total += int(getattr(st2, 'st_size', 0) or 0)
                    except Exception:
                        continue
        except Exception:
            truncated = True

    try:
        _scan_dir(path)
    except Exception:
        truncated = True

    if truncated:
        return None, True
    return int(total), False

def _trash_item_deleted_ts(meta_dir: str, name: str, entry_path: str) -> int | None:
    """Best-effort deleted timestamp for a trash entry."""
    try:
        mp = _trash_meta_path(meta_dir, name)
        if os.path.exists(mp):
            try:
                with open(mp, 'r', encoding='utf-8') as fp:
                    meta = json.load(fp) if fp else {}
                ts = int((meta or {}).get('deleted_ts') or 0)
                if ts > 0:
                    return ts
            except Exception:
                pass
    except Exception:
        pass
    try:
        st = os.lstat(entry_path)
        return int(getattr(st, 'st_mtime', 0) or 0)
    except Exception:
        return None

def _trash_hard_delete_path(p: str) -> bool:
    try:
        if os.path.isdir(p) and not os.path.islink(p):
            shutil.rmtree(p)
        else:
            os.unlink(p)
        return True
    except Exception:
        return False

def _local_trash_purge_expired(roots: List[str], *, ttl_days: int) -> Dict[str, Any]:
    """Delete expired trash entries (older than ttl_days)."""
    if ttl_days <= 0:
        return {'purged': 0, 'meta_purged': 0, 'errors': []}
    try:
        trash_root, meta_dir = _local_trash_dirs(roots)
    except Exception:
        return {'purged': 0, 'meta_purged': 0, 'errors': []}

    now = int(time.time())
    ttl_s = int(ttl_days) * 86400

    purged = 0
    meta_purged = 0
    errors: List[Dict[str, Any]] = []

    # Purge entries
    try:
        with os.scandir(trash_root) as it:
            for entry in it:
                if entry.name == _TRASH_META_DIRNAME:
                    continue
                name = entry.name
                ep = entry.path
                ts = _trash_item_deleted_ts(meta_dir, name, ep)
                if ts is None:
                    continue
                if (now - int(ts)) < ttl_s:
                    continue
                ok = _trash_hard_delete_path(ep)
                if ok:
                    purged += 1
                else:
                    errors.append({'path': ep, 'error': 'delete_failed'})
                # Best-effort remove metadata too
                try:
                    mp = _trash_meta_path(meta_dir, name)
                    if os.path.exists(mp) and _trash_hard_delete_path(mp):
                        meta_purged += 1
                except Exception:
                    pass
    except Exception:
        pass

    # Cleanup orphaned metadata
    try:
        with os.scandir(meta_dir) as it:
            for entry in it:
                try:
                    if not entry.is_file(follow_symlinks=False):
                        continue
                    if not entry.name.endswith('.json'):
                        continue
                    name = entry.name[:-5]
                    if not name:
                        continue
                    if not os.path.exists(os.path.join(trash_root, name)):
                        if _trash_hard_delete_path(entry.path):
                            meta_purged += 1
                except Exception:
                    continue
    except Exception:
        pass

    return {'purged': int(purged), 'meta_purged': int(meta_purged), 'errors': errors}

def _local_trash_used_bytes(roots: List[str], *, max_items: int = 500_000) -> tuple[int | None, bool]:
    """Compute total bytes currently stored in trash (excluding metadata dir)."""
    try:
        trash_root, _meta = _local_trash_dirs(roots)
    except Exception:
        return None, True

    total = 0
    items = 0
    truncated = False

    def _scan(p: str) -> None:
        nonlocal total, items, truncated
        if truncated:
            return
        try:
            st = os.lstat(p)
        except Exception:
            truncated = True
            return
        try:
            if stat.S_ISDIR(st.st_mode) and not os.path.islink(p):
                with os.scandir(p) as it:
                    for e in it:
                        if truncated:
                            return
                        # skip metadata dir anywhere (just in case)
                        if e.name == _TRASH_META_DIRNAME:
                            continue
                        items += 1
                        if items > max_items:
                            truncated = True
                            return
                        _scan(e.path)
            else:
                total += int(getattr(st, 'st_size', 0) or 0)
        except Exception:
            truncated = True

    try:
        with os.scandir(trash_root) as it:
            for entry in it:
                if entry.name == _TRASH_META_DIRNAME:
                    continue
                items += 1
                if items > max_items:
                    truncated = True
                    break
                _scan(entry.path)
    except Exception:
        truncated = True

    if truncated:
        return None, True
    return int(total), False

def _local_trash_stats(roots: List[str], *, force_refresh: bool = False, force_purge: bool = False) -> Dict[str, Any]:
    """Return cached trash stats and run periodic maintenance (auto-purge)."""
    cfg = _trash_cfg()
    now = float(time.time())
    max_bytes = int(cfg['max_bytes'])

    with _TRASH_MAINT_LOCK:
        global _TRASH_LAST_PURGE_TS
        cache_ts = float(_TRASH_STATS_CACHE.get('ts') or 0.0)
        cache_data = _TRASH_STATS_CACHE.get('data')

        purged_info: Dict[str, Any] | None = None

        if force_purge or (now - float(_TRASH_LAST_PURGE_TS or 0.0) > float(cfg['purge_interval_seconds'])):
            purged_info = _local_trash_purge_expired(roots, ttl_days=int(cfg['ttl_days']))
            _TRASH_LAST_PURGE_TS = now
            # After purge, refresh stats
            force_refresh = True

        if (not force_refresh) and cache_data and (now - cache_ts) <= float(cfg['stats_cache_seconds']):
            # attach last purge info if we did it in this call
            if purged_info is not None:
                try:
                    cache_data = dict(cache_data)
                    cache_data['purge'] = purged_info
                except Exception:
                    pass
            return cache_data

        used, trunc = _local_trash_used_bytes(roots)
        used_i = int(used or 0) if used is not None else None

        pct = None
        if used_i is not None and max_bytes > 0:
            try:
                pct = float(used_i) / float(max_bytes)
            except Exception:
                pct = None

        is_full = bool(used_i is not None and max_bytes > 0 and used_i >= max_bytes)
        is_near = bool(pct is not None and pct >= float(cfg['warn_ratio']))

        data = {
            'max_bytes': max_bytes,
            'ttl_days': int(cfg['ttl_days']),
            'used_bytes': used_i,
            'truncated': bool(trunc),
            'percent': (round(pct * 100.0, 1) if pct is not None else None),
            'ratio': pct,
            'is_full': is_full,
            'is_near_full': is_near,
            'purge': purged_info,
            'ts': int(now),
        }

        _TRASH_STATS_CACHE['ts'] = now
        _TRASH_STATS_CACHE['data'] = data
        return data


def _local_trash_dirs(roots: List[str]) -> tuple[str, str]:
    """Return (trash_root_abs, meta_dir_abs), ensuring they are allowed and exist."""
    # Enforce that trash is inside the local allowlist roots.
    trash_ap = _local_norm_abs(_TRASH_DIR, roots)
    # Parent must stay inside roots (prevents symlink escapes in parent components).
    _ = _local_resolve_nofollow(trash_ap, roots)

    # Do not allow trash to be a protected mount-label entry.
    if _local_is_protected_entry_abs(trash_ap):
        raise PermissionError('protected_path')

    meta_dir = os.path.join(trash_ap, _TRASH_META_DIRNAME)
    try:
        os.makedirs(meta_dir, exist_ok=True)
        os.makedirs(trash_ap, exist_ok=True)
    except Exception:
        # Re-raise as a predictable error; UI will show it in job error field.
        raise RuntimeError('trash_unavailable')
    return trash_ap, meta_dir


def _local_is_in_trash_abs(ap: str, roots: List[str]) -> bool:
    """Return True if an absolute, normalized path is under the trash root (lexical check)."""
    try:
        trash_ap = _local_norm_abs(_TRASH_DIR, roots)
        apn = os.path.normpath(ap)
        tn = os.path.normpath(trash_ap)
        return os.path.commonpath([apn, tn]) == tn
    except Exception:
        return False


def _trash_safe_name(base: str) -> str:
    s = (base or 'item').replace('/', '_').replace('\x00', '')
    # Keep reasonably short to avoid NAME_MAX issues on embedded FS.
    if len(s) > 120:
        s = s[:120]
    return s


def _trash_meta_path(meta_dir: str, trash_name: str) -> str:
    return os.path.join(meta_dir, f"{trash_name}.json")


def _next_available_path(dst_path: str) -> str:
    """Return a non-existing path by adding " (restored N)" before extension."""
    if not os.path.exists(dst_path):
        return dst_path
    ddir = os.path.dirname(dst_path) or '.'
    base = os.path.basename(dst_path)
    stem, ext = os.path.splitext(base)
    for i in range(2, 10000):
        cand = os.path.join(ddir, f"{stem} (restored {i}){ext}")
        if not os.path.exists(cand):
            return cand
    raise RuntimeError('dst_name_exhausted')


def _local_move_to_trash(path: str, roots: List[str]) -> Dict[str, Any]:
    """Move a local entry to trash and write metadata for restore."""
    ap = _local_resolve_nofollow(path, roots)

    if _local_is_protected_entry_abs(ap):
        raise PermissionError('protected_path')

    # Do not allow trashing of allowlist roots themselves.
    for r in roots:
        try:
            if os.path.normpath(ap) == os.path.normpath(r):
                raise PermissionError('refuse_trash_root')
        except PermissionError:
            raise
        except Exception:
            continue

    trash_root, meta_dir = _local_trash_dirs(roots)

    # Refuse moving the trash directory itself or its meta dir.
    try:
        apn = os.path.normpath(ap)
        tn = os.path.normpath(trash_root)
        mn = os.path.normpath(meta_dir)
        if apn == tn or apn == mn or os.path.commonpath([apn, mn]) == mn:
            raise PermissionError('refuse_trash_internal')
    except PermissionError:
        raise
    except Exception:
        pass

    # Already in trash => treat as hard delete (caller decides).
    if _local_is_in_trash_abs(ap, roots):
        raise RuntimeError('already_in_trash')

    base = _trash_safe_name(os.path.basename(ap.rstrip('/')) or 'item')
    ts = int(time.time())
    uid = uuid.uuid4().hex[:8]

    # Ensure unique name.
    for attempt in range(40):
        suffix = uid if attempt == 0 else (uid + '-' + uuid.uuid4().hex[:4])
        trash_name = f"{base}.{ts}.{suffix}"
        dst = os.path.join(trash_root, trash_name)
        if not os.path.exists(dst):
            break
    else:
        raise RuntimeError('trash_name_exhausted')

    # Move (rename when possible, copy+delete across FS).
    shutil.move(ap, dst)

    meta = {
        'orig_path': ap,
        'trash_name': trash_name,
        'deleted_ts': ts,
    }
    try:
        with open(_trash_meta_path(meta_dir, trash_name), 'w', encoding='utf-8') as fp:
            json.dump(meta, fp, ensure_ascii=False)
    except Exception:
        # Metadata failure should not lose user's data; best-effort ignore.
        pass

    return {'trash_path': dst, 'trash_name': trash_name, 'orig_path': ap}



def _local_soft_delete(path: str, roots: List[str], *, hard: bool = False) -> Dict[str, Any]:
    """Default delete behavior for local FS: move to trash (soft delete).

    Policy:
      - If hard=True OR the target is already inside the trash directory -> hard delete.
      - Auto-purge expired trash entries (TTL).
      - If trash is full OR the entry is larger than the trash limit -> hard delete (do not overflow).
    """
    ap = _local_resolve_nofollow(path, roots)

    # Deleting inside trash (or explicit permanent) always means hard delete.
    if hard or _local_is_in_trash_abs(ap, roots):
        _local_remove_entry(ap, roots, recursive=True)
        return {'mode': 'hard', 'path': ap, 'reason': 'permanent'}

    # Run periodic purge and get fresh stats for decision making.
    stats = _local_trash_stats(roots, force_refresh=True, force_purge=False)
    max_bytes = int(stats.get('max_bytes') or _TRASH_MAX_BYTES_DEFAULT)

    # Determine entry size (best-effort). If unknown -> refuse moving to trash (avoid overflow).
    item_bytes, trunc = _tree_size_bytes(ap)
    if item_bytes is None or trunc:
        _local_remove_entry(ap, roots, recursive=True)
        return {
            'mode': 'hard',
            'path': ap,
            'reason': 'too_large_for_trash',
            'item_bytes': None,
            'trash': stats,
        }

    if item_bytes > max_bytes:
        _local_remove_entry(ap, roots, recursive=True)
        return {
            'mode': 'hard',
            'path': ap,
            'reason': 'too_large_for_trash',
            'item_bytes': int(item_bytes),
            'trash': stats,
        }

    used = stats.get('used_bytes')
    # If used is unknown/truncated, be safe and treat as full.
    if used is None or bool(stats.get('truncated')):
        _local_remove_entry(ap, roots, recursive=True)
        return {
            'mode': 'hard',
            'path': ap,
            'reason': 'trash_full',
            'item_bytes': int(item_bytes),
            'trash': stats,
        }

    used_i = int(used or 0)
    if used_i + int(item_bytes) > max_bytes:
        _local_remove_entry(ap, roots, recursive=True)
        return {
            'mode': 'hard',
            'path': ap,
            'reason': 'trash_full',
            'item_bytes': int(item_bytes),
            'trash': stats,
        }

    info = _local_move_to_trash(ap, roots)
    info['mode'] = 'trash'
    info['item_bytes'] = int(item_bytes)
    # refresh stats after move (best-effort; cached)
    try:
        info['trash'] = _local_trash_stats(roots, force_refresh=True, force_purge=False)
    except Exception:
        info['trash'] = stats
    return info


def _local_restore_from_trash(path: str, roots: List[str]) -> Dict[str, Any]:
    """Restore a trashed entry back to its original path (or a non-conflicting variant)."""
    trash_root, meta_dir = _local_trash_dirs(roots)

    ap = _local_resolve_nofollow(path, roots)
    if not _local_is_in_trash_abs(ap, roots):
        raise PermissionError('not_in_trash')

    name = os.path.basename(ap.rstrip('/'))
    if not name or name in ('.', '..'):
        raise RuntimeError('bad_trash_entry')

    meta_path = _trash_meta_path(meta_dir, name)
    if not os.path.exists(meta_path):
        raise RuntimeError('no_trash_metadata')

    try:
        with open(meta_path, 'r', encoding='utf-8') as fp:
            meta = json.load(fp)
    except Exception:
        raise RuntimeError('bad_trash_metadata')

    orig = str((meta or {}).get('orig_path') or '').strip()
    if not orig:
        raise RuntimeError('bad_trash_metadata')

    # Validate destination is within roots and parents do not escape via symlinks.
    dst = _local_resolve_nofollow(orig, roots)

    # Ensure destination directory exists.
    try:
        parent = os.path.dirname(dst) or '/'
        os.makedirs(parent, exist_ok=True)
    except Exception:
        pass

    dst_final = _next_available_path(dst)

    # Move back.
    shutil.move(ap, dst_final)

    # Remove metadata (best-effort).
    try:
        os.remove(meta_path)
    except Exception:
        pass

    return {'from': ap, 'to': dst_final, 'orig': orig}
@dataclass
class RemoteFsSession:
    session_id: str
    protocol: str
    host: str
    port: int
    username: str
    auth_type: str
    options: Dict[str, Any]
    created_ts: float
    last_used_ts: float
    # For password auth
    password: str = ''
    # For SFTP key auth
    key_path: str = ''           # path on device (or temp file)
    key_is_temp: bool = False    # whether key_path should be deleted on session close
    # Optional: passphrase via SSH_ASKPASS (stored only in RAM; helper file is temp)
    askpass_path: str = ''
    env: Dict[str, str] | None = None


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
                s = self._sessions.pop(sid, None)
                if s:
                    self._cleanup_session_secrets(s)

    def _cleanup_session_secrets(self, s: RemoteFsSession) -> None:
        """Best-effort removal of temp secret material (uploaded private keys / askpass helpers)."""
        # Uploaded private key (temp file)
        try:
            if s.key_is_temp and s.key_path and os.path.isfile(s.key_path):
                os.remove(s.key_path)
        except Exception:
            pass
        # SSH_ASKPASS helper script (temp file)
        try:
            if s.askpass_path and os.path.isfile(s.askpass_path):
                os.remove(s.askpass_path)
        except Exception:
            pass

    def _touch(self, sid: str) -> None:
        with self._lock:
            s = self._sessions.get(sid)
            if s:
                s.last_used_ts = _now()

    def get(self, sid: str) -> Optional[RemoteFsSession]:
        self.cleanup()
        with self._lock:
            return self._sessions.get(sid)

    def create(self, protocol: str, host: str, port: int, username: str, auth_type: str, auth: Dict[str, Any], options: Dict[str, Any]) -> RemoteFsSession:
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
                options=options,
                created_ts=_now(),
                last_used_ts=_now(),
            )

            # --- Auth material (never persisted except temp files under /tmp) ---
            if auth_type == 'password':
                s.password = str(auth.get('password', '') or '')
            elif auth_type == 'key':
                # key_path: existing path on device, OR uploaded key data -> temp file
                key_path = str(auth.get('key_path', '') or '').strip()
                key_data = auth.get('key_data') or auth.get('key')
                if key_data and isinstance(key_data, (bytes, bytearray)):
                    key_data = key_data.decode('utf-8', errors='replace')
                key_data = str(key_data or '')

                if key_data:
                    # Write key to a private temp file (0600) and delete on session close.
                    tmp_key = os.path.join(self.tmp_dir or '/tmp', f"rfs_key_{sid}.key")
                    os.makedirs(os.path.dirname(tmp_key) or '.', exist_ok=True)
                    with open(tmp_key, 'w', encoding='utf-8') as f:
                        f.write(key_data)
                        if not key_data.endswith('\n'):
                            f.write('\n')
                    try:
                        os.chmod(tmp_key, 0o600)
                    except Exception:
                        pass
                    s.key_path = tmp_key
                    s.key_is_temp = True
                else:
                    s.key_path = key_path
                    s.key_is_temp = False

                passphrase = str(auth.get('passphrase', '') or '')
                if passphrase:
                    # SSH_ASKPASS helper (Python) + env, lives only for the session.
                    askpass = os.path.join(self.tmp_dir or '/tmp', f"rfs_askpass_{sid}.py")
                    os.makedirs(os.path.dirname(askpass) or '.', exist_ok=True)
                    with open(askpass, 'w', encoding='utf-8') as f:
                        f.write(
                            "#!/usr/bin/env python3\n"
                            "import os, base64, sys\n"
                            "b = os.environ.get('RFS_PASSPHRASE_B64','')\n"
                            "try:\n"
                            "    sys.stdout.write(base64.b64decode(b.encode()).decode('utf-8', errors='ignore'))\n"
                            "except Exception:\n"
                            "    pass\n"
                        )
                    try:
                        os.chmod(askpass, 0o700)
                    except Exception:
                        pass
                    s.askpass_path = askpass
                    s.env = {
                        'DISPLAY': '1',
                        'SSH_ASKPASS': askpass,
                        'SSH_ASKPASS_REQUIRE': 'force',
                        'RFS_PASSPHRASE_B64': base64.b64encode(passphrase.encode('utf-8')).decode('ascii'),
                    }

            self._sessions[sid] = s
            return s

    def close(self, sid: str) -> bool:
        with self._lock:
            s = self._sessions.pop(sid, None)
            if s:
                self._cleanup_session_secrets(s)
            return s is not None

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
                connect_prog = "ssh -a -x -oLogLevel=ERROR " \
                               f"-oUserKnownHostsFile={shlex.quote(kh)} -oGlobalKnownHostsFile=/dev/null -oStrictHostKeyChecking={strict}"

                # SFTP key auth: add identity file and force IdentitiesOnly for predictability.
                if s.auth_type == 'key' and s.key_path:
                    connect_prog += f" -oIdentitiesOnly=yes -i {shlex.quote(s.key_path)}"

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
        if s.auth_type == "password":
            parts.append(
                f"open -u {_lftp_quote(s.username)},{_lftp_quote(s.password)} {url}"
            )
        elif s.auth_type == 'key' and s.protocol == 'sftp':
            # Put username into URL for broad lftp compatibility.
            user_enc = _url_quote(s.username, safe='')
            parts.append(
                f"open sftp://{user_enc}@{s.host}:{int(s.port)}"
            )
        else:
            raise RuntimeError("unsupported_auth")

        parts.extend(commands)
        parts.append("bye")
        return "; ".join(parts)

    def _run_lftp(self, s: RemoteFsSession, commands: List[str], *, capture: bool = True) -> Tuple[int, bytes, bytes]:
        script = self._build_lftp_script(s, commands)
        env = os.environ.copy()
        env.setdefault("LC_ALL", "C")
        env.setdefault("LANG", "C")
        try:
            if s.env:
                env.update({k: str(v) for k, v in s.env.items() if v is not None})
        except Exception:
            pass

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
        try:
            if s.env:
                env.update({k: str(v) for k, v in s.env.items() if v is not None})
        except Exception:
            pass
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
    return_mgr: bool = False,
) -> Blueprint | Tuple[Blueprint, RemoteFsManager]:
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
                    "auth_types": ["password", "key"],
                    "supports_key_upload": True,
                    "supports_key_path": True,
                    "supports_passphrase": True,
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
                    "chown": True,
                    "chown_protocols": ["sftp"],
                    "touch": True,
                    "stat_batch": True,
                },
            },
        })

    # --------------------------- known_hosts helpers & UI endpoints ---------------------------

    def _ssh_key_fingerprint_sha256(key_b64: str) -> str:
        """Compute OpenSSH-like SHA256 fingerprint from base64 key blob."""
        try:
            blob = base64.b64decode((key_b64 or '').encode('ascii'), validate=False)
            h = hashlib.sha256(blob).digest()
            return 'SHA256:' + base64.b64encode(h).decode('ascii').rstrip('=')
        except Exception:
            return ''

    def _read_known_hosts_entries(path: str) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        try:
            _ensure_known_hosts_file(path)
            with open(path, 'r', encoding='utf-8', errors='replace') as f:
                lines = f.read().splitlines()
        except Exception:
            return out

        for idx, raw in enumerate(lines):
            line = (raw or '').strip()
            if not line or line.startswith('#'):
                continue
            # known_hosts format: hosts keytype key [comment]
            parts = line.split()
            if len(parts) < 3:
                out.append({
                    'idx': idx,
                    'hosts': parts[0] if parts else '',
                    'key_type': parts[1] if len(parts) > 1 else '',
                    'fingerprint': '',
                    'comment': ' '.join(parts[3:]) if len(parts) > 3 else '',
                    'raw': raw,
                    'bad': True,
                })
                continue
            hosts, key_type, key_b64 = parts[0], parts[1], parts[2]
            fp = _ssh_key_fingerprint_sha256(key_b64)
            out.append({
                'idx': idx,
                'hosts': hosts,
                'key_type': key_type,
                'fingerprint': fp,
                'comment': ' '.join(parts[3:]) if len(parts) > 3 else '',
                'raw': raw,
                'hashed': hosts.startswith('|1|'),
                'bad': False if fp else True,
            })
        return out

    @bp.get('/api/remotefs/known_hosts')
    def api_remotefs_known_hosts_list() -> Any:
        if (resp := _require_enabled()) is not None:
            return resp
        kh = (mgr.known_hosts_path or '').strip()
        if not kh:
            return error_response('known_hosts_unavailable', 404, ok=False)
        entries = _read_known_hosts_entries(kh)
        return jsonify({'ok': True, 'path': kh, 'entries': entries})

    @bp.get('/api/remotefs/known_hosts/fingerprint')
    def api_remotefs_known_hosts_fingerprint() -> Any:
        if (resp := _require_enabled()) is not None:
            return resp
        kh = (mgr.known_hosts_path or '').strip()
        if not kh:
            return error_response('known_hosts_unavailable', 404, ok=False)
        host = str(request.args.get('host', '') or '').strip()
        if not host:
            return error_response('host_required', 400, ok=False)
        port_raw = str(request.args.get('port', '') or '').strip()
        try:
            port = int(port_raw) if port_raw else 22
        except Exception:
            port = 22

        # Match entries by hosts field tokens.
        want_tokens = set()
        if port and int(port) != 22:
            want_tokens.add(f'[{host}]:{int(port)}')
        want_tokens.add(host)

        matches: List[Dict[str, Any]] = []
        for e in _read_known_hosts_entries(kh):
            hosts_field = str(e.get('hosts') or '')
            tokens = set([t.strip() for t in hosts_field.split(',') if t.strip()])
            if tokens & want_tokens:
                matches.append({'idx': e.get('idx'), 'hosts': hosts_field, 'key_type': e.get('key_type'), 'fingerprint': e.get('fingerprint'), 'comment': e.get('comment')})

        return jsonify({'ok': True, 'path': kh, 'host': host, 'port': port, 'matches': matches})

    @bp.post('/api/remotefs/known_hosts/clear')
    def api_remotefs_known_hosts_clear() -> Any:
        if (resp := _require_enabled()) is not None:
            return resp
        kh = (mgr.known_hosts_path or '').strip()
        if not kh:
            return error_response('known_hosts_unavailable', 404, ok=False)
        try:
            _ensure_known_hosts_file(kh)
            with open(kh, 'w', encoding='utf-8') as f:
                f.write('')
            try:
                os.chmod(kh, 0o600)
            except Exception:
                pass
            _core_log("info", "remotefs.known_hosts_clear", path=kh, remote_addr=str(request.remote_addr or ""))
            return jsonify({'ok': True, 'path': kh})
        except Exception:
            return error_response('clear_failed', 500, ok=False)

    @bp.post('/api/remotefs/known_hosts/delete')
    def api_remotefs_known_hosts_delete() -> Any:
        if (resp := _require_enabled()) is not None:
            return resp
        kh = (mgr.known_hosts_path or '').strip()
        if not kh:
            return error_response('known_hosts_unavailable', 404, ok=False)
        data = request.get_json(silent=True) or {}
        idx = data.get('idx', None)
        host = str(data.get('host', '') or '').strip()
        port = data.get('port', None)

        def _read_all_lines() -> List[str]:
            try:
                _ensure_known_hosts_file(kh)
                with open(kh, 'r', encoding='utf-8', errors='replace') as f:
                    return f.read().splitlines()
            except Exception:
                return []

        def _write_all_lines(lines: List[str]) -> None:
            _ensure_known_hosts_file(kh)
            with open(kh, 'w', encoding='utf-8') as f:
                f.write('\n'.join(lines) + ('\n' if lines else ''))
            try:
                os.chmod(kh, 0o600)
            except Exception:
                pass

        # Prefer robust deletion by host (handles hashed entries) if host provided.
        if host:
            target = host
            if port is not None:
                try:
                    p = int(port)
                    if p != 22:
                        target = f'[{host}]:{p}'
                except Exception:
                    target = host

            before = _read_all_lines()
            before_n = len(before)

            # 1) Try ssh-keygen -R (best effort, supports hashed entries)
            try:
                subprocess.run(['ssh-keygen', '-R', target, '-f', kh], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                after = _read_all_lines()
                deleted_count = max(0, before_n - len(after))
                try:
                    os.chmod(kh, 0o600)
                except Exception:
                    pass
                return jsonify({'ok': True, 'path': kh, 'target': target, 'deleted_count': deleted_count, 'method': 'ssh-keygen'})
            except Exception:
                pass

            # 2) Fallback: remove non-hashed entries by token match in the hosts field.
            deleted_count = 0
            new_lines: List[str] = []
            for raw in before:
                line = (raw or '').strip()
                if not line or line.startswith('#'):
                    new_lines.append(raw)
                    continue
                parts = line.split()
                if not parts:
                    new_lines.append(raw)
                    continue
                hosts_field = parts[0]
                tokens = [t.strip() for t in hosts_field.split(',') if t.strip()]
                if target in tokens:
                    deleted_count += 1
                    continue
                new_lines.append(raw)

            try:
                if deleted_count:
                    _write_all_lines(new_lines)
                else:
                    # Ensure file exists with safe perms.
                    _ensure_known_hosts_file(kh)
            except Exception:
                return error_response('delete_failed', 500, ok=False)

            _core_log("info", "remotefs.known_hosts_delete", method="manual", target=target, deleted_count=int(deleted_count), path=kh, remote_addr=str(request.remote_addr or ""))
            return jsonify({'ok': True, 'path': kh, 'target': target, 'deleted_count': deleted_count, 'method': 'manual'})

        if idx is None:
            return error_response('idx_or_host_required', 400, ok=False)

        try:
            idx_i = int(idx)
        except Exception:
            return error_response('bad_idx', 400, ok=False)

        try:
            lines = _read_all_lines()
            if idx_i < 0 or idx_i >= len(lines):
                return error_response('idx_out_of_range', 400, ok=False)
            lines.pop(idx_i)
            _write_all_lines(lines)
            _core_log("info", "remotefs.known_hosts_delete", method="idx", idx=idx_i, deleted_count=1, path=kh, remote_addr=str(request.remote_addr or ""))
            return jsonify({'ok': True, 'path': kh, 'deleted_count': 1})
        except Exception:
            return error_response('delete_failed', 500, ok=False)

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

        port_raw = data.get("port")
        default_port = 22 if protocol == "sftp" else 21
        try:
            if port_raw is None or str(port_raw).strip() == '':
                port = int(default_port)
            else:
                port = int(port_raw)
        except Exception:
            return error_response("bad_port", 400, ok=False)
        if port <= 0 or port > 65535:
            return error_response("bad_port", 400, ok=False)
        username = str(data.get("username", "")).strip()
        if not username:
            return error_response("username_required", 400, ok=False)

        auth = data.get("auth") or {}
        auth_type = str(auth.get("type", "password")).strip().lower()
        if auth_type not in ("password", "key"):
            return error_response("unsupported_auth", 400, ok=False)

        # Auth validation (keep backend strict; UI can guide users)
        if auth_type == "password":
            password = str(auth.get("password", ""))
            if not password:
                return error_response("password_required", 400, ok=False)
        else:
            # key auth is only supported for SFTP
            if protocol != 'sftp':
                return error_response("unsupported_auth", 400, ok=False)
            key_path = str(auth.get('key_path', '') or '').strip()
            key_data = auth.get('key_data') or auth.get('key')
            if key_data and isinstance(key_data, (bytes, bytearray)):
                key_data = key_data.decode('utf-8', errors='replace')
            key_data = str(key_data or '')
            if not key_path and not key_data:
                return error_response("key_required", 400, ok=False)
            # Basic guardrails (avoid huge JSON payloads)
            if key_data and len(key_data) > 128_000:
                return error_response("key_too_large", 400, ok=False)
            password = ''

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
            # Pass auth dict to manager (keeps secrets in RAM, uploaded keys in temp files)
            s = mgr.create(protocol, host, port, username, auth_type, auth, options)
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
            _core_log("warning", "remotefs.session_create_failed", protocol=protocol, host=host, port=port, username=username, kind=info.get("kind"), hint=info.get("hint"))
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

        _core_log("info", "remotefs.session_create", sid=s.session_id, protocol=s.protocol, host=s.host, port=s.port, username=s.username, auth=auth_type)

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
        _core_log("info", "remotefs.session_close", sid=sid, closed=bool(closed))
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
        _core_log("info", "remotefs.mkdir", sid=sid, path=path, parents=bool(parents))
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
        _core_log("info", "remotefs.rename", sid=sid, src=src, dst=dst)
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
            _core_log("info", "remotefs.remove", sid=sid, path=path, recursive=True)
            _core_log("info", "remotefs.remove", sid=sid, path=path, recursive=False, rmdir=True)
        return jsonify({"ok": True})

        # non-recursive: try rm then rmdir
        rc, out, err = mgr._run_lftp(s, [f"rm {_lftp_quote(path)}"], capture=True)
        if rc == 0:
            _core_log("info", "remotefs.remove", sid=sid, path=path, recursive=False)
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
            "Content-Disposition": _content_disposition_attachment(filename),
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
            _core_log("info", "remotefs.upload", sid=sid, path=remote_path, bytes=int(total))
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
        """Resolve local path following symlinks (content operations)."""
        try:
            return _local_resolve_follow(path, LOCALFS_ROOTS)
        except PermissionError as e:
            raise RuntimeError(str(e))

    def _ensure_local_path_allowed_nofollow(path: str) -> str:
        """Resolve local path without following the final component (rename/unlink)."""
        try:
            return _local_resolve_nofollow(path, LOCALFS_ROOTS)
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


    def _parse_df_free_bytes(text: str) -> int | None:
        """Parse lftp `df` output and return available bytes (best-effort).

        We expect something similar to POSIX df output, but formats vary by protocol.
        """
        try:
            lines = [ln.strip() for ln in (text or '').splitlines() if ln.strip()]
            if not lines:
                return None
            # Drop header-like lines
            data_lines = [ln for ln in lines if not re.search(r"\bFilesystem\b|\bMounted\b|\bUse%\b", ln, re.I)]
            if not data_lines:
                data_lines = lines[-1:]

            # Use the last data line
            ln = data_lines[-1]
            parts = re.split(r"\s+", ln)
            # Extract purely integer tokens
            nums: List[int] = []
            for tok in parts:
                if tok.isdigit():
                    try:
                        nums.append(int(tok))
                    except Exception:
                        pass
            # Typical: <fs> <blocks> <used> <avail> <use%> <mnt>
            if len(nums) >= 3:
                return int(nums[2])
            # Sometimes: <blocks> <used> <avail> ...
            if len(nums) == 2:
                # no reliable mapping
                return None
            return None
        except Exception:
            return None


    def _remote_free_bytes(sess: RemoteFsSession, path: str) -> int | None:
        """Return free bytes on remote filesystem for a given path (best-effort).

        If protocol/server doesn't support df, returns None.
        """
        p = str(path or '').strip() or '.'
        # Try byte-precise first; fall back to KiB blocks.
        for cmd, mul in ((f"df -B1 {_lftp_quote(p)}", 1), (f"df -k {_lftp_quote(p)}", 1024)):
            try:
                rc, out, err = mgr._run_lftp(sess, [cmd], capture=True)
                if rc != 0:
                    continue
                txt = (out or b'').decode('utf-8', errors='replace')
                avail = _parse_df_free_bytes(txt)
                if avail is None:
                    continue
                return int(avail) * int(mul)
            except Exception:
                continue
        return None


    def _remote_du_bytes(sess: RemoteFsSession, path: str) -> int | None:
        """Best-effort remote directory size in bytes.

        Works only when lftp supports `du -b` for the given protocol.
        """
        p = str(path or '').strip() or '.'
        # Prefer explicit bytes.
        for cmd in (f"du -sb {_lftp_quote(p)}", f"du -s -b {_lftp_quote(p)}"):
            try:
                rc, out, err = mgr._run_lftp(sess, [cmd], capture=True)
                if rc != 0:
                    continue
                txt = (out or b'').decode('utf-8', errors='replace')
                m = re.search(r"(^|\s)(\d+)(\s|$)", txt.strip())
                if m:
                    return int(m.group(2))
            except Exception:
                continue
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

        # Free space check on remote destination before mirror/put (best-effort).
        # Enabled by default; silently skipped if protocol/server doesn't support `df`.
        check_free_space = bool(opts.get('check_free_space', True))

        def _check_remote_free(ds_sess: RemoteFsSession, dst_path: str, need_bytes: int, *, label: str = 'remote') -> None:
            if not check_free_space:
                return
            try:
                nb = int(need_bytes or 0)
            except Exception:
                nb = 0
            if nb <= 0:
                return
            try:
                free_b = _remote_free_bytes(ds_sess, dst_path)
            except Exception:
                free_b = None
            if free_b is None:
                return
            if int(free_b) < nb:
                # Attach some context for UI/logs.
                try:
                    _progress_set(job, current={
                        'path': str(dst_path),
                        'name': os.path.basename(str(dst_path).rstrip('/')) or str(dst_path),
                        'phase': 'precheck',
                        'is_dir': True,
                    },
                    check={'need_bytes': int(nb), 'free_bytes': int(free_b), 'where': str(label)})
                except Exception:
                    pass
                raise RuntimeError('remote_no_space')

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
                        dp_abs = _ensure_local_path_allowed_nofollow(dpath)
                        os.makedirs(os.path.dirname(dp_abs) or '/tmp', exist_ok=True)
                        dpath = dp_abs
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
                        sp = _ensure_local_path_allowed_nofollow(spath)
                        dp = _ensure_local_path_allowed_nofollow(dpath)

                        # Protect Keenetic /tmp/mnt mount labels from being moved/renamed.
                        if _local_is_protected_entry_abs(sp) or _local_is_protected_entry_abs(dp):
                            raise RuntimeError('protected_path')

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
                                _local_remove_entry(dp, LOCALFS_ROOTS, recursive=True)
                            except PermissionError as e:
                                raise RuntimeError(str(e))
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
                    dp = _ensure_local_path_allowed_nofollow(dpath)
                    if _local_is_protected_entry_abs(dp):
                        raise RuntimeError('protected_path')
                    # overwrite policy
                    if os.path.exists(dp):
                        action = _decide_overwrite_action(spath=str(spath), sname=str(sname), dpath=str(dp))
                        if action == 'skip':
                            mark_done();
                            continue
                        try:
                            _local_remove_entry(dp, LOCALFS_ROOTS, recursive=True)
                        except PermissionError as e:
                            raise RuntimeError(str(e))
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
                        # Pre-check free space on remote destination (best-effort).
                        try:
                            need_b = _dir_size_bytes(sp)
                            _check_remote_free(ds, dpath, int(need_b), label=f"{ds.protocol}://{ds.host}")
                        except RuntimeError:
                            raise
                        except Exception:
                            pass
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
                        # Pre-check free space on remote destination (best-effort).
                        try:
                            if size_total:
                                _check_remote_free(ds, dpath, int(size_total), label=f"{ds.protocol}://{ds.host}")
                        except RuntimeError:
                            raise
                        except Exception:
                            pass
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
                    dp = _ensure_local_path_allowed_nofollow(dpath)

                    # COPY onto itself is a common UX case when both panels point to the same dir.
                    # Never delete the source; instead, auto-pick a free "(2)/(3)…" name.
                    if _same_local(sp, dp):
                        dp = _next_copy_path_local(dp)

                    if _local_is_protected_entry_abs(dp):
                        raise RuntimeError('protected_path')

                    if os.path.exists(dp):
                        action = _decide_overwrite_action(spath=str(spath), sname=str(sname), dpath=str(dp))
                        if action == 'skip':
                            mark_done();
                            continue
                        try:
                            _local_remove_entry(dp, LOCALFS_ROOTS, recursive=True)
                        except PermissionError as e:
                            raise RuntimeError(str(e))
                        except Exception:
                            pass
                    if is_dir:
                        shutil.copytree(sp, dp, dirs_exist_ok=True, symlinks=True, ignore_dangling_symlinks=True)
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
                                # Pre-check free space on destination (best-effort).
                                try:
                                    need_b = _remote_du_bytes(ss, spath) or 0
                                    if need_b:
                                        _check_remote_free(ds, dpath, int(need_b), label=f"{ds.protocol}://{ds.host}")
                                except RuntimeError:
                                    raise
                                except Exception:
                                    pass
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
                            # Pre-check free space on destination before mirror -R (best-effort).
                            try:
                                need_b = int(last_sz or 0) or _dir_size_bytes(tmpd)
                                if need_b:
                                    _check_remote_free(ds, dpath, int(need_b), label=f"{ds.protocol}://{ds.host}")
                            except RuntimeError:
                                raise
                            except Exception:
                                pass
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
                        try:
                            _local_remove_entry(spath, LOCALFS_ROOTS, recursive=True)
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

        trash_summary = {'moved': 0, 'permanent': 0, 'trash_full': 0, 'too_large': 0}
        last_trash_stats: Dict[str, Any] | None = None

        def _add_note(msg: str) -> None:
            try:
                notes = job.progress.get('notes') if isinstance(job.progress, dict) else None
                if not isinstance(notes, list):
                    notes = []
                notes.append(str(msg))
                # keep last 50 notes
                notes = notes[-50:]
                _progress_set(job, notes=notes)
            except Exception:
                pass


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
                    # Default behaviour: move to trash (/opt/var/trash) with restore metadata.
                    # When deleting inside the trash directory, we do a hard delete.
                    opts = spec.get('options') or {}
                    hard = bool(opts.get('hard') or opts.get('permanent') or opts.get('force'))
                    try:
                        info = _local_soft_delete(spath, LOCALFS_ROOTS, hard=hard)
                        try:
                            if isinstance(info, dict) and isinstance(info.get('trash'), dict):
                                last_trash_stats = info.get('trash')  # type: ignore
                        except Exception:
                            pass
                        try:
                            mode = str((info or {}).get('mode') or '')
                            reason = str((info or {}).get('reason') or '')
                            if mode == 'trash':
                                trash_summary['moved'] += 1
                            else:
                                trash_summary['permanent'] += 1
                                if reason == 'trash_full':
                                    trash_summary['trash_full'] += 1
                                    _add_note(f"Корзина заполнена — {sname or spath} удалён(о) навсегда")
                                elif reason == 'too_large_for_trash':
                                    trash_summary['too_large'] += 1
                                    _add_note(f"Слишком большой для корзины — {sname or spath} удалён(о) навсегда")
                        except Exception:
                            pass

                    except PermissionError as e:
                        raise RuntimeError(str(e))
                    except Exception:
                        # best-effort: ignore unexpected local delete failures
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

            # Attach trash summary (for UI notifications)
            if src_target == 'local':
                notice = None
                try:
                    if trash_summary.get('trash_full', 0):
                        # Trash is full: further deletes will be permanent.
                        pct = None
                        if last_trash_stats and last_trash_stats.get('percent') is not None:
                            pct = last_trash_stats.get('percent')
                        notice = f"Корзина заполнена{f' ({pct}%)' if pct is not None else ''}. Удаляемые файлы будут удаляться сразу — очистите корзину."
                    elif last_trash_stats and last_trash_stats.get('is_near_full'):
                        pct = last_trash_stats.get('percent')
                        notice = f"Корзина почти заполнена{f' ({pct}%)' if pct is not None else ''}. Рекомендуется очистить корзину."
                except Exception:
                    notice = None
                _progress_set(job, trash={'summary': trash_summary, 'stats': last_trash_stats, 'notice': notice})

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
        try:
            src = data.get('src') or {}
            dst = data.get('dst') or {}
            _core_log(
                "info",
                "fileops.job_create",
                job_id=job.job_id,
                op=op,
                sources=int(len(data.get('sources') or [])),
                bytes_total=int(data.get('bytes_total') or 0),
                src_target=str(src.get('target') or ''),
                src_sid=str(src.get('sid') or ''),
                src_path=str(src.get('path') or ''),
                dst_target=str(dst.get('target') or ''),
                dst_sid=str(dst.get('sid') or ''),
                dst_path=str(dst.get('path') or ''),
            )
        except Exception:
            pass

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


    @bp.post('/api/fileops/jobs/clear')
    def api_fileops_clear_jobs() -> Any:
        """Clear finished jobs from the in-memory history.

        This endpoint is optional for the UI: the client can fall back to local hiding
        if it doesn't exist.

        Body: {"scope": "history"|"finished"|"errors"|"all"}
          - history (default): done + error + canceled
          - finished: done + canceled
          - errors: error
          - all: all non-active jobs (done/error/canceled)
        """
        if (resp := _require_enabled()) is not None:
            return resp

        try:
            data = request.get_json(silent=True) or {}
        except Exception:
            data = {}
        scope = str((data or {}).get('scope') or 'history').strip().lower()
        if scope not in ('history', 'finished', 'errors', 'all'):
            scope = 'history'

        def _should_delete(state: str) -> bool:
            st = (state or '').strip().lower()
            if st in ('running', 'queued'):
                return False
            if scope == 'errors':
                return st == 'error'
            if scope == 'finished':
                return st in ('done', 'canceled')
            # history / all
            return st in ('done', 'error', 'canceled')

        deleted = 0
        try:
            with jobmgr._lock:
                to_del = [jid for jid, j in jobmgr._jobs.items() if _should_delete(getattr(j, 'state', '') or '')]
                for jid in to_del:
                    jobmgr._jobs.pop(jid, None)
                    deleted += 1
        except Exception:
            # If something goes wrong, be safe and do nothing.
            deleted = 0
        _core_log("info", "fileops.jobs_clear", deleted=int(deleted), scope=str(scope))
        return jsonify({'ok': True, 'deleted': deleted})


    @bp.post('/api/fileops/jobs/<job_id>/cancel')
    def api_fileops_cancel_job(job_id: str) -> Any:
        if (resp := _require_enabled()) is not None:
            return resp
        ok = jobmgr.cancel(job_id)
        if not ok:
            return error_response('job_not_found', 404, ok=False)
        _core_log("info", "fileops.job_cancel", job_id=job_id)
        return jsonify({'ok': True, 'canceled': True})


    if return_mgr:
        return bp, mgr
    return bp
