from __future__ import annotations

import http.server
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from services.module_transactions import launcher
from services.module_transactions.executor import recover
from services.module_transactions.journal import Journal
from services.module_transactions.plan import build_plan
from services.module_transactions.state import (
    ModuleTransactionError,
    new_operation_id,
    read_status,
    transactions_root,
    write_status,
)
from services.self_update.state import get_update_paths, try_acquire_lock
from tests.support.module_tx import (
    ARCHITECTURE,
    OWNERSHIP,
    changed_paths,
    make_panel,
    make_release,
    snapshot,
    write_release_directory,
)


ROOT = Path(__file__).resolve().parents[1]
SHIPPED = ROOT / "xkeen-ui" / "scripts" / "module_transaction.py"
RUNNER = ROOT / "tests" / "support" / "module_transaction_runner.py"
EARLY = {"prepared", "downloading", "verifying"}
BOOKKEEPING = {"module-catalog/catalog-2.10.0.json", "module-operations/status.json"}


class _Health(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *_args) -> None:
        return None


@pytest.fixture
def health_url():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Health)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}/api/auth/status"
    finally:
        server.shutdown()
        server.server_close()


@pytest.fixture
def stand(tmp_path: Path, monkeypatch, health_url: str):
    """A panel, a release directory and an environment that leaks nothing outside tmp."""

    monkeypatch.setenv("XKEEN_UI_UPDATE_DIR", str(tmp_path / "update"))
    monkeypatch.setenv("XKEEN_UI_MODULE_TX_HEALTH_TIMEOUT", "20")
    panel = make_panel(tmp_path)
    release = make_release()
    release_dir = write_release_directory(release, tmp_path / "release")

    class Stand:
        pass

    stand = Stand()
    stand.panel, stand.release, stand.release_dir, stand.health_url, stand.tmp = panel, release, release_dir, health_url, tmp_path
    stand.restart_cmd = [sys.executable, "-c", "pass"]
    return stand


def _prepare(stand, operation: str = "install", module_id: str = "tool.terminal", *, health_url: str | None = None) -> Journal:
    plan = build_plan(operation, module_id, **{**stand.panel.kwargs, "catalog": stand.release.catalog})
    return Journal.create(
        stand.panel.root, plan, new_operation_id(),
        extra={"health_url": health_url or stand.health_url, "restart_cmd": stand.restart_cmd},
    )


def _runner(stand, command: str, *extra: str, operation_id: str | None = None) -> subprocess.CompletedProcess:
    args = [
        sys.executable, str(RUNNER), command,
        "--panel-root", str(stand.panel.root), "--state-dir", str(stand.panel.state),
        "--release-dir", str(stand.release_dir), "--architecture", ARCHITECTURE, *extra,
    ]
    if operation_id:
        args += ["--operation", operation_id]
    return subprocess.run(args, capture_output=True, text=True, timeout=120)


def test_run_installs_a_module_and_reports_committed(stand) -> None:
    before = snapshot(stand.panel.root)
    journal = _prepare(stand)

    done = _runner(stand, "run", operation_id=journal.meta()["operation_id"])

    assert done.returncode == 0, done.stderr
    assert read_status(stand.panel.state)["result"] == "committed"
    assert Journal.find(stand.panel.root) is None
    after = snapshot(stand.panel.root)
    assert set(OWNERSHIP["tool.terminal"]) <= set(after)
    assert before["app.py"] == after["app.py"]


def test_run_rolls_back_when_the_panel_does_not_answer(stand, monkeypatch) -> None:
    monkeypatch.setenv("XKEEN_UI_MODULE_TX_HEALTH_TIMEOUT", "1")
    before = snapshot(stand.panel.root)
    journal = _prepare(stand, health_url="http://127.0.0.1:9/api/auth/status")

    done = _runner(stand, "run", operation_id=journal.meta()["operation_id"])

    assert done.returncode == 0, done.stderr
    status = read_status(stand.panel.state)
    assert (status["result"], status["error_code"], status["panel_unresponsive"]) == ("rolled_back", "operation_health_failed", True)
    assert changed_paths(before, snapshot(stand.panel.root)) <= BOOKKEEPING


