"""Background command jobs for XKeen UI.

This module runs `xkeen` (or optional shell commands) in a background thread and
stores incremental output for polling or WebSocket streaming.
"""

from __future__ import annotations

import codecs
import errno
import pty
import os
import select
import signal
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Dict

from services.restart_log import write_restart_log


def _build_exec_env(*, term: str | None = None) -> dict:
    """Normalize env for spawned commands.

    We try to mimic a normal interactive Entware shell so that:
    - /opt/bin tools are preferred (opkg, python/pip, xkeen, etc.)
    - HOME is writable (some installers/caches otherwise fail with 'Read-only file system')
    """
    env = os.environ.copy()

    # Prefer Entware first
    orig_path = env.get("PATH") or ""
    parts = [p for p in orig_path.split(":") if p]
    opt_first = ["/opt/sbin", "/opt/bin"]
    for d in opt_first:
        parts = [p for p in parts if p != d]
    env["PATH"] = ":".join(opt_first + parts) if parts else ":".join(opt_first)

    if not (env.get("HOME") or "").strip():
        for cand in ("/opt/root", "/root", "/tmp"):
            try:
                if os.path.isdir(cand) and os.access(cand, os.W_OK):
                    env["HOME"] = cand
                    break
            except Exception:
                pass
    env.setdefault("HOME", "/tmp")
    env.setdefault("TMPDIR", "/tmp")

    if term:
        env["TERM"] = term
    else:
        env.setdefault("TERM", os.environ.get("TERM", "xterm-256color"))

    # BusyBox shells can source $ENV in interactive mode
    for prof in ("/opt/etc/profile", "/etc/profile"):
        try:
            if os.path.isfile(prof):
                env.setdefault("ENV", prof)
                break
        except Exception:
            pass

    return env

from services.xkeen_commands_catalog import (
    build_xkeen_cmd,
    SHELL_BIN,
    COMMAND_TIMEOUT,
)

@dataclass
class CommandJob:
    id: str
    flag: str | None = None
    cmd: str | None = None
    use_pty: bool = False
    status: str = "queued"  # "queued" | "running" | "finished" | "error"
    exit_code: int | None = None
    output: str = ""
    created_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    error: str | None = None


JOBS: Dict[str, CommandJob] = {}
JOBS_LOCK = threading.Lock()
MAX_JOB_AGE = 3600  # seconds to keep finished jobs


def _restart_log_file() -> str:
    try:
        path = (os.environ.get("XKEEN_RESTART_LOG_FILE") or "").strip()
    except Exception:
        path = ""
    return path or "/opt/etc/xkeen-ui/restart.log"


def _sync_restart_log(job: "CommandJob" | None) -> None:
    if not job or job.flag != "-restart":
        return

    payload = job.output or ""
    err = str(job.error or "").strip()
    if err and err not in payload:
        if payload and not payload.endswith("\n"):
            payload += "\n"
        payload += err + "\n"

    try:
        write_restart_log(_restart_log_file(), payload)
    except Exception:
        pass


def cleanup_old_jobs() -> None:
    """Remove finished jobs older than MAX_JOB_AGE."""
    now = time.time()
    with JOBS_LOCK:
        old_ids = [
            job_id
            for job_id, job in JOBS.items()
            if job.finished_at is not None and (now - job.finished_at) > MAX_JOB_AGE
        ]
        for job_id in old_ids:
            JOBS.pop(job_id, None)


