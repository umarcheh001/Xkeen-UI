"""Резолвер прошивки — отдельная настройка, а не адрес в пользовательском поле.

Домашние имена ломаются молча: если локальный резолвер не указан, `router.lan`
и обратные зоны уходят в тоннель к зарубежным серверам и возвращают NXDOMAIN.
Осознанно этого почти никто не хочет, поэтому резолвер прошивки панель держит
сама — отдельной настройкой, включённой по умолчанию, — а поле остаётся под
собственные резолверы человека: контроллер домена, Pi-hole, DNS сегмента.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "xkeen-ui"))

from services import dns_over_vless as dns  # noqa: E402


def _write(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _scenario(tmp_path: Path) -> tuple[Path, Path, Path]:
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
                        "tag": "balancer_main",
                        "selector": ["proxy-a", "proxy-b"],
                        "strategy": {"type": "leastPing"},
                        "fallbackTag": "direct",
                    }
                ],
            }
        },
    )
    return configs, routing, state


def _patch_plumbing(monkeypatch, found: list[str]) -> None:
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
    monkeypatch.setattr(dns.firmware_resolvers, "discover", lambda *a, **kw: list(found))


def _enable(configs: Path, routing: Path, state: Path, **kwargs):
    return dns.apply_action(
        "enable",
        configs_dir=str(configs),
        routing_file=str(routing),
        ui_state_dir=str(state),
        restart_xkeen=lambda **_k: True,
        target_tag="balancer_main",
        **kwargs,
    )


def test_firmware_resolver_is_on_by_default_and_stays_out_of_the_user_field(
    tmp_path: Path, monkeypatch
):
    """Первое включение: прошивка отвечает на домашние имена, поле пустое.

    Адрес прошивки — не пользовательский выбор, и в поле «свои локальные DNS»
    ему не место: человек его туда не писал и не должен считать своим.
    """
    configs, routing, state = _scenario(tmp_path)
    _patch_plumbing(monkeypatch, ["127.0.0.1:41100"])

    _enable(configs, routing, state)

    saved = dns._load_state(str(state))
    assert saved["use_firmware_resolver"] is True
    assert saved["local_resolvers"] == []

    fragment = json.loads((configs / dns.MANAGED_FRAGMENT).read_text(encoding="utf-8"))
    home = fragment["dns"]["servers"][0]
    assert home["address"] == "127.0.0.1"
    assert home["port"] == 41100
    assert home["domains"] == dns.DEFAULT_LOCAL_DOMAINS


def test_saying_no_leaves_the_home_zones_without_a_local_server(tmp_path: Path, monkeypatch):
    """Отказ — снятая галочка, а не стёртое поле: он записан и виден."""
    configs, routing, state = _scenario(tmp_path)
    _patch_plumbing(monkeypatch, ["127.0.0.1:41100"])

    _enable(configs, routing, state, use_firmware_resolver=False)

    saved = dns._load_state(str(state))
    assert saved["use_firmware_resolver"] is False
    assert saved["local_resolvers"] == []
    assert saved["firmware_resolvers_applied"] == []

    fragment = json.loads((configs / dns.MANAGED_FRAGMENT).read_text(encoding="utf-8"))
    assert all(
        server.get("address") != "127.0.0.1"
        for server in fragment["dns"]["servers"]
        if isinstance(server, dict)
    )


def test_own_resolver_rides_alongside_the_firmware_one(tmp_path: Path, monkeypatch):
    """Контроллер домена не вытесняет прошивку и не смешивается с ней в поле."""
    configs, routing, state = _scenario(tmp_path)
    _patch_plumbing(monkeypatch, ["127.0.0.1:41100"])

    _enable(configs, routing, state, local_resolver="192.168.10.5")

    saved = dns._load_state(str(state))
    assert saved["use_firmware_resolver"] is True
    assert saved["local_resolvers"] == ["192.168.10.5:53"]
    assert saved["firmware_resolvers_applied"] == ["127.0.0.1:41100"]

    fragment = json.loads((configs / dns.MANAGED_FRAGMENT).read_text(encoding="utf-8"))
    homes = [s for s in fragment["dns"]["servers"] if isinstance(s, dict) and s.get("domains")]
    assert [s["address"] for s in homes[:2]] == ["192.168.10.5", "127.0.0.1"]


def test_the_refusal_survives_switching_the_feature_off_and_on(tmp_path: Path, monkeypatch):
    """Выключение и включение не переигрывает записанное решение человека."""
    configs, routing, state = _scenario(tmp_path)
    _patch_plumbing(monkeypatch, ["127.0.0.1:41100"])

    _enable(configs, routing, state, use_firmware_resolver=False)
    dns.apply_action(
        "disable",
        configs_dir=str(configs),
        routing_file=str(routing),
        ui_state_dir=str(state),
        restart_xkeen=lambda **_k: True,
    )
    _enable(configs, routing, state)

    saved = dns._load_state(str(state))
    assert saved["use_firmware_resolver"] is False
    assert saved["firmware_resolvers_applied"] == []


def test_old_mixed_list_splits_into_the_setting_and_the_field(tmp_path: Path, monkeypatch):
    """Переход на третью версию: адрес прошивки уходит из поля в настройку."""
    configs, routing, state = _scenario(tmp_path)
    _write(
        state / dns.STATE_FILENAME,
        {
            "version": 2,
            "enabled": False,
            "local_resolvers": ["192.168.10.5:53", "127.0.0.1:41100"],
        },
    )
    _patch_plumbing(monkeypatch, ["127.0.0.1:41101"])

    _enable(configs, routing, state)

    saved = dns._load_state(str(state))
    assert saved["use_firmware_resolver"] is True
    # Свой резолвер остался пользовательским, адрес прошивки взят заново —
    # порт мог уехать, пока функция была выключена.
    assert saved["local_resolvers"] == ["192.168.10.5:53"]
    assert saved["firmware_resolvers_applied"] == ["127.0.0.1:41101"]


def test_an_old_empty_list_gets_the_firmware_resolver_once(tmp_path: Path, monkeypatch):
    """Пустое поле во второй версии — не решение, а непонятный интерфейс.

    Отказ там записывался стиранием адреса, происхождения которого человек не
    понимал, и по окну нельзя было проверить, работают ли домашние имена.
    Такой отказ переигрываем один раз — дальше выбор делается галочкой.
    """
    configs, routing, state = _scenario(tmp_path)
    _write(state / dns.STATE_FILENAME, {"version": 2, "enabled": False, "local_resolvers": []})
    _patch_plumbing(monkeypatch, ["127.0.0.1:41100"])

    _enable(configs, routing, state)

    saved = dns._load_state(str(state))
    assert saved["use_firmware_resolver"] is True
    assert saved["firmware_resolvers_applied"] == ["127.0.0.1:41100"]


def test_a_third_version_refusal_is_never_replayed(tmp_path: Path, monkeypatch):
    """Отказ, сделанный галочкой, переходом уже не отменяется."""
    configs, routing, state = _scenario(tmp_path)
    _write(
        state / dns.STATE_FILENAME,
        {
            "version": 3,
            "enabled": False,
            "use_firmware_resolver": False,
            "local_resolvers": ["192.168.10.5:53"],
        },
    )
    _patch_plumbing(monkeypatch, ["127.0.0.1:41100"])

    _enable(configs, routing, state)

    saved = dns._load_state(str(state))
    assert saved["use_firmware_resolver"] is False
    assert saved["local_resolvers"] == ["192.168.10.5:53"]
    assert saved["firmware_resolvers_applied"] == []


def test_the_guard_repairs_the_firmware_address_without_touching_the_field(
    tmp_path: Path, monkeypatch
):
    """Порт уехал вместе с политикой доступа — сторож берёт новый.

    Чинить он вправе только то, что записал сам: своё поле человека остаётся
    как есть, а решение о прошивке живёт в настройке, не в списке адресов.
    """
    configs, routing, state = _scenario(tmp_path)
    _patch_plumbing(monkeypatch, ["127.0.0.1:41100"])
    _enable(configs, routing, state, local_resolver="192.168.10.5")

    monkeypatch.setattr(dns.firmware_resolvers, "discover", lambda *a, **kw: ["127.0.0.1:41102"])
    message = dns.recheck_local_resolvers(
        configs_dir=str(configs),
        routing_file=str(routing),
        ui_state_dir=str(state),
        restart_xkeen=lambda **_k: True,
    )

    assert "127.0.0.1:41102" in message
    saved = dns._load_state(str(state))
    assert saved["local_resolvers"] == ["192.168.10.5:53"]
    assert saved["firmware_resolvers_applied"] == ["127.0.0.1:41102"]


def test_the_guard_leaves_an_install_that_said_no_alone(tmp_path: Path, monkeypatch):
    """Снятая галочка — не поломка: чинить там нечего."""
    configs, routing, state = _scenario(tmp_path)
    _patch_plumbing(monkeypatch, ["127.0.0.1:41100"])
    _enable(configs, routing, state, use_firmware_resolver=False, local_resolver="192.168.10.5")

    monkeypatch.setattr(dns.firmware_resolvers, "discover", lambda *a, **kw: ["127.0.0.1:41102"])
    message = dns.recheck_local_resolvers(
        configs_dir=str(configs),
        routing_file=str(routing),
        ui_state_dir=str(state),
        restart_xkeen=lambda **_k: True,
    )

    assert message == ""
    saved = dns._load_state(str(state))
    assert saved["firmware_resolvers_applied"] == []


def _status(configs: Path, routing: Path, state: Path, monkeypatch, found: list[str]) -> dict:
    monkeypatch.setattr(dns, "detect_running_core", lambda: "xray")
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (False, "test"))
    monkeypatch.setattr(dns.firmware_resolvers, "discover", lambda *a, **kw: list(found))
    return dns.get_status(
        configs_dir=str(configs), routing_file=str(routing), ui_state_dir=str(state)
    )


def test_the_window_is_told_about_the_setting_and_the_field_separately(
    tmp_path: Path, monkeypatch
):
    """Окну нужны обе половины: решение о прошивке и собственные адреса."""
    configs, routing, state = _scenario(tmp_path)
    _write(
        state / dns.STATE_FILENAME,
        {
            "version": 3,
            "enabled": True,
            "use_firmware_resolver": True,
            "local_resolvers": ["192.168.10.5:53"],
            "firmware_resolvers_applied": ["127.0.0.1:41100"],
        },
    )

    result = _status(configs, routing, state, monkeypatch, ["127.0.0.1:41100"])

    assert result["use_firmware_resolver"] is True
    assert result["local_resolvers"] == ["192.168.10.5:53"]
    assert result["firmware_resolvers_applied"] == ["127.0.0.1:41100"]


def test_a_never_configured_install_is_offered_the_firmware_resolver(tmp_path: Path, monkeypatch):
    """Окно открыто впервые: галочка стоит, поле пустое."""
    configs, routing, state = _scenario(tmp_path)

    result = _status(configs, routing, state, monkeypatch, ["127.0.0.1:41100"])

    assert result["use_firmware_resolver"] is True
    assert result["local_resolvers"] == []


def test_an_old_state_shows_the_firmware_address_as_the_setting_not_the_field(
    tmp_path: Path, monkeypatch
):
    """До перехода окно не должно показывать адрес прошивки как свой."""
    configs, routing, state = _scenario(tmp_path)
    _write(
        state / dns.STATE_FILENAME,
        {
            "version": 2,
            "enabled": True,
            "local_resolvers": ["192.168.10.5:53", "127.0.0.1:41100"],
        },
    )

    result = _status(configs, routing, state, monkeypatch, ["127.0.0.1:41100"])

    assert result["use_firmware_resolver"] is True
    assert result["local_resolvers"] == ["192.168.10.5:53"]
    assert result["firmware_resolvers_applied"] == ["127.0.0.1:41100"]


def test_the_firmware_resolver_steps_aside_for_an_address_the_user_claimed(
    tmp_path: Path, monkeypatch
):
    """Группы различаются по адресу, и петля может быть занята человеком.

    AdGuard Home на самом роутере живёт на `127.0.0.1` — тот же адрес, что и
    резолвер прошивки. Панель добавляет прошивку сама, поэтому упереться в
    «адрес указан в обеих группах» человек мог бы, ничего не меняя: включение
    просто перестало бы работать. Автоматика уступает явной настройке.
    """
    configs, routing, state = _scenario(tmp_path)
    _patch_plumbing(monkeypatch, ["127.0.0.1:41100"])

    result = _enable(
        configs,
        routing,
        state,
        direct_resolver="127.0.0.1:5353",
        direct_domains="example.com",
    )

    assert result["ok"] is True
    saved = dns._load_state(str(state))
    assert saved["use_firmware_resolver"] is True
    # Решение сохранено, но записать адрес в этот раз было некуда.
    assert saved["firmware_resolvers_applied"] == []


def test_an_overlap_the_user_created_themselves_is_still_refused(tmp_path: Path, monkeypatch):
    """Сторожевой тест к правке выше: свои адреса разбирает человек.

    Уступка автоматики не должна превратиться в «панель молча чинит любой
    конфликт»: два своих адреса в разных группах — это ошибка ввода, и
    человек обязан её увидеть.
    """
    configs, routing, state = _scenario(tmp_path)
    _patch_plumbing(monkeypatch, [])

    with pytest.raises(dns.DnsOverVlessError) as excinfo:
        _enable(
            configs,
            routing,
            state,
            local_resolver="192.168.10.5",
            direct_resolver="192.168.10.5:5353",
            direct_domains="example.com",
        )

    assert excinfo.value.code == "resolver_group_overlap"
