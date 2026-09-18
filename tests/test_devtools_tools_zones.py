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


def test_top_row_stretches_the_last_card_to_match_env():
    base = BASE_CSS.read_text(encoding="utf-8")
    glass = GLASS_CSS.read_text(encoding="utf-8")
    operator = OPERATOR_CSS.read_text(encoding="utf-8")

    # Хвоста update.log в карточке больше нет — ни разметки, ни правил под него.
    assert "#dt-update-log {" not in base
    assert "#dt-update-log-box[open]" not in base
    assert ".dt-update-log " not in glass
    assert ".dt-update-log," not in glass

    # Зато последняя карточка левой колонки тянется до низа ряда, вровень с ENV,
    # а строка итога по логу прижата к её низу — без пустой рамки под собой.
    stretch = base[base.index(".dt-tools-left > #dt-update-card[open] {"):]
    stretch = stretch[: stretch.index("}")]
    assert "flex: 1 1 auto;" in stretch

    assert ".dt-tools-left > #dt-update-card[open]::details-content {" in base

    pinned = base[base.index(".dt-tools-left > #dt-update-card[open] .dt-update-log-summary {"):]
    pinned = pinned[: pinned.index("}")]
    assert "margin-top: auto;" in pinned

    # В теме оператора верхний ряд тоже растягивается
    top_row = operator[operator.index("body.devtools-page .dt-tools-layout {"):]
    top_row = top_row[: top_row.index("}")]
    assert "align-items: stretch;" in top_row
    assert "minmax(400px, 440px) minmax(0, 1fr)" in top_row


def test_update_log_is_reduced_to_a_verdict_line():
    template = TEMPLATE.read_text(encoding="utf-8")
    glass = GLASS_CSS.read_text(encoding="utf-8")
    script = (ROOT / "xkeen-ui/static/js/features/devtools/update.js").read_text(encoding="utf-8")

    card = template[template.index('id="dt-update-card"'):]
    card = card[: card.index('id="dt-env-card"')]

    # Вместо простыни лога — шапка, строка вердикта и кнопка в полный лог.
    assert "<pre" not in card
    assert 'class="dt-update-log-head">Лог обновлений<' in card
    assert 'id="dt-update-log-verdict"' in card
    assert 'id="dt-update-log-open"' in card

    # Кнопка ведёт во вкладку Logs тем же путём, что и «Open logs».
    assert "btnVerdictLog.addEventListener('click', openLogsTab)" in script

    # Три исхода: чисто, предупреждения, ошибки.
    assert "Во время обновлений ошибок не обнаружено" in script
    assert "Во время обновлений обнаружены ошибки" in script
    assert "Во время обновлений были предупреждения" in script

    # Ошибку опознаём и по состоянию операции, и по маркеру «[!]» в логе.
    verdict_fn = script[script.index("function _classifyUpdateLog("):]
    verdict_fn = verdict_fn[: verdict_fn.index("return 'clean';")]
    assert "stateVal === 'failed'" in verdict_fn
    assert "UPDATE_LOG_ALERT_RE" in verdict_fn

    # Цвет строки зависит от вердикта, а не от соседних правил.
    assert '.dt-update-log-verdict[data-verdict="failed"] > .small {' in glass

    # Тема оператора красит .small приглушённым !important, поэтому находке нужно
    # собственное правило в её слое — и только внутри body.devtools-page.
    operator = OPERATOR_CSS.read_text(encoding="utf-8")
    for verdict in ("warn", "failed"):
        rule = 'body.devtools-page .dt-update-log-verdict[data-verdict="%s"] > .small {' % verdict
        assert rule in operator, verdict


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

    # Три линии держит subgrid: кнопка с переносом в одной колонке поднимает ряд
    # кнопок и во второй, иначе низы колонок разъезжаются.
    rows_rule = css[css.index("/* Три общие линии колонок экспорта"):]
    rows_rule = rows_rule[: rows_rule.index("}")]
    assert rows_rule.count(".dt-io-split {") == 1
    assert "grid-template-rows: auto 1fr auto;" in rows_rule

    col_rule = css[css.index(".dt-prefs-io-flex {"):]
    col_rule = col_rule[: col_rule.index("}")]
    assert "grid-template-rows: subgrid;" in col_rule
    assert "grid-row: span 3;" in col_rule

    # В одну колонку subgrid не работает — там колонки снова обычный flex.
    narrow = css[css.index("@media (max-width: 1180px)"):]
    narrow = narrow[: narrow.index("@media (max-width: 760px)")]
    assert "grid-template-rows: none;" in narrow
    assert "grid-row: auto;" in narrow


