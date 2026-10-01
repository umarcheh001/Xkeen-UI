# Обсерватория по стратегиям балансировщиков — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Панель пишет `burstObservatory` тогда и только тогда, когда в каталоге конфигов Xray есть балансировщик `leastLoad`, не трогает подходящий файл владельца, никогда не оставляет две секции обсерватории, а балансировщик DNS-over-VLESS при `burstObservatory` отсекает неотвечающие узлы по доле неудач.

**Architecture:** Новый модуль `services/xray_observatory.py` — чтение каталога (стратегии балансировщиков и секции обсерватории по всем файлам) и чистые функции решения. `sync_observatory_subjects` в подписках переписывается поверх него, сохраняя сигнатуру. DNS-over-VLESS узнаёт действующий вид обсерватории и вместо `leastPing` ставит `leastLoad` с `tolerance`. Маршруты `/api/xray/observatory/*` перестают знать только ключ `observatory`.

**Tech Stack:** Python 3 (Flask-сервис панели), pytest, ядро Xray 26.9.9 из соседнего проекта `C:\Users\Alex\Documents\Xray-Configs\tools\cores\26.9.9\xray.exe` для приёмки.

**Spec:** `C:\Users\Alex\Desktop\задание-панели-2026-09-30-обсерватория.md` плюс раздел «Принятые решения» ниже (решения владельца панели от 01.10.2026, они уточняют задание). Замер, на который опираются решения: `C:\Users\Alex\Desktop\отчёт-обсерватория-замер-2026-10-01.html`.

## Как реализовано (01.10.2026)

План исполнен в `main`, коммиты `7ac5ffff`…`145452cb`. Код местами ушёл от текста задач ниже — там, где проверки нашли ошибки плана. Источник правды — код и тесты; этот раздел перечисляет расхождения.

- **Задача 3, условие возврата.** Возврат исходного файла привязан к признаку `has_runtime_targets`, который возвращает `sync_subscription_runtime_plan_delta`, а не к `next_plan`: именно по нему вызывающий код стирает слепок.
- **Задача 3, что возвращается.** Возвращается только замена, которую сделала сама панель. Признак — содержимое: слепок был обычной `observatory`, а в `07_observatory.json` сейчас `burstObservatory`, чей `pingConfig` равен тому, что панель пишет при замене. Собственный burst владельца не трогается. Слияние секций из двух файлов назад не разворачивается: правило «не больше одной секции» старше правила «вернуть как было».
- **Задача 2, порядок.** Обсерватория синхронизируется после записи маршрутизации: режим «только подписка» удаляет чужие `leastLoad`-балансировщики, и вид секции выбирается по тому, что осталось на диске.
- **Задача 2, чтение.** Файлы читаются через `utils.fs.load_text` (UTF-8, затем Windows-1251). Если строгий читатель видит ключ обсерватории, а каталог секцию не разобрал, панель ничего не создаёт.
- **Задача 2, слияние.** В одну секцию сливаются все остальные, включая вторую секцию того же вида в другом файле. Селектор перезаписывается, только если очищенный список отличается от прежнего.
- **Задача 5, маршруты.** Оба маршрута работают с файлом, где лежит действующая секция (`locate_section`). При создании и замене burst интервал формы игнорируется, пишется `2m`. Секции в других файлах при сохранении убираются. Комментарии владельца в JSONC-копии сохраняются.
- **Задача 4, мелочи.** DNS-over-VLESS берёт селекторы последней секции вида, как ядро; чужая стратегия не-объект не роняет сборку балансировщика.
- **Сверх плана: редактор.** Проверка «`leastLoad` без `burstObservatory`» работает и на файле маршрутизации: редактор получает вид действующей обсерватории. `leastPing` при burst ошибкой не считается. Заготовка `burstObservatory` в подсказке-исправлении получила рабочий адрес проб и `2m × 3`.
- **Три теста подписок.** В двух стенд сохраняет `leastLoad`, и они проверяют burst. В третьем (режим «только подписка» удаляет оба балансировщика владельца) проверяется обычная `observatory`.

Что остаётся открытым:

- Проверка на роутере (задача 6, шаг 5) не проводилась.
- Когда балансировщик DNS не выбрал ни одного узла, запрос уходит первому аутбаунду слитого конфига. На каталоге 45.1 это прокси подписки, не прямой выход; на раскладке, где первым идёт `direct`, это была бы утечка. Запасной тег панель балансировщику не ставит.
- Если последний `leastLoad` исчез при живой подписке, burst остаётся до ухода последней подписки.
- Слепок и возврат покрывают только `07_observatory.json`.
- Приёмочный тест с настоящим ядром на CI пропускается: путь к ядру задаётся `XKEEN_TEST_XRAY_CORE`.

## Принятые решения

1. Правило задания принято: `burstObservatory` нужна тогда и только тогда, когда в каталоге есть `leastLoad`.
2. При создании `burstObservatory` и при замене `observatory` → `burstObservatory` панель пишет `pingConfig` с `interval: "2m"`, `sampling: 3`, `timeout: "5s"`. Это сознательное отступление от пункта задания «`interval` не меньше прежнего `probeInterval`»: замер показал, что цена проб на роутере незаметна, а длинный цикл держит умерший узел «живым» слишком долго. Адрес проб (`destination`) берётся из прежнего `probeUrl`.
3. `pingConfig` существующей `burstObservatory` владельца панель не меняет никогда.
4. Балансировщик DNS-over-VLESS (`xk-dns-over-vless`) при действующей `burstObservatory`, покрывающей его узлы, получает `leastLoad` с `expected: 2` и `tolerance: 0.5` вместо `leastPing`: DNS раскладывается между двумя самыми стабильными узлами, узел с долей неудачных проб больше половины отсекается.
5. Пока остаётся хоть одна активная подписка, выключение одной из них вид обсерватории не меняет: убираются только её теги. Когда активных подписок не остаётся, файл обсерватории возвращается строго к виду до первой подписки, если панель меняла в нём вид секции. Это сознательное отступление от пункта задания «при выключении вид не менять»: владельцу панели важнее, чтобы после ухода последней подписки файлы были как до неё. Файл, который панель не трогала, по-прежнему не трогается.
6. Секция обсерватории, лежащая не в `07_observatory.json`, правится в том файле, где лежит; вторая секция в `07` не создаётся.
7. `leastLoad`, добавленный в редакторе при уже включённой подписке, автозаменой не обрабатывается — это остаётся на проверке редактора с quickfix.

## Известные последствия (проверить на стенде в задаче 6)

- `leastLoad` выбирает узлы с наименьшим разбросом задержки, а не с наименьшей задержкой. DNS пойдёт через два самых стабильных узла, которые могут быть не самыми быстрыми. Владелец панели это принял: для DNS стабильность важнее.
- Если по `tolerance` отсечены все узлы, балансировщик без `fallbackTag` отдаёт запрос обработчику по умолчанию. Куда он ведёт на роутерах, не проверено.
- Уже включённый DNS-over-VLESS остаётся на `leastPing`, пока его не применят заново (выключить и включить, либо пересохранить выбор маршрута). Автоматической миграции нет.

## Global Constraints

- Ветвлений по версии ядра нет.
- Сигнатура `sync_observatory_subjects` не меняется: её зовёт `sync_subscription_runtime_plan_delta`.
- Файл, который не требует смысловых изменений, не переписывается вовсе: ни `.json`, ни JSONC-копия. Критерий 1 задания — «байт в байт».
- В каталоге после любой записи панели не больше одной секции обсерватории.
- Сравнение селектора с тегами — по префиксу (`tag.startswith(selector)`), как это делает ядро.
- Коммиты: `git -c user.name="olmer2002" -c user.email="olmer2002@gmail.com" commit -m "..."`, сообщение на русском простым языком, без трейлеров. Не пушить без явной просьбы.
- Полный `pytest` запускать из Bash, не из PowerShell.
- В соседнем проекте `Xray-Configs` ничего не менять, только читать.

## Файлы

| Файл | Что с ним |
|---|---|
| `xkeen-ui/services/xray_observatory.py` | создать: чтение каталога, решение о виде, преобразования секций |
| `xkeen-ui/services/xray_subscriptions.py` | изменить: `sync_observatory_subjects`, `_probe_url_for_subscription`, `_rebuild_subscription_runtime`; добавить `_undo_observatory_conversion` |
| `xkeen-ui/services/dns_over_vless.py` | изменить: `_collect_runtime`, `_build_target`, `_build_combined_target` |
| `xkeen-ui/routes/xray_configs.py` | изменить: маршруты `observatory/config` и `observatory/generate` |
| `xkeen-ui/opt/etc/xray/templates/observatory/07_observatory_base.jsonc` | изменить: исправить пример `burstObservatory` |
| `tests/test_xray_observatory.py` | создать |
| `tests/test_xray_observatory_sync.py` | создать |
| `tests/test_dns_over_vless.py` | дополнить |
| `docs/dns-over-vless.md` | дополнить |

---

### Task 1: Модуль чтения каталога и решений

**Files:**
- Create: `xkeen-ui/services/xray_observatory.py`
- Test: `tests/test_xray_observatory.py`

