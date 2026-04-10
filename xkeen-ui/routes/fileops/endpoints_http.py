"""HTTP endpoints for /api/fileops/* (jobs management).

This module holds the REST-style endpoints. WebSocket endpoints live in
routes.fileops.ws.
"""

from __future__ import annotations

from typing import Any, Dict

from flask import Blueprint, jsonify, request

from routes.common.errors import error_response


def register_http_endpoints(bp: Blueprint, deps: Dict[str, Any]) -> None:
    _require_enabled = deps["require_enabled"]
    jobmgr = deps["jobmgr"]
    _normalize_delete = deps["normalize_delete"]
    _normalize_sources = deps["normalize_sources"]
    _compute_copy_move_conflicts = deps["compute_copy_move_conflicts"]
    _normalize_zip = deps.get("normalize_zip")
    _normalize_unzip = deps.get("normalize_unzip")
    _normalize_checksum = deps.get("normalize_checksum")
    _normalize_dirsize = deps.get("normalize_dirsize")
    _progress_set = deps["progress_set"]
    _run_job_delete = deps["run_job_delete"]
    _run_job_copy_move = deps["run_job_copy_move"]
    _run_job_zip = deps.get("run_job_zip")
    _run_job_unzip = deps.get("run_job_unzip")
    _run_job_checksum = deps.get("run_job_checksum")
    _run_job_dirsize = deps.get("run_job_dirsize")
    _core_log = deps.get("core_log")

    @bp.post("/api/fileops/jobs")
    def api_fileops_create_job() -> Any:
        if (resp := _require_enabled()) is not None:
            return resp
        data = request.get_json(silent=True) or {}
        op = str(data.get("op") or "copy").strip().lower()
        if op not in ("copy", "move", "delete", "zip", "unzip", "checksum", "dirsize"):
            return error_response("unsupported_op", 400, ok=False)
        try:
            if op == "delete":
                _normalize_delete(data)
            elif op in ("copy", "move"):
                _normalize_sources(data)
            elif op == "zip":
                if not callable(_normalize_zip):
                    raise RuntimeError('unsupported_op')
                data = _normalize_zip(data)
            elif op == "unzip":
                if not callable(_normalize_unzip):
                    raise RuntimeError('unsupported_op')
                data = _normalize_unzip(data)
            elif op == "checksum":
                if not callable(_normalize_checksum):
                    raise RuntimeError('unsupported_op')
                data = _normalize_checksum(data)
            elif op == "dirsize":
                if not callable(_normalize_dirsize):
                    raise RuntimeError('unsupported_op')
                data = _normalize_dirsize(data)
        except RuntimeError:
            return error_response("unsupported_op", 400, ok=False)
        except Exception:
            return error_response("bad_request", 400, ok=False)

        # Optional dry-run / conflict planning for copy/move
        if op in ("copy", "move"):
            opts = (data.get("options") or {}) if isinstance(data.get("options"), dict) else {}
            overwrite = str(opts.get("overwrite", "replace") or "replace").strip().lower()
            dry_run = bool(opts.get("dry_run"))
            decisions = opts.get("decisions") if isinstance(opts.get("decisions"), dict) else {}
            default_action = str(opts.get("default_action") or opts.get("overwrite_default") or "").strip().lower() or None
            if default_action not in (None, "replace", "skip"):
                default_action = None

            conflicts = _compute_copy_move_conflicts(data)
            if dry_run:
                return jsonify(
                    {
                        "ok": True,
                        "dry_run": True,
                        "op": op,
                        "src": data.get("src") or {},
                        "dst": data.get("dst") or {},
                        "sources": data.get("sources") or [],
                        "bytes_total": data.get("bytes_total") or 0,
                        "conflicts": conflicts,
                    }
                )

            if overwrite == "ask" and not decisions and not default_action and conflicts:
                return jsonify({"ok": False, "error": "conflicts", "conflicts": conflicts}), 409

        job = jobmgr.create(op)
        if op == "delete":
            spec = {"src": data["src"], "sources": data["sources"], "options": data.get("options") or {}}
            _progress_set(job, files_total=len(spec["sources"]))
            jobmgr.submit(job, _run_job_delete, spec)
        elif op in ("copy", "move"):
            spec = {
                "src": data["src"],
                "dst": data["dst"],
                "sources": data["sources"],
                "options": data.get("options") or {},
                "bytes_total": data.get("bytes_total") or 0,
            }
            _progress_set(job, bytes_total=spec["bytes_total"], files_total=len(spec["sources"]))
            jobmgr.submit(job, _run_job_copy_move, spec)
        elif op == "zip":
            if not callable(_run_job_zip):
                return error_response("unsupported_op", 400, ok=False)
            # data is already normalized into runner spec
            _progress_set(job, files_total=len(data.get('items') or []), bytes_total=0)
            jobmgr.submit(job, _run_job_zip, data)
        elif op == "unzip":
            if not callable(_run_job_unzip):
                return error_response("unsupported_op", 400, ok=False)
            _progress_set(job, files_total=0, bytes_total=0)
            jobmgr.submit(job, _run_job_unzip, data)
        elif op == "checksum":
            if not callable(_run_job_checksum):
                return error_response("unsupported_op", 400, ok=False)
            try:
                bt = int(data.get('size_total') or 0)
            except Exception:
                bt = 0
            _progress_set(job, files_total=1, bytes_total=bt)
            jobmgr.submit(job, _run_job_checksum, data)
        elif op == "dirsize":
            if not callable(_run_job_dirsize):
                return error_response("unsupported_op", 400, ok=False)
            _progress_set(job, files_total=0, bytes_total=0)
            jobmgr.submit(job, _run_job_dirsize, data)

        if callable(_core_log):
            try:
                src = data.get("src") or {}
                dst = data.get("dst") or {}
                _core_log(
                    "info",
                    "fileops.job_create",
                    job_id=job.job_id,
                    op=op,
                    sources=int(len(data.get("sources") or [])),
                    bytes_total=int(data.get("bytes_total") or 0),
                    src_target=str(src.get("target") or ""),
                    src_sid=str(src.get("sid") or ""),
                    src_path=str(src.get("path") or ""),
                    dst_target=str(dst.get("target") or ""),
                    dst_sid=str(dst.get("sid") or ""),
                    dst_path=str(dst.get("path") or ""),
                )
            except Exception:
                pass

        return jsonify({"ok": True, "job_id": job.job_id, "job": job.to_dict()})

    @bp.get("/api/fileops/jobs")
    def api_fileops_list_jobs() -> Any:
        if (resp := _require_enabled()) is not None:
            return resp
        try:
            limit = int(request.args.get("limit", "20") or "20")
        except Exception:
            limit = 20
        limit = max(1, min(100, limit))
        try:
            with jobmgr._lock:
                jobs = list(jobmgr._jobs.values())
        except Exception:
            jobs = []
        jobs.sort(key=lambda j: float(getattr(j, "created_ts", 0) or 0), reverse=True)
        return jsonify({"ok": True, "jobs": [j.to_dict() for j in jobs[:limit]]})

    @bp.get("/api/fileops/jobs/<job_id>")
    def api_fileops_get_job(job_id: str) -> Any:
        if (resp := _require_enabled()) is not None:
            return resp
        job = jobmgr.get(job_id)
        if not job:
            return error_response("job_not_found", 404, ok=False)
        return jsonify({"ok": True, "job": job.to_dict()})

    @bp.post("/api/fileops/jobs/clear")
    def api_fileops_clear_jobs() -> Any:
        """Clear finished jobs from the in-memory history."""
        if (resp := _require_enabled()) is not None:
            return resp

        try:
            data = request.get_json(silent=True) or {}
        except Exception:
            data = {}
        scope = str((data or {}).get("scope") or "history").strip().lower()
        if scope not in ("history", "finished", "errors", "all"):
            scope = "history"

        def _should_delete(state: str) -> bool:
            st = (state or "").strip().lower()
            if st in ("running", "queued"):
                return False
            if scope == "errors":
                return st == "error"
            if scope == "finished":
                return st in ("done", "canceled")
            return st in ("done", "error", "canceled")

        deleted = 0
        try:
            with jobmgr._lock:
                to_del = [jid for jid, j in jobmgr._jobs.items() if _should_delete(getattr(j, "state", "") or "")]
                for jid in to_del:
                    jobmgr._jobs.pop(jid, None)
                    deleted += 1
        except Exception:
            deleted = 0

        if callable(_core_log):
            try:
                _core_log("info", "fileops.jobs_clear", deleted=int(deleted), scope=str(scope))
            except Exception:
                pass
        return jsonify({"ok": True, "deleted": deleted})

    @bp.post("/api/fileops/jobs/<job_id>/cancel")
    def api_fileops_cancel_job(job_id: str) -> Any:
        if (resp := _require_enabled()) is not None:
            return resp
        ok = jobmgr.cancel(job_id)
        if not ok:
            return error_response("job_not_found", 404, ok=False)
        if callable(_core_log):
            try:
                _core_log("info", "fileops.job_cancel", job_id=job_id)
            except Exception:
                pass
        return jsonify({"ok": True, "canceled": True})