def test_every_card_row_keeps_its_buttons_small_and_on_the_right():
    base = BASE_CSS.read_text(encoding="utf-8")

    # Одно правило на все карточки — и широкие, и узкие.
    marker = ".dt-logging-actions {" + chr(10) + "  justify-content"
    row_rule = base[base.index(marker):]
    row_rule = row_rule[: row_rule.index("}")]
    assert "justify-content: flex-end;" in row_rule

    btn_rule = base[base.index(".dt-logging-actions button {"):]
    btn_rule = btn_rule[: btn_rule.index("}")]
    assert "width: auto;" in btn_rule
    assert "min-width: 96px;" in btn_rule

    # Кнопок во всю ширину и адресных исключений не осталось.
    assert "width: 100%;" not in base[base.index(".dt-logging-actions button {"):][:200]
    assert "#dt-logging-card .dt-logging-actions" not in base
    assert "#dt-ui-prefs-card .dt-logging-actions" not in base


def test_export_card_stretches_its_fields_to_the_card_height():
    base = BASE_CSS.read_text(encoding="utf-8")

    # Карточка встаёт вровень с соседней, поэтому высоту надо протянуть до полей.
    for selector in (
        "#dt-ui-prefs-io-card[open] {",
        "#dt-ui-prefs-io-card[open]::details-content {",
        "#dt-ui-prefs-io-card[open] > .dt-collapsible-body {",
        "#dt-ui-prefs-io-card .dt-io-split {",
    ):
        rule = base[base.index(selector):]
        rule = rule[: rule.index("}")]
        assert "flex" in rule, selector

    area_rule = base[base.index(".dt-prefs-io-flex .dt-codearea {"):]
    area_rule = area_rule[: area_rule.index("}")]
    assert "height: 100%;" in area_rule


def test_layout_columns_start_on_the_same_line():
    template = TEMPLATE.read_text(encoding="utf-8")
    base = BASE_CSS.read_text(encoding="utf-8")

    card = template[template.index('id="dt-layout-card"'):]
    card = card[: card.index("</details>")]

    # У обеих колонок своя подпись одной роли, и под ней ровно один контейнер —
    # иначе subgrid разложит содержимое по чужим строкам.
    assert card.count('class="small dt-layout-col-head"') == 2
    assert "Настройки раскладки и плотности UI" in card
    assert "Вкладки основной панели: перетаскивайте" in card

    # Описание карточки живёт в левой колонке, а не отдельной строкой над сеткой.
    body = card[card.index('class="dt-collapsible-body"'):]
    assert body.index("dt-layout-split") < body.index("Настройки раскладки и плотности UI")

    split_rule = base[base.index(".dt-layout-split {"):]
    split_rule = split_rule[: split_rule.index("}")]
    assert "grid-template-rows: auto 1fr;" in split_rule

    col_rule = base[base.index(".dt-layout-split > * {"):]
    col_rule = col_rule[: col_rule.index("}")]
    assert "grid-template-rows: subgrid;" in col_rule
    assert "grid-row: span 2;" in col_rule


def test_layout_card_lays_switches_and_tabs_in_two_columns():
    template = TEMPLATE.read_text(encoding="utf-8")
    base = BASE_CSS.read_text(encoding="utf-8")
    glass = GLASS_CSS.read_text(encoding="utf-8")

    card = template[template.index('id="dt-layout-card"'):]
    card = card[: card.index("</details>")]

    # Переключатели и пара селектов собраны в свои сетки, а не идут потоком.
    assert 'class="dt-layout-switches"' in card
    assert 'class="dt-layout-fields"' in card
    assert card.count('class="dt-switch"') == 5
    assert "margin-top:10px;\" title=\"Спрятать" not in card

    for name in ("dt-layout-switches", "dt-layout-fields"):
        rule = base[base.index("." + name + " {"):]
        rule = rule[: rule.index("}")]
        assert "grid-template-columns: repeat(2, minmax(0, 1fr));" in rule, name

    # Список вкладок — два столбика, порядок читается слева направо.
    tabs_rule = glass[glass.index(".dt-tab-list{"):]
    tabs_rule = tabs_rule[: tabs_rule.index("}")]
    assert "display: grid;" in tabs_rule
    assert "grid-template-columns: repeat(2, minmax(0, 1fr));" in tabs_rule

    # На узком экране всё сворачивается в одну колонку.
    narrow = glass[glass.index("@media (max-width: 1180px) {"):]
    narrow = narrow[: narrow.index("}")]
    assert ".dt-tab-list" in narrow

    # Строки subgrid остались только у карточки экспорта.
    split_rule = base[base.index(".dt-layout-split,"):]
    split_rule = split_rule[: split_rule.index("}")]
    assert "grid-template-rows:" not in split_rule


