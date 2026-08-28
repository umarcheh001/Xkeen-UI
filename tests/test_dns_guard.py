"""The shared port-53 guard: it watches whichever DNS assistant is on.

The guard replaced a watchdog that assumed Xray was the only core able to answer
DNS.  These tests pin the two things that assumption got wrong: a deliberate core
switch must not be treated as a crash, and the Mihomo assistant must be guarded
at all.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Dict, List

import pytest

from services import dns_guard, mihomo_dns


class _Stub:
    """A protection the test can steer, standing in for a real assistant."""

    def __init__(self, name: str, core: str, *, on: bool = True):
        self.name = name
        self.expected_core = core
        self.on = on
        self.released: List[str] = []

    def enabled(self) -> bool:
        return self.on

    def release(self, reason: str) -> Dict[str, Any]:
        self.released.append(reason)
        self.on = False
        return {"reason": reason}


@pytest.fixture(autouse=True)
def _no_real_dns(monkeypatch):
    """Never let a test touch the network; each test states its own health."""
    monkeypatch.setattr(dns_guard, "_probe_ok", lambda: False)
    monkeypatch.setattr(dns_guard, "detect_running_core", lambda: "")


def _tick(protections, counters=None, restarts=None, **kwargs):
    def restart(**meta):
        if restarts is not None:
            restarts.append(meta.get("source"))
        return True

    return dns_guard.guard_tick(
        protections=protections,
        counters=counters or {},
        restart_xkeen=restart,
        fail_threshold=kwargs.get("fail_threshold", 2),
        restart_attempts=kwargs.get("restart_attempts", 1),
    )


def test_guard_is_idle_while_no_protection_is_on():
    stub = _Stub("dns-over-vless", "xray", on=False)

    result = _tick([stub])

    assert result["action"] == "idle"
    assert stub.released == []


def test_guard_stays_quiet_while_dns_answers(monkeypatch):
    monkeypatch.setattr(dns_guard, "_probe_ok", lambda: True)
    stub = _Stub("dns-over-vless", "xray")

    result = _tick([stub], {"fails": 1, "restarts": 1})

    assert result["action"] == "ok"
    assert result["fails"] == 0 and result["restarts"] == 0


def test_guard_restarts_before_giving_up_when_the_core_is_simply_down():
    stub = _Stub("dns-over-vless", "xray")
    restarts: List[str] = []

    counters: Dict[str, Any] = {}
    actions = []
    for _ in range(2):
        counters = _tick([stub], counters, restarts)
        actions.append(counters["action"])

    assert actions == ["watching", "restarted"]
    assert restarts == ["dns-guard"]
    assert stub.released == []


def test_guard_hands_dns_back_after_the_restarts_do_not_help():
    stub = _Stub("dns-over-vless", "xray")

    counters: Dict[str, Any] = {}
    for _ in range(6):
        counters = _tick([stub], counters)
        if counters["action"] == "released":
            break

    assert counters["action"] == "released"
    assert len(stub.released) == 1
    assert "перезапуск" in stub.released[0]


def test_guard_recovers_without_releasing_when_dns_comes_back(monkeypatch):
    health = {"ok": False}
    monkeypatch.setattr(dns_guard, "_probe_ok", lambda: health["ok"])
    stub = _Stub("dns-over-vless", "xray")

    counters: Dict[str, Any] = {}
    for _ in range(2):
        counters = _tick([stub], counters)
    assert counters["action"] == "restarted"

    health["ok"] = True
    counters = _tick([stub], counters)

    assert counters["action"] == "ok"
    assert stub.released == []


def test_switching_to_mihomo_is_not_treated_as_a_crashed_xray(monkeypatch):
    """The tester's case: restarting cannot bring back a core nobody selected."""
    monkeypatch.setattr(dns_guard, "detect_running_core", lambda: "mihomo")
    stub = _Stub("dns-over-vless", "xray")
    restarts: List[str] = []

    result = _tick([stub], {}, restarts)

    # Released on the very first failing check, with no restart budget burned.
    assert result["action"] == "core-switched"
    assert restarts == []
    assert len(stub.released) == 1
    assert "mihomo" in stub.released[0] and "xray" in stub.released[0]


def test_switching_to_xray_stands_the_mihomo_protection_down(monkeypatch):
    """The mirror image, now that the Mihomo assistant is guarded too."""
    monkeypatch.setattr(dns_guard, "detect_running_core", lambda: "xray")
    stub = _Stub("mihomo-dns", "mihomo")
    restarts: List[str] = []

    result = _tick([stub], {}, restarts)

    assert result["action"] == "core-switched"
    assert restarts == []
    assert len(stub.released) == 1


