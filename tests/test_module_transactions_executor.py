from __future__ import annotations

import http.server
import json
import threading
from pathlib import Path

import pytest

from services.module_catalog_client import CatalogTransportError
from services.module_transactions.executor import OperationCancelled, run_operation, wait_for_panel
from services.module_transactions.journal import Journal
from services.module_transactions.plan import build_plan
from services.module_transactions.state import read_status
from tests.support.module_tx import (
    ARCHITECTURE,
    FRONTEND,
    OWNERSHIP,
    STATE_PATHS,
    changed_paths,
    file_bytes,
    make_panel,
    make_release,
    module_archive,
    snapshot,
)


INSTALLED_WITH_TERMINAL = ("core", "tool.editor", "engine.xray", "tool.terminal")


class Recorder:
    """A panel that is restarted and probed, without a real process behind it."""

    def __init__(self, healthy: list[bool] | None = None) -> None:
        self.restarts = 0
        self.probes: list[str] = []
        self._healthy = list(healthy or [])

    def restart(self) -> None:
        self.restarts += 1

    def wait_healthy(self, phase: str) -> bool:
        self.probes.append(phase)
        return self._healthy.pop(0) if self._healthy else True


def _run(panel, release, operation: str, module_id: str, recorder: Recorder | None = None, **kwargs):
    recorder = recorder or Recorder()
    plan = build_plan(operation, module_id, **{**panel.kwargs, "catalog": release.catalog})
    journal = Journal.create(panel.root, plan, "20261005T000000Z-abcdef", extra={})
    result = run_operation(
        journal,
        state_dir=panel.state,
        client=release.client(panel.state),
        architecture=ARCHITECTURE,
        restart=recorder.restart,
        wait_healthy=recorder.wait_healthy,
        **kwargs,
    )
    return result, journal, recorder


