from __future__ import annotations

import json
import socket
import socketserver
import threading
import time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from services.mihomo_clash_client import (
    MihomoClashClient,
    MihomoClashClientError,
    MihomoClashEndpoint,
)
from services.mihomo_clash_target import MihomoClashTarget


class _FixtureHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    responses: dict[str, tuple[int, str, bytes]] = {}
    seen: list[dict[str, str]] = []

    def do_GET(self):  # noqa: N802
        self.__class__.seen.append(
            {
                "path": self.path,
                "authorization": self.headers.get("Authorization") or "",
                "connection": self.headers.get("Connection") or "",
            }
        )
        status, content_type, payload = self.__class__.responses.get(
            self.path,
            (404, "application/json", b'{"error":"missing"}'),
        )
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
        self.wfile.flush()

    def do_PUT(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length)
        self.__class__.seen.append(
            {
                "method": "PUT",
                "path": self.path,
                "authorization": self.headers.get("Authorization") or "",
                "content_type": self.headers.get("Content-Type") or "",
                "body": body.decode("utf-8"),
            }
        )
        status, content_type, payload = self.__class__.responses.get(
            f"PUT {self.path}",
            (404, "application/json", b'{"error":"missing"}'),
        )
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
        self.wfile.flush()

    def log_message(self, _format, *_args):
        return


@contextmanager
def tcp_server(responses):
    handler = type("FixtureHandler", (_FixtureHandler,), {"responses": responses, "seen": []})
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_port, handler
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def client_for_port(port: int, endpoints, *, secret: str = "") -> MihomoClashClient:
    return MihomoClashClient(
        MihomoClashTarget(
            transport="tcp",
            port=port,
            loopback_host="127.0.0.1",
            secret=secret,
        ),
        endpoints=endpoints,
    )


def test_tcp_client_uses_allowlisted_operation_and_injects_bearer_header():
    endpoints = {"probe": MihomoClashEndpoint("GET", "/version", 2, 1024)}
    with tcp_server({"/version": (200, "application/json", b'{"version":"test"}')}) as (port, handler):
        response = client_for_port(port, endpoints, secret="backend-only").request_json("probe")

    assert response.payload == {"version": "test"}
    assert handler.seen == [
        {
            "path": "/version",
            "authorization": "Bearer backend-only",
            "connection": "close",
        }
    ]


def test_client_rejects_unknown_operation_before_connecting():
    client = client_for_port(9, {})
    with pytest.raises(MihomoClashClientError) as captured:
        client.request_json("../../debug")
    assert captured.value.code == "operation_not_allowed"
    assert captured.value.status == 400


@pytest.mark.parametrize(
    "path",
    [
        "http://router:9090/version",
        "//router/version",
        "/bad#fragment",
        "/proxies/{unknown}",
        "/proxies/{name}/{name}",
    ],
)
def test_client_rejects_unsafe_endpoint_table_path(path: str):
    with pytest.raises(ValueError, match="endpoint path"):
        client_for_port(9090, {"unsafe": MihomoClashEndpoint("GET", path, 2, 1024)})


@pytest.mark.parametrize(
    ("status", "code"),
    [(401, "api_unauthorized"), (404, "endpoint_not_supported"), (429, "upstream_busy")],
)
def test_client_maps_upstream_status_without_leaking_body(status: int, code: str):
    endpoints = {"probe": MihomoClashEndpoint("GET", "/probe", 2, 1024)}
    body = b'{"error":"secret-sensitive-upstream-detail"}'
    with tcp_server({"/probe": (status, "application/json", body)}) as (port, _handler):
        with pytest.raises(MihomoClashClientError) as captured:
            client_for_port(port, endpoints).request_json("probe")
    assert captured.value.code == code
    assert "secret-sensitive" not in str(captured.value)


def test_client_rejects_declared_oversized_response_before_json_decode():
    endpoints = {"probe": MihomoClashEndpoint("GET", "/probe", 2, 4)}
    with tcp_server({"/probe": (200, "application/json", b'{"long":true}')}) as (port, _handler):
        with pytest.raises(MihomoClashClientError) as captured:
            client_for_port(port, endpoints).request_json("probe")
    assert captured.value.code == "upstream_payload_too_large"


def test_client_rejects_unexpected_content_type():
    endpoints = {"probe": MihomoClashEndpoint("GET", "/probe", 2, 1024)}
    with tcp_server({"/probe": (200, "text/html", b"<html></html>")}) as (port, _handler):
        with pytest.raises(MihomoClashClientError) as captured:
            client_for_port(port, endpoints).request_json("probe")
    assert captured.value.code == "upstream_content_type_invalid"