def _run_command_job(job_id: str, stdin_data: str | None) -> None:
    """Run xkeen or shell command in background and store result in JOBS."""
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return
        job.status = "running"

    use_pty = bool(getattr(job, 'use_pty', False))

    if job.cmd:
        cmd = [SHELL_BIN, "-c", job.cmd]
    elif job.flag:
        cmd = build_xkeen_cmd(job.flag)
    else:
        with JOBS_LOCK:
            job = JOBS.get(job_id)
            if not job:
                return
            job.status = "error"
            job.error = "empty command"
            job.finished_at = time.time()
        return

    # Stream output while the command is running so /ws/command-status can actually stream.
    # Note: we run the command in its own process group so we can terminate the whole tree on timeout.
    COMMAND_MAX_OUTPUT_CHARS = int(os.environ.get("XKEEN_COMMAND_MAX_OUTPUT_CHARS", "1048576"))  # 1 MiB

    def _is_noise_line(line: str) -> bool:
        low = (line or "").lower()
        if "collected errors" in low:
            return True
        if "opkg_conf" in low or "opkg" in low:
            return True
        return False

    def _append_output(chunk: str) -> None:
        if not chunk:
            return
        restart_job = None
        with JOBS_LOCK:
            j = JOBS.get(job_id)
            if not j:
                return
            # Prevent unbounded RAM usage on chatty commands.
            if COMMAND_MAX_OUTPUT_CHARS > 0 and len(j.output) >= COMMAND_MAX_OUTPUT_CHARS:
                # Mark once.
                if "[output truncated]" not in j.output:
                    j.output += "\n[output truncated]\n"
                return
            if COMMAND_MAX_OUTPUT_CHARS > 0:
                room = COMMAND_MAX_OUTPUT_CHARS - len(j.output)
                if room <= 0:
                    return
                if len(chunk) > room:
                    j.output += chunk[:room]
                    if "[output truncated]" not in j.output:
                        j.output += "\n[output truncated]\n"
                    restart_job = j if j.flag == "-restart" else None
                    return
            j.output += chunk
            restart_job = j if j.flag == "-restart" else None
        _sync_restart_log(restart_job)

    started = time.time()
    proc: subprocess.Popen | None = None
    exit_code: int | None = None
    timed_out = False

    try:
        pty_master_fd = None

        if use_pty:
            # Run the command with stdout/stderr attached to a pseudo-terminal so
            # programs detect TTY and switch to console-friendly log format (INFO[...]).
            master_fd, slave_fd = pty.openpty()
            pty_master_fd = master_fd

            proc = subprocess.Popen(
                cmd,
                stdin=slave_fd,
                stdout=slave_fd,
                stderr=slave_fd,
                text=False,
                close_fds=True,
                preexec_fn=os.setsid,
                env=_build_exec_env(term=os.environ.get('TERM') or 'xterm-256color'),
            )

            if stdin_data is not None:
                try:
                    os.write(master_fd, stdin_data.encode('utf-8', errors='ignore'))
                except Exception:
                    pass

            try:
                os.close(slave_fd)
            except Exception:
                pass

            read_fd = master_fd
        else:
            proc = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE if stdin_data is not None else None,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=False,
                close_fds=True,
                preexec_fn=os.setsid,
                           env=_build_exec_env(),
            )
            if proc.stdout is None:
                raise RuntimeError('no stdout')
            read_fd = proc.stdout.fileno()

        fd = read_fd
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        carry = ""

        while True:
            # Timeout check
            if (time.time() - started) > float(COMMAND_TIMEOUT):
                timed_out = True
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                except Exception:
                    try:
                        proc.terminate()
                    except Exception:
                        pass
                try:
                    # Give it a bit to exit
                    proc.wait(timeout=1.0)
                except Exception:
                    try:
                        os.killpg(proc.pid, signal.SIGKILL)
                    except Exception:
                        try:
                            proc.kill()
                        except Exception:
                            pass
                break

            # Read available output (non-blocking-ish)
            try:
                r, _, _ = select.select([fd], [], [], 0.2)
            except Exception:
                r = [fd]

            if r:
                try:
                    try:
                        data = os.read(fd, 4096)
                    except OSError as oe:
                        if getattr(oe, 'errno', None) == errno.EIO:
                            data = b''
                        else:
                            raise
                except Exception:
                    data = b""
                if not data:
                    break

                txt = decoder.decode(data)
                if txt:
                    txt = txt.replace('\r\n', '\n').replace('\r', '\n')
                    carry += txt
                    while "\n" in carry:
                        line, carry = carry.split("\n", 1)
                        if _is_noise_line(line):
                            continue
                        _append_output(line + "\n")

            # If process exited and no more buffered data is coming, we can finish.
            try:
                if proc.poll() is not None:
                    # Drain whatever is left (best effort)
                    try:
                        while True:
                            r2, _, _ = select.select([fd], [], [], 0)
                            if not r2:
                                break
                            try:
                                data2 = os.read(fd, 4096)
                            except OSError as oe2:
                                if getattr(oe2, 'errno', None) == errno.EIO:
                                    data2 = b''
                                else:
                                    raise
                            if not data2:
                                break
                            txt2 = decoder.decode(data2)
                            if txt2:
                                txt2 = txt2.replace('\r\n', '\n').replace('\r', '\n')
                                carry += txt2
                                while "\n" in carry:
                                    line, carry = carry.split("\n", 1)
                                    if _is_noise_line(line):
                                        continue
                                    _append_output(line + "\n")
                    except Exception:
                        pass
                    break
            except Exception:
                pass

        # Flush decoder + remaining partial line
        try:
            tail = decoder.decode(b"", final=True)
        except Exception:
            tail = ""
        if tail:
            carry += tail
        if carry:
            # last line without newline
            if not _is_noise_line(carry):
                _append_output(carry)

        try:
            exit_code = proc.wait(timeout=0.2)
        except Exception:
            try:
                exit_code = proc.poll()
            except Exception:
                exit_code = None

        restart_job = None
        with JOBS_LOCK:
            job = JOBS.get(job_id)
            if not job:
                return
            if timed_out:
                job.status = "error"
                job.error = f"timeout after {COMMAND_TIMEOUT}s"
            else:
                job.status = "finished"
            job.exit_code = int(exit_code) if exit_code is not None else None
            job.finished_at = time.time()
            restart_job = job if job.flag == "-restart" else None
        _sync_restart_log(restart_job)

    except Exception as e:  # pragma: no cover - defensive
        restart_job = None
        with JOBS_LOCK:
            job = JOBS.get(job_id)
            if not job:
                return
            job.status = "error"
            job.error = str(e)
            job.finished_at = time.time()
            restart_job = job if job.flag == "-restart" else None
        _sync_restart_log(restart_job)
    finally:
        try:
            if proc is not None:
                try:
                    if proc.stdout:
                        proc.stdout.close()
                except Exception:
                    pass
                try:
                    if proc.stdin:
                        proc.stdin.close()
                except Exception:
                    pass

            if pty_master_fd is not None:
                try:
                    os.close(pty_master_fd)
                except Exception:
                    pass
        except Exception:
            pass


def create_command_job(flag: str | None, stdin_data: str | None, cmd: str | None = None, use_pty: bool = False) -> CommandJob:
    """Create CommandJob, start background thread and return the job object."""
    job_id = uuid.uuid4().hex[:12]
    job = CommandJob(id=job_id, flag=flag, cmd=cmd, use_pty=bool(use_pty) and stdin_data is None)
    with JOBS_LOCK:
        JOBS[job_id] = job

    if flag == "-restart":
        _sync_restart_log(job)

    cleanup_old_jobs()

    t = threading.Thread(target=_run_command_job, args=(job_id, stdin_data), daemon=True)
    t.start()
    return job



def get_command_job(job_id: str) -> CommandJob | None:
    # Return a job by id (thread-safe).
    try:
        jid = (job_id or "").strip()
    except Exception:
        jid = ""
    if not jid:
        return None
    with JOBS_LOCK:
        return JOBS.get(jid)

# Backward-compatible aliases (old app.py names)
_cleanup_old_jobs = cleanup_old_jobs
_create_command_job = create_command_job
_get_command_job = get_command_job