def test_button_rows_breathe_like_the_card_padding():
    base = BASE_CSS.read_text(encoding="utf-8")
    glass = GLASS_CSS.read_text(encoding="utf-8")
    operator = OPERATOR_CSS.read_text(encoding="utf-8")

    # Зазор ряда кнопок задан в базовом слое и равен отступу карточки (12px).
    row_rule = base[base.index(".dt-logging-actions {"):]
    row_rule = row_rule[: row_rule.index("}")]
    assert "gap: 12px;" in row_rule

    service_rule = operator[operator.index("body.devtools-page .dt-service-actions {"):]
    service_rule = service_rule[: service_rule.index("}")]
    assert "gap: 12px;" in service_rule

    card_rule = operator[operator.index("body.devtools-page :is(.card, details.dt-collapsible"):]
    card_rule = card_rule[: card_rule.index("}")]
    assert "padding: 11px 12px;" in card_rule

    # Тема оператора ужимает до 5px только сетку действий внутри карточки экспорта;
    # ряды кнопок карточек живут на общем зазоре.
    tight = operator[operator.index("body.devtools-page .dt-actions-grid {"):]
    tight = tight[: tight.index("}")]
    assert "gap: 5px;" in tight
    assert ".dt-logging-actions" not in tight
    assert ".dt-update-actions" not in tight

    # Ряд кнопок обновления и декриптора — тот же зазор, что у Save/Reset.
    update_row = glass[glass.index(".dt-update-actions {"):]
    update_row = update_row[: update_row.index("}")]
    assert "gap: 12px;" in update_row


def test_no_card_overrides_the_shared_button_row():
    base = BASE_CSS.read_text(encoding="utf-8")
    template = TEMPLATE.read_text(encoding="utf-8")

    assert ".dt-card-wide .dt-logging-actions" not in base
    assert 'class="dt-logging-actions" style="justify-content:flex-end;"' not in template

    for card_id in ("dt-terminal-theme-card", "dt-branding-card", "dt-layout-card",
                    "dt-logging-card", "dt-ui-prefs-card"):
        card = template[template.index('id="%s"' % card_id):]
        card = card[: card.index("</details>")] if "</details>" in card else card
        assert 'class="dt-logging-actions"' in card, card_id


def test_check_result_stays_in_the_pill_next_to_latest():
    script = (ROOT / "xkeen-ui/static/js/features/devtools/update.js").read_text(encoding="utf-8")

    render_check = script[script.index("function _renderCheck("):]
    render_check = render_check[: render_check.index("function _renderStatus(")]

    # Плашка статуса принадлежит операции обновления: результат проверки версии
    # пишется только в пилюлю рядом с «Latest» и в подсказку под ней.
    assert "_setStatus(" not in render_check
    assert "'⬆️ Доступно обновление: ' + verLabel" in render_check
    assert "'✅ У вас актуальная версия'" in render_check

    # Ход самой проверки — тоже в пилюле, а не поверх состояния операции.
    check_fn = script[script.index("async function checkLatest("):]
    check_fn = check_fn[: check_fn.index("async function loadStatus(")]
    assert "_setStatus(" not in check_fn
    assert "'Проверяем GitHub…'" in check_fn

    # Состояние операции по-прежнему рисует только _renderStatus.
    render_status = script[script.index("function _renderStatus("):]
    render_status = render_status[: render_status.index("function _fmtBytes(")] if "function _fmtBytes(" in render_status else render_status
    assert "'Ошибка обновления'" in render_status


def test_update_substatus_speaks_russian():
    script = (ROOT / "xkeen-ui/static/js/features/devtools/update.js").read_text(encoding="utf-8")

    render_status = script[script.index("function _renderStatus("):]

    # Строка под статусом собирается по-русски.
    assert "'Шаг: ' + _ruStep(step)" in render_status
    assert "const errRu = _ruText(err);" in render_status
    assert "'Ошибка: ' + errRu" in render_status
    # Сообщение панели не повторяет ту же ошибку второй строкой.
    assert "msg.toLowerCase() !== errRu.toLowerCase()" in render_status
    assert "'Резервных копий: '" in render_status
    assert "'Процесс обновления: '" in render_status
    assert "Step: " not in render_status
    assert "Runner pid" not in render_status

    # Коды и сообщения скрипта обновления переводятся по словарю,
    # незнакомый текст остаётся как есть.
    assert "'spawn_failed': 'не удалось запустить процесс обновления'," in script
    assert "'sha256 mismatch': 'контрольная сумма не совпала'," in script
    ru_fn = script[script.index("function _ruText("):]
    ru_fn = ru_fn[: ru_fn.index("function _ruStep(")]
    assert "return known || raw;" in ru_fn


def test_update_actions_fill_the_card_width():
    glass = GLASS_CSS.read_text(encoding="utf-8")

    rule = glass[glass.index(".dt-update-actions > * {"):]
    rule = rule[: rule.index("}")]
    assert "flex: 1 1 auto;" in rule


def test_prefs_io_buttons_are_labelled_in_russian():
    template = TEMPLATE.read_text(encoding="utf-8")

    card = template[template.index('id="dt-ui-prefs-io-card"'):]
    card = card[: card.index("</details>")]

    for label in (
        "Собрать JSON",
        "Копировать в буфер",
        "Сохранить в файл",
        "Применить из поля",
        "Загрузить из файла",
        "Сбросить всё",
    ):
        assert label in card, label