def test_a_mihomo_outage_is_guarded_like_an_xray_one(monkeypatch):
    """Before the shared guard this protection had no watchdog at all."""
    monkeypatch.setattr(dns_guard, "detect_running_core", lambda: "mihomo")
    stub = _Stub("mihomo-dns", "mihomo")
    restarts: List[str] = []

    counters: Dict[str, Any] = {}
    for _ in range(6):
        counters = _tick([stub], counters, restarts)
        if counters["action"] == "released":
            break

    assert counters["action"] == "released"
    assert restarts == ["dns-guard"]
    assert len(stub.released) == 1


def test_a_released_guard_does_not_act_again():
    stub = _Stub("dns-over-vless", "xray")

    counters: Dict[str, Any] = {}
    for _ in range(6):
        counters = _tick([stub], counters)
        if counters["action"] == "released":
            break
    counters["released"] = True
    stub.on = True

    again = _tick([stub], counters)

    assert again["action"] == "released"
    assert len(stub.released) == 1


def test_two_protections_left_on_by_an_old_install_are_both_released():
    """They share one firmware switch, so releasing just one leaves it flipped."""
    xray = _Stub("dns-over-vless", "xray")
    mihomo = _Stub("mihomo-dns", "mihomo")

    counters: Dict[str, Any] = {}
    for _ in range(6):
        counters = _tick([xray, mihomo], counters)
        if counters["action"] == "released":
            break

    assert counters["action"] == "released"
    assert len(xray.released) == 1 and len(mihomo.released) == 1


def test_a_protection_whose_state_cannot_be_read_is_not_guarded():
    def explode() -> bool:
        raise OSError("state unreadable")

    protection = dns_guard.Protection(
        "broken", expected_core="xray", is_enabled=explode, release=lambda reason: {}
    )

    assert protection.enabled() is False
    assert _tick([protection])["action"] == "idle"


# --- mutual exclusion -------------------------------------------------------


def _enable_xray_state(state_dir: Path) -> None:
    state_dir.mkdir(parents=True, exist_ok=True)
    (state_dir / "dns_over_vless.json").write_text(
        json.dumps({"enabled": True}), encoding="utf-8"
    )


def _enable_mihomo_state(state_dir: Path, payload: Dict[str, Any] | None = None) -> None:
    target = state_dir / "mihomo-dns"
    target.mkdir(parents=True, exist_ok=True)
    (target / "mihomo_dns.json").write_text(
        json.dumps(payload or {"enabled": True}), encoding="utf-8"
    )


def test_no_owner_while_both_protections_are_off(tmp_path: Path):
    assert dns_guard.protection_owner(
        ui_state_dir=str(tmp_path), mihomo_config_file=str(tmp_path / "config.yaml")
    ) == ""


def test_the_mihomo_assistant_sees_the_xray_one_holding_port_53(tmp_path: Path):
    _enable_xray_state(tmp_path)

    conflict = dns_guard.conflicting_protection(
        want="mihomo-dns",
        ui_state_dir=str(tmp_path),
        mihomo_config_file=str(tmp_path / "config.yaml"),
    )

    assert conflict == dns_guard.PROTECTION_LABELS["dns-over-vless"]


def test_the_xray_assistant_sees_the_mihomo_one_holding_port_53(tmp_path: Path):
    _enable_mihomo_state(tmp_path)

    conflict = dns_guard.conflicting_protection(
        want="dns-over-vless",
        ui_state_dir=str(tmp_path),
        mihomo_config_file=str(tmp_path / "config.yaml"),
    )

    assert conflict == dns_guard.PROTECTION_LABELS["mihomo-dns"]


def test_a_protection_does_not_conflict_with_itself(tmp_path: Path):
    _enable_xray_state(tmp_path)

    assert dns_guard.conflicting_protection(
        want="dns-over-vless",
        ui_state_dir=str(tmp_path),
        mihomo_config_file=str(tmp_path / "config.yaml"),
    ) == ""


# --- the Mihomo release path ------------------------------------------------