**Interfaces:**
- Produces:
  - константы `OBSERVATORY_FILE`, `KIND_PLAIN = "observatory"`, `KIND_BURST = "burstObservatory"`, `BURST_INTERVAL = "2m"`, `BURST_SAMPLING = 3`, `BURST_TIMEOUT = "5s"`, `LEAST_LOAD_EXPECTED = 2`, `LEAST_LOAD_TOLERANCE = 0.5`;
  - `read_fragment(path: str) -> dict | None`;
  - `clean_selectors(raw: Any) -> list[str]`;
  - `collect_catalog(configs_dir: str) -> dict` с ключами `strategies: list[str]` (в нижнем регистре), `has_least_load: bool`, `sections: list[{"file": str, "kind": str, "section": dict}]`;
  - `effective_section(catalog: dict, kind: str) -> dict | None` — последняя по порядку файлов секция этого вида;
  - `effective_kind(catalog: dict) -> str` — `KIND_PLAIN`, если есть хоть одна обычная секция (ядро берёт её первой), иначе `KIND_BURST`, иначе `""`;
  - `covers(selectors: Iterable[str], tag: str) -> bool`;
  - `new_burst_section(selectors: list[str], destination: str) -> dict`;
  - `burst_from_plain(section: dict, default_destination: str) -> dict`.

- [ ] **Step 1: Написать падающие тесты**

```python
# tests/test_xray_observatory.py
from __future__ import annotations

import json
from pathlib import Path

from services import xray_observatory as obs


def _write(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def test_catalog_collects_strategies_and_sections_from_every_file(tmp_path: Path):
    _write(
        tmp_path / "05_routing.json",
        {"routing": {"balancers": [
            {"tag": "fast", "selector": ["VPS_"], "strategy": {"type": "leastPing"}},
            {"tag": "heavy", "selector": ["VPS_"], "strategy": {"type": "leastLoad"}},
        ]}},
    )
    _write(tmp_path / "07_observatory.json", {"observatory": {"subjectSelector": ["VPS_NL"]}})
    _write(tmp_path / "09_extra.json", {"burstObservatory": {"subjectSelector": ["VPS_"]}})
    (tmp_path / "04_outbounds.json.disable").write_text("{}", encoding="utf-8")

    catalog = obs.collect_catalog(str(tmp_path))

    assert catalog["strategies"] == ["leastping", "leastload"]
    assert catalog["has_least_load"] is True
    assert [(item["file"], item["kind"]) for item in catalog["sections"]] == [
        ("07_observatory.json", "observatory"),
        ("09_extra.json", "burstObservatory"),
    ]
    # The core registers the plain observatory first, so it is the one in effect.
    assert obs.effective_kind(catalog) == "observatory"
    assert obs.effective_section(catalog, "burstObservatory")["file"] == "09_extra.json"


def test_catalog_reads_root_level_balancers_and_commented_json(tmp_path: Path):
    _write(tmp_path / "05_routing.json", {"balancers": [{"tag": "b", "strategy": {"type": "leastLoad"}}]})
    (tmp_path / "07_observatory.json").write_text(
        '// выбор объяснён в эталоне\n{ "burstObservatory": { "subjectSelector": ["VPS_"] } }\n',
        encoding="utf-8",
    )

    catalog = obs.collect_catalog(str(tmp_path))

    assert catalog["has_least_load"] is True
    assert obs.effective_kind(catalog) == "burstObservatory"


def test_catalog_of_empty_or_missing_dir_is_empty(tmp_path: Path):
    catalog = obs.collect_catalog(str(tmp_path / "missing"))

    assert catalog == {"strategies": [], "has_least_load": False, "sections": []}
    assert obs.effective_kind(catalog) == ""
    assert obs.effective_section(catalog, "observatory") is None


def test_covers_compares_by_prefix():
    assert obs.covers(["VPS_"], "VPS_NL_SUB--NL_xhttp") is True
    assert obs.covers(["VPS_NL_SUB"], "VPS_NL_SUB") is True
    assert obs.covers(["VPS_NL"], "VPS_CH_SUB") is False
    assert obs.covers([], "VPS_NL_SUB") is False


def test_burst_from_plain_keeps_selector_and_probe_address():
    plain = {
        "subjectSelector": ["VPS_NL_SUB", "VPS_CH_SUB"],
        "probeUrl": "https://cp.cloudflare.com/generate_204",
        "probeInterval": "5m",
        "enableConcurrency": True,
    }

    assert obs.burst_from_plain(plain, "https://fallback.example/204") == {
        "subjectSelector": ["VPS_NL_SUB", "VPS_CH_SUB"],
        "pingConfig": {
            "destination": "https://cp.cloudflare.com/generate_204",
            "interval": "2m",
            "sampling": 3,
            "timeout": "5s",
        },
    }
    assert obs.burst_from_plain({}, "https://fallback.example/204")["pingConfig"]["destination"] == (
        "https://fallback.example/204"
    )
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `python -m pytest tests/test_xray_observatory.py -q`
Expected: ошибка импорта `cannot import name 'xray_observatory'`.

- [ ] **Step 3: Написать модуль**

```python
# xkeen-ui/services/xray_observatory.py
"""Which observatory an Xray config directory has, and which one it needs.

Xray ships two observatories.  ``leastLoad`` reads the sample statistics only
``burstObservatory`` produces; with the plain ``observatory`` it silently
degrades into "fastest by the last probe".  When both sections are present the
core registers the plain one first and every strategy reads it, so the burst
one probes for nothing.  The directory is merged as a whole, hence everything
here looks at every file, not only at 07_observatory.json.
"""

from __future__ import annotations

import copy
import json
import os
from typing import Any, Dict, Iterable, List

from utils.jsonc import strip_json_comments_text

OBSERVATORY_FILE = "07_observatory.json"
KIND_PLAIN = "observatory"
KIND_BURST = "burstObservatory"
KINDS = (KIND_PLAIN, KIND_BURST)

# Measured on the routers on 2026-10-01: a probe costs ~20-30 ms of CPU, so the
# cycle length is chosen by how long a dead node may stay selectable, not by load.
BURST_INTERVAL = "2m"
BURST_SAMPLING = 3
BURST_TIMEOUT = "5s"
# DNS rides the two steadiest nodes: three samples are too few to trust one pick.
LEAST_LOAD_EXPECTED = 2
LEAST_LOAD_TOLERANCE = 0.5


def read_fragment(path: str) -> Dict[str, Any] | None:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            text = fh.read()
    except Exception:
        return None
    for candidate in (text, strip_json_comments_text(text)):
        try:
            obj = json.loads(candidate)
        except Exception:
            continue
        return obj if isinstance(obj, dict) else None
    return None


def clean_selectors(raw: Any) -> List[str]:
    out: List[str] = []
    for item in raw if isinstance(raw, list) else []:
        value = str(item or "").strip()
        if value and value not in out:
            out.append(value)
    return out


def _balancer_strategies(obj: Dict[str, Any]) -> List[str]:
    routing = obj.get("routing") if isinstance(obj.get("routing"), dict) else {}
    found: List[str] = []
    for holder in (routing, obj):
        balancers = holder.get("balancers")
        for item in balancers if isinstance(balancers, list) else []:
            strategy = item.get("strategy") if isinstance(item, dict) else None
            kind = str(strategy.get("type") or "").strip().lower() if isinstance(strategy, dict) else ""
            if kind:
                found.append(kind)
    return found


def collect_catalog(configs_dir: str) -> Dict[str, Any]:
    strategies: List[str] = []
    sections: List[Dict[str, Any]] = []
    try:
        names = sorted(os.listdir(str(configs_dir or "")))
    except Exception:
        names = []
    for name in names:
        if not name.lower().endswith(".json"):
            continue
        path = os.path.join(str(configs_dir), name)
        if not os.path.isfile(path):
            continue
        obj = read_fragment(path)
        if obj is None:
            continue
        strategies.extend(_balancer_strategies(obj))
        for kind in KINDS:
            if isinstance(obj.get(kind), dict):
                sections.append({"file": name, "kind": kind, "section": obj[kind]})
    return {
        "strategies": strategies,
        "has_least_load": "leastload" in strategies,
        "sections": sections,
    }


def effective_section(catalog: Dict[str, Any], kind: str) -> Dict[str, Any] | None:
    found = [item for item in catalog.get("sections", []) if item.get("kind") == kind]
    return found[-1] if found else None


def effective_kind(catalog: Dict[str, Any]) -> str:
    if effective_section(catalog, KIND_PLAIN) is not None:
        return KIND_PLAIN
    if effective_section(catalog, KIND_BURST) is not None:
        return KIND_BURST
    return ""


def covers(selectors: Iterable[str], tag: str) -> bool:
    value = str(tag or "")
    return any(value.startswith(str(prefix)) for prefix in selectors if str(prefix or ""))


def new_burst_section(selectors: List[str], destination: str) -> Dict[str, Any]:
    return {
        "subjectSelector": list(selectors),
        "pingConfig": {
            "destination": str(destination),
            "interval": BURST_INTERVAL,
            "sampling": BURST_SAMPLING,
            "timeout": BURST_TIMEOUT,
        },
    }


def burst_from_plain(section: Dict[str, Any], default_destination: str) -> Dict[str, Any]:
    source = section if isinstance(section, dict) else {}
    destination = str(source.get("probeUrl") or "").strip() or str(default_destination)
    return new_burst_section(clean_selectors(source.get("subjectSelector")), destination)


