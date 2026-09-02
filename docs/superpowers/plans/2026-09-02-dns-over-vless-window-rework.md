# Переработка окна DNS-over-VLESS — план работ

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Разложить окно DNS-over-VLESS на шесть именованных зон с двумя переключаемыми раскладками, не потеряв ни одного объяснения и ни одного id.

**Architecture:** Разметка одна, раскладок две — они отличаются только сеткой `grid-template-areas` на `.routing-dns-over-vless-body` и переключаются атрибутом `data-dns-layout` на `.modal-content`. Зоны и раскрывашки подсказок — нативные `<details>`, поэтому открытие и закрытие не требует кода. Все id элементов сохраняются: `dns_over_vless.js` адресует их через плоскую карту `DOM` и по структуре не ходит.

**Tech Stack:** Jinja-шаблон `panel.html`, ванильный JS (`XKeen.ui.settings`), CSS с токенами `--op-*`, pytest для разметки и исходников, Playwright для поведения и снимков.

**Spec:** `docs/superpowers/specs/2026-09-02-dns-over-vless-window-rework-design.md`

## Global Constraints

- Все id элементов окна сохраняются без изменений — список в спецификации, раздел «Решение».
- Ни одна из 13 подсказок не удаляется; текст можно только делить на видимую часть и содержимое `<details>`.
- Модификатор «переключатель без чипа» применяется адресно к переключателям внутри модальных форм. Снимать чип у `.dt-switch` или `.xk-mini-switch` глобально нельзя: класс используется в `routing-side-card` (`panel-operator.css:5355`) и в панелях инструментов, где чип уместен.
- Порог схлопывания в одну колонку — 1100 px. Ниже него раскладка всегда одноколоночная, даже при `split`.
- Значения настройки раскладки: `auto` (по умолчанию), `single`, `split`.
- Коммиты: `git -c user.name="olmer2002" -c user.email="olmer2002@gmail.com" commit`. Сообщения на русском, простым языком, без трейлеров `Co-Authored-By`.
- После правок `panel.html` пересобирать описи генераторами и синхронизировать ключ сброса кеша `panel-operator.css` в шаблоне и восьми тестах (Task 9).
- Запуск python-тестов: `python -m pytest tests -q`. Перед e2e обязателен `npm run frontend:build`.

---

### Task 1: Настройка раскладки на сервере

**Files:**
- Modify: `xkeen-ui/services/ui_settings.py:85-97` (DEFAULTS), `:187-192` (канонический пустой), `:492-530` (нормализация)
- Test: `tests/test_ui_settings_dns_layout.py`

**Interfaces:**
- Consumes: ничего.
- Produces: ключ `routing.dnsOverVlessLayout` в ответе `GET /api/ui-settings`; допустимые значения `"auto" | "single" | "split"`, значение по умолчанию `"auto"`. Task 7 читает его через `XKeen.ui.settings.get().routing.dnsOverVlessLayout`.

- [ ] **Step 1: Написать падающий тест**

```python
# tests/test_ui_settings_dns_layout.py
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "xkeen-ui"))

from services.ui_settings import DEFAULTS, normalize  # noqa: E402


def test_layout_defaults_to_auto():
    assert DEFAULTS["routing"]["dnsOverVlessLayout"] == "auto"


def test_layout_accepts_known_values():
    for value in ("auto", "single", "split"):
        out, _rep = normalize({"routing": {"dnsOverVlessLayout": value}})
        assert out["routing"]["dnsOverVlessLayout"] == value


def test_layout_is_case_insensitive():
    out, _rep = normalize({"routing": {"dnsOverVlessLayout": "SPLIT"}})
    assert out["routing"]["dnsOverVlessLayout"] == "split"


def test_unknown_layout_falls_back_to_auto_and_warns():
    out, rep = normalize({"routing": {"dnsOverVlessLayout": "three-columns"}})
    assert out["routing"]["dnsOverVlessLayout"] == "auto"
    assert any(w.get("path") == "routing.dnsOverVlessLayout" for w in rep.warnings)


def test_wrong_type_falls_back_to_auto():
    out, rep = normalize({"routing": {"dnsOverVlessLayout": 5}})
    assert out["routing"]["dnsOverVlessLayout"] == "auto"
    assert rep.changed is True
```

Если `normalize` экспортируется под другим именем — открыть `xkeen-ui/services/ui_settings.py`, найти публичную функцию нормализации (она возвращает пару «настройки, отчёт») и подставить её имя во всех пяти тестах.

- [ ] **Step 2: Убедиться, что тест падает**

Run: `python -m pytest tests/test_ui_settings_dns_layout.py -q`
Expected: FAIL — `KeyError: 'dnsOverVlessLayout'`.

- [ ] **Step 3: Добавить значение по умолчанию**

В `DEFAULTS["routing"]` (после `showScenarioCard`):

```python
        # Раскладка окна DNS-over-VLESS: "auto" — две колонки, если помещаются,
        # "single" — всегда одна, "split" — всегда две. Ниже 1100 px любая
        # раскладка схлопывается в одну колонку: на планшете двух колонок нет.
        "dnsOverVlessLayout": "auto",
```

В `_canonical_empty()`, в блоке `"routing": {`:

```python
            "dnsOverVlessLayout": str(DEFAULTS["routing"]["dnsOverVlessLayout"]),
```

- [ ] **Step 4: Добавить нормализацию**

В блоке `# ---- routing ----`, после `show_scenario_card`:

```python
        dns_layout = routing_raw.get("dnsOverVlessLayout")
        if dns_layout is not None:
            value = _as_lower_str(dns_layout)
            if value in ("auto", "single", "split"):
                out["routing"]["dnsOverVlessLayout"] = value
            else:
                # Неизвестная раскладка — это чаще всего настройка из будущей
                # версии. Откатываемся к auto, а не роняем весь блок routing.
                rep.warnings.append(
                    {"path": "routing.dnsOverVlessLayout", "warning": "unknown value; reset to auto"}
                )
                rep.changed = True
```

- [ ] **Step 5: Убедиться, что тесты проходят**

Run: `python -m pytest tests/test_ui_settings_dns_layout.py -q`
Expected: PASS, 5 тестов.

- [ ] **Step 6: Убедиться, что не сломались соседние**

