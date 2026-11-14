import copy
import json

import pytest

from services import xray_handler_service as hot


def _config():
    return {
        "api": {"listen": "127.0.0.1:10085", "services": ["HandlerService"]},
        "outbounds": [
            {"tag": "direct", "protocol": "freedom"},
            {"tag": "sub--node", "protocol": "vless", "settings": {}, "streamSettings": {
                "security": "reality", "realitySettings": {"serverName": "old.example", "shortId": "abcd", "publicKey": "same-key"},
            }},
        ],
    }


def _files(config):
    return {"config.json": json.dumps(config).encode()}


def _rotated(config):
    updated = copy.deepcopy(config)
    updated["outbounds"][1]["streamSettings"]["realitySettings"].update(serverName="new.example", shortId="1234")
    return updated


@pytest.mark.parametrize("unsafe", ["public", "hostname", "missing_api", "missing_service", "route", "address", "public_key", "mux", "tags"])
def test_only_stable_reality_rotation_with_explicit_local_api_is_eligible(unsafe):
    original = _config()
    updated = _rotated(original)
    if unsafe == "public":
        original["api"]["listen"] = updated["api"]["listen"] = "0.0.0.0:10085"
    elif unsafe == "hostname":
        original["api"]["listen"] = updated["api"]["listen"] = "localhost:10085"
    elif unsafe == "missing_api":
        original.pop("api")
        updated.pop("api")
    elif unsafe == "missing_service":
        original["api"]["services"] = updated["api"]["services"] = ["StatsService"]
    elif unsafe == "route":
        updated["routing"] = {"rules": []}
    elif unsafe == "address":
        updated["outbounds"][1]["settings"] = {"address": "different.example"}
    elif unsafe == "public_key":
        updated["outbounds"][1]["streamSettings"]["realitySettings"]["publicKey"] = "changed-key"
    elif unsafe == "mux":
        original["outbounds"][1]["mux"] = updated["outbounds"][1]["mux"] = {"enabled": True}
    else:
        updated["outbounds"][1]["tag"] = "new-tag"

    assert hot._plan(_files(original), _files(updated)) is None


def test_rotation_plan_keeps_tags_and_all_other_fields():
    original = _config()
    plan = hot._plan(_files(original), _files(_rotated(original)))
    assert plan[0] == "127.0.0.1:10085"
    assert plan[3] == ["sub--node"]


def test_fork_config_reader_logs_do_not_hide_the_json_document():
    output = '2026/11/14 [Info] Reading config: &{Name:config.json Format:json}\n{\n"outbound": []\n}\n'
    assert hot._json_output(output) == {"outbound": []}
    with pytest.raises(json.JSONDecodeError):
        hot._json_output(output + "unexpected trailing data")


def _mock_runtime(tmp_path, monkeypatch, *, fail_add=False, fail_rollback=False, drift=False, default="direct"):
    original = _config()
    updated = _rotated(original)
    (tmp_path / "config.json").write_text(json.dumps(updated), encoding="utf-8")
    old = {item["tag"]: item for item in original["outbounds"]}
    new = {item["tag"]: item for item in updated["outbounds"]}
    state = copy.deepcopy(old)
    if drift:
        state["sub--node"]["settings"] = {"external": True}
    monkeypatch.setenv("XKEEN_SUBSCRIPTIONS_HOT_APPLY", "1")
    monkeypatch.setattr(hot.xray_transactions, "xray_binary", lambda: "xray")
    monkeypatch.setattr(hot.xray_transactions, "check_confdir", lambda _: {"ok": True})
    monkeypatch.setattr(hot, "_compiled", lambda _binary, _files, directory: (old if directory.name == "before" else new, "direct" if directory.name == "before" else default))
    monkeypatch.setattr(hot, "_runtime", lambda *_: copy.deepcopy(state))
    calls = []

    def api(_binary, _server, command, *args):
        calls.append(command)
        if command == "rmo":
            state.pop(args[-1], None)
        elif command == "ado":
            if fail_add and (calls.count("ado") == 1 or fail_rollback):
                raise RuntimeError("injected API failure")
            with open(args[0], encoding="utf-8") as stream:
                outbound = json.load(stream)["outbounds"][0]
            state[outbound["tag"]] = outbound

    monkeypatch.setattr(hot, "_api", api)
    return _files(original), state, old, new, calls


def test_api_failure_rolls_back_before_validated_restart(tmp_path, monkeypatch):
    previous, state, old, _new, calls = _mock_runtime(tmp_path, monkeypatch, fail_add=True)
    assert hot.try_apply(str(tmp_path), previous) == {"hot_applied": False, "hot_apply_fallback": True}
    assert state == old
    assert calls == ["rmo", "ado", "rmo", "ado"]


def test_api_rollback_failure_requires_runtime_reconciliation(tmp_path, monkeypatch):
    previous, *_ = _mock_runtime(tmp_path, monkeypatch, fail_add=True, fail_rollback=True)
    with pytest.raises(hot.HotApplyUncertain, match="xray_handler_rollback_failed"):
        hot.try_apply(str(tmp_path), previous)


@pytest.mark.parametrize("reason", ["disabled", "drift", "default", "invalid"])
def test_ineligible_or_unverified_runtime_is_never_mutated(tmp_path, monkeypatch, reason):
    previous, _state, _old, _new, calls = _mock_runtime(tmp_path, monkeypatch, drift=reason == "drift", default="sub--node" if reason == "default" else "direct")
    if reason == "disabled":
        monkeypatch.delenv("XKEEN_SUBSCRIPTIONS_HOT_APPLY", raising=False)
    elif reason == "invalid":
        monkeypatch.setattr(hot.xray_transactions, "check_confdir", lambda _: {"ok": None})
    assert hot.try_apply(str(tmp_path), previous) is None
    assert calls == []


def test_hot_apply_success_matches_the_whole_runtime(tmp_path, monkeypatch):
    previous, state, _old, new, calls = _mock_runtime(tmp_path, monkeypatch)
    assert hot.try_apply(str(tmp_path), previous)["hot_applied"] is True
    assert state == new
    assert calls == ["rmo", "ado"]


def test_uncertain_runtime_forces_recovery_even_if_the_core_is_running(tmp_path, monkeypatch):
    from services import xray_subscriptions as subs

    def uncertain(*_):
        raise hot.HotApplyUncertain("injected")

    monkeypatch.setattr(hot, "try_apply", uncertain)
    monkeypatch.setattr(subs, "_xkeen_runtime_stopped", lambda: False)
    monkeypatch.setattr(subs.xray_transactions, "check_confdir", lambda _: {"ok": True})
    calls = []

    def restart(**kwargs):
        calls.append(kwargs["source"])
        return len(calls) == 2

    result = subs._restart_subscription_update(restart, subs.xray_transactions.MemoryGuard(), str(tmp_path), "batch")
    assert result["recovered"] is True
    assert result["restarted"] is False
    assert calls == ["batch", "xray-subscriptions-recovery"]
