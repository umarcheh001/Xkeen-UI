import base64
import json
import os
from pathlib import Path

import pytest

from services import events, ws_wsgi


def handle(ws, *, subscribe=None, unsubscribe=None, validate=None):
    return ws_wsgi.handle_events_request(
        {"wsgi.websocket": ws, "QUERY_STRING": "token=test"},
        lambda *_: None,
        fallback_app=lambda *_: [b"fallback"], qs_safe="token=***",
        ws_debug=lambda *args, **kwargs: None,
        validate_ws_token=validate or (lambda *args, **kwargs: True),
        subscribe_ws=subscribe or events.subscribe,
        unsubscribe_ws=unsubscribe or events.unsubscribe,
        event_subscribers=events.EVENT_SUBSCRIBERS,
    )


class WebSocket:
    def __init__(self, messages):
        self.messages = iter(messages)
        self.closed = False
        self.sent = []

    def receive(self):
        message = next(self.messages)
        if isinstance(message, Exception):
            raise message
        return message

    def close(self):
        self.closed = True

    def send(self, data):
        self.sent.append(data)


@pytest.mark.parametrize("messages", [[None], ["", "ignored", None], [OSError("peer disconnected")], [ws_wsgi.WebSocketError("closed")]])
def test_disconnect_removes_subscriber_and_closes_socket_without_broadcast(messages):
    ws = WebSocket(messages)
    assert handle(ws) == []
    assert ws.closed and ws not in events.EVENT_SUBSCRIBERS


def test_subscription_failure_still_closes_socket():
    ws = WebSocket([])

    def fail(ws):
        events.subscribe(ws)
        raise OSError("subscribe failed")

    assert handle(ws, subscribe=fail) == []
    assert ws.closed and ws not in events.EVENT_SUBSCRIBERS


def test_unsubscribe_failure_still_closes_socket():
    ws = WebSocket([None])

    def fail(ws):
        events.unsubscribe(ws)
        raise OSError("unsubscribe failed")

    with pytest.raises(OSError):
        handle(ws, unsubscribe=fail)
    assert ws.closed and ws not in events.EVENT_SUBSCRIBERS


def test_unauthorized_socket_never_subscribes():
    ws = WebSocket([])
    assert handle(ws, validate=lambda *args, **kwargs: False) == []
    assert ws.closed and ws not in events.EVENT_SUBSCRIBERS


def test_real_gevent_reconnects_release_subscribers_and_file_descriptors():
    gevent = pytest.importorskip("gevent")
    pytest.importorskip("geventwebsocket")
    from gevent import socket
    from gevent.pywsgi import WSGIServer
    from geventwebsocket.handler import WebSocketHandler

    def app(environ, start_response):
        if environ.get("wsgi.websocket"):
            return handle(environ["wsgi.websocket"])
        start_response("200 OK", [("Content-Type", "text/plain")])
        return [b"ok"]

    server = WSGIServer(("127.0.0.1", 0), app, handler_class=WebSocketHandler, log=None)
    server.start()
    baseline_subscribers = len(events.EVENT_SUBSCRIBERS)

    def receive_exact(client, size):
        data = b""
        while len(data) < size:
            chunk = client.recv(size - len(data))
            assert chunk
            data += chunk
        return data

    def cycle(graceful):
        with socket.create_connection(("127.0.0.1", server.server_port), timeout=3) as client:
            key = base64.b64encode(os.urandom(16)).decode()
            client.sendall((f"GET /ws/events HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: {key}\r\n\r\n").encode())
            response = b""
            while b"\r\n\r\n" not in response:
                data = client.recv(4096)
                assert data
                response += data
            assert b"101" in response.split(b"\r\n", 1)[0]
            # Empty masked ping; a pong proves receive processes control frames.
            client.sendall(b"\x89\x80\x00\x00\x00\x00")
            assert receive_exact(client, 2) == b"\x8a\x00"
            events.broadcast_event({"name": "lifecycle-check"})
            opcode, size = receive_exact(client, 2)
            assert opcode == 0x81 and size < 126
            assert json.loads(receive_exact(client, size)) == {"type": "event", "name": "lifecycle-check"}
            if graceful:
                client.sendall(b"\x88\x80\x00\x00\x00\x00")
                assert receive_exact(client, 2) == b"\x88\x00"
        with gevent.Timeout(3):
            while len(events.EVENT_SUBSCRIBERS) != baseline_subscribers:
                gevent.sleep(0.001)

    try:
        cycle(True)
        cycle(False)
        fd_dir = Path("/proc/self/fd")
        baseline_fds = len(list(fd_dir.iterdir())) if fd_dir.is_dir() else None
        for _ in range(100):
            cycle(True)
            cycle(False)
        gevent.sleep(0.05)
        if baseline_fds is not None:
            final_fds = len(list(fd_dir.iterdir()))
            print(f"FDs: {baseline_fds} -> {final_fds}; 200 reconnects; subscribers: {len(events.EVENT_SUBSCRIBERS)}")
            assert final_fds <= baseline_fds
    finally:
        server.stop(timeout=1)
