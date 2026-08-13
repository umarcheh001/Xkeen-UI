from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "xkeen-ui/templates/panel.html"
OPERATOR_CSS = ROOT / "xkeen-ui/static/panel-operator.css"
LEGACY_CSS = ROOT / "xkeen-ui/static/styles.css"
GENERATOR = ROOT / "scripts/generate_panel_operator_inventory.py"
SNAPSHOT = ROOT / "docs/panel-operator-stage0-inventory.json"
CONTRACT_DOC = ROOT / "docs/panel-operator-stage0-contract.md"
PLAN_DOC = ROOT / "docs/panel-operator-redesign-completion-plan.md"
DOCS_INDEX = ROOT / "docs/README.md"

EXPECTED_VIEWS = {"routing", "mihomo", "xkeen", "xray-logs", "commands", "files"}
EXPECTED_ENGINES = {"codemirror", "monaco"}
EXPECTED_VIEWPORTS = {
    (1920, 1080),
    (1440, 900),
    (1280, 720),
    (1024, 768),
    (390, 844),
    (360, 800),
}


def _split_selector_list(prelude: str) -> list[str]:
    selectors: list[str] = []
    start = 0
    paren_depth = 0
    bracket_depth = 0
    quote: str | None = None
    escaped = False
    for index, char in enumerate(prelude):
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
        elif char in {"'", '"'}:
            quote = char
        elif char == "(":
            paren_depth += 1
        elif char == ")":
            paren_depth = max(0, paren_depth - 1)
        elif char == "[":
            bracket_depth += 1
        elif char == "]":
            bracket_depth = max(0, bracket_depth - 1)
        elif char == "," and paren_depth == 0 and bracket_depth == 0:
            selectors.append(prelude[start:index].strip())
            start = index + 1
    selectors.append(prelude[start:].strip())
    return selectors


