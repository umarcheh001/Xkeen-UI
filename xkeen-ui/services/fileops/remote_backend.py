"""Remote (lftp-based) helper functions for file operations.

This module intentionally contains no Flask code. It is used by the fileops
service runtime to perform best-effort remote filesystem queries and to run
long-running lftp processes.
"""

from __future__ import annotations

import os
import re
import subprocess
import time
from typing import Any, Callable, Iterable, List, Sequence, Tuple

from urllib.parse import quote as _url_quote


def remote_stat_size(
    mgr: Any,
    sess: Any,
    rpath: str,
    *,
    lftp_quote: Callable[[str], str],
    parse_ls_line: Callable[[str], dict | None],
) -> int | None:
    """Best-effort file size lookup via `cls -ld` parsing."""
    rc, out, _err = mgr._run_lftp(sess, [f"cls -ld {lftp_quote(rpath)}"], capture=True)
    if rc != 0:
        return None
    text = (out or b"").decode("utf-8", errors="replace")
    for line in text.splitlines():
        item = parse_ls_line(line)
        if item:
            try:
                return int(item.get("size") or 0)
            except Exception:
                return None
    return None


def _parse_df_free_bytes(text: str) -> int | None:
    """Parse lftp `df` output and return available bytes (best-effort)."""
    try:
        lines = [ln.strip() for ln in (text or "").splitlines() if ln.strip()]
        if not lines:
            return None

        # Drop header-like lines
        data_lines = [
            ln
            for ln in lines
            if not re.search(r"\bFilesystem\b|\bMounted\b|\bUse%\b", ln, re.I)
        ]
        if not data_lines:
            data_lines = lines[-1:]

        ln = data_lines[-1]
        parts = re.split(r"\s+", ln)
        nums: List[int] = []
        for tok in parts:
            if tok.isdigit():
                try:
                    nums.append(int(tok))
                except Exception:
                    pass

        # Typical: <fs> <blocks> <used> <avail> <use%> <mnt>
        if len(nums) >= 3:
            return int(nums[2])
        return None
    except Exception:
        return None


def remote_free_bytes(
    mgr: Any,
    sess: Any,
    path: str,
    *,
    lftp_quote: Callable[[str], str],
) -> int | None:
    """Return free bytes on remote filesystem for a given path (best-effort)."""
    p = str(path or "").strip() or "."
    for cmd, mul in ((f"df -B1 {lftp_quote(p)}", 1), (f"df -k {lftp_quote(p)}", 1024)):
        try:
            rc, out, _err = mgr._run_lftp(sess, [cmd], capture=True)
            if rc != 0:
                continue
            txt = (out or b"").decode("utf-8", errors="replace")
            avail = _parse_df_free_bytes(txt)
            if avail is None:
                continue
            return int(avail) * int(mul)
        except Exception:
            continue
    return None


def remote_du_bytes(
    mgr: Any,
    sess: Any,
    path: str,
    *,
    lftp_quote: Callable[[str], str],
) -> int | None:
    """Best-effort remote directory size in bytes."""
    p = str(path or "").strip() or "."
    for cmd in (f"du -sb {lftp_quote(p)}", f"du -s -b {lftp_quote(p)}"):
        try:
            rc, out, _err = mgr._run_lftp(sess, [cmd], capture=True)
            if rc != 0:
                continue
            txt = (out or b"").decode("utf-8", errors="replace")
            m = re.search(r"(^|\s)(\d+)(\s|$)", txt.strip())
            if m:
                return int(m.group(2))
        except Exception:
            continue
    return None


def remote_is_dir(
    mgr: Any,
    sess: Any,
    rpath: str,
    *,
    lftp_quote: Callable[[str], str],
    parse_ls_line: Callable[[str], dict | None],
) -> bool | None:
    rc, out, _err = mgr._run_lftp(sess, [f"cls -ld {lftp_quote(rpath)}"], capture=True)
    if rc != 0:
        return None
    text = (out or b"").decode("utf-8", errors="replace")
    for line in text.splitlines():
        item = parse_ls_line(line)
        if item:
            return item.get("type") == "dir"
    return None


