from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from scripts.panel_template_source import compose_panel_template


ROOT = Path(__file__).resolve().parents[1]
GENERATOR = ROOT / "scripts" / "generate_modular_panel_stage4_1_contract.py"
SNAPSHOT = ROOT / "docs" / "modular-panel-stage4.1-contract.json"
CONTRACT = ROOT / "docs" / "modular-panel-stage4.1-contract.md"
PLAN = ROOT / "README-modular-panel-plan.md"
DOCS_INDEX = ROOT / "docs" / "README.md"


def _generate(tmp_path: Path) -> tuple[dict, str]:
    json_out = tmp_path / "modular-panel-stage4.1-contract.json"
    markdown_out = tmp_path / "modular-panel-stage4.1-contract.md"
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
    return (
        json.loads(json_out.read_text(encoding="utf-8")),
        markdown_out.read_text(encoding="utf-8"),
    )


def test_stage4_1_contract_covers_shell_screens_modals_and_profiles(tmp_path):
    payload, _markdown = _generate(tmp_path)

    assert payload["schema_version"] == 1
    assert payload["stage"] == {
        "id": "4.1",
        "name": "Контракт границ shell, экранов и модальных окон",
        "status": "closed",
        "closed_on": "2026-09-29",
    }

    source = payload["source"]
    assert source["template"] == "xkeen-ui/templates/panel.html"
    assert source["inventory"] == "docs/modular-panel-stage0-inventory.json"
    assert source["line_count"] > 5_000
    assert source["id_count"] > 1_000
    assert source["duplicate_ids"] == []

    shell = {item["id"]: item for item in payload["shell"]}
    assert set(shell) == {
        "head",
        "page_config",
        "startup",
        "header",
        "navigation",
        "global_controls",
    }
    assert shell["head"]["module_id"] == "core"
    assert "window.XKeen.pageConfig" in shell["page_config"]["dom_anchors"]
    assert "top-tab-mihomo-generator" in shell["navigation"]["dom_anchors"]
    panel_template = compose_panel_template(ROOT)
    devtools_link_start = panel_template.index("url_for('devtools_page')")
    devtools_link_end = panel_template.index("panel-core-ui-refresh-btn")
    assert "{% if has_diagnostics %}" in panel_template[devtools_link_start - 200 : devtools_link_end]

    screens = {item["id"]: item for item in payload["screens"]}
    assert {
        screen_id: item["module_id"] for screen_id, item in screens.items()
    } == {
        "routing": "engine.xray",
        "mihomo": "engine.mihomo",
        "xkeen": "core",
        "xray-logs": "engine.xray",
        "commands": "tool.terminal",
        "files": "tool.files",
    }
    assert all(item["root_id"].startswith("view-") for item in screens.values())
    assert all(item["line"] > 0 for item in screens.values())

    modals = {item["id"]: item for item in payload["modals"]}
    assert len(modals) == 53
    assert len(modals) == len(payload["modals"])
    assert all(item["line"] > 0 for item in modals.values())
    assert all(item["target_partial"] for item in modals.values())

    assert modals["core-modal"]["boundary"] == "shared"
    assert modals["confirm-modal"]["target_module_id"] == "core"
    assert modals["fm-help-modal"]["current_inventory_module_id"] == "core"
    assert modals["fm-help-modal"]["target_module_id"] == "tool.files"
    assert modals["ssh-modal"]["target_module_id"] == "tool.terminal"
    assert modals["mihomo-hwid-modal"]["target_module_id"] == "integration.happ"

    mixed_ids = {item["id"] for item in payload["mixed_boundaries"]}
    assert {
        "navigation",
        "global-controls",
        "routing-editor",
        "mihomo-editor",
        "mihomo-hwid",
        "file-editor",
        "ssh-file-manager",
    } <= mixed_ids

    profiles = {item["id"]: item for item in payload["profiles"]}
    assert set(profiles) == {"legacy-full", "full", "xray-minimal", "mihomo-minimal"}
    assert profiles["legacy-full"]["forbidden_views"] == []
    assert profiles["full"]["forbidden_modal_ids"] == []
    assert profiles["xray-minimal"]["expected_views"] == ["routing", "xkeen", "xray-logs"]
    assert profiles["xray-minimal"]["forbidden_views"] == ["mihomo", "commands", "files"]
    assert profiles["mihomo-minimal"]["expected_views"] == ["mihomo", "xkeen"]
    assert profiles["mihomo-minimal"]["forbidden_views"] == [
        "routing",
        "xray-logs",
        "commands",
        "files",
    ]


def test_stage4_1_contract_snapshot_and_markdown_match_generator(tmp_path):
    assert SNAPSHOT.is_file()
    assert CONTRACT.is_file()

    payload, markdown = _generate(tmp_path)
    assert json.loads(SNAPSHOT.read_text(encoding="utf-8")) == payload
    assert CONTRACT.read_text(encoding="utf-8") == markdown


def test_stage4_1_closure_is_reflected_in_documentation():
    plan = PLAN.read_text(encoding="utf-8")
    contract = CONTRACT.read_text(encoding="utf-8")
    docs_index = DOCS_INDEX.read_text(encoding="utf-8")

    for fragment in (
        "Этапы 0, 1, 2, 3, 3R, 3R.1, 4.1, 4.2, 4.3 и 4.4 закрыты;",
        "### Подэтап 4.1. Контракт границ shell, экранов и модальных окон",
        "docs/modular-panel-stage4.1-contract.md",
        "Критерий готовности 4.1:",
    ):
        assert fragment in plan

    for fragment in (
        "Статус: **закрыт 29 сентября 2026 года**.",
        "## Shell boundaries",
        "## Screen boundaries",
        "## Modal boundaries",
        "## Mixed boundaries и решения",
        "## Profile baseline",
        "Критерий готовности **выполнен**",
    ):
        assert fragment in contract

    assert "modular-panel-stage4.1-contract.md" in docs_index
    assert "modular-panel-stage4.1-contract.json" in docs_index