def replace_section(obj: Dict[str, Any], kind: str, section: Dict[str, Any]) -> Dict[str, Any]:
    """Put ``section`` under ``kind``, dropping the twin key, keeping key order."""
    out: Dict[str, Any] = {}
    placed = False
    for key, value in obj.items():
        if key in KINDS:
            if not placed:
                out[kind] = copy.deepcopy(section)
                placed = True
            continue
        out[key] = value
    if not placed:
        out[kind] = copy.deepcopy(section)
    return out
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `python -m pytest tests/test_xray_observatory.py -q`
Expected: `5 passed`.

- [ ] **Step 5: Коммит**

```bash
git add xkeen-ui/services/xray_observatory.py tests/test_xray_observatory.py
git -c user.name="olmer2002" -c user.email="olmer2002@gmail.com" commit -m "Панель умеет читать, какая обсерватория есть в конфигах Xray и какая нужна"
```

---

### Task 2: Синхронизация обсерватории подписок по правилу задания

**Files:**
- Modify: `xkeen-ui/services/xray_subscriptions.py` — функция `sync_observatory_subjects` (сейчас строки 5622–5682) и `_probe_url_for_subscription` (строки 7140–7149)
- Test: `tests/test_xray_observatory_sync.py`

**Interfaces:**
- Consumes: всё из Task 1.
- Produces:
  - `sync_observatory_subjects(*, xray_configs_dir, add_tags, remove_tags=None, managed_active=None, snapshot=None, replace_subjects=False) -> bool` — сигнатура прежняя.

- [ ] **Step 1: Написать падающие тесты**

```python
# tests/test_xray_observatory_sync.py
from __future__ import annotations

import json
from pathlib import Path

import pytest

ETALON = (
    "// burstObservatory: leastLoad читает разброс задержки, его даёт только она\n"
    '{ "burstObservatory": {\n'
    '    "subjectSelector": ["VPS_"],\n'
    '    "pingConfig": {\n'
    '      "destination": "https://cp.cloudflare.com/generate_204",\n'
    '      "interval": "10m", "sampling": 6, "timeout": "5s" } } }\n'
)
SUB_TAGS = ["VPS_NL_SUB", "VPS_CH_SUB"]


@pytest.fixture
def env(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as subs

    xray_dir = tmp_path / "configs"
    jsonc_dir = tmp_path / "jsonc"
    xray_dir.mkdir()
    jsonc_dir.mkdir()
    monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
    return subs, xray_dir, jsonc_dir


def _routing(xray_dir: Path, *strategies: str) -> None:
    balancers = [
        {"tag": f"b{idx}", "selector": ["VPS_"], "strategy": {"type": kind}}
        for idx, kind in enumerate(strategies)
    ]
    (xray_dir / "05_routing.json").write_text(
        json.dumps({"routing": {"balancers": balancers, "rules": []}}, indent=2) + "\n", encoding="utf-8"
    )


def _sections(xray_dir: Path) -> list[tuple[str, str]]:
    found = []
    for path in sorted(xray_dir.glob("*.json")):
        obj = json.loads(path.read_text(encoding="utf-8"))
        for kind in ("observatory", "burstObservatory"):
            if kind in obj:
                found.append((path.name, kind))
    return found


def test_covering_burst_file_is_left_byte_for_byte(env):
    subs, xray_dir, jsonc_dir = env
    _routing(xray_dir, "leastPing", "leastLoad")
    target = xray_dir / "07_observatory.json"
    target.write_text(ETALON, encoding="utf-8")

    changed = subs.sync_observatory_subjects(xray_configs_dir=str(xray_dir), add_tags=SUB_TAGS)

    assert changed is False
    assert target.read_text(encoding="utf-8") == ETALON
    assert list(jsonc_dir.iterdir()) == []


def test_burst_selector_is_extended_and_ping_config_kept(env):
    subs, xray_dir, _jsonc = env
    _routing(xray_dir, "leastLoad")
    ping = {"destination": "https://cp.cloudflare.com/generate_204", "interval": "10m", "sampling": 6, "timeout": "5s"}
    (xray_dir / "07_observatory.json").write_text(
        json.dumps({"burstObservatory": {"subjectSelector": ["OTHER_"], "pingConfig": ping}}), encoding="utf-8"
    )

    assert subs.sync_observatory_subjects(xray_configs_dir=str(xray_dir), add_tags=SUB_TAGS) is True

    section = json.loads((xray_dir / "07_observatory.json").read_text(encoding="utf-8"))["burstObservatory"]
    assert section["subjectSelector"] == ["OTHER_", "VPS_NL_SUB", "VPS_CH_SUB"]
    assert section["pingConfig"] == ping


def test_plain_observatory_becomes_burst_when_least_load_exists(env):
    subs, xray_dir, _jsonc = env
    _routing(xray_dir, "leastPing", "leastLoad")
    (xray_dir / "07_observatory.json").write_text(
        json.dumps({"observatory": {
            "subjectSelector": ["manual"],
            "probeUrl": "https://cp.cloudflare.com/generate_204",
            "probeInterval": "5m",
            "enableConcurrency": True,
        }}),
        encoding="utf-8",
    )

    assert subs.sync_observatory_subjects(xray_configs_dir=str(xray_dir), add_tags=SUB_TAGS) is True

    assert _sections(xray_dir) == [("07_observatory.json", "burstObservatory")]
    section = json.loads((xray_dir / "07_observatory.json").read_text(encoding="utf-8"))["burstObservatory"]
    assert section == {
        "subjectSelector": ["manual", "VPS_NL_SUB", "VPS_CH_SUB"],
        "pingConfig": {
            "destination": "https://cp.cloudflare.com/generate_204",
            "interval": "2m",
            "sampling": 3,
            "timeout": "5s",
        },
    }


def test_without_least_load_a_plain_observatory_is_written(env):
    subs, xray_dir, _jsonc = env
    _routing(xray_dir, "leastPing", "random")

    assert subs.sync_observatory_subjects(xray_configs_dir=str(xray_dir), add_tags=SUB_TAGS) is True

    assert _sections(xray_dir) == [("07_observatory.json", "observatory")]
    section = json.loads((xray_dir / "07_observatory.json").read_text(encoding="utf-8"))["observatory"]
    assert section["subjectSelector"] == SUB_TAGS
    assert section["probeInterval"] == "60s"


def test_least_load_without_any_section_creates_burst(env):
    subs, xray_dir, _jsonc = env
    _routing(xray_dir, "leastLoad")

    assert subs.sync_observatory_subjects(xray_configs_dir=str(xray_dir), add_tags=SUB_TAGS) is True

    assert _sections(xray_dir) == [("07_observatory.json", "burstObservatory")]
    section = json.loads((xray_dir / "07_observatory.json").read_text(encoding="utf-8"))["burstObservatory"]
    assert section["subjectSelector"] == SUB_TAGS
    assert section["pingConfig"]["interval"] == "2m"
    assert section["pingConfig"]["sampling"] == 3


def test_owner_burst_without_least_load_is_not_replaced(env):
    subs, xray_dir, _jsonc = env
    _routing(xray_dir, "leastPing")
    (xray_dir / "07_observatory.json").write_text(ETALON, encoding="utf-8")

    assert subs.sync_observatory_subjects(xray_configs_dir=str(xray_dir), add_tags=["OTHER_SUB"]) is True

    assert _sections(xray_dir) == [("07_observatory.json", "burstObservatory")]
    section = json.loads((xray_dir / "07_observatory.json").read_text(encoding="utf-8"))["burstObservatory"]
    assert section["subjectSelector"] == ["VPS_", "OTHER_SUB"]
    assert section["pingConfig"]["interval"] == "10m"


def test_two_sections_collapse_into_the_needed_one(env):
    subs, xray_dir, _jsonc = env
    _routing(xray_dir, "leastLoad")
    (xray_dir / "07_observatory.json").write_text(
        json.dumps({"observatory": {"subjectSelector": ["plain_only"], "probeUrl": "https://a.example/204"}}),
        encoding="utf-8",
    )
    (xray_dir / "09_burst.json").write_text(
        json.dumps({"burstObservatory": {"subjectSelector": ["VPS_"], "pingConfig": {"interval": "10m"}}}),
        encoding="utf-8",
    )

    assert subs.sync_observatory_subjects(xray_configs_dir=str(xray_dir), add_tags=SUB_TAGS) is True

    assert _sections(xray_dir) == [("09_burst.json", "burstObservatory")]
    section = json.loads((xray_dir / "09_burst.json").read_text(encoding="utf-8"))["burstObservatory"]
    assert section["subjectSelector"] == ["VPS_", "plain_only"]
    assert section["pingConfig"] == {"interval": "10m"}


def test_section_in_a_foreign_file_is_edited_in_place(env):
    subs, xray_dir, _jsonc = env
    _routing(xray_dir, "leastLoad")
    (xray_dir / "09_burst.json").write_text(
        json.dumps({"burstObservatory": {"subjectSelector": ["OTHER_"], "pingConfig": {"interval": "10m"}}}),
        encoding="utf-8",
    )

    assert subs.sync_observatory_subjects(xray_configs_dir=str(xray_dir), add_tags=SUB_TAGS) is True

    assert not (xray_dir / "07_observatory.json").exists()
    assert _sections(xray_dir) == [("09_burst.json", "burstObservatory")]


def test_removal_drops_only_our_tags_and_keeps_the_kind(env):
    subs, xray_dir, _jsonc = env
    _routing(xray_dir, "leastLoad")
    subs.sync_observatory_subjects(xray_configs_dir=str(xray_dir), add_tags=["manual", *SUB_TAGS])

    changed = subs.sync_observatory_subjects(
        xray_configs_dir=str(xray_dir), add_tags=[], remove_tags=SUB_TAGS, managed_active=False
    )

    assert changed is True
    assert _sections(xray_dir) == [("07_observatory.json", "burstObservatory")]
    section = json.loads((xray_dir / "07_observatory.json").read_text(encoding="utf-8"))["burstObservatory"]
    assert section["subjectSelector"] == ["manual"]


def test_removal_leaves_an_untouched_owner_file_alone(env):
    subs, xray_dir, jsonc_dir = env
    _routing(xray_dir, "leastLoad")
    target = xray_dir / "07_observatory.json"
    target.write_text(ETALON, encoding="utf-8")

    changed = subs.sync_observatory_subjects(
        xray_configs_dir=str(xray_dir), add_tags=[], remove_tags=SUB_TAGS, managed_active=False
    )

    assert changed is False
    assert target.read_text(encoding="utf-8") == ETALON
    assert list(jsonc_dir.iterdir()) == []


def test_removal_without_any_section_creates_nothing(env):
    subs, xray_dir, _jsonc = env
    _routing(xray_dir, "leastLoad")

    changed = subs.sync_observatory_subjects(
        xray_configs_dir=str(xray_dir), add_tags=[], remove_tags=SUB_TAGS, managed_active=False
    )

    assert changed is False
    assert not (xray_dir / "07_observatory.json").exists()


def test_probe_url_is_read_from_either_kind(env):
    subs, xray_dir, _jsonc = env
    (xray_dir / "07_observatory.json").write_text(ETALON, encoding="utf-8")

    assert subs._probe_url_for_subscription(str(xray_dir)) == "https://cp.cloudflare.com/generate_204"
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `python -m pytest tests/test_xray_observatory_sync.py -q`
Expected: падают все, кроме `test_without_least_load_a_plain_observatory_is_written`.

- [ ] **Step 3: Переписать синхронизацию**

В `xkeen-ui/services/xray_subscriptions.py` добавить импорт рядом с остальными импортами `services.*`:

```python
from services.xray_observatory import (
    KIND_BURST,
    KIND_PLAIN,
    OBSERVATORY_FILE,
    burst_from_plain,
    clean_selectors,
    collect_catalog,
    covers,
    effective_section,
    new_burst_section,
    read_fragment,
    replace_section,
)
```

Заменить тело `sync_observatory_subjects` целиком и добавить перед ней функцию `_apply_observatory_plan`:

```python
def _apply_observatory_plan(
    xray_configs_dir: str,
    *,
    add: List[str],
    remove: set[str],
    replace_subjects: bool,
    managed_active: bool,
    convert_kind: bool,
    snapshot: SnapshotCallback | None,
) -> bool:
    configs_dir = str(xray_configs_dir or "")
    # A broken 07_observatory.json must still stop the caller, as it did before.
    _load_observatory(os.path.join(configs_dir, OBSERVATORY_FILE), strict_existing=True)

    catalog = collect_catalog(configs_dir)
    plain = effective_section(catalog, KIND_PLAIN)
    burst = effective_section(catalog, KIND_BURST)
    want_burst = bool(catalog["has_least_load"])

    if plain is not None and burst is not None:
        # Both at once: the core reads the plain one and the burst one probes
        # for nothing.  Keep the one this directory needs, fold the other in.
        keep, drop = (burst, plain) if want_burst else (plain, burst)
    else:
        keep, drop = (plain if plain is not None else burst), None

    if keep is None and not add:
        return False

    kind = keep["kind"] if keep is not None else (KIND_BURST if want_burst else KIND_PLAIN)
    target_file = keep["file"] if keep is not None else OBSERVATORY_FILE
    section: Dict[str, Any] = copy.deepcopy(keep["section"]) if keep is not None else {}

    subjects: List[str] = []
    if not replace_subjects:
        subjects = [item for item in clean_selectors(section.get("subjectSelector")) if item not in remove]
        if drop is not None:
            for item in clean_selectors(drop["section"].get("subjectSelector")):
                if item not in remove and item not in subjects:
                    subjects.append(item)
    for tag in add:
        # The core matches selectors by prefix, so a covered tag adds nothing.
        if covers(subjects, tag):
            continue
        subjects.append(tag)
    section["subjectSelector"] = subjects

    if keep is None:
        if kind == KIND_BURST:
            section = new_burst_section(subjects, DEFAULT_PROBE_URL)
        else:
            section.setdefault("probeUrl", DEFAULT_PROBE_URL)
            section.setdefault("probeInterval", "60s")
            section.setdefault("enableConcurrency", True)
    elif kind == KIND_PLAIN and want_burst and convert_kind:
        section = burst_from_plain(section, DEFAULT_PROBE_URL)
        kind = KIND_BURST

    if keep is not None and drop is None and kind == keep["kind"] and section == keep["section"]:
        # Nothing to say: leave the owner's file, its comments and layout alone.
        return False

    header = "// Generated by XKeen UI subscriptions (observatory subjects)" if managed_active else ""
    changed = False

    target_path = os.path.join(configs_dir, target_file)
    target_obj = replace_section(read_fragment(target_path) or {}, kind, section)
    changed = bool(
        _write_jsonc_sidecar_if_changed(
            target_path, target_obj, header=header, snapshot=snapshot, preserve_existing_comments=True
        )
        or changed
    )
    changed = bool(_write_json_if_changed(target_path, target_obj, snapshot=snapshot) or changed)

    if drop is not None and drop["file"] != target_file:
        drop_path = os.path.join(configs_dir, drop["file"])
        drop_obj = read_fragment(drop_path) or {}
        drop_obj.pop(drop["kind"], None)
        changed = bool(
            _write_jsonc_sidecar_if_changed(
                drop_path, drop_obj, header="", snapshot=snapshot, preserve_existing_comments=True
            )
            or changed
        )
        changed = bool(_write_json_if_changed(drop_path, drop_obj, snapshot=snapshot) or changed)

    return changed


