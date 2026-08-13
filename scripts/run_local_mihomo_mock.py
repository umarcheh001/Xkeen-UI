#!/usr/bin/env python3
"""Run the stateful local Mihomo/Clash API fixture for manual UI testing.

It serves the same safe, deterministic API double used by the integration
tests over the panel's Unix controller socket.  No router, Mihomo binary, or
LAN port is required.  Stop it with Ctrl+C.
"""

from __future__ import annotations

import argparse
import errno
import signal
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from tests.support.fake_mihomo import FakeMihomo, FakeMihomoState


DEFAULT_SOCKET = REPO_ROOT / "xkeen-ui" / "opt" / "etc" / "mihomo" / "mihomo-api.sock"


def _ensure_socket_is_safe(socket_path: Path) -> None:
    """Refuse to replace a live controller; clean up only stale sockets."""
    if not socket_path.exists() and not socket_path.is_socket():
        return

    import socket

    probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        probe.settimeout(0.25)
        probe.connect(str(socket_path))
    except OSError as exc:
        if exc.errno not in {errno.ENOENT, errno.ECONNREFUSED}:
            raise RuntimeError(
                f"cannot verify existing socket {socket_path}: {exc}"
            ) from exc
    else:
        raise RuntimeError(
            f"a controller is already listening at {socket_path}; refusing to replace it"
        )
    finally:
        probe.close()

    socket_path.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--socket", type=Path, default=DEFAULT_SOCKET, help="Unix controller socket")
    parser.add_argument("--connections", type=int, default=8, help="initial fake active connections")
    args = parser.parse_args()

    socket_path = args.socket.expanduser().resolve()
    _ensure_socket_is_safe(socket_path)
    state = FakeMihomoState(connection_count=max(0, args.connections), secret="")

    with FakeMihomo(state, socket_path=socket_path):
        print(f"Local fake Mihomo API is ready on {socket_path}", flush=True)
        print("Panel actions are stateful: group selection, mode, latency, providers and connections.", flush=True)
        print("Press Ctrl+C to stop.", flush=True)
        signal.signal(signal.SIGTERM, lambda *_args: (_ for _ in ()).throw(KeyboardInterrupt()))
        try:
            signal.pause()
        except KeyboardInterrupt:
            print("Local fake Mihomo API stopped.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
