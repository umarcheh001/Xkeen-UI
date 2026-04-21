import importlib
import sys
from types import SimpleNamespace
from types import ModuleType

from flask import Flask

from services.capabilities import detect_capabilities
from services.xkeen_commands_catalog import get_full_shell_policy, is_full_shell_enabled


def _import_commands_module():
    sys.modules.pop("routes.commands", None)
    sys.modules.pop("services.command_jobs", None)
    sys.modules.setdefault("pty", ModuleType("pty"))
    return importlib.import_module("routes.commands")


def _make_commands_client():
    commands_module = _import_commands_module()
    app = Flask(__name__)
    app.register_blueprint(commands_module.create_commands_blueprint())
    return app.test_client(), commands_module


def test_full_shell_defaults_to_disabled(monkeypatch):
    monkeypatch.delenv("XKEEN_ALLOW_SHELL", raising=False)

    assert is_full_shell_enabled() is False

    policy = get_full_shell_policy()
    assert policy["enabled"] is False
    assert policy["env"] == "XKEEN_ALLOW_SHELL"
    assert policy["default"] == "0"
    assert policy["requires_restart"] is False
    assert "XKEEN_ALLOW_SHELL=1" in policy["hint"]


def test_run_command_rejects_shell_and_returns_guidance(monkeypatch):
    monkeypatch.delenv("XKEEN_ALLOW_SHELL", raising=False)
    client, _ = _make_commands_client()

    res = client.post("/api/run-command", json={"cmd": "id"})
    data = res.get_json()

    assert res.status_code == 403
    assert data["ok"] is False
    assert data["error"] == "shell_disabled"
    assert "XKEEN_ALLOW_SHELL=1" in data["hint"]
    assert data["shell"]["enabled"] is False
    assert data["shell"]["requires_restart"] is False


def test_shell_opt_in_is_read_dynamically_without_reimport(monkeypatch):
    monkeypatch.delenv("XKEEN_ALLOW_SHELL", raising=False)
    created = []

    def fake_create_command_job(flag, stdin_data, cmd=None, use_pty=False):
        created.append({
            "flag": flag,
            "stdin_data": stdin_data,
            "cmd": cmd,
            "use_pty": use_pty,
        })
        return SimpleNamespace(id="job-1", flag=flag, cmd=cmd, status="running")

    client, commands_module = _make_commands_client()
    monkeypatch.setattr(commands_module, "create_command_job", fake_create_command_job)

    blocked = client.post("/api/run-command", json={"cmd": "echo test"})
    assert blocked.status_code == 403

    monkeypatch.setenv("XKEEN_ALLOW_SHELL", "1")
    allowed = client.post("/api/run-command", json={"cmd": "echo test"})
    data = allowed.get_json()

    assert allowed.status_code == 202
    assert data["ok"] is True
    assert data["cmd"] == "echo test"
    assert created == [{
        "flag": None,
        "stdin_data": None,
        "cmd": "echo test",
        "use_pty": False,
    }]


def test_xkeen_flags_still_work_when_shell_is_disabled(monkeypatch):
    monkeypatch.delenv("XKEEN_ALLOW_SHELL", raising=False)

    def fake_create_command_job(flag, stdin_data, cmd=None, use_pty=False):
        return SimpleNamespace(id="job-flag", flag=flag, cmd=cmd, status="running")

    client, commands_module = _make_commands_client()
    monkeypatch.setattr(commands_module, "create_command_job", fake_create_command_job)

    res = client.post("/api/run-command", json={"flag": "-status"})
    data = res.get_json()

    assert res.status_code == 202
    assert data["ok"] is True
    assert data["flag"] == "-status"


def test_capabilities_expose_terminal_shell_policy(monkeypatch):
    monkeypatch.delenv("XKEEN_ALLOW_SHELL", raising=False)

    caps = detect_capabilities({}, which=lambda _name: None)

    assert caps["terminal"]["shell"]["enabled"] is False
    assert caps["terminal"]["shell"]["default"] == "0"
    assert caps["terminal"]["shell"]["env"] == "XKEEN_ALLOW_SHELL"


def test_terminal_capabilities_disable_pty_when_runtime_lacks_posix_support(monkeypatch):
    from services import capabilities as caps_mod

    monkeypatch.setattr(caps_mod.os, "name", "nt", raising=False)

    state = caps_mod.detect_terminal_state({}, runtime_mode="dev", ws_runtime=True)

    assert state["ws"] is True
    assert state["pty"] is False
    assert state["reason"] is None