def sync_observatory_subjects(
    *,
    xray_configs_dir: str,
    add_tags: Iterable[str],
    remove_tags: Iterable[str] | None = None,
    managed_active: bool | None = None,
    snapshot: SnapshotCallback | None = None,
    replace_subjects: bool = False,
) -> bool:
    add = [str(t or "").strip() for t in add_tags if str(t or "").strip()]
    remove = {str(t or "").strip() for t in (remove_tags or []) if str(t or "").strip()}
    if not add and not remove and not replace_subjects:
        return False
    return _apply_observatory_plan(
        xray_configs_dir,
        add=add,
        remove=remove,
        replace_subjects=replace_subjects,
        managed_active=bool(add) if managed_active is None else bool(managed_active),
        # Removing tags alone never switches the kind; going back to the
        # owner's original file is _undo_observatory_conversion's job.
        convert_kind=bool(add),
        snapshot=snapshot,
    )
```

Заменить `_probe_url_for_subscription`:

```python
def _probe_url_for_subscription(xray_configs_dir: str) -> str:
    try:
        catalog = collect_catalog(str(xray_configs_dir or ""))
        plain = effective_section(catalog, KIND_PLAIN)
        burst = effective_section(catalog, KIND_BURST)
        if plain is not None:
            probe_url = str(plain["section"].get("probeUrl") or "").strip()
        elif burst is not None:
            ping = burst["section"].get("pingConfig")
            probe_url = str(ping.get("destination") or "").strip() if isinstance(ping, dict) else ""
        else:
            probe_url = ""
        if probe_url:
            return probe_url
    except Exception:
        pass
    return DEFAULT_PROBE_URL
```

- [ ] **Step 4: Убедиться, что новые тесты проходят**

Run: `python -m pytest tests/test_xray_observatory_sync.py -q`
Expected: `12 passed`.

- [ ] **Step 5: Прогнать существующие тесты подписок**

Run: `python -m pytest tests/test_xray_subscriptions.py tests/test_xray_subscriptions_routes.py -q 2>&1 | tail -15`
Expected: всё зелёное. Известный риск: раньше при неизменном селекторе функция всё равно обновляла шапку JSONC-копии, теперь выходит раньше. Если упадёт тест на шапку `// Generated by XKeen UI subscriptions (observatory subjects)` в JSONC-копии — не ослаблять правило «файл не трогать», а разобрать, какой сценарий ждёт шапку, и доложить: это решение владельца панели, а не исполнителя.

- [ ] **Step 6: Коммит**

```bash
git add xkeen-ui/services/xray_subscriptions.py tests/test_xray_observatory_sync.py
git -c user.name="olmer2002" -c user.email="olmer2002@gmail.com" commit -m "Подписки выбирают обсерваторию по стратегиям балансировщиков" -m "- если в конфигах есть балансировщик leastLoad, панель пишет burstObservatory, иначе обычную observatory
- подходящий файл владельца не переписывается вовсе, комментарии и оформление остаются
- двух секций обсерватории одновременно больше не бывает
- при выключении одной из подписок убираются только её теги"
```

---

### Task 3: После ухода последней подписки обсерватория возвращается к исходному виду

Панель при первом обновлении подписки запоминает слепок `07_observatory.json` — текст файла до своего вмешательства. Сейчас слепок возвращается только при выходе из режима «только подписка». При обычном выключении панель лишь убирает свои теги, и после замены `observatory` → `burstObservatory` файл остался бы с чужим для владельца видом секции. По решению 5: когда активных подписок не остаётся, а вид секции отличается от того, что был в слепке, файл возвращается из слепка целиком.