Run: `python -m pytest tests -q -k ui_settings`
Expected: PASS.

- [ ] **Step 7: Коммит**

```bash
git add xkeen-ui/services/ui_settings.py tests/test_ui_settings_dns_layout.py
git -c user.name="olmer2002" -c user.email="olmer2002@gmail.com" commit -m "Панель запоминает, в сколько колонок показывать окно DNS-over-VLESS"
```

---

### Task 2: Переключатель без чипа

**Files:**
- Modify: `xkeen-ui/static/panel-operator.css` (в конце секции primitives, рядом с блоком `body.panel-page .dt-switch-label` на строке 986)
- Test: `tests/test_dns_modal_switches.py`

**Interfaces:**
- Consumes: ничего.
- Produces: класс-модификатор `xk-switch-bare`, который ставится рядом с `dt-switch` на `<label>`. Tasks 4 и 10 навешивают его в разметке.

- [ ] **Step 1: Написать падающий тест**

```python
# tests/test_dns_modal_switches.py
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CSS = (ROOT / "xkeen-ui/static/panel-operator.css").read_text(encoding="utf-8")


def test_bare_switch_drops_the_toolbar_chip():
    start = CSS.index("body.panel-page .dt-switch.xk-switch-bare {")
    block = CSS[start:CSS.index("}", start)]
    # Чип задан в базовом .dt-switch (styles.css) и снимается целиком,
    # иначе от таблетки остаётся половина: фон без рамки или наоборот.
    for fragment in ("padding: 0", "border: 0", "background: none", "border-radius: 0"):
        assert fragment in block, fragment


def test_bare_switch_does_not_touch_the_shared_primitive():
    # Снять чип у всех .dt-switch нельзя: класс живёт в панелях инструментов
    # и в routing-side-card, где таблетка уместна.
    assert "body.panel-page .dt-switch {" not in CSS
    assert "body.panel-page .xk-mini-switch {" not in CSS
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `python -m pytest tests/test_dns_modal_switches.py -q`
Expected: FAIL — `ValueError: substring not found`.

- [ ] **Step 3: Добавить модификатор**

```css
/* Переключатель формы, а не панели инструментов.
 *
 * Базовый .dt-switch (styles.css:13964) приходит завёрнутым в «чип»: padding,
 * border-radius: 9999px, рамка и фон. В тулбаре с короткой подписью это
 * таблетка, а в модальной форме, где контейнер — грид (styles.css:19302) или
 * где .xk-mini-switch сам ставит width: 100%, чип растягивается на всю
 * колонку и превращается в широкую плашку.
 *
 * Модификатор адресный: у общего примитива чип остаётся.
 */
body.panel-page .dt-switch.xk-switch-bare {
  padding: 0;
  border: 0;
  background: none;
  border-radius: 0;
  width: auto;
}

body.panel-page .dt-switch.xk-switch-bare:hover {
  background: none;
}

body.panel-page .dt-switch.xk-switch-bare .dt-switch-label {
  color: var(--op-text);
  font-size: calc(11px * var(--xk-font-scale, 1));
  font-weight: 600;
}
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `python -m pytest tests/test_dns_modal_switches.py -q`
Expected: PASS, 2 теста.

- [ ] **Step 5: Коммит**

```bash
git add xkeen-ui/static/panel-operator.css tests/test_dns_modal_switches.py
git -c user.name="olmer2002" -c user.email="olmer2002@gmail.com" commit -m "Переключатели в окнах DNS перестают выглядеть широкими плашками"
```

---

### Task 3: Подсказки под «Подробнее»

**Files:**
- Modify: `xkeen-ui/templates/panel.html:2563-2686`, `xkeen-ui/static/panel-operator.css`
- Test: `tests/test_dns_modal_hints.py`

**Interfaces:**
- Consumes: ничего.
- Produces: разметка `<p class="modal-hint">Короткая суть. <details class="xk-hint-more"><summary>Подробнее</summary><p>…</p></details></p>` — Task 4 переносит эти абзацы в зоны как есть.

- [ ] **Step 1: Написать падающий тест**

```python
# tests/test_dns_modal_hints.py
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = (ROOT / "xkeen-ui/templates/panel.html").read_text(encoding="utf-8")

START = '<div id="routing-dns-over-vless-modal"'
END = '<div id="mihomo-dns-modal"'
MODAL = TEMPLATE[TEMPLATE.index(START):TEMPLATE.index(END)]

# Фразы, ради которых подсказки и писались. Если хоть одна пропала при
# переносе под «Подробнее» — объяснение потеряно, а не свёрнуто.
KEPT = (
    "имя хоста пришлось бы разрешать",
    "127.0.0.1:41100",
    "geoip:private",
    "Встроенный DNS Xray отвечает только на A и AAAA",
    "балансировщик указать нельзя",
    "перестают действовать DNS-фильтры прошивки",
    "заворачивает на собственный резолвер",
    "Эти запросы увидит провайдер",
)


def test_no_explanation_is_lost():
    for phrase in KEPT:
        assert phrase in MODAL, phrase


def test_long_explanations_live_under_a_disclosure():
    assert MODAL.count('<details class="xk-hint-more">') >= 6
    assert MODAL.count("<summary>Подробнее</summary>") == MODAL.count('<details class="xk-hint-more">')


def test_visible_part_of_a_hint_stays_short():
    # Видимая часть — одна строка «что сюда вписывать». Всё длинное уезжает
    # под раскрывашку, иначе окно снова превращается в четыре страницы текста.
    for hint in re.findall(r'<p class="modal-hint[^"]*"[^>]*>(.*?)(?=<details|</p>)', MODAL, re.S):
        visible = re.sub(r"<[^>]+>", "", hint).strip()
        assert len(visible) <= 200, visible[:80]
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `python -m pytest tests/test_dns_modal_hints.py -q`
Expected: FAIL — `test_long_explanations_live_under_a_disclosure` и `test_visible_part_of_a_hint_stays_short`.

- [ ] **Step 3: Разделить подсказки**

Для каждой из тринадцати подсказок в окне: первое предложение (что вписывать) остаётся видимым, остальное уезжает под раскрывашку. Образец на подсказке к полю серверов:

```html
<p class="modal-hint">Через запятую, только по IP-адресу.
  <details class="xk-hint-more">
    <summary>Подробнее</summary>
    <p>Имя хоста пришлось бы разрешать до того, как заработает сам DNS, — резолвить его нечем. Второй и следующие используются, когда первый не отвечает. Порт указывайте, если резолвер слушает не на 53 — например <code>127.0.0.53:5353</code>. Шифрованный апстрим задаётся схемой <code>https://</code> — с адресом и обязательным путём, например <code>https://1.1.1.1/dns-query</code>; без пути сервер не ответит. Есть ещё <code>tcp://</code> — обычный DNS поверх TCP. Схемы <code>tls://</code> и <code>quic://</code> ядро Xray не понимает, панель их не примет. На остальные типы записей схема не распространяется: при включённом пропуске ниже они уходят к тому же адресу обычным DNS на порт 53.</p>
  </details>
