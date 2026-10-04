from __future__ import annotations

from copy import deepcopy
from types import SimpleNamespace

import pytest

from services.router_modem_control import (
    MAX_OPERATION_ENTRIES,
    OPERATION_RETENTION_SECONDS,
    RESET_START_PROBE_DEADLINE_SECONDS,
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
    def __init__(self, *, qmi_imei: str = "222222222222222", reset_returncode: int = 0):
        self.argv: list[list[str]] = []
        self.qmi_imei = qmi_imei
        self.reset_returncode = reset_returncode

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
        if "--dms-set-operating-mode=reset" in argv:
            return SimpleNamespace(returncode=self.reset_returncode, stdout="", stderr="raw reset stderr")
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
        sleep=lambda _seconds: None,
        worker_starter=lambda _worker: None,
    )


def test_validate_modem_id_accepts_strict_ascii_identifier():
    assert validate_modem_id("UsbQmi1") == "UsbQmi1"
    assert validate_modem_id("UsbQmi_1.v2-aux") == "UsbQmi_1.v2-aux"


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


def test_probe_hard_disables_reset_when_selected_rci_imei_is_absent(transports):
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


def test_reset_rejects_selected_rci_modem_without_imei_before_scheduling(transports):
    inventory = deepcopy(MODEMS)
    inventory["items"][1].pop("imei")
    workers = []
    service = ModemControlService(
        rci_fetcher=lambda *_args, **_kwargs: inventory,
        device_enumerator=transports.devices,
        runner=transports.runner,
        worker_starter=workers.append,
    )

    with pytest.raises(ModemControlError) as exc_info:
        service.start_reset("UsbQmi1", confirmation="UsbQmi1")

    assert exc_info.value.code == "transport_not_matched"
    assert workers == []
    assert transports.argv == []


def test_probe_reports_missing_qmi_tool_without_raw_exception(rci_fetcher):
    def missing_tool(_argv, **_kwargs):
        raise FileNotFoundError("/secret/qmicli execution details")

    service = ModemControlService(
        rci_fetcher=rci_fetcher,
        device_enumerator=lambda: {"qmi": ["/dev/cdc-wdm1"], "tty": []},
        runner=missing_tool,
    )
    result = service.probe("UsbQmi1")

    assert result["preferred_transport"] is None
    assert "qmi_tool_missing" in repr(result)
    assert "/secret" not in repr(result)


def test_probe_maps_qmi_nonzero_to_stable_safe_code(transports):
    def failed_probe(argv, **kwargs):
        assert "--dms-get-ids" in argv
        return SimpleNamespace(returncode=1, stdout="", stderr="private qmi details")

    service = ModemControlService(
        sampler=lambda: MODEMS,
        device_enumerator=lambda: {"qmi": ["/dev/cdc-wdm1"], "tty": []},
        runner=failed_probe,
    )
    result = service.probe("UsbQmi1")

    assert result["code"] == "qmi_probe_failed"
    assert "private qmi details" not in repr(result)


def test_probe_falls_back_to_tty_only_after_at_and_cgsn_imei_match(rci_fetcher, transports):
    transports.qmi_imei = "999999999999999"
    tty_calls = []

    def tty_exchange(path, command, **kwargs):
        tty_calls.append((path, command, kwargs))
        if path.endswith("1"):
            return "AT\r\nOK\r\n" if command == "AT" else "AT+CGSN\r\n222222222222222\r\nOK\r\n"
        return "AT\r\nOK\r\n" if command == "AT" else "AT+CGSN\r\n111111111111111\r\nOK\r\n"

    service = ModemControlService(
        rci_fetcher=rci_fetcher,
        device_enumerator=transports.devices,
        runner=transports.runner,
        tty_exchange=tty_exchange,
    )
    result = service.probe("UsbQmi1")

    assert result["preferred_transport"] == "tty"
    assert result["transports"] == [{"kind": "tty", "available": True}]
    matched_port_calls = [command for path, command, _kwargs in tty_calls if path.endswith("1")]
    assert matched_port_calls == ["AT", "AT+CGSN"]
    assert all(command in {"AT", "AT+CGSN"} for _path, command, _kwargs in tty_calls)


