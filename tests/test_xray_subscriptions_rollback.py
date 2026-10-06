"""Подписка не оставляет на диске конфиг, который отклонило ядро."""

from __future__ import annotations

from pathlib import Path

import pytest

from tests.test_xray_subscriptions_pause import Bench


@pytest.fixture
def bench(tmp_path: Path, monkeypatch) -> Bench:
    return Bench(tmp_path, monkeypatch)


OWN_FILES = ("04_outbounds.json", "05_routing.json", "07_observatory.json")


def _own_bytes(bench: Bench) -> dict:
    return {name: (bench.xray / name).read_bytes() for name in OWN_FILES}


def _config_names(bench: Bench) -> list:
    return sorted(path.name for path in bench.xray.iterdir() if path.is_file())


def _save_only(bench: Bench, sub_id: str) -> None:
    bench.subs.upsert_subscription(
        str(bench.state), {"id": sub_id, "tag": sub_id, "url": f"https://example.com/{sub_id}"}
    )


def _refresh(bench: Bench, sub_id: str, restarts: list | None = None):
    calls = restarts if restarts is not None else []
    return bench.subs.refresh_subscription(
        str(bench.state),
        sub_id,
        xray_configs_dir=str(bench.xray),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **kwargs: calls.append(kwargs.get("source")) or True,
    )


def _delete(bench: Bench, sub_id: str, restarts: list | None = None):
    calls = restarts if restarts is not None else []
    return bench.subs.delete_subscription(
        str(bench.state),
        sub_id,
        xray_configs_dir=str(bench.xray),
        snapshot=lambda _path: None,
        restart_xkeen=lambda **kwargs: calls.append(kwargs.get("source")) or True,
    )


def _stored(bench: Bench, sub_id: str) -> dict:
    return next(item for item in bench.subs.list_subscriptions(str(bench.state)) if item["id"] == sub_id)


def _core(bench: Bench, monkeypatch, verdict):
    """Подменить ответ ядра; ``verdict`` — значение или функция от каталога."""
    calls: list = []

    def check(xray_configs_dir):
        calls.append(sorted(path.name for path in Path(xray_configs_dir).iterdir() if path.is_file()))
        ok = verdict(Path(xray_configs_dir)) if callable(verdict) else verdict
        return {"ok": ok, "reason": "rejected" if ok is False else "", "details": "failed to build outbound handler"}

    monkeypatch.setattr(bench.subs, "_check_live_config", check)
    return calls


def test_download_the_core_rejects_leaves_everything_as_it_was(bench: Bench, monkeypatch):
    _save_only(bench, "alpha")
    before = _own_bytes(bench)
    names = _config_names(bench)
    # Ядру не нравится именно новый фрагмент: без него конфиг годен.
    _core(bench, monkeypatch, lambda directory: not (directory / "04_outbounds.alpha.json").exists())
    restarts: list = []

    result = _refresh(bench, "alpha", restarts)

    assert result["ok"] is False
    assert "Xray отклонил" in result["error"]
    assert "failed to build outbound handler" in result["error"]
    assert restarts == []
    assert _own_bytes(bench) == before
    assert _config_names(bench) == names
    assert list(bench.jsonc.iterdir()) == []
    stored = _stored(bench, "alpha")
    assert stored["last_ok"] is False
    assert "Xray отклонил" in stored["last_error"]


def test_download_the_core_accepts_goes_through_and_restarts(bench: Bench, monkeypatch):
    _save_only(bench, "alpha")
    calls = _core(bench, monkeypatch, True)
    restarts: list = []

    result = _refresh(bench, "alpha", restarts)

    assert result["ok"] is True
    assert (bench.xray / "04_outbounds.alpha.json").exists()
    assert restarts == ["xray-subscription-refresh"]
    assert len(calls) == 1
    assert "04_outbounds.alpha.json" in calls[0]


def test_a_core_that_could_not_be_asked_does_not_undo_the_download(bench: Bench, monkeypatch):
    _save_only(bench, "alpha")
    _core(bench, monkeypatch, None)

    result = _refresh(bench, "alpha")

    assert result["ok"] is True
    assert (bench.xray / "04_outbounds.alpha.json").exists()


def test_a_config_already_broken_before_the_download_is_not_blamed_on_it(bench: Bench, monkeypatch):
    _save_only(bench, "alpha")
    calls = _core(bench, monkeypatch, False)

    result = _refresh(bench, "alpha")

    assert result["ok"] is True
    assert (bench.xray / "04_outbounds.alpha.json").exists()
    assert any("отклонял" in warning for warning in result["warnings"])
    # Второй вопрос ядру — про каталог, каким он был до операции.
    assert len(calls) == 2
    assert "04_outbounds.alpha.json" not in calls[1]


