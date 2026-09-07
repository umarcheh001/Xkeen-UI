"""Порт резолвера прошивки может уехать, и сторож это чинит.

Номер порта равен 41100 плюс индекс политики доступа. Пользователь удаляет
политику в веб-интерфейсе прошивки — и адрес, записанный в конфигурации Xray,
указывает в никуда. Тишина при этом полная: зона просто уходит в тоннель.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "xkeen-ui"))

from services import dns_over_vless as dns  # noqa: E402


def test_no_resync_when_the_addresses_still_match(tmp_path: Path, monkeypatch):
    state = tmp_path / "state"
    state.mkdir()
    dns._save_state(str(state), {"enabled": True, "local_resolvers": ["127.0.0.1:41100"]})
    monkeypatch.setattr(dns.firmware_resolvers, "discover", lambda *a, **kw: ["127.0.0.1:41100"])
    called = []
    monkeypatch.setattr(dns, "apply_action", lambda *a, **kw: called.append(kw))

    note = dns.recheck_local_resolvers(
        configs_dir=str(tmp_path), routing_file=str(tmp_path / "05_routing.json"),
        ui_state_dir=str(state), restart_xkeen=lambda *a, **kw: {"ok": True},
    )

    assert note == ""
    assert called == []


def test_resync_when_the_port_is_gone(tmp_path: Path, monkeypatch):
    state = tmp_path / "state"
    state.mkdir()
    dns._save_state(str(state), {"enabled": True, "local_resolvers": ["127.0.0.1:41100"]})
    monkeypatch.setattr(dns.firmware_resolvers, "discover", lambda *a, **kw: ["127.0.0.1:41101"])
    called = []
    monkeypatch.setattr(dns, "apply_action", lambda *a, **kw: called.append(kw) or {"ok": True})

    note = dns.recheck_local_resolvers(
        configs_dir=str(tmp_path), routing_file=str(tmp_path / "05_routing.json"),
        ui_state_dir=str(state), restart_xkeen=lambda *a, **kw: {"ok": True},
    )

    assert "127.0.0.1:41101" in note
    assert called and called[0]["local_resolver"] == ["127.0.0.1:41101"]
    # Штамп времени пережил вызов и лежит в сохранённом состоянии.
    assert dns._load_state(str(state)).get("local_resolvers_synced_at")


def test_resync_happens_at_most_once_an_hour(tmp_path: Path, monkeypatch):
    state = tmp_path / "state"
    state.mkdir()
    dns._save_state(
        str(state),
        {
            "enabled": True,
            "local_resolvers": ["127.0.0.1:41100"],
            "local_resolvers_synced_at": time.time(),
        },
    )
    monkeypatch.setattr(dns.firmware_resolvers, "discover", lambda *a, **kw: ["127.0.0.1:41101"])
    called = []
    monkeypatch.setattr(dns, "apply_action", lambda *a, **kw: called.append(kw))

    note = dns.recheck_local_resolvers(
        configs_dir=str(tmp_path), routing_file=str(tmp_path / "05_routing.json"),
        ui_state_dir=str(state), restart_xkeen=lambda *a, **kw: {"ok": True},
    )

    assert note == ""
    assert called == []


def test_untouched_setting_is_left_alone(tmp_path: Path, monkeypatch):
    # Пользователь локальные зоны не настраивал — навязывать их сторож не должен.
    state = tmp_path / "state"
    state.mkdir()
    dns._save_state(str(state), {"enabled": True, "local_resolvers": []})
    monkeypatch.setattr(dns.firmware_resolvers, "discover", lambda *a, **kw: ["127.0.0.1:41100"])
    called = []
    monkeypatch.setattr(dns, "apply_action", lambda *a, **kw: called.append(kw))

    assert dns.recheck_local_resolvers(
        configs_dir=str(tmp_path), routing_file=str(tmp_path / "05_routing.json"),
        ui_state_dir=str(state), restart_xkeen=lambda *a, **kw: {"ok": True},
    ) == ""
    assert called == []


def test_disabled_feature_is_not_touched(tmp_path: Path, monkeypatch):
    state = tmp_path / "state"
    state.mkdir()
    dns._save_state(str(state), {"enabled": False, "local_resolvers": ["127.0.0.1:41100"]})
    monkeypatch.setattr(dns.firmware_resolvers, "discover", lambda *a, **kw: ["127.0.0.1:41101"])
    called = []
    monkeypatch.setattr(dns, "apply_action", lambda *a, **kw: called.append(kw))

    assert dns.recheck_local_resolvers(
        configs_dir=str(tmp_path), routing_file=str(tmp_path / "05_routing.json"),
        ui_state_dir=str(state), restart_xkeen=lambda *a, **kw: {"ok": True},
    ) == ""
    assert called == []


def test_no_resync_when_discover_comes_back_empty(tmp_path: Path, monkeypatch):
    # Конфигурация прошивки временно нечитаема — не стоит из-за этого
    # отказываться от рабочего адреса, который уже сохранён.
    state = tmp_path / "state"
    state.mkdir()
    dns._save_state(str(state), {"enabled": True, "local_resolvers": ["127.0.0.1:41100"]})
    monkeypatch.setattr(dns.firmware_resolvers, "discover", lambda *a, **kw: [])
    called = []
    monkeypatch.setattr(dns, "apply_action", lambda *a, **kw: called.append(kw))

    note = dns.recheck_local_resolvers(
        configs_dir=str(tmp_path), routing_file=str(tmp_path / "05_routing.json"),
        ui_state_dir=str(state), restart_xkeen=lambda *a, **kw: {"ok": True},
    )

    assert note == ""
    assert called == []


def test_failed_resync_still_stamps_the_timestamp(tmp_path: Path, monkeypatch):
    # Штамп ставится до вызова apply_action: даже если попытка провалилась,
    # сторож не должен пытаться перезапустить ядро на каждом такте.
    state = tmp_path / "state"
    state.mkdir()
    dns._save_state(str(state), {"enabled": True, "local_resolvers": ["127.0.0.1:41100"]})
    monkeypatch.setattr(dns.firmware_resolvers, "discover", lambda *a, **kw: ["127.0.0.1:41101"])

    def _boom(*a, **kw):
        raise RuntimeError("не удалось применить настройку")

    monkeypatch.setattr(dns, "apply_action", _boom)

    with pytest.raises(RuntimeError):
        dns.recheck_local_resolvers(
            configs_dir=str(tmp_path), routing_file=str(tmp_path / "05_routing.json"),
            ui_state_dir=str(state), restart_xkeen=lambda *a, **kw: {"ok": True},
        )

    assert dns._load_state(str(state)).get("local_resolvers_synced_at")
