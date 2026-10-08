"""Обновление из панели делает ту же работу вне каталога панели, что и установщик.

Раньше оно меняло только файлы панели: библиотеки Python, служба автозапуска,
шаблоны и команды в /opt/bin оставались от прежней версии. Теперь исполнитель
дважды зовёт общий скрипт: `prepare` — до первого изменённого файла, `apply` —
после раскладки, перед перезапуском. При откате `apply` зовётся ещё раз, уже от
возвращённого прежнего скрипта.
"""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
from unittest.mock import patch

import pytest

from services.module_transactions import executor
from services.module_transactions.executor import run_operation
from services.module_transactions.journal import Journal
from services.module_transactions.plan import build_panel_update_plan, build_plan
from services.module_transactions.state import ModuleTransactionError, read_status
from services.panel_package_contract import validate_panel_archive
from tests.support.module_tx import ARCHITECTURE, file_bytes, make_panel, make_release, snapshot


OLD, NEW = "2.10.0", "2.11.0"
# Запись о ходе операции и кэш каталога — не файлы панели.
SERVICE_FOLDERS = ("module-operations/", "module-catalog/")


def _update_plan(tmp_path: Path, panel, release):
    archive = tmp_path / "checked" / "panel.tar.gz"
    archive.parent.mkdir(parents=True, exist_ok=True)
    archive.write_bytes(release.panel)
    listing = validate_panel_archive(archive, release.catalog["panel"], platform_architecture=ARCHITECTURE)
    return build_panel_update_plan(
        panel_root=panel.root, state_dir=panel.state, catalog=release.catalog,
        target_archive=listing, architecture=ARCHITECTURE, free_bytes=1 << 40,
    )


def _run(panel, plan, release, provision, *, restart=lambda: None, healthy=lambda _phase: True):
    journal = Journal.create(panel.root, plan, "provision-environment", extra={})
    return run_operation(
        journal,
        state_dir=panel.state,
        client=release.client(panel.state),
        architecture=ARCHITECTURE,
        restart=restart,
        wait_healthy=healthy,
        provision=provision,
    )


def test_update_prepares_before_any_file_changes_and_applies_before_the_restart(tmp_path):
    panel = make_panel(tmp_path, version=OLD)
    release = make_release(version=NEW)
    events: list[tuple[str, bytes]] = []

    def provision(phase: str, _script: Path) -> None:
        events.append((phase, panel.path("app.py").read_bytes()))

    def restart() -> None:
        events.append(("restart", panel.path("app.py").read_bytes()))

    result = _run(panel, _update_plan(tmp_path, panel, release), release, provision, restart=restart)

    assert result == "committed"
    assert events == [
        ("prepare", file_bytes("app.py", OLD)),
        ("apply", file_bytes("app.py", NEW)),
        ("restart", file_bytes("app.py", NEW)),
    ]


def test_an_environment_that_cannot_be_prepared_stops_the_update_before_it_starts(tmp_path):
    panel = make_panel(tmp_path, version=OLD)
    release = make_release(version=NEW)
    before = snapshot(panel.root)
    phases: list[str] = []

    def provision(phase: str, _script: Path) -> None:
        phases.append(phase)
        raise ModuleTransactionError("operation_environment_failed", "Не найден Entware (opkg).")

    result = _run(panel, _update_plan(tmp_path, panel, release), release, provision)

    status = read_status(panel.state)
    assert result == "interrupted"
    assert phases == ["prepare"]
    assert status["error_code"] == "operation_environment_failed"
    assert "Entware" in status["error"]
    after = snapshot(panel.root)
    assert {path: body for path, body in after.items() if not path.startswith(SERVICE_FOLDERS)} == {
        path: body for path, body in before.items() if not path.startswith(SERVICE_FOLDERS)
    }


