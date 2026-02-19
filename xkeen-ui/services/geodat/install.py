from __future__ import annotations

"""Helpers for installing/checking xk-geodat binary."""

import os
import re
import subprocess
import urllib.error
import urllib.request
from typing import Any, Dict, Tuple


_CRASH_RE = re.compile(
    r"(SIGSEGV|segmentation\s+violation|SIGILL|illegal\s+instruction|SIGBUS|bus\s+error|futexwakeup)",
    re.IGNORECASE,
)


def _is_mips_platform() -> bool:
    try:
        m = (os.uname().machine or '').lower()
    except Exception:
        m = ''
    return 'mips' in m


def _append_godebug(env: Dict[str, str], token: str) -> None:
    if not token:
        return
    gd = (env.get('GODEBUG', '') or '').strip()
    if token in gd:
        return
    env['GODEBUG'] = (gd + (',' if gd else '') + token)


def _apply_mips_safe_env(env: Dict[str, str]) -> Dict[str, str]:
    if not _is_mips_platform():
        return env
    env2 = dict(env)
    _append_godebug(env2, 'asyncpreemptoff=1')
    env2.setdefault('GOMAXPROCS', '1')
    return env2


def _geodat_stat_meta(path: str) -> Dict[str, Any]:
    st = os.stat(path)
    return {
        'size': int(getattr(st, 'st_size', 0) or 0),
        'mtime': int(getattr(st, 'st_mtime', 0) or 0),
    }


def _download_to_file(url: str, tmp_path: str, max_bytes: int | None) -> int:
    """Download URL to tmp_path with an optional size cap (bytes)."""
    req = urllib.request.Request(url, headers={"User-Agent": "Xkeen-UI"})
    with urllib.request.urlopen(req, timeout=45) as resp:
        status = getattr(resp, "status", None)
        if isinstance(status, int) and status >= 400:
            raise RuntimeError(f"http_{status}")
        try:
            length = resp.headers.get("Content-Length")
            if length is not None and max_bytes is not None and int(length) > max_bytes:
                raise RuntimeError("size_limit")
        except ValueError:
            pass

        total = 0
        with open(tmp_path, "wb") as f:
            while True:
                chunk = resp.read(256 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if max_bytes is not None and total > max_bytes:
                    raise RuntimeError("size_limit")
                f.write(chunk)
    return total


def _geodat_install_script_path() -> str:
    return (os.getenv('XKEEN_GEODAT_INSTALL_SCRIPT', '') or '').strip() or '/opt/etc/xkeen-ui/scripts/install_xk_geodat.sh'


def _geodat_run_help(bin_path: str) -> Tuple[bool, str]:
    """Return (ok_installed, help_text_tail).

    Best-effort sanity check. Some builds exit non-zero on --help, so we treat
    them as installed unless it's an execution/format error.
    """

    def _run(env: dict[str, str]):
        return subprocess.run(
            [bin_path, '--help'],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
            timeout=3,
        )

    env0 = _apply_mips_safe_env(os.environ.copy())
    p = _run(env0)
    out = (p.stdout or '').strip()
    err = (p.stderr or '').strip()
    comb = (out + "\n" + err).strip()

    if p.returncode != 0:
        m = re.search(r"ASSUME_NO_MOVING_GC_UNSAFE_RISK_IT_WITH=(go\d+\.\d+)", comb)
        if m and "ASSUME_NO_MOVING_GC_UNSAFE_RISK_IT_WITH" not in env0:
            env1 = env0.copy()
            env1["ASSUME_NO_MOVING_GC_UNSAFE_RISK_IT_WITH"] = m.group(1)
            p2 = _run(env1)
            out2 = (p2.stdout or '').strip()
            err2 = (p2.stderr or '').strip()
            comb2 = (out2 + "\n" + err2).strip()
            # If it executes (even with non-zero), we consider it installed.
            if _CRASH_RE.search(comb2):
                return False, comb2[:800]
            if p2.returncode in (126, 127) or 'Exec format error' in comb2 or 'not found' in comb2:
                return False, comb2[:800]
            return True, (comb2 or comb)[:800]

        # Non-fatal: some builds exit non-zero on --help.
        if _CRASH_RE.search(comb):
            return False, comb[:800]
        if p.returncode in (126, 127) or 'Exec format error' in comb or 'not found' in comb:
            return False, comb[:800]
        return True, comb[:800]

    return True, (comb or out or err)[:800]
