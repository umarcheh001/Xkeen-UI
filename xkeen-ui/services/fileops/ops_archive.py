from __future__ import annotations

import os
import shutil
import tarfile
import time
import uuid
import zipfile
from typing import Any, Dict, List, Tuple

from services.fileops.job_models import FileOpJob
from services.fileops.runtime import FileOpsRuntime


CHUNK_BYTES = 256 * 1024


def _sanitize_archive_filename(name: str, fmt: str) -> str:
    """Return a safe leaf filename with correct extension."""
    n = str(name or '').strip() or 'archive'
    # leaf only
    n = n.replace('\\', '/').split('/')[-1]
    n = n.replace('..', '_').replace('/', '_').replace('\\', '_')
    n = ''.join((c if (c.isalnum() or c in (' ', '.', '-', '_', '(', ')')) else '_') for c in n).strip() or 'archive'
    n = n[:120]

    f = str(fmt or 'zip').strip().lower()
    is_targz = f in ('tgz', 'tar.gz', 'tar_gz', 'targz')
    # strip existing archive extensions
    base = n
    for ext in ('.tar.gz', '.tgz', '.tar.bz2', '.tbz', '.tbz2', '.tar.xz', '.txz', '.tar', '.zip'):
        if base.lower().endswith(ext):
            base = base[: -len(ext)]
            break
    base = base.strip(' .') or 'archive'
    return (base + '.tar.gz') if is_targz else (base + '.zip')


def normalize_zip(spec: Dict[str, Any], rt: FileOpsRuntime) -> Dict[str, Any]:
    target = str(spec.get('target') or 'local').strip().lower()
    if target != 'local':
        raise RuntimeError('only_local_supported')
    cwd = str(spec.get('cwd') or '').strip() or '/'
    fmt = str(spec.get('format') or spec.get('fmt') or 'zip').strip().lower()
    overwrite = bool(spec.get('overwrite') is True or str(spec.get('overwrite') or '').strip().lower() in ('1', 'true', 'yes', 'on'))

    items_raw = spec.get('items')
    if not isinstance(items_raw, list) or not items_raw:
        raise RuntimeError('items_required')
    if len(items_raw) > 2000:
        raise RuntimeError('too_many_items')

    ensure_follow = rt.ensure_local_follow
    ensure_nofollow = rt.ensure_local_nofollow
    if not callable(ensure_follow) or not callable(ensure_nofollow):
        raise RuntimeError('local_helpers_missing')

    items: List[Tuple[str, str]] = []
    for it in items_raw:
        pth = ''
        if isinstance(it, str):
            pth = str(it).strip()
        elif isinstance(it, dict):
            pth = str(it.get('path') or '').strip()
        if not pth:
            continue
        if not pth.startswith('/'):
            pth = os.path.join(cwd, pth)
        try:
            rp = ensure_follow(pth)
        except PermissionError as e:
            raise RuntimeError(str(e))
        if not os.path.exists(rp):
            raise RuntimeError('not_found')
        base = os.path.basename(rp.rstrip('/')) or 'item'
        base = base.replace('..', '_').replace('/', '_').replace('\\', '_') or 'item'
        items.append((rp, base))
    if not items:
        raise RuntimeError('items_required')

    name = _sanitize_archive_filename(str(spec.get('name') or 'archive'), fmt)
    out_path = os.path.join(cwd, name) if not str(spec.get('name') or '').startswith('/') else str(spec.get('name') or '')
    if not out_path.startswith('/'):
        out_path = os.path.join(cwd, out_path)
    try:
        rp_out = ensure_nofollow(out_path)
    except PermissionError as e:
        raise RuntimeError(str(e))
    parent = os.path.dirname(rp_out) or '/'
    try:
        os.makedirs(parent, exist_ok=True)
    except Exception:
        raise RuntimeError('mkdir_failed')

    if os.path.exists(rp_out) and not overwrite:
        raise RuntimeError('exists')

    out_fmt = 'tar.gz' if str(fmt).strip().lower() in ('tgz', 'tar.gz', 'tar_gz', 'targz') else 'zip'
    return {
        'format': out_fmt,
        'overwrite': overwrite,
        'cwd': cwd,
        'out_path': out_path,
        'out_abs': rp_out,
        'items': [{'src_abs': rp, 'arcname': base} for (rp, base) in items],
    }


