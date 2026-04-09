"""Routes for running XKeen commands in the background.

Extracted from legacy app.py.

Endpoints:
- POST /api/run-command
- GET  /api/run-command/<job_id>

These endpoints are used by the built-in terminal transport and utilities.
"""

from __future__ import annotations

from typing import Any, Dict

from flask import Blueprint, jsonify, request

from routes.common.errors import error_response

from services.command_jobs import create_command_job, get_command_job, cleanup_old_jobs
from services.xkeen_commands_catalog import ALLOWED_FLAGS, get_full_shell_policy, is_full_shell_enabled


def create_commands_blueprint() -> Blueprint:
    bp = Blueprint("commands", __name__)

    @bp.post("/api/run-command")
    def api_run_command():
        data = request.get_json(silent=True) or {}

        flag = str(data.get("flag", "") or "").strip()
        cmd = str(data.get("cmd", "") or "").strip()

        stdin_data = data.get("stdin")
        if not isinstance(stdin_data, str):
            stdin_data = None

        # Optional: run command attached to a pseudo-terminal (TTY-like output)
        use_pty = bool(data.get("pty") or data.get("tty"))

        # Legacy mode: xkeen <flag>
        if flag:
            if flag not in ALLOWED_FLAGS:
                return error_response("flag not allowed", 400, ok=False)
            job = create_command_job(flag=flag, stdin_data=stdin_data, cmd=None, use_pty=use_pty)
            return (
                jsonify(
                    {
                        "ok": True,
                        "job_id": job.id,
                        "flag": job.flag,
                        "status": job.status,
                    }
                ),
                202,
            )

        # Full shell mode: arbitrary command, if enabled
        if cmd:
            if not is_full_shell_enabled():
                shell_policy = get_full_shell_policy()
                return (
                    jsonify(
                        {
                            "ok": False,
                            "error": "shell_disabled",
                            "message": str(shell_policy.get("message") or "Shell-команды в UI отключены."),
                            "hint": str(shell_policy.get("hint") or ""),
                            "shell": shell_policy,
                        }
                    ),
                    403,
                )
            job = create_command_job(flag=None, stdin_data=stdin_data, cmd=cmd, use_pty=use_pty)
            return (
                jsonify(
                    {
                        "ok": True,
                        "job_id": job.id,
                        "cmd": job.cmd,
                        "status": job.status,
                    }
                ),
                202,
            )

        return error_response("empty flag/cmd", 400, ok=False)

    @bp.get("/api/run-command/<job_id>")
    def api_run_command_status(job_id: str):
        cleanup_old_jobs()
        job = get_command_job(job_id)
        if job is None:
            return error_response("job not found", 404, ok=False)

        return (
            jsonify(
                {
                    "ok": True,
                    "job_id": job.id,
                    "flag": job.flag,
                    "status": job.status,
                    "exit_code": job.exit_code,
                    "output": job.output,
                    "created_at": job.created_at,
                    "finished_at": job.finished_at,
                    "error": job.error,
                }
            ),
            200,
        )

    return bp
