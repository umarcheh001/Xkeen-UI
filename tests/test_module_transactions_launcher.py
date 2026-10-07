from __future__ import annotations

import os
import signal

import pytest

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


def _runner_argv(operation_id: str = OPERATION_ID):
    return (
        "python",
        "module_transaction.py",
        "run",
        "--operation",
        operation_id,
    )


def test_request_cancel_signals_only_matching_module_runner(tmp_path):
    panel, _journal = _operation(tmp_path)
    signals = []

    request_cancel(
        panel.root,
        panel.state,
        OPERATION_ID,
        read_cmdline=lambda _pid: _runner_argv(),
        terminate=lambda pid, sig: signals.append((pid, sig)),
        platform_name="nt",
    )

    assert signals == [(os.getpid(), signal.SIGTERM)]


@pytest.mark.parametrize(
    ("requested_id", "status_result", "running", "argv", "code"),
    [
        ("20261006T120000Z-000000", "running", True, _runner_argv(), "operation_not_found"),
        (OPERATION_ID, "committed", True, _runner_argv(), "operation_not_running"),
        (OPERATION_ID, "running", False, _runner_argv(), "operation_not_running"),
        (OPERATION_ID, "running", True, ("python", "worker.py"), "operation_process_mismatch"),
        (
            OPERATION_ID,
            "running",
            True,
            _runner_argv("20261006T120000Z-000000"),
            "operation_process_mismatch",
        ),
    ],
)
def test_request_cancel_refuses_unsafe_targets(
    tmp_path, requested_id, status_result, running, argv, code
):
    panel, _journal = _operation(tmp_path, running=running)
    write_status(
        panel.state,
        {"operation_id": OPERATION_ID, "result": status_result},
    )
    signals = []

    with pytest.raises(ModuleTransactionError) as raised:
        request_cancel(
            panel.root,
            panel.state,
            requested_id,
            read_cmdline=lambda _pid: argv,
            terminate=lambda pid, sig: signals.append((pid, sig)),
        )

    assert raised.value.code == code
    assert signals == []


def test_request_cancel_refuses_when_journal_is_missing(tmp_path):
    panel = make_panel(tmp_path)
    write_status(panel.state, {"operation_id": OPERATION_ID, "result": "running"})

    with pytest.raises(ModuleTransactionError) as raised:
        request_cancel(
            panel.root,
            panel.state,
            OPERATION_ID,
            read_cmdline=lambda _pid: _runner_argv(),
            terminate=lambda _pid, _sig: pytest.fail("must not signal"),
        )

    assert raised.value.code == "operation_not_found"


def test_request_cancel_maps_process_exit_race(tmp_path):
    panel, _journal = _operation(tmp_path)

    with pytest.raises(ModuleTransactionError) as raised:
        request_cancel(
            panel.root,
            panel.state,
            OPERATION_ID,
            read_cmdline=lambda _pid: _runner_argv(),
            terminate=lambda _pid, _sig: (_ for _ in ()).throw(ProcessLookupError()),
            platform_name="nt",
        )

    assert raised.value.code == "operation_not_running"


def test_request_cancel_uses_pidfd_to_prevent_linux_pid_reuse(tmp_path):
    panel, _journal = _operation(tmp_path)
    calls = []

    request_cancel(
        panel.root,
        panel.state,
        OPERATION_ID,
        read_cmdline=lambda _pid: _runner_argv(),
        terminate=lambda _pid, _sig: pytest.fail("pid kill fallback is unsafe"),
        platform_name="posix",
        open_process=lambda pid: calls.append(("open", pid)) or 42,
        signal_process=lambda fd, sig: calls.append(("signal", fd, sig)),
        close_process=lambda fd: calls.append(("close", fd)),
    )

    assert calls == [
        ("open", os.getpid()),
        ("signal", 42, signal.SIGTERM),
        ("close", 42),
    ]


def test_request_cancel_refuses_linux_when_pidfd_is_unavailable(tmp_path):
    panel, _journal = _operation(tmp_path)

    with pytest.raises(ModuleTransactionError) as raised:
        request_cancel(
            panel.root,
            panel.state,
            OPERATION_ID,
            read_cmdline=lambda _pid: _runner_argv(),
            platform_name="posix",
            open_process=lambda _pid: None,
            terminate=lambda _pid, _sig: pytest.fail("must not signal by PID"),
        )

    assert raised.value.code == "operation_process_mismatch"


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
