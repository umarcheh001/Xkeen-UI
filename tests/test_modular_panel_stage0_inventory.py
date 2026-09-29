from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
GENERATOR = ROOT / "scripts" / "generate_modular_panel_inventory.py"
SNAPSHOT = ROOT / "docs" / "modular-panel-stage0-inventory.json"
CONTRACT = ROOT / "docs" / "modular-panel-stage0-inventory.md"
PLAN = ROOT / "README-modular-panel-plan.md"
DOCS_INDEX = ROOT / "docs" / "README.md"

EXPECTED_MODULES = {
    "core",
    "engine.xray",
    "engine.mihomo",
    "tool.editor",
    "tool.terminal",
    "tool.files",
    "tool.backups",
    "integration.happ",
    "tool.advanced-diagnostics",
}

REQUIRED_UNIT_FIELDS = {
    "module_id",
    "kind",
    "path",
    "depends_on",
    "starts_background_task",
    "registers_routes",
    "frontend_bundle",
    "system_requirements",
    "removable",
}


def _generate(tmp_path: Path) -> tuple[dict, str]:
    json_out = tmp_path / "modular-panel-stage0-inventory.json"
    markdown_out = tmp_path / "modular-panel-stage0-inventory.md"
    result = subprocess.run(
        [
            sys.executable,
            str(GENERATOR),
            "--root",
            str(ROOT),
            "--json-out",
            str(json_out),
            "--markdown-out",
            str(markdown_out),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr or result.stdout
    return json.loads(json_out.read_text(encoding="utf-8")), markdown_out.read_text(encoding="utf-8")


def test_stage0_inventory_generator_runs_and_covers_required_contract(tmp_path):
    payload, _markdown = _generate(tmp_path)

    assert payload["schema_version"] == 1
    assert payload["stage"] == {
        "id": 0,
        "name": "Инвентаризация текущей панели",
        "status": "closed",
        "closed_on": "2026-09-29",
    }
    assert payload["scope"]["official_repository_only"] is True
    assert payload["scope"]["arbitrary_external_plugins"] is False

    modules = {item["id"]: item for item in payload["modules"]}
    assert set(modules) == EXPECTED_MODULES
    assert modules["core"]["removable"] is False
    assert all(modules[module_id]["unit_count"] > 0 for module_id in EXPECTED_MODULES)

    units = payload["units"]
    assert len(units) > 700
    assert all(REQUIRED_UNIT_FIELDS.issubset(item) for item in units)
    assert all(item["module_id"] in EXPECTED_MODULES for item in units)
    assert all((ROOT / item["path"]).is_file() for item in units)

    kinds = {item["kind"] for item in units}
    for required_kind in (
        "backend_route",
        "backend_service",
        "frontend_entrypoint",
        "frontend_feature",
        "template",
        "stylesheet",
        "editor_schema",
        "backend_test",
        "frontend_test",
        "configuration",
    ):
        assert required_kind in kinds

    routes = payload["routes"]
    assert routes["endpoint_count"] > 250
    assert routes["files_with_routes"] > 40
    registration = {item["factory"]: item for item in routes["registration_points"]}
    assert registration["create_mihomo_blueprint"]["module_id"] == "engine.mihomo"
    assert registration["create_routing_blueprint"]["module_id"] == "engine.xray"
    assert registration["create_remotefs_blueprint"]["current_gate"] == "capability: remoteFs.enabled"

    tasks = {item["id"]: item for item in payload["background_tasks"]}
    for task_id in (
        "core.memory_guard",
        "terminal.pty_cleanup",
        "xray.subscription_scheduler",
        "xray.latency_jobs",
        "mihomo.subscription_scheduler",
        "mihomo.clash_telemetry_workers",
        "files.worker_queue",
        "dns.shared_guard",
    ):
        assert task_id in tasks

    bundles = {item["id"]: item for item in payload["frontend_bundles"]}
    assert set(bundles) == {
        "panel-core",
        "panel-routing",
        "panel-mihomo",
        "terminal-lazy",
        "file-manager-lazy",
        "backups-page",
        "devtools-page",
        "xkeen-page",
        "mihomo-generator-page",
    }
    assert bundles["terminal-lazy"]["file_count"] > 30
    assert bundles["file-manager-lazy"]["file_count"] > 25
    assert "engine.xray" in bundles["panel-routing"]["module_ids"]
    assert "engine.mihomo" in bundles["panel-mihomo"]["module_ids"]

    surfaces = payload["ui_surfaces"]
    views = {item["id"]: item["module_id"] for item in surfaces["panel_views"]}
    assert views == {
        "routing": "engine.xray",
        "mihomo": "engine.mihomo",
        "xkeen": "core",
        "xray-logs": "engine.xray",
        "commands": "tool.terminal",
        "files": "tool.files",
    }
    assert len(surfaces["panel_modals"]) == 53


def test_stage0_inventory_snapshot_and_markdown_match_generator(tmp_path):
    assert SNAPSHOT.is_file()
    assert CONTRACT.is_file()

    payload, markdown = _generate(tmp_path)
    assert json.loads(SNAPSHOT.read_text(encoding="utf-8")) == payload
    assert CONTRACT.read_text(encoding="utf-8") == markdown


def test_stage0_closure_is_reflected_in_documentation():
    contract = CONTRACT.read_text(encoding="utf-8")
    plan = PLAN.read_text(encoding="utf-8")
    docs_index = DOCS_INDEX.read_text(encoding="utf-8")

    for fragment in (
        "Статус: **Этап 0 закрыт 29 сентября 2026 года**.",
        "## Сводка модулей",
        "## Backend routes и регистрация",
        "## Фоновые задачи",
        "## Frontend и UI surfaces",
        "Критерий завершения **выполнен**",
        "Этап 3 — Backend gates",
    ):
        assert fragment in contract

    for fragment in (
        "## Этап 0. Инвентаризация текущей панели — закрыт",
        "Статус этапа: **закрыт 29 сентября 2026 года**.",
        "Критерий готовности: **выполнен**.",
        "docs/modular-panel-stage0-inventory.json",
        "docs/modular-panel-stage0-inventory.md",
        "scripts/generate_modular_panel_inventory.py",
    ):
        assert fragment in plan

    for fragment in (
        "modular-panel-stage0-inventory.md",
        "modular-panel-stage0-inventory.json",
        "generate_modular_panel_inventory.py",
    ):
        assert fragment in docs_index