def test_run_reports_a_failing_restart_command(stand) -> None:
    stand.restart_cmd = [sys.executable, "-c", "raise SystemExit(3)"]
    before = snapshot(stand.panel.root)
    journal = _prepare(stand)

    done = _runner(stand, "run", operation_id=journal.meta()["operation_id"])

    assert done.returncode == 0
    assert read_status(stand.panel.state)["result"] == "rolled_back"
    assert changed_paths(before, snapshot(stand.panel.root)) <= BOOKKEEPING


@pytest.mark.parametrize("step", ["prepared", "downloading", "verifying", "applying", "state", "restarting", "health"])
def test_kill_at_step_then_recover_restores_tree(stand, step: str) -> None:
    before = snapshot(stand.panel.root)
    journal = _prepare(stand)

    killed = _runner(stand, "run", "--fail-at", step, operation_id=journal.meta()["operation_id"])
    assert killed.returncode == 70, killed.stderr
    assert Journal.find(stand.panel.root) is not None

    recovered = _runner(stand, "recover")

    # A cleanly cancelled operation is not a failure: only an undo that could
    # not be finished is reported with a non-zero code.
    assert recovered.returncode == 0, recovered.stderr
    assert changed_paths(before, snapshot(stand.panel.root)) <= BOOKKEEPING
    assert Journal.find(stand.panel.root) is None
    assert not transactions_root(stand.panel.root).exists()
    status = read_status(stand.panel.state)
    assert status["result"] == ("interrupted" if step in EARLY else "rolled_back")
    assert status["recovered"] is True
    assert status["error_code"] == "operation_interrupted"


def test_killed_runner_does_not_block_the_next_operation(stand) -> None:
    journal = _prepare(stand)
    _runner(stand, "run", "--fail-at", "applying", operation_id=journal.meta()["operation_id"])
    assert _runner(stand, "recover").returncode == 0

    journal = _prepare(stand)
    done = _runner(stand, "run", operation_id=journal.meta()["operation_id"])

    assert done.returncode == 0, done.stderr
    assert read_status(stand.panel.state)["result"] == "committed"


def test_recover_is_noop_while_executor_is_alive(stand) -> None:
    journal = _prepare(stand)
    journal.set_pid(os.getppid() if os.name != "nt" else _other_live_pid())
    journal.set_step("restarting")
    write_status(stand.panel.state, {"operation_id": journal.meta()["operation_id"], "result": "running", "step": "restarting"})

    assert recover(stand.panel.root, stand.panel.state) is None

    assert journal.dir.is_dir()
    assert read_status(stand.panel.state)["result"] == "running"
    assert _runner(stand, "recover").returncode == 0
    assert journal.dir.is_dir()


def _other_live_pid() -> int:
    """A process that outlives the test body and is not the test itself."""

    process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    _LIVE.append(process)
    return process.pid


_LIVE: list[subprocess.Popen] = []


@pytest.fixture(autouse=True)
def _reap_helpers():
    yield
    while _LIVE:
        process = _LIVE.pop()
        process.kill()
        process.wait()


def test_recover_survives_corrupt_operation_json_with_changes(stand) -> None:
    before = snapshot(stand.panel.root)
    journal = _prepare(stand)
    _runner(stand, "run", "--fail-at", "state", operation_id=journal.meta()["operation_id"])
    assert changed_paths(before, snapshot(stand.panel.root)) - BOOKKEEPING
    (journal.dir / "operation.json").write_text("{broken", encoding="utf-8")

    result = recover(stand.panel.root, stand.panel.state)

    assert result == "interrupted"
    assert changed_paths(before, snapshot(stand.panel.root)) <= BOOKKEEPING
    assert Journal.find(stand.panel.root) is None
    assert read_status(stand.panel.state)["result"] == "interrupted"


