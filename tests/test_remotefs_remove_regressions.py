from __future__ import annotations

from flask import Blueprint, Flask

from routes.remotefs.ops import register_ops_endpoints


class _FakeMgr:
    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = []

    def _run_lftp(self, session, commands, *, capture=True):
        self.calls.append({"session": session, "commands": list(commands), "capture": bool(capture)})
        if not self._responses:
            raise AssertionError("No scripted lftp response left for test")
        return self._responses.pop(0)


def _build_client(responses):
    app = Flask(__name__)
    app.config.update(TESTING=True, SECRET_KEY="test-secret")
    bp = Blueprint("remotefs_test", __name__)
    mgr = _FakeMgr(responses)
    logs = []
    session = object()

    def get_session_or_404(sid: str):
        if sid != "sid-1":
            return None, ({"ok": False, "error": "session_not_found"}, 404)
        return session, None

    def core_log(level: str, msg: str, **extra):
        logs.append({"level": level, "msg": msg, "extra": dict(extra)})

    register_ops_endpoints(
        bp,
        get_session_or_404=get_session_or_404,
        mgr=mgr,
        core_log=core_log,
    )
    app.register_blueprint(bp)
    return app.test_client(), mgr, logs, session


def test_remotefs_remove_non_recursive_uses_rm_success_path():
    client, mgr, logs, session = _build_client(
        [
            (0, b"", b""),
        ]
    )

    response = client.delete("/api/remotefs/sessions/sid-1/remove?path=plain.txt")

    assert response.status_code == 200
    assert response.get_json() == {"ok": True}
    assert mgr.calls == [
        {
            "session": session,
            "commands": ['rm "plain.txt"'],
            "capture": True,
        }
    ]
    assert logs == [
        {
            "level": "info",
            "msg": "remotefs.remove",
            "extra": {"sid": "sid-1", "path": "plain.txt", "recursive": False},
        }
    ]


def test_remotefs_remove_non_recursive_falls_back_to_rmdir():
    client, mgr, logs, session = _build_client(
        [
            (1, b"", b"not a file"),
            (0, b"", b""),
        ]
    )

    response = client.delete("/api/remotefs/sessions/sid-1/remove?path=empty-dir")

    assert response.status_code == 200
    assert response.get_json() == {"ok": True}
    assert mgr.calls == [
        {
            "session": session,
            "commands": ['rm "empty-dir"'],
            "capture": True,
        },
        {
            "session": session,
            "commands": ['rmdir "empty-dir"'],
            "capture": True,
        },
    ]
    assert logs == [
        {
            "level": "info",
            "msg": "remotefs.remove",
            "extra": {"sid": "sid-1", "path": "empty-dir", "recursive": False, "rmdir": True},
        }
    ]


def test_remotefs_remove_non_recursive_returns_error_when_rm_and_rmdir_fail():
    client, mgr, logs, session = _build_client(
        [
            (1, b"", b"rm failed"),
            (1, b"", b"directory not empty"),
        ]
    )

    response = client.delete("/api/remotefs/sessions/sid-1/remove?path=busy-dir")

    assert response.status_code == 400
    assert response.get_json() == {"error": "remove_failed", "ok": False}
    assert mgr.calls == [
        {
            "session": session,
            "commands": ['rm "busy-dir"'],
            "capture": True,
        },
        {
            "session": session,
            "commands": ['rmdir "busy-dir"'],
            "capture": True,
        },
    ]
    assert logs == []


def test_remotefs_remove_recursive_returns_after_recursive_delete():
    client, mgr, logs, session = _build_client(
        [
            (0, b"", b""),
        ]
    )

    response = client.delete("/api/remotefs/sessions/sid-1/remove?path=tree&recursive=1")

    assert response.status_code == 200
    assert response.get_json() == {"ok": True}
    assert mgr.calls == [
        {
            "session": session,
            "commands": ['rm -r "tree"'],
            "capture": True,
        }
    ]
    assert logs == [
        {
            "level": "info",
            "msg": "remotefs.remove",
            "extra": {"sid": "sid-1", "path": "tree", "recursive": True},
        }
    ]
