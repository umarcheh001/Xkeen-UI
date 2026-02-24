from __future__ import annotations

import os
import re
import shutil
import subprocess
import time
import uuid
from typing import Any, Dict

from services.fileops.runtime import FileOpsRuntime
from services.fileops.job_models import FileOpJob
from services.fileops.local_backend import _copyfile_no_stat, _copytree_no_stat, _safe_move_no_stat


def run_job_copy_move(job: FileOpJob, spec: Dict[str, Any], rt: FileOpsRuntime) -> None:
    # spec is validated at API layer; this function runs in background.
    rt.job_set_state(job, 'running')
    job.started_ts = rt.now_fn()

    ensure_follow = rt.ensure_local_follow
    ensure_nofollow = rt.ensure_local_nofollow
    if not callable(ensure_follow) or not callable(ensure_nofollow):
        raise RuntimeError('local_helpers_missing')

    spool_base = getattr(rt, 'spool_base_dir', None)
    try:
        spool_max = int(getattr(rt, 'spool_max_bytes', 0) or 0)
    except Exception:
        spool_max = 0

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
        rt.spool_cleanup_stale()
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

    def _check_remote_free(ds_sess: Any, dst_path: str, need_bytes: int, *, label: str = 'remote') -> None:
        if not check_free_space:
            return
        try:
            nb = int(need_bytes or 0)
        except Exception:
            nb = 0
        if nb <= 0:
            return
        try:
            free_b = rt.remote_free_bytes(ds_sess, dst_path)
        except Exception:
            free_b = None
        if free_b is None:
            return
        if int(free_b) < nb:
            # Attach some context for UI/logs.
            try:
                rt.progress_set(job, current={
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
    rt.progress_set(job, files_total=len(sources), files_done=0, bytes_done=0, bytes_total=spec.get('bytes_total') or 0)

    def mark_done():
        rt.progress_set(job, files_done=(job.progress.get('files_done', 0) or 0) + 1)

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
            rt.progress_set(job, current={'path': spath, 'name': sname, 'phase': 'copy', 'is_dir': is_dir})

            # determine destination path (TC-like): if destination is treated as a directory, create it if missing.
            dst_path = dst['path']
            dst_is_dir = bool(dst.get('is_dir')) or dst_path.endswith('/') or len(sources) > 1
            if dst_is_dir:
                if dst_target == 'local':
                    ddir = ensure_follow(dst_path)
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
                    ds0 = rt.mgr.get(dst.get('sid'))
                    if not ds0:
                        raise RuntimeError('session_not_found')
                    if ddir != '/':
                        rt.mgr._run_lftp(ds0, [f"mkdir -p {rt.lftp_quote(ddir)}"], capture=True)
                    dpath = (ddir.rstrip('/') + '/' + sname) if ddir != '/' else ('/' + sname)
            else:
                dpath = dst_path
                # ensure parent exists
                if dst_target == 'local':
                    dp_abs = ensure_nofollow(dpath)
                    os.makedirs(os.path.dirname(dp_abs) or '/tmp', exist_ok=True)
                    dpath = dp_abs
                else:
                    ds0 = rt.mgr.get(dst.get('sid'))
                    if not ds0:
                        raise RuntimeError('session_not_found')
                    parent = os.path.dirname(dpath.rstrip('/'))
                    if parent and parent not in ('', '.'):
                        rt.mgr._run_lftp(ds0, [f"mkdir -p {rt.lftp_quote(parent)}"], capture=True)

            # --- same-target fast path for move ---
            if job.op == 'move' and src_target == dst_target:
                if src_target == 'local':
                    sp = ensure_nofollow(spath)
                    dp = ensure_nofollow(dpath)

                    # Protect Keenetic /tmp/mnt mount labels from being moved/renamed.
                    if rt.local_is_protected_entry_abs(sp) or rt.local_is_protected_entry_abs(dp):
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
                            rt.local_remove_entry(dp, rt.local_roots, recursive=True)
                        except PermissionError as e:
                            raise RuntimeError(str(e))
                        except Exception:
                            pass
                    try:
                        # Robust across different mounts/FS types (EXDEV, copystat failures).
                        _safe_move_no_stat(sp, dp)
                    except Exception as e:
                        raise RuntimeError(str(e) or 'move_failed')
                    mark_done();
                    continue
                if src_target == 'remote':
                    ss = rt.mgr.get(src['sid'])
                    if not ss:
                        raise RuntimeError('session_not_found')

                    # Remote move onto itself is a no-op.
                    if str(spath) == str(dpath):
                        mark_done();
                        continue

                    if rt.remote_exists(ss, dpath):
                        action = _decide_overwrite_action(spath=str(spath), sname=str(sname), dpath=str(dpath))
                        if action == 'skip':
                            mark_done();
                            continue
                        rt.mgr._run_lftp(ss, [f"rm -r {rt.lftp_quote(dpath)}"], capture=True)
                    rc, out, err = rt.mgr._run_lftp(ss, [f"mv {rt.lftp_quote(spath)} {rt.lftp_quote(dpath)}"], capture=True)
                    if rc != 0:
                        raise RuntimeError('remote_move_failed')
                    mark_done();
                    continue

            # --- copy routes ---
            if src_target == 'remote' and dst_target == 'local':
                ss = rt.mgr.get(src['sid'])
                if not ss:
                    raise RuntimeError('session_not_found')
                # dpath is already resolved above; keep as a safety net.
                dp = ensure_nofollow(dpath)
                if rt.local_is_protected_entry_abs(dp):
                    raise RuntimeError('protected_path')
                # overwrite policy
                if os.path.exists(dp):
                    action = _decide_overwrite_action(spath=str(spath), sname=str(sname), dpath=str(dp))
                    if action == 'skip':
                        mark_done();
                        continue
                    try:
                        rt.local_remove_entry(dp, rt.local_roots, recursive=True)
                    except PermissionError as e:
                        raise RuntimeError(str(e))
                    except Exception:
                        pass
                # directory: mirror; file: cat stream
                if is_dir:
                    os.makedirs(dp, exist_ok=True)
                    cmd = f"mirror --verbose -- {rt.lftp_quote(spath)} {rt.lftp_quote(dp)}"
                    proc = rt.mgr._popen_lftp(ss, [cmd])
                    job._proc = proc
                    out, err = proc.communicate()
                    if proc.returncode != 0:
                        raise RuntimeError('mirror_failed')
                    mark_done();
                else:
                    os.makedirs(os.path.dirname(dp) or '/tmp', exist_ok=True)
                    tmp = dp + '.part.' + uuid.uuid4().hex[:6]
                    size_total = rt.remote_stat_size(ss, spath) or 0
                    # update bytes_total incrementally
                    if (job.progress.get('bytes_total', 0) or 0) == 0 and size_total:
                        rt.progress_set(job, bytes_total=int(size_total))
                    proc = rt.mgr._popen_lftp(ss, [f"cat {rt.lftp_quote(spath)}"])
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
                                rt.progress_set(job, bytes_done=(job.progress.get('bytes_done', 0) or 0) + len(chunk))
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
                ds = rt.mgr.get(dst['sid'])
                if not ds:
                    raise RuntimeError('session_not_found')
                sp = ensure_follow(spath)
                if is_dir:
                    # Pre-check free space on remote destination (best-effort).
                    try:
                        need_b = rt.dir_size_bytes(sp)
                        _check_remote_free(ds, dpath, int(need_b), label=f"{ds.protocol}://{ds.host}")
                    except RuntimeError:
                        raise
                    except Exception:
                        pass
                    # mirror -R local_dir -> remote_dir
                    cmd = f"mirror -R --verbose -- {rt.lftp_quote(sp)} {rt.lftp_quote(dpath)}"
                    proc = rt.mgr._popen_lftp(ds, [cmd])
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
                        rt.progress_set(job, bytes_total=int(size_total))
                    # Pre-check free space on remote destination (best-effort).
                    try:
                        if size_total:
                            _check_remote_free(ds, dpath, int(size_total), label=f"{ds.protocol}://{ds.host}")
                    except RuntimeError:
                        raise
                    except Exception:
                        pass
                    # overwrite policy (best-effort)
                    if rt.remote_exists(ds, dpath):
                        action = _decide_overwrite_action(spath=str(spath), sname=str(sname), dpath=str(dpath))
                        if action == 'skip':
                            mark_done();
                            continue
                        rt.mgr._run_lftp(ds, [f"rm -r {rt.lftp_quote(dpath)}"], capture=True)
                    proc = rt.mgr._popen_lftp(ds, [f"put {rt.lftp_quote(sp)} -o {rt.lftp_quote(dpath)}"])
                    job._proc = proc
                    out, err = proc.communicate()
                    if proc.returncode != 0:
                        raise RuntimeError('upload_failed')
                    # No reliable per-byte progress here without parsing; mark done at end.
                    rt.progress_set(job, bytes_done=(job.progress.get('bytes_done', 0) or 0) + size_total)
                    mark_done();

            elif src_target == 'local' and dst_target == 'local':
                sp = ensure_follow(spath)
                dp = ensure_nofollow(dpath)

                # COPY onto itself is a common UX case when both panels point to the same dir.
                # Never delete the source; instead, auto-pick a free "(2)/(3)…" name.
                if _same_local(sp, dp):
                    dp = _next_copy_path_local(dp)

                if rt.local_is_protected_entry_abs(dp):
                    raise RuntimeError('protected_path')

                if os.path.exists(dp):
                    action = _decide_overwrite_action(spath=str(spath), sname=str(sname), dpath=str(dp))
                    if action == 'skip':
                        mark_done();
                        continue
                    try:
                        rt.local_remove_entry(dp, rt.local_roots, recursive=True)
                    except PermissionError as e:
                        raise RuntimeError(str(e))
                    except Exception:
                        pass
                if is_dir:
                    try:
                        _copytree_no_stat(sp, dp)
                    except Exception as e:
                        raise RuntimeError(str(e) or 'copy_failed')
                    mark_done();
                else:
                    os.makedirs(os.path.dirname(dp) or '/tmp', exist_ok=True)
                    size_total = 0
                    try:
                        size_total = os.stat(sp).st_size
                    except Exception:
                        pass
                    if (job.progress.get('bytes_total', 0) or 0) == 0 and size_total:
                        rt.progress_set(job, bytes_total=int(size_total or 0))
                    with open(sp, 'rb') as r, open(dp + '.part.' + uuid.uuid4().hex[:6], 'wb') as w:
                        tmp = w.name
                        while True:
                            if job.cancel_flag.is_set():
                                raise RuntimeError('canceled')
                            chunk = r.read(64*1024)
                            if not chunk:
                                break
                            w.write(chunk)
                            rt.progress_set(job, bytes_done=(job.progress.get('bytes_done', 0) or 0) + len(chunk))
                    os.rename(tmp, dp)
                    try:
                        if os.path.exists(tmp):
                            os.remove(tmp)
                    except Exception:
                        pass
                    mark_done();

            elif src_target == 'remote' and dst_target == 'remote':
                ss = rt.mgr.get(src['sid'])
                ds = rt.mgr.get(dst['sid'])
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
                        if not rt.remote_exists(ds, cand):
                            picked = cand
                            break
                    if picked:
                        dpath = picked

                # overwrite policy on destination
                if rt.remote_exists(ds, dpath):
                    action = _decide_overwrite_action(spath=str(spath), sname=str(sname), dpath=str(dpath))
                    if action == 'skip':
                        mark_done();
                        continue
                    # best-effort remove
                    rt.mgr._run_lftp(ds, [f"rm -r {rt.lftp_quote(dpath)}"], capture=True)

                if not is_dir:
                    # First try server-side copy if same session.
                    if src.get('sid') == dst.get('sid'):
                        rc, out, err = rt.mgr._run_lftp(ss, [f"cp {rt.lftp_quote(spath)} {rt.lftp_quote(dpath)}"], capture=True)
                        if rc == 0:
                            # No bytes streamed; still advance progress to keep UI consistent.
                            sz = rt.remote_stat_size(ss, spath) or 0
                            if sz:
                                rt.progress_set(job, bytes_done=(job.progress.get('bytes_done', 0) or 0) + int(sz))
                            mark_done();
                            continue

                    # For FTP/FTPS pairs try lftp URL-form copy first (FXP when possible).
                    if rt.remote2remote_direct and ss.protocol in ('ftp', 'ftps') and ds.protocol in ('ftp', 'ftps'):
                        try:
                            src_url = rt.url_for_session_path(ss, spath)
                            dst_url = rt.url_for_session_path(ds, dpath)
                            rt.progress_set(job, current={'path': spath, 'name': sname, 'phase': 'fxp', 'is_dir': False})
                            script = rt.build_lftp_url_script(ss, ds, [f"get {rt.lftp_quote(src_url)} -o {rt.lftp_quote(dst_url)}"])
                            proc = rt.popen_lftp_raw(script)
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
                                    sz = rt.remote_stat_size(ss, spath) or 0
                                    if sz:
                                        rt.progress_set(job, bytes_done=(job.progress.get('bytes_done', 0) or 0) + int(sz))
                                    mark_done();
                                    continue
                            finally:
                                job._proc = None
                        except RuntimeError:
                            raise
                        except Exception:
                            # fall back to spooling route; clean up possible partial dest
                            try:
                                rt.mgr._run_lftp(ds, [f"rm -r {rt.lftp_quote(dpath)}"], capture=True)
                            except Exception:
                                pass
                            pass

                    # Fallback: spool to local tmp then upload.
                    base_usage = 0
                    if spool_max and spool_base:
                        # account for existing spool usage (other jobs/leftovers)
                        base_usage = rt.dir_size_bytes(spool_base, stop_after=spool_max + 1)
                    size_total = rt.remote_stat_size(ss, spath) or 0
                    if spool_max and size_total:
                        rt.spool_check_limit(int(base_usage + int(size_total)))
                    tmp = rt.spool_tmp_file(ext='bin')
                    try:
                        rt.progress_set(job, current={'path': spath, 'name': sname, 'phase': 'download', 'is_dir': False})
                        done = 0
                        proc = rt.mgr._popen_lftp(ss, [f"cat {rt.lftp_quote(spath)}"])
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
                                    if spool_max and (base_usage + done) > spool_max:
                                        try:
                                            rt.terminate_proc(proc)
                                        except Exception:
                                            pass
                                        raise RuntimeError('spool_limit_exceeded')
                                    rt.progress_set(job, bytes_done=(job.progress.get('bytes_done', 0) or 0) + len(chunk))
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

                        rt.progress_set(job, current={'path': spath, 'name': sname, 'phase': 'upload', 'is_dir': False})
                        proc2 = rt.mgr._popen_lftp(ds, [f"put {rt.lftp_quote(tmp)} -o {rt.lftp_quote(dpath)}"])
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
                    if rt.remote2remote_direct and ss.protocol in ('ftp', 'ftps') and ds.protocol in ('ftp', 'ftps'):
                        try:
                            # Pre-check free space on destination (best-effort).
                            try:
                                need_b = rt.remote_du_bytes(ss, spath) or 0
                                if need_b:
                                    _check_remote_free(ds, dpath, int(need_b), label=f"{ds.protocol}://{ds.host}")
                            except RuntimeError:
                                raise
                            except Exception:
                                pass
                            src_url = rt.url_for_session_path(ss, spath)
                            dst_url = rt.url_for_session_path(ds, dpath)
                            rt.progress_set(job, current={'path': spath, 'name': sname, 'phase': 'fxp', 'is_dir': True})
                            script = rt.build_lftp_url_script(ss, ds, [f"mirror --verbose -- {rt.lftp_quote(src_url)} {rt.lftp_quote(dst_url)}"])
                            proc = rt.popen_lftp_raw(script)
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
                                rt.mgr._run_lftp(ds, [f"rm -r {rt.lftp_quote(dpath)}"], capture=True)
                            except Exception:
                                pass
                            pass

                    # Directory copy fallback: mirror down to spool dir then mirror -R up.
                    tmpd = rt.spool_tmp_dir()
                    try:
                        rt.progress_set(job, current={'path': spath, 'name': sname, 'phase': 'download', 'is_dir': True})
                        base_usage = 0
                        if spool_max and spool_base:
                            base_usage = rt.dir_size_bytes(spool_base, stop_after=spool_max + 1)
                            if base_usage >= spool_max:
                                raise RuntimeError('spool_limit_exceeded')
                        remaining = max(0, spool_max - base_usage) if spool_max else 0
                        last_sz = 0

                        proc1 = rt.popen_lftp_quiet(ss, [f"mirror -- {rt.lftp_quote(spath)} {rt.lftp_quote(tmpd)}"])
                        job._proc = proc1
                        try:
                            while proc1.poll() is None:
                                if job.cancel_flag.is_set():
                                    rt.terminate_proc(proc1)
                                    raise RuntimeError('canceled')

                                if spool_max:
                                    sz = rt.dir_size_bytes(tmpd, stop_after=remaining + 1)
                                    if sz > remaining:
                                        rt.terminate_proc(proc1)
                                        raise RuntimeError('spool_limit_exceeded')
                                    if sz > last_sz:
                                        rt.progress_set(job, bytes_done=(job.progress.get('bytes_done', 0) or 0) + int(sz - last_sz))
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

                        rt.progress_set(job, current={'path': spath, 'name': sname, 'phase': 'upload', 'is_dir': True})
                        # Pre-check free space on destination before mirror -R (best-effort).
                        try:
                            need_b = int(last_sz or 0) or rt.dir_size_bytes(tmpd)
                            if need_b:
                                _check_remote_free(ds, dpath, int(need_b), label=f"{ds.protocol}://{ds.host}")
                        except RuntimeError:
                            raise
                        except Exception:
                            pass
                        proc2 = rt.popen_lftp_quiet(ds, [f"mirror -R -- {rt.lftp_quote(tmpd)} {rt.lftp_quote(dpath)}"])
                        job._proc = proc2
                        try:
                            while proc2.poll() is None:
                                if job.cancel_flag.is_set():
                                    rt.terminate_proc(proc2)
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
                        rt.local_remove_entry(spath, rt.local_roots, recursive=True)
                    except Exception:
                        pass
                else:
                    ss = rt.mgr.get(src['sid'])
                    if ss:
                        rt.mgr._run_lftp(ss, [f"rm -r {rt.lftp_quote(spath)}"], capture=True)

        rt.job_set_state(job, 'done')
        job.finished_ts = rt.now_fn()
        job._proc = None
    except RuntimeError as e:
        if str(e) == 'canceled' or job.cancel_flag.is_set():
            rt.job_set_state(job, 'canceled', error=None)
        else:
            rt.job_set_state(job, 'error', error=str(e))
        job.finished_ts = rt.now_fn()
        try:
            if job._proc is not None:
                job._proc.terminate()
        except Exception:
            pass
        job._proc = None
    except Exception as e:
        rt.job_set_state(job, 'error', error='unexpected_error')
        job.finished_ts = rt.now_fn()
        try:
            if job._proc is not None:
                job._proc.terminate()
        except Exception:
            pass
        job._proc = None

