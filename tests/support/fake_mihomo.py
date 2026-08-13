"""Stateful dependency-free Mihomo API double for local/CI integration tests."""

from __future__ import annotations

import json
import socketserver
import threading
import time
from contextlib import AbstractContextManager
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit


def connection_payload(count: int, *, generation: int = 0) -> dict[str, Any]:
    rows = []
    for index in range(max(0, int(count))):
        rows.append(
            {
                "id": f"conn-{generation}-{index:04d}",
                "metadata": {
                    "network": "udp" if index % 5 == 0 else "tcp",
                    "type": "Mixed",
                    "sourceIP": f"192.0.2.{index % 200 + 1}",
                    "sourcePort": str(20_000 + index),
                    "destinationIP": f"198.51.100.{index % 200 + 1}",
                    "destinationPort": "443",
                    "host": f"host-{index}.example.test",
                    "inboundName": "mixed-in",
                },
                "upload": index * 101 + generation * 1024,
                "download": index * 503 + generation * 4096,
                "start": "2026-08-10T08:00:00.000Z",
                "chains": ["AUTO", f"node-{index % 8}"],
                "providerChains": ["fixture-provider"],
                "rule": "DomainSuffix",
                "rulePayload": "example.test",
            }
        )
    return {
        "downloadTotal": generation * 4_000_000 + sum(row["download"] for row in rows),
        "uploadTotal": generation * 1_000_000 + sum(row["upload"] for row in rows),
        "memory": 32 * 1024 * 1024 + len(rows) * 4096,
        "connections": rows,
    }


@dataclass
class FakeMihomoState:
    secret: str = "fixture-secret"
    connection_count: int = 8
    delay_seconds: float = 0.0
    forced_status: dict[str, int] = field(default_factory=dict)
    generation: int = 0
    mode: str = "rule"
    selected: dict[str, str] = field(default_factory=lambda: {"AUTO": "node-a"})
    provider_updates: list[tuple[str, str]] = field(default_factory=list)
    provider_healthchecks: list[str] = field(default_factory=list)
    disconnected_ids: set[str] = field(default_factory=set)
    requests: list[dict[str, Any]] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            payload = connection_payload(self.connection_count, generation=self.generation)
            rows = [
                row
                for row in payload["connections"]
                if row["id"] not in self.disconnected_ids
            ]
            payload["connections"] = rows
            payload["downloadTotal"] = self.generation * 4_000_000 + sum(
                row["download"] for row in rows
            )
            payload["uploadTotal"] = self.generation * 1_000_000 + sum(
                row["upload"] for row in rows
            )
            return payload

    def record(self, method: str, path: str, authorization: str) -> None:
        with self.lock:
            self.requests.append(
                {"method": method, "path": path, "authorization": authorization}
            )

    def disconnect(self, connection_id: str) -> bool:
        with self.lock:
            active_ids = {
                row["id"]
                for row in connection_payload(
                    self.connection_count,
                    generation=self.generation,
                )["connections"]
                if row["id"] not in self.disconnected_ids
            }
            if connection_id not in active_ids:
                return False
            self.disconnected_ids.add(connection_id)
            return True

    def disconnect_all(self) -> int:
        with self.lock:
            active_ids = {
                row["id"]
                for row in connection_payload(
                    self.connection_count,
                    generation=self.generation,
                )["connections"]
                if row["id"] not in self.disconnected_ids
            }
            self.disconnected_ids.update(active_ids)
            return len(active_ids)


class _ThreadingUnixHTTPServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    """HTTPServer-compatible Unix listener used by the same request handler."""

    daemon_threads = True
    allow_reuse_address = True


