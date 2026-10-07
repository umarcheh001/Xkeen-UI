"""Let the panel ask the runner of an operation to stop, without its process id.

A signal sent by process id reaches whoever owns that number now. Only a
kernel with ``pidfd`` (5.3 and newer) can pin the process itself, and routers
run older ones. So the runner listens for the request on the loopback address
and interrupts itself: nothing is ever sent to a process by its number. The
worst a stale address can do is hand the word of a finished operation to a
stranger, who has no use for it.
"""

from __future__ import annotations

import hmac
import secrets
import socket
import threading
from typing import Any, Callable, Mapping


LOOPBACK = "127.0.0.1"
_ACCEPT_POLL_S = 0.2
_CLIENT_TIMEOUT_S = 3.0
_MAX_REQUEST_BYTES = 512


def _read_line(connection: socket.socket) -> bytes:
    received = b""
    while b"\n" not in received and len(received) < _MAX_REQUEST_BYTES:
        chunk = connection.recv(_MAX_REQUEST_BYTES)
        if not chunk:
            break
        received += chunk
    return received.split(b"\n", 1)[0]


class CancelListener:
    """The runner's side: waits for the word of its operation and calls ``on_cancel``."""

    def __init__(self, operation_id: str, on_cancel: Callable[[], None]) -> None:
        self._operation_id = str(operation_id)
        self._on_cancel = on_cancel
        self._token = secrets.token_hex(32)
        self._socket: socket.socket | None = None
        self._thread: threading.Thread | None = None
        self._closing = threading.Event()

    def start(self) -> dict[str, Any]:
        """Begin to listen; the answer is what the panel needs to reach this runner."""

        listening = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            listening.bind((LOOPBACK, 0))
            listening.listen(4)
            # Closing a socket does not wake a thread that waits in accept on
            # every system; a short wait and a flag do.
            listening.settimeout(_ACCEPT_POLL_S)
        except OSError:
            listening.close()
            raise
        self._socket = listening
        self._thread = threading.Thread(target=self._serve, name="module-operation-cancel", daemon=True)
        self._thread.start()
        return {"host": LOOPBACK, "port": int(listening.getsockname()[1]), "token": self._token}

    def _serve(self) -> None:
        expected = f"{self._token} {self._operation_id}".encode("ascii", errors="replace")
        while not self._closing.is_set():
            try:
                connection, _peer = self._socket.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            with connection:
                try:
                    connection.settimeout(_CLIENT_TIMEOUT_S)
                    if hmac.compare_digest(_read_line(connection), expected):
                        self._on_cancel()
                        connection.sendall(b"ok\n")
                    else:
                        connection.sendall(b"no\n")
                except Exception:
                    # A client that hangs up or says rubbish is nobody's problem.
                    continue

    def close(self) -> None:
        self._closing.set()
        thread, self._thread = self._thread, None
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=_ACCEPT_POLL_S * 10)
        listening, self._socket = self._socket, None
        if listening is not None:
            try:
                listening.close()
            except OSError:
                pass


def send_cancel(address: Mapping[str, Any], operation_id: str, *, timeout: float = _CLIENT_TIMEOUT_S) -> bool:
    """Ask the runner at ``address`` to stop; whether it took the request for its own.

    Raises ``OSError`` when nobody listens there and ``ValueError`` when the
    address is not one a runner could have recorded.
    """

    if not isinstance(address, Mapping):
        raise ValueError("no cancel address")
    host, port, token = address.get("host"), address.get("port"), address.get("token")
    if host != LOOPBACK or isinstance(port, bool) or not isinstance(port, int) or not 0 < port < 65536:
        raise ValueError("invalid cancel address")
    if not isinstance(token, str) or not token.isalnum():
        raise ValueError("invalid cancel token")
    with socket.create_connection((host, port), timeout=timeout) as connection:
        connection.settimeout(timeout)
        connection.sendall(f"{token} {operation_id}\n".encode("ascii", errors="replace"))
        return _read_line(connection) == b"ok"
