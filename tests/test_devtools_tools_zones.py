from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "xkeen-ui/templates/devtools.html"
BASE_CSS = ROOT / "xkeen-ui/static/styles.css"
GLASS_CSS = ROOT / "xkeen-ui/static/devtools.css"
OPERATOR_CSS = ROOT / "xkeen-ui/static/devtools-operator.css"


def test_base_layer_defines_zone_primitives():
    css = BASE_CSS.read_text(encoding="utf-8")

    assert ".dt-zone-block {" in css
    assert ".dt-zone-head {" in css
    assert ".dt-zone {" in css
    assert "grid-template-columns: repeat(2, minmax(0, 1fr));" in css
    assert ".dt-zone > .dt-card-wide { grid-column: 1 / -1; }" in css
    assert ".dt-zone-block:not(:has(.card:not([data-xk-force-hidden])))" in css


def test_zones_collapse_to_one_column_on_narrow_screens():
    css = BASE_CSS.read_text(encoding="utf-8")

    narrow = css[css.index("@media (max-width: 1024px)"):]
    narrow = narrow[: narrow.index("/* Log controls */")]
    assert ".dt-zone {" in narrow

    # Именно у .dt-zone, а не у любого соседа в том же медиазапросе:
    # без среза до закрывающей скобки ассерта проходила бы и без правки.
    zone_rule = narrow[narrow.index(".dt-zone {"):]
    zone_rule = zone_rule[: zone_rule.index("}")]
    assert "grid-template-columns: minmax(0, 1fr);" in zone_rule