def normalize_unzip(spec: Dict[str, Any], rt: FileOpsRuntime) -> Dict[str, Any]:
    target = str(spec.get('target') or 'local').strip().lower()
    if target != 'local':
        raise RuntimeError('only_local_supported')

    cwd = str(spec.get('cwd') or '').strip() or '/'
    arch = str(spec.get('archive') or spec.get('path') or '').strip()
    if not arch:
        raise RuntimeError('archive_required')
    if not arch.startswith('/'):
        arch = os.path.join(cwd, arch)

    dest = str(spec.get('dest') or '').strip() or ''
    create_dest = bool(spec.get('create_dest') is True or str(spec.get('create_dest') or '').strip().lower() in ('1', 'true', 'yes', 'on'))
    strip_top_dir = bool(spec.get('strip_top_dir') is True or str(spec.get('strip_top_dir') or '').strip().lower() in ('1', 'true', 'yes', 'on'))
    flatten = bool(spec.get('flatten') is True or str(spec.get('flatten') or '').strip().lower() in ('1', 'true', 'yes', 'on'))
    overwrite = bool(spec.get('overwrite') is True or str(spec.get('overwrite') or '').strip().lower() in ('1', 'true', 'yes', 'on'))

    ensure_follow = rt.ensure_local_follow
    if not callable(ensure_follow):
        raise RuntimeError('local_helpers_missing')

    try:
        rp_arch = ensure_follow(arch)
    except PermissionError as e:
        raise RuntimeError(str(e))
    if not os.path.isfile(rp_arch):
        raise RuntimeError('not_found')

    dest0 = dest or cwd
    if not dest0.startswith('/'):
        dest0 = os.path.join(cwd, dest0)

    # If dest does not exist and create_dest is enabled, validate parent within sandbox.
    try:
        if os.path.exists(dest0):
            rp_dest = ensure_follow(dest0)
        else:
            parent = os.path.dirname(dest0.rstrip('/')) or '/'
            base = os.path.basename(dest0.rstrip('/')) or ''
            rp_parent = ensure_follow(parent)
            rp_dest = os.path.join(rp_parent, base) if base else rp_parent
    except PermissionError as e:
        raise RuntimeError(str(e))

    if not os.path.exists(rp_dest) and not create_dest:
        raise RuntimeError('dest_not_found')

    # Optional selection (archive members)
    sel_raw = spec.get('items')
    sel_exact: List[str] = []
    if isinstance(sel_raw, list):
        for x in sel_raw:
            try:
                nm = str(x or '').replace('\\', '/').strip()
            except Exception:
                nm = ''
            if not nm:
                continue
            while nm.startswith('./'):
                nm = nm[2:]
            is_dir = nm.endswith('/')
            nm2 = nm.strip('/')
            if not nm2 or nm2 in ('.', '..'):
                continue
            sel_exact.append(nm2 + '/' if is_dir else nm2)
    if len(sel_exact) > 10000:
        raise RuntimeError('too_many_items')

    return {
        'cwd': cwd,
        'archive': arch,
        'archive_abs': rp_arch,
        'dest': dest,
        'dest_abs': rp_dest,
        'create_dest': create_dest,
        'strip_top_dir': strip_top_dir,
        'flatten': flatten,
        'overwrite': overwrite,
        'items': sel_exact,
    }


def _is_safe_extract_path(dest_root_abs: str, rel: str) -> bool:
    try:
        root = os.path.abspath(dest_root_abs)
        out = os.path.abspath(os.path.join(root, rel))
        if out == root:
            return False
        return out.startswith(root.rstrip(os.sep) + os.sep)
    except Exception:
        return False


