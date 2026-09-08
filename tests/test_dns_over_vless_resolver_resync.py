"""Порт резолвера прошивки может уехать, и сторож это чинит.

Номер порта равен 41100 плюс индекс политики доступа. Пользователь удаляет
политику в веб-интерфейсе прошивки — и адрес, записанный в конфигурации Xray,
указывает в никуда. Тишина при этом полная: зона просто уходит в тоннель.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "xkeen-ui"))

from services import dns_over_vless as dns  # noqa: E402


def _write(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _base_config(tmp_path: Path) -> tuple[Path, Path, Path]:
    """A minimal routable install: one balancer, one direct outbound."""
    configs = tmp_path / "configs"
    state = tmp_path / "state"
    configs.mkdir()
    state.mkdir()
    _write(
        configs / "04_outbounds.json",
        {
            "outbounds": [
                {"tag": "direct", "protocol": "freedom"},
                {"tag": "proxy-a", "protocol": "vless"},
                {"tag": "proxy-b", "protocol": "vless"},
            ]
        },
    )
    routing = configs / "05_routing.json"
    _write(
        routing,
        {
            "routing": {
                "rules": [{"type": "field", "outboundTag": "direct", "network": "tcp,udp"}],
                "balancers": [
                    {
                        "tag": "proxy",
                        "selector": ["proxy-a", "proxy-b"],
                        "strategy": {"type": "leastPing"},
                        "fallbackTag": "direct",
                    }
                ],
            }
        },
    )
    return configs, routing, state


def _patch_apply_action_plumbing(monkeypatch) -> None:
    """Everything ``apply_action`` needs beyond the filesystem to run for real."""
    monkeypatch.setattr(dns, "detect_running_core", lambda: "xray")
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (False, "test"))
    monkeypatch.setattr(dns, "_stage_and_test", lambda *_a, **_k: {"ok": True})
    monkeypatch.setattr(dns, "_wait_for_xray", lambda *_a, **_k: True)
    monkeypatch.setattr(dns, "_wait_for_port_53", lambda *_a, **_k: True)
    monkeypatch.setattr(dns, "_dns_probe", lambda *_a, **_k: {"ok": True, "answers": 1})
    monkeypatch.setattr(dns, "_set_dns_override", lambda enabled: None)
    monkeypatch.setattr(
        dns, "_write_routing_preserving_comments", lambda path, obj, **_k: _write(Path(path), obj)
    )


def test_no_resync_when_the_addresses_still_match(tmp_path: Path, monkeypatch):
    state = tmp_path / "state"
    state.mkdir()
    dns._save_state(str(state), {"enabled": True, "local_resolvers": ["127.0.0.1:41100"]})
    # Сторож спрашивает записанный адрес о живости; здесь речь не о ней, а
    # о совпадении адресов — без подмены проба ушла бы в сеть машины с тестами.
    monkeypatch.setattr(dns, "_resolver_answers", lambda *_a, **_k: True)
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
    # apply_action не подменяется лямбдой: только настоящий вызов пишет
    # "enable" своим собственным словарём состояния и может стереть штамп,
    # который recheck_local_resolvers поставил до вызова.
    configs, routing_path, state = _base_config(tmp_path)
    _patch_apply_action_plumbing(monkeypatch)
    # Включение само находит резолвер прошивки — с него и начинается снимок,
    # с которым сторож потом сверяет найденное.
    monkeypatch.setattr(dns.firmware_resolvers, "discover", lambda *a, **kw: ["127.0.0.1:41100"])

    dns.apply_action(
        "enable",
        configs_dir=str(configs),
        routing_file=str(routing_path),
        ui_state_dir=str(state),
        restart_xkeen=lambda **_k: True,
        target_tag="proxy",
    )

    monkeypatch.setattr(dns.firmware_resolvers, "discover", lambda *a, **kw: ["127.0.0.1:41101"])

    note = dns.recheck_local_resolvers(
        configs_dir=str(configs), routing_file=str(routing_path),
        ui_state_dir=str(state), restart_xkeen=lambda **_k: True,
    )

    assert "127.0.0.1:41101" in note
    saved = dns._load_state(str(state))
    assert saved.get("firmware_resolvers_applied") == ["127.0.0.1:41101"]
    # Штамп времени пережил настоящий вызов apply_action, а не только лямбду.
    assert saved.get("local_resolvers_synced_at")


def test_addresses_the_user_chose_themselves_are_left_alone(tmp_path: Path, monkeypatch):
    # Pi-hole, AdGuard или домашний сервер — не резолвер прошивки, сторожу
    # трогать эту запись нельзя, даже если она "устарела" по сравнению с
    # найденными портами.
    state = tmp_path / "state"
    state.mkdir()
    dns._save_state(str(state), {"enabled": True, "local_resolvers": ["192.168.10.5:53"]})
    monkeypatch.setattr(dns.firmware_resolvers, "discover", lambda *a, **kw: ["127.0.0.1:41100"])
    called = []
    monkeypatch.setattr(dns, "apply_action", lambda *a, **kw: called.append(kw))

    note = dns.recheck_local_resolvers(
        configs_dir=str(tmp_path), routing_file=str(tmp_path / "05_routing.json"),
        ui_state_dir=str(state), restart_xkeen=lambda *a, **kw: {"ok": True},
    )

    assert note == ""
    assert called == []


def test_mixed_set_keeps_the_users_address_and_swaps_the_firmware_one(tmp_path: Path, monkeypatch):
    # Смешанный набор: один адрес пользователь вписал сам, другой — то, что
    # когда-то нашёл сторож. Устарел только второй, первый трогать нельзя.
    state = tmp_path / "state"
    state.mkdir()
    dns._save_state(
        str(state),
        {"enabled": True, "local_resolvers": ["192.168.10.5:53", "127.0.0.1:41100"]},
    )
    monkeypatch.setattr(dns.firmware_resolvers, "discover", lambda *a, **kw: ["127.0.0.1:41101"])
    called = []
    monkeypatch.setattr(dns, "apply_action", lambda *a, **kw: called.append(kw) or {"ok": True})

    note = dns.recheck_local_resolvers(
        configs_dir=str(tmp_path), routing_file=str(tmp_path / "05_routing.json"),
        ui_state_dir=str(state), restart_xkeen=lambda *a, **kw: {"ok": True},
    )

    assert "127.0.0.1:41101" in note
    # Свой адрес сторож не пересылает: ``apply_action`` возьмёт его из
    # состояния сам и не тронет — сторожу принадлежит только половина прошивки.
    assert called and called[0]["use_firmware_resolver"] is True
    assert "local_resolver" not in called[0]


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


def test_a_stamp_from_the_future_does_not_mute_the_resync_forever(tmp_path: Path, monkeypatch):
    # Keenetic грузится без часов реального времени: штамп может оказаться
    # "в будущем" относительно временно неверных часов роутера. Без защиты
    # (now - last) уходит в минус, разница меньше часа навсегда, и резолвер
    # прошивки остаётся молчаливо устаревшим до перезапуска панели.
    state = tmp_path / "state"
    state.mkdir()
    dns._save_state(
        str(state),
        {
            "enabled": True,
            "local_resolvers": ["127.0.0.1:41100"],
            "local_resolvers_synced_at": time.time() + 7200.0,
        },
    )
    monkeypatch.setattr(dns.firmware_resolvers, "discover", lambda *a, **kw: ["127.0.0.1:41101"])
    called = []
    monkeypatch.setattr(dns, "apply_action", lambda *a, **kw: called.append(kw) or {"ok": True})

    note = dns.recheck_local_resolvers(
        configs_dir=str(tmp_path), routing_file=str(tmp_path / "05_routing.json"),
        ui_state_dir=str(state), restart_xkeen=lambda *a, **kw: {"ok": True},
    )

    assert "127.0.0.1:41101" in note
    assert called and called[0]["use_firmware_resolver"] is True


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