def test_client_maps_socket_timeout_to_retryable_safe_error():
    class SlowHandler(_FixtureHandler):
        def do_GET(self):  # noqa: N802
            time.sleep(0.2)
            super().do_GET()

    SlowHandler.responses = {"/slow": (200, "application/json", b"{}")}
    SlowHandler.seen = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), SlowHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        client = client_for_port(
            server.server_port,
            {"slow": MihomoClashEndpoint("GET", "/slow", 0.05, 1024)},
        )
        with pytest.raises(MihomoClashClientError) as captured:
            client.request_json("slow")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
    assert captured.value.code == "upstream_timeout"
    assert captured.value.status == 504
    assert captured.value.retryable is True


def test_client_stream_parser_handles_multiple_ndjson_frames():
    endpoints = {"stream": MihomoClashEndpoint("GET", "/stream", 2, 1024, stream=True)}
    body = b'{"sequence":1}\n{"sequence":2}\n'
    with tcp_server({"/stream": (200, "application/json", body)}) as (port, _handler):
        frames = list(client_for_port(port, endpoints).iter_json_frames("stream"))
    assert frames == [{"sequence": 1}, {"sequence": 2}]


def test_select_proxy_encodes_one_path_segment_and_sends_bounded_json_body():
    endpoints = {"proxy_select": MihomoClashEndpoint("PUT", "/proxies/{name}", 2, 1024)}
    expected_path = "/proxies/%D0%90%D0%B2%D1%82%D0%BE%2F%D0%B2%D1%8B%D0%B1%D0%BE%D1%80"
    with tcp_server(
        {f"PUT {expected_path}": (204, "text/plain", b"")}
    ) as (port, handler):
        response = client_for_port(port, endpoints, secret="backend-only").select_proxy(
            "Авто/выбор",
            "узел-A",
        )

    assert response.status == 204
    assert response.payload is None
    assert handler.seen == [
        {
            "method": "PUT",
            "path": expected_path,
            "authorization": "Bearer backend-only",
            "content_type": "application/json",
            "body": '{"name":"узел-A"}',
        }
    ]


def test_provider_proxy_delay_encodes_provider_and_node_segments():
    endpoints = {
        "provider_proxy_delay": MihomoClashEndpoint(
            "GET",
            "/providers/proxies/{provider}/proxies/{name}/healthcheck",
            2,
            1024,
        )
    }
    expected = (
        "/providers/proxies/provider%2Fone/proxies/node%2Fone/healthcheck"
        "?url=https%3A%2F%2Fwww.gstatic.com%2Fgenerate_204&timeout=5000&expected=204"
    )
    with tcp_server({expected: (200, "application/json", b'{"delay":42}')}) as (port, handler):
        response = client_for_port(port, endpoints).request_provider_proxy_delay(
            "provider/one",
            "node/one",
        )

    assert response.payload == {"delay": 42}
    assert handler.seen[0]["path"] == expected


def test_delay_uses_backend_preset_and_never_accepts_arbitrary_url():
    endpoints = {"proxy_delay": MihomoClashEndpoint("GET", "/proxies/{name}/delay", 2, 1024)}
    expected_path = (
        "/proxies/node%20A/delay?"
        "url=https%3A%2F%2Fwww.gstatic.com%2Fgenerate_204&timeout=5000&expected=204"
    )
    with tcp_server({expected_path: (200, "application/json", b'{"delay":87}')}) as (
        port,
        handler,
    ):
        response = client_for_port(port, endpoints).request_delay("proxy", "node A", preset="google")

    assert response.payload == {"delay": 87}
    assert handler.seen[0]["path"] == expected_path

    client = client_for_port(port, endpoints)
    with pytest.raises(MihomoClashClientError) as captured:
        client.request_delay("proxy", "node A", preset="http://router/private")
    assert captured.value.code == "delay_preset_not_allowed"


@pytest.mark.parametrize("name", ["", "bad\nheader", "x" * 1025])
def test_named_operations_reject_invalid_resource_names_before_connecting(name: str):
    endpoints = {"proxy_select": MihomoClashEndpoint("PUT", "/proxies/{name}", 2, 1024)}
    client = client_for_port(9, endpoints)
    with pytest.raises(MihomoClashClientError) as captured:
        client.select_proxy(name, "node")
    assert captured.value.code == "resource_name_invalid"


@pytest.mark.skipif(not hasattr(socket, "AF_UNIX"), reason="Unix sockets are unavailable")
def test_unix_socket_client_uses_same_http_contract(tmp_path: Path):
    socket_path = tmp_path / "mihomo.sock"

    class UnixHTTPServer(socketserver.UnixStreamServer):
        allow_reuse_address = True

    handler = type(
        "UnixFixtureHandler",
        (_FixtureHandler,),
        {"responses": {"/version": (200, "application/json", b'{"version":"unix"}')}, "seen": []},
    )
    server = UnixHTTPServer(str(socket_path), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        client = MihomoClashClient(
            MihomoClashTarget(transport="unix", socket_path=socket_path),
            endpoints={"probe": MihomoClashEndpoint("GET", "/version", 2, 1024)},
        )
        response = client.request_json("probe")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
    assert response.payload == {"version": "unix"}
