"""Invoke the KeeneticOS firmware CLI (``ndmc``) from the panel process.

The init script sources ``/opt/etc/profile`` before starting Python so that
native extensions can dlopen Entware libraries.  That leaves
``LD_LIBRARY_PATH`` pointing at ``/opt/lib``, and every firmware binary the
panel spawns inherits it: ``ndmc`` then loads Entware's OpenSSL instead of the
one shipped with the firmware and aborts before it can talk to ndm::

    ndm: ndmc: system failed [0xcffd0062]
    ndm: Cli::Main: failed to initialize

Putting the firmware library directories first restores the correct load
order.  KeeneticOS 4.3+ additionally expects a controlling terminal, so an
initialization failure is retried once on a pseudo-terminal.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass
from typing import Optional, Sequence

_FIRMWARE_LIB_DIRS = ("/lib", "/usr/lib")
_NDMC_FALLBACK_PATHS = ("/bin/ndmc", "/usr/bin/ndmc", "/opt/bin/ndmc")
_INIT_FAILURE_MARKERS = ("failed to initialize", "system failed [0xcffd")


@dataclass
class NdmcRun:
    rc: int
    stdout: str
    stderr: str

    @property
    def output(self) -> str:
        return f"{self.stdout or ''}\n{self.stderr or ''}".strip()

    @property
    def init_failed(self) -> bool:
        lowered = self.output.lower()
        return any(marker in lowered for marker in _INIT_FAILURE_MARKERS)


def firmware_env(base: Optional[dict] = None) -> dict:
    """Environment for firmware binaries: firmware libraries win over /opt."""

    env = dict(os.environ if base is None else base)
    current = str(env.get("LD_LIBRARY_PATH") or "")
    rest = [part for part in current.split(":") if part and part not in _FIRMWARE_LIB_DIRS]
    env["LD_LIBRARY_PATH"] = ":".join([*_FIRMWARE_LIB_DIRS, *rest])
    return env


def ndmc_path() -> str:
    try:
        found = shutil.which("ndmc")
    except Exception:
        found = None
    if found:
        return str(found)
    for candidate in _NDMC_FALLBACK_PATHS:
        try:
            if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
                return candidate
        except Exception:
            continue
    return ""


def run_ndmc(payload: str, *, timeout: float = 15.0, binary: Optional[str] = None) -> NdmcRun:
    """Run ``ndmc -c <payload>`` with a firmware-safe environment.

    Raises ``FileNotFoundError`` when ndmc is not installed and lets
    ``subprocess.TimeoutExpired`` propagate, so callers keep their own
    error mapping.
    """

    exe = str(binary or "").strip() or ndmc_path()
    if not exe:
        raise FileNotFoundError("ndmc")
    argv = [exe, "-c", str(payload)]
    env = firmware_env()
    proc = subprocess.run(
        argv,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
        env=env,
    )
    run = NdmcRun(int(proc.returncode or 0), str(proc.stdout or ""), str(proc.stderr or ""))
    if run.rc == 0 or not run.init_failed:
        return run
    retried = _run_on_pty(argv, env=env, timeout=timeout)
    return retried if retried is not None else run


def _run_on_pty(argv: Sequence[str], *, env: dict, timeout: float) -> Optional[NdmcRun]:
    """Second attempt for firmware builds that insist on a real terminal."""

    try:
        import fcntl
        import pty
        import select
        import struct
        import termios
        import time
    except Exception:  # pragma: no cover - non-POSIX (local dev on Windows)
        return None

    try:
        master, slave = pty.openpty()
    except Exception:
        return None

    proc = None
    chunks: list[bytes] = []
    try:
        try:
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 200, 0, 0))
        except Exception:
            pass
        env = dict(env)
        env.setdefault("TERM", "dumb")
        proc = subprocess.Popen(
            list(argv),
            stdin=slave,
            stdout=slave,
            stderr=slave,
            env=env,
            close_fds=True,
        )
        os.close(slave)
        slave = -1

        deadline = time.monotonic() + float(timeout)
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                proc.kill()
                break
            ready, _, _ = select.select([master], [], [], min(0.25, remaining))
            if ready:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    break
                if not data:
                    break
                chunks.append(data)
            elif proc.poll() is not None:
                break
        try:
            rc = proc.wait(timeout=2)
        except Exception:
            proc.kill()
            rc = proc.poll() or 1
    except Exception:
        if proc is not None:
            try:
                proc.kill()
            except Exception:
                pass
        return None
    finally:
        for fd in (master, slave):
            if fd is not None and fd >= 0:
                try:
                    os.close(fd)
                except Exception:
                    pass

    text = b"".join(chunks).decode("utf-8", "replace")
    return NdmcRun(int(rc or 0), text, "")
