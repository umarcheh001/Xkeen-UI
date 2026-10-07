from __future__ import annotations

from dataclasses import replace
import errno
import json
import os
import shutil
from pathlib import Path

import pytest

from services.module_transactions import journal as journal_module
from services.module_transactions.journal import Journal
from services.module_transactions.plan import build_plan
from services.module_transactions.state import ModuleTransactionError, transactions_root
from tests.support.module_tx import OWNERSHIP, file_bytes, make_panel, set_mtime, snapshot


def _staged(tmp_path: Path, relative: str, payload: bytes | None = None) -> Path:
    source = tmp_path / "incoming" / Path(*relative.split("/"))
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_bytes(payload if payload is not None else b"new " + relative.encode())
    return source


def _install_journal(tmp_path: Path, panel, module_id: str = "tool.terminal", operation: str = "install") -> Journal:
    plan = build_plan(operation, module_id, **panel.kwargs)
    return Journal.create(panel.root, plan, "20261005T000000Z-abcdef", extra={"health_url": "http://127.0.0.1:1/"})


def _apply_everything(tmp_path: Path, panel, journal: Journal) -> None:
    for relative in journal.plan.files_add:
        journal.apply_file(relative, _staged(tmp_path, relative))
    journal.write_state_file("modules.json", b'{"changed": true}\n')
    journal.write_state_file("brand-new-state.json", b"{}\n")


@pytest.fixture(params=["hardlink", "copy"])
def backup_mode(request, monkeypatch) -> str:
    if request.param == "copy":
        def no_links(*_args, **_kwargs):
            raise OSError(errno.EPERM, "links are not supported here")

        monkeypatch.setattr(journal_module.os, "link", no_links)
    return request.param


def test_create_writes_the_plan_next_to_the_panel(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)

    journal = _install_journal(tmp_path, panel)

    assert journal.dir == transactions_root(panel.root) / "20261005T000000Z-abcdef"
    assert journal.staging.is_dir() and journal.backup.is_dir()
    meta = journal.meta()
    assert meta["step"] == "prepared"
    assert meta["health_url"] == "http://127.0.0.1:1/"
    assert meta["plan"]["module_id"] == "tool.terminal"
    assert Journal.find(panel.root) == journal.dir
    assert snapshot(panel.root) == snapshot(panel.root)


def test_find_returns_none_without_an_operation(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)

    assert Journal.find(panel.root) is None
    transactions_root(panel.root).mkdir()
    assert Journal.find(panel.root) is None