def _unique_leaf(parent_abs: str, leaf: str, *, is_dir: bool) -> str:
    base = os.path.basename(str(leaf or '').strip()) or 'item'
    if is_dir:
        stem, ext = base, ''
    else:
        stem, ext = os.path.splitext(base)
        stem = stem or base
    for i in range(1, 1000):
        cand = f"{stem} ({i}){ext}" if ext else f"{stem} ({i})"
        if not os.path.exists(os.path.join(parent_abs, cand)):
            return cand
    return f"{stem} ({int(time.time())}){ext}" if ext else f"{stem} ({int(time.time())})"


def _flatten_member_name(nm_use: str) -> str:
    s = str(nm_use or '').replace('\\', '/').rstrip('/')
    if not s or s in ('.', './'):
        return ''
    leaf = os.path.basename(s)
    if leaf in ('', '.', '..'):
        return ''
    return leaf.replace(':', '_')


def _ensure_parent_dirs(nm_use: str) -> str:
    nm_use = nm_use.replace('\\', '/').lstrip('/')
    parts = [p for p in nm_use.split('/') if p and p not in ('.', '..')]
    return '/'.join(parts)


def _compute_strip_prefix(metas: List[Tuple[str, bool]], strip_top_dir: bool) -> str:
    if not strip_top_dir:
        return ''
    roots: set[str | None] = set()
    for nm0, is_dir in metas:
        nm0s = str(nm0 or '').lstrip('/').strip()
        if not nm0s:
            continue
        parts = [p for p in nm0s.split('/') if p]
        if not parts:
            continue
        if len(parts) == 1:
            if is_dir:
                continue
            roots.add(None)
            continue
        roots.add(parts[0])
    if len(roots) == 1 and None not in roots:
        root = next(iter(roots))
        if root and root not in ('.', '..'):
            return root + '/'
    return ''