def test_probe_rejects_mismatched_tty_imei_without_positional_fallback(rci_fetcher, transports):
    transports.qmi_imei = "999999999999999"
    tty_calls = []

    def tty_exchange(path, command, **kwargs):
        tty_calls.append((path, command, kwargs))
        return "AT\r\nOK\r\n" if command == "AT" else "AT+CGSN\r\n111111111111111\r\nOK\r\n"

    service = ModemControlService(
        rci_fetcher=rci_fetcher,
        device_enumerator=transports.devices,
        runner=transports.runner,
        tty_exchange=tty_exchange,
    )
    result = service.probe("UsbQmi1")

    assert result["preferred_transport"] is None
    assert all(item["available"] is False for item in result["transports"])
    assert "transport_not_matched" in repr(result)
    assert all(command != "AT+RESET" for _path, command, _kwargs in tty_calls)


def test_reset_rejects_mismatched_tty_without_scheduling_or_reset(rci_fetcher, transports):
    transports.qmi_imei = "999999999999999"
    tty_calls = []
    workers = []

    def tty_exchange(path, command, **kwargs):
        tty_calls.append((path, command))
        return "AT\r\nOK\r\n" if command == "AT" else "AT+CGSN\r\n111111111111111\r\nOK\r\n"

    service = ModemControlService(
        rci_fetcher=rci_fetcher,
        device_enumerator=transports.devices,
        runner=transports.runner,
        tty_exchange=tty_exchange,
        worker_starter=workers.append,
    )

    with pytest.raises(ModemControlError) as exc_info:
        service.start_reset("UsbQmi1", confirmation="UsbQmi1")

    assert exc_info.value.code == "transport_not_matched"
    assert workers == []
    assert all(command != "AT+RESET" for _path, command in tty_calls)
    assert not any("--dms-set-operating-mode=reset" in call for call in transports.argv)


def test_reset_probe_stops_before_late_matching_transport_after_deadline(rci_fetcher):
    now = [100.0]
    workers = []
    tty_paths = [f"/dev/ttyUSB{index}" for index in range(6)]
    tty_calls = []

    def runner(argv, **kwargs):
        now[0] += float(kwargs["timeout"])
        return SimpleNamespace(returncode=0, stdout="IMEI: '999999999999999'\n", stderr="")

    def tty_exchange(path, command, *, timeout):
        tty_calls.append((path, command, timeout))
        now[0] += timeout
        if path.endswith("5"):
            return "AT\r\nOK\r\n" if command == "AT" else "AT+CGSN\r\n222222222222222\r\nOK\r\n"
        return "AT\r\nOK\r\n" if command == "AT" else "AT+CGSN\r\n111111111111111\r\nOK\r\n"

    service = ModemControlService(
        rci_fetcher=rci_fetcher,
        sampler=lambda: MODEMS,
        device_enumerator=lambda: {"qmi": ["/dev/cdc-wdm0"], "tty": tty_paths},
        runner=runner,
        tty_exchange=tty_exchange,
        clock=lambda: now[0],
        worker_starter=workers.append,
    )

    with pytest.raises(ModemControlError) as exc_info:
        service.start_reset("UsbQmi1", confirmation="UsbQmi1")

    assert exc_info.value.code == "transport_not_matched"
    assert workers == []
    assert now[0] - 100.0 <= RESET_START_PROBE_DEADLINE_SECONDS
    assert not any(path.endswith("5") for path, _command, _timeout in tty_calls)
    assert all(timeout <= 3.0 for _path, _command, timeout in tty_calls)