def test_a_failed_apply_rolls_the_files_back_and_restores_the_environment(tmp_path):
    panel = make_panel(tmp_path, version=OLD)
    release = make_release(version=NEW)
    phases: list[tuple[str, bytes]] = []

    def provision(phase: str, _script: Path) -> None:
        phases.append((phase, panel.path("app.py").read_bytes()))
        if phase == "apply" and len([name for name, _body in phases if name == "apply"]) == 1:
            raise ModuleTransactionError("operation_environment_failed", "служба автозапуска не записалась")

    result = _run(panel, _update_plan(tmp_path, panel, release), release, provision)

    assert result == "rolled_back"
    assert panel.path("app.py").read_bytes() == file_bytes("app.py", OLD)
    # Второй apply — уже на возвращённых прежних файлах: он возвращает и то,
    # что первый успел поменять вне каталога панели.
    assert [name for name, _body in phases] == ["prepare", "apply", "apply"]
    assert phases[-1][1] == file_bytes("app.py", OLD)


def test_a_panel_that_did_not_come_up_gets_its_previous_environment_back(tmp_path):
    panel = make_panel(tmp_path, version=OLD)
    release = make_release(version=NEW)
    phases: list[str] = []

    result = _run(
        panel, _update_plan(tmp_path, panel, release), release,
        lambda phase, _script: phases.append(phase),
        healthy=lambda phase: phase == "rollback",
    )

    assert result == "rolled_back"
    assert phases == ["prepare", "apply", "apply"]


def test_a_failure_to_restore_the_environment_does_not_hide_the_rollback(tmp_path):
    panel = make_panel(tmp_path, version=OLD)
    release = make_release(version=NEW)
    calls: list[str] = []

    def provision(phase: str, _script: Path) -> None:
        calls.append(phase)
        if calls.count("apply") == 2:
            raise OSError("no shell")

    result = _run(panel, _update_plan(tmp_path, panel, release), release, provision,
                  healthy=lambda phase: phase == "rollback")

    assert result == "rolled_back"
    assert read_status(panel.state)["environment_restored"] is False


def test_a_module_operation_applies_but_has_nothing_to_prepare(tmp_path):
    panel = make_panel(tmp_path)
    release = make_release()
    plan = build_plan("install", "tool.terminal", **{**panel.kwargs, "catalog": release.catalog})
    phases: list[str] = []

    result = _run(panel, plan, release, lambda phase, _script: phases.append(phase))

    # Библиотеки нужны релизу, а не модулю; модулю — его пакеты Entware (до
    # раскладки файлов), а после неё команды и шаблоны.
    assert result == "committed"
    assert phases == ["packages", "apply"]


def test_packages_that_could_not_be_brought_do_not_stop_the_module(tmp_path):
    panel = make_panel(tmp_path)
    release = make_release()
    plan = build_plan("install", "tool.files", **{**panel.kwargs, "catalog": release.catalog})
    phases: list[str] = []

    def provision(phase: str, _script: Path) -> None:
        phases.append(phase)
        if phase == "packages":
            raise ModuleTransactionError("operation_environment_failed", "источник пакетов не ответил")

    result = _run(panel, plan, release, provision)

    # Модуль работает и без пакета: он ставится, а нехватка остаётся в журнале.
    assert result == "committed"
    assert phases == ["packages", "apply"]
    assert panel.path("static/js/pages/file_manager.lazy.entry.js").is_file()


def test_removing_a_module_brings_no_packages(tmp_path):
    panel = make_panel(tmp_path, installed=("core", "tool.editor", "engine.xray", "tool.files"))
    plan = build_plan("remove", "tool.files", **panel.kwargs)
    phases: list[str] = []

    result = _run(panel, plan, make_release(), lambda phase, _script: phases.append(phase))

    assert result == "committed"
    assert "packages" not in phases


def test_the_runner_tells_the_script_what_the_operation_is_about(tmp_path):
    cli = _cli()
    panel = make_panel(tmp_path, version=OLD)
    trace = tmp_path / "trace.txt"
    script = panel.root / "scripts" / "provision_env.sh"
    script.parent.mkdir(parents=True, exist_ok=True)
    script.write_bytes(
        (
            '#!/bin/sh\necho "$1 target=[${XKEEN_UI_TARGET_VERSION:-}] module=[${XKEEN_UI_OPERATION_MODULE:-}]" >> "'
            + trace.as_posix()
            + '"\n'
        ).encode("utf-8")
    )

    with patch.dict(os.environ, {"XKEEN_UI_TARGET_VERSION": "9.9.9", "XKEEN_UI_OPERATION_MODULE": "tool.stale"}):
        cli.build_provision(panel.root, target_version=NEW)("prepare", script)
        cli.build_provision(panel.root, module_id="tool.files")("packages", script)

    # Значения, оставшиеся в окружении панели от другой операции, не подхватываются.
    assert trace.read_text(encoding="utf-8").splitlines() == [
        f"prepare target=[{NEW}] module=[]",
        "packages target=[] module=[tool.files]",
    ]


