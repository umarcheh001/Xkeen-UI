"""FS endpoints: read + write.

Extracted from routes.fs.blueprint to keep the blueprint module smaller.
"""

from __future__ import annotations

import os
import shutil
import uuid
from typing import Any, Dict, Optional

from flask import jsonify, request


def register_readwrite_endpoints(bp, deps: Dict[str, Any]) -> None:
    error_response = deps["error_response"]
    _require_enabled = deps["_require_enabled"]
    _get_session_or_404 = deps["_get_session_or_404"]
    _core_log = deps["_core_log"]

    LOCALFS_ROOTS = deps["LOCALFS_ROOTS"]
    TMP_DIR = deps["TMP_DIR"]

    mgr = deps["mgr"]
    _lftp_quote = deps["_lftp_quote"]
    _parse_ls_line = deps["_parse_ls_line"]

    _local_resolve = deps["_local_resolve"]
    _apply_local_metadata_best_effort = deps["_apply_local_metadata_best_effort"]

    _snapshot_before_overwrite = deps.get("_snapshot_before_overwrite")
    _BACKUP_DIR = deps.get("_BACKUP_DIR", "")
    _BACKUP_DIR_REAL = deps.get("_BACKUP_DIR_REAL", "")
    _XRAY_CONFIGS_DIR_REAL = deps.get("_XRAY_CONFIGS_DIR_REAL", "")

    @bp.get("/api/fs/read")
    def api_fs_read() -> Any:
        """Read a text file (UTF-8) from local sandbox or remote session."""
        if (resp := _require_enabled()) is not None:
            return resp

        target = str(request.args.get("target", "") or "").strip().lower()
        path = str(request.args.get("path", "") or "").strip()
        if target not in ("local", "remote"):
            return error_response("bad_target", 400, ok=False)
        if not path:
            return error_response("path_required", 400, ok=False)

        # Keep reads bounded to protect embedded devices.
        MAX_BYTES = 1024 * 1024  # 1 MiB
        size_bytes: Optional[int] = None
        truncated = False

        def _decode_utf8_or_415(raw: bytes) -> Any:
            # Heuristic: if NUL byte exists -> binary
            if b"\x00" in raw:
                return None
            try:
                return raw.decode("utf-8")
            except Exception:
                return None

        if target == "local":
            try:
                rp = _local_resolve(path, LOCALFS_ROOTS)
            except PermissionError:
                return error_response("Доступ к пути запрещён.", 403, ok=False, code="forbidden")

            if os.path.isdir(rp):
                return error_response("not_a_file", 400, ok=False)
            if not os.path.isfile(rp):
                return error_response("not_found", 404, ok=False)

            try:
                size_bytes = int(os.path.getsize(rp))
            except Exception:
                size_bytes = None

            try:
                with open(rp, "rb") as fp:
                    raw = fp.read(MAX_BYTES + 1)
            except Exception:
                return error_response("read_failed", 400, ok=False)

            if len(raw) > MAX_BYTES:
                raw = raw[:MAX_BYTES]
                truncated = True

            text = _decode_utf8_or_415(raw)
            if text is None:
                return error_response("not_text", 415, ok=False, binary=True, size=size_bytes)

            return jsonify({"ok": True, "target": "local", "path": rp, "text": text, "truncated": truncated, "size": size_bytes})

        # remote
        sid = str(request.args.get("sid") or "").strip()
        if not sid:
            return error_response("sid_required", 400, ok=False)
        s, resp = _get_session_or_404(sid)
        if resp is not None:
            return resp

        # Best-effort size + dir detection via `cls -l`
        is_dir = False
        try:
            rc, out, err = mgr._run_lftp(s, [f"cls -l {_lftp_quote(path)}"], capture=True)
            if rc == 0:
                text_ls = (out or b"").decode("utf-8", errors="replace")
                for line in text_ls.splitlines():
                    item = _parse_ls_line(line)
                    if not item:
                        continue
                    is_dir = (str(item.get("type") or "") == "dir")
                    try:
                        size_bytes = int(item.get("size"))
                    except Exception:
                        size_bytes = None
                    break
        except Exception:
            is_dir = False

        if is_dir:
            return error_response("not_a_file", 400, ok=False)

        # Stream cat and stop after MAX_BYTES
        raw = b""
        p2 = None
        stdout = None
        stderr = None
        try:
            p2 = mgr._popen_lftp(s, [f"cat {_lftp_quote(path)}"])
            stdout = p2.stdout
            stderr = p2.stderr
            if stdout is None:
                raise RuntimeError("no_stdout")
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
            raw = b"".join(chunks)
            if truncated and len(raw) > MAX_BYTES:
                raw = raw[:MAX_BYTES]
        except Exception:
            return error_response("read_failed", 400, ok=False)
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
            return error_response("not_text", 415, ok=False, binary=True, size=size_bytes)

        return jsonify({"ok": True, "target": "remote", "sid": sid, "path": path, "text": text, "truncated": truncated, "size": size_bytes})

    @bp.post("/api/fs/write")
    def api_fs_write() -> Any:
        """Write a text file (UTF-8) to local sandbox or remote session."""
        if (resp := _require_enabled()) is not None:
            return resp

        data = request.get_json(silent=True) or {}
        dry_run = (
            str(request.args.get("dry_run", "") or request.args.get("preflight", "") or "").strip().lower() in ("1", "true", "yes", "on")
            or str(data.get("dry_run", "") or "").strip().lower() in ("1", "true", "yes", "on")
        )
        target = str(data.get("target") or "").strip().lower()
        path_s = str(data.get("path") or "").strip()
        text = data.get("text", None)

        if target not in ("local", "remote"):
            return error_response("bad_target", 400, ok=False)
        if not path_s:
            return error_response("path_required", 400, ok=False)
        if not isinstance(text, str):
            return error_response("text_required", 400, ok=False)

        # Keep writes bounded.
        MAX_WRITE = 2 * 1024 * 1024  # 2 MiB
        raw = text.encode("utf-8", errors="strict")
        if len(raw) > MAX_WRITE:
            return error_response("too_large", 413, ok=False, max_bytes=MAX_WRITE)

        os.makedirs(TMP_DIR, exist_ok=True)

        if target == "local":
            try:
                rp = _local_resolve(path_s, LOCALFS_ROOTS)
            except PermissionError:
                return error_response("Доступ к пути запрещён.", 403, ok=False, code="forbidden")

            if os.path.isdir(rp):
                return error_response("not_a_file", 400, ok=False)

            parent = os.path.dirname(rp)
            if parent and not os.path.isdir(parent):
                return error_response("parent_not_found", 400, ok=False)

            # Preserve perms/owner when overwriting an existing file.
            st0 = None
            try:
                if os.path.exists(rp):
                    st0 = os.stat(rp)
            except Exception:
                st0 = None

            if dry_run:
                return jsonify({"ok": True, "dry_run": True, "bytes": len(raw), "would_overwrite": bool(os.path.exists(rp))})

            # Auto-create snapshot (rollback) before overwriting Xray config fragments.
            try:
                if st0 is not None and _snapshot_before_overwrite and _BACKUP_DIR and _XRAY_CONFIGS_DIR_REAL and _BACKUP_DIR_REAL:
                    _snapshot_before_overwrite(
                        rp,
                        backup_dir=_BACKUP_DIR,
                        xray_configs_dir_real=_XRAY_CONFIGS_DIR_REAL,
                        backup_dir_real=_BACKUP_DIR_REAL,
                    )
            except Exception:
                pass

            tmp_path = os.path.join(TMP_DIR, f"xkeen_write_local_{uuid.uuid4().hex}.tmp")
            try:
                with open(tmp_path, "wb") as fp:
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
                return error_response("write_failed", 400, ok=False)
            _core_log("info", "fs.write", target="local", path=path_s, bytes=len(raw), dry_run=bool(dry_run))
            return jsonify({"ok": True, "bytes": len(raw)})

        # remote
        sid = str(data.get("sid") or "").strip()
        if not sid:
            return error_response("sid_required", 400, ok=False)
        s, resp = _get_session_or_404(sid)
        if resp is not None:
            return resp

        tmp_path = os.path.join(TMP_DIR, f"xkeen_write_remote_{sid}_{uuid.uuid4().hex}.tmp")
        try:
            with open(tmp_path, "wb") as fp:
                fp.write(raw)
            rc, out, err = mgr._run_lftp(
                s,
                [f"put {_lftp_quote(tmp_path)} -o {_lftp_quote(path_s)}"],
                capture=True,
            )
            if rc != 0:
                return error_response("remote_put_failed", 400, ok=False)
            _core_log("info", "fs.write", target="remote", sid=sid, path=path_s, bytes=len(raw), dry_run=False)
            return jsonify({"ok": True, "bytes": len(raw)})
        except Exception:
            return error_response("write_failed", 400, ok=False)
        finally:
            try:
                os.remove(tmp_path)
            except Exception:
                pass
