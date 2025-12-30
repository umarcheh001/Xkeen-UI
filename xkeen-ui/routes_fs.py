"""Filesystem API facade for the router UI.

This blueprint exposes the UI-stable endpoints under /api/fs/*.

- Local operations are always available (within configured local roots).
- Remote operations are available only when the RemoteFS manager is present
  in app.extensions as "xkeen.remotefs_mgr" and is enabled.

The UI already uses /api/fs/* with a "target" selector (local|remote). This
facade keeps that contract stable while allowing RemoteFS to be optional.
"""

from __future__ import annotations

import os
import json
import re
import stat
import uuid
import shutil
import subprocess
import time
import hashlib
from typing import Any, Dict, List, Optional, Tuple

from flask import Blueprint, request, jsonify, current_app, Response, send_file
from werkzeug.local import LocalProxy

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
                # keep it compact
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


# Reuse shared helpers from the RemoteFS module to avoid duplicated logic.
from routes_remotefs import (
    error_response,
    _local_allowed_roots,
    _local_is_allowed,
    _local_resolve,
    _local_norm_abs,
    _local_resolve_follow,
    _local_resolve_nofollow,
    _local_remove_entry,
    _local_soft_delete,
    _local_restore_from_trash,
    _local_trash_dirs,
    _local_trash_stats,
    _TRASH_META_DIRNAME,
    _local_is_protected_entry_abs,
    _local_item_from_stat,
    _sanitize_download_filename,
    _content_disposition_attachment,
    _zip_directory,
    _zip_selection_local,
    _lftp_quote,
    _parse_ls_line,
)