Что эта задача сознательно не делает:
- не трогает файл, если вид секции тот же, что в слепке, — там работает прежнее удаление тегов, и ручные правки владельца, сделанные при включённой подписке, сохраняются;
- не удаляет файл, которого до подписки не было вовсе, — поведение для созданного панелью файла остаётся прежним;
- не меняет выход из режима «только подписка»: там слепок возвращается и так.

Обратная сторона, о которой владелец знает: если панель меняла вид секции, ручные правки `07_observatory.json`, сделанные при включённой подписке, при возврате из слепка пропадают.

**Files:**
- Modify: `xkeen-ui/services/xray_subscriptions.py` — новая функция `_undo_observatory_conversion` рядом с `_restore_subscription_managed_baselines`, вызов в `_rebuild_subscription_runtime` (сейчас строки 5560–5619)
- Test: `tests/test_xray_observatory_sync.py`

**Interfaces:**
- Consumes: `KIND_PLAIN`, `KIND_BURST`, `OBSERVATORY_FILE`, `read_fragment` из Task 1; существующие `_normalize_managed_baselines`, `_restore_managed_file_baseline`, `_load_jsonc_text`, `MANAGED_BASELINES_KEY`, `MANAGED_BASELINE_OBSERVATORY_KEY`.
- Produces: `_undo_observatory_conversion(ui_state_dir: str, *, xray_configs_dir: str, snapshot=None) -> bool`.

- [ ] **Step 1: Написать падающие тесты**

Дописать в `tests/test_xray_observatory_sync.py`:

```python
PLAIN_BEFORE = (
    "{\n"
    '  "observatory": {\n'
    '    "subjectSelector": ["manual"],\n'
    '    "probeUrl": "https://cp.cloudflare.com/generate_204",\n'
    '    "probeInterval": "5m"\n'
    "  }\n"
    "}\n"
)


def _state_dir(tmp_path: Path) -> Path:
    path = tmp_path / "state"
    path.mkdir()
    return path


def test_last_subscription_leaving_restores_the_original_kind(env, tmp_path):
    subs, xray_dir, _jsonc = env
    ui_state_dir = _state_dir(tmp_path)
    _routing(xray_dir, "leastLoad")
    target = xray_dir / "07_observatory.json"
    target.write_text(PLAIN_BEFORE, encoding="utf-8")
    subs._ensure_subscription_managed_baselines(str(ui_state_dir), str(xray_dir))

    subs.sync_observatory_subjects(xray_configs_dir=str(xray_dir), add_tags=SUB_TAGS)
    assert _sections(xray_dir) == [("07_observatory.json", "burstObservatory")]
    subs.sync_observatory_subjects(
        xray_configs_dir=str(xray_dir), add_tags=[], remove_tags=SUB_TAGS, managed_active=False
    )

    undone = subs._undo_observatory_conversion(str(ui_state_dir), xray_configs_dir=str(xray_dir))

    assert undone is True
    assert target.read_text(encoding="utf-8") == PLAIN_BEFORE


def test_same_kind_keeps_owner_edits_made_while_subscribed(env, tmp_path):
    subs, xray_dir, _jsonc = env
    ui_state_dir = _state_dir(tmp_path)
    _routing(xray_dir, "leastPing")
    target = xray_dir / "07_observatory.json"
    target.write_text(PLAIN_BEFORE, encoding="utf-8")
    subs._ensure_subscription_managed_baselines(str(ui_state_dir), str(xray_dir))

    edited = PLAIN_BEFORE.replace('"5m"', '"1m"')
    target.write_text(edited, encoding="utf-8")

    assert subs._undo_observatory_conversion(str(ui_state_dir), xray_configs_dir=str(xray_dir)) is False
    assert target.read_text(encoding="utf-8") == edited


def test_file_created_by_the_panel_is_not_removed_by_the_undo(env, tmp_path):
    subs, xray_dir, _jsonc = env
    ui_state_dir = _state_dir(tmp_path)
    _routing(xray_dir, "leastLoad")
    subs._ensure_subscription_managed_baselines(str(ui_state_dir), str(xray_dir))
    subs.sync_observatory_subjects(xray_configs_dir=str(xray_dir), add_tags=SUB_TAGS)

    assert subs._undo_observatory_conversion(str(ui_state_dir), xray_configs_dir=str(xray_dir)) is False
    assert (xray_dir / "07_observatory.json").exists()


def test_rebuild_undoes_the_conversion_only_when_no_targets_remain(env, tmp_path, monkeypatch):
    subs, xray_dir, _jsonc = env
    ui_state_dir = _state_dir(tmp_path)
    calls = []
    monkeypatch.setattr(
        subs, "sync_subscription_runtime_plan_delta", lambda **_k: {"observatory_changed": False}
    )
    monkeypatch.setattr(
        subs, "_undo_observatory_conversion", lambda *_a, **_k: calls.append("undo") or True
    )

    plans = iter([{"has_runtime_targets": True}, {"has_runtime_targets": True}])
    monkeypatch.setattr(subs, "_build_runtime_sync_plan", lambda _state: next(plans))
    still_active = subs._rebuild_subscription_runtime(
        str(ui_state_dir), xray_configs_dir=str(xray_dir),
        previous_state={"subscriptions": []}, state_override={"subscriptions": []},
    )

    plans = iter([{"has_runtime_targets": True}, {"has_runtime_targets": False}])
    last_gone = subs._rebuild_subscription_runtime(
        str(ui_state_dir), xray_configs_dir=str(xray_dir),
        previous_state={"subscriptions": []}, state_override={"subscriptions": []},
    )

    assert still_active["observatory_changed"] is False
    assert last_gone["observatory_changed"] is True
    assert calls == ["undo"]
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `python -m pytest tests/test_xray_observatory_sync.py -q -k "restores_the_original_kind or same_kind or created_by_the_panel or rebuild_undoes"`
Expected: 4 failed, `AttributeError: ... has no attribute '_undo_observatory_conversion'`.

- [ ] **Step 3: Написать возврат и подключить его**

В `xkeen-ui/services/xray_subscriptions.py` сразу после функции `_restore_subscription_managed_baselines` добавить:

```python
def _observatory_kind_of(obj: Any) -> str:
    if isinstance(obj, dict):
        for kind in (KIND_PLAIN, KIND_BURST):
            if isinstance(obj.get(kind), dict):
                return kind
    return ""


def _undo_observatory_conversion(
    ui_state_dir: str,
    *,
    xray_configs_dir: str,
    snapshot: SnapshotCallback | None = None,
) -> bool:
    """Give the owner's observatory file back once no subscription needs it.

    While a subscription is active the panel may switch the section kind to
    match the balancer strategies.  Removing tags cannot undo that, so when the
    last subscription leaves and the kind differs from the one captured before
    the first subscription, the captured file is written back whole.  A file of
    the same kind is left to tag removal: edits the owner made meanwhile stay.
    """
    with _STATE_LOCK:
        state = load_subscription_state(ui_state_dir)
        baselines = _normalize_managed_baselines(state.get(MANAGED_BASELINES_KEY))
    baseline = baselines.get(MANAGED_BASELINE_OBSERVATORY_KEY) if baselines else None
    if not isinstance(baseline, dict) or not baseline.get("exists"):
        return False
    before_kind = _observatory_kind_of(_load_jsonc_text(str(baseline.get("text") or "")))
    if not before_kind:
        return False
    path = _config_fragment_path(xray_configs_dir, baseline.get("path") or OBSERVATORY_FILE)
    if _observatory_kind_of(read_fragment(path)) == before_kind:
        return False
    return _restore_managed_file_baseline(
        xray_configs_dir, baseline, default_name=OBSERVATORY_FILE, snapshot=snapshot
    )
```

В `_rebuild_subscription_runtime` заменить последний `return sync_subscription_runtime_plan_delta(...)` (обычный путь, без возврата слепка) на:

```python
    result = sync_subscription_runtime_plan_delta(
        xray_configs_dir=xray_configs_dir,
        previous_plan=prev_plan,
        next_plan=next_plan,
        snapshot=snapshot,
    )
    if not next_plan.get("has_runtime_targets"):
        # Callers drop the baselines right after this returns, so the kind has
        # to go back now or never.
        undone = _undo_observatory_conversion(ui_state_dir, xray_configs_dir=xray_configs_dir, snapshot=snapshot)
        result["observatory_changed"] = bool(result.get("observatory_changed") or undone)
    return result
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `python -m pytest tests/test_xray_observatory_sync.py tests/test_xray_subscriptions.py -q 2>&1 | tail -5`
Expected: всё зелёное.

- [ ] **Step 5: Коммит**

```bash
git add xkeen-ui/services/xray_subscriptions.py tests/test_xray_observatory_sync.py
git -c user.name="olmer2002" -c user.email="olmer2002@gmail.com" commit -m "После отключения последней подписки файл обсерватории возвращается к исходному виду"
```

---

### Task 4: DNS-over-VLESS отсекает неотвечающие узлы при burstObservatory

`leastPing` при `burstObservatory` продолжает выбирать умерший или мигающий узел, пока в выборке есть хоть одна удачная проба. `leastLoad` с `tolerance` отсекает узел по доле неудач.

**Files:**
- Modify: `xkeen-ui/services/dns_over_vless.py` — `_collect_runtime` (строки 370–433), `_build_target` (746–780), `_build_combined_target` (871–897)
- Modify: `docs/dns-over-vless.md` — абзац про стратегию собственного балансировщика (строка 112)
- Test: `tests/test_dns_over_vless.py`

