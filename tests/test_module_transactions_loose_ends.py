"""Small holes of the module operation engine found by the independent review."""

from __future__ import annotations

import io
import json
import os
import stat
import tarfile
import time
from pathlib import Path

import pytest

from services.module_transactions import journal as journal_module
from services.module_transactions import launcher
from services.module_transactions.executor import recover
from services.module_transactions.extract import extract_payload
from services.module_transactions.journal import Journal
from services.module_transactions.plan import build_plan
from services.module_transactions.state import ModuleTransactionError, pid_alive, read_status, write_status
from tests.support.module_tx import make_panel, snapshot


posix_only = pytest.mark.skipif(os.name == "nt", reason="file modes and process states are POSIX notions")


def _journal(panel, operation_id: str = "20261005T000000Z-abcdef") -> Journal:
    plan = build_plan("install", "tool.terminal", **panel.kwargs)
    return Journal.create(panel.root, plan, operation_id, extra={"health_url": "http://127.0.0.1:1/"})


def _later(monkeypatch, seconds: float) -> None:
    now = time.monotonic()
    monkeypatch.setattr(journal_module.time, "monotonic", lambda: now + seconds)


# -- the moment between recording an operation and its runner reporting ------


def test_just_recorded_operation_counts_as_carried(tmp_path: Path) -> None:
    journal = Journal.open(_journal(make_panel(tmp_path)).dir)

    assert journal.runner_alive() is False
    assert journal.starting() is True
    assert journal.busy() is True


def test_operation_nobody_picked_up_stops_counting_as_carried(tmp_path: Path, monkeypatch) -> None:
    journal = _journal(make_panel(tmp_path))

    _later(monkeypatch, journal_module._START_GRACE_S + 1)

    assert Journal.open(journal.dir).busy() is False