</p>
```

Подсказки короче 200 символов (например «DNS пойдёт через выбранный балансировщик или прокси…») оставить как есть, без раскрывашки.

- [ ] **Step 4: Оформить раскрывашку**

В `panel-operator.css`:

```css
/* Длинные объяснения не удалены, а свёрнуты: нативный <details> даёт
 * клавиатурную доступность и не требует ни строчки JS. */
body.panel-page .xk-hint-more {
  display: inline;
}

body.panel-page .xk-hint-more > summary {
  display: inline;
  cursor: pointer;
  color: var(--op-accent-hover);
  text-decoration: underline dotted;
  list-style: none;
}

body.panel-page .xk-hint-more > summary::-webkit-details-marker {
  display: none;
}

body.panel-page .xk-hint-more[open] > summary {
  color: var(--op-muted);
}

body.panel-page .xk-hint-more > p {
  margin: 6px 0 0;
  padding-left: 10px;
  border-left: 2px solid var(--op-border);
  color: var(--op-muted);
}
```

- [ ] **Step 5: Убедиться, что тесты проходят**

Run: `python -m pytest tests/test_dns_modal_hints.py -q`
Expected: PASS, 3 теста.

- [ ] **Step 6: Коммит**

```bash
git add xkeen-ui/templates/panel.html xkeen-ui/static/panel-operator.css tests/test_dns_modal_hints.py
git -c user.name="olmer2002" -c user.email="olmer2002@gmail.com" commit -m "Длинные пояснения в окне DNS-over-VLESS убираются под «Подробнее»"
```

---

### Task 4: Зонирование разметки

**Files:**
- Modify: `xkeen-ui/templates/panel.html:2563-2686`
- Test: `tests/test_dns_modal_zones.py`

**Interfaces:**
- Consumes: `xk-switch-bare` (Task 2), разметку подсказок (Task 3).
- Produces: шесть секций `<details class="xk-dns-zone" data-zone="route|servers|home|direct|records|devices">` с `<summary class="xk-dns-zone-head">`, внутри неё `<b>` с названием, `<span class="xk-dns-zone-opt">необязательно</span>` у необязательных и `<span class="xk-dns-zone-sum" data-zone-sum="…"></span>` для сводки. Task 5 раскладывает эти секции по областям сетки, Task 6 заполняет сводки.

- [ ] **Step 1: Написать падающий тест**

```python
# tests/test_dns_modal_zones.py
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = (ROOT / "xkeen-ui/templates/panel.html").read_text(encoding="utf-8")
MODAL = TEMPLATE[TEMPLATE.index('<div id="routing-dns-over-vless-modal"'):TEMPLATE.index('<div id="mihomo-dns-modal"')]

ZONES = ("route", "servers", "home", "direct", "records", "devices")

# Полный список id окна. Модуль dns_over_vless.js адресует их через плоскую
# карту DOM, поэтому перекладывать узлы можно, а терять id — нет.
IDS = (
    "badge", "lead-title", "lead-text", "status", "details", "route", "target",
    "target-tools", "target-count", "target-all", "target-none", "route-fallback",
    "multi", "multi-row", "upstreams", "remote", "local", "zones", "zones-row",
    "zone-presets", "direct", "direct-zones", "direct-zones-row",
    "direct-from-rules", "pass", "pass-row", "pass-node", "pass-health",
    "clients", "clients-summary", "clients-list", "capture", "reset",
)


def test_every_id_survives_the_rework():
    for name in IDS:
        assert f'id="routing-dns-over-vless-{name}"' in MODAL, name


def test_six_zones_exist():
    for zone in ZONES:
        assert f'<details class="xk-dns-zone" data-zone="{zone}"' in MODAL, zone


def test_required_zones_are_open_and_optional_are_not():
    for zone in ("route", "servers"):
        block = MODAL[MODAL.index(f'data-zone="{zone}"'):]
        assert block[:80].find(" open") != -1, zone
    for zone in ("home", "direct", "records", "devices"):
        block = MODAL[MODAL.index(f'data-zone="{zone}"'):]
        assert block[:80].find(" open") == -1, zone


def test_optional_zones_are_labelled_and_carry_a_summary_slot():
    for zone in ("home", "direct", "records", "devices"):
        start = MODAL.index(f'data-zone="{zone}"')
        head = MODAL[start:MODAL.index("</summary>", start)]
        assert '<span class="xk-dns-zone-opt">необязательно</span>' in head, zone
        assert f'data-zone-sum="{zone}"' in head, zone


def test_section_switches_sit_in_the_subheader():
    for zone, switch in (("records", "pass"), ("devices", "capture")):
        start = MODAL.index(f'data-zone="{zone}"')
        head = MODAL[start:MODAL.index("</summary>", start)]
        assert f'id="routing-dns-over-vless-{switch}"' in head, zone
        assert "xk-switch-bare" in head, zone


def test_flag_switch_is_bare_too():
    start = MODAL.index('id="routing-dns-over-vless-remote"')
    label = MODAL[MODAL.rindex("<label", 0, start):start]
    assert "xk-switch-bare" in label
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `python -m pytest tests/test_dns_modal_zones.py -q`
Expected: FAIL — `test_six_zones_exist`.

- [ ] **Step 3: Переложить разметку в зоны**

Образец одной обязательной и одной необязательной зоны; остальные четыре — по той же форме, состав полей взят из таблицы в спецификации:

```html
<details class="xk-dns-zone" data-zone="route" open>
  <summary class="xk-dns-zone-head">
    <b>Маршрут для DNS-запросов</b>
  </summary>
  <div class="xk-dns-zone-body" id="routing-dns-over-vless-route">
    <!-- сюда без изменений переезжает содержимое прежнего блока route:
         multi-row, target-tools, target, route-hint, route-fallback -->
  </div>
</details>

<details class="xk-dns-zone" data-zone="records">
  <summary class="xk-dns-zone-head">
    <b>Прочие типы записей</b>
    <span class="xk-dns-zone-opt">необязательно</span>
    <span class="xk-dns-zone-sum" data-zone-sum="records"></span>
    <label class="dt-switch xk-switch-bare" title="Пропускать типы записей, на которые встроенный DNS Xray не отвечает.">
      <input type="checkbox" id="routing-dns-over-vless-pass">
      <span class="dt-switch-slider" aria-hidden="true"></span>
    </label>
  </summary>
  <div class="xk-dns-zone-body">
    <!-- подсказка про A/AAAA и блок pass-row без изменений -->
  </div>
</details>
```

Важно: `id="routing-dns-over-vless-route"` переезжает на внутренний `<div class="xk-dns-zone-body">`, а не на `<details>`. Task 8 продолжит прятать этим id только выбор маршрута.

- [ ] **Step 4: Оформить зоны**

В `panel-operator.css`:

```css
body.panel-page .xk-dns-zone {
  border: 1px solid var(--op-border);
  border-radius: var(--op-radius);
  background: var(--op-surface-2);
  overflow: hidden;
}

body.panel-page .xk-dns-zone-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  cursor: pointer;
  list-style: none;
}

body.panel-page .xk-dns-zone-head::-webkit-details-marker { display: none; }

body.panel-page .xk-dns-zone-head > b {
  color: var(--op-text-strong);
  font-size: calc(12.5px * var(--xk-font-scale, 1));
  font-weight: 600;
}

body.panel-page .xk-dns-zone-opt {
  font-size: calc(9.5px * var(--xk-font-scale, 1));
  color: var(--op-faint);
  border: 1px solid var(--op-border);
  border-radius: 999px;
  padding: 1px 7px;
}

/* Сводка прижата вправо и исчезает, когда зона раскрыта: там уже видно
 * настоящие значения, а повтор только шумит. */
body.panel-page .xk-dns-zone-sum {
  margin-left: auto;
  color: var(--op-data-muted);
  font-size: calc(10.5px * var(--xk-font-scale, 1));
  font-variant-numeric: tabular-nums;
}

body.panel-page .xk-dns-zone[open] .xk-dns-zone-sum { display: none; }

body.panel-page .xk-dns-zone-head .dt-switch { margin-left: auto; }
body.panel-page .xk-dns-zone-sum ~ .dt-switch { margin-left: 0; }

body.panel-page .xk-dns-zone-body {
  display: grid;
  gap: 6px;
  padding: 10px 12px 12px;
  border-top: 1px solid var(--op-border);
}
```

- [ ] **Step 5: Убедиться, что тесты проходят**

Run: `python -m pytest tests/test_dns_modal_zones.py tests/test_dns_modal_hints.py -q`
Expected: PASS.

- [ ] **Step 6: Коммит**

```bash
git add xkeen-ui/templates/panel.html xkeen-ui/static/panel-operator.css tests/test_dns_modal_zones.py
git -c user.name="olmer2002" -c user.email="olmer2002@gmail.com" commit -m "Окно DNS-over-VLESS разделено на шесть именованных зон"
```

---

### Task 5: Две раскладки

**Files:**
- Modify: `xkeen-ui/templates/panel.html` (класс ширины и атрибут на `.modal-content`), `xkeen-ui/static/panel-operator.css`
- Test: `tests/test_dns_modal_layouts.py`

**Interfaces:**
- Consumes: зоны из Task 4.
- Produces: атрибут `data-dns-layout="single|split"` на `.routing-dns-over-vless-modal-content`; области сетки `lead state route servers home direct records devices foot`. Task 7 переключает этот атрибут.

- [ ] **Step 1: Написать падающий тест**

```python
# tests/test_dns_modal_layouts.py
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CSS = (ROOT / "xkeen-ui/static/panel-operator.css").read_text(encoding="utf-8")
TEMPLATE = (ROOT / "xkeen-ui/templates/panel.html").read_text(encoding="utf-8")
MODAL = TEMPLATE[TEMPLATE.index('<div id="routing-dns-over-vless-modal"'):TEMPLATE.index('<div id="mihomo-dns-modal"')]


def test_modal_starts_in_a_known_layout():
    assert 'data-dns-layout="single"' in MODAL
    # Ширина берётся из существующего размера системы, а не заводится своя.
    assert "xk-modal-width-1160" in MODAL


def test_both_layouts_are_declared():
    assert '[data-dns-layout="single"] .routing-dns-over-vless-body {' in CSS
    assert '[data-dns-layout="split"] .routing-dns-over-vless-body {' in CSS


def test_narrow_screens_collapse_to_one_column():
    start = CSS.index("@media (max-width: 1100px)")
    block = CSS[start:start + 600]
    assert 'data-dns-layout="split"' in block
    assert "grid-template-areas" in block
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `python -m pytest tests/test_dns_modal_layouts.py -q`
Expected: FAIL — `data-dns-layout="single"` не найден.

- [ ] **Step 3: Проставить атрибут и ширину в шаблоне**

```html
<div class="modal-content xk-modal-width xk-modal-width-1160 routing-dns-over-vless-modal-content" data-dns-layout="single">
```

Каждой зоне и каждому блоку задать область через `style`-свободный способ — классом в CSS по `data-zone`, см. следующий шаг.

- [ ] **Step 4: Описать две сетки**

```css
body.panel-page #routing-dns-over-vless-modal .routing-dns-over-vless-body {
  display: grid;
  gap: 10px;
  align-items: start;
}

