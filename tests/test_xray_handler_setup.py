import json
import os
from pathlib import Path

import pytest

from services import xray_handler_setup as setup


@pytest.fixture
def context(tmp_path, monkeypatch):
    configs, state, raw = [tmp_path / name for name in ("configs", "state", "jsonc")]
    for directory in (configs, state, raw):
        directory.mkdir()
    (configs / "00_base.json").write_text('{"outbounds":[{"protocol":"freedom","tag":"direct"}]}', encoding="utf-8")
    monkeypatch.setenv(setup.KEY, "0")
    monkeypatch.setenv("XKEEN_UI_ENV_FILE", str(state / "devtools.env"))
    monkeypatch.setattr(setup, "jsonc_path_for", lambda path: str(raw / (Path(path).name + "c")))
    monkeypatch.setattr(setup, "detect_xkeen_runtime_core", lambda: "xray")
    monkeypatch.setattr(setup.xray_transactions, "xray_binary", lambda: "xray")
    monkeypatch.setattr(setup.xray_transactions, "check_staged", lambda *_: {"ok": True})
    monkeypatch.setattr(setup.xray_transactions, "check_confdir", lambda *_: {"ok": True})
    expected = {"direct": {"tag": "direct"}}
    monkeypatch.setattr(setup.hot, "_compiled", lambda *_: (expected, "direct"))
    monkeypatch.setattr(setup.hot, "_runtime", lambda *_: expected)
    calls = []

    def restart(**kwargs):
        calls.append(kwargs["source"])
        return True

    return str(configs), str(state), raw, calls, restart


def test_one_click_setup_and_disable_preserve_other_configs(context):
    configs, state, raw, calls, restart = context
    original = (Path(configs) / "00_base.json").read_bytes()
    result = setup.configure(configs, state, True, restart)
    api_path = Path(configs) / "99_xkeen_subscription_api.json"
    configured = api_path.read_bytes()
    api = json.loads(configured)["api"]
    assert result["enabled"] and result["ready"] and result["restarted"]
    assert setup.hot.loopback_server(api["listen"])
    assert api["services"] == ["HandlerService"]
    assert (Path(configs) / "00_base.json").read_bytes() == original
    assert calls == ["xray-handler-setup"]
    assert os.environ[setup.KEY] == "1"
    assert setup.KEY in (Path(state) / "devtools.env").read_text()
    result = setup.configure(configs, state, False, restart)
    assert not result["enabled"] and not result["restarted"]
    assert api_path.read_bytes() == configured
    assert len(calls) == 1
    assert os.environ[setup.KEY] == "0"


def test_existing_api_keeps_services_fields_and_comments(context):
    configs, state, raw, calls, restart = context
    path = Path(configs) / "00_base.json"
    obj = json.loads(path.read_text())
    obj["api"] = {"tag": "stats-api", "listen": "127.0.0.1:10085", "services": ["StatsService"]}
    path.write_text(json.dumps(obj), encoding="utf-8")
    (raw / "00_base.jsonc").write_text('// Keep my API comment\n' + json.dumps(obj), encoding="utf-8")
    snapshots = []
    setup.configure(configs, state, True, restart, snapshot=snapshots.append)
    api = json.loads(path.read_text())["api"]
    assert api == {"tag": "stats-api", "listen": "127.0.0.1:10085", "services": ["StatsService", "HandlerService"]}
    assert "Keep my API comment" in (raw / "00_base.jsonc").read_text()
    assert set(snapshots) == {str(path), str(raw / "00_base.jsonc")}
    assert calls == ["xray-handler-setup"]
    result = setup.configure(configs, state, True, restart)
    assert not result["restarted"] and len(calls) == 1