def test_a_failure_halfway_through_rolls_the_fragment_back(bench: Bench, monkeypatch):
    _save_only(bench, "alpha")
    before = _own_bytes(bench)
    names = _config_names(bench)

    def boom(*_args, **_kwargs):
        raise RuntimeError("routing is not writable")

    monkeypatch.setattr(bench.subs, "_rebuild_subscription_runtime", boom)

    result = _refresh(bench, "alpha")

    assert result["ok"] is False
    assert "routing is not writable" in result["error"]
    assert _config_names(bench) == names
    assert _own_bytes(bench) == before


def test_a_download_that_changes_nothing_does_not_bother_the_core(bench: Bench, monkeypatch):
    bench.add("alpha")
    # Маршрутизация доходит до устойчивого вида за второй проход: первый после
    # добавления ещё переставляет её, это старое поведение.
    _refresh(bench, "alpha")
    calls = _core(bench, monkeypatch, True)

    result = _refresh(bench, "alpha")

    assert result["ok"] is True
    assert result["changed"] is False
    assert calls == []


def test_delete_the_core_rejects_is_undone_and_reported(bench: Bench, monkeypatch):
    bench.add("alpha")
    before = _own_bytes(bench)
    names = _config_names(bench)
    fragment = (bench.xray / "04_outbounds.alpha.json").read_bytes()
    # Конфиг годен только с фрагментом подписки.
    _core(bench, monkeypatch, lambda directory: (directory / "04_outbounds.alpha.json").exists())
    restarts: list = []

    with pytest.raises(bench.subs.SubscriptionConfigRejected) as excinfo:
        _delete(bench, "alpha", restarts)

    assert "Xray отклонил" in str(excinfo.value)
    assert restarts == []
    assert _config_names(bench) == names
    assert _own_bytes(bench) == before
    assert (bench.xray / "04_outbounds.alpha.json").read_bytes() == fragment
    assert _stored(bench, "alpha")["id"] == "alpha"


def test_delete_goes_through_when_the_config_was_broken_anyway(bench: Bench, monkeypatch):
    bench.add("alpha")
    _core(bench, monkeypatch, False)

    result = _delete(bench, "alpha")

    assert result["deleted"]["id"] == "alpha"
    assert not (bench.xray / "04_outbounds.alpha.json").exists()
    assert bench.subs.list_subscriptions(str(bench.state)) == []
    assert "отклонял" in result["warning"]


def test_the_check_can_be_switched_off(bench: Bench, monkeypatch):
    from services import xray_transactions

    def unexpected(*_args, **_kwargs):
        raise AssertionError("ядро спрашивать не должны")

    monkeypatch.setattr(xray_transactions, "check_confdir", unexpected)
    monkeypatch.setenv("XKEEN_SUBSCRIPTIONS_PREFLIGHT", "0")

    assert bench.subs._check_live_config(str(bench.xray))["ok"] is None


def test_pause_the_core_rejects_is_undone_without_a_restart(tmp_path: Path, monkeypatch):
    from tests.test_subscription_pause_dns import Rig

    rig = Rig(tmp_path, monkeypatch)
    rig.bench.add("alpha")
    before = _own_bytes(rig.bench)
    names = _config_names(rig.bench)
    # Конфиг годен только пока фрагмент подписки на месте.
    _core(rig.bench, monkeypatch, lambda directory: (directory / "04_outbounds.alpha.json").exists())

    with pytest.raises(rig.pause_mod.PauseError) as excinfo:
        rig.pause()

    assert excinfo.value.code == "xray_config_rejected"
    assert "Xray отклонил" in str(excinfo.value)
    assert rig.restarts == []
    assert _config_names(rig.bench) == names
    assert _own_bytes(rig.bench) == before
    assert rig.bench.sub("alpha")["paused"] is False


def test_resume_the_core_rejects_keeps_the_pause(tmp_path: Path, monkeypatch):
    from tests.test_subscription_pause_dns import Rig

    rig = Rig(tmp_path, monkeypatch)
    rig.bench.add("alpha")
    rig.pause()
    rig.restarts.clear()
    names = _config_names(rig.bench)
    _core(rig.bench, monkeypatch, lambda directory: not (directory / "04_outbounds.alpha.json").exists())

    with pytest.raises(rig.pause_mod.PauseError) as excinfo:
        rig.resume()

    assert excinfo.value.code == "xray_config_rejected"
    assert rig.restarts == []
    assert _config_names(rig.bench) == names
    assert rig.bench.sub("alpha")["paused"] is True