body.panel-page .routing-dns-over-vless-lead { grid-area: lead; }
body.panel-page #routing-dns-over-vless-status { grid-area: state; }
body.panel-page .xk-dns-zone[data-zone="route"] { grid-area: route; }
body.panel-page .xk-dns-zone[data-zone="servers"] { grid-area: servers; }
body.panel-page .xk-dns-zone[data-zone="home"] { grid-area: home; }
body.panel-page .xk-dns-zone[data-zone="direct"] { grid-area: direct; }
body.panel-page .xk-dns-zone[data-zone="records"] { grid-area: records; }
body.panel-page .xk-dns-zone[data-zone="devices"] { grid-area: devices; }
body.panel-page .routing-dns-over-vless-foot { grid-area: foot; }

/* Одна колонка: порядок чтения сверху вниз, состояние и устройства в потоке. */
body.panel-page [data-dns-layout="single"] .routing-dns-over-vless-body {
  grid-template-columns: minmax(0, 1fr);
  grid-template-areas:
    "lead"
    "state"
    "route"
    "servers"
    "home"
    "direct"
    "records"
    "devices"
    "foot";
}

/* Две колонки: слева настройка, справа «как это работает сейчас».
 * Разбор по устройствам — главная диагностика окна, и в рельсе он виден
 * сразу, а не после прокрутки длинной формы. */
body.panel-page [data-dns-layout="split"] .routing-dns-over-vless-body {
  grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr);
  grid-template-areas:
    "lead    lead"
    "route   state"
    "servers devices"
    "home    devices"
    "direct  foot"
    "records foot";
}

/* Ниже этого порога двух колонок физически нет — схлопываемся независимо
 * от выбранной настройки. */
@media (max-width: 1100px) {
  body.panel-page [data-dns-layout="split"] .routing-dns-over-vless-body {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      "lead" "state" "route" "servers" "home" "direct" "records" "devices" "foot";
  }
}
```

- [ ] **Step 5: Собрать подвал в один блок**

Ссылки (`.routing-dns-over-vless-links`) и предупреждение про Mihomo (`.routing-dns-over-vless-warning`) обернуть в `<div class="routing-dns-over-vless-foot">`, чтобы они переезжали в рельс одним куском.

- [ ] **Step 6: Убедиться, что тесты проходят**

Run: `python -m pytest tests/test_dns_modal_layouts.py -q`
Expected: PASS, 3 теста.

- [ ] **Step 7: Коммит**

```bash
git add xkeen-ui/templates/panel.html xkeen-ui/static/panel-operator.css tests/test_dns_modal_layouts.py
git -c user.name="olmer2002" -c user.email="olmer2002@gmail.com" commit -m "У окна DNS-over-VLESS появилась вторая раскладка в две колонки"
```

---

### Task 6: Сводки зон и клик по переключателю в подшапке

**Files:**
- Modify: `xkeen-ui/static/js/features/routing_cards/rules/dns_over_vless.js`
- Test: `tests/test_dns_over_vless_zone_summaries.py`, `e2e/dns_over_vless_zones.spec.mjs`

**Interfaces:**
- Consumes: слоты `data-zone-sum` (Task 4).
- Produces: функция `renderZoneSummaries(data)`, вызываемая из `render(data)` после `renderDnsFields(data)`. Task 7 её не трогает.

- [ ] **Step 1: Написать падающий тест на исходник**

```python
# tests/test_dns_over_vless_zone_summaries.py
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JS = (ROOT / "xkeen-ui/static/js/features/routing_cards/rules/dns_over_vless.js").read_text(encoding="utf-8")


def test_summaries_are_rendered_for_every_optional_zone():
    assert "function renderZoneSummaries(" in JS
    for zone in ("home", "direct", "records", "devices"):
        assert f'"{zone}"' in JS or f"'{zone}'" in JS, zone


def test_summaries_are_refreshed_from_render():
    body = JS[JS.index("function render(data) {"):]
    assert "renderZoneSummaries(" in body[:body.index("\n  function ")]


def test_switch_click_does_not_fold_the_zone():
    # Переключатель живёт в <summary>; без гашения всплытия нажатие на слайдер
    # свернуло бы зону вместе с включением настройки.
    assert "stopPropagation" in JS
    assert "xk-dns-zone-head" in JS
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `python -m pytest tests/test_dns_over_vless_zone_summaries.py -q`
Expected: FAIL — `renderZoneSummaries` не найдена.

- [ ] **Step 3: Реализовать сводки**

```js
  // Сводка нужна ровно для того, чтобы свёрнутое не значило «спрятанное»:
  // по шапкам должно читаться состояние всего окна, без раскрытия зон.
  function zoneSummaryText(zone, data) {
    if (zone === 'home') {
      const list = (data && data.local_resolvers) || [];
      if (!list.length) return 'не настроена';
      const zones = parseZones(($(DOM.zones) || {}).value || '');
      return `${list.length} резолвер(ов) · ${zones.length} зон`;
    }
    if (zone === 'direct') {
      const list = (data && data.direct_resolvers) || [];
      if (!list.length) return 'не настроены';
      const domains = (data && data.direct_domains) || [];
      return `${list.length} резолвер(ов) · ${domains.length} доменов`;
    }
    if (zone === 'records') {
      if (!(data && data.pass_non_ip)) return 'выключено';
      const node = (data && data.pass_non_ip_node) || '';
      return node ? `включено · узел ${node}` : 'включено';
    }
    if (zone === 'devices') {
      const summary = $(DOM.clientsSummary);
      return (summary && summary.textContent.trim()) || 'проверяем…';
    }
    return '';
  }

  function renderZoneSummaries(data) {
    const slots = document.querySelectorAll('[data-zone-sum]');
    for (let i = 0; i < slots.length; i += 1) {
      const slot = slots[i];
      slot.textContent = zoneSummaryText(slot.dataset.zoneSum, data);
    }
  }
```

- [ ] **Step 4: Вызвать из render и погасить всплытие**

В конце `render(data)`, после `renderDnsFields(data)`:

```js
    renderZoneSummaries(data);
```

В `init()`:

```js
    // Клик по переключателю в подшапке меняет настройку, а не сворачивает зону.
    document.addEventListener('click', (event) => {
      const target = event.target;
      if (!target || !target.closest) return;
      if (target.closest('.xk-dns-zone-head .dt-switch')) event.stopPropagation();
    }, true);
```

- [ ] **Step 5: Написать e2e-тест на поведение**

