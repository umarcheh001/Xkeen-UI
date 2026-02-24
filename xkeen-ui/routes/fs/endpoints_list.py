"""FS endpoints: list + stat-batch.

These endpoints were extracted from routes.fs.blueprint to keep the blueprint
module from becoming unmaintainable.

Implementation note: we keep the logic identical and inject dependencies via
`deps` to avoid importing from other route modules.
"""

from __future__ import annotations

import json
import os
import re
import stat
from typing import Any, Dict, List

from flask import jsonify, request


def register_list_endpoints(bp, deps: Dict[str, Any]) -> None:
    error_response = deps["error_response"]
    _require_enabled = deps["_require_enabled"]
    _get_session_or_404 = deps["_get_session_or_404"]

    LOCALFS_ROOTS = deps["LOCALFS_ROOTS"]

    mgr = deps["mgr"]
    _lftp_quote = deps["_lftp_quote"]
    _parse_ls_line = deps["_parse_ls_line"]

    _local_norm_abs = deps["_local_norm_abs"]
    _local_resolve = deps["_local_resolve"]
    _local_resolve_nofollow = deps["_local_resolve_nofollow"]
    _local_is_allowed = deps["_local_is_allowed"]
    _local_item_from_stat = deps["_local_item_from_stat"]
    _local_trash_dirs = deps["_local_trash_dirs"]
    _local_trash_stats = deps["_local_trash_stats"]
    _TRASH_META_DIRNAME = deps["_TRASH_META_DIRNAME"]

    dir_size_bytes_best_effort = deps["dir_size_bytes_best_effort"]

    @bp.get("/api/fs/list")
    def api_fs_list() -> Any:
        if (resp := _require_enabled()) is not None:
            return resp
        target = str(request.args.get("target", "") or "").strip().lower()
        if target not in ("local", "remote"):
            return error_response("bad_target", 400, ok=False)

        if target == "local":
            path_in = str(request.args.get("path", "") or "")
            try:
                # Keep a non-realpath absolute path for UI/breadcrumbs (preserves /tmp/mnt/<LABEL> symlinks),
                # while still resolving realpath for security checks and actual FS access.
                ap = _local_norm_abs(path_in, LOCALFS_ROOTS)
                rp = _local_resolve(path_in, LOCALFS_ROOTS)
            except PermissionError as e:
                return error_response(str(e), 403, ok=False)

            # Distinguish "missing" from "not a directory" to keep UI messages sane.
            if not os.path.exists(rp):
                return error_response("not_found", 404, ok=False)
            if not os.path.isdir(rp):
                return error_response("not_a_directory", 400, ok=False)

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
                                if not me.name.endswith(".json"):
                                    continue
                                key = me.name[:-5]
                                if not key:
                                    continue
                                with open(me.path, "r", encoding="utf-8") as f:
                                    j = json.load(f) if f else {}
                                op = str((j or {}).get("orig_path") or "").strip()
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
            is_tmp_mnt_root = os.path.normpath(rp) == "/tmp/mnt"

            def _looks_like_uuid(name: str) -> bool:
                try:
                    n = str(name or "")
                    # Canonical UUID with dashes
                    if re.match(
                        r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
                        n,
                    ):
                        return True
                    # Some systems may expose long hex-only mount ids
                    if re.match(r"^[0-9a-fA-F]{24,}$", n):
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
                                    item["trash_from"] = trash_from_map.get(entry.name, "")
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
            except FileNotFoundError:
                return error_response("not_found", 404, ok=False)
            except PermissionError as e:
                return error_response(str(e), 403, ok=False)
            except Exception:
                return error_response("list_failed", 400, ok=False)

            items: List[Dict[str, Any]]
            if is_tmp_mnt_root and disk_labels:
                # Show friendly labels; hide raw UUID mount folders.
                items = disk_labels + items_all
            else:
                # If there are no labels, don't hide anything.
                items = mnt_uuid_dirs + disk_labels + items_all

            out = {"ok": True, "target": "local", "path": ap, "realpath": rp, "roots": LOCALFS_ROOTS, "items": items}
            if trash_root:
                out["trash_root"] = trash_root
            # Trash usage stats (for UI warnings)
            try:
                out["trash"] = _local_trash_stats(LOCALFS_ROOTS)
            except Exception:
                pass
            return jsonify(out)

        # remote
        sid = str(request.args.get("sid") or "").strip()
        if not sid:
            return error_response("sid_required", 400, ok=False)
        s, resp = _get_session_or_404(sid)
        if resp is not None:
            return resp
        rpath = str(request.args.get("path", ".") or ".").strip()
        # Normalize remote path for stability: collapse duplicate slashes and strip trailing slashes.
        if rpath not in (".", "/"):
            try:
                rpath = re.sub(r"/+", "/", rpath).rstrip("/") or "/"
            except Exception:
                pass

        cmd = "cls -l" if (not rpath or rpath in (".",)) else f"cls -l {_lftp_quote(rpath)}"
        rc, out, err = mgr._run_lftp(s, [cmd], capture=True)
        if rc != 0:
            # lftp sometimes writes useful diagnostics to stdout (not stderr),
            # and on embedded systems stderr can be empty. Include a short tail.
            tail_err = (err.decode("utf-8", errors="replace")[-400:]).strip()
            tail_out = (out.decode("utf-8", errors="replace")[-400:]).strip()
            tail = tail_err or tail_out or f"rc={rc}"
            return error_response("list_failed", 400, ok=False, details=tail)
        text = out.decode("utf-8", errors="replace")
        items2: List[Dict[str, Any]] = []
        for line in text.splitlines():
            item = _parse_ls_line(line)
            if item is not None:
                items2.append(item)

        # Fallback: some FTP/SFTP servers output a non-standard `ls -l` format
        # that our parser can't understand. If we got output but parsed zero
        # items, fall back to `cls -1` (names only) and return a minimal item
        # format so the UI can still navigate.
        if (not items2) and (text or "").strip():
            cmd2 = "cls -1" if (not rpath or rpath in (".",)) else f"cls -1 {_lftp_quote(rpath)}"
            rc2, out2, err2 = mgr._run_lftp(s, [cmd2], capture=True)
            if rc2 == 0:
                text2 = (out2 or b"").decode("utf-8", errors="replace")
                seen: set[str] = set()
                for raw in text2.splitlines():
                    nm = (raw or "").strip()
                    if not nm or nm.startswith("total "):
                        continue

                    # Some servers include trailing slash for dirs.
                    is_dir = False
                    if nm.endswith("/"):
                        is_dir = True
                        nm = nm.rstrip("/")

                    # Normalize to last segment if full path is returned.
                    if "/" in nm:
                        nn = nm.rstrip("/")
                        if nn:
                            seg = nn.split("/")[-1]
                            if seg:
                                nm = seg

                    if nm in (".", ".."):
                        continue
                    if nm in seen:
                        continue
                    seen.add(nm)

                    items2.append(
                        {
                            "name": nm,
                            "type": "dir" if is_dir else "other",
                            "size": 0,
                            "perm": "",
                            "mtime": None,
                        }
                    )
        return jsonify({"ok": True, "target": "remote", "sid": sid, "path": rpath, "items": items2})

    @bp.post("/api/fs/stat-batch")
    def api_fs_stat_batch() -> Any:
        if (resp := _require_enabled()) is not None:
            return resp
        data = request.get_json(silent=True) or {}
        target = str(data.get("target") or "").strip().lower()
        # When true, directories will include a best-effort deep size (size of contents).
        # This can be expensive on routers, so the UI should only enable it when needed.
        deep = bool(data.get("deep", False))
        if target not in ("local", "remote"):
            return error_response("bad_target", 400, ok=False)

        paths: List[str] = []
        if isinstance(data.get("paths"), list):
            cwd = str(data.get("cwd") or "").strip() or ""
            for n in data.get("paths"):
                nm = str(n or "").strip()
                if not nm:
                    continue
                if cwd:
                    full = (cwd.rstrip("/") + "/" + nm) if target == "remote" else os.path.join(cwd, nm)
                else:
                    full = nm
                paths.append(full)
        elif data.get("path"):
            paths = [str(data.get("path") or "").strip()]
        if not paths:
            return error_response("no_paths", 400, ok=False)
        if len(paths) > 200:
            return error_response("too_many_paths", 400, ok=False)

        if target == "local":
            out_items: List[Dict[str, Any]] = []
            for p in paths:
                try:
                    ap = _local_resolve_nofollow(p, LOCALFS_ROOTS)
                except PermissionError:
                    out_items.append({"path": p, "exists": False, "error": "forbidden"})
                    continue

                if not os.path.lexists(ap):
                    out_items.append({"path": ap, "exists": False})
                    continue

                try:
                    st0 = os.lstat(ap)
                    mode_i = int(getattr(st0, "st_mode", 0) or 0)

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

                    size_deep = None
                    size_deep_err = None
                    if deep and is_dir and not is_link:
                        size_deep, size_deep_err = dir_size_bytes_best_effort(ap, timeout_s=3.0)

                    out_items.append(
                        {
                            "path": ap,
                            "path_real": os.path.realpath(ap),
                            "exists": True,
                            "type": "link" if is_link else ("dir" if is_dir else "file"),
                            "size": int(getattr(st0, "st_size", 0) or 0),
                            "size_deep": int(size_deep) if isinstance(size_deep, int) else None,
                            "size_deep_error": size_deep_err,
                            "mode": mode_i,
                            "perm": perm_s,
                            "uid": int(getattr(st0, "st_uid", -1) or -1),
                            "gid": int(getattr(st0, "st_gid", -1) or -1),
                            "mtime": int(getattr(st0, "st_mtime", 0) or 0),
                            "atime": int(getattr(st0, "st_atime", 0) or 0),
                            "link_target": link_target,
                            "link_dir": bool(link_dir) if is_link else False,
                        }
                    )
                except Exception:
                    out_items.append({"path": ap, "exists": False, "error": "stat_failed"})
            return jsonify({"ok": True, "target": "local", "items": out_items})

        sid = str(data.get("sid") or "").strip()
        if not sid:
            return error_response("sid_required", 400, ok=False)
        s, resp = _get_session_or_404(sid)
        if resp is not None:
            return resp
        out_items2: List[Dict[str, Any]] = []
        for p in paths:
            rc, out, err = mgr._run_lftp(s, [f"cls -ld {_lftp_quote(p)}"], capture=True)
            if rc != 0:
                out_items2.append({"path": p, "exists": False})
                continue
            text = out.decode("utf-8", errors="replace").strip().splitlines()
            line = text[-1] if text else ""
            item = _parse_ls_line(line)
            if not item:
                out_items2.append({"path": p, "exists": True})
                continue
            out_items2.append(
                {
                    "path": p,
                    "exists": True,
                    "type": item.get("type"),
                    "size": item.get("size"),
                    "perm": item.get("perm"),
                    "mtime": item.get("mtime"),
                    "link_target": item.get("link_target"),
                }
            )
        return jsonify({"ok": True, "target": "remote", "sid": sid, "items": out_items2})
