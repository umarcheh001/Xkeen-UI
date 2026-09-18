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


CARD_IDS = (
    "dt-service-card",
    "dt-update-card",
    "dt-env-card",
    "dt-happ-decryptor-card",
    "dt-logging-card",
    "dt-ui-prefs-card",
    "dt-branding-card",
    "dt-ui-prefs-io-card",
    "dt-layout-card",
    "dt-terminal-theme-card",
)


def _tools_tab(template):
    start = template.index('id="dt-tab-tools"')
    return template[start: template.index('id="dt-tab-logs"', start)]


def _zone(template, label):
    tools = _tools_tab(template)
    start = tools.index('aria-label="%s"' % label)
    tail = tools[start:]
    for next_label in ('aria-label="Система"', 'aria-label="Вид интерфейса"'):
        if next_label in tail[1:]:
            tail = tail[: tail.index(next_label, 1)]
    return tail


def test_every_card_keeps_its_id_exactly_once():
    template = TEMPLATE.read_text(encoding="utf-8")

    for card_id in CARD_IDS:
        assert template.count('id="%s"' % card_id) == 1, card_id


def test_top_row_keeps_only_service_and_update():
    template = TEMPLATE.read_text(encoding="utf-8")
    tools = _tools_tab(template)

    left = tools[tools.index('class="layout-side dt-tools-left"'): tools.index('class="layout-main dt-tools-right"')]
    assert 'id="dt-service-card"' in left
    assert 'id="dt-update-card"' in left
    for moved in ("dt-happ-decryptor-card", "dt-logging-card", "dt-ui-prefs-card",
                  "dt-branding-card", "dt-ui-prefs-io-card", "dt-layout-card",
                  "dt-terminal-theme-card"):
        assert moved not in left, moved


def test_cards_are_distributed_over_three_named_zones():
    template = TEMPLATE.read_text(encoding="utf-8")
    tools = _tools_tab(template)

    assert tools.count('class="dt-zone-block"') == 3
    assert tools.count('class="dt-zone-head"') == 3
    assert 'aria-hidden="true">Сервис, обновление и настройки<' in tools
    assert 'aria-hidden="true">Система<' in tools
    assert 'aria-hidden="true">Вид интерфейса<' in tools

    system = _zone(template, "Система")
    for card_id in ("dt-happ-decryptor-card", "dt-logging-card", "dt-terminal-theme-card"):
        assert 'id="%s"' % card_id in system, card_id

    view = _zone(template, "Вид интерфейса")
    for card_id in ("dt-branding-card", "dt-ui-prefs-card", "dt-ui-prefs-io-card", "dt-layout-card"):
        assert 'id="%s"' % card_id in view, card_id


def test_wide_cards_span_both_columns():
    template = TEMPLATE.read_text(encoding="utf-8")

    for card_id in ("dt-terminal-theme-card", "dt-branding-card", "dt-layout-card"):
        opening = template[template.index('id="%s"' % card_id) - 200: template.index('id="%s"' % card_id)]
        assert "dt-card-wide" in opening, card_id


def test_both_themes_style_zone_cards():
    glass = GLASS_CSS.read_text(encoding="utf-8")
    operator = OPERATOR_CSS.read_text(encoding="utf-8")

    assert "body.devtools-page .dt-zone > .card" in glass
    assert "body.devtools-page .dt-zone-head" in glass
    assert "body.devtools-page .dt-zone > details.card > summary h2::before" in glass

    assert "body.devtools-page .dt-zone-head" in operator
    assert "body.devtools-page .dt-zone > .card" in operator


def test_terminal_card_starts_collapsed_and_others_do_not():
    template = TEMPLATE.read_text(encoding="utf-8")

    terminal = template[template.index('id="dt-terminal-theme-card"'):]
    terminal = terminal[: terminal.index(">")]
    assert " open" not in terminal

    for card_id in ("dt-update-card", "dt-happ-decryptor-card", "dt-logging-card",
                    "dt-ui-prefs-card", "dt-branding-card", "dt-ui-prefs-io-card",
                    "dt-layout-card"):
        opening = template[template.index('id="%s"' % card_id):]
        opening = opening[: opening.index(">")]
        assert " open" in opening, card_id


