from __future__ import annotations

from pathlib import Path

from services.module_transactions.history import (
    ENVIRONMENT_TAIL,
    HISTORY_LIMIT,
    environment_log_path,
    history_path,
    read_history,
)
from services.module_transactions.provision import build_provision
from services.module_transactions.state import write_status


def _status(operation_id: str = "20261026T122903Z-e1d4a5", **overrides):
    return {
        "operation_id": operation_id,
        "scope": "panel",
        "operation": "panel-update",
        "module_id": None,
        "version": "3.0.3-beta.6",
        "source_version": "3.0.3-beta.5",
        "step": "committed",
        "result": "committed",
        "error_code": None,
        "error": None,
        "started_at": 1793017743.42,
        "finished_at": 1793017762.07,
        "log": [{"step": "prepared", "at": 1793017743.95}, {"step": "committed", "at": 1793017761.96}],
        **overrides,
    }


def _script(tmp_path: Path, body: str) -> Path:
    script = tmp_path / "provision_env.sh"
    script.write_bytes(("#!/bin/sh\n" + body).encode("utf-8"))
    return script


def test_terminal_status_is_recorded(tmp_path):
    write_status(tmp_path, _status())

    [entry] = read_history(tmp_path)

    assert entry["operation_id"] == "20261026T122903Z-e1d4a5"
    assert entry["result"] == "committed"
    assert entry["source_version"] == "3.0.3-beta.5"
    assert [record["step"] for record in entry["log"]] == ["prepared", "committed"]
    assert entry["channel"] == "stable"
    assert history_path(tmp_path).name == "history.jsonl"


def test_the_update_channel_of_the_panel_is_kept(tmp_path):
    from services.module_update_channel import write_channel

    write_channel(tmp_path, "prerelease")
    write_status(tmp_path, _status())

    assert read_history(tmp_path)[0]["channel"] == "prerelease"


def test_running_status_is_not_history(tmp_path):
    write_status(tmp_path, _status(result="running", step="applying", finished_at=None))

    assert read_history(tmp_path) == []


def test_same_operation_is_replaced_not_added(tmp_path):
    write_status(tmp_path, _status(result="rolled_back"))
    write_status(tmp_path, _status(result="committed"))

    [entry] = read_history(tmp_path)

    assert entry["result"] == "committed"


def test_history_keeps_last_50(tmp_path):
    for index in range(HISTORY_LIMIT + 5):
        write_status(tmp_path, _status(f"op-{index:03d}"))

    entries = read_history(tmp_path)

    assert len(entries) == HISTORY_LIMIT == 50
    assert entries[0]["operation_id"] == "op-005"
    assert entries[-1]["operation_id"] == "op-054"


def test_broken_line_is_skipped(tmp_path):
    write_status(tmp_path, _status("op-a"))
    with history_path(tmp_path).open("a", encoding="utf-8") as handle:
        handle.write('{"oper\n')
    write_status(tmp_path, _status("op-b"))

    assert [entry["operation_id"] for entry in read_history(tmp_path)] == ["op-a", "op-b"]


def test_environment_output_goes_with_the_operation(tmp_path):
    state = tmp_path / "state"
    write_status(state, _status(result="running", step="prepared", finished_at=None))
    script = _script(tmp_path, 'echo "[ok] opkg update"\necho "[ok] curl уже стоит"\necho "[note] package_missing lftp"\n')

    build_provision(tmp_path, log_path=environment_log_path(state))("apply", script)
    write_status(state, _status())

    [entry] = read_history(state)
    assert entry["environment"] == [
        "=== apply ===",
        "[ok] opkg update",
        "[ok] curl уже стоит",
        "[note] package_missing lftp",
    ]


def test_environment_tail_is_limited(tmp_path):
    state = tmp_path / "state"
    write_status(state, _status(result="running", step="prepared", finished_at=None))
    script = _script(tmp_path, 'i=0\nwhile [ $i -lt 500 ]; do echo "line $i"; i=$((i+1)); done\n')

    build_provision(tmp_path, log_path=environment_log_path(state))("apply", script)
    write_status(state, _status())

    [entry] = read_history(state)
    assert len(entry["environment"]) == ENVIRONMENT_TAIL == 200
    assert entry["environment"][-1] == "line 499"


def test_new_operation_clears_environment_log(tmp_path):
    write_status(tmp_path, _status("op-old", result="running", finished_at=None))
    environment_log_path(tmp_path).write_text("=== apply ===\nold\n", encoding="utf-8")
    write_status(tmp_path, _status("op-old"))

    write_status(tmp_path, _status("op-new", result="running", finished_at=None))

    assert not environment_log_path(tmp_path).exists()


def test_module_name_is_kept(tmp_path):
    write_status(tmp_path, _status(scope="module", operation="install", module_id="tool.terminal"))

    [entry] = read_history(tmp_path)

    assert entry["module_name"] == "Терминал и команды"
