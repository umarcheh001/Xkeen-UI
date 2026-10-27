"""Firmware initrc detection and safe, persistent repair."""

import subprocess

import pytest

from services import entware_initrc as service
from utils.firmware import NdmcRun


@pytest.fixture(autouse=True)
def cache():
    service.clear_initrc_cache()
    yield
    service.clear_initrc_cache()


@pytest.mark.parametrize("config,state,path", [
    ("opkg disk ABC\nopkg initrc /opt/etc/init.d/rc.unslung", "ok", "/opt/etc/init.d/rc.unslung"),
    ("opkg initrc /custom/stop", "ok", "/custom/stop"),
    ("\x1b[K opkg disk ABC\r\n\x1b[K opkg initrc /Custom/Stop", "ok", "/Custom/Stop"),
    ("opkg disk ABC", "missing", None),
    ("opkg disk ABC\nno opkg initrc", "missing", None),
    ("opkg disk ABC\n# opkg initrc /ignored\nopkg initrc", "missing", None),
    ("hostname router", "unknown", None),
    ("", "unknown", None),
])
def test_status_parses_config(monkeypatch, config, state, path):
    monkeypatch.setattr(service, "run_ndmc", lambda *a, **k: NdmcRun(0, config, ""))
    assert service.initrc_status() == {"state": state, "path": path}


@pytest.mark.parametrize("result", [
    FileNotFoundError("ndmc"), subprocess.TimeoutExpired("ndmc", 10),
    NdmcRun(1, "opkg disk ABC", "failed"),
    NdmcRun(0, "opkg disk ABC\n% error failed", ""),
    NdmcRun(0, "opkg disk ABC", "error: failed"),
])
def test_read_failure_is_unknown(monkeypatch, result):
    def run(*a, **k):
        if isinstance(result, Exception):
            raise result
        return result
    monkeypatch.setattr(service, "run_ndmc", run)
    assert service.initrc_status() == {"state": "unknown", "path": None}


def test_cache_returns_independent_copy_and_can_be_cleared(monkeypatch):
    calls = []
    def run(command, **kw):
        calls.append(command)
        return NdmcRun(0, "opkg disk ABC", "")
    monkeypatch.setattr(service, "run_ndmc", run)
    service.initrc_status()["state"] = "ok"
    assert service.initrc_status()["state"] == "missing"
    assert calls == ["show running-config"]
    service.clear_initrc_cache()
    service.initrc_status()
    assert len(calls) == 2


def firmware(monkeypatch, *, path=None, failure=None, no_effect=False):
    state = {"path": path, "calls": [], "failure": failure}
    def run(command, **kw):
        state["calls"].append(command)
        if command == "show running-config":
            return NdmcRun(0, "opkg disk ABC\n" + (f"opkg initrc {state['path']}" if state["path"] else ""), "")
        if state["failure"] and command == state["failure"][0]:
            result = state["failure"][1]
            if isinstance(result, Exception):
                raise result
            return result
        if command.startswith("opkg initrc") and not no_effect:
            state["path"] = "/opt/etc/init.d/rc.unslung"
        return NdmcRun(0, "Done", "")
    monkeypatch.setattr(service, "run_ndmc", run)
    return state


def test_apply_sets_and_saves_in_separate_calls_and_refreshes_cache(monkeypatch):
    state = firmware(monkeypatch)
    assert service.initrc_status()["state"] == "missing"
    state["calls"].clear()
    assert service.apply_initrc() == {"state": "ok", "path": "/opt/etc/init.d/rc.unslung"}
    assert state["calls"] == ["show running-config", "opkg initrc /opt/etc/init.d/rc.unslung", "system configuration save", "show running-config"]
    assert service.initrc_status()["state"] == "ok"


def test_apply_preserves_existing_custom_path(monkeypatch):
    state = firmware(monkeypatch)
    service.initrc_status()
    state["path"] = "/custom/stop"
    state["calls"].clear()
    assert service.apply_initrc()["path"] == "/custom/stop"
    assert state["calls"] == ["show running-config", "system configuration save", "show running-config"]


@pytest.mark.parametrize("command", ["opkg initrc /opt/etc/init.d/rc.unslung", "system configuration save"])
@pytest.mark.parametrize("failure", [NdmcRun(0, "% error denied", ""), NdmcRun(0, "", "error: denied"), NdmcRun(1, "denied", ""), OSError("denied")])
def test_apply_reports_firmware_failure(monkeypatch, command, failure):
    state = firmware(monkeypatch, failure=(command, failure))
    with pytest.raises(service.InitrcError) as exc:
        service.apply_initrc()
    assert "denied" in exc.value.details
    assert exc.value.code
    assert state["calls"][-1] == command


def test_retry_saves_after_previous_save_failure(monkeypatch):
    state = firmware(monkeypatch, failure=("system configuration save", NdmcRun(1, "denied", "")))
    with pytest.raises(service.InitrcError):
        service.apply_initrc()
    state["failure"] = None
    state["calls"].clear()
    assert service.apply_initrc()["state"] == "ok"
    assert "system configuration save" in state["calls"]


def test_apply_rejects_no_effect(monkeypatch):
    firmware(monkeypatch, no_effect=True)
    with pytest.raises(service.InitrcError) as exc:
        service.apply_initrc()
    assert exc.value.code == "initrc_not_applied"


def test_apply_unknown_never_changes_config(monkeypatch):
    calls = []
    def run(command, **kw):
        calls.append(command)
        return NdmcRun(0, "hostname router", "")
    monkeypatch.setattr(service, "run_ndmc", run)
    with pytest.raises(service.InitrcError) as exc:
        service.apply_initrc()
    assert exc.value.code == "initrc_unavailable"
    assert calls == ["show running-config"]