def test_install_commits_and_changes_only_manifest_files_and_state(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    release = make_release()
    before = snapshot(panel.root)

    result, journal, recorder = _run(panel, release, "install", "tool.terminal")

    assert result == "committed"
    assert not journal.dir.exists()
    after = snapshot(panel.root)
    assert changed_paths(before, after) <= set(OWNERSHIP["tool.terminal"]) | STATE_PATHS | {"module-catalog/catalog-2.10.0.json", "module-operations/status.json"}
    for relative in OWNERSHIP["tool.terminal"]:
        assert after[relative] == file_bytes(relative)
    assert panel.read_json("module-installed.json")["modules"]["tool.terminal"] is True
    assert panel.read_json("install-profile.json")["profile"] == "custom"
    assert (recorder.restarts, recorder.probes) == (1, ["operation"])
    status = read_status(panel.state)
    assert status["result"] == "committed" and status["step"] == "committed"
    assert (status["operation"], status["module_id"], status["operation_id"]) == ("install", "tool.terminal", "20261005T000000Z-abcdef")
    assert status["error_code"] is None
    assert [item["step"] for item in status["log"]] == [
        "prepared", "downloading", "verifying", "applying", "state", "restarting", "health", "committed",
    ]
    assert status["finished_at"] >= status["started_at"]


def test_install_of_a_page_module_restores_its_bridge_entry(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    release = make_release()

    result, _, _ = _run(panel, release, "install", "tool.backups")

    assert result == "committed"
    assert panel.read_json("static/frontend-build/.vite/manifest.json") == FRONTEND["bridge"]
    assert panel.read_json("static/frontend-build/.vite/manifest.build.json") == FRONTEND["build"]


def test_installed_gz_is_served(tmp_path: Path) -> None:
    from routes.ui_assets import resolve_precompressed_static

    panel = make_panel(tmp_path)

    _run(panel, make_release(), "install", "tool.terminal")

    packed = panel.path("static/js/pages/terminal.lazy.entry.js.gz")
    assert resolve_precompressed_static(str(panel.root / "static"), "js/pages/terminal.lazy.entry.js", "gzip") == str(packed)


def test_remove_commits_and_leaves_other_modules_untouched(tmp_path: Path) -> None:
    panel = make_panel(tmp_path, installed=INSTALLED_WITH_TERMINAL)
    release = make_release()
    before = snapshot(panel.root)

    result, journal, recorder = _run(panel, release, "remove", "tool.terminal")

    assert result == "committed"
    after = snapshot(panel.root)
    assert not set(OWNERSHIP["tool.terminal"]) & set(after)
    assert changed_paths(before, after) <= set(OWNERSHIP["tool.terminal"]) | STATE_PATHS | {"module-operations/status.json"}
    assert panel.read_json("modules.json")["modules"]["tool.terminal"]["enabled"] is False
    assert release.transport.calls == []
    assert [item["step"] for item in read_status(panel.state)["log"]] == [
        "prepared", "applying", "state", "restarting", "health", "committed",
    ]
    assert recorder.restarts == 1


def test_repair_brings_back_a_damaged_file(tmp_path: Path) -> None:
    panel = make_panel(tmp_path, installed=INSTALLED_WITH_TERMINAL)
    before = snapshot(panel.root)
    panel.path("services/ws_pty.py").write_bytes(b"damaged")
    panel.path("static/js/terminal/_core.js").unlink()

    result, _, _ = _run(panel, make_release(), "repair", "tool.terminal")

    assert result == "committed"
    after = snapshot(panel.root)
    assert changed_paths(before, after) <= {"module-catalog/catalog-2.10.0.json", "module-operations/status.json"}


def test_health_failure_rolls_back_byte_for_byte(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    before = snapshot(panel.root)

    result, journal, recorder = _run(panel, make_release(), "install", "tool.terminal", Recorder([False, True]))

    assert result == "rolled_back"
    assert not journal.dir.exists()
    after = snapshot(panel.root)
    assert changed_paths(before, after) <= {"module-catalog/catalog-2.10.0.json", "module-operations/status.json"}
    assert (recorder.restarts, recorder.probes) == (2, ["operation", "rollback"])
    status = read_status(panel.state)
    assert (status["result"], status["error_code"]) == ("rolled_back", "operation_health_failed")
    assert status.get("panel_unresponsive") is False


def test_health_failure_twice_reports_panel_unresponsive(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    before = snapshot(panel.root)

    result, journal, _ = _run(panel, make_release(), "install", "tool.terminal", Recorder([False, False]))

    assert result == "rolled_back"
    assert not journal.dir.exists()
    assert changed_paths(before, snapshot(panel.root)) <= {"module-catalog/catalog-2.10.0.json", "module-operations/status.json"}
    assert read_status(panel.state)["panel_unresponsive"] is True


def test_failed_restart_command_rolls_back(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    before = snapshot(panel.root)
    recorder = Recorder()
    calls = {"count": 0}

    def restart() -> None:
        calls["count"] += 1
        if calls["count"] == 1:
            raise OSError("init script is gone")

    plan = build_plan("install", "tool.terminal", **panel.kwargs)
    journal = Journal.create(panel.root, plan, "20261005T000000Z-abcdef", extra={})
    result = run_operation(
        journal, state_dir=panel.state, client=make_release().client(panel.state), architecture=ARCHITECTURE,
        restart=restart, wait_healthy=recorder.wait_healthy,
    )

    assert result == "rolled_back"
    assert calls["count"] == 2
    assert changed_paths(before, snapshot(panel.root)) <= {"module-catalog/catalog-2.10.0.json", "module-operations/status.json"}


def test_failure_before_any_restart_rolls_back_without_restarting(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    before = snapshot(panel.root)
    panel.path("services/ws_pty.py").mkdir(parents=True)

    result, journal, recorder = _run(panel, make_release(), "install", "tool.terminal")

    assert result == "rolled_back"
    assert (recorder.restarts, recorder.probes) == (0, [])
    panel.path("services/ws_pty.py").rmdir()
    panel.path("services").rmdir() if not any(panel.path("services").iterdir()) else None
    assert read_status(panel.state)["error_code"] == "operation_target_unsafe"
    assert not journal.dir.exists()
    assert set(changed_paths(before, snapshot(panel.root))) <= {"module-catalog/catalog-2.10.0.json", "module-operations/status.json"}


def test_rollback_failure_keeps_the_operation_directory(tmp_path: Path, monkeypatch) -> None:
    from services.module_transactions import journal as journal_module

    panel = make_panel(tmp_path, installed=INSTALLED_WITH_TERMINAL)
    release = make_release()
    recorder = Recorder([False])
    plan = build_plan("repair", "tool.terminal", **{**panel.kwargs, "catalog": release.catalog})
    journal = Journal.create(panel.root, plan, "20261005T000000Z-abcdef", extra={})
    real_rollback = journal_module.Journal.rollback

    def failing_rollback(self):
        from services.module_transactions.state import ModuleTransactionError

        raise ModuleTransactionError("operation_rollback_failed", "cannot restore", path="services/ws_pty.py", error="Read-only file system")

    monkeypatch.setattr(journal_module.Journal, "rollback", failing_rollback)

    result = run_operation(
        journal, state_dir=panel.state, client=release.client(panel.state), architecture=ARCHITECTURE,
        restart=recorder.restart, wait_healthy=recorder.wait_healthy,
    )

    monkeypatch.setattr(journal_module.Journal, "rollback", real_rollback)
    assert result == "rollback_failed"
    assert journal.dir.is_dir()
    status = read_status(panel.state)
    assert (status["result"], status["error_code"]) == ("rollback_failed", "operation_health_failed")
    assert status["failed_path"] == "services/ws_pty.py"
    assert "Read-only" in status["failed_error"]
    # The panel is restarted anyway: it may still work in the mixed state.
    assert recorder.restarts == 2


def test_checksum_mismatch_leaves_root_untouched(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    release = make_release()
    release.transport.responses[release.archive_url("tool.terminal")] = b"x" * len(release.archives["tool.terminal"])
    before = snapshot(panel.root)

    result, journal, recorder = _run(panel, release, "install", "tool.terminal")

    assert result == "interrupted"
    assert not journal.dir.exists()
    assert changed_paths(before, snapshot(panel.root)) <= {"module-catalog/catalog-2.10.0.json", "module-operations/status.json"}
    assert read_status(panel.state)["error_code"] == "catalog_archive_checksum_mismatch"
    assert recorder.restarts == 0


def test_transport_drop_mid_download_leaves_root_untouched(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    release = make_release()
    release.transport.truncate.add(release.archive_url("tool.terminal"))
    before = snapshot(panel.root)

    result, journal, recorder = _run(panel, release, "install", "tool.terminal")

    assert result == "interrupted"
    assert not journal.dir.exists()
    assert changed_paths(before, snapshot(panel.root)) <= {"module-catalog/catalog-2.10.0.json", "module-operations/status.json"}
    assert read_status(panel.state)["error_code"]
    assert recorder.restarts == 0


def test_offline_catalog_leaves_root_untouched(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    release = make_release()
    for url in list(release.transport.responses):
        release.transport.fail[url] = CatalogTransportError("catalog_transport_failed", "offline")
    before = snapshot(panel.root)

    result, journal, _ = _run(panel, release, "install", "tool.terminal")

    assert result == "interrupted"
    assert changed_paths(before, snapshot(panel.root)) <= {"module-operations/status.json"}
    assert read_status(panel.state)["error_code"] == "catalog_unavailable"


def test_archive_that_disagrees_with_the_ownership_map_is_refused(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    foreign = dict(OWNERSHIP)
    foreign["tool.terminal"] = (*OWNERSHIP["tool.terminal"], "app.py")
    probe = make_release()
    entry = next(item for item in probe.catalog["modules"] if item["id"] == "tool.terminal")
    release = make_release(archives={"tool.terminal": module_archive("tool.terminal", "2.10.0", foreign, entry)})
    before = snapshot(panel.root)

    result, journal, _ = _run(panel, release, "install", "tool.terminal")

    assert result == "interrupted"
    assert read_status(panel.state)["error_code"] == "module_ownership_conflict"
    assert snapshot(panel.root)["app.py"] == before["app.py"]
    assert not journal.dir.exists()


def test_catalog_that_changed_since_the_plan_is_refused(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    planned = make_release()
    served = make_release(archives={"tool.terminal": planned.archives["tool.terminal"] + b"\0"})
    plan = build_plan("install", "tool.terminal", **{**panel.kwargs, "catalog": planned.catalog})
    journal = Journal.create(panel.root, plan, "20261005T000000Z-abcdef", extra={})
    recorder = Recorder()

    result = run_operation(
        journal, state_dir=panel.state, client=served.client(panel.state), architecture=ARCHITECTURE,
        restart=recorder.restart, wait_healthy=recorder.wait_healthy,
    )

    assert result == "interrupted"
    assert read_status(panel.state)["error_code"] == "module_version_mismatch"


@pytest.mark.parametrize("step", ["prepared", "downloading", "verifying"])
def test_cancel_before_applying_leaves_root_untouched(tmp_path: Path, step: str) -> None:
    panel = make_panel(tmp_path)
    before = snapshot(panel.root)

    def cancel(current: str) -> None:
        if current == step:
            raise OperationCancelled()

    result, journal, recorder = _run(panel, make_release(), "install", "tool.terminal", on_step=cancel)

    assert result == "interrupted"
    assert not journal.dir.exists()
    assert changed_paths(before, snapshot(panel.root)) <= {"module-catalog/catalog-2.10.0.json", "module-operations/status.json"}
    assert read_status(panel.state)["error_code"] == "operation_cancelled"
    assert recorder.restarts == 0


@pytest.mark.parametrize("step", ["state", "restarting", "health"])
def test_cancel_after_applying_rolls_back(tmp_path: Path, step: str) -> None:
    panel = make_panel(tmp_path)
    before = snapshot(panel.root)

    def cancel(current: str) -> None:
        if current == step:
            raise OperationCancelled()

    result, journal, _ = _run(panel, make_release(), "install", "tool.terminal", on_step=cancel)

    assert result == "rolled_back"
    assert not journal.dir.exists()
    assert changed_paths(before, snapshot(panel.root)) <= {"module-catalog/catalog-2.10.0.json", "module-operations/status.json"}
    assert read_status(panel.state)["error_code"] == "operation_cancelled"


class _Health(http.server.BaseHTTPRequestHandler):
    status = 200

    def do_GET(self) -> None:  # noqa: N802
        self.send_response(type(self).status)
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *_args) -> None:
        return None


@pytest.fixture
def health_server():
    _Health.status = 200
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Health)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}/api/auth/status"
    finally:
        server.shutdown()
        server.server_close()


def test_wait_for_panel_requires_200_and_no_last_error(tmp_path: Path, health_server: str) -> None:
    panel = make_panel(tmp_path, installed=INSTALLED_WITH_TERMINAL)

    assert wait_for_panel(health_server, panel.state, "tool.terminal", "install", timeout_s=5) is True

    modules = panel.read_json("modules.json")
    modules["modules"]["tool.terminal"]["last_error"] = "ImportError: boom"
    panel.path("modules.json").write_text(json.dumps(modules), encoding="utf-8")

    assert wait_for_panel(health_server, panel.state, "tool.terminal", "install", timeout_s=5) is False
    # After a removal or an undo the module is not expected to be there at all.
    assert wait_for_panel(health_server, panel.state, "tool.terminal", "remove", timeout_s=5) is True
    assert wait_for_panel(health_server, panel.state, "tool.terminal", "install", timeout_s=5, check_module=False) is True


def test_wait_for_panel_checks_every_full_scope_target_module(tmp_path: Path, health_server: str) -> None:
    panel = make_panel(tmp_path)
    state = panel.read_json("modules.json")
    state["modules"]["engine.xray"]["last_error"] = "failed activation"
    panel.path("modules.json").write_text(json.dumps(state), encoding="utf-8")

    assert wait_for_panel(
        health_server,
        panel.state,
        None,
        "profile-transition",
        timeout_s=5,
        target_module_ids=("core", "engine.xray", "tool.editor"),
    ) is False


def test_wait_for_panel_gives_up_when_the_panel_answers_with_an_error(tmp_path: Path, health_server: str) -> None:
    panel = make_panel(tmp_path)
    _Health.status = 500
    naps: list[float] = []

    assert wait_for_panel(health_server, panel.state, "tool.terminal", "install", timeout_s=0.3, sleep=naps.append) is False
    assert naps, "the probe must retry until the deadline"


def test_wait_for_panel_gives_up_when_nothing_listens(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)

    assert wait_for_panel("http://127.0.0.1:9/api/auth/status", panel.state, "tool.terminal", "install",
                          timeout_s=0.2, sleep=lambda _seconds: None) is False


# -- находки итоговой проверки ветки ---------------------------------------


def test_cancel_after_the_panel_is_confirmed_does_not_undo_the_operation(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)

    def cancel(current: str) -> None:
        if current == "committed":
            raise OperationCancelled()

    result, journal, recorder = _run(panel, make_release(), "install", "tool.terminal", on_step=cancel)

    assert result == "committed"
    assert not journal.dir.exists()
    assert set(OWNERSHIP["tool.terminal"]) <= set(snapshot(panel.root))
    assert panel.read_json("module-installed.json")["modules"]["tool.terminal"] is True
    assert read_status(panel.state)["result"] == "committed"
    assert recorder.restarts == 1


def test_shield_is_raised_before_confirming_and_before_undoing(tmp_path: Path) -> None:
    calls: list[str] = []
    panel = make_panel(tmp_path / "first")
    _run(panel, make_release(), "install", "tool.terminal", shield=lambda: calls.append("shield"))
    assert calls == ["shield"]

    calls.clear()
    other = make_panel(tmp_path / "second")
    result, _, _ = _run(
        other, make_release(), "install", "tool.terminal", Recorder([False, True]), shield=lambda: calls.append("shield")
    )
    assert result == "rolled_back"
    assert calls == ["shield"]


def test_status_write_failure_after_confirmation_keeps_the_result(tmp_path: Path, monkeypatch) -> None:
    from services.module_transactions import executor as executor_module

    panel = make_panel(tmp_path)
    real_write = executor_module.write_status

    def write_until_committed(state_dir, status):
        if status.get("step") == "committed":
            raise OSError("No space left on device")
        return real_write(state_dir, status)

    monkeypatch.setattr(executor_module, "write_status", write_until_committed)

    result, journal, recorder = _run(panel, make_release(), "install", "tool.terminal")

    assert result == "committed"
    assert not journal.dir.exists()
    assert set(OWNERSHIP["tool.terminal"]) <= set(snapshot(panel.root))
    assert recorder.restarts == 1


def test_everything_is_flushed_before_the_restart_and_before_confirming(tmp_path: Path, monkeypatch) -> None:
    from services.module_transactions import journal as journal_module

    panel = make_panel(tmp_path)
    order: list[str] = []
    monkeypatch.setattr(journal_module.os, "sync", lambda: order.append("sync"), raising=False)
    recorder = Recorder()
    real_restart = recorder.restart

    def restart() -> None:
        order.append("restart")
        real_restart()

    recorder.restart = restart

    result, _, _ = _run(panel, make_release(), "install", "tool.terminal", recorder)

    assert result == "committed"
    assert order.index("sync") < order.index("restart")
    assert "sync" in order[order.index("restart"):]
