"""Local filesystem allowlist/resolve + trash helpers.

Moved from routes_remotefs.py to break routes->routes imports.
"""

from __future__ import annotations

import os
import stat
import re
import time
import json
import shutil
import threading
import uuid
from typing import Any, Dict, List, Optional, Tuple

from services.utils.env import _read_float_env, _read_int_env

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
    # Keep both the user-facing root path (lexical checks use it) and its realpath
    # (realpath checks use it). This matters on macOS where /tmp is a symlink to
    # /private/tmp: UI often sends "/tmp/..." while realpath resolves to "/private/tmp/...".
    out: List[str] = []
    for r in roots:
        try:
            ap = os.path.normpath(str(r)).rstrip('/')
            if ap:
                out.append(ap)
        except Exception:
            pass
        try:
            rp = os.path.realpath(str(r)).rstrip('/')
            if rp:
                out.append(rp)
        except Exception:
            pass
    # de-dup
    return sorted(set([x for x in out if x]))


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
    """Return True if `ap` is a protected mount-label entry (or /tmp/mnt itself).

    Keenetic uses /tmp/mnt as a mount root for USB volumes. Its *top-level* entries are
    usually auto-created mountpoints and/or label symlinks. Renaming/deleting those
    directories is a common footgun.

    However, users (and our UI) can accidentally place a *regular file* directly under
    /tmp/mnt (e.g. upload while being in /tmp/mnt). Such files must remain removable.

    Policy:
      - /tmp/mnt itself is always protected.
      - Direct children of /tmp/mnt are protected only when they are:
          * symlinks, or
          * mountpoint directories (real mountpoints).
      - Regular files under /tmp/mnt are NOT protected (so they can be cleaned up).
      - If the path does not exist yet and is a direct child of /tmp/mnt, treat it as
        protected to prevent creating new "loose" entries in the mount root.
    """
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
            # Existing entry: protect only mountpoint dirs / symlinks.
            try:
                st = os.lstat(apn)
                mode_i = int(getattr(st, 'st_mode', 0) or 0)
                if stat.S_ISLNK(mode_i):
                    return True
                if stat.S_ISDIR(mode_i):
                    try:
                        rp = os.path.realpath(apn)
                        if os.path.ismount(rp):
                            return True
                    except Exception:
                        # If we cannot determine mount status, be conservative.
                        return True
                # Regular file / other => not protected.
                return False
            except FileNotFoundError:
                # Prevent creating new top-level entries under /tmp/mnt.
                return True
            except Exception:
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

    # Move (rename when possible; across FS we do copy+delete).
    # NOTE: shutil.move() uses copy2/copytree which may fail on some router filesystems
    # (e.g. FAT/NTFS/exFAT) due to metadata/permission copying. We use a safer
    # implementation that ignores copystat errors.

    def _copyfile_no_stat(src: str, dst: str) -> None:
        shutil.copyfile(src, dst)
        try:
            shutil.copystat(src, dst, follow_symlinks=False)
        except Exception:
            pass

    def _copytree_no_stat(src_dir: str, dst_dir: str) -> None:
        os.makedirs(dst_dir, exist_ok=False)
        try:
            with os.scandir(src_dir) as it:
                for entry in it:
                    sp = entry.path
                    dp = os.path.join(dst_dir, entry.name)
                    try:
                        if entry.is_symlink():
                            try:
                                os.symlink(os.readlink(sp), dp)
                            except FileExistsError:
                                pass
                            continue
                        if entry.is_dir(follow_symlinks=False):
                            _copytree_no_stat(sp, dp)
                        else:
                            _copyfile_no_stat(sp, dp)
                    except Exception:
                        # best-effort: continue copying other entries
                        continue
        finally:
            try:
                shutil.copystat(src_dir, dst_dir, follow_symlinks=False)
            except Exception:
                pass

    def _safe_move_no_stat(src: str, dst: str) -> None:
        try:
            os.rename(src, dst)
            return
        except Exception:
            pass
        st = os.lstat(src)
        if stat.S_ISLNK(st.st_mode):
            # move symlink itself (do not follow target)
            os.symlink(os.readlink(src), dst)
            os.unlink(src)
            return
        if stat.S_ISDIR(st.st_mode):
            _copytree_no_stat(src, dst)
            shutil.rmtree(src, ignore_errors=True)
            return
        # regular file / other: copy bytes and unlink
        _copyfile_no_stat(src, dst)
        try:
            os.unlink(src)
        except IsADirectoryError:
            shutil.rmtree(src, ignore_errors=True)

    _safe_move_no_stat(ap, dst)

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