def test_failed_disable_restores_persisted_and_running_setting(context, monkeypatch):
    configs, state, _raw, calls, restart = context
    setup.env.set_env(state, {setup.KEY: "1"})
    path = Path(state) / "devtools.env"
    previous = path.read_bytes()

    def fail_after_write(*_args, **_kwargs):
        path.write_text(f"{setup.KEY}=0\n")
        os.environ[setup.KEY] = "0"
        raise OSError("injected failure after write")

    monkeypatch.setattr(setup.env, "set_env", fail_after_write)
    with pytest.raises(ValueError):
        setup.configure(configs, state, False, restart)
    assert path.read_bytes() == previous and os.environ[setup.KEY] == "1"
    assert not calls


@pytest.mark.parametrize("failure", ["public_api", "legacy_api", "invalid", "unknown", "other_core", "multiple_api"])
def test_setup_declines_unsafe_or_unverified_configs_without_writing(context, monkeypatch, failure):
    configs, state, raw, calls, restart = context
    path = Path(configs) / "api.json"
    if failure == "public_api":
        path.write_text('{"api":{"listen":"0.0.0.0:10085"}}')
    elif failure == "legacy_api":
        path.write_text('{"api":{"tag":"stats-api","services":["StatsService"]}}')
    elif failure == "multiple_api":
        path.write_text('{"api":{}}')
        (Path(configs) / "second-api.json").write_text('{"api":{}}')
    elif failure == "other_core":
        monkeypatch.setattr(setup, "detect_xkeen_runtime_core", lambda: "mihomo")
    else:
        monkeypatch.setattr(setup.xray_transactions, "check_staged", lambda *_: {"ok": False if failure == "invalid" else None})
    before = {p.name: p.read_bytes() for p in Path(configs).iterdir()}
    with pytest.raises(ValueError):
        setup.configure(configs, state, True, restart)
    assert {p.name: p.read_bytes() for p in Path(configs).iterdir()} == before
    assert not calls and not list(raw.iterdir())
    assert os.environ[setup.KEY] == "0"


@pytest.mark.parametrize("failure", ["restart", "verification", "env_write"])
def test_setup_failure_restores_files_environment_and_old_runtime(context, monkeypatch, failure):
    from services import xray_subscriptions as subs

    configs, state, raw, calls, restart = context
    before = (Path(configs) / "00_base.json").read_bytes()
    monkeypatch.setattr(subs, "_xkeen_runtime_stopped", lambda: True)
    if failure == "restart":
        def restart(**kwargs):
            calls.append(kwargs["source"])
            return len(calls) > 1
    elif failure == "verification":
        monkeypatch.setattr(setup.hot, "_runtime", lambda *_: {"wrong": {}})
    else:
        def fail_write(*_args, **_kwargs):
            os.environ[setup.KEY] = "1"
            raise OSError("injected write error")
        monkeypatch.setattr(setup.env, "set_env", fail_write)
    with pytest.raises(ValueError):
        setup.configure(configs, state, True, restart)
    assert (Path(configs) / "00_base.json").read_bytes() == before
    assert not (Path(configs) / "99_xkeen_subscription_api.json").exists()
    assert not list(raw.iterdir())
    assert os.environ[setup.KEY] == "0"
    assert len(calls) == 2


def test_hot_apply_route_requires_an_explicit_boolean(context, monkeypatch):
    from flask import Flask
    from routes.xray_subscriptions import create_xray_subscriptions_blueprint

    configs, state, _raw, _calls, restart = context
    app = Flask(__name__)
    app.register_blueprint(create_xray_subscriptions_blueprint(
        ui_state_dir=state, xray_configs_dir=configs, restart_xkeen=restart,
        snapshot_xray_config_before_overwrite=lambda _: None,
    ))
    client = app.test_client()
    assert client.get('/api/xray/subscriptions/hot-apply').get_json()["enabled"] is False
    for payload in ({}, {"enabled": "false"}, [], None):
        assert client.post('/api/xray/subscriptions/hot-apply', json=payload).status_code == 400
    response = client.post('/api/xray/subscriptions/hot-apply', json={"enabled": True})
    assert response.status_code == 200 and response.get_json()["ready"] is True