def run_job_zip(job: FileOpJob, spec: Dict[str, Any], rt: FileOpsRuntime) -> None:
    rt.job_set_state(job, 'running')
    job.started_ts = rt.now_fn()

    out_abs = str(spec.get('out_abs') or '').strip()
    out_path = str(spec.get('out_path') or '').strip()
    fmt = str(spec.get('format') or 'zip').strip().lower()
    overwrite = bool(spec.get('overwrite'))
    items = spec.get('items') or []

    tmp_dir = os.getenv('TMP_DIR', '/tmp')
    os.makedirs(tmp_dir, exist_ok=True)
    tmp_out = os.path.join(tmp_dir, f"xkeen_zip_{uuid.uuid4().hex}.tmp")

    try:
        # Pre-scan for totals (best-effort) to provide progress.
        bytes_total = 0
        files_total = 0
        for it in items:
            if job.cancel_flag is not None and job.cancel_flag.is_set():
                raise RuntimeError('canceled')
            p = str(it.get('src_abs') or '')
            if not p:
                continue
            if os.path.isdir(p):
                for root, _, files in os.walk(p):
                    for fn in files:
                        if job.cancel_flag is not None and job.cancel_flag.is_set():
                            raise RuntimeError('canceled')
                        fp = os.path.join(root, fn)
                        try:
                            st = os.lstat(fp)
                            bytes_total += int(getattr(st, 'st_size', 0) or 0)
                        except Exception:
                            pass
                        files_total += 1
            else:
                try:
                    st = os.lstat(p)
                    bytes_total += int(getattr(st, 'st_size', 0) or 0)
                except Exception:
                    pass
                files_total += 1

        rt.progress_set(
            job,
            files_total=int(files_total),
            files_done=0,
            bytes_total=int(bytes_total),
            bytes_done=0,
            current={'path': out_path or out_abs, 'name': os.path.basename(out_abs) or 'archive', 'phase': 'zip', 'is_dir': False},
        )

        bytes_done = 0
        files_done = 0

        if fmt == 'tar.gz':
            with tarfile.open(tmp_out, mode='w:gz') as tf:
                for it in items:
                    if job.cancel_flag is not None and job.cancel_flag.is_set():
                        raise RuntimeError('canceled')
                    rp = str(it.get('src_abs') or '')
                    base = str(it.get('arcname') or '') or os.path.basename(rp.rstrip('/')) or 'item'

                    if os.path.isdir(rp):
                        for root, dirs, files in os.walk(rp):
                            if job.cancel_flag is not None and job.cancel_flag.is_set():
                                raise RuntimeError('canceled')
                            rel_root = os.path.relpath(root, rp)
                            rel_root = '' if rel_root == '.' else rel_root
                            arc_root = (base + ('/' + rel_root if rel_root else '')).rstrip('/')

                            # Ensure empty dirs are preserved.
                            if not dirs and not files:
                                try:
                                    tf.add(root, arcname=arc_root, recursive=False)
                                except Exception:
                                    pass

                            for fn in files:
                                if job.cancel_flag is not None and job.cancel_flag.is_set():
                                    raise RuntimeError('canceled')
                                src = os.path.join(root, fn)
                                rel = os.path.join(rel_root, fn) if rel_root else fn
                                arc = (base + '/' + rel.replace('\\', '/')).lstrip('/')
                                rt.progress_set(job, current={'path': src, 'name': fn, 'phase': 'zip', 'is_dir': False})
                                try:
                                    tf.add(src, arcname=arc, recursive=False)
                                except Exception:
                                    continue
                                files_done += 1
                                try:
                                    bytes_done += int(os.path.getsize(src))
                                except Exception:
                                    pass
                                rt.progress_set(job, files_done=int(files_done), bytes_done=int(bytes_done))
                    else:
                        rt.progress_set(job, current={'path': rp, 'name': base, 'phase': 'zip', 'is_dir': False})
                        tf.add(rp, arcname=base, recursive=False)
                        files_done += 1
                        try:
                            bytes_done += int(os.path.getsize(rp))
                        except Exception:
                            pass
                        rt.progress_set(job, files_done=int(files_done), bytes_done=int(bytes_done))
        else:
            with zipfile.ZipFile(tmp_out, mode='w', compression=zipfile.ZIP_DEFLATED) as zf:
                for it in items:
                    if job.cancel_flag is not None and job.cancel_flag.is_set():
                        raise RuntimeError('canceled')
                    rp = str(it.get('src_abs') or '')
                    base = str(it.get('arcname') or '') or os.path.basename(rp.rstrip('/')) or 'item'
                    if os.path.isdir(rp):
                        for root, dirs, files in os.walk(rp):
                            rel_root = os.path.relpath(root, rp)
                            rel_root = '' if rel_root == '.' else rel_root
                            arc_dir = (base + ('/' + rel_root if rel_root else '')).rstrip('/') + '/'
                            if not dirs and not files:
                                try:
                                    zf.writestr(arc_dir, b'')
                                except Exception:
                                    pass
                            for fn in files:
                                if job.cancel_flag is not None and job.cancel_flag.is_set():
                                    raise RuntimeError('canceled')
                                src = os.path.join(root, fn)
                                rel = os.path.join(rel_root, fn) if rel_root else fn
                                arc = (base + '/' + rel.replace('\\', '/')).lstrip('/')
                                rt.progress_set(job, current={'path': src, 'name': fn, 'phase': 'zip', 'is_dir': False})
                                try:
                                    zf.write(src, arc)
                                except Exception:
                                    continue
                                files_done += 1
                                try:
                                    bytes_done += int(os.path.getsize(src))
                                except Exception:
                                    pass
                                rt.progress_set(job, files_done=int(files_done), bytes_done=int(bytes_done))
                    else:
                        rt.progress_set(job, current={'path': rp, 'name': base, 'phase': 'zip', 'is_dir': False})
                        zf.write(rp, base)
                        files_done += 1
                        try:
                            bytes_done += int(os.path.getsize(rp))
                        except Exception:
                            pass
                        rt.progress_set(job, files_done=int(files_done), bytes_done=int(bytes_done))

        # finalize
        if os.path.exists(out_abs) and not overwrite:
            raise RuntimeError('exists')
        try:
            os.replace(tmp_out, out_abs)
        except Exception:
            shutil.move(tmp_out, out_abs)

        try:
            out_bytes = int(os.path.getsize(out_abs))
        except Exception:
            out_bytes = None

        rt.progress_set(job, result={'path': out_path or out_abs, 'bytes': out_bytes})
        rt.job_set_state(job, 'done')
        job.finished_ts = rt.now_fn()
    except RuntimeError as e:
        if str(e) == 'canceled' or (job.cancel_flag is not None and job.cancel_flag.is_set()):
            rt.job_set_state(job, 'canceled', error=None)
        else:
            rt.job_set_state(job, 'error', error=str(e))
        job.finished_ts = rt.now_fn()
        try:
            if os.path.exists(tmp_out):
                os.remove(tmp_out)
        except Exception:
            pass
    except Exception:
        rt.job_set_state(job, 'error', error='unexpected_error')
        job.finished_ts = rt.now_fn()
        try:
            if os.path.exists(tmp_out):
                os.remove(tmp_out)
        except Exception:
            pass


