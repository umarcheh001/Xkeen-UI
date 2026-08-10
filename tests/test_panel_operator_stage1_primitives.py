from __future__ import annotations

from collections import Counter
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
OPERATOR_CSS = ROOT / "xkeen-ui/static/panel-operator.css"
PLAN_DOC = ROOT / "docs/panel-operator-redesign-completion-plan.md"
CONTRACT_DOC = ROOT / "docs/panel-operator-stage1-primitives.md"
DOCS_INDEX = ROOT / "docs/README.md"

SECTION_NAMES = [
    "1. TOKENS",
    "2. RESET / LEGACY BOUNDARY",
    "3. SHELL",
    "4. PRIMITIVES",
    "5. WORKSPACES",
    "6. MODALS",
    "7. THEMES",
    "8. RESPONSIVE",
]

PRIMITIVE_NAMES = [
    "surface / section",
    "field",
    "button / icon-button",
    "action-bar",
    "data-row",
    "status / tag",
    "segmented-control",
    "empty-state",
]


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
            selectors.append(" ".join(prelude[start:index].split()))
            start = index + 1
    selectors.append(" ".join(prelude[start:].split()))
    return [selector for selector in selectors if selector]


def _selector_counts(css: str) -> tuple[int, int, int, int]:
    without_comments = re.sub(r"/\*.*?\*/", "", css, flags=re.DOTALL)
    selectors: list[str] = []
    for match in re.finditer(r"([^{}]+)\{", without_comments):
        prelude = match.group(1).strip()
        if not prelude or prelude.startswith("@"):
            continue
        selectors.extend(_split_selector_list(prelude))
    counts = Counter(selectors)
    duplicate_selectors = sum(count > 1 for count in counts.values())
    duplicate_instances = sum(count - 1 for count in counts.values())
    return len(selectors), len(counts), duplicate_selectors, duplicate_instances


def test_stage1_stylesheet_has_one_canonical_layer_order():
    css = OPERATOR_CSS.read_text(encoding="utf-8")
    positions = [css.index(f"* {name}") for name in SECTION_NAMES]

    assert positions == sorted(positions)
    assert len(set(positions)) == len(SECTION_NAMES)
    assert css.find("@media", positions[-1]) > positions[-1]
    assert "@media" not in css[positions[0] : positions[-1]]
    assert "final fixes" not in css[positions[-1] :].lower()

    light_theme = css.index('html[data-theme="light"] body.panel-page {')
    assert positions[6] < light_theme < positions[7]
    assert css[light_theme : positions[7]].count("--op-") >= 20


def test_stage1_primitives_use_low_specificity_scope_and_existing_anchors():
    css = OPERATOR_CSS.read_text(encoding="utf-8")
    primitives_start = css.index("* 4. PRIMITIVES")
    workspaces_start = css.index("* 5. WORKSPACES")
    primitives = css[primitives_start:workspaces_start]

    for name in PRIMITIVE_NAMES:
        assert f"/* {name} */" in primitives
    assert primitives.count(":where(body.panel-page)") >= len(PRIMITIVE_NAMES)

    for anchor in (
        ".card",
        ".routing-side-card",
        ".command-row",
        ".fm-row",
        ".terminal-input",
        ".modal-actions",
        ".btn-icon",
        '[role="status"]',
        ".routing-focus-switch",
        ".fm-empty",
    ):
        assert anchor in primitives


def test_stage1_flat_effect_and_geometry_contract_is_static():
    css = OPERATOR_CSS.read_text(encoding="utf-8")

    assert not re.search(r"(?:linear|radial|conic|repeating-linear|repeating-radial)-gradient\(", css)
    assert "--op-control-h: 32px;" in css
    assert "--op-control-compact-h: 28px;" in css
    assert "--op-touch-target: 40px;" in css
    assert "--op-control-radius: 6px;" in css
    assert "--op-surface-radius: 9px;" in css
    assert "min-height: var(--op-touch-target) !important;" in css

    pill_blocks = re.findall(
        r"([^{}]+)\{[^{}]*border-radius:\s*999px\s*;[^{}]*\}",
        re.sub(r"/\*.*?\*/", "", css, flags=re.DOTALL),
        flags=re.DOTALL,
    )
    # Pills are intentionally reserved for the switch track, compact count
    # badge, and device alias. Keep this as an explicit allow-list so a new
    # rounded component cannot silently reintroduce legacy visual language.
    assert len(pill_blocks) == 3
    assert ".fm-toggle-slider" in pill_blocks[0]
    assert ".xk-mihomo-connections-view-tab span" in pill_blocks[1]
    assert ".xk-mihomo-device-name" in pill_blocks[2]

    assert ")::before," in css
    assert ")::after {" in css
    assert "background-image: none !important;" in css
    assert "box-shadow: none !important;" in css
    assert "transform: none !important;" in css


def test_operator_selector_layer_stays_within_living_budget():
    css = OPERATOR_CSS.read_text(encoding="utf-8")
    contract = CONTRACT_DOC.read_text(encoding="utf-8")
    definitions, unique, duplicate_selectors, duplicate_instances = _selector_counts(css)

    # Total definitions and unique selectors are telemetry, not ceilings:
    # completing another workspace legitimately grows both values. Guard the
    # share of cascade debt instead, so proportional growth remains possible
    # while a wave of repeated overrides still fails with useful diagnostics.
    duplicate_selector_ratio = duplicate_selectors / unique if unique else 0
    duplicate_instance_ratio = duplicate_instances / definitions if definitions else 0
    assert duplicate_selector_ratio <= 0.20, (
        f"selectors repeated in multiple rules: {duplicate_selectors}/{unique} "
        f"({duplicate_selector_ratio:.1%}, maximum 20%)"
    )
    assert duplicate_instance_ratio <= 0.20, (
        f"additional repeated instances: {duplicate_instances}/{definitions} "
        f"({duplicate_instance_ratio:.1%}, maximum 20%)"
    )
    # The Stage 1 document is a closure snapshot. Later stages may compact the
    # same canonical layer further without rewriting that historical result.
    for documented_metric in (
        "selector definitions: 932 → 893",
        "unique selectors: 725 → 716",
        "selectors с повторным определением: 155 → 132",
        "дополнительные повторные instances: 207 → 177",
    ):
        assert documented_metric in contract


def test_stage1_closure_is_reflected_in_documentation():
    plan = PLAN_DOC.read_text(encoding="utf-8")
    contract = CONTRACT_DOC.read_text(encoding="utf-8")
    index = DOCS_INDEX.read_text(encoding="utf-8")

    for fragment in (
        "### Этап 1. Уплотнить scoped-слой в систему примитивов — закрыт",
        "Критерий завершения: **выполнен**",
        "panel-operator-stage1-primitives.md",
    ):
        assert fragment in plan

    for fragment in (
        "Статус: **Этап 1 закрыт 28 июля 2026 года**.",
        "## Mapping примитивов",
        "## Legacy boundary",
        "## Геометрия",
        "## Уплотнение selector layer",
        "## Автоматические проверки",
        "Критерий завершения выполнен",
    ):
        assert fragment in contract

    assert "panel-operator-stage1-primitives.md" in index