```js
// e2e/dns_over_vless_zones.spec.mjs
import { test, expect } from './fixtures.mjs';

test('переключатель в подшапке не сворачивает зону', async ({ page, openDnsOverVless }) => {
  await openDnsOverVless(page);
  const zone = page.locator('.xk-dns-zone[data-zone="records"]');
  await zone.locator('summary').click();
  await expect(zone).toHaveAttribute('open', '');
  await zone.locator('.dt-switch').click();
  await expect(zone).toHaveAttribute('open', '');
  await expect(zone.locator('#routing-dns-over-vless-pass')).toBeChecked();
});

test('свёрнутая зона показывает сводку', async ({ page, openDnsOverVless }) => {
  await openDnsOverVless(page);
  const sum = page.locator('[data-zone-sum="home"]');
  await expect(sum).toHaveText('не настроена');
});
```

Хелпер `openDnsOverVless` взять из `e2e/dns_over_vless_route_picker.spec.mjs`; если он там встроен в тело теста — вынести в `e2e/fixtures.mjs` и переиспользовать.

- [ ] **Step 6: Прогнать**

Run: `python -m pytest tests/test_dns_over_vless_zone_summaries.py -q`
Expected: PASS.
Run: `npm run frontend:build && npx playwright test e2e/dns_over_vless_zones.spec.mjs`
Expected: PASS, 2 теста.

- [ ] **Step 7: Коммит**

```bash
git add xkeen-ui/static/js/features/routing_cards/rules/dns_over_vless.js tests/test_dns_over_vless_zone_summaries.py e2e/dns_over_vless_zones.spec.mjs e2e/fixtures.mjs
git -c user.name="olmer2002" -c user.email="olmer2002@gmail.com" commit -m "Свёрнутая зона окна DNS-over-VLESS показывает, что в ней настроено"
```

---

### Task 7: Кнопка раскладки

**Files:**
- Modify: `xkeen-ui/templates/panel.html` (шапка окна), `xkeen-ui/static/js/features/routing_cards/rules/dns_over_vless.js`
- Test: `tests/test_dns_over_vless_layout_switch.py`, `e2e/dns_over_vless_zones.spec.mjs`

**Interfaces:**
- Consumes: `routing.dnsOverVlessLayout` (Task 1), атрибут `data-dns-layout` (Task 5).
- Produces: кнопка `#routing-dns-over-vless-layout`, функции `readLayout()`, `applyLayout(mode)`, `LAYOUT_MODES = ['auto', 'single', 'split']`.

- [ ] **Step 1: Написать падающий тест**

```python
# tests/test_dns_over_vless_layout_switch.py
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JS = (ROOT / "xkeen-ui/static/js/features/routing_cards/rules/dns_over_vless.js").read_text(encoding="utf-8")
TEMPLATE = (ROOT / "xkeen-ui/templates/panel.html").read_text(encoding="utf-8")


def test_header_has_a_layout_button():
    assert 'id="routing-dns-over-vless-layout"' in TEMPLATE


def test_layout_modes_are_the_three_agreed_ones():
    assert "LAYOUT_MODES" in JS
    for mode in ("'auto'", "'single'", "'split'"):
        assert mode in JS, mode


def test_preference_travels_through_ui_settings():
    # Вкус у человека один на все машины, поэтому не localStorage.
    assert "XKeen.ui.settings" in JS
    assert "dnsOverVlessLayout" in JS
    assert "localStorage" not in JS


def test_auto_resolves_by_width():
    assert "1100" in JS
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `python -m pytest tests/test_dns_over_vless_layout_switch.py -q`
Expected: FAIL — кнопки нет.

- [ ] **Step 3: Добавить кнопку в шапку**

Перед кнопкой закрытия в `modal-header`:

```html
<button type="button" id="routing-dns-over-vless-layout" class="modal-close routing-dns-over-vless-layout-btn" title="Раскладка окна: авто, одна колонка, две колонки" aria-label="Раскладка окна">{{ op_icon('compare') }}</button>
```

- [ ] **Step 4: Реализовать переключение**

```js
  const LAYOUT_MODES = ['auto', 'single', 'split'];
  const LAYOUT_MIN_SPLIT_PX = 1100;

  function readLayout() {
    try {
      const settings = window.XKeen.ui.settings.get();
      const value = settings && settings.routing && settings.routing.dnsOverVlessLayout;
      return LAYOUT_MODES.indexOf(value) === -1 ? 'auto' : value;
    } catch (e) {
      return 'auto';
    }
  }

  // Ниже порога двух колонок физически нет, поэтому split там неотличим от
  // single — решает ширина, а не настройка.
  function resolveLayout(mode) {
    if (mode === 'single') return 'single';
    const fits = window.innerWidth >= LAYOUT_MIN_SPLIT_PX;
    if (mode === 'split') return fits ? 'split' : 'single';
    return fits ? 'split' : 'single';
  }

  function applyLayout(mode) {
    const content = document.querySelector('#routing-dns-over-vless-modal .modal-content');
    if (!content) return;
    content.dataset.dnsLayout = resolveLayout(mode);
    const button = $(DOM.layout);
    if (button) {
      const names = { auto: 'авто', single: 'одна колонка', split: 'две колонки' };
      button.title = `Раскладка окна: ${names[mode]}`;
    }
  }

  async function cycleLayout() {
    const next = LAYOUT_MODES[(LAYOUT_MODES.indexOf(readLayout()) + 1) % LAYOUT_MODES.length];
    applyLayout(next);
    try {
      await window.XKeen.ui.settings.patch({ routing: { dnsOverVlessLayout: next } });
    } catch (e) {
      // Настройка не сохранилась — раскладка всё равно уже применена на экране.
    }
  }
```

В карту `DOM` добавить `layout: 'routing-dns-over-vless-layout'`. В `init()`:

```js
    const layoutBtn = $(DOM.layout);
    if (layoutBtn) layoutBtn.addEventListener('click', cycleLayout);
    window.addEventListener('resize', () => applyLayout(readLayout()));
    document.addEventListener('xkeen:ui-settings-changed', () => applyLayout(readLayout()));