def test_recover_survives_corrupt_operation_json_without_changes(stand) -> None:
    before = snapshot(stand.panel.root)
    journal = _prepare(stand)
    (journal.dir / "operation.json").write_bytes(b"\x00\x00")

    assert recover(stand.panel.root, stand.panel.state) == "interrupted"

    assert changed_paths(before, snapshot(stand.panel.root)) <= BOOKKEEPING
    assert Journal.find(stand.panel.root) is None


def test_recover_without_operation_directory_exits_zero(stand) -> None:
    before = snapshot(stand.panel.root)

    assert recover(stand.panel.root, stand.panel.state) is None
    done = _runner(stand, "recover")

    assert done.returncode == 0, done.stderr
    assert snapshot(stand.panel.root) == before


def test_recover_finishes_a_confirmed_operation(stand) -> None:
    journal = _prepare(stand)
    killed = _runner(stand, "run", "--fail-at", "committed", operation_id=journal.meta()["operation_id"])
    assert killed.returncode == 70

    assert recover(stand.panel.root, stand.panel.state) == "committed"

    assert Journal.find(stand.panel.root) is None
    assert set(OWNERSHIP["tool.terminal"]) <= set(snapshot(stand.panel.root))
    assert read_status(stand.panel.state)["result"] == "committed"


def test_recover_retries_a_failed_rollback(stand, monkeypatch) -> None:
    from services.module_transactions import journal as journal_module

    before = snapshot(stand.panel.root)
    journal = _prepare(stand)
    _runner(stand, "run", "--fail-at", "state", operation_id=journal.meta()["operation_id"])
    real_rollback = journal_module.Journal.rollback

    def failing(self):
        raise ModuleTransactionError("operation_rollback_failed", "cannot restore", path="services/ws_pty.py", error="Input/output error")

    monkeypatch.setattr(journal_module.Journal, "rollback", failing)
    assert recover(stand.panel.root, stand.panel.state) == "rollback_failed"
    status = read_status(stand.panel.state)
    assert (status["result"], status["failed_path"]) == ("rollback_failed", "services/ws_pty.py")
    assert Journal.find(stand.panel.root) is not None
    with pytest.raises(ModuleTransactionError) as raised:
        launcher.ensure_idle(stand.panel.root, stand.panel.state)
    assert raised.value.code == "operation_rollback_failed"

    monkeypatch.setattr(journal_module.Journal, "rollback", real_rollback)
    assert recover(stand.panel.root, stand.panel.state) == "rolled_back"

    assert changed_paths(before, snapshot(stand.panel.root)) <= BOOKKEEPING
    assert "failed_path" not in read_status(stand.panel.state)
    launcher.ensure_idle(stand.panel.root, stand.panel.state)


def test_run_refuses_when_self_update_lock_is_held(stand) -> None:
    before = snapshot(stand.panel.root)
    lock_file = get_update_paths(str(stand.panel.state))["lock_file"]
    acquired, _ = try_acquire_lock(lock_file)
    assert acquired
    journal = _prepare(stand)
    try:
        done = _runner(stand, "run", operation_id=journal.meta()["operation_id"])
    finally:
        os.remove(lock_file)

    assert done.returncode == 1
    status = read_status(stand.panel.state)
    assert (status["result"], status["error_code"]) == ("interrupted", "operation_in_progress")
    assert changed_paths(before, snapshot(stand.panel.root)) <= BOOKKEEPING
    assert Journal.find(stand.panel.root) is None


def test_run_releases_the_lock(stand) -> None:
    journal = _prepare(stand)

    _runner(stand, "run", operation_id=journal.meta()["operation_id"])

    assert not os.path.exists(get_update_paths(str(stand.panel.state))["lock_file"])


def test_run_with_an_unknown_operation_is_a_usage_error(stand) -> None:
    done = _runner(stand, "run", operation_id="20200101T000000Z-000000")

    assert done.returncode == 2
    assert "20200101T000000Z-000000" in done.stderr


