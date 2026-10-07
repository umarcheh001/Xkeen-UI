from __future__ import annotations

import os
import threading

import pytest

from services.module_transactions.cancel_channel import CancelListener
from services.module_transactions.journal import Journal
from services.module_transactions.launcher import ensure_restartable, request_cancel
from services.module_transactions.plan import build_plan
from services.module_transactions.state import ModuleTransactionError, write_status
from services.self_update.state import get_update_paths, try_acquire_lock
from tests.support.module_tx import make_panel


OPERATION_ID = "20261006T120000Z-abcdef"


def _operation(tmp_path, *, running: bool = True):
    panel = make_panel(tmp_path)
    plan = build_plan("install", "tool.terminal", **panel.kwargs)
    journal = Journal.create(panel.root, plan, OPERATION_ID, extra={})
    journal.set_pid(os.getpid() if running else 2_147_483_647)
    write_status(
        panel.state,
        {"operation_id": OPERATION_ID, "result": "running"},
    )
    return panel, journal


@pytest.fixture
def listening():
    """Исполнитель операции, который слушает просьбу об отмене."""

    asked = threading.Event()
    channel = CancelListener(OPERATION_ID, asked.set)
    address = channel.start()
    try:
        yield channel, address, asked
    finally:
        channel.close()


def test_request_cancel_reaches_the_runner_of_the_operation(tmp_path, listening):
    _channel, address, asked = listening
    panel, journal = _operation(tmp_path)
    journal.set_cancel_channel(address)

    request_cancel(panel.root, panel.state, OPERATION_ID)

    assert asked.is_set()


@pytest.mark.parametrize(
    ("requested_id", "status_result", "running", "code"),
    [
        ("20261006T120000Z-000000", "running", True, "operation_not_found"),
        (OPERATION_ID, "committed", True, "operation_not_running"),
        (OPERATION_ID, "running", False, "operation_not_running"),
    ],
)
def test_request_cancel_refuses_unsafe_targets(
    tmp_path, listening, requested_id, status_result, running, code
):
    _channel, address, asked = listening
    panel, journal = _operation(tmp_path, running=running)
    journal.set_cancel_channel(address)
    write_status(
        panel.state,
        {"operation_id": OPERATION_ID, "result": status_result},
    )

    with pytest.raises(ModuleTransactionError) as raised:
        request_cancel(panel.root, panel.state, requested_id)

    assert raised.value.code == code
    assert not asked.is_set()


def test_request_cancel_refuses_when_journal_is_missing(tmp_path):
    panel = make_panel(tmp_path)
    write_status(panel.state, {"operation_id": OPERATION_ID, "result": "running"})

    with pytest.raises(ModuleTransactionError) as raised:
        request_cancel(panel.root, panel.state, OPERATION_ID)

    assert raised.value.code == "operation_not_found"


def test_request_cancel_maps_a_runner_that_just_left(tmp_path):
    panel, journal = _operation(tmp_path)
    channel = CancelListener(OPERATION_ID, lambda: None)
    journal.set_cancel_channel(channel.start())
    channel.close()

    with pytest.raises(ModuleTransactionError) as raised:
        request_cancel(panel.root, panel.state, OPERATION_ID)

    assert raised.value.code == "operation_not_running"


def test_request_cancel_fails_when_the_runner_does_not_listen_yet(tmp_path):
    panel, _journal = _operation(tmp_path)

    with pytest.raises(ModuleTransactionError) as raised:
        request_cancel(panel.root, panel.state, OPERATION_ID)

    assert raised.value.code == "operation_cancel_failed"


def test_request_cancel_fails_when_the_listener_is_not_the_runner(tmp_path, listening):
    # На записанном адресе оказался кто-то другой: он не знает слова операции,
    # и ничего, кроме отказа, из этого не выходит.
    _channel, address, asked = listening
    panel, journal = _operation(tmp_path)
    journal.set_cancel_channel({**address, "token": "0" * 64})

    with pytest.raises(ModuleTransactionError) as raised:
        request_cancel(panel.root, panel.state, OPERATION_ID)

    assert raised.value.code == "operation_cancel_failed"
    assert not asked.is_set()


def test_request_cancel_never_signals_a_process_by_its_number(tmp_path, listening, monkeypatch):
    _channel, address, _asked = listening
    panel, journal = _operation(tmp_path)
    journal.set_cancel_channel(address)
    monkeypatch.setattr(os, "kill", lambda *_args: pytest.fail("must not signal by PID"))

    request_cancel(panel.root, panel.state, OPERATION_ID)


def test_ensure_restartable_refuses_live_operation(tmp_path):
    panel, _journal = _operation(tmp_path)

    with pytest.raises(ModuleTransactionError) as raised:
        ensure_restartable(panel.root, panel.state)

    assert raised.value.code == "operation_in_progress"


def test_ensure_restartable_requires_recovery_for_abandoned_journal(tmp_path):
    panel, _journal = _operation(tmp_path, running=False)

    with pytest.raises(ModuleTransactionError) as raised:
        ensure_restartable(panel.root, panel.state)

    assert raised.value.code == "operation_recovery_required"


def test_ensure_restartable_preserves_rollback_failed(tmp_path):
    panel, _journal = _operation(tmp_path, running=False)
    write_status(panel.state, {"operation_id": OPERATION_ID, "result": "rollback_failed"})

    with pytest.raises(ModuleTransactionError) as raised:
        ensure_restartable(panel.root, panel.state)

    assert raised.value.code == "operation_rollback_failed"


def test_ensure_restartable_refuses_live_panel_update_lock(tmp_path, monkeypatch):
    panel = make_panel(tmp_path)
    monkeypatch.setenv("XKEEN_UI_UPDATE_DIR", str(tmp_path / "update"))
    lock_file = get_update_paths(str(panel.state))["lock_file"]
    assert try_acquire_lock(lock_file)[0]
    try:
        with pytest.raises(ModuleTransactionError) as raised:
            ensure_restartable(panel.root, panel.state)
    finally:
        os.remove(lock_file)

    assert raised.value.code == "operation_in_progress"


def test_ensure_restartable_accepts_idle_panel(tmp_path, monkeypatch):
    panel = make_panel(tmp_path)
    monkeypatch.setenv("XKEEN_UI_UPDATE_DIR", str(tmp_path / "update"))

    ensure_restartable(panel.root, panel.state)
