# Перекомпоновка вкладки Tools в DevTools — план работ

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Разложить девять карточек вкладки Tools по трём именованным зонам, отдав им ширину экрана, и выровнять верхний ряд по высоте карточки ENV.

**Architecture:** Разметка и CSS, без изменений в JS. В `templates/devtools.html` семь карточек переезжают из узкой колонки `.dt-tools-left` в две новые зоны после существующей сетки `.dt-tools-layout`; каждая зона — грид в две колонки, карточка с классом `dt-card-wide` занимает обе. Верхний ряд растягивается по высоте, слабину забирает хвост `update.log`. Карточка темы терминала открывается свёрнутой — её состояние уже хранит существующий механизм `wireCollapsibleState`.

**Tech Stack:** Jinja2-шаблон, чистый CSS (три слоя: базовый `styles.css`, «стеклянный» `devtools.css`, плоский `devtools-operator.css`), pytest для текстовых тестов шаблона и CSS, Playwright для e2e.

**Spec:** `docs/superpowers/specs/2026-09-17-devtools-tools-layout-design.md`

## Global Constraints

- Класс `.dt-tools-layout` сохраняется в разметке и в обоих CSS-слоях: его наличие проверяют `tests/test_devtools_operator_theme.py:69` и `:96`.
- В `static/devtools-operator.css` дословно сохраняется строка `grid-template-columns: minmax(400px, 440px) minmax(0, 1fr);` — её проверяет тот же тест.
- Все девять id карточек сохраняются без переименования: `dt-service-card`, `dt-update-card`, `dt-env-card`, `dt-happ-decryptor-card`, `dt-logging-card`, `dt-ui-prefs-card`, `dt-branding-card`, `dt-ui-prefs-io-card`, `dt-layout-card`, `dt-terminal-theme-card`.
- Атрибуты `data-xk-section` на карточках не трогаются: это контракт ENV-вайтлиста (`static/js/ui/sections.js`).
- Правила слоя `devtools-operator.css` пишутся только внутри `body.devtools-page` — иначе падает `test_devtools_operator_stylesheet_is_isolated_and_loaded_last`.
- JS не меняется ни в одной задаче.
- Коммиты делаются с явным автором: `git -c user.name=olmer2002 -c user.email=olmer2002@gmail.com commit …`. Трейлеры (`Co-Authored-By` и любые другие) не добавляются. Пуш — только по отдельной просьбе.
- `pytest` запускается из Bash, не из PowerShell (в PowerShell падает `test_version_check` — он ходит настоящим curl).
- Перед любым запуском e2e обязателен `npm run frontend:build`.

---

### Task 1: Примитивы зон в базовом слое CSS

Ставим CSS-каркас до того, как трогать разметку: правила безвредны, пока в разметке нет зон, и следующая задача сразу получает рабочее оформление.

**Files:**
- Modify: `xkeen-ui/static/styles.css` (рядом с блоком `.dt-tools-layout`, строки 3204–3229, и в медиазапросе на строке 3230)
- Test: `tests/test_devtools_tools_zones.py` (создаётся здесь)

**Interfaces:**
- Consumes: ничего.
- Produces: классы `.dt-zone-block`, `.dt-zone-head`, `.dt-zone`, `.dt-card-wide` — ими пользуются задачи 2–5.

- [ ] **Step 1: Написать падающий тест**

Создать `tests/test_devtools_tools_zones.py`:

```python
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
    assert "grid-template-columns: minmax(0, 1fr);" in narrow
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `pytest tests/test_devtools_tools_zones.py -v`
Expected: FAIL — `assert '.dt-zone-block {' in css`.

- [ ] **Step 3: Добавить правила в базовый слой**

В `xkeen-ui/static/styles.css` сразу после блока `.layout-side .card { margin-top: 0; }` (строки 3226–3228) вставить:

```css
/* DevTools: named zones below the top row */
.dt-zone-block {
  margin-top: 24px;
}

.dt-zone-head {
  display: flex;
  align-items: center;
  gap: 14px;
  margin: 0 4px 12px;
  font-size: calc(11.5px * var(--xk-font-scale, 1));
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--muted, #94a3b8);
}

