from __future__ import annotations

import pytest

from services import dns_service_lifecycle as lifecycle


def _release_kwargs():
    return {
        "expected_owner": "dns-over-vless",
        "configs_dir": "/tmp/configs",
        "routing_file": "/tmp/routing.json",
        "ui_state_dir": "/tmp/state",
        "mihomo_config_file": "/tmp/config.yaml",
        "restart_xkeen": lambda **_kwargs: True,
    }


def test_stop_protection_reports_owner_label(monkeypatch):
    monkeypatch.setattr(lifecycle, "protection_owner", lambda **_kwargs: "mihomo-dns")

    result = lifecycle.get_stop_protection(
        ui_state_dir="/tmp/state",
        mihomo_config_file="/tmp/config.yaml",
    )

    assert result == {
        "active": True,
        "owner": "mihomo-dns",
        "label": "защита DNS Mihomo",
    }


def test_stop_protection_fails_closed_when_mihomo_override_is_unknown(monkeypatch):
    monkeypatch.setattr(lifecycle, "protection_owner", lambda **_kwargs: "")
    monkeypatch.setattr(
        lifecycle.mihomo_dns,
        "get_status",
        lambda **_kwargs: {
            "enabled": False,
            "dns_listener_configured": True,
            "dns_override": None,
            "active_core": "mihomo",
        },
    )

    with pytest.raises(lifecycle.DnsServiceLifecycleError, match="DNS override"):
        lifecycle.get_stop_protection(
            ui_state_dir="/tmp/state",
            mihomo_config_file="/tmp/config.yaml",
        )


def test_xray_dns_is_released_before_service_stop(monkeypatch):
    owners = iter(["dns-over-vless", ""])
    calls = []
    monkeypatch.setattr(lifecycle, "protection_owner", lambda **_kwargs: next(owners))
    monkeypatch.setattr(
        lifecycle.mihomo_dns,
        "get_status",
        lambda **_kwargs: {"enabled": False, "dns_listener_configured": False},
    )
    monkeypatch.setattr(
        lifecycle.dns_over_vless,
        "apply_action",
        lambda action, **kwargs: calls.append((action, kwargs)) or {"ok": True},
    )

    result = lifecycle.release_for_service_stop(**_release_kwargs())

    assert result["released"] is True
    assert result["owner"] == "dns-over-vless"
    assert calls[0][0] == "disable"
    assert calls[0][1]["routing_file"] == "/tmp/routing.json"


def test_release_refuses_owner_changed_after_confirmation(monkeypatch):
    monkeypatch.setattr(lifecycle, "protection_owner", lambda **_kwargs: "mihomo-dns")

    with pytest.raises(lifecycle.DnsServiceLifecycleError, match="изменился"):
        lifecycle.release_for_service_stop(**_release_kwargs())


def test_mihomo_manual_profile_uses_soft_release(monkeypatch):
    owners = iter(["mihomo-dns", ""])
    calls = []
    monkeypatch.setattr(lifecycle, "protection_owner", lambda **_kwargs: next(owners))
    monkeypatch.setattr(lifecycle.mihomo_dns, "get_status", lambda **_kwargs: {"can_release": True})
    monkeypatch.setattr(
        lifecycle.mihomo_dns,
        "apply_action",
        lambda action, **kwargs: calls.append((action, kwargs)) or {"ok": True, "released": True},
    )
    kwargs = _release_kwargs()
    kwargs["expected_owner"] = "mihomo-dns"

    result = lifecycle.release_for_service_stop(**kwargs)

    assert result["released"] is True
    assert result["owner"] == "mihomo-dns"
    assert calls[0][0] == "release"
    assert calls[0][1]["config_file"] == "/tmp/config.yaml"