def create_fs_blueprint(*, tmp_dir: str = "/tmp", max_upload_mb: int = 200) -> Blueprint:
    """Create /api/fs/* facade blueprint.

    Args:
        tmp_dir: temp directory used for local zip/write/upload staging.
        max_upload_mb: max upload size limit used by /api/fs/upload.
    """

    bp = Blueprint("fs", __name__)

    # Allowed local roots (UI sandbox).
    LOCALFS_ROOTS = _local_allowed_roots()

    # Local staging config (do NOT depend on remotefs manager existing).
    TMP_DIR = str(tmp_dir or "/tmp")
    MAX_UPLOAD_MB = int(max_upload_mb or 200)

    # ZIP creation can easily exhaust /tmp (often tmpfs/RAM on routers).
    # Configure a hard server-side cap via env:
    #   - XKEEN_MAX_ZIP_MB (preferred)
    #   - MAX_ZIP_MB (fallback)
    # 0 / empty disables the limit.
    def _read_int_env(name: str, default: int = 0) -> int:
        try:
            v = str(os.getenv(name, '') or '').strip()
            if not v:
                return int(default)
            return int(float(v))
        except Exception:
            return int(default)

    MAX_ZIP_MB = _read_int_env('XKEEN_MAX_ZIP_MB', _read_int_env('MAX_ZIP_MB', 0))
    MAX_ZIP_BYTES: int | None = None
    if isinstance(MAX_ZIP_MB, int) and MAX_ZIP_MB > 0:
        MAX_ZIP_BYTES = int(MAX_ZIP_MB) * 1024 * 1024

    # Upper bound for how many entries we will stat/parse when estimating archive size.
    # Keeps estimation from hanging on huge trees.
    MAX_ZIP_ESTIMATE_ITEMS = max(10_000, min(500_000, _read_int_env('XKEEN_MAX_ZIP_ESTIMATE_ITEMS', 200_000)))

    def _fmt_mb(n: int | None) -> str:
        try:
            if n is None:
                return ''
            return f"{(float(n) / (1024.0 * 1024.0)):.1f} MiB"
        except Exception:
            return ''


    def _apply_local_metadata_best_effort(dst_path: str, st0: os.stat_result | None) -> None:
        """Best-effort preserve mode/owner/group when overwriting a local file.

        Routers often rely on specific perms for configs/scripts. Atomic replace via
        os.replace() may reset perms depending on umask and filesystem.
        """
        if st0 is None:
            return
        try:
            mode = int(getattr(st0, 'st_mode', 0) or 0) & 0o7777
            if mode:
                try:
                    os.chmod(dst_path, mode)
                except Exception:
                    pass
            try:
                uid = int(getattr(st0, 'st_uid', -1))
                gid = int(getattr(st0, 'st_gid', -1))
                if uid >= 0 and gid >= 0:
                    os.chown(dst_path, uid, gid)
            except Exception:
                pass
        except Exception:
            return


    def _tmp_free_bytes() -> int | None:
        try:
            return int(shutil.disk_usage(TMP_DIR).free)
        except Exception:
            return None

    def _dir_walk_sum_bytes(root: str) -> tuple[int | None, int, bool]:
        """Best-effort recursive size estimate for local trees.

        Returns (bytes|None, items_count, truncated).
        """
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
                        if items > MAX_ZIP_ESTIMATE_ITEMS:
                            truncated = True
                            return
                        try:
                            st = entry.stat(follow_symlinks=False)
                        except Exception:
                            continue
                        try:
                            if entry.is_dir(follow_symlinks=False):
                                _scan_dir(os.path.join(d, entry.name))
                            else:
                                total += int(getattr(st, 'st_size', 0) or 0)
                        except Exception:
                            continue
            except Exception:
                truncated = True

        try:
            if os.path.isfile(root):
                try:
                    return int(os.path.getsize(root)), 1, False
                except Exception:
                    return None, 1, True
            if not os.path.isdir(root):
                return None, 0, True
            _scan_dir(root)
            return int(total), int(items), bool(truncated)
        except Exception:
            return None, int(items), True

    def _remote_estimate_tree_bytes(sess: Any, rpath: str) -> tuple[int | None, int, bool]:
        """Best-effort recursive size estimate for remote trees.

        Uses streaming `cls -lR` output parsing to avoid loading huge listings into RAM.
        Returns (bytes|None, entries_count, truncated).
        """
        total = 0
        entries = 0
        truncated = False

        p = None
        stdout = None
        stderr = None
        buf = b''

        def _handle_line(line: str) -> None:
            nonlocal total, entries
            item = _parse_ls_line(line)
            if not item:
                return
            t = str(item.get('type') or '')
            if t == 'dir':
                return
            # Treat non-dir as file-ish (file/link).
            try:
                total += int(item.get('size') or 0)
            except Exception:
                pass

        try:
            # Some protocols may not support -R; treat failures as unknown.
            p = mgr._popen_lftp(sess, [f"cls -lR {_lftp_quote(rpath)}"])
            stdout = p.stdout
            stderr = p.stderr
            if stdout is None:
                return None, 0, True
            while True:
                chunk = stdout.read(64 * 1024)
                if not chunk:
                    break
                buf += chunk
                while True:
                    idx = buf.find(b'\n')
                    if idx < 0:
                        break
                    line_b = buf[:idx]
                    buf = buf[idx + 1:]
                    entries += 1
                    if entries > MAX_ZIP_ESTIMATE_ITEMS:
                        truncated = True
                        try:
                            p.terminate()
                        except Exception:
                            pass
                        break
                    try:
                        _handle_line(line_b.decode('utf-8', errors='replace'))
                    except Exception:
                        pass
                if truncated:
                    break

            # flush last line
            if not truncated and buf:
                try:
                    entries += 1
                    _handle_line(buf.decode('utf-8', errors='replace'))
                except Exception:
                    pass

            try:
                rc = p.wait(timeout=2) if p else 0
            except Exception:
                rc = 0
            if int(rc or 0) != 0:
                return None, int(entries), True
            return int(total), int(entries), bool(truncated)
        except Exception:
            return None, int(entries), True
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

    def _remote_stat_type_size(sess: Any, rpath: str) -> tuple[str | None, int | None]:
        """Return (type, size) for remote path, best-effort."""
        try:
            rc, out, err = mgr._run_lftp(sess, [f"cls -ld {_lftp_quote(rpath)}"], capture=True)
            if rc != 0:
                return None, None
            text = (out or b'').decode('utf-8', errors='replace')
            for line in text.splitlines():
                item = _parse_ls_line(line)
                if not item:
                    continue
                t = str(item.get('type') or '') or None
                sz = None
                try:
                    sz = int(item.get('size'))
                except Exception:
                    sz = None
                return t, sz
        except Exception:
            return None, None
        return None, None

    def _zip_precheck_or_confirm(*, estimated_bytes: int | None, truncated: bool, confirm: bool, kind: str, tmp_need_bytes: int | None = None) -> Any | None:
        """Return a Flask response if we should block/ask-confirm, else None."""
        if MAX_ZIP_BYTES is None:
            return None

        # Hard reject if we can estimate and it's over the configured cap.
        if isinstance(estimated_bytes, int) and estimated_bytes >= 0 and estimated_bytes > MAX_ZIP_BYTES:
            return error_response(
                'zip_too_large',
                413,
                ok=False,
                estimated_bytes=int(estimated_bytes),
                max_bytes=int(MAX_ZIP_BYTES),
                hint=f"Оценка: {_fmt_mb(int(estimated_bytes))}. Лимит: {_fmt_mb(int(MAX_ZIP_BYTES))}.",
            )

        # If estimate is missing/truncated, require explicit confirmation to proceed.
        if (estimated_bytes is None or truncated) and not confirm:
            return error_response(
                'confirm_required',
                409,
                ok=False,
                estimated_bytes=estimated_bytes,
                estimate_truncated=bool(truncated),
                max_bytes=int(MAX_ZIP_BYTES),
                kind=str(kind or ''),
                message='Размер архива оценить точно не удалось. Создание ZIP может занять много места в /tmp.',
            )

        # tmp free space check (best-effort)
        if isinstance(tmp_need_bytes, int) and tmp_need_bytes > 0:
            free = _tmp_free_bytes()
            if isinstance(free, int) and free >= 0 and free < tmp_need_bytes:
                return error_response(
                    'tmp_no_space',
                    507,
                    ok=False,
                    required_bytes=int(tmp_need_bytes),
                    free_bytes=int(free),
                    message=f"Недостаточно места в /tmp для создания архива. Нужно ~{_fmt_mb(int(tmp_need_bytes))}, доступно ~{_fmt_mb(int(free))}.",
                )

        return None

    def _run_lftp_mirror_with_tmp_cap(sess: Any, *, src: str, dst: str, hard_cap_bytes: int | None) -> None:
        """Run lftp mirror (remote->local) and abort if /tmp usage grows too much.

        This is a best-effort safety net: we track global free space in TMP_DIR
        rather than measuring dst tree size.
        """
        cmd = f"mirror --verbose -- {_lftp_quote(src)} {_lftp_quote(dst)}"
        script = mgr._build_lftp_script(sess, [cmd])
        env = os.environ.copy()
        env.setdefault('LC_ALL', 'C')
        env.setdefault('LANG', 'C')

        start_free = _tmp_free_bytes()
        proc = subprocess.Popen([mgr.lftp_bin, '-c', script], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, env=env, bufsize=0)

        try:
            # Poll + enforce cap while the mirror runs.
            while proc.poll() is None:
                if isinstance(hard_cap_bytes, int) and hard_cap_bytes > 0 and isinstance(start_free, int) and start_free > 0:
                    cur_free = _tmp_free_bytes()
                    if isinstance(cur_free, int) and cur_free >= 0:
                        used = int(start_free - cur_free)
                        if used > hard_cap_bytes:
                            try:
                                proc.terminate()
                            except Exception:
                                pass
                            raise RuntimeError('tmp_limit_exceeded')
                time.sleep(0.25)

            _out, _err = proc.communicate()
            if int(proc.returncode or 0) != 0:
                tail = ((_err or b'').decode('utf-8', errors='replace')[-400:]).strip()
                raise RuntimeError('mirror_failed:' + tail)

        finally:
            try:
                if proc and proc.stderr:
                    proc.stderr.close()
            except Exception:
                pass

    # Remote manager proxy (available only when remote blueprint is registered).
    mgr = LocalProxy(lambda: current_app.extensions.get("xkeen.remotefs_mgr"))

    def _infer_target() -> str:
        # Try args, then form, then JSON (best-effort).
        try:
            t = request.args.get("target")
            if t:
                return str(t).strip().lower()
        except Exception:
            pass
        try:
            t = request.form.get("target")
            if t:
                return str(t).strip().lower()
        except Exception:
            pass
        try:
            data = request.get_json(silent=True)
            if isinstance(data, dict) and data.get("target"):
                return str(data.get("target") or "").strip().lower()
        except Exception:
            pass
        return ""

    def _require_enabled() -> Optional[Any]:
        """Remote gating for /api/fs/*.

        The original implementation gated everything under remotefs. Here we
        only gate remote actions; local actions must remain available.
        """
        target = _infer_target()
        if target != "remote":
            return None
        mgr_obj = current_app.extensions.get("xkeen.remotefs_mgr")
        if not mgr_obj or not getattr(mgr_obj, "enabled", False):
            return error_response("feature_disabled", 404, ok=False)
        return None

    def _get_session_or_404(sid: str):
        if (resp := _require_enabled()) is not None:
            return None, resp
        mgr_obj = current_app.extensions.get("xkeen.remotefs_mgr")
        if not mgr_obj:
            return None, error_response("feature_disabled", 404, ok=False)
        s = mgr_obj.get(sid)
        if not s:
            return None, error_response("session_not_found", 404, ok=False)
        try:
            mgr_obj._touch(sid)
        except Exception:
            pass
        return s, None

    def _remote_is_dir(sess: Any, rpath: str) -> bool | None:
        """Return True/False if path exists and is dir/file, or None if missing."""
        try:
            rc, out, err = mgr._run_lftp(sess, [f"cls -ld {_lftp_quote(rpath)}"], capture=True)
        except Exception:
            return None
        if rc != 0:
            return None
        text = out.decode("utf-8", errors="replace")
        for line in text.splitlines():
            item = _parse_ls_line(line)
            if item:
                return item.get("type") == "dir"
        return None

    def _remote_exists(sess: Any, rpath: str) -> bool:
        return _remote_is_dir(sess, rpath) is not None

    @bp.get('/api/fs/list')
    def api_fs_list() -> Any:
        if (resp := _require_enabled()) is not None:
            return resp
        target = str(request.args.get('target', '') or '').strip().lower()
        if target not in ('local', 'remote'):
            return error_response('bad_target', 400, ok=False)

        confirm = str(request.args.get('confirm', '') or '').strip().lower() in ('1', 'true', 'yes', 'on')

        confirm = str(request.args.get('confirm', '') or '').strip().lower() in ('1', 'true', 'yes', 'on')
        dry_run = str(request.args.get('dry_run', '') or request.args.get('preflight', '') or '').strip().lower() in ('1', 'true', 'yes', 'on')

        if target == 'local':
            path = request.args.get('path', '')
            try:
                rp = _local_resolve(path, LOCALFS_ROOTS)
            except PermissionError as e:
                return error_response(str(e), 403, ok=False)
            if not os.path.isdir(rp):
                return error_response('not_a_directory', 400, ok=False)

            # Trash metadata ("Откуда удалено")
            trash_root: str | None = None
            trash_meta_dir: str | None = None
            in_trash_root = False
            trash_from_map: Dict[str, str] = {}
            try:
                trash_root, trash_meta_dir = _local_trash_dirs(LOCALFS_ROOTS)
                in_trash_root = os.path.normpath(rp) == os.path.normpath(trash_root)
                if in_trash_root and trash_meta_dir and os.path.isdir(trash_meta_dir):
                    with os.scandir(trash_meta_dir) as md:
                        for me in md:
                            try:
                                if not me.is_file(follow_symlinks=False):
                                    continue
                                if not me.name.endswith('.json'):
                                    continue
                                key = me.name[:-5]
                                if not key:
                                    continue
                                with open(me.path, 'r', encoding='utf-8') as f:
                                    j = json.load(f) if f else {}
                                op = str((j or {}).get('orig_path') or '').strip()
                                if op:
                                    trash_from_map[key] = op
                            except Exception:
                                continue
            except Exception:
                pass
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
                        if in_trash_root and entry.name == _TRASH_META_DIRNAME:
                            continue
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

                            if in_trash_root:
                                try:
                                    item['trash_from'] = trash_from_map.get(entry.name, '')
                                except Exception:
                                    pass

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

            out = {'ok': True, 'target': 'local', 'path': rp, 'roots': LOCALFS_ROOTS, 'items': items}
            if trash_root:
                out['trash_root'] = trash_root
            # Trash usage stats (for UI warnings)
            try:
                out['trash'] = _local_trash_stats(LOCALFS_ROOTS)
            except Exception:
                pass
            return jsonify(out)

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
        confirm = str(request.args.get('confirm', '') or '').strip().lower() in ('1', 'true', 'yes', 'on')
        dry_run = str(request.args.get('dry_run', '') or request.args.get('preflight', '') or '').strip().lower() in ('1', 'true', 'yes', 'on')
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
                tmp_zip = os.path.join(TMP_DIR, f"xkeen_zip_local_{uuid.uuid4().hex}.zip")
                try:
                    est_bytes, est_items, est_trunc = None, 0, False
                    if MAX_ZIP_BYTES is not None or dry_run:
                        est_bytes, est_items, est_trunc = _dir_walk_sum_bytes(rp)

                    # Rough tmp need: resulting ZIP is typically <= total bytes (plus headers).
                    tmp_need = None
                    if isinstance(est_bytes, int) and est_bytes >= 0:
                        tmp_need = int(est_bytes * 1.20) + (8 * 1024 * 1024)
                    elif MAX_ZIP_BYTES is not None:
                        tmp_need = int(MAX_ZIP_BYTES * 1.20) + (8 * 1024 * 1024)

                    if dry_run:
                        return jsonify({
                            'ok': True,
                            'dry_run': True,
                            'kind': 'download_dir_zip',
                            'target': 'local',
                            'path': rp,
                            'estimated_bytes': est_bytes,
                            'estimate_items': est_items,
                            'estimate_truncated': bool(est_trunc),
                            'max_bytes': MAX_ZIP_BYTES,
                            'tmp_free_bytes': _tmp_free_bytes(),
                            'tmp_need_bytes': tmp_need,
                            'confirm_required': bool((MAX_ZIP_BYTES is not None) and (est_bytes is None or est_trunc)),
                        })

                    if (resp3 := _zip_precheck_or_confirm(
                        estimated_bytes=est_bytes,
                        truncated=bool(est_trunc),
                        confirm=bool(confirm),
                        kind='download_dir_zip_local',
                        tmp_need_bytes=tmp_need,
                    )) is not None:
                        return resp3

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
                        'Content-Disposition': _content_disposition_attachment(zip_name),
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
            tmp_root = os.path.join(TMP_DIR, f"xkeen_zip_remote_{sid}_{uuid.uuid4().hex}")
            tmp_dir = os.path.join(tmp_root, base)
            tmp_zip = os.path.join(TMP_DIR, f"xkeen_zip_remote_{sid}_{uuid.uuid4().hex}.zip")
            try:
                est_bytes, est_items, est_trunc = None, 0, False
                if MAX_ZIP_BYTES is not None or dry_run:
                    est_bytes, est_items, est_trunc = _remote_estimate_tree_bytes(s, path)
                # Rough tmp need: mirror data + resulting ZIP. Worst-case ~2x.
                tmp_need = None
                if isinstance(est_bytes, int) and est_bytes >= 0:
                    tmp_need = int(est_bytes * 2.20) + (32 * 1024 * 1024)
                elif MAX_ZIP_BYTES is not None:
                    tmp_need = int(MAX_ZIP_BYTES * 2.20) + (32 * 1024 * 1024)

                if dry_run:
                    return jsonify({
                        'ok': True,
                        'dry_run': True,
                        'kind': 'download_dir_zip',
                        'target': 'remote',
                        'sid': sid,
                        'path': path,
                        'estimated_bytes': est_bytes,
                        'estimate_items': est_items,
                        'estimate_truncated': bool(est_trunc),
                        'max_bytes': MAX_ZIP_BYTES,
                        'tmp_free_bytes': _tmp_free_bytes(),
                        'tmp_need_bytes': tmp_need,
                        'confirm_required': bool((MAX_ZIP_BYTES is not None) and (est_bytes is None or est_trunc)),
                    })

                if (resp3 := _zip_precheck_or_confirm(
                    estimated_bytes=est_bytes,
                    truncated=bool(est_trunc),
                    confirm=bool(confirm),
                    kind='download_dir_zip_remote',
                    tmp_need_bytes=tmp_need,
                )) is not None:
                    return resp3

                os.makedirs(tmp_dir, exist_ok=True)

                # Use lftp mirror to fetch the folder into tmp_dir.
                hard_cap = None
                if MAX_ZIP_BYTES is not None:
                    # Allow ~2x of cap (mirror+zip) + headroom.
                    base_cap = est_bytes if isinstance(est_bytes, int) and est_bytes >= 0 else MAX_ZIP_BYTES
                    hard_cap = int(base_cap * 2.50) + (32 * 1024 * 1024)
                _run_lftp_mirror_with_tmp_cap(s, src=path, dst=tmp_dir, hard_cap_bytes=hard_cap)

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
                    'Content-Disposition': _content_disposition_attachment(zip_name),
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
                if msg == 'tmp_limit_exceeded':
                    return error_response(
                        'tmp_limit_exceeded',
                        413,
                        ok=False,
                        max_bytes=MAX_ZIP_BYTES,
                        message='Создание архива прервано: превышен лимит использования /tmp (см. XKEEN_MAX_ZIP_MB).',
                    )
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
            'Content-Disposition': _content_disposition_attachment(filename),
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
        dry_run = (
            str(request.args.get('dry_run', '') or request.args.get('preflight', '') or '').strip().lower() in ('1', 'true', 'yes', 'on')
            or str(data.get('dry_run', '') or '').strip().lower() in ('1', 'true', 'yes', 'on')
        )
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

        os.makedirs(TMP_DIR, exist_ok=True)

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

            # Preserve perms/owner when overwriting an existing file.
            st0 = None
            try:
                if os.path.exists(rp):
                    st0 = os.stat(rp)
            except Exception:
                st0 = None

            if dry_run:
                return jsonify({'ok': True, 'dry_run': True, 'bytes': len(raw), 'would_overwrite': bool(os.path.exists(rp))})

            tmp_path = os.path.join(TMP_DIR, f"xkeen_write_local_{uuid.uuid4().hex}.tmp")
            try:
                with open(tmp_path, 'wb') as fp:
                    fp.write(raw)
                try:
                    os.replace(tmp_path, rp)
                except Exception:
                    shutil.move(tmp_path, rp)

                _apply_local_metadata_best_effort(rp, st0)

            except Exception:
                try:
                    if os.path.exists(tmp_path):
                        os.remove(tmp_path)
                except Exception:
                    pass
                return error_response('write_failed', 400, ok=False)
            _core_log("info", "fs.write", target="local", path=path_s, bytes=len(raw), dry_run=bool(dry_run))
            return jsonify({'ok': True, 'bytes': len(raw)})
        # remote
        sid = str(data.get('sid') or '').strip()
        if not sid:
            return error_response('sid_required', 400, ok=False)
        s, resp = _get_session_or_404(sid)
        if resp is not None:
            return resp

        tmp_path = os.path.join(TMP_DIR, f"xkeen_write_remote_{sid}_{uuid.uuid4().hex}.tmp")
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
            _core_log("info", "fs.write", target="remote", sid=sid, path=path_s, bytes=len(raw), dry_run=False)
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

        confirm = str(request.args.get('confirm', '') or '').strip().lower() in ('1', 'true', 'yes', 'on')

        data = request.get_json(silent=True) or {}
        dry_run = (
            str(request.args.get('dry_run', '') or request.args.get('preflight', '') or '').strip().lower() in ('1', 'true', 'yes', 'on')
            or str(data.get('dry_run', '') or '').strip().lower() in ('1', 'true', 'yes', 'on')
        )
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

        os.makedirs(TMP_DIR, exist_ok=True)
        tmp_zip = os.path.join(TMP_DIR, f"xkeen_zip_selection_{uuid.uuid4().hex}.zip")

        if target == 'local':
            resolved: List[Tuple[str, str]] = []
            try:
                total_est: int | None = 0
                total_items = 0
                total_trunc = False
                for it in items:
                    try:
                        rp = _local_resolve(it['path'], LOCALFS_ROOTS)
                    except PermissionError as e:
                        raise RuntimeError(str(e))
                    if not os.path.exists(rp):
                        raise RuntimeError('not_found')
                    resolved.append((rp, str(it.get('name') or it['path'])))

                    if MAX_ZIP_BYTES is not None or dry_run:
                        est_b, est_n, est_t = _dir_walk_sum_bytes(rp)
                        total_items += int(est_n or 0)
                        if est_b is None:
                            total_est = None
                        elif total_est is not None:
                            try:
                                total_est += int(est_b)
                            except Exception:
                                total_est = None
                        if est_t:
                            total_trunc = True

                # Rough tmp need: ZIP file itself (<= total bytes in many cases) + headroom.
                tmp_need = None
                if isinstance(total_est, int) and total_est >= 0:
                    tmp_need = int(total_est * 1.20) + (16 * 1024 * 1024)
                elif MAX_ZIP_BYTES is not None:
                    tmp_need = int(MAX_ZIP_BYTES * 1.20) + (16 * 1024 * 1024)

                if dry_run:
                    return jsonify({
                        'ok': True,
                        'dry_run': True,
                        'kind': 'archive_selection',
                        'target': 'local',
                        'zip_name': zip_name,
                        'root_name': root_name,
                        'estimated_bytes': total_est,
                        'estimate_items': total_items,
                        'estimate_truncated': bool(total_trunc),
                        'max_bytes': MAX_ZIP_BYTES,
                        'tmp_free_bytes': _tmp_free_bytes(),
                        'tmp_need_bytes': tmp_need,
                        'confirm_required': bool((MAX_ZIP_BYTES is not None) and (total_est is None or total_trunc)),
                    })

                if (resp3 := _zip_precheck_or_confirm(
                    estimated_bytes=total_est,
                    truncated=bool(total_trunc),
                    confirm=bool(confirm),
                    kind='archive_selection_local',
                    tmp_need_bytes=tmp_need,
                )) is not None:
                    return resp3

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
                    'Content-Disposition': _content_disposition_attachment(zip_name),
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

        # Best-effort size estimation + tmp safety check.
        total_est: int | None = None
        total_entries = 0
        total_trunc = False
        if MAX_ZIP_BYTES is not None or dry_run:
            total_est = 0
            for it in items:
                rpath = str(it.get('path') or '').strip()
                if not rpath:
                    continue
                is_dir = it.get('is_dir', None)
                if is_dir is None:
                    t, _sz = _remote_stat_type_size(s, rpath)
                    if t is None:
                        total_est = None
                        total_trunc = True
                        continue
                    is_dir = (t == 'dir')
                if is_dir:
                    est_b, est_n, est_t = _remote_estimate_tree_bytes(s, rpath)
                    total_entries += int(est_n or 0)
                    if est_b is None:
                        total_est = None
                    elif total_est is not None:
                        try:
                            total_est += int(est_b)
                        except Exception:
                            total_est = None
                    if est_t:
                        total_trunc = True
                else:
                    t, sz = _remote_stat_type_size(s, rpath)
                    total_entries += 1
                    if sz is None:
                        total_est = None
                    elif total_est is not None:
                        try:
                            total_est += int(sz)
                        except Exception:
                            total_est = None

        tmp_need = None
        if isinstance(total_est, int) and total_est >= 0:
            tmp_need = int(total_est * 2.20) + (32 * 1024 * 1024)
        elif MAX_ZIP_BYTES is not None:
            tmp_need = int(MAX_ZIP_BYTES * 2.20) + (32 * 1024 * 1024)

        if dry_run:
            # No filesystem side effects.
            return jsonify({
                'ok': True,
                'dry_run': True,
                'kind': 'archive_selection',
                'target': 'remote',
                'sid': sid,
                'zip_name': zip_name,
                'root_name': root_name,
                'estimated_bytes': total_est,
                'estimate_items': total_entries,
                'estimate_truncated': bool(total_trunc),
                'max_bytes': MAX_ZIP_BYTES,
                'tmp_free_bytes': _tmp_free_bytes(),
                'tmp_need_bytes': tmp_need,
                'confirm_required': bool((MAX_ZIP_BYTES is not None) and (total_est is None or total_trunc)),
            })

        if (resp3 := _zip_precheck_or_confirm(
            estimated_bytes=total_est,
            truncated=bool(total_trunc),
            confirm=bool(confirm),
            kind='archive_selection_remote',
            tmp_need_bytes=tmp_need,
        )) is not None:
            try:
                if os.path.exists(tmp_zip):
                    os.remove(tmp_zip)
            except Exception:
                pass
            return resp3

        tmp_root = os.path.join(TMP_DIR, f"xkeen_zip_multi_{sid}_{uuid.uuid4().hex}")
        tmp_payload = os.path.join(tmp_root, root_name)
        try:
            os.makedirs(tmp_payload, exist_ok=True)

            start_free = _tmp_free_bytes()
            hard_cap = None
            if MAX_ZIP_BYTES is not None:
                base_cap = total_est if isinstance(total_est, int) and total_est >= 0 else MAX_ZIP_BYTES
                hard_cap = int(base_cap * 2.50) + (32 * 1024 * 1024)

            def _enforce_tmp_cap() -> None:
                if isinstance(hard_cap, int) and hard_cap > 0 and isinstance(start_free, int) and start_free > 0:
                    cur_free = _tmp_free_bytes()
                    if isinstance(cur_free, int) and cur_free >= 0:
                        used = int(start_free - cur_free)
                        if used > hard_cap:
                            raise RuntimeError('tmp_limit_exceeded')

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
                    _enforce_tmp_cap()
                    _run_lftp_mirror_with_tmp_cap(s, src=rpath, dst=dest, hard_cap_bytes=hard_cap)
                    _enforce_tmp_cap()
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
                                # avoid killing the device by filling /tmp
                                _enforce_tmp_cap()
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
                'Content-Disposition': _content_disposition_attachment(zip_name),
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
            if msg == 'tmp_limit_exceeded':
                return error_response(
                    'tmp_limit_exceeded',
                    413,
                    ok=False,
                    max_bytes=MAX_ZIP_BYTES,
                    message='Создание архива прервано: превышен лимит использования /tmp (см. XKEEN_MAX_ZIP_MB).',
                )
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

        # By default we do NOT overwrite existing files.
        # The UI should handle conflicts and retry with overwrite=1.
        overwrite = str(request.args.get('overwrite', '') or '').strip().lower() in ('1', 'true', 'yes', 'on')

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

        max_bytes = int(MAX_UPLOAD_MB) * 1024 * 1024
        os.makedirs(TMP_DIR, exist_ok=True)

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

            # Prevent destructive overwrite by default.
            # Preserve perms/owner when overwrite is explicitly allowed.
            st0 = None
            try:
                if os.path.lexists(rp):
                    if os.path.isdir(rp):
                        return error_response('not_a_file', 400, ok=False)
                    if not overwrite:
                        etype = 'file'
                        try:
                            stx = os.lstat(rp)
                            mode_i = int(getattr(stx, 'st_mode', 0) or 0)
                            if stat.S_ISLNK(mode_i):
                                etype = 'link'
                        except Exception:
                            etype = 'file'
                        return error_response('exists', 409, ok=False, target='local', path=rp, type=etype)
                    try:
                        st0 = os.stat(rp)
                    except Exception:
                        st0 = None
            except Exception:
                st0 = None

            tmp_path = os.path.join(TMP_DIR, f"xkeen_upload_local_{uuid.uuid4().hex}.tmp")
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
                    return error_response('upload_too_large', 413, ok=False, max_mb=MAX_UPLOAD_MB)
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
            _apply_local_metadata_best_effort(rp, st0)
            _core_log("info", "fs.upload", target="local", path=str(rp), bytes=int(total), overwrite=bool(overwrite))
            return jsonify({'ok': True, 'bytes': total, 'path': rp})

        # remote
        sid = str(request.args.get('sid') or '').strip()
        if not sid:
            return error_response('sid_required', 400, ok=False)
        s, resp = _get_session_or_404(sid)
        if resp is not None:
            return resp

        remote_path = path
        # If user passed a directory, append file name.
        if remote_path.endswith('/'):
            remote_path = remote_path.rstrip('/') + '/' + safe_fn
        else:
            try:
                isdir = _remote_is_dir(s, remote_path)
                if isdir is True:
                    remote_path = remote_path.rstrip('/') + '/' + safe_fn
            except Exception:
                pass

        # Prevent destructive overwrite by default.
        if not overwrite:
            try:
                isdir = _remote_is_dir(s, remote_path)
                if isdir is True:
                    return error_response('not_a_file', 400, ok=False, target='remote', path=remote_path, type='dir')
                if isdir is False:
                    return error_response('exists', 409, ok=False, target='remote', path=remote_path, type='file')
            except Exception:
                pass

        tmp_path = os.path.join(TMP_DIR, f"xkeen_upload_{sid}_{uuid.uuid4().hex}.tmp")
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
                return error_response('upload_too_large', 413, ok=False, max_mb=MAX_UPLOAD_MB)
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
            _core_log("info", "fs.upload", target="remote", sid=sid, path=remote_path, bytes=int(total), overwrite=bool(overwrite))
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
            _core_log("info", "fs.mkdir", target="local", path=path_s, parents=bool(parents))
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


    @bp.post('/api/fs/restore')
    def api_fs_restore() -> Any:
        """Restore entries from trash back to their original locations.

        Body (JSON):
          { 'target': 'local', 'paths': ['/opt/var/trash/<name>', ...] }
        """
        if (resp := _require_enabled()) is not None:
            return resp
        data = request.get_json(silent=True) or {}
        target = str((data.get('target') or 'local')).strip().lower()
        if target != 'local':
            return error_response('bad_target', 400, ok=False)
        paths = data.get('paths')
        if not isinstance(paths, list):
            p1 = data.get('path')
            paths = [p1] if p1 else []
        paths = [str(x or '').strip() for x in paths if str(x or '').strip()]
        if not paths:
            return error_response('path_required', 400, ok=False)

        restored = []
        errors = []
        for pth in paths:
            try:
                info = _local_restore_from_trash(pth, LOCALFS_ROOTS)
                restored.append(info)
            except PermissionError as e:
                errors.append({'path': pth, 'error': str(e)})
            except Exception as e:
                errors.append({'path': pth, 'error': str(e) or 'restore_failed'})
        _core_log("info", "fs.restore", target="local", restored=len(restored), errors=len(errors))
        return jsonify({'ok': True, 'restored': restored, 'errors': errors})


    @bp.post('/api/fs/trash/clear')
    def api_fs_trash_clear() -> Any:
        """Permanently remove everything inside the local trash directory."""
        if (resp := _require_enabled()) is not None:
            return resp
        data = request.get_json(silent=True) or {}
        target = str((data.get('target') or 'local')).strip().lower()
        if target != 'local':
            return error_response('bad_target', 400, ok=False)

        try:
            trash_root, meta_dir = _local_trash_dirs(LOCALFS_ROOTS)
        except PermissionError as e:
            return error_response(str(e), 403, ok=False)
        except Exception:
            return error_response('trash_not_configured', 400, ok=False)

        # Ensure directories exist.
        try:
            os.makedirs(trash_root, exist_ok=True)
            os.makedirs(meta_dir, exist_ok=True)
        except Exception:
            return error_response('trash_init_failed', 400, ok=False)

        deleted = 0
        meta_deleted = 0
        errors: List[Dict[str, Any]] = []

        # Delete content of trash root, but keep metadata dir itself.
        try:
            with os.scandir(trash_root) as it:
                for entry in it:
                    try:
                        if entry.name == _TRASH_META_DIRNAME:
                            continue
                        p = entry.path
                        if entry.is_dir(follow_symlinks=False):
                            shutil.rmtree(p)
                        else:
                            os.unlink(p)
                        deleted += 1
                    except Exception as e:
                        errors.append({'path': entry.path, 'error': str(e) or 'delete_failed'})
        except Exception as e:
            return error_response('trash_clear_failed', 400, ok=False, details=str(e) or '')

        # Clear meta files
        try:
            with os.scandir(meta_dir) as it:
                for entry in it:
                    try:
                        p = entry.path
                        if entry.is_dir(follow_symlinks=False):
                            shutil.rmtree(p)
                        else:
                            os.unlink(p)
                        meta_deleted += 1
                    except Exception as e:
                        errors.append({'path': entry.path, 'error': str(e) or 'delete_failed'})
        except Exception:
            pass
        _core_log("info", "fs.trash_clear", deleted=int(deleted), meta_deleted=int(meta_deleted), errors=len(errors))
        return jsonify({'ok': True, 'deleted': deleted, 'meta_deleted': meta_deleted, 'errors': errors})


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
                sp = _local_resolve_nofollow(src_p, LOCALFS_ROOTS)
                dp = _local_resolve_nofollow(dst_p, LOCALFS_ROOTS)
            except PermissionError as e:
                return error_response(str(e), 403, ok=False)
            if _local_is_protected_entry_abs(sp) or _local_is_protected_entry_abs(dp):
                return error_response('protected_path', 403, ok=False)
            try:
                os.rename(sp, dp)
            except FileNotFoundError:
                return error_response('not_found', 404, ok=False)
            except Exception:
                return error_response('rename_failed', 400, ok=False)
            _core_log("info", "fs.rename", target="local", src=src_p, dst=dst_p)
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
                ap = _local_resolve_nofollow(path_s, LOCALFS_ROOTS)
            except PermissionError as e:
                return error_response(str(e), 403, ok=False)

            # Use lexists so broken symlinks can still be removed.
            if not os.path.lexists(ap):
                return error_response('not_found', 404, ok=False)

            # Корзина вместо удаления: по умолчанию перемещаем в /opt/var/trash.
            # Для окончательного удаления поддерживаем ?hard=1 (или ?permanent=1).
            hard = (request.args.get('hard', '0') or '') in ('1', 'true', 'yes', 'on') or (request.args.get('permanent', '0') or '') in ('1', 'true', 'yes', 'on')
            try:
                info = _local_soft_delete(ap, LOCALFS_ROOTS, hard=bool(hard))
            except PermissionError as e:
                code = str(e)
                if code == 'refuse_delete_mountpoint':
                    return error_response(code, 403, ok=False)
                return error_response(code or 'path_not_allowed', 403, ok=False)
            except Exception:
                return error_response('remove_failed', 400, ok=False)
            _core_log("info", "fs.remove", target="local", path=path_s, hard=bool(hard), recursive=bool(recursive))
            return jsonify({'ok': True, 'delete': info})

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
            _core_log("info", "fs.remove", target="remote", sid=sid, path=path_s, recursive=True)
            return jsonify({'ok': True})
        rc, out, err = mgr._run_lftp(s, [f"rm {_lftp_quote(path_s)}"], capture=True)
        if rc == 0:
            _core_log("info", "fs.remove", target="remote", sid=sid, path=path_s, recursive=False)
            return jsonify({'ok': True})
        rc2, out2, err2 = mgr._run_lftp(s, [f"rmdir {_lftp_quote(path_s)}"], capture=True)
        if rc2 != 0:
            tail = (err2.decode('utf-8', errors='replace')[-400:]).strip()
            return error_response('remove_failed', 400, ok=False, details=tail)
        _core_log("info", "fs.remove", target="remote", sid=sid, path=path_s, recursive=False, rmdir=True)
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
            _core_log("info", "fs.chmod", target="local", path=path_s, mode=oct(mode_i))
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
        _core_log("info", "fs.chmod", target="remote", sid=sid, path=path_s, mode=oct(mode_i))
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
            _core_log("info", "fs.chown", target="local", path=path_s, uid=int(uid_i), gid=int(gid_i))
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
        _core_log("info", "fs.chown", target="remote", sid=sid, path=path_s, uid=int(uid_i), gid=int(gid_i))
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
                    _core_log("info", "fs.touch", target="local", path=path_s, skipped=True)
                    return jsonify({'ok': True, 'target': 'local', 'path': rp, 'skipped': True})
                if not os.path.exists(rp):
                    with open(rp, 'a', encoding='utf-8'):
                        pass
                os.utime(rp, None)
            except Exception:
                return error_response('touch_failed', 400, ok=False)
            _core_log("info", "fs.touch", target="local", path=path_s, skipped=False)
            return jsonify({'ok': True, 'target': 'local', 'path': rp})

        sid = str(data.get('sid') or '').strip()
        if not sid:
            return error_response('sid_required', 400, ok=False)
        s, resp = _get_session_or_404(sid)
        if resp is not None:
            return resp

        # Avoid destructive overwrite by default.
        if create_only and _remote_exists(s, path_s):
            _core_log("info", "fs.touch", target="remote", sid=sid, path=path_s, skipped=True)
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
        _core_log("info", "fs.touch", target="remote", sid=sid, path=path_s, skipped=False)
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
                    ap = _local_resolve_nofollow(p, LOCALFS_ROOTS)
                except PermissionError:
                    out_items.append({'path': p, 'exists': False, 'error': 'forbidden'})
                    continue

                if not os.path.lexists(ap):
                    out_items.append({'path': ap, 'exists': False})
                    continue

                try:
                    st = os.lstat(ap)
                    mode_i = int(getattr(st, 'st_mode', 0) or 0)

                    is_link = stat.S_ISLNK(mode_i)
                    is_dir = stat.S_ISDIR(mode_i)

                    perm_s = None
                    try:
                        perm_s = stat.filemode(mode_i)
                    except Exception:
                        perm_s = None

                    link_target = None
                    link_dir = False
                    if is_link:
                        try:
                            link_target = os.readlink(ap)
                        except Exception:
                            link_target = None
                        # If link points to an allowed directory, expose it for UI convenience.
                        try:
                            target_real = os.path.realpath(ap)
                            if _local_is_allowed(target_real, LOCALFS_ROOTS) and os.path.isdir(target_real):
                                link_dir = True
                        except Exception:
                            link_dir = False

                    out_items.append({
                        'path': ap,
                        'path_real': os.path.realpath(ap),
                        'exists': True,
                        'type': 'link' if is_link else ('dir' if is_dir else 'file'),
                        'size': int(getattr(st, 'st_size', 0) or 0),
                        'mode': mode_i,
                        'perm': perm_s,
                        'uid': int(getattr(st, 'st_uid', -1) or -1),
                        'gid': int(getattr(st, 'st_gid', -1) or -1),
                        'mtime': int(getattr(st, 'st_mtime', 0) or 0),
                        'atime': int(getattr(st, 'st_atime', 0) or 0),
                        'link_target': link_target,
                        'link_dir': bool(link_dir) if is_link else False,
                    })
                except Exception:
                    out_items.append({'path': ap, 'exists': False, 'error': 'stat_failed'})
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
                'link_target': item.get('link_target'),
            })
        return jsonify({'ok': True, 'target': 'remote', 'sid': sid, 'items': out_items})


    @bp.get('/api/fs/checksum')
    def api_fs_checksum() -> Any:
        """Compute md5 and sha256 for a single file.

        Query params:
          target=local|remote
          path=<full path>
          sid=<remote session id> (for target=remote)

        Returns JSON:
          { ok: true, target, path, size, md5, sha256 }
        """
        if (resp := _require_enabled()) is not None:
            return resp

        target = str(request.args.get('target', '') or '').strip().lower()
        path = str(request.args.get('path', '') or '').strip()
        if target not in ('local', 'remote'):
            return error_response('bad_target', 400, ok=False)
        if not path:
            return error_response('path_required', 400, ok=False)

        # Routers can be slow; keep memory bounded and stream.
        CHUNK = 256 * 1024

        def _hash_stream(fp) -> tuple[str, str, int]:
            md5 = hashlib.md5()
            sha = hashlib.sha256()
            total = 0
            while True:
                chunk = fp.read(CHUNK)
                if not chunk:
                    break
                total += len(chunk)
                md5.update(chunk)
                sha.update(chunk)
            return md5.hexdigest(), sha.hexdigest(), total

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
                with open(rp, 'rb') as fp:
                    md5_hex, sha_hex, total = _hash_stream(fp)
            except Exception:
                return error_response('read_failed', 400, ok=False)

            # Prefer stat size (might differ from streamed total for special files)
            size_bytes: int | None
            try:
                size_bytes = int(os.path.getsize(rp))
            except Exception:
                size_bytes = int(total)

            return jsonify({
                'ok': True,
                'target': 'local',
                'path': rp,
                'size': size_bytes,
                'md5': md5_hex,
                'sha256': sha_hex,
            })

        # remote
        sid = str(request.args.get('sid') or '').strip()
        if not sid:
            return error_response('sid_required', 400, ok=False)
        s, resp = _get_session_or_404(sid)
        if resp is not None:
            return resp

        # Determine type/size early.
        rtype, rsize = _remote_stat_type_size(s, path)
        if rtype is None:
            return error_response('not_found', 404, ok=False)
        if rtype == 'dir':
            return error_response('not_a_file', 400, ok=False)

        p2 = None
        stdout = None
        stderr = None
        try:
            p2 = mgr._popen_lftp(s, [f"cat {_lftp_quote(path)}"])
            stdout = p2.stdout
            stderr = p2.stderr
            if stdout is None:
                raise RuntimeError('no_stdout')

            md5 = hashlib.md5()
            sha = hashlib.sha256()
            total = 0
            while True:
                chunk = stdout.read(CHUNK)
                if not chunk:
                    break
                total += len(chunk)
                md5.update(chunk)
                sha.update(chunk)

            # Ensure lftp finished successfully.
            try:
                rc = p2.wait(timeout=3)
            except Exception:
                rc = None

            if rc is not None and int(rc) != 0:
                return error_response('read_failed', 400, ok=False)

            return jsonify({
                'ok': True,
                'target': 'remote',
                'sid': sid,
                'path': path,
                'size': rsize if isinstance(rsize, int) else int(total),
                'md5': md5.hexdigest(),
                'sha256': sha.hexdigest(),
            })
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
                    try:
                        # Terminate only if still running.
                        if getattr(p2, 'poll', None) and p2.poll() is None:
                            try:
                                p2.terminate()
                            except Exception:
                                pass
                    except Exception:
                        pass
                    try:
                        p2.wait(timeout=1)
                    except Exception:
                        pass
            except Exception:
                pass




    return bp

