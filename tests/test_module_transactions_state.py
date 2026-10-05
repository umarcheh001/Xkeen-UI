from __future__ import annotations

import os
import re
from pathlib import Path

from services.module_transactions.state import (
    RESULTS,
    STEPS,
    ModuleTransactionError,
    new_operation_id,
    pid_alive,
    read_status,
    status_path,
    transactions_root,
    write_status,
)


def test_error_carries_a_stable_code_and_details() -> None:
    error = ModuleTransactionError("module_free_space", "not enough room", required=10, free=3)

    assert error.code == "module_free_space"
    assert error.message == "not enough room"
    assert error.details == {"required": 10, "free": 3}
    assert "module_free_space" in str(error)


def test_steps_and_results_are_the_ones_the_spec_names() -> None:
    assert STEPS == (
        "prepared", "downloading", "verifying", "applying", "state",
        "restarting", "health", "committed", "rolling_back",
    )
    assert RESULTS == ("running", "committed", "rolled_back", "interrupted", "rollback_failed")


def test_transactions_live_next_to_the_panel_not_inside_it() -> None:
    root = transactions_root(Path("/opt/etc/xkeen-ui"))

    assert root.name == "xkeen-ui.module-transactions"
    assert root.parent == Path("/opt/etc")


def test_status_path_is_under_the_state_directory(tmp_path: Path) -> None:
    assert status_path(tmp_path) == tmp_path / "module-operations" / "status.json"


def test_operation_id_is_sortable_utc_time_with_a_random_suffix() -> None:
    first = new_operation_id(0.0)
    second = new_operation_id(0.0)

    assert re.fullmatch(r"\d{8}T\d{6}Z-[0-9a-f]{6}", first)
    assert first.startswith("19700101T000000Z-")
    assert first != second
    assert re.fullmatch(r"\d{8}T\d{6}Z-[0-9a-f]{6}", new_operation_id())


def test_status_round_trip(tmp_path: Path) -> None:
    status = {"operation_id": "x", "result": "running", "step": "applying", "журнал": ["шаг"]}

    write_status(tmp_path, status)

    assert read_status(tmp_path) == status
    assert [path.name for path in status_path(tmp_path).parent.iterdir()] == ["status.json"]


def test_missing_status_reads_as_no_operation(tmp_path: Path) -> None:
    assert read_status(tmp_path) == {"result": None}


def test_corrupt_status_reads_as_no_operation(tmp_path: Path) -> None:
    path = status_path(tmp_path)
    path.parent.mkdir(parents=True)
    path.write_text("{broken", encoding="utf-8")

    assert read_status(tmp_path) == {"result": None}

    path.write_text("[1, 2]", encoding="utf-8")

    assert read_status(tmp_path) == {"result": None}


def test_pid_alive_tells_a_running_process_from_garbage() -> None:
    assert pid_alive(os.getpid()) is True
    assert pid_alive("x") is False
    assert pid_alive(None) is False
    assert pid_alive(0) is False