def test_recorded_before_a_reboot_is_not_starting(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(journal_module, "current_boot_id", lambda: "boot-one")
    journal = _journal(make_panel(tmp_path))

    monkeypatch.setattr(journal_module, "current_boot_id", lambda: "boot-two")

    assert Journal.open(journal.dir).starting() is False


def test_operation_that_moved_on_is_not_starting(tmp_path: Path) -> None:
    journal = _journal(make_panel(tmp_path))
    journal.set_step("applying")

    assert Journal.open(journal.dir).starting() is False


def test_record_without_the_uptime_mark_is_not_starting(tmp_path: Path) -> None:
    journal = _journal(make_panel(tmp_path))
    record = journal.dir / "operation.json"
    meta = json.loads(record.read_text(encoding="utf-8"))
    del meta["created_uptime"]
    record.write_text(json.dumps(meta), encoding="utf-8")

    assert Journal.open(journal.dir).starting() is False


def test_recover_leaves_a_just_recorded_operation_alone(tmp_path: Path, monkeypatch) -> None:
    panel = make_panel(tmp_path)
    journal = _journal(panel)

    assert recover(panel.root, panel.state) is None
    assert journal.dir.is_dir()

    _later(monkeypatch, journal_module._START_GRACE_S + 1)

    assert recover(panel.root, panel.state) == "interrupted"
    assert not journal.dir.exists()


def test_new_operation_is_refused_while_another_is_starting(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("XKEEN_UI_UPDATE_DIR", str(tmp_path / "update"))
    panel = make_panel(tmp_path)
    _journal(panel)

    with pytest.raises(ModuleTransactionError) as raised:
        launcher.ensure_idle(panel.root, panel.state)

    assert raised.value.code == "operation_in_progress"


# -- the undo trusts nothing it reads back -----------------------------------


@pytest.mark.parametrize("path", ["../outside.txt", "static/../../outside.txt", "/outside.txt", "..\\outside.txt"])
def test_rollback_ignores_a_logged_path_outside_the_panel(tmp_path: Path, path: str) -> None:
    panel = make_panel(tmp_path)
    outside = tmp_path / "outside.txt"
    outside.write_bytes(b"not a file of the panel\n")
    before = snapshot(panel.root)
    journal = _journal(panel)
    with open(journal.dir / "actions.log", "ab") as log:
        log.write((json.dumps({"kind": "add", "path": path}) + "\n").encode("utf-8"))
        log.write((json.dumps({"kind": "mkdir", "path": ".."}) + "\n").encode("utf-8"))

    Journal.open(journal.dir).rollback()

    assert outside.read_bytes() == b"not a file of the panel\n"
    assert snapshot(panel.root) == before


# -- file modes ---------------------------------------------------------------


@posix_only
def test_rewritten_state_file_keeps_its_mode(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    target = panel.path("modules.json")
    target.chmod(0o600)
    journal = _journal(panel)

    journal.write_state_file("modules.json", b'{"changed": true}\n')

    assert stat.S_IMODE(target.stat().st_mode) == 0o600

    journal.rollback()

    assert stat.S_IMODE(target.stat().st_mode) == 0o600


@posix_only
def test_extract_keeps_a_script_executable_and_nothing_more(tmp_path: Path) -> None:
    archive = tmp_path / "module.tar.gz"
    with tarfile.open(archive, "w:gz") as packed:
        for name, mode in (("payload/tools/run.sh", 0o755), ("payload/data.json", 0o666), ("payload/odd.bin", 0o4711)):
            info = tarfile.TarInfo(name)
            info.size = 1
            info.mode = mode
            packed.addfile(info, io.BytesIO(b"x"))

    extract_payload(archive, tmp_path / "out", ["tools/run.sh", "data.json", "odd.bin"])

    def mode(relative: str) -> int:
        return stat.S_IMODE((tmp_path / "out" / relative).stat().st_mode)

    assert mode("tools/run.sh") == 0o755
    assert mode("data.json") == 0o644
    assert mode("odd.bin") == 0o755


# -- a process that ended but was not collected -------------------------------


@pytest.mark.skipif(not Path("/proc/self/stat").exists() or not hasattr(os, "fork"), reason="needs /proc and fork")
def test_ended_process_nobody_collected_is_not_alive() -> None:
    child = os.fork()
    if child == 0:
        os._exit(0)
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            state = Path(f"/proc/{child}/stat").read_text(encoding="ascii").rpartition(")")[2].split()[0]
            if state == "Z":
                break
            time.sleep(0.05)

        assert pid_alive(child) is False
    finally:
        os.waitpid(child, 0)
    assert pid_alive(os.getpid()) is True


# -- the status the panel shows ----------------------------------------------


def test_observed_status_closes_an_operation_whose_record_is_gone(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    write_status(panel.state, {"operation_id": "gone", "result": "running", "step": "applying", "error_code": None})

    status = launcher.observe_status(panel.root, panel.state)

    assert status["result"] == "interrupted"
    assert status["error_code"] == "operation_interrupted"
    assert status["finished_at"]
    assert read_status(panel.state)["result"] == "interrupted"


def test_observed_status_does_not_touch_a_finished_operation(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    written = {"operation_id": "done", "result": "committed", "step": "committed"}
    write_status(panel.state, written)

    assert launcher.observe_status(panel.root, panel.state) == written


def test_observed_status_waits_for_an_operation_that_is_starting(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    journal = _journal(panel)
    write_status(panel.state, {"operation_id": journal.meta()["operation_id"], "result": "running", "step": "prepared"})

    assert launcher.observe_status(panel.root, panel.state)["result"] == "running"
    assert journal.dir.is_dir()


def test_observed_status_finishes_an_operation_whose_runner_is_gone(tmp_path: Path, monkeypatch) -> None:
    panel = make_panel(tmp_path)
    before = snapshot(panel.root)
    journal = _journal(panel)
    relative = journal.plan.files_add[0]
    source = tmp_path / "incoming.bin"
    source.write_bytes(b"new file of the module\n")
    journal.apply_file(relative, source)
    journal.set_step("health")
    write_status(panel.state, {"operation_id": journal.meta()["operation_id"], "result": "running", "step": "health"})
    _later(monkeypatch, journal_module._START_GRACE_S + 1)

    status = launcher.observe_status(panel.root, panel.state)

    assert status["result"] == "rolled_back"
    assert status["recovered"] is True
    # The running panel was restarted on the files that are gone again.
    assert status["restart_required"] is True
    after = snapshot(panel.root)
    after.pop("module-operations/status.json", None)
    assert after == before


def test_recover_before_the_panel_starts_asks_for_no_restart(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    journal = _journal(panel)
    journal.set_step("health")

    assert recover(panel.root, panel.state) == "rolled_back"
    assert "restart_required" not in read_status(panel.state)


def test_restart_asked_of_a_running_panel_is_forgotten_once_it_starts(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    write_status(
        panel.state,
        {"operation_id": "undone", "result": "rolled_back", "step": "health", "recovered": True, "restart_required": True},
    )

    assert launcher.settle_restart_on_startup(panel.state) is True

    status = read_status(panel.state)
    assert "restart_required" not in status
    assert (status["result"], status["recovered"]) == ("rolled_back", True)


def test_panel_start_leaves_a_status_that_asks_for_nothing_alone(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)

    assert launcher.settle_restart_on_startup(panel.state) is False
    assert not (panel.state / "module-operations" / "status.json").exists()

    written = {"operation_id": "done", "result": "committed", "step": "committed"}
    write_status(panel.state, written)
    before = (panel.state / "module-operations" / "status.json").stat().st_mtime_ns

    assert launcher.settle_restart_on_startup(panel.state) is False
    assert read_status(panel.state) == written
    assert (panel.state / "module-operations" / "status.json").stat().st_mtime_ns == before


def test_started_panel_no_longer_asks_for_the_restart_it_just_had(isolated_runtime_env) -> None:
    from tests.conftest import _platform_supports_full_app

    if not _platform_supports_full_app():
        pytest.skip("Full Flask app startup requires Unix-only modules (pty/termios).")
    import importlib

    state_dir = isolated_runtime_env["state_dir"]
    write_status(state_dir, {"operation_id": "undone", "result": "rolled_back", "restart_required": True})

    importlib.import_module("app_factory").create_app(ws_runtime=False)

    assert "restart_required" not in read_status(state_dir)


# -- the plan and the records have to be one directory -----------------------


def test_launch_refuses_a_state_directory_apart_from_the_panel(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    plan = build_plan("install", "tool.terminal", **panel.kwargs)
    elsewhere = tmp_path / "state"
    elsewhere.mkdir()

    with pytest.raises(ModuleTransactionError) as raised:
        launcher.launch(
            plan, panel_root=panel.root, state_dir=elsewhere, health_url="http://127.0.0.1:1/", restart_cmd=["true"],
        )

    assert raised.value.code == "operation_state_dir_mismatch"
    assert Journal.find(panel.root) is None
    assert read_status(elsewhere) == {"result": None}


# -- renaming a file onto another name of itself ------------------------------


@pytest.fixture
def posix_rename(monkeypatch) -> None:
    """Make ``os.replace`` behave as rename(2) does on the router.

    POSIX: when both names already refer to the same file, rename does
    nothing and reports success - the source name stays. Windows removes it,
    which hid a leftover temporary file from the tests run there.
    """

    real_replace = os.replace

    def replace(source, target, *args, **kwargs):
        try:
            if os.path.samefile(source, target):
                return None
        except OSError:
            pass
        return real_replace(source, target, *args, **kwargs)

    monkeypatch.setattr(journal_module.os, "replace", replace)


def _links_work(tmp_path: Path) -> bool:
    probe = tmp_path / "link-probe"
    probe.write_bytes(b"x")
    try:
        os.link(probe, tmp_path / "link-probe-2")
    except OSError:
        return False
    return True


def test_rollback_leaves_no_temporary_file_when_the_original_was_never_replaced(tmp_path: Path, posix_rename) -> None:
    if not _links_work(tmp_path):
        pytest.skip("this filesystem has no hard links")
    panel = make_panel(tmp_path / "stand", installed=("core", "tool.editor", "engine.xray", "tool.terminal"))
    before = snapshot(panel.root)
    plan = build_plan("remove", "tool.terminal", **panel.kwargs)
    journal = Journal.create(panel.root, plan, "20261005T000000Z-abcdef", extra={})
    relative = plan.files_remove[0]
    # Announced and kept, and then the power went: the file itself is untouched.
    journal._record("remove", relative)
    journal._keep(relative, panel.path(relative))

    Journal.open(journal.dir).rollback()

    assert snapshot(panel.root) == before


def test_second_rollback_leaves_no_temporary_files(tmp_path: Path, posix_rename) -> None:
    if not _links_work(tmp_path):
        pytest.skip("this filesystem has no hard links")
    panel = make_panel(tmp_path / "stand", installed=("core", "tool.editor", "engine.xray", "tool.terminal"))
    before = snapshot(panel.root)
    plan = build_plan("repair", "tool.terminal", **panel.kwargs)
    journal = Journal.create(panel.root, plan, "20261005T000000Z-abcdef", extra={})
    for relative in plan.files_add:
        source = tmp_path / "incoming.bin"
        source.write_bytes(b"new " + relative.encode())
        journal.apply_file(relative, source)

    journal.rollback()
    assert snapshot(panel.root) == before
    # The undo is repeated after a failure or a power cut halfway through.
    Journal.open(journal.dir).rollback()

    assert snapshot(panel.root) == before