**Interfaces:**
- Consumes: `LEAST_LOAD_EXPECTED`, `LEAST_LOAD_TOLERANCE`, `KIND_PLAIN`, `KIND_BURST` из Task 1.
- Produces: в словаре `runtime` новый ключ `observatory_kind: str`; `observatory_selectors` теперь содержит селекторы только действующего вида.

- [ ] **Step 1: Написать падающие тесты**

Дописать в `tests/test_dns_over_vless.py` после `test_least_ping_is_used_only_when_observatory_probes_the_chosen_proxies`:

```python
LEAST_LOAD_WITH_TOLERANCE = {"type": "leastLoad", "settings": {"expected": 2, "tolerance": 0.5}}


def test_burst_observatory_switches_own_balancer_to_least_load(tmp_path: Path):
    configs, routing_path, _state = _scenario_config(tmp_path)
    _write(configs / "07_observatory.json", {"burstObservatory": {"subjectSelector": ["my_proxy"]}})
    routing = json.loads(routing_path.read_text(encoding="utf-8"))
    runtime = dns._collect_runtime(str(configs), routing)

    covered = dns._select_target(runtime, ["my_proxy_1", "my_proxy_2"], routing)
    partly = dns._select_target(runtime, ["my_proxy_1", "reserve_proxy_1"], routing)

    assert runtime["observatory_kind"] == "burstObservatory"
    assert covered["managed_balancer"]["strategy"] == LEAST_LOAD_WITH_TOLERANCE
    assert partly["managed_balancer"]["strategy"] == {"type": "random"}


def test_plain_observatory_wins_when_both_sections_exist(tmp_path: Path):
    configs, routing_path, _state = _scenario_config(tmp_path)
    _write(configs / "07_observatory.json", {"observatory": {"subjectSelector": ["reserve_proxy"]}})
    _write(configs / "09_burst.json", {"burstObservatory": {"subjectSelector": ["my_proxy"]}})
    routing = json.loads(routing_path.read_text(encoding="utf-8"))
    runtime = dns._collect_runtime(str(configs), routing)

    # The core reads the plain section, so my_proxy_* are in fact not probed.
    assert runtime["observatory_kind"] == "observatory"
    assert runtime["observatory_selectors"] == ["reserve_proxy"]
    target = dns._select_target(runtime, ["my_proxy_1", "my_proxy_2"], routing)
    assert target["managed_balancer"]["strategy"] == {"type": "random"}


def test_cloned_least_ping_balancer_becomes_least_load_under_burst(tmp_path: Path):
    configs, routing_path, _state = _scenario_config(tmp_path)
    routing = json.loads(routing_path.read_text(encoding="utf-8"))
    source = next(
        item for item in routing["routing"]["balancers"]
        if (item.get("strategy") or {}).get("type") == "leastPing"
    )
    probed = [str(value) for value in source["selector"]]

    _write(configs / "07_observatory.json", {"burstObservatory": {"subjectSelector": probed}})
    burst_runtime = dns._collect_runtime(str(configs), routing)
    under_burst = dns._select_target(burst_runtime, source["tag"], routing)

    _write(configs / "07_observatory.json", {"observatory": {"subjectSelector": probed}})
    plain_runtime = dns._collect_runtime(str(configs), routing)
    under_plain = dns._select_target(plain_runtime, source["tag"], routing)

    assert under_burst["managed_balancer"]["strategy"] == LEAST_LOAD_WITH_TOLERANCE
    assert under_plain["managed_balancer"]["strategy"] == {"type": "leastPing"}
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `python -m pytest tests/test_dns_over_vless.py -q -k "burst or plain_observatory_wins or cloned_least_ping"`
Expected: 3 failed (`KeyError: 'observatory_kind'` и неверная стратегия).

- [ ] **Step 3: Научить `_collect_runtime` действующему виду**

Добавить импорт в `xkeen-ui/services/dns_over_vless.py`:

```python
from services.xray_observatory import KIND_BURST, KIND_PLAIN, LEAST_LOAD_EXPECTED, LEAST_LOAD_TOLERANCE
```

В `_collect_runtime` заменить объявление `observatory_selectors: list[str] = []` и цикл по ключам:

```python
    # subjectSelector entries per observatory kind.  With both sections present
    # the core reads the plain one, so only its selectors count as "probed".
    observatory_by_kind: Dict[str, list[str]] = {KIND_PLAIN: [], KIND_BURST: []}
    observatory_present: set[str] = set()
```

```python
        for key in (KIND_PLAIN, KIND_BURST):
            section = obj.get(key)
            if not isinstance(section, dict):
                continue
            observatory_present.add(key)
            raw = section.get("subjectSelector")
            for value in raw if isinstance(raw, list) else []:
                prefix = str(value).strip()
                if prefix:
                    observatory_by_kind[key].append(prefix)
```

Перед `return` добавить и расширить возвращаемый словарь:

```python
    observatory_kind = (
        KIND_PLAIN if KIND_PLAIN in observatory_present
        else KIND_BURST if KIND_BURST in observatory_present
        else ""
    )
```

```python
        "observatory_selectors": observatory_by_kind.get(observatory_kind, []),
        "observatory_kind": observatory_kind,
```

- [ ] **Step 4: Выбирать стратегию по виду обсерватории**

Добавить функцию перед `_build_combined_target`:

```python
def _probed_strategy(runtime: Dict[str, Any], tags: Iterable[str]) -> Dict[str, Any]:
    """Health-aware strategy for outbounds an observatory actually probes.

    Under ``burstObservatory`` a node counts as alive while any probe of its
    sample succeeded, and failed probes never enter its average delay -- so
    ``leastPing`` keeps choosing a dead or flapping node.  ``leastLoad`` can cut
    a node by its share of failed probes, which is what DNS needs.
    """
    if not _observatory_covers(runtime, list(tags)):
        return {"type": "random"}
    if runtime.get("observatory_kind") == KIND_BURST:
        return {
            "type": "leastLoad",
            "settings": {"expected": LEAST_LOAD_EXPECTED, "tolerance": LEAST_LOAD_TOLERANCE},
        }
    return {"type": "leastPing"}
```

В `_build_combined_target` заменить строку со `strategy = ...` на:

```python
    strategy = _probed_strategy(runtime, tags)
```

В `_build_target` после сборки словаря `managed` (до блока про `fallbackTag`) добавить:

```python
    if _clean_tag(managed["strategy"].get("type")).lower() == "leastping":
        live = [
            item["tag"]
            for item in _proxy_outbounds(runtime)
            if any(item["tag"].startswith(prefix) for prefix in managed["selector"])
        ]
        upgraded = _probed_strategy(runtime, live)
        # Only ever upgrade: an uncovered leastPing clone stays what the owner wrote.
        if upgraded["type"] == "leastLoad":
            managed["strategy"] = upgraded
```

- [ ] **Step 5: Убедиться, что тесты проходят**

Run: `python -m pytest tests/test_dns_over_vless.py -q 2>&1 | tail -5`
Expected: всё зелёное, включая прежний `test_least_ping_is_used_only_when_observatory_probes_the_chosen_proxies`.

- [ ] **Step 6: Проверить, что ядро принимает такую стратегию**

```bash
S="$TEMP/xk-leastload-check"; rm -rf "$S"; mkdir -p "$S"
cat > "$S/c.json" <<'EOF'
{"outbounds":[{"tag":"p1","protocol":"freedom"},{"tag":"p2","protocol":"freedom"}],
 "routing":{"balancers":[{"tag":"xk-dns-over-vless","selector":["p"],"strategy":{"type":"leastLoad","settings":{"expected":2,"tolerance":0.5}}}],
            "rules":[{"inboundTag":["none"],"balancerTag":"xk-dns-over-vless"}]},
 "burstObservatory":{"subjectSelector":["p"],"pingConfig":{"destination":"https://cp.cloudflare.com/generate_204","interval":"2m","sampling":3,"timeout":"5s"}}}
EOF
"C:/Users/Alex/Documents/Xray-Configs/tools/cores/26.9.9/xray.exe" run -confdir "$S" -test; echo "exit=$?"
```

Expected: `Configuration OK.` и `exit=0`. Если ядро отвергает `settings.expected` или `settings.tolerance` — остановиться и доложить, имена полей не подбирать.

- [ ] **Step 7: Обновить документацию**

В `docs/dns-over-vless.md` в абзаце про собственный балансировщик (строка 112, начинается с «Стратегия `leastPing` ставится, только если observatory») дописать после него:

```markdown
  Если в конфигах действует `burstObservatory`, вместо `leastPing` ставится `leastLoad` с
  `expected: 2` и `tolerance: 0.5`. Причина: при `burstObservatory` узел считается живым, пока в выборке есть
  хоть одна удачная проба, и `leastPing` продолжает выбирать умерший или мигающий узел.
  `leastLoad` отсекает узел, у которого провалилось больше половины проб, а запросы раскладывает
  между двумя самыми стабильными узлами. Обратная сторона:
  `leastLoad` выбирает узел с наименьшим разбросом задержки, а не с наименьшей задержкой.
  То же правило действует для копии чужого балансировщика, если у оригинала стоял `leastPing`.
  Уже включённая защита меняет стратегию только при следующем применении.