def test_status_command_prints_the_status_file(stand) -> None:
    write_status(stand.panel.state, {"result": "committed", "module_id": "tool.terminal"})

    done = subprocess.run(
        [sys.executable, str(SHIPPED), "status", "--state-dir", str(stand.panel.state)],
        capture_output=True, text=True, timeout=60,
    )

    assert done.returncode == 0, done.stderr
    assert json.loads(done.stdout) == {"result": "committed", "module_id": "tool.terminal"}


def test_ensure_idle_blocks_while_an_operation_runs(stand) -> None:
    journal = _prepare(stand)
    journal.set_pid(_other_live_pid())

    with pytest.raises(ModuleTransactionError) as raised:
        launcher.ensure_idle(stand.panel.root, stand.panel.state)

    assert raised.value.code == "operation_in_progress"


def test_ensure_idle_blocks_while_the_panel_updates_itself(stand) -> None:
    lock_file = get_update_paths(str(stand.panel.state))["lock_file"]
    assert try_acquire_lock(lock_file)[0]
    try:
        with pytest.raises(ModuleTransactionError) as raised:
            launcher.ensure_idle(stand.panel.root, stand.panel.state)
    finally:
        os.remove(lock_file)

    assert raised.value.code == "operation_in_progress"


def test_launch_returns_id_and_status_reaches_committed(stand) -> None:
    plan = build_plan("install", "tool.terminal", **{**stand.panel.kwargs, "catalog": stand.release.catalog})

    operation_id = launcher.launch(
        plan,
        panel_root=stand.panel.root,
        state_dir=stand.panel.state,
        health_url=stand.health_url,
        restart_cmd=stand.restart_cmd,
        script=RUNNER,
        extra_args=["--release-dir", str(stand.release_dir), "--architecture", ARCHITECTURE],
    )

    assert read_status(stand.panel.state)["operation_id"] == operation_id
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline and read_status(stand.panel.state)["result"] == "running":
        time.sleep(0.2)
    status = read_status(stand.panel.state)
    assert status["result"] == "committed", status
    assert set(OWNERSHIP["tool.terminal"]) <= set(snapshot(stand.panel.root))


def test_launch_clears_a_dead_operation_first(stand) -> None:
    before = snapshot(stand.panel.root)
    journal = _prepare(stand)
    _runner(stand, "run", "--fail-at", "state", operation_id=journal.meta()["operation_id"])
    plan = build_plan("install", "tool.files", **{**stand.panel.kwargs, "catalog": stand.release.catalog})

    launcher.launch(
        plan, panel_root=stand.panel.root, state_dir=stand.panel.state, health_url=stand.health_url,
        restart_cmd=stand.restart_cmd, script=RUNNER,
        extra_args=["--release-dir", str(stand.release_dir), "--architecture", ARCHITECTURE],
    )

    deadline = time.monotonic() + 30
    while time.monotonic() < deadline and read_status(stand.panel.state)["result"] == "running":
        time.sleep(0.2)
    after = snapshot(stand.panel.root)
    assert read_status(stand.panel.state)["result"] == "committed"
    assert set(OWNERSHIP["tool.files"]) <= set(after)
    assert not set(OWNERSHIP["tool.terminal"]) & set(after)
    assert before["app.py"] == after["app.py"]


def test_recover_works_when_the_signature_library_cannot_be_imported(stand) -> None:
    """A broken Python dependency must not leave the panel half replaced at boot."""

    before = snapshot(stand.panel.root)
    journal = _prepare(stand)
    _runner(stand, "run", "--fail-at", "state", operation_id=journal.meta()["operation_id"])
    probe = (
        "import importlib.abc, importlib.util, sys\n"
        "class Block(importlib.abc.MetaPathFinder):\n"
        "    def find_spec(self, name, path=None, target=None):\n"
        "        if name.split('.')[0] == 'cryptography':\n"
        "            raise ImportError('cryptography is broken on this router')\n"
        "sys.meta_path.insert(0, Block())\n"
        "spec = importlib.util.spec_from_file_location('module_transaction', sys.argv[1])\n"
        "module = importlib.util.module_from_spec(spec)\n"
        "spec.loader.exec_module(module)\n"
        "raise SystemExit(module.main(['recover', '--panel-root', sys.argv[2], '--state-dir', sys.argv[3]]))\n"
    )

    done = subprocess.run(
        [sys.executable, "-c", probe, str(SHIPPED), str(stand.panel.root), str(stand.panel.state)],
        capture_output=True, text=True, timeout=60,
    )

    assert done.returncode == 0, done.stderr
    assert changed_paths(before, snapshot(stand.panel.root)) <= BOOKKEEPING
    assert read_status(stand.panel.state)["result"] == "rolled_back"