def test_open_restores_the_plan_and_step(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    journal = _install_journal(tmp_path, panel)
    journal.set_step("applying")
    journal.set_pid(4242)

    reopened = Journal.open(journal.dir)

    assert reopened.plan == journal.plan
    assert reopened.panel_root == panel.root
    assert reopened.meta()["step"] == "applying"
    assert reopened.meta()["pid"] == 4242


def test_open_accepts_stage_8_3_plan_without_scope_fields(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    journal = _install_journal(tmp_path, panel)
    record = json.loads((journal.dir / "operation.json").read_text(encoding="utf-8"))
    for field in ("scope", "source_version", "target_version", "target_profile"):
        record["plan"].pop(field)
    (journal.dir / "operation.json").write_text(json.dumps(record), encoding="utf-8")

    reopened = Journal.open(journal.dir)

    assert reopened.plan.scope == "module"
    assert reopened.plan.source_version == reopened.plan.version


@pytest.mark.parametrize("scope,operation", [("panel", "panel-update"), ("profile", "profile-transition")])
def test_full_scope_journal_round_trip_keeps_path_constraints(
    tmp_path: Path, scope: str, operation: str
) -> None:
    panel = make_panel(tmp_path)
    module_journal = _install_journal(tmp_path, panel)
    plan = replace(
        module_journal.plan,
        scope=scope,
        operation=operation,
        module_id=None,
        target_profile={"profile": "xray-minimal", "module_ids": ["core"], "editor_variant": "light"},
    )
    module_journal.commit()
    journal = Journal.create(panel.root, plan, f"{scope}-operation", extra={})

    reopened = Journal.open(journal.dir)

    assert reopened.plan == plan
    with pytest.raises(ModuleTransactionError) as raised:
        reopened.apply_file("secret.key", tmp_path / "missing")
    assert raised.value.code == "operation_target_unsafe"


def test_open_reports_a_corrupt_operation_file(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    journal = _install_journal(tmp_path, panel)
    (journal.dir / "operation.json").write_text("{broken", encoding="utf-8")

    with pytest.raises(ModuleTransactionError) as raised:
        Journal.open(journal.dir)

    assert raised.value.code == "operation_journal_invalid"


def test_apply_replaces_adds_and_removes_files(tmp_path: Path, backup_mode: str) -> None:
    panel = make_panel(tmp_path, installed=("core", "tool.editor", "engine.xray", "tool.terminal"))
    journal = _install_journal(tmp_path, panel, operation="repair")
    panel.path("static/js/terminal/_core.js").unlink()

    _apply_everything(tmp_path, panel, journal)

    assert panel.path("services/ws_pty.py").read_bytes() == b"new services/ws_pty.py"
    assert panel.path("static/js/terminal/_core.js").read_bytes() == b"new static/js/terminal/_core.js"
    assert panel.path("modules.json").read_bytes() == b'{"changed": true}\n'
    assert panel.path("brand-new-state.json").read_bytes() == b"{}\n"
    assert not list(panel.root.rglob("*.xk-tx-new"))


def test_apply_then_rollback_restores_tree_byte_for_byte(tmp_path: Path, backup_mode: str) -> None:
    panel = make_panel(tmp_path, installed=("core", "tool.editor", "engine.xray", "tool.terminal"))
    panel.path("static/js/terminal/_core.js").unlink()
    before = snapshot(panel.root)
    journal = _install_journal(tmp_path, panel, operation="repair")

    _apply_everything(tmp_path, panel, journal)
    journal.rollback()

    assert snapshot(panel.root) == before


def test_remove_then_rollback_restores_tree_byte_for_byte(tmp_path: Path, backup_mode: str) -> None:
    panel = make_panel(tmp_path, installed=("core", "tool.editor", "engine.xray", "tool.terminal"))
    before = snapshot(panel.root)
    journal = _install_journal(tmp_path, panel, operation="remove")

    for relative in journal.plan.files_remove:
        journal.remove_file(relative)
    assert not panel.path("services/ws_pty.py").exists()
    assert not panel.path("static/js/terminal").exists()
    journal.rollback()

    assert snapshot(panel.root) == before


def test_remove_refuses_a_path_outside_the_plan(tmp_path: Path) -> None:
    panel = make_panel(tmp_path, installed=("core", "tool.editor", "engine.xray", "tool.terminal"))
    journal = _install_journal(tmp_path, panel, operation="remove")

    with pytest.raises(ModuleTransactionError) as raised:
        journal.remove_file("app.py")

    assert raised.value.code == "operation_target_unsafe"
    assert panel.path("app.py").is_file()


def test_rollback_removes_directories_the_operation_created(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    assert not panel.path("static/js/terminal").exists()
    journal = _install_journal(tmp_path, panel)

    for relative in journal.plan.files_add:
        journal.apply_file(relative, _staged(tmp_path, relative))
    assert panel.path("static/js/terminal/_core.js").is_file()
    journal.rollback()

    assert not panel.path("static/js/terminal").exists()
    assert panel.path("static/js").is_dir()


def test_rollback_is_idempotent(tmp_path: Path, backup_mode: str) -> None:
    panel = make_panel(tmp_path, installed=("core", "tool.editor", "engine.xray", "tool.terminal"))
    before = snapshot(panel.root)
    journal = _install_journal(tmp_path, panel, operation="repair")
    _apply_everything(tmp_path, panel, journal)

    journal.rollback()
    journal.rollback()

    assert snapshot(panel.root) == before


def test_rollback_after_partial_apply_and_reopen(tmp_path: Path) -> None:
    panel = make_panel(tmp_path, installed=("core", "tool.editor", "engine.xray", "tool.terminal"))
    before = snapshot(panel.root)
    journal = _install_journal(tmp_path, panel, operation="repair")
    first, second = journal.plan.files_add[:2]
    journal.apply_file(first, _staged(tmp_path, first))
    journal.apply_file(second, _staged(tmp_path, second))

    Journal.open(journal.dir).rollback()

    assert snapshot(panel.root) == before


def test_torn_last_line_of_actions_log_is_ignored(tmp_path: Path) -> None:
    panel = make_panel(tmp_path, installed=("core", "tool.editor", "engine.xray", "tool.terminal"))
    before = snapshot(panel.root)
    journal = _install_journal(tmp_path, panel, operation="repair")
    relative = journal.plan.files_add[0]
    journal.apply_file(relative, _staged(tmp_path, relative))
    with open(journal.dir / "actions.log", "ab") as handle:
        handle.write(b'{"kind": "replace", "path": "serv')

    Journal.open(journal.dir).rollback()

    assert snapshot(panel.root) == before


def test_interrupted_copy_leaves_no_temporary_file_after_rollback(tmp_path: Path) -> None:
    panel = make_panel(tmp_path, installed=("core", "tool.editor", "engine.xray", "tool.terminal"))
    before = snapshot(panel.root)
    journal = _install_journal(tmp_path, panel, operation="repair")
    relative = journal.plan.files_add[0]
    # What a power cut between the copy and the rename leaves behind.
    with open(journal.dir / "actions.log", "ab") as handle:
        handle.write((json.dumps({"kind": "replace", "path": relative}) + "\n").encode("utf-8"))
    panel.path(relative + ".xk-tx-new").write_bytes(b"half written")

    Journal.open(journal.dir).rollback()

    assert snapshot(panel.root) == before


def test_enospc_during_copy_rolls_back(tmp_path: Path, monkeypatch) -> None:
    panel = make_panel(tmp_path, installed=("core", "tool.editor", "engine.xray", "tool.terminal"))
    before = snapshot(panel.root)
    journal = _install_journal(tmp_path, panel, operation="repair")
    sources = {relative: _staged(tmp_path, relative) for relative in journal.plan.files_add}
    real_copy = shutil.copy2
    incoming = {str(path) for path in sources.values()}
    calls = {"count": 0}

    def copy_until_the_disk_is_full(source, destination, *args, **kwargs):
        if str(source) in incoming:
            calls["count"] += 1
            if calls["count"] == 3:
                Path(destination).write_bytes(b"par")
                raise OSError(errno.ENOSPC, "No space left on device")
        return real_copy(source, destination, *args, **kwargs)

    monkeypatch.setattr(journal_module.shutil, "copy2", copy_until_the_disk_is_full)

    with pytest.raises(OSError) as raised:
        for relative, source in sources.items():
            journal.apply_file(relative, source)
    assert raised.value.errno == errno.ENOSPC
    monkeypatch.setattr(journal_module.shutil, "copy2", real_copy)
    journal.rollback()

    assert snapshot(panel.root) == before


def test_gz_is_not_older_than_source_after_align(tmp_path: Path) -> None:
    from routes.ui_assets import resolve_precompressed_static

    panel = make_panel(tmp_path)
    journal = _install_journal(tmp_path, panel)
    for relative in journal.plan.files_add:
        journal.apply_file(relative, _staged(tmp_path, relative))
    source = panel.path("static/js/pages/terminal.lazy.entry.js")
    packed = panel.path("static/js/pages/terminal.lazy.entry.js.gz")
    set_mtime(packed, 1_000_000_000)
    set_mtime(source, 1_700_000_000)
    assert resolve_precompressed_static(str(panel.root / "static"), "js/pages/terminal.lazy.entry.js", "gzip") is None

    journal.align_precompressed()

    assert packed.stat().st_mtime >= source.stat().st_mtime
    assert resolve_precompressed_static(str(panel.root / "static"), "js/pages/terminal.lazy.entry.js", "gzip") == str(packed)


def test_align_ignores_a_copy_whose_source_is_missing(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    journal = _install_journal(tmp_path, panel)
    for relative in journal.plan.files_add:
        journal.apply_file(relative, _staged(tmp_path, relative))
    panel.path("static/js/pages/terminal.lazy.entry.js").unlink()

    journal.align_precompressed()


def test_rollback_failure_reports_first_unrestored_path(tmp_path: Path, monkeypatch) -> None:
    panel = make_panel(tmp_path, installed=("core", "tool.editor", "engine.xray", "tool.terminal"))
    journal = _install_journal(tmp_path, panel, operation="repair")
    for relative in journal.plan.files_add:
        journal.apply_file(relative, _staged(tmp_path, relative))
    real_replace = os.replace
    broken = journal.plan.files_add[1]

    def replace_unless_broken(source, destination, *args, **kwargs):
        if Path(destination) == panel.path(broken):
            raise OSError(errno.EROFS, "Read-only file system")
        return real_replace(source, destination, *args, **kwargs)

    monkeypatch.setattr(journal_module.os, "replace", replace_unless_broken)

    with pytest.raises(ModuleTransactionError) as raised:
        journal.rollback()

    assert raised.value.code == "operation_rollback_failed"
    assert raised.value.details["path"] == broken
    assert "Read-only" in raised.value.details["error"]
    assert journal.dir.is_dir()
    # Files handled before the failure are back; the copy of the rest is kept.
    last = journal.plan.files_add[-1]
    assert panel.path(last).read_bytes() == file_bytes(last)
    assert (journal.backup / "files" / Path(*broken.split("/"))).read_bytes() == file_bytes(broken)

    monkeypatch.setattr(journal_module.os, "replace", real_replace)
    journal.rollback()
    assert panel.path(broken).read_bytes() == file_bytes(broken)


def test_apply_refuses_a_directory_in_place_of_a_file(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    journal = _install_journal(tmp_path, panel)
    relative = "services/ws_pty.py"
    panel.path(relative).mkdir(parents=True)

    with pytest.raises(ModuleTransactionError) as raised:
        journal.apply_file(relative, _staged(tmp_path, relative))

    assert raised.value.code == "operation_target_unsafe"
    assert panel.path(relative).is_dir()


def test_apply_refuses_a_path_outside_the_plan(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    journal = _install_journal(tmp_path, panel)

    with pytest.raises(ModuleTransactionError) as raised:
        journal.apply_file("app.py", _staged(tmp_path, "app.py"))

    assert raised.value.code == "operation_target_unsafe"
    assert panel.path("app.py").read_bytes() == file_bytes("app.py")


def test_commit_removes_operation_directory(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    journal = _install_journal(tmp_path, panel)
    for relative in journal.plan.files_add:
        journal.apply_file(relative, _staged(tmp_path, relative))

    journal.commit()

    assert not journal.dir.exists()
    assert Journal.find(panel.root) is None
    assert panel.path("services/ws_pty.py").read_bytes() == b"new services/ws_pty.py"
    assert set(OWNERSHIP["tool.terminal"]) <= set(snapshot(panel.root))


# -- находки итоговой проверки ветки ---------------------------------------


def test_power_loss_inside_commit_does_not_undo_a_confirmed_operation(tmp_path: Path, monkeypatch) -> None:
    """Подтверждение удаляет каталог по частям; обрыв посреди него не должен запускать откат."""

    from services.module_transactions.executor import recover

    panel = make_panel(tmp_path)
    journal = _install_journal(tmp_path, panel)
    for relative in journal.plan.files_add:
        journal.apply_file(relative, _staged(tmp_path, relative))
    journal.write_state_file("modules.json", b'{"changed": true}\n')
    after = snapshot(panel.root)

    def power_cut(path, *args, **kwargs):
        # The record of the operation is gone, the action log is still there.
        target = Path(path) / "operation.json"
        if target.exists():
            target.unlink()
        raise KeyboardInterrupt("power cut")

    monkeypatch.setattr(journal_module.shutil, "rmtree", power_cut)
    with pytest.raises(KeyboardInterrupt):
        journal.commit()
    monkeypatch.undo()

    assert Journal.find(panel.root) is None
    assert recover(panel.root, panel.state) is None
    assert snapshot(panel.root) == after
    assert not transactions_root(panel.root).exists()


def test_rollback_needs_no_free_space_when_backups_are_links(tmp_path: Path, monkeypatch) -> None:
    panel = make_panel(tmp_path, installed=("core", "tool.editor", "engine.xray", "tool.terminal"))
    before = snapshot(panel.root)
    journal = _install_journal(tmp_path, panel, operation="repair")
    for relative in journal.plan.files_add:
        journal.apply_file(relative, _staged(tmp_path, relative))
    linked = journal.backup / "files" / Path(*journal.plan.files_add[0].split("/"))
    if linked.stat().st_nlink < 2:
        pytest.skip("this filesystem keeps backups as copies")

    def disk_is_full(*_args, **_kwargs):
        raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr(journal_module.shutil, "copy2", disk_is_full)
    journal.rollback()
    monkeypatch.undo()

    assert snapshot(panel.root) == before


def test_damaged_line_in_the_middle_of_the_log_does_not_lose_previous_files(tmp_path: Path) -> None:
    panel = make_panel(tmp_path, installed=("core", "tool.editor", "engine.xray", "tool.terminal"))
    before = snapshot(panel.root)
    journal = _install_journal(tmp_path, panel, operation="repair")
    for relative in journal.plan.files_add:
        journal.apply_file(relative, _staged(tmp_path, relative))
    journal.write_state_file("modules.json", b'{"changed": true}\n')
    log = journal.dir / "actions.log"
    lines = log.read_bytes().split(b"\n")
    lines[0] = b'{"kind": "repl\x00\x00'
    lines[2] = b"garbage"
    log.write_bytes(b"\n".join(lines))

    Journal.open(journal.dir).rollback()

    assert snapshot(panel.root) == before


def test_previous_files_come_back_even_without_any_log(tmp_path: Path) -> None:
    panel = make_panel(tmp_path, installed=("core", "tool.editor", "engine.xray", "tool.terminal"))
    before = snapshot(panel.root)
    journal = _install_journal(tmp_path, panel, operation="remove")
    for relative in journal.plan.files_remove:
        journal.remove_file(relative)
    (journal.dir / "actions.log").unlink()

    Journal.open(journal.dir).rollback()

    assert snapshot(panel.root) == before


def test_flush_asks_the_system_to_write_everything_down(tmp_path: Path, monkeypatch) -> None:
    panel = make_panel(tmp_path)
    journal = _install_journal(tmp_path, panel)
    calls = []
    monkeypatch.setattr(journal_module.os, "sync", lambda: calls.append("sync"), raising=False)

    journal.flush()

    assert calls == ["sync"]


def test_runner_is_dead_after_a_reboot_even_if_its_pid_is_taken(tmp_path: Path, monkeypatch) -> None:
    panel = make_panel(tmp_path)
    journal = _install_journal(tmp_path, panel)
    monkeypatch.setattr(journal_module, "current_boot_id", lambda: "boot-one")
    journal.set_pid(os.getpid())

    assert journal.meta()["boot_id"] == "boot-one"
    assert Journal.open(journal.dir).runner_alive() is True

    monkeypatch.setattr(journal_module, "current_boot_id", lambda: "boot-two")

    assert Journal.open(journal.dir).runner_alive() is False


def test_runner_without_a_pid_is_not_alive(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)

    assert _install_journal(tmp_path, panel).runner_alive() is False