def _mihomo_install(tmp_path: Path, *, original: str = "dns:\n  enable: false\n"):
    config_file = tmp_path / "config.yaml"
    config_file.write_text("dns:\n  enable: true\n", encoding="utf-8")
    snapshot = tmp_path / "before.yaml"
    snapshot.write_text(original, encoding="utf-8")
    _enable_mihomo_state(
        tmp_path,
        {
            "enabled": True,
            "original_config": str(snapshot),
            "original_sha256": hashlib.sha256(original.encode("utf-8")).hexdigest(),
            "original_dns_override": False,
        },
    )
    return config_file, snapshot


def test_mihomo_release_restores_the_config_and_the_firmware_resolver(tmp_path: Path, monkeypatch):
    config_file, _snapshot = _mihomo_install(tmp_path)
    saved: List[str] = []
    overrides: List[bool] = []
    monkeypatch.setattr(mihomo_dns, "_set_dns_override", lambda enabled: overrides.append(enabled))
    monkeypatch.setattr(mihomo_dns, "_wait_for_port_53", lambda **kwargs: True)

    released = mihomo_dns.emergency_release(
        config_file=str(config_file),
        ui_state_dir=str(tmp_path),
        save_config=lambda text: saved.append(text),
        restart_xkeen=lambda **kwargs: True,
        reason="ядро не отвечает",
    )

    assert saved == ["dns:\n  enable: false\n"]
    assert overrides == [False]
    assert "config_restored" in released["steps"]
    # The state is gone, so the guard will not try to release the same thing twice.
    assert mihomo_dns.is_enabled(config_file=str(config_file), ui_state_dir=str(tmp_path)) is False


def test_mihomo_release_still_frees_port_53_when_the_snapshot_is_damaged(tmp_path: Path, monkeypatch):
    """A broken snapshot must not keep the whole LAN without DNS."""
    config_file, snapshot = _mihomo_install(tmp_path)
    snapshot.write_text("dns:\n  enable: true # tampered\n", encoding="utf-8")
    saved: List[str] = []
    overrides: List[bool] = []
    monkeypatch.setattr(mihomo_dns, "_set_dns_override", lambda enabled: overrides.append(enabled))
    monkeypatch.setattr(mihomo_dns, "_wait_for_port_53", lambda **kwargs: True)

    released = mihomo_dns.emergency_release(
        config_file=str(config_file),
        ui_state_dir=str(tmp_path),
        save_config=lambda text: saved.append(text),
        restart_xkeen=lambda **kwargs: True,
        reason="ядро не отвечает",
    )

    # The damaged config is not written back, but the override is still restored.
    assert saved == []
    assert "snapshot_corrupt" in released["steps"]
    assert overrides == [False]


def test_mihomo_release_survives_a_failing_writer(tmp_path: Path, monkeypatch):
    config_file, _snapshot = _mihomo_install(tmp_path)
    overrides: List[bool] = []
    monkeypatch.setattr(mihomo_dns, "_set_dns_override", lambda enabled: overrides.append(enabled))
    monkeypatch.setattr(mihomo_dns, "_wait_for_port_53", lambda **kwargs: True)

    def _boom(_text: str) -> None:
        raise OSError("read-only filesystem")

    released = mihomo_dns.emergency_release(
        config_file=str(config_file),
        ui_state_dir=str(tmp_path),
        save_config=_boom,
        restart_xkeen=lambda **kwargs: True,
        reason="ядро не отвечает",
    )

    # Restoring DNS matters more than restoring the config, so the run continues.
    assert any(step.startswith("config_failed:") for step in released["steps"])
    assert overrides == [False]


def test_build_protections_skips_mihomo_without_a_writer(tmp_path: Path):
    protections = dns_guard.build_protections(
        configs_dir=str(tmp_path),
        routing_file=str(tmp_path / "routing.json"),
        ui_state_dir=str(tmp_path),
        mihomo_config_file=str(tmp_path / "config.yaml"),
        save_mihomo_config=None,
        restart_xkeen=lambda **kwargs: True,
    )

    assert [item.name for item in protections] == ["dns-over-vless"]


def test_build_protections_wires_both_assistants(tmp_path: Path):
    protections = dns_guard.build_protections(
        configs_dir=str(tmp_path),
        routing_file=str(tmp_path / "routing.json"),
        ui_state_dir=str(tmp_path),
        mihomo_config_file=str(tmp_path / "config.yaml"),
        save_mihomo_config=lambda text: None,
        restart_xkeen=lambda **kwargs: True,
    )

    assert [item.name for item in protections] == ["dns-over-vless", "mihomo-dns"]
    assert [item.expected_core for item in protections] == ["xray", "mihomo"]