```

В `open()` — `applyLayout(readLayout());` перед первым `refresh()`.

- [ ] **Step 5: Дописать e2e**

```js
test('раскладка переключается и запоминается', async ({ page, openDnsOverVless }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await openDnsOverVless(page);
  const content = page.locator('#routing-dns-over-vless-modal .modal-content');
  await expect(content).toHaveAttribute('data-dns-layout', 'split');
  await page.locator('#routing-dns-over-vless-layout').click();
  await expect(content).toHaveAttribute('data-dns-layout', 'single');
});

test('на узком экране раскладка всегда одноколоночная', async ({ page, openDnsOverVless }) => {
  await page.setViewportSize({ width: 900, height: 1000 });
  await openDnsOverVless(page);
  await expect(page.locator('#routing-dns-over-vless-modal .modal-content'))
    .toHaveAttribute('data-dns-layout', 'single');
});
```

- [ ] **Step 6: Прогнать**

Run: `python -m pytest tests/test_dns_over_vless_layout_switch.py -q`
Expected: PASS, 4 теста.
Run: `npm run frontend:build && npx playwright test e2e/dns_over_vless_zones.spec.mjs`
Expected: PASS, 4 теста.

- [ ] **Step 7: Коммит**

```bash
git add xkeen-ui/templates/panel.html xkeen-ui/static/js/features/routing_cards/rules/dns_over_vless.js tests/test_dns_over_vless_layout_switch.py e2e/dns_over_vless_zones.spec.mjs
git -c user.name="olmer2002" -c user.email="olmer2002@gmail.com" commit -m "Раскладку окна DNS-over-VLESS можно выбрать и она запоминается"
```

---

### Task 8: Настройки видны при включённой функции

**Files:**
- Modify: `xkeen-ui/static/js/features/routing_cards/rules/dns_over_vless.js:294-315`
- Test: `tests/test_dns_over_vless_fields_visible.py`, `e2e/dns_over_vless_zones.spec.mjs`

**Interfaces:**
- Consumes: зоны из Task 4 (id `routing-dns-over-vless-route` теперь на теле зоны «Маршрут»).
- Produces: поведение — при `enabled` поля видимы и `disabled`, выбор маршрута скрыт.

- [ ] **Step 1: Написать падающий тест**

```python
# tests/test_dns_over_vless_fields_visible.py
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JS = (ROOT / "xkeen-ui/static/js/features/routing_cards/rules/dns_over_vless.js").read_text(encoding="utf-8")


def test_route_visibility_no_longer_hides_the_whole_form():
    body = JS[JS.index("function renderRoute(data) {"):JS.index("function parseZones(")]
    # Прячется только зона маршрута; поля живут в соседних зонах и остаются.
    assert "fieldsLocked" in body or "setFieldsLocked" in body


def test_locked_fields_are_disabled_not_hidden():
    assert "function setFieldsLocked(" in JS
    body = JS[JS.index("function setFieldsLocked("):]
    block = body[:body.index("\n  function ")]
    assert ".disabled =" in block
    assert "classList.add('hidden')" not in block
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `python -m pytest tests/test_dns_over_vless_fields_visible.py -q`
Expected: FAIL — `setFieldsLocked` не найдена.

- [ ] **Step 3: Разделить видимость и активность**

```js
  // Выбор маршрута и поля настроек жили в одном контейнере, поэтому при
  // включённой функции пряталось и то и другое: посмотреть, что настроено,
  // можно было только выключив защиту. Менять маршрут на ходу и правда
  // нельзя — а читать и готовить настройки к следующему включению можно.
  function setFieldsLocked(locked) {
    const ids = [DOM.upstreams, DOM.remote, DOM.local, DOM.zones, DOM.direct,
      DOM.directZones, DOM.pass, DOM.passNode, DOM.capture];
    for (let i = 0; i < ids.length; i += 1) {
      const el = $(ids[i]);
      if (el) el.disabled = locked || busy;
    }
    const note = document.getElementById('routing-dns-over-vless-locked-note');
    if (note) note.classList.toggle('hidden', !locked);
  }
```

В `renderRoute` заменить безусловное сокрытие: `wrap` (зона маршрута) прячется как прежде, а сразу за ним добавить

```js
    setFieldsLocked(!!(data && data.enabled));
```

В шаблон, в тело зоны «DNS-серверы», добавить пояснение:

```html
<p id="routing-dns-over-vless-locked-note" class="modal-hint hidden">Функция включена, поэтому настройки только для чтения. Правки применятся при следующем включении.</p>
```

- [ ] **Step 4: Дописать e2e**

```js
test('при включённой функции настройки видны и заблокированы', async ({ page, openDnsOverVless }) => {
  await openDnsOverVless(page, { enabled: true, can_disable: true });
  await expect(page.locator('#routing-dns-over-vless-upstreams')).toBeVisible();
  await expect(page.locator('#routing-dns-over-vless-upstreams')).toBeDisabled();
  await expect(page.locator('#routing-dns-over-vless-locked-note')).toBeVisible();
  await expect(page.locator('#routing-dns-over-vless-route')).toBeHidden();
});
```

Хелпер `openDnsOverVless` должен принимать переопределения статуса и подмешивать их в `STATUS` из `e2e/dns_over_vless_route_picker.spec.mjs`.

- [ ] **Step 5: Прогнать**

Run: `python -m pytest tests/test_dns_over_vless_fields_visible.py -q`
Expected: PASS, 2 теста.
Run: `npx playwright test e2e/dns_over_vless_zones.spec.mjs`
Expected: PASS, 5 тестов.

- [ ] **Step 6: Коммит**

```bash
git add xkeen-ui/static/js/features/routing_cards/rules/dns_over_vless.js xkeen-ui/templates/panel.html tests/test_dns_over_vless_fields_visible.py e2e/dns_over_vless_zones.spec.mjs
git -c user.name="olmer2002" -c user.email="olmer2002@gmail.com" commit -m "Настройки DNS-over-VLESS видно и при включённой функции"
```

---

### Task 9: Переключатели в окне Mihomo

**Files:**
- Modify: `xkeen-ui/templates/panel.html` (окно `#mihomo-dns-modal` и соседние `xk-mini-switch` в модальных формах)
- Test: `tests/test_dns_modal_switches.py` (дополняется)

**Interfaces:**
- Consumes: `xk-switch-bare` (Task 2).
- Produces: ничего для последующих задач.

- [ ] **Step 1: Дописать падающий тест**

