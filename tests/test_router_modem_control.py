from __future__ import annotations

from copy import deepcopy
from types import SimpleNamespace

import pytest

from services.router_modem_control import (
    MODEM_PROBE_DEADLINE_SECONDS,
    ModemControlError,
    ModemControlService,
    validate_modem_id,
)


MODEMS = {
    "available": True,
    "items": [
        {
            "id": "UsbQmi0",
            "name": "BEELINE",
            "imei": "111111111111111",
            "operator": "Beeline",
            "model": "Dell Snapdragon X55",
            "sim": "READY",
        },
        {
            "id": "UsbQmi1",
            "name": "T2_STATIC",
            "imei": "222222222222222",
            "operator": "Tele2",
            "model": "DW5821e Snapdragon X20 LTE",
            "sim": "READY",
        },
    ],
}


class TransportDoubles:
    def __init__(self, *, qmi_imei: str = "222222222222222"):
        self.argv: list[list[str]] = []
        self.qmi_imei = qmi_imei

    def devices(self):
        return {
            "qmi": ["/dev/cdc-wdm0", "/dev/cdc-wdm1"],
            "tty": ["/dev/ttyUSB0", "/dev/ttyUSB1"],
        }

    def runner(self, argv, **kwargs):
        self.argv.append(list(argv))
        assert kwargs.get("shell") is False
        assert isinstance(argv, (list, tuple))
        if "--dms-get-ids" in argv:
            device = argv[argv.index("-d") + 1]
            imei = self.qmi_imei if device.endswith("1") else "111111111111111"
            return SimpleNamespace(returncode=0, stdout=f"IMEI: '{imei}'\n", stderr="raw qmi stderr")
        raise AssertionError(f"unexpected argv: {argv!r}")


@pytest.fixture
def rci_fetcher():
    return lambda *_args, **_kwargs: MODEMS


@pytest.fixture
def transports():
    return TransportDoubles()


@pytest.fixture
def service(rci_fetcher, transports):
    return ModemControlService(
        rci_fetcher=rci_fetcher,
        sampler=lambda: MODEMS,
        device_enumerator=transports.devices,
        runner=transports.runner,
        clock=lambda: 100.0,
    )


def test_validate_modem_id_accepts_strict_ascii_identifier():
    assert validate_modem_id("UsbQmi1") == "UsbQmi1"
    assert validate_modem_id("UsbQmi_1.v2-aux") == "UsbQmi_1.v2-aux"


def test_modem_control_service_exposes_probe_only():
    assert hasattr(ModemControlService, "probe")
    assert not hasattr(ModemControlService, "start_reset")
    assert not hasattr(ModemControlService, "status")


@pytest.mark.parametrize("value", ["", " ", "Usb/Qmi1", "Usb Qmi1", "UsbQmi1/../../x", "модем", "a" * 65, "a\x00b"])
def test_validate_modem_id_rejects_empty_overlong_or_unsafe_values(value):
    with pytest.raises((ValueError, ModemControlError)):
        validate_modem_id(value)


def test_probe_matches_selected_modem_by_imei_and_prefers_qmi(service, transports):
    result = service.probe("UsbQmi1")

    assert result["modem"]["id"] == "UsbQmi1"
    assert result["preferred_transport"] == "qmi"
    assert result["transports"] == [{"kind": "qmi", "available": True}]
    assert "222222222222222" not in repr(result)


def test_probe_selects_exact_rci_id_and_never_uses_browser_supplied_identity(service):
    result = service.probe("UsbQmi1")

    assert result["modem"]["id"] == "UsbQmi1"
    assert result["modem"]["name"] == "T2_STATIC"
    assert "imei" not in result["modem"]
    assert "device" not in result["modem"]


def test_probe_redacts_and_bounds_nested_carrier_payload(transports):
    inventory = deepcopy(MODEMS)
    inventory["items"][1]["carriers"] = [
        {
            "technology": "4G+",
            "band": "B" * 500 + " SECRET-IMEI-222222222222222",
            "earfcn": {"raw": "nested-private-value"},
            "phy_cell_id": ["unexpected", "container"],
            "downlink_frequency": 123,
            "secret": {"raw": "must-not-leak"},
        }
    ]
    service = ModemControlService(
        sampler=lambda: inventory,
        device_enumerator=transports.devices,
        runner=transports.runner,
    )

    result = service.probe("UsbQmi1")
    carrier = result["modem"]["carriers"][0]

    assert len(carrier["band"]) <= 64
    assert carrier["downlink_frequency"] == 123
    assert "nested-private-value" not in repr(result)
    assert "must-not-leak" not in repr(result)
    assert "222222222222222" not in repr(result)
    assert all(isinstance(value, (str, int, float, bool)) or value is None for value in carrier.values())


def test_probe_rejects_unknown_modem_without_enumerating_devices(rci_fetcher, transports):
    service = ModemControlService(rci_fetcher=rci_fetcher, device_enumerator=transports.devices, runner=transports.runner)

    with pytest.raises(ModemControlError, match="modem_not_found"):
        service.probe("UsbQmi9")
    assert transports.argv == []


def test_probe_qmi_matching_uses_fixed_argv_and_redacts_stderr(service, transports):
    result = service.probe("UsbQmi1")

    qmi_calls = [call for call in transports.argv if "--dms-get-ids" in call]
    assert qmi_calls
    assert all("--dms-get-ids" in call for call in qmi_calls)
    assert all("shell=True" not in str(call) for call in qmi_calls)
    assert "raw qmi stderr" not in repr(result)
    assert "222222222222222" not in repr(result)


def test_probe_reports_transport_not_matched_when_qmi_imei_differs(rci_fetcher, transports):
    transports.qmi_imei = "999999999999999"
    service = ModemControlService(rci_fetcher=rci_fetcher, device_enumerator=transports.devices, runner=transports.runner)

    result = service.probe("UsbQmi1")

    assert result["preferred_transport"] is None
    assert result["transports"]
    assert all(item["available"] is False for item in result["transports"])
    assert "transport_not_matched" in repr(result)


def test_probe_does_not_enumerate_transports_without_selected_rci_imei(transports):
    inventory = deepcopy(MODEMS)
    inventory["items"][1].pop("imei")
    service = ModemControlService(
        rci_fetcher=lambda *_args, **_kwargs: inventory,
        device_enumerator=transports.devices,
        runner=transports.runner,
    )

    result = service.probe("UsbQmi1")

    assert result["preferred_transport"] is None
    assert all(item["available"] is False for item in result["transports"])
    assert "transport_not_matched" in repr(result)
    assert transports.argv == []


def test_transport_helpers_do_not_accept_shell_strings(service):
    with pytest.raises((TypeError, ValueError, ModemControlError)):
        service.probe("UsbQmi1; reboot")