def remote_exists(
    mgr: Any,
    sess: Any,
    rpath: str,
    *,
    lftp_quote: Callable[[str], str],
    parse_ls_line: Callable[[str], dict | None],
) -> bool:
    return remote_is_dir(
        mgr, sess, rpath, lftp_quote=lftp_quote, parse_ls_line=parse_ls_line
    ) is not None


def url_for_session_path(sess: Any, path: str) -> str:
    """Build a URL with embedded credentials for lftp URL-style commands."""
    p = (path or "").strip() or "/"
    if not p.startswith("/"):
        p = "/" + p
    user = _url_quote(getattr(sess, "username", "") or "", safe="")
    pwd = _url_quote(getattr(sess, "password", "") or "", safe="")
    host = getattr(sess, "host", "")
    port = int(getattr(sess, "port", 0) or 0)
    proto = getattr(sess, "protocol", "")
    p_enc = _url_quote(p, safe="/")
    return f"{proto}://{user}:{pwd}@{host}:{port}{p_enc}"


def run_lftp_raw(mgr: Any, script: str) -> Tuple[int, bytes, bytes]:
    env = os.environ.copy()
    env.setdefault("LC_ALL", "C")
    env.setdefault("LANG", "C")
    p = subprocess.Popen(
        [mgr.lftp_bin, "-c", script],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )
    out, err = p.communicate()
    return int(p.returncode or 0), out or b"", err or b""


def popen_lftp_raw(mgr: Any, script: str) -> subprocess.Popen:
    env = os.environ.copy()
    env.setdefault("LC_ALL", "C")
    env.setdefault("LANG", "C")
    return subprocess.Popen(
        [mgr.lftp_bin, "-c", script],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        bufsize=0,
    )


def popen_lftp_quiet(mgr: Any, sess: Any, commands: List[str]) -> subprocess.Popen:
    """Run lftp with stdout suppressed to avoid pipe buffer deadlocks."""
    script = mgr._build_lftp_script(sess, commands)
    env = os.environ.copy()
    env.setdefault("LC_ALL", "C")
    env.setdefault("LANG", "C")
    return subprocess.Popen(
        [mgr.lftp_bin, "-c", script],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        env=env,
        bufsize=0,
    )


def terminate_proc(proc: subprocess.Popen) -> None:
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


def build_lftp_url_script(
    src_sess: Any,
    dst_sess: Any,
    commands: Sequence[str],
    *,
    tls_verify_modes: Iterable[str],
    fxp_enabled: bool,
    lftp_quote: Callable[[str], str],
) -> str:
    """Build an lftp script for URL-based (remote->remote) commands."""

    timeout = max(
        int(getattr(src_sess, "options", {}).get("timeout_sec", 10) or 10),
        int(getattr(dst_sess, "options", {}).get("timeout_sec", 10) or 10),
    )

    modes = {str(x) for x in tls_verify_modes}

    def _mode(sess: Any) -> str:
        m = str(getattr(sess, "options", {}).get("tls_verify_mode") or "none").strip().lower()
        return m if m in modes else "none"

    m1 = _mode(src_sess)
    m2 = _mode(dst_sess)
    tls_verify = (m1 != "none") and (m2 != "none")
    strict_host = (m1 == "strict") and (m2 == "strict")
    ca_file = getattr(src_sess, "options", {}).get("tls_ca_file") or getattr(dst_sess, "options", {}).get(
        "tls_ca_file"
    )

    parts: List[str] = [
        "set cmd:fail-exit yes",
        "set cmd:interactive false",
        f"set net:timeout {timeout}",
        "set net:max-retries 1",
        "set net:persist-retries 0",
    ]

    parts.append(f"set ftp:use-fxp {'yes' if fxp_enabled else 'no'}")
    parts.append(f"set ssl:verify-certificate {'yes' if tls_verify else 'no'}")
    parts.append(f"set ssl:check-hostname {'yes' if strict_host else 'no'}")
    if ca_file:
        parts.append(f"set ssl:ca-file {lftp_quote(str(ca_file))}")

    parts.extend(list(commands))
    parts.append("bye")
    return "; ".join(parts)
