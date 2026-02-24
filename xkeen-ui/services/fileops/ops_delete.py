from __future__ import annotations

from typing import Any, Dict

from services.fileops.runtime import FileOpsRuntime
from services.fileops.job_models import FileOpJob


def run_job_delete(job: FileOpJob, spec: Dict[str, Any], rt: FileOpsRuntime) -> None:
    # spec validated at API layer; runs in background.
    rt.job_set_state(job, 'running')
    job.started_ts = rt.now_fn()

    src = spec['src']
    sources = spec['sources']
    src_target = src['target']

    rt.progress_set(job, files_total=len(sources), files_done=0, bytes_done=0, bytes_total=0)

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
            rt.progress_set(job, notes=notes)
        except Exception:
            pass


    def mark_done():
        rt.progress_set(job, files_done=(job.progress.get('files_done', 0) or 0) + 1)

    try:
        for ent in sources:
            if job.cancel_flag.is_set():
                raise RuntimeError('canceled')

            spath = ent['path']
            sname = ent.get('name') or ''
            is_dir = bool(ent.get('is_dir'))

            rt.progress_set(job, current={'path': spath, 'name': sname, 'phase': 'delete', 'is_dir': is_dir})

            if src_target == 'local':
                # Default behaviour: move to trash (/opt/var/trash) with restore metadata.
                # When deleting inside the trash directory, we do a hard delete.
                opts = spec.get('options') or {}
                hard = bool(opts.get('hard') or opts.get('permanent') or opts.get('force'))
                try:
                    info = rt.local_soft_delete(spath, rt.local_roots, hard=hard)
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
                except Exception as e:
                    # Do not silently ignore delete failures; otherwise UI will show "done"
                    # while the file stays in place.
                    raise RuntimeError(str(e) or 'delete_failed')
                mark_done();
            else:
                ss = rt.mgr.get(src['sid'])
                if not ss:
                    raise RuntimeError('session_not_found')
                # Remote delete must not be best-effort; otherwise UI will show "done" while the file stays in place.
                cmd = f"rm -r {rt.lftp_quote(spath)}" if is_dir else f"rm {rt.lftp_quote(spath)}"
                rc, out, err = rt.mgr._run_lftp(ss, [cmd], capture=True)
                if rc != 0:
                    try:
                        tail_err = (err or b'').decode('utf-8', errors='replace')[-400:].strip()
                        tail_out = (out or b'').decode('utf-8', errors='replace')[-400:].strip()
                        tail = tail_err or tail_out or f"rc={rc}"
                    except Exception:
                        tail = f"rc={rc}"
                    raise RuntimeError(f"delete_failed:{tail}")
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
            rt.progress_set(job, trash={'summary': trash_summary, 'stats': last_trash_stats, 'notice': notice})

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

    except Exception:
        rt.job_set_state(job, 'error', error='unexpected_error')
        job.finished_ts = rt.now_fn()
        try:
            if job._proc is not None:
                job._proc.terminate()
        except Exception:
            pass
        job._proc = None