def test_reset_requires_exact_confirmation_and_returns_safe_operation(service):
    with pytest.raises(ModemControlError) as exc_info:
        service.start_reset("UsbQmi1", confirmation="Beeline")

    assert exc_info.value.code == "modem_confirmation_mismatch"


def test_duplicate_active_reset_is_rejected(service):
    first = service.start_reset("UsbQmi1", confirmation="UsbQmi1")

    with pytest.raises(ModemControlError) as exc_info:
        service.start_reset("UsbQmi1", confirmation="UsbQmi1")

    assert first["operation_id"]
    assert exc_info.value.code == "modem_operation_in_progress"


def test_reset_operation_state_has_terminal_contract_and_redacts_command_output(service, transports):
    accepted = service.start_reset("UsbQmi1", confirmation="UsbQmi1")
    assert accepted["before"]["id"] == "UsbQmi1"
    assert "imei" not in accepted["before"]
    assert "222222222222222" not in repr(accepted["before"])
    operation = service.status(accepted["operation_id"])

    assert operation["status"] in {"queued", "running", "waiting_for_modem", "recovered", "failed", "timed_out"}
    assert {"operation_id", "modem_id", "status", "before", "transport"}.issubset(operation)
    assert "stdout" not in operation
    assert "stderr" not in operation
    assert "raw reset stderr" not in repr(operation)
    assert "222222222222222" not in repr(operation)
    assert all(isinstance(call, list) for call in transports.argv)


def test_worker_reset_targets_only_imei_matched_qmi_path(transports):
    workers = []
    now = [100.0]
    service = ModemControlService(
        rci_fetcher=lambda *_args, **_kwargs: MODEMS,
        device_enumerator=transports.devices,
        runner=transports.runner,
        worker_starter=workers.append,
        clock=lambda: now[0],
        sleep=lambda seconds: now.__setitem__(0, now[0] + max(seconds, 1)),
    )

    accepted = service.start_reset("UsbQmi1", confirmation="UsbQmi1")
    assert len(workers) == 1
    workers[0]()

    reset_calls = [call for call in transports.argv if "--dms-set-operating-mode=reset" in call]
    assert reset_calls == [["qmicli", "-d", "/dev/cdc-wdm1", "--dms-set-operating-mode=reset"]]
    assert service.status(accepted["operation_id"])["modem_id"] == "UsbQmi1"


def test_worker_tty_reset_targets_only_imei_matched_tty_path(rci_fetcher, transports):
    transports.qmi_imei = "999999999999999"
    workers = []
    tty_calls = []
    now = [100.0]

    def tty_exchange(path, command, **kwargs):
        tty_calls.append((path, command, kwargs))
        if path.endswith("1"):
            if command == "AT+CGSN":
                return "AT+CGSN\r\n222222222222222\r\nOK\r\n"
            return "AT\r\nOK\r\n"
        return "AT\r\nOK\r\n" if command == "AT" else "AT+CGSN\r\n111111111111111\r\nOK\r\n"

    service = ModemControlService(
        rci_fetcher=rci_fetcher,
        device_enumerator=transports.devices,
        runner=transports.runner,
        tty_exchange=tty_exchange,
        worker_starter=workers.append,
        clock=lambda: now[0],
        sleep=lambda seconds: now.__setitem__(0, now[0] + max(seconds, 1)),
    )
    accepted = service.start_reset("UsbQmi1", confirmation="UsbQmi1")
    workers[0]()

    reset_calls = [(path, command) for path, command, _kwargs in tty_calls if command == "AT+RESET"]
    assert reset_calls == [("/dev/ttyUSB1", "AT+RESET")]
    assert not any("--dms-set-operating-mode=reset" in call for call in transports.argv)
    assert service.status(accepted["operation_id"])["modem_id"] == "UsbQmi1"


