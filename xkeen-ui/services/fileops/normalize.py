from __future__ import annotations

import os
from typing import Any, Dict, List

from services.fileops.runtime import FileOpsRuntime


def normalize_sources(spec: Dict[str, Any], rt: FileOpsRuntime) -> None:
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
                rp = rt.ensure_local_follow(dpath)
                if os.path.isdir(rp):
                    dst_is_dir = True
            else:
                ds = rt.mgr.get(dst.get('sid'))
                if not ds:
                    raise RuntimeError('session_not_found')
                if rt.remote_is_dir(ds, dpath) is True:
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
            rp = rt.ensure_local_follow(ent['path'])
            ent['path'] = rp
            try:
                st = os.lstat(rp)
                ent['is_dir'] = os.path.isdir(rp)
                if os.path.isfile(rp):
                    bytes_total += int(st.st_size or 0)
            except Exception:
                pass
    else:
        ss = rt.mgr.get(src['sid'])
        if not ss:
            raise RuntimeError('session_not_found')
        for ent in sources:
            rpath = ent['path']
            is_dir = rt.remote_is_dir(ss, rpath)
            if is_dir is True:
                ent['is_dir'] = True
            elif is_dir is False:
                ent['is_dir'] = False
                sz = rt.remote_stat_size(ss, rpath)
                if sz:
                    bytes_total += int(sz)
            # if None: leave as-is

    spec['src'] = src
    spec['dst'] = dst
    spec['sources'] = sources
    spec['bytes_total'] = bytes_total


def compute_dst_path_for_entry(dst: Dict[str, Any], dst_target: str, sources: List[Dict[str, Any]], ent: Dict[str, Any], rt: FileOpsRuntime) -> str:
    """Compute destination path for a given source entry.

    Does not create anything; just returns the resolved path string.
    """
    dst_path = str(dst.get('path') or '')
    sname = str(ent.get('name') or '')
    dst_is_dir = bool(dst.get('is_dir'))
    if dst_is_dir or dst_path.endswith('/') or len(sources) > 1:
        if dst_target == 'local':
            ddir = rt.ensure_local_follow(dst_path)
            return os.path.join(ddir, sname)
        ddir = dst_path.rstrip('/')
        if not ddir:
            ddir = '/'
        return (ddir.rstrip('/') + '/' + sname) if ddir != '/' else ('/' + sname)
    return dst_path


def compute_copy_move_conflicts(spec: Dict[str, Any], rt: FileOpsRuntime) -> List[Dict[str, Any]]:
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
        ds = rt.mgr.get(dst.get('sid'))

    conflicts: List[Dict[str, Any]] = []
    for ent in sources:
        try:
            dpath = compute_dst_path_for_entry(dst, dst_target, sources, ent, rt)
        except Exception:
            continue
        exists = False
        try:
            if dst_target == 'local':
                dp = rt.ensure_local_follow(dpath)
                exists = os.path.exists(dp)
                dpath_resolved = dp
            else:
                if not ds:
                    raise RuntimeError('session_not_found')
                exists = bool(rt.remote_exists(ds, dpath))
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

def normalize_delete(spec: Dict[str, Any], rt: FileOpsRuntime) -> None:
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
            rp = rt.ensure_local_follow(ent['path'])
            ent['path'] = rp
            try:
                ent['is_dir'] = os.path.isdir(rp)
            except Exception:
                pass
    else:
        ss = rt.mgr.get(src['sid'])
        if not ss:
            raise RuntimeError('session_not_found')
        for ent in sources:
            rpath = ent['path']
            is_dir = rt.remote_is_dir(ss, rpath)
            if is_dir is True:
                ent['is_dir'] = True
            elif is_dir is False:
                ent['is_dir'] = False

    spec['src'] = src
    spec['sources'] = sources
