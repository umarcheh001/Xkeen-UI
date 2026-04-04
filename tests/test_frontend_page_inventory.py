from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PROJECT_ROOT = ROOT / "xkeen-ui"
GENERATOR = ROOT / "scripts" / "generate_frontend_inventory.py"
SNAPSHOT = ROOT / "docs" / "frontend-page-inventory.json"

EXPECTED_PAGES = {
    "panel": "static/js/pages/panel.entry.js",
    "backups": "static/js/pages/backups.entry.js",
    "devtools": "static/js/pages/devtools.entry.js",
    "xkeen": "static/js/pages/xkeen.entry.js",
    "mihomo_generator": "static/js/pages/mihomo_generator.entry.js",
}


def test_frontend_inventory_generator_runs_for_current_project(tmp_path):
    assert GENERATOR.is_file(), "frontend inventory generator should exist"

    output_path = tmp_path / "frontend-page-inventory.generated.json"
    result = subprocess.run(
        [sys.executable, str(GENERATOR), "--root", str(ROOT), "--json-out", str(output_path)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr or result.stdout
    assert output_path.is_file(), "generator should produce a JSON inventory snapshot"

    payload = json.loads(output_path.read_text(encoding="utf-8"))
    pages = payload.get("pages", {})
    assert set(pages) == set(EXPECTED_PAGES)

    for page_name, entry_path in EXPECTED_PAGES.items():
        page = pages[page_name]
        assert page.get("entry") == entry_path
        assert (PROJECT_ROOT / entry_path).is_file(), f"missing entry file for {page_name}: {entry_path}"
        assert (PROJECT_ROOT / page["init"]).is_file(), f"missing init file for {page_name}: {page['init']}"
        assert (PROJECT_ROOT / page["template"]).is_file(), f"missing template for {page_name}: {page['template']}"
        for item in page.get("esm_bootstrap_files", []):
            rel = item.get("path")
            assert rel, f"{page_name} inventory contains ESM bootstrap file without path"
            assert (PROJECT_ROOT / rel).is_file(), f"inventory references missing bootstrap file: {rel}"


def test_frontend_inventory_snapshot_is_committed_and_matches_generator(tmp_path):
    assert SNAPSHOT.is_file(), "committed frontend inventory snapshot should exist under docs/"

    output_path = tmp_path / "frontend-page-inventory.generated.json"
    result = subprocess.run(
        [sys.executable, str(GENERATOR), "--root", str(ROOT), "--json-out", str(output_path)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr or result.stdout
    assert output_path.read_text(encoding="utf-8") == SNAPSHOT.read_text(encoding="utf-8"), (
        "committed docs/frontend-page-inventory.json should stay in sync with the generator output"
    )


def test_panel_inventory_captures_current_p2_screen_split_and_lazy_runtime(tmp_path):
    output_path = tmp_path / "frontend-page-inventory.generated.json"
    result = subprocess.run(
        [sys.executable, str(GENERATOR), "--root", str(ROOT), "--json-out", str(output_path)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr or result.stdout

    payload = json.loads(output_path.read_text(encoding="utf-8"))
    panel = payload["pages"]["panel"]
    shared_imports = set(panel.get("shared_imports") or [])
    dynamic_imports = set(panel.get("dynamic_imports") or [])
    esm_files = {item["path"] for item in panel.get("esm_bootstrap_files", [])}

    required_shared_imports = {
        "./top_level_shell.shared.js",
        "./top_level_panel_mihomo.shared.js",
        "./panel.screen.bootstrap.js",
    }
    assert required_shared_imports.issubset(shared_imports)
    assert dynamic_imports == set()
    assert "static/js/runtime/lazy_runtime.js" in esm_files
    for rel in (
        "static/js/pages/top_level_panel_screen.js",
        "static/js/pages/top_level_mihomo_generator_screen.js",
        "static/js/pages/top_level_screen_host.shared.js",
        "static/js/pages/panel.screen.bootstrap.js",
        "static/js/pages/panel.bootstrap_tail.bundle.js",
        "static/js/pages/panel.shared_compat.bundle.js",
    ):
        assert rel in esm_files, f"panel P2 inventory should capture transitive screen/bootstrap module: {rel}"

    lazy_runtime_inventory = panel.get("lazy_runtime_inventory") or {}
    feature_scripts = lazy_runtime_inventory.get("feature_scripts") or {}
    assert set(feature_scripts) == {"backups", "jsonEditor", "datContents"}

    all_lazy_features = set(panel.get("all_bootstrap_lazy_features") or [])
    for feature_name in (
        "restartLog",
        "serviceStatus",
        "routingTemplates",
        "github",
        "donate",
        "mihomoImport",
        "mihomoProxyTools",
        "mihomoHwidSub",
        "xkeenTexts",
        "commandsList",
        "coresStatus",
    ):
        assert feature_name in all_lazy_features, (
            f"panel inventory should still capture panel-local lazy feature {feature_name}"
        )


def test_devtools_inventory_captures_current_p3_screen_split_and_deferred_sections(tmp_path):
    output_path = tmp_path / "frontend-page-inventory.generated.json"
    result = subprocess.run(
        [sys.executable, str(GENERATOR), "--root", str(ROOT), "--json-out", str(output_path)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr or result.stdout

    payload = json.loads(output_path.read_text(encoding="utf-8"))
    devtools = payload["pages"]["devtools"]
    shared_imports = set(devtools.get("shared_imports") or [])
    dynamic_imports = set(devtools.get("dynamic_imports") or [])
    esm_files = {item["path"] for item in devtools.get("esm_bootstrap_files", [])}

    required_shared_imports = {
        "./top_level_shell.shared.js",
        "./top_level_panel_mihomo.shared.js",
        "./devtools.screen.bootstrap.js",
    }
    assert required_shared_imports.issubset(shared_imports)
    assert dynamic_imports == set()

    for rel in (
        "static/js/pages/devtools.screen.bootstrap.js",
        "static/js/pages/top_level_devtools_screen.js",
        "static/js/pages/top_level_panel_mihomo.shared.js",
        "static/js/features/devtools.js",
        "static/js/features/devtools/logs.js",
        "static/js/features/devtools/update.js",
    ):
        assert rel in esm_files, f"devtools P3 inventory should capture screen/bootstrap module: {rel}"


def test_frontend_inventory_docs_freeze_source_graph_as_canonical_stage1_contract():
    inventory_doc = (ROOT / "docs" / "frontend-page-inventory.md").read_text(encoding="utf-8")

    required_fragments = [
        "## Freeze contract для stages 1 и 3",
        "source entrypoints в `static/js/pages/*.entry.js` остаются канонической картой страниц",
        "build-managed wrappers из `static/frontend-build/assets/*-*.js` не являются отдельной архитектурой",
        "snapshot можно и нужно строить по source graph",
    ]

    for fragment in required_fragments:
        assert fragment in inventory_doc, f"missing stage 1/3 freeze fragment in frontend-page-inventory.md: {fragment}"
