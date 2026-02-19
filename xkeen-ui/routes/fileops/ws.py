"""WebSocket endpoints for FileOps.

Contains:
- POST /api/fileops/ws-token
- WS /ws/fileops
"""

from __future__ import annotations

import json
from typing import Any, Dict

from flask import Blueprint, jsonify, request


def register_ws_endpoints(bp: Blueprint, deps: Dict[str, Any]) -> None:
    _require_enabled = deps["require_enabled"]
    issue_token = deps["issue_ws_token"]
    validate_token = deps["validate_ws_token"]
    jobmgr = deps["jobmgr"]
    ws_sleep = deps["ws_sleep"]

    @bp.post("/api/fileops/ws-token")
    def api_fileops_ws_token() -> Any:
        if (resp := _require_enabled()) is not None:
            return resp
        ttl = 60
        try:
            data = request.get_json(silent=True) or {}
            if isinstance(data, dict) and data.get("ttl"):
                ttl = max(10, min(300, int(data.get("ttl"))))
        except Exception:
            ttl = 60
        token = issue_token(ttl_seconds=ttl)
        return jsonify({"ok": True, "token": token, "ttl": ttl})

    @bp.route("/ws/fileops")
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

        ws = request.environ.get("wsgi.websocket")
        if ws is None:
            return "Expected WebSocket", 400

        token = (request.args.get("token") or "").strip()
        job_id = (request.args.get("job_id") or "").strip()
        if not token or not job_id:
            try:
                ws.send(json.dumps({"type": "error", "message": "token and job_id are required"}, ensure_ascii=False))
            except Exception:
                pass
            try:
                ws.close()
            except Exception:
                pass
            return ""

        if not validate_token(token):
            try:
                ws.send(json.dumps({"type": "error", "message": "bad_token"}, ensure_ascii=False))
            except Exception:
                pass
            try:
                ws.close()
            except Exception:
                pass
            return ""

        last_rev = -1
        try:
            while True:
                job = jobmgr.get(job_id)
                if job is None:
                    try:
                        ws.send(json.dumps({"type": "error", "message": "job_not_found"}, ensure_ascii=False))
                    except Exception:
                        pass
                    break

                rev = int(getattr(job, "rev", 0) or 0)
                if last_rev < 0:
                    last_rev = rev
                    ws.send(json.dumps({"type": "init", "job": job.to_dict()}, ensure_ascii=False))
                elif rev != last_rev:
                    last_rev = rev
                    ws.send(json.dumps({"type": "update", "job": job.to_dict()}, ensure_ascii=False))

                if job.state in ("done", "error", "canceled"):
                    ws.send(json.dumps({"type": "done", "job": job.to_dict()}, ensure_ascii=False))
                    break

                ws_sleep(0.2)
        except Exception:
            pass
        finally:
            try:
                ws.close()
            except Exception:
                pass
        return ""


__all__ = ["register_ws_endpoints"]