class FakeMihomo(AbstractContextManager["FakeMihomo"]):
    def __init__(
        self,
        state: FakeMihomoState | None = None,
        *,
        socket_path: Path | None = None,
    ):
        self.state = state or FakeMihomoState()
        self.socket_path = Path(socket_path) if socket_path is not None else None
        self.server: ThreadingHTTPServer | _ThreadingUnixHTTPServer | None = None
        self.thread: threading.Thread | None = None

    @property
    def port(self) -> int:
        if self.server is None:
            raise RuntimeError("fake Mihomo is not running")
        if self.socket_path is not None:
            raise RuntimeError("Unix fake Mihomo does not expose a TCP port")
        return int(self.server.server_port)

    def __enter__(self) -> "FakeMihomo":
        state = self.state

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, _format, *_args):
                return

            def _send(self, status: int, payload: Any = None) -> None:
                raw = b"" if payload is None else json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                if raw:
                    try:
                        self.wfile.write(raw)
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        # Timeout tests intentionally close the client side first.
                        pass

            def _authorize(self) -> bool:
                if not state.secret:
                    return True
                if self.headers.get("Authorization") == f"Bearer {state.secret}":
                    return True
                self._send(401, {"message": "credential rejected"})
                return False

            def _prepare(self) -> tuple[str, str] | None:
                parsed = urlsplit(self.path)
                state.record(self.command, parsed.path, self.headers.get("Authorization") or "")
                if not self._authorize():
                    return None
                if state.delay_seconds:
                    time.sleep(state.delay_seconds)
                status = state.forced_status.get(parsed.path)
                if status:
                    self._send(status, {"message": "forced fixture error"})
                    return None
                return parsed.path, parsed.query

            def _send_log_stream(self) -> None:
                frames = [
                    {"time": "2026-08-10T10:02:00Z", "level": "info", "message": "fixture request", "fields": {"network": "tcp"}},
                    {"time": "2026-08-10T10:02:01Z", "level": "warning", "message": f"Bearer {state.secret}", "fields": {"secret": state.secret, "host": "fixture.test"}},
                ]
                raw = b"\n".join(json.dumps(frame).encode("utf-8") for frame in frames) + b"\n"
                self.send_response(200)
                self.send_header("Content-Type", "application/x-ndjson")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                try:
                    self.wfile.write(raw)
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def do_GET(self):  # noqa: N802
                prepared = self._prepare()
                if prepared is None:
                    return
                path, _query = prepared
                if path == "/logs":
                    self._send_log_stream()
                elif path == "/version":
                    self._send(200, {"version": "Mihomo Meta fake-pr8"})
                elif path == "/configs":
                    self._send(200, {"mode": state.mode, "tun": {"enable": True}})
                elif path in {"/proxies", "/group"}:
                    now = state.selected.get("AUTO", "node-a")
                    self._send(
                        200,
                        {
                            "proxies": {
                                "GLOBAL": {"type": "Selector", "all": ["AUTO"], "now": "AUTO"},
                                "AUTO": {"type": "Selector", "all": ["node-a", "node-b"], "now": now},
                                "node-a": {"type": "VLESS", "alive": True, "history": [{"delay": 40}]},
                                "node-b": {"type": "Trojan", "alive": True, "history": [{"delay": 80}]},
                            }
                        },
                    )
                elif path == "/providers/proxies":
                    self._send(
                        200,
                        {
                            "providers": {
                                "fixture-proxy": {
                                    "name": "fixture-proxy",
                                    "type": "Proxy",
                                    "vehicleType": "HTTP",
                                    "updatedAt": "2026-08-10T10:00:00Z",
                                    "healthCheck": {"enable": True},
                                    "proxies": [
                                        {"name": "node-a", "alive": True},
                                        {"name": "node-b", "alive": False},
                                    ],
                                }
                            }
                        },
                    )
                elif path == "/providers/rules":
                    self._send(
                        200,
                        {
                            "providers": {
                                "fixture-rules": {
                                    "name": "fixture-rules",
                                    "type": "Rule",
                                    "vehicleType": "HTTP",
                                    "updatedAt": "2026-08-10T10:01:00Z",
                                    "behavior": "domain",
                                    "format": "mrs",
                                    "ruleCount": 12,
                                }
                            }
                        },
                    )
                elif path == "/rules":
                    self._send(
                        200,
                        {
                            "rules": [
                                {"type": "DomainSuffix", "payload": "example.test", "proxy": "AUTO"},
                                {"type": "RuleSet", "payload": "fixture-rules", "proxy": "DIRECT"},
                                {"type": "Match", "payload": "", "proxy": "AUTO"},
                            ]
                        },
                    )
                elif path == "/connections":
                    self._send(200, state.snapshot())
                elif path == "/memory":
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(b'{"inuse":0,"oslimit":0}\n')
                    self.wfile.flush()
                    self.wfile.write(b'{"inuse":33554432,"oslimit":0}\n')
                elif path.startswith("/providers/proxies/") and path.endswith("/healthcheck"):
                    provider = unquote(path.removeprefix("/providers/proxies/").removesuffix("/healthcheck").rstrip("/"))
                    with state.lock:
                        state.provider_healthchecks.append(provider)
                    self._send(204)
                elif path.endswith("/delay") or path.endswith("/healthcheck"):
                    self._send(200, {"delay": 42})
                else:
                    self._send(404, {"message": "missing"})

            def do_PUT(self):  # noqa: N802
                prepared = self._prepare()
                if prepared is None:
                    return
                path, _query = prepared
                if path.startswith("/providers/proxies/"):
                    provider = unquote(path.removeprefix("/providers/proxies/"))
                    with state.lock:
                        state.provider_updates.append(("proxy", provider))
                    self._send(204)
                    return
                if path.startswith("/providers/rules/"):
                    provider = unquote(path.removeprefix("/providers/rules/"))
                    with state.lock:
                        state.provider_updates.append(("rule", provider))
                    self._send(204)
                    return
                if not path.startswith("/proxies/"):
                    self._send(404, {"message": "missing"})
                    return
                size = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(size) or b"{}")
                with state.lock:
                    state.selected[unquote(path.removeprefix("/proxies/"))] = str(body.get("name") or "")
                self._send(204)

            def do_PATCH(self):  # noqa: N802
                prepared = self._prepare()
                if prepared is None:
                    return
                path, _query = prepared
                if path != "/configs":
                    self._send(404, {"message": "missing"})
                    return
                size = int(self.headers.get("Content-Length") or 0)
                try:
                    body = json.loads(self.rfile.read(size) or b"{}")
                except (TypeError, ValueError, json.JSONDecodeError):
                    self._send(400, {"message": "invalid json"})
                    return
                mode = str(body.get("mode") or "").lower()
                if mode not in {"rule", "global", "direct"}:
                    self._send(400, {"message": "invalid mode"})
                    return
                with state.lock:
                    state.mode = mode
                self._send(204)

            def do_DELETE(self):  # noqa: N802
                prepared = self._prepare()
                if prepared is None:
                    return
                path, _query = prepared
                if path == "/connections":
                    state.disconnect_all()
                elif path.startswith("/proxies/"):
                    # Mihomo's "unfix" endpoint is relevant for automatic
                    # proxy groups.  The fixture has no persisted fixed state,
                    # so accepting it is sufficient to exercise the facade and
                    # UI reconciliation flow locally.
                    self._send(204)
                    return
                elif path.startswith("/connections/"):
                    requested = unquote(path.removeprefix("/connections/"))
                    if not state.disconnect(requested):
                        self._send(404, {"message": "missing"})
                        return
                else:
                    self._send(404, {"message": "missing"})
                    return
                self._send(204)

        if self.socket_path is None:
            self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        else:
            self.socket_path.parent.mkdir(parents=True, exist_ok=True)
            self.socket_path.unlink(missing_ok=True)
            self.server = _ThreadingUnixHTTPServer(str(self.socket_path), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *_exc_info) -> None:
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()
        if self.thread is not None:
            self.thread.join(timeout=3)
        if self.socket_path is not None:
            self.socket_path.unlink(missing_ok=True)
        self.server = None
        self.thread = None


__all__ = ["FakeMihomo", "FakeMihomoState", "connection_payload"]