# -- находки итоговой проверки ветки ---------------------------------------


def test_run_refuses_an_operation_that_already_started(stand) -> None:
    journal = _prepare(stand)
    operation_id = journal.meta()["operation_id"]
    _runner(stand, "run", "--fail-at", "state", operation_id=operation_id)
    half_done = snapshot(stand.panel.root)
    kept = sorted(path.name for path in (journal.backup / "files").rglob("*") if path.is_file())

    again = _runner(stand, "run", operation_id=operation_id)

    assert again.returncode == 2, again.stderr
    assert "already started" in again.stderr
    assert snapshot(stand.panel.root) == half_done
    assert sorted(path.name for path in (journal.backup / "files").rglob("*") if path.is_file()) == kept


def test_recover_after_a_reboot_ignores_a_reused_pid(stand, monkeypatch) -> None:
    from services.module_transactions import journal as journal_module

    before = snapshot(stand.panel.root)
    journal = _prepare(stand)
    _runner(stand, "run", "--fail-at", "state", operation_id=journal.meta()["operation_id"])
    reopened = Journal.open(journal.dir)
    monkeypatch.setattr(journal_module, "current_boot_id", lambda: "before-the-power-cut")
    reopened.set_pid(_other_live_pid())
    monkeypatch.setattr(journal_module, "current_boot_id", lambda: "after-the-power-cut")

    assert recover(stand.panel.root, stand.panel.state) == "rolled_back"
    assert changed_paths(before, snapshot(stand.panel.root)) <= BOOKKEEPING


def _shipped(stand, command: str, *, state: bool = True) -> subprocess.CompletedProcess:
    args = [sys.executable, str(SHIPPED), command, "--panel-root", str(stand.panel.root)]
    if state:
        args += ["--state-dir", str(stand.panel.state)]
    return subprocess.run(args, capture_output=True, text=True, timeout=120)


def test_busy_answers_three_only_while_an_operation_is_carried(stand) -> None:
    assert _shipped(stand, "busy", state=False).returncode == 0

    journal = _prepare(stand)
    # Recorded a moment ago: its runner may not have reported yet.
    assert _shipped(stand, "busy", state=False).returncode == 3

    journal.set_pid(_other_live_pid())
    journal.set_step("applying")
    assert _shipped(stand, "busy", state=False).returncode == 3


def test_busy_does_not_hold_the_installer_for_a_dead_operation(stand) -> None:
    journal = _prepare(stand)
    _runner(stand, "run", "--fail-at", "applying", operation_id=journal.meta()["operation_id"])

    assert _shipped(stand, "busy", state=False).returncode == 0


def test_forget_drops_the_leftovers_and_closes_the_record(stand) -> None:
    journal = _prepare(stand)
    _runner(stand, "run", "--fail-at", "state", operation_id=journal.meta()["operation_id"])
    assert read_status(stand.panel.state)["result"] == "running"

    assert _shipped(stand, "forget").returncode == 0

    assert not transactions_root(stand.panel.root).exists()
    status = read_status(stand.panel.state)
    assert status["result"] == "interrupted"
    assert status["error_code"] == "operation_superseded"
    assert status["finished_at"]


def test_forget_keeps_the_record_of_a_finished_operation(stand) -> None:
    journal = _prepare(stand)
    assert _runner(stand, "run", operation_id=journal.meta()["operation_id"]).returncode == 0
    finished = read_status(stand.panel.state)

    assert _shipped(stand, "forget").returncode == 0

    assert read_status(stand.panel.state) == finished
