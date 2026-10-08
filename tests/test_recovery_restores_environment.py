"""Возврат прерванной операции возвращает и то, что лежит вне каталога панели.

Исполнитель после отката сам зовёт общий скрипт прежней версии. Но операцию,
исполнитель которой погиб (пропало питание), возвращает служба автозапуска или
сама панель — и там прежние файлы возвращались, а служба, шаблоны и команды в
/opt/bin оставались от релиза, который не встал.
"""

from __future__ import annotations

import importlib.util
import threading
from pathlib import Path

import pytest

from services.module_transactions import launcher
from services.module_transactions.executor import recover
from services.module_transactions.journal import Journal
from services.module_transactions.plan import build_plan
from services.module_transactions.state import ModuleTransactionError, read_status, write_status
from tests.support.module_tx import ARCHITECTURE, make_panel, make_release


def _abandoned(tmp_path: Path, step: str):
    """Операция, исполнитель которой погиб на шаге ``step``."""

    panel = make_panel(tmp_path)
    plan = build_plan(
        "install", "tool.terminal",
        panel_root=panel.root, state_dir=panel.state, catalog=make_release().catalog,
        architecture=ARCHITECTURE, free_bytes=1 << 40,
    )
    journal = Journal.create(panel.root, plan, "abandoned-operation", extra={})
    journal.set_step(step)
    return panel


class Recorder:
    def __init__(self, error: Exception | None = None) -> None:
        self.calls: list[tuple[str, Path]] = []
        self.error = error

    def __call__(self, phase: str, script: Path):
        self.calls.append((phase, Path(script)))
        if self.error is not None:
            raise self.error
        return []


@pytest.mark.parametrize("step", ["state", "restarting", "health", "rolling_back"])
def test_an_undone_operation_gets_its_previous_environment_back(tmp_path, step):
    panel = _abandoned(tmp_path, step)
    provision = Recorder()

    assert recover(panel.root, panel.state, provision=provision) == "rolled_back"

    assert provision.calls == [("apply", panel.root / "scripts" / "provision_env.sh")]
    assert "environment_restored" not in read_status(panel.state)


@pytest.mark.parametrize("step", ["prepared", "downloading", "verifying", "applying"])
def test_an_operation_that_never_reached_the_environment_calls_nothing(tmp_path, step):
    panel = _abandoned(tmp_path, step)
    provision = Recorder()

    recover(panel.root, panel.state, provision=provision)

    assert provision.calls == []


def test_an_environment_that_could_not_be_restored_does_not_hide_the_undo(tmp_path):
    panel = _abandoned(tmp_path, "health")
    provision = Recorder(ModuleTransactionError("operation_environment_failed", "нет opkg"))

    assert recover(panel.root, panel.state, provision=provision) == "rolled_back"

    status = read_status(panel.state)
    assert (status["result"], status["environment_restored"]) == ("rolled_back", False)
    assert Journal.find(panel.root) is None


def test_recovery_without_a_script_runner_works_as_before(tmp_path):
    panel = _abandoned(tmp_path, "health")

    assert recover(panel.root, panel.state) == "rolled_back"


# --- кто зовёт возврат ---------------------------------------------------------------------


def _trace_script(panel, trace: Path) -> None:
    script = panel.root / "scripts" / "provision_env.sh"
    script.parent.mkdir(parents=True, exist_ok=True)
    script.write_bytes(f'#!/bin/sh\necho "$1" >> "{trace.as_posix()}"\n'.encode("utf-8"))


def _cli():
    script = Path(__file__).resolve().parents[1] / "xkeen-ui" / "scripts" / "module_transaction.py"
    spec = importlib.util.spec_from_file_location("module_transaction_cli_recovery", script)
    cli = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cli)
    return cli


def test_the_boot_command_restores_the_environment(tmp_path):
    panel = _abandoned(tmp_path, "health")
    trace = tmp_path / "trace.txt"
    _trace_script(panel, trace)

    code = _cli().main(["recover", "--panel-root", str(panel.root), "--state-dir", str(panel.state)])

    assert code == 0
    assert trace.read_text(encoding="utf-8").split() == ["apply"]


def test_the_panel_restores_the_environment_when_it_finds_a_dead_runner(tmp_path):
    panel = _abandoned(tmp_path, "health")
    trace = tmp_path / "trace.txt"
    _trace_script(panel, trace)
    write_status(panel.state, {"operation_id": "abandoned-operation", "result": "running", "step": "health"})

    status = launcher.observe_status(panel.root, panel.state)

    assert status["result"] == "rolled_back"
    assert status["restart_required"] is True
    assert trace.read_text(encoding="utf-8").split() == ["apply"]


def test_two_looks_at_a_dead_runner_do_not_undo_it_twice_at_once(tmp_path, monkeypatch):
    panel = _abandoned(tmp_path, "health")
    write_status(panel.state, {"operation_id": "abandoned-operation", "result": "running", "step": "health"})
    entered, release = threading.Event(), threading.Event()
    calls: list[str] = []
    real = launcher.recover

    def slow(*args, **kwargs):
        calls.append("recover")
        entered.set()
        assert release.wait(10)
        return real(*args, **kwargs)

    monkeypatch.setattr(launcher, "recover", slow)
    first = threading.Thread(target=launcher.observe_status, args=(panel.root, panel.state))
    first.start()
    assert entered.wait(10)

    # Второй опрос, пока первый возвращает файлы: видит «выполняется» и не мешает.
    second = launcher.observe_status(panel.root, panel.state)

    release.set()
    first.join(10)
    assert second["result"] == "running"
    assert calls == ["recover"]
    assert read_status(panel.state)["result"] == "rolled_back"
