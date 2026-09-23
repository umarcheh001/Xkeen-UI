"""Состояние `opkg dns-override` читается через RCI, а ndmc остаётся запасным.

Замер на роутере 45.1 (23.09.2026): весь `get_status` — 167,8 мс, из них 144,7
мс занимает единственный вызов `ndmc show running-config`. Дорог не сам ndmc
(запуск процесса — 9 мс), а выдача всех 16,8 КБ конфига; сокращённых форм
команды прошивка не принимает (`Command::Base error`). Тот же факт локальный
RCI отдаёт за 5 мс.

RCI зеркалит включённые флаги: `ntp master` приходит как `{"master": true}`,
`isolate-private` — как `true`. Значит включённый `dns-override` будет в ветке
`/rci/opkg` рядом с `disk`, а выключенный — отсутствовать, что совпадает с
нынешним выводом «команда отсутствует» из running-config.

Любая осечка RCI обязана молча возвращать нас на прежний путь: на прошивках
5.2+ он требует токен, а на машине разработчика его нет вовсе.
"""

from __future__ import annotations

import pytest

from services import dns_over_vless as dns
from utils.firmware import NdmcRun


@pytest.fixture
def ndmc_says(monkeypatch):
    """Подменить ответ ndmc и убедиться, что до него вообще дошли."""

    calls: list[str] = []

    def install(text: str) -> list[str]:
        def fake_run(command, timeout=None):
            calls.append(command)
            return NdmcRun(0, text, "")

        monkeypatch.setattr(dns, "run_ndmc", fake_run)
        monkeypatch.setattr(dns, "_ndmc_path", lambda: "/bin/ndmc")
        return calls

    return install


@pytest.fixture
def rci_says(monkeypatch):
    def install(value):
        def fake_fetch(path, timeout=None):
            if isinstance(value, Exception):
                raise value
            return value

        monkeypatch.setattr(dns, "fetch_rci_json", fake_fetch)

    return install


class TestRciAnswers:
    def test_enabled_flag_is_read(self, rci_says, ndmc_says) -> None:
        calls = ndmc_says("opkg dns-override\n")
        rci_says({"disk": {"disk": "ENTWARE:/"}, "dns-override": True})
        assert dns._dns_override_status() == (True, "rci")
        assert calls == [], "ndmc не должен запускаться, когда ответил RCI"

    def test_disabled_flag_is_read(self, rci_says) -> None:
        rci_says({"disk": {"disk": "ENTWARE:/"}, "dns-override": False})
        assert dns._dns_override_status() == (False, "rci")

    def test_missing_key_means_off(self, rci_says) -> None:
        # Прошивка не печатает выключенные по умолчанию команды — ни в
        # running-config, ни в RCI.
        rci_says({"disk": {"disk": "ENTWARE:/"}})
        enabled, detail = dns._dns_override_status()
        assert enabled is False
        assert "rci" in detail


class TestFallbackToNdmc:
    def test_unreachable_rci_falls_back(self, rci_says, ndmc_says) -> None:
        calls = ndmc_says("opkg dns-override\n")
        rci_says(OSError("connection refused"))
        assert dns._dns_override_status() == (True, "running-config")
        assert calls == ["show running-config"]

    def test_foreign_shape_falls_back(self, rci_says, ndmc_says) -> None:
        # Не словарь — значит прошивка ответила не тем, чем мы думали.
        calls = ndmc_says("no opkg dns-override\n")
        rci_says(["unexpected"])
        assert dns._dns_override_status() == (False, "running-config")
        assert calls == ["show running-config"]

    def test_unreadable_value_falls_back(self, rci_says, ndmc_says) -> None:
        calls = ndmc_says("opkg dns-override\n")
        rci_says({"dns-override": "может быть"})
        assert dns._dns_override_status() == (True, "running-config")
        assert calls == ["show running-config"]

    def test_missing_ndmc_still_reported(self, rci_says, monkeypatch) -> None:
        rci_says(OSError("no rci here"))
        monkeypatch.setattr(dns, "_ndmc_path", lambda: "")
        assert dns._dns_override_status() == (None, "ndmc не найден")