def test_worker_marks_recovered_with_after_snapshot(transports):
    workers = []
    now = [100.0]
    reads_after_reset = [0]

    def runner(argv, **kwargs):
        result = transports.runner(argv, **kwargs)
        if "--dms-set-operating-mode=reset" in argv:
            reads_after_reset[0] = 1
        return result

    def rci_fetcher(*_args, **_kwargs):
        if reads_after_reset[0] == 1:
            reads_after_reset[0] = 2
            return {"available": True, "items": []}
        return MODEMS

    service = ModemControlService(
        rci_fetcher=rci_fetcher,
        sampler=lambda: rci_fetcher("show/interface"),
        device_enumerator=transports.devices,
        runner=runner,
        worker_starter=workers.append,
        clock=lambda: now[0],
        sleep=lambda seconds: now.__setitem__(0, now[0] + max(seconds, 1)),
    )

    accepted = service.start_reset("UsbQmi1", confirmation="UsbQmi1")
    workers[0]()
    operation = service.status(accepted["operation_id"])

    assert operation["status"] == "recovered"
    assert operation["after"]["id"] == "UsbQmi1"


def test_default_sampler_recovers_after_successful_empty_inventory(transports):
    workers = []
    now = [100.0]
    reset_started = [False]
    empty_reads = [0]
    payload = {
        "UsbQmi1": {
            "id": "UsbQmi1", "type": "UsbQmi", "description": "T2_STATIC",
            "imei": "222222222222222", "operator": "Tele2", "rsrp": -73,
        },
    }

    def fetch(path):
        if not reset_started[0]:
            return payload
        empty_reads[0] += 1
        if empty_reads[0] <= 5:
            return {}
        return payload

    def runner(argv, **kwargs):
        result = transports.runner(argv, **kwargs)
        if "--dms-set-operating-mode=reset" in argv:
            reset_started[0] = True
        return result

    service = ModemControlService(
        rci_fetcher=fetch,
        device_enumerator=transports.devices,
        runner=runner,
        worker_starter=workers.append,
        clock=lambda: now[0],
        sleep=lambda seconds: now.__setitem__(0, now[0] + max(seconds, 1)),
    )
    accepted = service.start_reset("UsbQmi1", confirmation="UsbQmi1")
    workers[0]()

    assert service.status(accepted["operation_id"])["status"] == "recovered"


def test_worker_does_not_confirm_disappearance_after_transient_rci_failure(transports):
    workers = []
    now = [100.0]
    reads_after_reset = [0]

    def runner(argv, **kwargs):
        result = transports.runner(argv, **kwargs)
        if "--dms-set-operating-mode=reset" in argv:
            reads_after_reset[0] = 1
        return result

    def sampler():
        if reads_after_reset[0] == 1:
            reads_after_reset[0] = 2
            return {"available": False, "items": [], "state": "unavailable"}
        return MODEMS

    service = ModemControlService(
        sampler=sampler,
        device_enumerator=transports.devices,
        runner=runner,
        worker_starter=workers.append,
        clock=lambda: now[0],
        sleep=lambda seconds: now.__setitem__(0, now[0] + max(seconds, 1)),
    )
    accepted = service.start_reset("UsbQmi1", confirmation="UsbQmi1")
    workers[0]()

    operation = service.status(accepted["operation_id"])
    assert operation["status"] == "timed_out"


def test_worker_releases_active_slot_when_target_disappears(transports):
    workers = []
    service = ModemControlService(
        sampler=lambda: MODEMS,
        device_enumerator=transports.devices,
        runner=transports.runner,
        worker_starter=workers.append,
        clock=lambda: 100.0,
        sleep=lambda _seconds: None,
    )
    accepted = service.start_reset("UsbQmi1", confirmation="UsbQmi1")
    service._targets.pop(accepted["operation_id"])
    workers[0]()

    operation = service.status(accepted["operation_id"])
    assert operation["status"] == "failed"
    assert operation["code"] == "modem_operation_target_missing"
    second = service.start_reset("UsbQmi1", confirmation="UsbQmi1")
    assert second["operation_id"] != accepted["operation_id"]


