"""Статус операции отдаёт окну восстановления всё, что нужно показать владельцу.

Ответ `GET /api/modules/operations/status` собирается из файла, который пишет
исполнитель, и пропускает только известные поля. Среди них не было ни пути
файла, который не удалось вернуть, ни причины, по которой роутер не удалось
подготовить к релизу, ни области операции после восстановления.
"""

from __future__ import annotations

import json

from services.module_lifecycle import _public_status
from services.module_transactions.executor import recover
from services.module_transactions.journal import Journal
from services.module_transactions.launcher import launch
from services.module_transactions.plan import build_plan
from services.module_transactions.state import read_status
from tests.support.module_tx import ARCHITECTURE, make_panel, make_release


def _failed(**fields):
    return {"operation_id": "op", "result": "rollback_failed", "error_code": "operation_rollback_failed", **fields}


def test_the_file_that_could_not_be_restored_is_named():
    public = _public_status(_failed(failed_path="services/ws_pty.py", failed_error="[Errno 13] /opt/etc/secret"))

    assert public["failed_path"] == "services/ws_pty.py"
    # Текст системной ошибки с путями роутера наружу не идёт.
    assert "failed_error" not in public
    assert "secret" not in json.dumps(public)


def test_a_path_that_is_not_a_panel_file_is_not_passed_on():
    for path in ("/opt/etc/passwd", "../outside", "C:/secret", "a\\b", "", None, 7, "services/\nx"):
        assert "failed_path" not in _public_status(_failed(failed_path=path)), path


def test_the_reason_the_router_could_not_be_prepared_reaches_the_owner():
    public = _public_status(
        {
            "operation_id": "op",
            "result": "interrupted",
            "error_code": "operation_environment_failed",
            "error": "Не удалось установить Python-зависимость gevent.",
        }
    )

    assert public["error"] == "the router could not be prepared for the release"
    assert public["error_detail"] == "Не удалось установить Python-зависимость gevent."


def test_the_reason_is_one_short_line():
    public = _public_status(
        {"result": "interrupted", "error_code": "operation_environment_failed", "error": "первая\nвторая\x1b[31m " + "я" * 900}
    )

    assert "\n" not in public["error_detail"] and "\x1b" not in public["error_detail"]
    assert len(public["error_detail"]) <= 300


def test_other_errors_carry_no_free_text():
    public = _public_status(
        {"result": "rolled_back", "error_code": "operation_health_failed", "error": "internal /opt/secret"}
    )

    assert "error_detail" not in public
    assert "secret" not in json.dumps(public)


def test_an_environment_that_was_not_restored_is_said_so():
    assert _public_status({"result": "rolled_back", "environment_restored": False})["environment_restored"] is False
    assert "environment_restored" not in _public_status({"result": "rolled_back"})
    assert "environment_restored" not in _public_status({"result": "rolled_back", "environment_restored": "no"})


def _module_plan(panel, release):
    return build_plan(
        "install",
        "tool.terminal",
        panel_root=panel.root,
        state_dir=panel.state,
        catalog=release.catalog,
        architecture=ARCHITECTURE,
        free_bytes=1 << 40,
    )


def test_a_recovered_operation_keeps_its_scope(tmp_path):
    panel = make_panel(tmp_path)
    journal = Journal.create(panel.root, _module_plan(panel, make_release()), "scope-operation", extra={})
    journal.set_step("applying")

    assert recover(panel.root, panel.state) == "rolled_back"

    assert read_status(panel.state)["scope"] == "module"


def test_a_just_launched_operation_already_has_its_scope(tmp_path, monkeypatch):
    panel = make_panel(tmp_path)
    monkeypatch.setenv("XKEEN_UI_UPDATE_DIR", str(tmp_path / "update"))

    launch(
        _module_plan(panel, make_release()),
        panel_root=panel.root,
        state_dir=panel.state,
        health_url="http://127.0.0.1:1/login",
        restart_cmd=["true"],
        script=tmp_path / "no-such-runner.py",
    )

    assert read_status(panel.state)["scope"] == "module"