def run_job_unzip(job: FileOpJob, spec: Dict[str, Any], rt: FileOpsRuntime) -> None:
    rt.job_set_state(job, 'running')
    job.started_ts = rt.now_fn()

    rp_arch = str(spec.get('archive_abs') or '').strip()
    rp_dest = str(spec.get('dest_abs') or '').strip()
    create_dest = bool(spec.get('create_dest'))
    strip_top_dir = bool(spec.get('strip_top_dir'))
    flatten = bool(spec.get('flatten'))
    overwrite = bool(spec.get('overwrite'))
    sel_exact = spec.get('items') or []

    try:
        if not os.path.exists(rp_dest):
            if not create_dest:
                raise RuntimeError('dest_not_found')
            os.makedirs(rp_dest, exist_ok=True)
        if not os.path.isdir(rp_dest):
            raise RuntimeError('dest_not_dir')

        dest_root_abs = os.path.abspath(rp_dest)
        extracted = 0
        skipped = 0
        renamed = 0

        def _want_member(nm0: str) -> bool:
            if not sel_exact:
                return True
            if nm0 in sel_exact:
                return True
            for d in sel_exact:
                if d.endswith('/'):
                    dd = d.strip('/')
                    if nm0 == dd or nm0.startswith(dd + '/'):
                        return True
            return False

        # We'll compute totals best-effort for progress.
        files_total = 0
        bytes_total = 0

        lower = rp_arch.lower()
        if lower.endswith('.zip'):
            with zipfile.ZipFile(rp_arch, 'r') as zf:
                members = zf.infolist()
                metas: List[Tuple[str, bool]] = []
                for zi in members:
                    nm0 = (zi.filename or '').replace('\\', '/').lstrip('/')
                    while nm0.startswith('./'):
                        nm0 = nm0[2:]
                    if not nm0 or nm0 in ('.', './'):
                        continue
                    is_dir = bool(nm0.endswith('/'))
                    nm0s = nm0.rstrip('/')
                    if not _want_member(nm0s):
                        continue
                    metas.append((nm0, is_dir))
                    if not is_dir:
                        files_total += 1
                        try:
                            bytes_total += int(getattr(zi, 'file_size', 0) or 0)
                        except Exception:
                            pass
                strip_prefix = _compute_strip_prefix(metas, strip_top_dir)
                rt.progress_set(job, files_total=int(files_total), files_done=0, bytes_total=int(bytes_total), bytes_done=0,
                                current={'path': rp_arch, 'name': os.path.basename(rp_arch), 'phase': 'unzip', 'is_dir': False})

                seen_flat: dict[str, int] = {}
                bytes_done = 0
                files_done = 0

                def _apply_dir_map(name: str) -> str:
                    nm_use = name
                    if strip_prefix and nm_use.startswith(strip_prefix):
                        nm_use = nm_use[len(strip_prefix):]
                    return nm_use.lstrip('/')

                for zi in members:
                    if job.cancel_flag is not None and job.cancel_flag.is_set():
                        raise RuntimeError('canceled')
                    nm0 = (zi.filename or '').replace('\\', '/').lstrip('/')
                    while nm0.startswith('./'):
                        nm0 = nm0[2:]
                    if not nm0 or nm0 in ('.', './'):
                        continue
                    is_dir = bool(nm0.endswith('/'))
                    nm0s = nm0.rstrip('/')
                    if not _want_member(nm0s):
                        continue

                    nm_use = _apply_dir_map(nm0).rstrip('/')
                    if not nm_use:
                        continue

                    if flatten:
                        leaf = _flatten_member_name(nm_use)
                        if not leaf:
                            skipped += 1
                            continue
                        base = leaf
                        n = seen_flat.get(base, 0)
                        if n:
                            stem, ext = os.path.splitext(base)
                            stem = stem or base
                            base = f"{stem} ({n}){ext}" if ext else f"{stem} ({n})"
                        seen_flat[leaf] = n + 1
                        rel = base
                    else:
                        rel = nm_use

                    rel = _ensure_parent_dirs(rel)
                    if not rel:
                        skipped += 1
                        continue
                    if not _is_safe_extract_path(dest_root_abs, rel):
                        skipped += 1
                        continue
                    out = os.path.abspath(os.path.join(dest_root_abs, rel))

                    if is_dir:
                        os.makedirs(out, exist_ok=True)
                        continue

                    if os.path.exists(out):
                        parent_abs = os.path.dirname(out) or dest_root_abs
                        leaf = os.path.basename(out)
                        if (not overwrite) or os.path.isdir(out):
                            new_leaf = _unique_leaf(parent_abs, leaf, is_dir=False)
                            rel_parent = '/'.join([p for p in rel.split('/')[:-1] if p])
                            rel2 = (rel_parent + '/' + new_leaf) if rel_parent else new_leaf
                            out = os.path.abspath(os.path.join(dest_root_abs, rel2))
                            renamed += 1

                    os.makedirs(os.path.dirname(out) or dest_root_abs, exist_ok=True)
                    rt.progress_set(job, current={'path': nm0, 'name': os.path.basename(nm0s), 'phase': 'unzip', 'is_dir': False})
                    with zf.open(zi, 'r') as src, open(out, 'wb') as dst_fp:
                        shutil.copyfileobj(src, dst_fp, length=CHUNK_BYTES)
                    extracted += 1
                    files_done += 1
                    try:
                        bytes_done += int(getattr(zi, 'file_size', 0) or 0)
                    except Exception:
                        pass
                    rt.progress_set(job, files_done=int(files_done), bytes_done=int(bytes_done))

        elif lower.endswith('.tar') or lower.endswith('.tar.gz') or lower.endswith('.tgz') or lower.endswith('.tar.xz') or lower.endswith('.txz') or lower.endswith('.tar.bz2') or lower.endswith('.tbz') or lower.endswith('.tbz2'):
            with tarfile.open(rp_arch, 'r:*') as tf:
                members = tf.getmembers()
                metas = []
                for ti in members:
                    nm0 = (ti.name or '').replace('\\', '/').lstrip('/')
                    while nm0.startswith('./'):
                        nm0 = nm0[2:]
                    if not nm0 or nm0 in ('.', './'):
                        continue
                    is_dir = bool(ti.isdir() or nm0.endswith('/'))
                    nm0s = nm0.rstrip('/')
                    if not _want_member(nm0s):
                        continue
                    metas.append((nm0, is_dir))
                    if not is_dir:
                        files_total += 1
                        try:
                            bytes_total += int(getattr(ti, 'size', 0) or 0)
                        except Exception:
                            pass
                strip_prefix = _compute_strip_prefix(metas, strip_top_dir)
                rt.progress_set(job, files_total=int(files_total), files_done=0, bytes_total=int(bytes_total), bytes_done=0,
                                current={'path': rp_arch, 'name': os.path.basename(rp_arch), 'phase': 'unzip', 'is_dir': False})
                seen_flat: dict[str, int] = {}
                bytes_done = 0
                files_done = 0

                def _apply_dir_map(name: str) -> str:
                    nm_use = name
                    if strip_prefix and nm_use.startswith(strip_prefix):
                        nm_use = nm_use[len(strip_prefix):]
                    return nm_use.lstrip('/')

                for ti in members:
                    if job.cancel_flag is not None and job.cancel_flag.is_set():
                        raise RuntimeError('canceled')
                    nm0 = (ti.name or '').replace('\\', '/').lstrip('/')
                    while nm0.startswith('./'):
                        nm0 = nm0[2:]
                    if not nm0 or nm0 in ('.', './'):
                        continue
                    is_dir = bool(ti.isdir() or nm0.endswith('/'))
                    nm0s = nm0.rstrip('/')
                    if not _want_member(nm0s):
                        continue

                    nm_use = _apply_dir_map(nm0).rstrip('/')
                    if not nm_use:
                        continue
                    if ti.issym() or ti.islnk():
                        skipped += 1
                        continue

                    if flatten:
                        leaf = _flatten_member_name(nm_use)
                        if not leaf:
                            skipped += 1
                            continue
                        base = leaf
                        n = seen_flat.get(base, 0)
                        if n:
                            stem, ext = os.path.splitext(base)
                            stem = stem or base
                            base = f"{stem} ({n}){ext}" if ext else f"{stem} ({n})"
                        seen_flat[leaf] = n + 1
                        rel = base
                    else:
                        rel = nm_use

                    rel = _ensure_parent_dirs(rel)
                    if not rel:
                        skipped += 1
                        continue
                    if not _is_safe_extract_path(dest_root_abs, rel):
                        skipped += 1
                        continue
                    out = os.path.abspath(os.path.join(dest_root_abs, rel))

                    if is_dir:
                        os.makedirs(out, exist_ok=True)
                        continue

                    if os.path.exists(out):
                        parent_abs = os.path.dirname(out) or dest_root_abs
                        leaf = os.path.basename(out)
                        if (not overwrite) or os.path.isdir(out):
                            new_leaf = _unique_leaf(parent_abs, leaf, is_dir=False)
                            rel_parent = '/'.join([p for p in rel.split('/')[:-1] if p])
                            rel2 = (rel_parent + '/' + new_leaf) if rel_parent else new_leaf
                            out = os.path.abspath(os.path.join(dest_root_abs, rel2))
                            renamed += 1

                    os.makedirs(os.path.dirname(out) or dest_root_abs, exist_ok=True)
                    rt.progress_set(job, current={'path': nm0, 'name': os.path.basename(nm0s), 'phase': 'unzip', 'is_dir': False})
                    src = tf.extractfile(ti)
                    if src is None:
                        skipped += 1
                        continue
                    with src, open(out, 'wb') as dst_fp:
                        shutil.copyfileobj(src, dst_fp, length=CHUNK_BYTES)
                    extracted += 1
                    files_done += 1
                    try:
                        bytes_done += int(getattr(ti, 'size', 0) or 0)
                    except Exception:
                        pass
                    rt.progress_set(job, files_done=int(files_done), bytes_done=int(bytes_done))
        else:
            raise RuntimeError('unsupported_archive')

        rt.progress_set(job, result={'archive': rp_arch, 'dest': rp_dest, 'extracted': extracted, 'skipped': skipped, 'renamed': renamed})
        rt.job_set_state(job, 'done')
        job.finished_ts = rt.now_fn()
    except RuntimeError as e:
        if str(e) == 'canceled' or (job.cancel_flag is not None and job.cancel_flag.is_set()):
            rt.job_set_state(job, 'canceled', error=None)
        else:
            rt.job_set_state(job, 'error', error=str(e))
        job.finished_ts = rt.now_fn()
    except Exception:
        rt.job_set_state(job, 'error', error='unexpected_error')
        job.finished_ts = rt.now_fn()