def test_the_release_brings_its_own_script_for_the_preparation(tmp_path):
    panel = make_panel(tmp_path)
    plan = build_plan("repair", "engine.xray", **panel.kwargs)
    journal = Journal.create(panel.root, plan, "script-choice", extra={})
    installed = panel.root / "scripts" / "provision_env.sh"

    assert executor.provision_script(journal, staged=True) == installed

    staged = journal.staging / "payload" / "scripts" / "provision_env.sh"
    staged.parent.mkdir(parents=True)
    staged.write_text("#!/bin/sh\n", encoding="utf-8")

    # Новому релизу виднее, что ему нужно; если скрипт не менялся — берётся установленный.
    assert executor.provision_script(journal, staged=True) == staged
    assert executor.provision_script(journal, staged=False) == installed


def test_update_keeps_the_owners_repository_and_channel(tmp_path):
    panel = make_panel(tmp_path, version=OLD)
    build = panel.read_json("BUILD.json")
    panel.path("BUILD.json").write_text(
        json.dumps({**build, "repo": "someone/fork", "channel": "beta", "tree_sha256": "a" * 64}), encoding="utf-8"
    )
    release = make_release(version=NEW)

    assert _run(panel, _update_plan(tmp_path, panel, release), release, None) == "committed"

    written = panel.read_json("BUILD.json")
    assert (written["version"], written["repo"], written["channel"]) == (NEW, "someone/fork", "beta")
    # Сумма дерева прежней сборки новой не принадлежит.
    assert "tree_sha256" not in written or written["tree_sha256"] is None


# --- исполнитель как программа ---------------------------------------------------------


def _cli():
    script = Path(__file__).resolve().parents[1] / "xkeen-ui" / "scripts" / "module_transaction.py"
    spec = importlib.util.spec_from_file_location("module_transaction_cli_provision", script)
    cli = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cli)
    return cli


def test_the_runner_calls_the_shared_script_of_the_panel(tmp_path):
    cli = _cli()
    panel = make_panel(tmp_path, version=OLD)
    trace = tmp_path / "trace.txt"
    script = panel.root / "scripts" / "provision_env.sh"
    script.parent.mkdir(parents=True, exist_ok=True)
    script.write_bytes(
        f'#!/bin/sh\necho "$1 ui=$UI_DIR python=$PYTHON_BIN" >> "{trace.as_posix()}"\n'.encode("utf-8")
    )

    provision = cli.build_provision(panel.root)
    provision("apply", script)

    line = trace.read_text(encoding="utf-8").strip()
    assert line.startswith("apply ui=")
    assert Path(line.split("ui=", 1)[1].split(" python=", 1)[0]) == panel.root
    assert line.split("python=", 1)[1]


def test_the_runner_reports_the_reason_the_script_gave(tmp_path):
    cli = _cli()
    panel = make_panel(tmp_path, version=OLD)
    script = panel.root / "scripts" / "provision_env.sh"
    script.parent.mkdir(parents=True, exist_ok=True)
    script.write_bytes(
        '#!/bin/sh\necho "[*] проверяю"\necho "[!] Не найден Entware (opkg)."\necho "ещё строка"\nexit 1\n'.encode("utf-8")
    )

    with pytest.raises(ModuleTransactionError) as raised:
        cli.build_provision(panel.root)("prepare", script)

    assert raised.value.code == "operation_environment_failed"
    assert raised.value.message == "Не найден Entware (opkg)."


def test_a_panel_without_the_shared_script_is_updated_as_before(tmp_path):
    cli = _cli()
    panel = make_panel(tmp_path, version=OLD)

    # Панель, поставленная до появления общего скрипта: звать нечего.
    cli.build_provision(panel.root)("apply", panel.root / "scripts" / "provision_env.sh")