```python
def test_mihomo_dns_switches_are_bare_too():
    template = (ROOT / "xkeen-ui/templates/panel.html").read_text(encoding="utf-8")
    start = template.index('<div id="mihomo-dns-modal"')
    modal = template[start:start + 20000]
    for switch in re.finditer(r'<label class="dt-switch[^"]*"', modal):
        assert "xk-switch-bare" in switch.group(0), switch.group(0)


def test_side_card_switches_keep_the_chip():
    css = (ROOT / "xkeen-ui/static/panel-operator.css").read_text(encoding="utf-8")
    # routing-side-card остаётся с таблеткой: там она уместна.
    assert ".routing-side-card .xk-mini-switch" in css
```

Добавить `import re` в начало файла.

- [ ] **Step 2: Убедиться, что тест падает**

Run: `python -m pytest tests/test_dns_modal_switches.py -q`
Expected: FAIL — `xk-switch-bare` отсутствует у переключателей Mihomo.

- [ ] **Step 3: Проставить модификатор**

Всем `<label class="dt-switch xk-mini-switch …">` внутри `#mihomo-dns-modal` добавить `xk-switch-bare`. Переключатели вне модальных окон не трогать.

- [ ] **Step 4: Прогнать**

Run: `python -m pytest tests/test_dns_modal_switches.py -q`
Expected: PASS, 4 теста.

- [ ] **Step 5: Коммит**

```bash
git add xkeen-ui/templates/panel.html tests/test_dns_modal_switches.py
git -c user.name="olmer2002" -c user.email="olmer2002@gmail.com" commit -m "Окно защищённого DNS Mihomo избавилось от тех же широких плашек"
```

---

### Task 10: Описи, ключ кеша и эталоны

**Files:**
- Modify: `xkeen-ui/templates/panel.html` (ключ `v=`), `docs/panel-operator-icon-inventory.json`, `docs/panel-operator-stage0-inventory.json`, восемь тестов операторского слоя
- Modify: `e2e/dns_guard_shots.spec.mjs`

**Interfaces:**
- Consumes: итоговую разметку всех предыдущих задач.
- Produces: зелёные проверки оформления.

- [ ] **Step 1: Обновить ключ сброса кеша**

В `panel.html` заменить `v='20260902dns70'` у `panel-operator.css` на новую дату-версию, например `v='20260903dns80'`. То же значение подставить в восьми тестах:

```bash
grep -rl "20260902dns70" tests/ xkeen-ui/templates/
```

Заменить во всех найденных файлах — по одной строке на файл.

- [ ] **Step 2: Пересобрать описи**

```bash
python scripts/generate_operator_icon_inventory.py
python scripts/generate_panel_operator_inventory.py
```

Описи хранят номера строк `panel.html`, а они сдвинулись — файлы должны измениться.

- [ ] **Step 3: Прогнать проверки оформления**

Run: `python -m pytest tests -q -k panel_operator`
Expected: PASS.

- [ ] **Step 4: Снять эталоны обеих раскладок**

В `e2e/dns_guard_shots.spec.mjs` добавить снимки окна в `single` и в `split`, в светлой и тёмной теме — четыре снимка. Переключатель раскладок удваивает поверхность визуальных тестов: без снимка второй раскладки она протухнет незаметно, потому что смотрят обычно в свою.

Маски на данные машины (адреса, имена устройств, MAC) обязательны — эталон без масок нельзя принимать.

- [ ] **Step 5: Полный прогон**

Run: `python -m pytest tests -q`
Expected: PASS, падений нет.
Run: `npm run frontend:build && npx playwright test`
Expected: PASS.

- [ ] **Step 6: Коммит**

```bash
git add xkeen-ui/templates/panel.html tests/ docs/panel-operator-icon-inventory.json docs/panel-operator-stage0-inventory.json e2e/dns_guard_shots.spec.mjs
git -c user.name="olmer2002" -c user.email="olmer2002@gmail.com" commit -m "Вернуть зелёными проверки оформления и снять эталоны обеих раскладок"
```

---

### Task 11: Живой прогон на роутере

**Files:** нет правок; задача — проверка.

**Interfaces:**
- Consumes: собранный архив.
- Produces: список замечаний для отдельного прохода доводки.

- [ ] **Step 1: Собрать архив**

```bash
npm run archive:user
```

Ожидаемо: `version: <sha> (base <sha>, dirty=false)` — если `dirty=true`, значит в `xkeen-ui/` остались несохранённые правки.

- [ ] **Step 2: Установить на роутер и проверить**

Открыть окно и убедиться:
- при выключенной функции виден выбор маршрута, поля активны;
- при включённой функции поля видны, заблокированы, пояснение показано, выбор маршрута скрыт;
- свёрнутые зоны показывают сводки, соответствующие реальным настройкам;
- кнопка раскладки переключает три состояния и переживает перезагрузку страницы;
- на ширине меньше 1100 px окно в одну колонку;
- нажатие на переключатель в подшапке не сворачивает зону.

- [ ] **Step 3: Записать замечания**

Собрать список для отдельного прохода доводки — как договаривались, рихтовка после живых прогонов идёт отдельно.

---

## Самопроверка плана

**Покрытие спецификации.** Зонирование — Task 4. Две раскладки и настройка — Tasks 1, 5, 7. Изменение поведения — Task 8. Переключатели — Tasks 2, 4, 9. Подсказки — Task 3. Описи, ключ кеша, эталоны — Task 10. Живой прогон — Task 11. Разделы «Что не меняется» и «Осознанно вне объёма» ограничений не требуют, кроме уже вынесенных в Global Constraints.

**Согласованность имён.** `xk-switch-bare` (Tasks 2, 4, 9), `xk-dns-zone` / `xk-dns-zone-head` / `xk-dns-zone-body` / `xk-dns-zone-sum` / `xk-dns-zone-opt` (Tasks 4, 5, 6), `data-dns-layout` (Tasks 5, 7), `data-zone-sum` (Tasks 4, 6), `routing.dnsOverVlessLayout` (Tasks 1, 7), `renderZoneSummaries` (Task 6), `setFieldsLocked` (Task 8), `LAYOUT_MODES` / `readLayout` / `applyLayout` / `resolveLayout` / `cycleLayout` (Task 7).