def _generate(tmp_path: Path) -> dict[str, object]:
    output = tmp_path / "panel-operator-stage0-inventory.generated.json"
    result = subprocess.run(
        [sys.executable, str(GENERATOR), "--root", str(ROOT), "--json-out", str(output)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr or result.stdout
    return json.loads(output.read_text(encoding="utf-8"))


def test_stage0_inventory_snapshot_is_reproducible(tmp_path):
    payload = _generate(tmp_path)
    assert SNAPSHOT.is_file(), "Stage 0 inventory snapshot must be committed under docs/"
    assert payload == json.loads(SNAPSHOT.read_text(encoding="utf-8")), (
        "docs/panel-operator-stage0-inventory.json must match the generator output"
    )


def test_stage0_inventory_covers_views_accordions_engines_and_all_modals(tmp_path):
    payload = _generate(tmp_path)

    views = payload["top_level_views"]
    assert {item["name"] for item in views} == EXPECTED_VIEWS
    assert all(item["target_present"] for item in views)
    assert all(item["states"] for item in views)

    accordions = payload["accordions"]
    # The HWID subscription editor replaced its two diagnostic accordions
    # with direct, editable device-profile fields. The optional Mihomo egress
    # card adds one persisted disclosure to the ten remaining controls.
    assert len(accordions) == 11
    assert all(item["target_id"] and item["target_present"] for item in accordions)
    assert all(item["states"] == ["collapsed", "expanded"] for item in accordions)

    engines = payload["editor_engines"]
    assert set(engines["valid"]) == EXPECTED_ENGINES
    assert engines["default"] == "codemirror"
    assert len(engines["selectors"]) == 8

    modal_inventory = payload["modal_inventory"]
    assert modal_inventory["count"] == 50
    assert modal_inventory["missing_family_ids"] == []
    assert modal_inventory["stale_family_ids"] == []
    assert set(modal_inventory["family_counts"]) == {
        "confirm-compact-form",
        "editor-workbench",
        "master-detail",
        "drawer-help",
    }
    assert all(item["states"] for item in modal_inventory["items"])
    assert all(item["operator_family"] == item["family"] for item in modal_inventory["items"])
    assert all(item["icon_inventory"]["close_control_count"] == 1 for item in modal_inventory["items"])
    assert all(item["icon_inventory"]["close_icons"] == ["close"] for item in modal_inventory["items"])
    assert all(not item["icon_inventory"]["icon_only_without_accessible_name"] for item in modal_inventory["items"])
    assert all(not item["icon_inventory"]["legacy_glyph_controls"] for item in modal_inventory["items"])


def test_stage0_inventory_classifies_all_inline_styles_and_dom_hooks(tmp_path):
    payload = _generate(tmp_path)
    inline = payload["inline_styles"]
    dom = payload["dom_contract"]

    # Stage 5 moved static max-width/gap/margin declarations into scoped
    # modal classes, so the canonical inline-style baseline is lower.
    assert inline["attribute_count"] == 209
    assert sum(inline["attribute_kind_counts"].values()) == 209
    assert inline["attribute_kind_counts"]["state-visibility-hook"] > 0
    assert inline["attribute_kind_counts"]["presentation-geometry"] > 0
    assert inline["attribute_kind_counts"]["mixed-state-and-presentation"] > 0
    assert inline["declaration_kind_counts"]["state-visibility"] > 0
    assert inline["declaration_kind_counts"]["presentation-geometry"] > 0

    assert dom["id_count"] == dom["unique_id_count"]
    assert dom["duplicate_ids"] == []
    assert dom["data_attribute_count"] > 0
    assert dom["hidden_runtime_node_count"] > 0
    assert dom["js_referenced_template_id_count"] > 0
    for required_id in (
        "routing-focus-note",
        "json-editor-file-label",
        "inbounds-file-code",
        "outbounds-file-code",
    ):
        assert required_id in dom["ids"]


def test_operator_stylesheet_is_last_owned_and_fully_scoped():
    template = TEMPLATE.read_text(encoding="utf-8")
    operator_css = OPERATOR_CSS.read_text(encoding="utf-8")
    legacy_css = LEGACY_CSS.read_text(encoding="utf-8")

    stylesheet_tags = re.findall(
        r"<link\b[^>]*\brel=[\"']stylesheet[\"'][^>]*>", template, flags=re.IGNORECASE | re.DOTALL
    )
    assert stylesheet_tags
    assert "panel-operator.css" in stylesheet_tags[-1]
    assert template.count("panel-operator.css") == 1
    assert re.search(r"<body\b[^>]*\bclass=[\"'][^\"']*\bpanel-page\b", template)

    # Existing panel blocks in styles.css are legacy debt and are frozen by a
    # normalized block digest. New redesign rules have panel-operator.css as
    # their only owner.
    assert "panel-operator.css" not in legacy_css
    without_legacy_comments = re.sub(r"/\*.*?\*/", "", legacy_css, flags=re.DOTALL)
    legacy_blocks = []
    for match in re.finditer(r"([^{}]+)\{([^{}]*)\}", without_legacy_comments):
        prelude = " ".join(match.group(1).split())
        declarations = " ".join(match.group(2).split())
        if "body.panel-page" in prelude:
            legacy_blocks.append(f"{prelude}{{{declarations}}}")
    legacy_digest = hashlib.sha256(("\n".join(legacy_blocks) + "\n").encode("utf-8")).hexdigest()
    assert len(legacy_blocks) == 738
    assert legacy_digest == "6240c3421a60d918980211858b6d49bfd97e66472136c12f5983e9e9c4a38c95"

    without_comments = re.sub(r"/\*.*?\*/", "", operator_css, flags=re.DOTALL)
    unscoped: list[str] = []
    for match in re.finditer(r"([^{}]+)\{", without_comments):
        prelude = match.group(1).strip()
        if not prelude or prelude.startswith("@"):
            continue
        for selector in _split_selector_list(prelude):
            selector = selector.strip()
            if selector and "body.panel-page" not in selector:
                unscoped.append(selector)
    assert unscoped == [], f"operator selectors must stay scoped to body.panel-page: {unscoped[:5]}"


def test_all_twelve_stage0_visual_baselines_are_present_and_match_viewports(tmp_path):
    payload = _generate(tmp_path)
    captures = payload["visual_baselines"]["captures"]
    assert len(captures) == 12
    assert {item["theme"] for item in captures} == {"dark", "light"}
    assert {tuple(item["viewport"]) for item in captures} == EXPECTED_VIEWPORTS
    for item in captures:
        assert item["present"], f"missing baseline: {item['path']}"
        assert item["sha256"], f"baseline has no digest: {item['path']}"
        assert item["png_size"] == item["viewport"], f"baseline dimensions drifted: {item['path']}"


def test_stage0_closure_is_reflected_in_documentation():
    contract = CONTRACT_DOC.read_text(encoding="utf-8")
    plan = PLAN_DOC.read_text(encoding="utf-8")
    index = DOCS_INDEX.read_text(encoding="utf-8")

    for fragment in (
        "Статус: **Этап 0 закрыт 28 июля 2026 года**.",
        "## Матрица top-level views",
        "## Матрица modal families",
        "## Классификация inline-style",
        "## Visual baseline",
        "Критерий завершения выполнен",
    ):
        assert fragment in contract
    for fragment in (
        "### Этап 0. Зафиксировать контракт и матрицу состояний — закрыт",
        "Критерий завершения: **выполнен**",
        "panel-operator-stage0-inventory.json",
    ):
        assert fragment in plan
    for fragment in (
        "panel-operator-redesign-completion-plan.md",
        "panel-operator-stage0-contract.md",
        "panel-operator-stage0-inventory.json",
    ):
        assert fragment in index