def test_wide_cards_use_multi_column_inner_grids():
    css = BASE_CSS.read_text(encoding="utf-8")
    template = TEMPLATE.read_text(encoding="utf-8")

    assert ".dt-card-wide .dt-theme-grid" in css
    assert ".dt-card-wide .dt-rename-list" in css
    assert ".dt-card-wide .dt-branding-split" in css

    io_card = template[template.index('id="dt-ui-prefs-io-card"'): template.index('id="dt-layout-card"')]
    assert 'class="dt-io-split"' in io_card
    assert "dt-prefs-io-flex" in css

    # Терминал стоит РАНЬШЕ Layout-карточки (зона «Система» перед «Вид
    # интерфейса»), поэтому срез по dt-terminal-theme-card был бы пустым.
    # Обрезаем по собственному закрывающему тегу карточки.
    layout_card = template[template.index('id="dt-layout-card"'):]
    layout_card = layout_card[: layout_card.index("</details>")]
    assert 'class="dt-layout-split"' in layout_card


def test_top_row_stretches_and_update_log_takes_the_slack():
    base = BASE_CSS.read_text(encoding="utf-8")
    glass = GLASS_CSS.read_text(encoding="utf-8")
    operator = OPERATOR_CSS.read_text(encoding="utf-8")

    assert "#dt-update-card[open] {" in base
    update_rule = base[base.index("#dt-update-card[open] {"):]
    update_rule = update_rule[: update_rule.index("}")]
    assert "flex: 1 1 auto;" in update_rule

    assert "#dt-update-log {" in base
    log_rule = base[base.index("#dt-update-log {"):]
    log_rule = log_rule[: log_rule.index("}")]
    assert "overflow: auto;" in log_rule
    assert "max-height: none;" in log_rule

    # Хвост лога больше не заперт фиксированной высотой
    assert ".dt-update-log {\n  max-height: 240px;\n}" not in glass

    # В теме оператора верхний ряд тоже растягивается
    top_row = operator[operator.index("body.devtools-page .dt-tools-layout {"):]
    top_row = top_row[: top_row.index("}")]
    assert "align-items: stretch;" in top_row
    assert "minmax(400px, 440px) minmax(0, 1fr)" in top_row


def test_prefs_io_columns_are_built_the_same_way():
    template = TEMPLATE.read_text(encoding="utf-8")
    css = BASE_CSS.read_text(encoding="utf-8")

    card = template[template.index('id="dt-ui-prefs-io-card"'):]
    card = card[: card.index("</details>")]

    columns = card.split('class="dt-prefs-io-flex"')[1:]
    assert len(columns) == 2

    # Обе колонки идут по одной схеме: подпись, поле, ряд кнопок под ним.
    for column in columns:
        assert column.index("dt-io-col-head") < column.index("dt-codearea") < column.index("dt-actions-grid")

    # Сброс уехал в подвал карточки, отделённый линией.
    footer = card[card.index('class="dt-io-reset"'):]
    assert 'id="dt-ui-prefs-resetall"' in footer
    assert "dt-codearea" not in footer

    reset_rule = css[css.index(".dt-io-reset {"):]
    reset_rule = reset_rule[: reset_rule.index("}")]
    assert "border-top:" in reset_rule
    assert "justify-content: space-between;" in reset_rule


def test_prefs_io_buttons_are_labelled_in_russian():
    template = TEMPLATE.read_text(encoding="utf-8")

    card = template[template.index('id="dt-ui-prefs-io-card"'):]
    card = card[: card.index("</details>")]

    for label in ("Экспортировать", "Копировать", "Скачать", "Импортировать", "Сбросить всё"):
        assert label in card, label