def test_worker_marks_failed_when_reset_command_returns_nonzero(transports):
    transports.reset_returncode = 1
    workers = []
    service = ModemControlService(
        rci_fetcher=lambda *_args, **_kwargs: MODEMS,
        device_enumerator=transports.devices,
        runner=transports.runner,
        worker_starter=workers.append,
    )

    accepted = service.start_reset("UsbQmi1", confirmation="UsbQmi1")
    workers[0]()
    operation = service.status(accepted["operation_id"])

    assert operation["status"] == "failed"
    assert operation["after"] is None
    assert operation["code"] == "modem_reset_failed"


def test_status_unknown_operation_is_not_substituted(service):
    with pytest.raises(ModemControlError) as exc_info:
        service.status("missing-operation")

    assert exc_info.value.code == "operation_not_found"


def test_status_prunes_expired_operation(transports):
    now = [100.0]
    transports.reset_returncode = 1
    service = ModemControlService(
        rci_fetcher=lambda *_args, **_kwargs: MODEMS,
        device_enumerator=transports.devices,
        runner=transports.runner,
        clock=lambda: now[0],
        worker_starter=lambda worker: worker(),
    )
    accepted = service.start_reset("UsbQmi1", confirmation="UsbQmi1")
    now[0] += 901

    with pytest.raises(ModemControlError, match="operation_not_found"):
        service.status(accepted["operation_id"])


def test_start_reset_prunes_terminal_entries_without_status_polling(transports):
    now = [100.0]
    transports.reset_returncode = 1
    service = ModemControlService(
        rci_fetcher=lambda *_args, **_kwargs: MODEMS,
        device_enumerator=transports.devices,
        runner=transports.runner,
        clock=lambda: now[0],
        worker_starter=lambda worker: worker(),
    )

    first = service.start_reset("UsbQmi1", confirmation="UsbQmi1")
    assert service._operations[first["operation_id"]].status == "failed"
    now[0] += OPERATION_RETENTION_SECONDS + 1

    second = service.start_reset("UsbQmi1", confirmation="UsbQmi1")

    assert first["operation_id"] not in service._operations
    assert second["operation_id"] in service._operations
    assert len(service._operations) == 1


def test_operation_registry_stays_bounded_without_status_polling(transports):
    workers = []
    transports.reset_returncode = 1

    def start_worker(worker):
        if not workers:
            workers.append(worker)
            return
        worker()

    service = ModemControlService(
        rci_fetcher=lambda *_args, **_kwargs: MODEMS,
        device_enumerator=transports.devices,
        runner=transports.runner,
        worker_starter=start_worker,
    )
    active = service.start_reset("UsbQmi1", confirmation="UsbQmi1")

    for _ in range(MAX_OPERATION_ENTRIES + 32):
        service.start_reset("UsbQmi0", confirmation="UsbQmi0")

    assert active["operation_id"] in service._operations
    assert len(service._operations) <= MAX_OPERATION_ENTRIES


def test_reset_times_out_when_exact_rci_modem_never_returns(transports):
    now = [100.0]
    workers = []
    service = ModemControlService(
        rci_fetcher=lambda *_args, **_kwargs: MODEMS,
        device_enumerator=transports.devices,
        runner=transports.runner,
        clock=lambda: now[0],
        sleep=lambda seconds: now.__setitem__(0, now[0] + max(seconds, 1)),
        worker_starter=workers.append,
    )
    accepted = service.start_reset("UsbQmi1", confirmation="UsbQmi1")

    assert len(workers) == 1
    workers[0]()
    operation = service.status(accepted["operation_id"])
    assert operation["status"] == "timed_out"
    assert operation["finished_at"] >= operation["started_at"]
    assert "222222222222222" not in repr(operation)
    assert "raw reset stderr" not in repr(operation)


def test_transport_helpers_do_not_accept_shell_strings(service):
    with pytest.raises((TypeError, ValueError, ModemControlError)):
        service.probe("UsbQmi1; reboot")