.dt-zone-head::after {
  content: "";
  flex: 1 1 auto;
  height: 1px;
  background: linear-gradient(90deg, var(--border, #334155), transparent);
}

.dt-zone {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  align-items: stretch;
}

.dt-zone > .card {
  margin-top: 0;
  margin-bottom: 0;
}

.dt-zone > .dt-card-wide { grid-column: 1 / -1; }

/* Зона, у которой ENV-вайтлист спрятал все карточки, уходит вместе с подписью */
.dt-zone-block:not(:has(.card:not([data-xk-force-hidden]))) {
  display: none;
}
```

В существующий медиазапрос `@media (max-width: 1024px)` (строка 3230), рядом с правилом для `.dt-tools-layout`, добавить:

```css
  .dt-zone {
    grid-template-columns: minmax(0, 1fr);
  }
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

Run: `pytest tests/test_devtools_tools_zones.py -v`
Expected: PASS, 2 теста.

- [ ] **Step 5: Коммит**

```bash
git -c user.name=olmer2002 -c user.email=olmer2002@gmail.com add xkeen-ui/static/styles.css tests/test_devtools_tools_zones.py
git -c user.name=olmer2002 -c user.email=olmer2002@gmail.com commit -m "Примитивы зон для вкладки Tools"
```

---

### Task 2: Разметка — три зоны вместо колонки из девяти карточек

**Files:**
- Modify: `xkeen-ui/templates/devtools.html:93-725`
- Test: `tests/test_devtools_tools_zones.py`

**Interfaces:**
- Consumes: классы из задачи 1.
- Produces: разметку с якорями `aria-label="Система"` и `aria-label="Вид интерфейса"` — на них опираются тесты и CSS задач 3–5.

- [ ] **Step 1: Написать падающий тест**

Дописать в `tests/test_devtools_tools_zones.py`:

```python
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
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `pytest tests/test_devtools_tools_zones.py -v`
Expected: FAIL — `test_top_row_keeps_only_service_and_update`, `test_cards_are_distributed_over_three_named_zones`, `test_wide_cards_span_both_columns`.

- [ ] **Step 3: Переложить разметку**

В `xkeen-ui/templates/devtools.html` внутри `<div id="dt-tab-tools" …>`:

1. Обернуть существующую сетку в блок зоны. Перед строкой `<div class="layout-2col dt-tools-layout">` вставить:

```html
      <section class="dt-zone-block">
        <div class="dt-zone-head" aria-hidden="true">Сервис, обновление и настройки</div>
```

и закрыть `</section>` сразу после закрывающего `</div>` этой сетки.

2. Вырезать из `<div class="layout-side dt-tools-left">` семь карточек целиком, вместе с их содержимым, оставив там только `dt-service-card` и `dt-update-card`. Порядок вырезаемых блоков в текущем файле: `dt-happ-decryptor-card` (строки 211–283), `dt-logging-card` (284–360), `dt-ui-prefs-card` (361–435), `dt-branding-card` (436–526), `dt-ui-prefs-io-card` (527–565), `dt-layout-card` (566–645), `dt-terminal-theme-card` (646–683).

3. После `</section>` верхней зоны вставить две новые зоны и разложить в них вырезанные карточки:

```html
      <section class="dt-zone-block">
        <div class="dt-zone-head" aria-hidden="true">Система</div>
        <div class="dt-zone" role="group" aria-label="Система">
          <!-- сюда: dt-happ-decryptor-card, затем dt-logging-card -->
          <!-- затем dt-terminal-theme-card с классом dt-card-wide -->
        </div>
      </section>

      <section class="dt-zone-block">
        <div class="dt-zone-head" aria-hidden="true">Вид интерфейса</div>
        <div class="dt-zone" role="group" aria-label="Вид интерфейса">
          <!-- сюда: dt-branding-card с классом dt-card-wide -->
          <!-- затем dt-ui-prefs-card, затем dt-ui-prefs-io-card -->
          <!-- затем dt-layout-card с классом dt-card-wide -->
        </div>
      </section>
```

4. Трём карточкам дописать класс в существующий `class`, ничего из него не удаляя:

```html
<details class="card dt-collapsible dt-card-wide" id="dt-terminal-theme-card" data-xk-section="theme terminal dt-terminal-theme-card">
<details class="card dt-collapsible dt-card-wide" id="dt-branding-card" data-xk-section="ui branding dt-branding-card" open>
<details class="card dt-collapsible dt-card-wide" id="dt-layout-card" data-xk-section="layout dt-layout-card" open>
```

Обратите внимание: у `dt-terminal-theme-card` атрибут `open` в этой строке уже снят — это требование задачи 5, и снимается он здесь же, одной правкой строки.

- [ ] **Step 4: Запустить тесты и убедиться, что они проходят**

Run: `pytest tests/test_devtools_tools_zones.py tests/test_devtools_operator_theme.py -v`
Expected: PASS. Если упал `test_devtools_operator_layer_covers_shell_tools_env_logs_modals_and_mobile` — значит потерян класс `.dt-tools-layout` или строка `grid-template-columns` в слое оператора; вернуть их.

- [ ] **Step 5: Коммит**

```bash
git -c user.name=olmer2002 -c user.email=olmer2002@gmail.com add xkeen-ui/templates/devtools.html tests/test_devtools_tools_zones.py
git -c user.name=olmer2002 -c user.email=olmer2002@gmail.com commit -m "Карточки Tools разложены по трём зонам"
```

---

### Task 3: Оформление зон в обеих темах

Сейчас глиф и фон карточки привязаны к селектору `.dt-tools-left > .card`. После переезда семь карточек остались бы без глифов — расширяем селекторы.

**Files:**
- Modify: `xkeen-ui/static/devtools.css:1151-1189` (фон карточек и `::before` с глифом), `:1915-1925` (медиазапрос)
- Modify: `xkeen-ui/static/devtools-operator.css:240-260`, `:788-792`, `:1341-1350`
- Test: `tests/test_devtools_tools_zones.py`, `tests/test_devtools_operator_theme.py:63-90`

**Interfaces:**
- Consumes: классы зон из задачи 1, разметку из задачи 2.
- Produces: оформленные зоны; на них опирается визуальная проверка задачи 6.

- [ ] **Step 1: Написать падающий тест**

Дописать в `tests/test_devtools_tools_zones.py`:

```python
def test_both_themes_style_zone_cards():
    glass = GLASS_CSS.read_text(encoding="utf-8")
    operator = OPERATOR_CSS.read_text(encoding="utf-8")

    assert "body.devtools-page .dt-zone > .card" in glass
    assert "body.devtools-page .dt-zone-head" in glass
    assert "body.devtools-page .dt-zone > details.card > summary h2::before" in glass

    assert "body.devtools-page .dt-zone-head" in operator
    assert "body.devtools-page .dt-zone > .card" in operator
```

И в `tests/test_devtools_operator_theme.py`, в кортеж обязательных якорей функции `test_devtools_operator_layer_covers_shell_tools_env_logs_modals_and_mobile` (строки 66–79), добавить `".dt-zone"` — рядом с `".dt-tools-layout"`.

- [ ] **Step 2: Запустить тесты и убедиться, что они падают**

Run: `pytest tests/test_devtools_tools_zones.py::test_both_themes_style_zone_cards tests/test_devtools_operator_theme.py -v`
Expected: FAIL — обе проверки не находят `.dt-zone` в слоях тем.

- [ ] **Step 3: Расширить селекторы в «стеклянной» теме**

В `xkeen-ui/static/devtools.css` заменить селекторы так, чтобы правила действовали и в зонах.

Было (строки 1151–1152):

```css
body.devtools-page .dt-tools-left > .card,
body.devtools-page .dt-tools-left > details.card {
```

Стало:

```css
body.devtools-page .dt-tools-left > .card,
body.devtools-page .dt-tools-left > details.card,
body.devtools-page .dt-zone > .card,
body.devtools-page .dt-zone > details.card {
```

Было (строки 1188–1189):

```css
body.devtools-page .dt-tools-left > section.card > h2::before,
body.devtools-page .dt-tools-left > details.card > summary h2::before {
```

Стало:

```css
body.devtools-page .dt-tools-left > section.card > h2::before,
body.devtools-page .dt-tools-left > details.card > summary h2::before,
body.devtools-page .dt-zone > section.card > h2::before,
body.devtools-page .dt-zone > details.card > summary h2::before {
```

Такую же правку сделать в светлой теме — строки 1619–1620, там тот же селектор под `html[data-theme="light"]`.

Следом добавить оформление подписи зоны:

```css
body.devtools-page .dt-zone-head {
  color: #8fb0e0;
}

body.devtools-page .dt-zone-head::after {
  background: linear-gradient(90deg, rgba(96, 165, 250, 0.38), rgba(96, 165, 250, 0.04));
}
```

- [ ] **Step 4: Расширить селекторы в теме оператора**

В `xkeen-ui/static/devtools-operator.css` (строки 240–241) было:

```css
body.devtools-page .dt-tools-left > :is(section, details) > h2::before,
body.devtools-page .dt-tools-left > details > summary h2::before,
```

Стало:

```css
body.devtools-page .dt-tools-left > :is(section, details) > h2::before,
body.devtools-page .dt-tools-left > details > summary h2::before,
body.devtools-page .dt-zone > :is(section, details) > h2::before,
body.devtools-page .dt-zone > details > summary h2::before,
```

В блоке на строках 788–790 к перечислению `body.devtools-page .dt-tools-left > :is(.card, details.card),` добавить строкой ниже:

```css
body.devtools-page .dt-zone > :is(.card, details.card),
```

И добавить плоскую подпись зоны:

```css
body.devtools-page .dt-zone-head {
  color: var(--op-text-muted);
  letter-spacing: 0.12em;
}

body.devtools-page .dt-zone-head::after {
  background: var(--op-border);
}
```

В медиазапросе на строке 1341 (`@media (max-width: 1180px)`), где сетка сводится в одну колонку, добавить:

```css
  body.devtools-page .dt-zone {
    grid-template-columns: minmax(0, 1fr);
  }
```

- [ ] **Step 5: Запустить тесты и убедиться, что они проходят**

Run: `pytest tests/test_devtools_tools_zones.py tests/test_devtools_operator_theme.py -v`
Expected: PASS, включая `test_devtools_operator_stylesheet_is_isolated_and_loaded_last` — все новые правила слоя оператора должны быть внутри `body.devtools-page`.

- [ ] **Step 6: Коммит**

```bash
git -c user.name=olmer2002 -c user.email=olmer2002@gmail.com add xkeen-ui/static/devtools.css xkeen-ui/static/devtools-operator.css tests/test_devtools_tools_zones.py tests/test_devtools_operator_theme.py
git -c user.name=olmer2002 -c user.email=olmer2002@gmail.com commit -m "Зоны Tools оформлены в обеих темах"
```

---

### Task 4: Верхний ряд вровень с ENV

**Files:**
- Modify: `xkeen-ui/static/styles.css` (рядом с `.dt-tools-layout`, строка 3204)
- Modify: `xkeen-ui/static/devtools.css:534` (снять `max-height` у хвоста лога)
- Modify: `xkeen-ui/static/devtools-operator.css:756-760` (`align-items`)
- Test: `tests/test_devtools_tools_zones.py`

**Interfaces:**
- Consumes: разметку из задачи 2.
- Produces: растянутый верхний ряд; высоту проверяет e2e из задачи 6.

- [ ] **Step 1: Написать падающий тест**

Дописать в `tests/test_devtools_tools_zones.py`:

```python
def test_top_row_stretches_and_update_log_takes_the_slack():
    base = BASE_CSS.read_text(encoding="utf-8")
    glass = GLASS_CSS.read_text(encoding="utf-8")
    operator = OPERATOR_CSS.read_text(encoding="utf-8")

    assert "#dt-update-card[open] {" in base
    assert "flex: 1 1 auto;" in base
    assert "#dt-update-log {" in base
    assert "overflow: auto;" in base

    # Хвост лога больше не заперт фиксированной высотой
    assert ".dt-update-log {\n  max-height: 240px;\n}" not in glass

    # В теме оператора верхний ряд тоже растягивается
    top_row = operator[operator.index("body.devtools-page .dt-tools-layout {"):]
    top_row = top_row[: top_row.index("}")]
    assert "align-items: stretch;" in top_row
    assert "minmax(400px, 440px) minmax(0, 1fr)" in top_row
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `pytest tests/test_devtools_tools_zones.py::test_top_row_stretches_and_update_log_takes_the_slack -v`
Expected: FAIL — `assert '#dt-update-card[open] {' in base`.

- [ ] **Step 3: Растянуть верхний ряд в базовом слое**

В `xkeen-ui/static/styles.css` сразу после блока `.dt-tools-layout { … }` (строки 3204–3206) добавить:

```css
/* DevTools: левая колонка верхнего ряда идёт вровень с карточкой ENV */
.dt-tools-layout {
  align-items: stretch;
}

#dt-update-card[open] {
  flex: 1 1 auto;
  min-height: 0;
}

#dt-update-card[open] > .dt-collapsible-body {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

#dt-update-log-box[open] {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

#dt-update-log-box[open] > .dt-collapsible-body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

#dt-update-log {
  flex: 1 1 auto;
  min-height: 96px;
  max-height: none;
  overflow: auto;
}
```

- [ ] **Step 4: Снять фиксированную высоту хвоста лога**

В `xkeen-ui/static/devtools.css` заменить блок на строках 534–536:

```css
.dt-update-log {
  max-height: 240px;
}
```

на

```css
.dt-update-log {
  /* Высоту задаёт растяжка верхнего ряда: см. #dt-update-log в styles.css */
  min-height: 96px;
}
```

- [ ] **Step 5: Поменять выравнивание в теме оператора**

В `xkeen-ui/static/devtools-operator.css` в блоке `body.devtools-page .dt-tools-layout` (строки 756–760) заменить `align-items: start;` на `align-items: stretch;`. Строку `grid-template-columns: minmax(400px, 440px) minmax(0, 1fr);` оставить дословно.

- [ ] **Step 6: Запустить тесты и убедиться, что они проходят**

Run: `pytest tests/test_devtools_tools_zones.py tests/test_devtools_operator_theme.py -v`
Expected: PASS.

- [ ] **Step 7: Коммит**

```bash
git -c user.name=olmer2002 -c user.email=olmer2002@gmail.com add xkeen-ui/static/styles.css xkeen-ui/static/devtools.css xkeen-ui/static/devtools-operator.css tests/test_devtools_tools_zones.py
git -c user.name=olmer2002 -c user.email=olmer2002@gmail.com commit -m "Верхний ряд Tools выровнен по высоте ENV"
```

---

### Task 5: Внутренности карточек, получивших ширину

Здесь карточки перестраиваются под новую ширину: Брендинг и Терминал раскладываются в несколько колонок, Layout‑твики встают в две, а Экспорт/Импорт становится ростом с «Интерфейс». Атрибут `open` у терминала уже снят в задаче 2; проверку на это добавляем здесь.

**Files:**
- Modify: `xkeen-ui/static/styles.css` (рядом с `.dt-theme-grid`, строка 12844)
- Modify: `xkeen-ui/templates/devtools.html` — карточка `dt-ui-prefs-io-card` (две колонки), карточка `dt-layout-card` (две колонки)
- Test: `tests/test_devtools_tools_zones.py`

**Interfaces:**
- Consumes: классы `.dt-card-wide`, `.dt-zone` из задач 1–2.
- Produces: раскладку внутри карточек; её проверяет e2e из задачи 6.

- [ ] **Step 1: Написать падающий тест**

Дописать в `tests/test_devtools_tools_zones.py`:

```python
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

    layout_card = template[template.index('id="dt-layout-card"'): template.index('id="dt-terminal-theme-card"')]
    assert 'class="dt-layout-split"' in layout_card
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `pytest tests/test_devtools_tools_zones.py::test_wide_cards_use_multi_column_inner_grids -v`
Expected: FAIL — `assert '.dt-card-wide .dt-theme-grid' in css`.

- [ ] **Step 3: Добавить многоколоночные сетки для широких карточек**

В `xkeen-ui/static/styles.css` сразу после блока `.dt-theme-grid { … }` (строки 12844–12848) добавить:

Селекторы намеренно составные (`.dt-card-wide .dt-…`): базовые правила
`.dt-branding-split` и `.dt-rename-list` живут в `devtools.css`, который
подключается позже, но их специфичность ниже — составной селектор выигрывает
независимо от порядка файлов. Ничего переносить между слоями не нужно.

```css
/* DevTools: карточки во всю ширину раскладывают своё содержимое в колонки */
.dt-card-wide .dt-theme-grid {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.dt-card-wide .dt-rename-list {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 9px;
}

/* Внутри широкой карточки строке переименования хватает меньших минимумов,
   иначе четыре колонки не помещаются и грид переполняет карточку. */
.dt-card-wide .dt-rename-row {
  grid-template-columns: minmax(110px, 1fr) minmax(150px, 1.6fr);
}

.dt-card-wide .dt-branding-split {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
  align-items: start;
  margin-top: 0;
}

.dt-layout-split,
.dt-io-split {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  align-items: start;
}

/* Поля JSON тянутся по высоте карточки, а не по атрибуту rows */
.dt-prefs-io-flex {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.dt-prefs-io-flex .dt-codearea {
  flex: 1 1 auto;
  min-height: 96px;
  height: auto;
}

@media (max-width: 1400px) {
  .dt-card-wide .dt-rename-list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 1180px) {
  .dt-card-wide .dt-theme-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .dt-card-wide .dt-branding-split,
  .dt-layout-split,
  .dt-io-split {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 760px) {
  .dt-card-wide .dt-theme-grid,
  .dt-card-wide .dt-rename-list {
    grid-template-columns: minmax(0, 1fr);
  }
}
```

Порог для переименования вкладок отдельный (1400 px, а не 1180): строка состоит
из подписи и поля, и на четыре колонки ей нужна почти вся ширина контейнера.

- [ ] **Step 4: Поставить заголовок панели в один ряд с лого и favicon**

Сейчас «Заголовок панели» лежит отдельной строкой над `.dt-branding-split`, а по
спеке он идёт третьей колонкой вместе с лого и favicon. В `dt-branding-card`
убрать обёртку `.dt-logging-grid` с полем заголовка и перенести само поле первым
ребёнком внутрь `.dt-branding-split`:

```html
              <div class="dt-branding-split">
                <div class="dt-branding-block">
                  <div class="small" style="opacity:0.9; margin-bottom:6px;"><b>Заголовок панели</b></div>
                  <input id="dt-branding-title" type="text" class="dt-pill-field" placeholder="Xkeen UI" autocomplete="off">
                </div>

                <div class="dt-branding-block">
                  <!-- существующий блок «Лого» без изменений -->
                </div>

                <div class="dt-branding-block">
                  <!-- существующий блок «Favicon» без изменений -->
                </div>
              </div>
```

Id `dt-branding-title` сохраняется, класс `dt-pill-field` тоже — JS брендинга не
меняется. Атрибут `style="grid-column: 1 / -1;"` со старой обёртки уезжает вместе
с ней: в три колонки заголовок больше не растягивается.

- [ ] **Step 5: Перестроить карточку «Экспорт / Импорт»**

В `xkeen-ui/templates/devtools.html`, внутри `dt-ui-prefs-io-card`, блоки Export и Import поставить в две колонки и включить растяжение полей. Заменить содержимое `.dt-collapsible-body` (кроме первой строки-описания) на:

```html
              <div class="dt-io-split">
                <div class="dt-prefs-io-flex">
                  <div class="dt-actions-grid" aria-label="Export actions">
                    <button type="button" id="dt-ui-prefs-export" class="btn-secondary" title="Собрать текущие UI‑настройки в JSON ниже.">Export JSON</button>
                    <button type="button" id="dt-ui-prefs-copy" class="btn-secondary" title="Скопировать JSON в буфер обмена.">Copy</button>
                    <button type="button" id="dt-ui-prefs-download" class="btn-secondary" title="Скачать JSON файлом.">Download</button>
                  </div>
                  <textarea id="dt-ui-prefs-export-text" class="dt-codearea" rows="4" spellcheck="false" placeholder="Нажмите Export JSON…" readonly></textarea>
                </div>

                <div class="dt-prefs-io-flex">
                  <div class="small" style="margin-bottom:6px; opacity:0.9;"><b>Import JSON</b> (вставьте или загрузите файл)</div>
                  <textarea id="dt-ui-prefs-import-text" class="dt-codearea" rows="4" spellcheck="false" placeholder='{ "kind": "xkeen-ui-prefs", "prefs": { ... } }'></textarea>
                  <div class="dt-actions-grid" style="margin-top:8px;" aria-label="Import actions">
                    <button type="button" id="dt-ui-prefs-import" class="btn-secondary" title="Применить JSON из поля выше (перезапишет UI‑настройки).">Import JSON</button>
                    <label id="dt-ui-prefs-import-file-btn" class="btn-secondary dt-btn-like dt-file-label" role="button" tabindex="0" title="Загрузить JSON из файла и вставить в поле импорта.">
                      Import from file
                      <input id="dt-ui-prefs-import-file" type="file" accept="application/json" class="dt-file-input-overlay">
                    </label>
                  </div>
                </div>
              </div>

              <div class="dt-logging-actions" style="margin-top:12px; justify-content:space-between; align-items:center;">
                <span class="small" style="opacity:0.9;"><b>Reset all UI prefs</b> — сброс настроек в этом браузере</span>
                <button type="button" id="dt-ui-prefs-resetall" class="btn-danger" title="Полный сброс UI‑настроек (в браузере): тема/типографика/layout/скрытия/перетасовка вкладок и т.д.">Reset all</button>
              </div>

              <div id="dt-ui-prefs-io-status" class="small" style="margin-top:8px; opacity:0.85;"></div>
```

Все id сохранены один в один — JS этой карточки не меняется.

- [ ] **Step 6: Перестроить карточку Layout‑твиков**

В `dt-layout-card` завернуть содержимое `.dt-collapsible-body` в две колонки: слева переключатели и селекты (всё от `dt-layout-compact` до `dt-layout-container`), справа — редактор порядка вкладок. Снаружи двух колонок остаются только описание сверху и кнопка `dt-layout-tabs-reset` снизу:

```html
              <div class="dt-layout-split">
                <div>
                  <!-- переключатели dt-layout-compact … dt-layout-hide-unused и селекты
                       dt-layout-desc-scale, dt-layout-container — без изменений -->
                </div>
                <div>
                  <div class="small" style="margin-bottom:8px; opacity:0.9;">
                    Вкладки основной панели: перетаскивайте для перестановки, ⭐ закрепляет вкладку слева.
                  </div>
                  <ul class="dt-tab-list" id="dt-layout-tab-list" aria-label="Tab order editor"></ul>
                </div>
              </div>
```

Разделитель `<hr>` перед редактором вкладок удалить: колонки уже разделяют блоки.

- [ ] **Step 7: Запустить тесты и убедиться, что они проходят**

Run: `pytest tests/test_devtools_tools_zones.py -v`
Expected: PASS, все тесты файла.

- [ ] **Step 8: Коммит**

```bash
git -c user.name=olmer2002 -c user.email=olmer2002@gmail.com add xkeen-ui/static/styles.css xkeen-ui/templates/devtools.html tests/test_devtools_tools_zones.py
git -c user.name=olmer2002 -c user.email=olmer2002@gmail.com commit -m "Широкие карточки Tools раскладываются в колонки"
```

---

### Task 6: E2E на раскладку и память сворачивания

**Files:**
- Create: `e2e/devtools_tools_zones.spec.mjs`
- Test: он же

**Interfaces:**
- Consumes: всё из задач 1–5.
- Produces: ничего для следующих задач.

- [ ] **Step 1: Написать падающий спек**

Создать `e2e/devtools_tools_zones.spec.mjs`:

```javascript
import { test, expect } from './fixtures.mjs';


async function openTools(page, viewport) {
  await page.setViewportSize(viewport);
  await page.goto('/devtools');
  await expect(page.locator('body')).toHaveClass(/\bdevtools-page\b/);
  await expect(page.locator('#dt-env-card')).toBeVisible();
}


test.describe('DevTools Tools zones', () => {
  test('cards are laid out in three zones without horizontal scroll', async ({ page }) => {
    await openTools(page, { width: 1600, height: 1000 });

    const heads = page.locator('#dt-tab-tools .dt-zone-head');
    await expect(heads).toHaveCount(3);
    await expect(heads.nth(0)).toHaveText('Сервис, обновление и настройки');
    await expect(heads.nth(1)).toHaveText('Система');
    await expect(heads.nth(2)).toHaveText('Вид интерфейса');

    const geometry = await page.evaluate(() => {
      const zoneLabel = (id) => document.getElementById(id).closest('.dt-zone')?.getAttribute('aria-label') || '';
      const bottom = (id) => document.getElementById(id).getBoundingClientRect().bottom;
      return {
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        happZone: zoneLabel('dt-happ-decryptor-card'),
        terminalZone: zoneLabel('dt-terminal-theme-card'),
        brandingZone: zoneLabel('dt-branding-card'),
        layoutZone: zoneLabel('dt-layout-card'),
        trayBottom: document.querySelector('.dt-tools-left').getBoundingClientRect().bottom,
        envBottom: bottom('dt-env-card'),
        prefsBottom: bottom('dt-ui-prefs-card'),
        ioBottom: bottom('dt-ui-prefs-io-card'),
      };
    });

    expect(geometry.pageOverflow).toBeLessThanOrEqual(1);
    expect(geometry.happZone).toBe('Система');
    expect(geometry.terminalZone).toBe('Система');
    expect(geometry.brandingZone).toBe('Вид интерфейса');
    expect(geometry.layoutZone).toBe('Вид интерфейса');
    expect(Math.abs(geometry.trayBottom - geometry.envBottom)).toBeLessThanOrEqual(2);
    expect(Math.abs(geometry.prefsBottom - geometry.ioBottom)).toBeLessThanOrEqual(2);
  });

  test('zones collapse to one column on a narrow screen', async ({ page }) => {
    await openTools(page, { width: 900, height: 900 });

    const columns = await page.evaluate(() => {
      const zone = document.querySelector('#dt-tab-tools .dt-zone');
      return getComputedStyle(zone).gridTemplateColumns.split(' ').length;
    });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );

    expect(columns).toBe(1);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('terminal theme card starts collapsed and remembers being opened', async ({ page }) => {
    await openTools(page, { width: 1600, height: 1000 });

    const card = page.locator('#dt-terminal-theme-card');
    await expect(card).not.toHaveAttribute('open', /.*/);

    await card.locator('summary').click();
    await expect(card).toHaveAttribute('open', /.*/);

    await page.reload();
    await expect(page.locator('#dt-env-card')).toBeVisible();
    await expect(page.locator('#dt-terminal-theme-card')).toHaveAttribute('open', /.*/);

    const stored = await page.evaluate(
      () => localStorage.getItem('xk.devtools.collapse.dt-terminal-theme-card.open'),
    );
    expect(stored).toBe('1');

    await page.locator('#dt-terminal-theme-card summary').click();
    await page.reload();
    await expect(page.locator('#dt-env-card')).toBeVisible();
    await expect(page.locator('#dt-terminal-theme-card')).not.toHaveAttribute('open', /.*/);
  });
});
```

- [ ] **Step 2: Собрать фронтенд и запустить спек**

Run: `npm run frontend:build && npx playwright test e2e/devtools_tools_zones.spec.mjs`
Expected: PASS. Если тест «starts collapsed» падает на чтении `localStorage` — проверить префикс ключа: его задаёт `storagePrefix: 'xk.devtools.collapse.'` в `static/js/features/devtools.js:20`, а `CORE_STORAGE.ns` может добавлять свой префикс. Взять фактическое имя ключа из `page.evaluate(() => Object.keys(localStorage))` и поправить ожидание в тесте, а не в продуктовом коде.

- [ ] **Step 3: Коммит**

```bash
git -c user.name=olmer2002 -c user.email=olmer2002@gmail.com add e2e/devtools_tools_zones.spec.mjs
git -c user.name=olmer2002 -c user.email=olmer2002@gmail.com commit -m "E2E на зоны Tools и память сворачивания терминала"
```

---

### Task 7: Полный прогон и осмотр глазами

**Files:**
- Modify: любые из предыдущих задач — только если что-то всплывёт

- [ ] **Step 1: Прогнать питоновские тесты целиком**

Run (из Bash, не из PowerShell): `pytest -q`
Expected: PASS. Падения в `tests/test_version_check.py` при запуске из PowerShell — известная особенность окружения, не регрессия.

- [ ] **Step 2: Прогнать e2e целиком**

Run: `npm run frontend:build && npx playwright test`
Expected: прежний зелёный результат плюс новый спек. Если осиротевший сервер занял порт 18188 от прерванного прогона — убить его, иначе тесты уйдут на устаревшие шаблоны.

- [ ] **Step 3: Осмотреть страницу в четырёх сочетаниях**

Открыть `/devtools` и проверить: тёмная и светлая тема × основная тема и тема оператора (переключатель темы в шапке, тема оператора — последним подключённым стилем). Смотреть:

1. три подписи зон на месте, карточки в нужных зонах;
2. поднос слева кончается на одной линии с ENV, хвост `update.log` скроллится внутри;
3. терминал свёрнут; после раскрытия его поля стоят в четыре колонки;
4. «Интерфейс» и «Экспорт / Импорт» одной высоты;
5. в Брендинге все восемь полей переименования читаемы целиком;
6. на ширине 900 px всё в одну колонку, горизонтального скролла нет.

- [ ] **Step 4: Проверить поведение ENV-вайтлиста**

Запустить панель с `XKEEN_UI_DEVTOOLS_SECTIONS_WHITELIST=env,service,update` и убедиться, что подписи «Система» и «Вид интерфейса» исчезли вместе со своими карточками, а не висят над пустотой.

- [ ] **Step 5: Коммит, если что-то правилось**

```bash
git -c user.name=olmer2002 -c user.email=olmer2002@gmail.com add -A
git -c user.name=olmer2002 -c user.email=olmer2002@gmail.com commit -m "Правки после осмотра перекомпонованной вкладки Tools"
```

---

## Вне этого плана

- Сводки текущих значений в заголовках карточек — отдельная вторая итерация, каркас от них не зависит.
- Логика карточек, их запросы и обработчики.
- Вкладка Logs.