```

- [ ] **Step 8: Коммит**

```bash
git add xkeen-ui/services/dns_over_vless.py tests/test_dns_over_vless.py docs/dns-over-vless.md
git -c user.name="olmer2002" -c user.email="olmer2002@gmail.com" commit -m "DNS-over-VLESS перестаёт ходить через неотвечающий сервер при burstObservatory" -m "- при burstObservatory балансировщик DNS отсекает сервер, у которого провалилось больше половины проверок, и делит запросы между двумя самыми стабильными серверами
- при обычной observatory всё работает как раньше"
```

---

### Task 5: Маршруты и шаблон обсерватории

Окно быстрого балансировщика создаёт обсерваторию маршрутом `POST /api/xray/observatory/generate` и читает её `GET /api/xray/observatory/config`. Оба знают только ключ `observatory`: на файле с `burstObservatory` первый допишет вторую секцию, второй покажет пустые поля. В шаблоне пример `burstObservatory` написан полями обычной.

**Files:**
- Modify: `xkeen-ui/services/xray_observatory.py` — две чистые функции
- Modify: `xkeen-ui/routes/xray_configs.py` — `api_xray_observatory_config` (строки 2122–2208), `api_xray_observatory_generate` (2213–2357)
- Modify: `xkeen-ui/opt/etc/xray/templates/observatory/07_observatory_base.jsonc`
- Test: `tests/test_xray_observatory.py`

**Interfaces:**
- Produces:
  - `describe_config(cfg_obj: dict) -> dict` с ключами `kind`, `subjectSelector`, `probeUrl`, `probeInterval`, `enableConcurrency`;
  - `apply_generate_request(cfg_obj: dict, *, subject: list[str], probe_url: Any, probe_interval: Any, enable_concurrency: Any, want_burst: bool) -> dict` — возвращает новый объект файла с одной секцией.

- [ ] **Step 1: Написать падающие тесты**

Дописать в `tests/test_xray_observatory.py`:

```python
def test_describe_config_maps_burst_fields_to_the_form():
    cfg = {"burstObservatory": {
        "subjectSelector": ["VPS_"],
        "pingConfig": {"destination": "https://cp.cloudflare.com/generate_204", "interval": "10m", "sampling": 6},
    }}

    assert obs.describe_config(cfg) == {
        "kind": "burstObservatory",
        "subjectSelector": ["VPS_"],
        "probeUrl": "https://cp.cloudflare.com/generate_204",
        "probeInterval": "10m",
        "enableConcurrency": True,
    }
    assert obs.describe_config({})["kind"] == ""


def test_generate_updates_an_existing_burst_section_in_place():
    cfg = {"burstObservatory": {
        "subjectSelector": ["old"],
        "pingConfig": {"destination": "https://a.example/204", "interval": "10m", "sampling": 6, "timeout": "5s"},
    }}

    result = obs.apply_generate_request(
        cfg, subject=["VPS_"], probe_url="https://b.example/204", probe_interval="", enable_concurrency=None,
        want_burst=False,
    )

    assert list(result) == ["burstObservatory"]
    assert result["burstObservatory"] == {
        "subjectSelector": ["VPS_"],
        "pingConfig": {"destination": "https://b.example/204", "interval": "10m", "sampling": 6, "timeout": "5s"},
    }


def test_generate_writes_burst_for_least_load_and_plain_otherwise():
    burst = obs.apply_generate_request(
        {}, subject=["VPS_"], probe_url=None, probe_interval=None, enable_concurrency=None, want_burst=True
    )
    plain = obs.apply_generate_request(
        {}, subject=["VPS_"], probe_url=None, probe_interval=None, enable_concurrency=None, want_burst=False
    )

    assert burst == {"burstObservatory": {
        "subjectSelector": ["VPS_"],
        "pingConfig": {"destination": "https://www.gstatic.com/generate_204", "interval": "2m", "sampling": 3,
                       "timeout": "5s"},
    }}
    assert plain == {"observatory": {
        "subjectSelector": ["VPS_"],
        "probeUrl": "https://www.gstatic.com/generate_204",
        "probeInterval": "60s",
        "enableConcurrency": True,
    }}


def test_generate_converts_plain_to_burst_when_least_load_appeared():
    cfg = {"log": {}, "observatory": {"subjectSelector": ["old"], "probeUrl": "https://a.example/204",
                                      "probeInterval": "5m", "enableConcurrency": True}}

    result = obs.apply_generate_request(
        cfg, subject=["VPS_"], probe_url=None, probe_interval=None, enable_concurrency=None, want_burst=True
    )

    assert list(result) == ["log", "burstObservatory"]
    assert result["burstObservatory"]["subjectSelector"] == ["VPS_"]
    assert result["burstObservatory"]["pingConfig"]["destination"] == "https://a.example/204"
    assert result["burstObservatory"]["pingConfig"]["interval"] == "2m"


def test_bundled_template_shows_a_valid_burst_example():
    text = (Path(__file__).resolve().parents[1]
            / "xkeen-ui/opt/etc/xray/templates/observatory/07_observatory_base.jsonc").read_text(encoding="utf-8")
    burst_part = text.split("burstObservatory", 1)[1]

    assert '"pingConfig"' in burst_part
    assert '"destination"' in burst_part
    assert "probeUrl" not in burst_part
    assert "leastLoad" in text
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `python -m pytest tests/test_xray_observatory.py -q`
Expected: 5 новых тестов падают (`AttributeError` и провал проверки шаблона).

- [ ] **Step 3: Дописать чистые функции**

В конец `xkeen-ui/services/xray_observatory.py`:

```python
DEFAULT_PROBE_URL = "https://www.gstatic.com/generate_204"


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def describe_config(cfg_obj: Dict[str, Any]) -> Dict[str, Any]:
    """Flatten whichever section the file holds into the fields the form shows."""
    obj = cfg_obj if isinstance(cfg_obj, dict) else {}
    if isinstance(obj.get(KIND_PLAIN), dict):
        section = obj[KIND_PLAIN]
        concurrency = section.get("enableConcurrency")
        return {
            "kind": KIND_PLAIN,
            "subjectSelector": clean_selectors(section.get("subjectSelector")),
            "probeUrl": str(section.get("probeUrl") or ""),
            "probeInterval": str(section.get("probeInterval") or ""),
            "enableConcurrency": concurrency if isinstance(concurrency, bool) else True,
        }
    if isinstance(obj.get(KIND_BURST), dict):
        section = obj[KIND_BURST]
        ping = section.get("pingConfig") if isinstance(section.get("pingConfig"), dict) else {}
        return {
            "kind": KIND_BURST,
            "subjectSelector": clean_selectors(section.get("subjectSelector")),
            "probeUrl": str(ping.get("destination") or ""),
            "probeInterval": str(ping.get("interval") or ""),
            "enableConcurrency": True,
        }
    return {"kind": "", "subjectSelector": [], "probeUrl": "", "probeInterval": "", "enableConcurrency": True}


def apply_generate_request(
    cfg_obj: Dict[str, Any],
    *,
    subject: List[str],
    probe_url: Any,
    probe_interval: Any,
    enable_concurrency: Any,
    want_burst: bool,
) -> Dict[str, Any]:
    """Apply the form to the file, keeping exactly one observatory section."""
    obj = copy.deepcopy(cfg_obj) if isinstance(cfg_obj, dict) else {}
    plain = obj.get(KIND_PLAIN) if isinstance(obj.get(KIND_PLAIN), dict) else None
    burst = obj.get(KIND_BURST) if isinstance(obj.get(KIND_BURST), dict) else None

    if burst is not None or want_burst:
        if burst is None:
            burst = burst_from_plain(plain or {}, DEFAULT_PROBE_URL)
        ping = burst.get("pingConfig") if isinstance(burst.get("pingConfig"), dict) else {}
        if _text(probe_url):
            ping["destination"] = _text(probe_url)
        if _text(probe_interval):
            ping["interval"] = _text(probe_interval)
        burst["subjectSelector"] = list(subject)
        burst["pingConfig"] = ping
        return replace_section(obj, KIND_BURST, burst)

    section = plain if plain is not None else {}
    section["subjectSelector"] = list(subject)
    if _text(probe_url):
        section["probeUrl"] = _text(probe_url)
    else:
        section.setdefault("probeUrl", DEFAULT_PROBE_URL)
    if _text(probe_interval):
        section["probeInterval"] = _text(probe_interval)
    else:
        section.setdefault("probeInterval", "60s")
    if isinstance(enable_concurrency, bool):
        section["enableConcurrency"] = enable_concurrency
    else:
        section.setdefault("enableConcurrency", True)
    return replace_section(obj, KIND_PLAIN, section)
```

- [ ] **Step 4: Перевести маршруты на эти функции**

В `xkeen-ui/routes/xray_configs.py` добавить импорт рядом с остальными импортами `services.*`:

```python
from services.xray_observatory import apply_generate_request, collect_catalog, describe_config, read_fragment
```

В `api_xray_observatory_config`:
- блок чтения файла (от `if exists:` до конца блока `try/except`, заполняющего `cfg_obj`) заменить на `cfg_obj = read_fragment(dst_json) or {}` под тем же `if exists:`;
- удалить вычисление `obs` и вложенные функции `_str`, `_bool`, `_list`;
- сборку `config = {...}` заменить на `config = describe_config(cfg_obj)`.

В `api_xray_observatory_generate`:
- блок чтения существующего файла заменить на `cfg_obj = (read_fragment(dst_json) or {}) if existed else {}`;
- блок от `obs = cfg_obj.get("observatory")` до `cfg_obj["observatory"] = obs` включительно заменить на:

```python
        cfg_obj = apply_generate_request(
            cfg_obj,
            subject=subject,
            probe_url=probe_url,
            probe_interval=probe_interval,
            enable_concurrency=enable_conc,
            want_burst=bool(collect_catalog(XRAY_CONFIGS_DIR)["has_least_load"]),
        )
        described = describe_config(cfg_obj)
```

- в тексте JSONC-копии заменить первую строку шапки `"// Автосгенерировано панелью XKeen UI (leastPing)\n"` на `"// Автосгенерировано панелью XKeen UI (обсерватория для балансировщиков)\n"`;
- в ответе словарь `"config": {...}` заменить на `"config": described`.

- [ ] **Step 5: Исправить шаблон**

В `xkeen-ui/opt/etc/xray/templates/observatory/07_observatory_base.jsonc` заменить хвост файла, начиная со строки `// Альтернатива (не включайте одновременно с observatory):`, на:

```jsonc
// Для balancer.strategy.type=leastLoad нужна burstObservatory: только она считает
// разброс задержки и долю неудачных проб. Не включайте одновременно с observatory —
// ядро возьмёт обычную, и leastLoad останется без этих данных.
// {
//   "burstObservatory": {
//     "subjectSelector": ["proxy"],
//     "pingConfig": {
//       "destination": "https://www.google.com/generate_204",
//       "interval": "2m",
//       "sampling": 3,
//       "timeout": "5s"
//     }
//   }
// }
```

- [ ] **Step 6: Убедиться, что тесты проходят**

Run: `python -m pytest tests/test_xray_observatory.py tests/test_frontend_runtime_hotfixes.py -q 2>&1 | tail -5`
Expected: всё зелёное.

- [ ] **Step 7: Коммит**

```bash
git add xkeen-ui/services/xray_observatory.py xkeen-ui/routes/xray_configs.py xkeen-ui/opt/etc/xray/templates/observatory/07_observatory_base.jsonc tests/test_xray_observatory.py
git -c user.name="olmer2002" -c user.email="olmer2002@gmail.com" commit -m "Окно балансировщика понимает burstObservatory и не дописывает вторую обсерваторию"
```

---

### Task 6: Приёмка настоящим ядром и полный прогон

**Files:**
- Create: `tests/test_xray_observatory_acceptance.py`

**Interfaces:**
- Consumes: `sync_observatory_subjects` из Task 2.

- [ ] **Step 1: Написать тест приёмки по критериям задания**

Тест собирает каталог из эталона и аутбаундов, включает и выключает «подписку», затем отдаёт каталог ядру. Без ядра на машине тест пропускается.

```python
# tests/test_xray_observatory_acceptance.py
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

CORE = Path(os.environ.get("XKEEN_TEST_XRAY_CORE", r"C:\Users\Alex\Documents\Xray-Configs\tools\cores\26.9.9\xray.exe"))
SUB_TAGS = ["VPS_NL_SUB", "VPS_CH_SUB"]
ETALON = (
    "// выбор объяснён в эталоне\n"
    '{ "burstObservatory": { "subjectSelector": ["VPS_"],\n'
    '    "pingConfig": { "destination": "https://cp.cloudflare.com/generate_204",\n'
    '                    "interval": "10m", "sampling": 6, "timeout": "5s" } } }\n'
)
PLAIN = {"observatory": {"subjectSelector": ["manual"], "probeUrl": "https://cp.cloudflare.com/generate_204",
                         "probeInterval": "5m", "enableConcurrency": True}}

pytestmark = pytest.mark.skipif(not CORE.exists(), reason="ядро Xray 26.9.9 недоступно")


def _catalog(tmp_path: Path, strategies: list[str], observatory: str | None) -> Path:
    configs = tmp_path / "configs"
    configs.mkdir()
    outbounds = [{"tag": "direct", "protocol": "freedom"}] + [
        {"tag": f"{tag}--node", "protocol": "freedom"} for tag in SUB_TAGS
    ]
    (configs / "04_outbounds.json").write_text(json.dumps({"outbounds": outbounds}), encoding="utf-8")
    balancers = [
        {"tag": f"b{idx}", "selector": ["VPS_"], "strategy": {"type": kind}}
        for idx, kind in enumerate(strategies)
    ]
    rules = [{"inboundTag": [f"none{idx}"], "balancerTag": f"b{idx}"} for idx in range(len(strategies))]
    (configs / "05_routing.json").write_text(
        json.dumps({"routing": {"balancers": balancers, "rules": rules}}), encoding="utf-8"
    )
    if observatory is not None:
        (configs / "07_observatory.json").write_text(observatory, encoding="utf-8")
    return configs


def _core_accepts(configs: Path) -> None:
    run = subprocess.run([str(CORE), "run", "-confdir", str(configs), "-test"], capture_output=True, text=True)
    assert run.returncode == 0, run.stdout + run.stderr


def _kinds(configs: Path) -> list[str]:
    from services.xray_observatory import collect_catalog

    return [item["kind"] for item in collect_catalog(str(configs))["sections"]]


@pytest.fixture
def subs(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as module

    jsonc_dir = tmp_path / "jsonc"
    jsonc_dir.mkdir()
    monkeypatch.setattr(module, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(module, "ensure_xray_jsonc_dir", lambda: None)
    return module


@pytest.mark.parametrize(
    "strategies, observatory, expected_kind",
    [
        (["leastPing", "leastLoad"], ETALON, "burstObservatory"),              # критерий 1
        (["leastLoad"], json.dumps({"burstObservatory": {"subjectSelector": ["OTHER_"]}}), "burstObservatory"),  # 2
        (["leastPing", "leastLoad"], json.dumps(PLAIN), "burstObservatory"),  # критерий 3
        (["leastPing"], None, "observatory"),                                  # критерий 4
    ],
)
def test_enable_then_disable_leaves_one_section_the_core_accepts(tmp_path, subs, strategies, observatory, expected_kind):
    configs = _catalog(tmp_path, strategies, observatory)
    _core_accepts(configs)  # контрольный прогон: исходный каталог ядро принимает

    subs.sync_observatory_subjects(xray_configs_dir=str(configs), add_tags=SUB_TAGS)
    assert _kinds(configs) == [expected_kind]
    _core_accepts(configs)

    subs.sync_observatory_subjects(
        xray_configs_dir=str(configs), add_tags=[], remove_tags=SUB_TAGS, managed_active=False
    )
    assert _kinds(configs) == [expected_kind]  # критерий 5: одна секция, удаление тегов вид не меняет
    _core_accepts(configs)                      # критерий 6


def test_etalon_survives_enable_and_disable_byte_for_byte(tmp_path, subs):
    configs = _catalog(tmp_path, ["leastPing", "leastLoad"], ETALON)

    subs.sync_observatory_subjects(xray_configs_dir=str(configs), add_tags=SUB_TAGS)
    subs.sync_observatory_subjects(
        xray_configs_dir=str(configs), add_tags=[], remove_tags=SUB_TAGS, managed_active=False
    )

    assert (configs / "07_observatory.json").read_text(encoding="utf-8") == ETALON
```

- [ ] **Step 2: Запустить приёмку**

Run: `python -m pytest tests/test_xray_observatory_acceptance.py -q`
Expected: `5 passed`. Если все пять `skipped` — ядро не найдено, приёмка не состоялась; указать путь через `XKEEN_TEST_XRAY_CORE` и повторить.

- [ ] **Step 3: Полный прогон python-тестов из Bash**

Run: `python -m pytest -q 2>&1 | tail -15`
Expected: всё зелёное. Любое падение вне тронутых файлов сначала проверить на чистом дереве (`git stash` → тот же тест → `git stash pop`), чтобы отличить старое падение от своего.

- [ ] **Step 4: Коммит**

```bash
git add tests/test_xray_observatory_acceptance.py
git -c user.name="olmer2002" -c user.email="olmer2002@gmail.com" commit -m "Проверка обсерватории настоящим ядром Xray"
```

- [ ] **Step 5: Проверка на роутере — только по отмашке владельца**

Не выполнять без явного «да». Порядок, когда отмашка будет: собрать архив, поставить на 45.1, пройти сценарий владельца из задания (выключить подписку и DNS-over-VLESS → залить эталон → включить обратно), затем проверить три вещи:
1. `07_observatory.json` совпадает с эталоном байт в байт;
2. в `05_routing.json` у `xk-dns-over-vless` стоит `leastLoad` с `expected: 2` и `tolerance: 0.5`;
3. время ответа DNS через защиту не выросло заметно по сравнению с `leastPing` (последствие из раздела «Известные последствия»);
4. куда уходит DNS-запрос, когда балансировщик не выбрал ни одного узла (все отсечены по `tolerance`): по коду ядра без `fallbackTag` запрос отдаётся обработчику по умолчанию. Если на роутере это прямой выход мимо туннеля — это утечка, её надо закрыть до выкладки отдельной задачей.

---

## Что в план не вошло

- Автозамена обсерватории при сохранении маршрутизации в редакторе (решение 7).
- Автоматическая миграция уже включённого DNS-over-VLESS с `leastPing` на `leastLoad`.
- Правка эталона в проекте `Xray-Configs`: `10m × 6` → `2m × 3` меняет владелец эталона, панель чужой `pingConfig` не трогает.
- Задачи 3–5 задания от 24 сентября (`"type": "field"`, `domainMatcher`, отключение файлов).
