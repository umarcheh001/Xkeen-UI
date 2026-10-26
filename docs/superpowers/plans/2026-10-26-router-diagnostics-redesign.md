# Диагностика роутера: дашборд — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Переделать окно «Диагностика роутера» в дашборд по согласованной спецификации: история на роутере (час / сутки / неделя) с сохранением, карточки, график-индикатор, железо по реальным датчикам, вкладки инструментов.

**Architecture:** На сервере новый пакет `services/system_resources_history/` (разбор датчиков, кольцевые ярусы истории, правило проблем, сохранение, фоновый сборщик) и новые маршруты в блюпринте модуля `tool.advanced-diagnostics`. Зоны (зелёная / оранжевая / красная) вычисляет только сервер; браузер их рисует. Фронтенд — новый каталог `static/js/features/resource_monitor/`: окно в shadow DOM со своим CSS, графики на canvas, перерисовка только изменившегося столбца.

**Tech Stack:** Python 3 (Flask, `threading`, `array`), RCI прошивки через `utils/firmware.py` / `fetch_rci_json`, ES-модули без фреймворка, Canvas 2D, Playwright e2e, pytest.

**Spec:** `docs/superpowers/specs/2026-10-26-router-diagnostics-redesign-design.md` (коммиты `af09dd04`, `6b9a770a`, `3e7edf66`, `51f559c8`). Финальный макет: `C:\Users\Alex\Desktop\Диагностика роутера — макет.html`.

## Global Constraints

- Весь текст интерфейса — по-русски, формулировки из спецификации дословно («Есть проблемы: N», «нет данных», «горячее обычного на N °C», «процессор замедлился из-за нагрева» и т. д.).
- Вызовы `ndmc` — только через `xkeen-ui/utils/firmware.py`; RCI — через `fetch_rci_json` из `services/router_diagnostics.py`.
- Запись файлов — только через `services/io/atomic.py` (`_atomic_write_json`); сторож `tests/test_atomic_write_single_source.py` должен оставаться зелёным.
- Новые файлы модуля обязаны содержать в пути `system_resources`, `resource_monitor` или `router_diagnostics` (по этим словам `scripts/generate_modular_panel_inventory.py` относит файл к `tool.advanced-diagnostics`).
- После `git add` новых файлов — `npm run inventory:refresh`, затем коммит (хук pre-commit сверяет описи).
- JS-файлы панели в CRLF: править через Edit или скрипт-файлом, не `sed -i` и не heredoc с обратными слэшами.
- Полный pytest — `npm run test:py`; перед e2e — `npm run frontend:build`.
- Коммиты: `git -c user.name="olmer2002" -c user.email="olmer2002@gmail.com" commit`, сообщение по-русски простым языком, без трейлеров. Не пушить без команды владельца.
- Пороги (только в Python, `services/system_resources_history/zones.py`): процессор 60/85 %, память без кэша 75/90 %, канал 70/90 % тарифа, очередь задач 0,7/1 × ядер, температура чипа 80/95 °C, Wi‑Fi 85/100 °C. Проблема — 3 мин подряд в красной, снятие — 2 мин вне её.
- Ярусы истории: свежий 15 с × 240, суточный 300 с × 288, недельный 1800 с × 336; замер раз в 5 с; RCI-данные раз в 30 с (связь, conntrack) и 60 с (Wi‑Fi, порты, zram, частота).
- Сохранение: `/tmp/xkeen-ui/resource-history.json` раз в 300 с; `<ui_state_dir>/resource-history.json` раз в 21600 с и при остановке.
- Производительность: окно в shadow DOM (`static/panel-operator.css` внутрь не проникает), графики на canvas, опрос только при открытом окне и видимой вкладке; кадр перерисовки ≤ 8 мс при замедлении процессора ×4.

## Review Focus

- **Часы роутера прыгают** (после перезагрузки NTP переводит время на часы вперёд или назад): не должно появиться «истории» на прыжок или отрицательных интервалов — прыжок вперёд даёт пробел, назад сбрасывает свежий ярус. Тест в Task 3.
- **Счётчики WAN сбрасываются или WAN меняется** (переподключение, переход на LTE): никаких отрицательных скоростей и пиков в тысячи процентов — точка на стыке пропускается. Тест в Task 6.
- **Сохранённый файл старый, битый, обрезанный или от другой модели** (другой набор показателей): панель стартует с пустой историей, файл не роняет сборщик. Тест в Task 4.
- **Тариф введён криво** (0, отрицательный, текст, 100000) или провайдер даёт больше тарифа: ввод отклоняется с понятной ошибкой; > 100 % — столбец красный, во всплывашке «105 % — выше тарифа». Тесты в Task 7 и Task 10.
- **Окно открыто на слабом телефоне или во фоновой вкладке:** нет опроса и перерисовок, пока вкладка скрыта; после возврата — одна догрузка истории, без очереди накопленных перерисовок. Тест в Task 12.

---

### Task 1: Разбор датчиков и памяти

**Files:**
- Create: `xkeen-ui/services/system_resources_history/__init__.py` (пустой)
- Create: `xkeen-ui/services/system_resources_history/sensors.py`
- Create: `tests/fixtures/system_resources_sensors/nc1812/` и `.../kn1811/` — файлы `meminfo`, `stat`, `swaps`, `zram0_disksize`, `zram0_mm_stat`, `thermal/zoneN_type|temp|trip_point_K_temp|trip_point_K_type`, `cpufreq_cur`, `cpufreq_max` (только kn1811) — из выгрузок `probe_sensors.sh` (scratchpad, `probe_out.txt`, `probe_10_1.txt`), без адресов и MAC
- Test: `tests/test_system_resources_sensors.py`

**Interfaces:**
- Produces (все функции принимают `reader: Callable[[Path], str]` и `lister: Callable[[Path], list[str]]` для подмены в тестах):
  - `@dataclass ThermalZone: type: str; temp_c: float; shutdown_c: float | None`
  - `read_thermal_zones(reader, lister) -> list[ThermalZone]` — `shutdown_c` = наибольший `trip_point` типа `critical`, иначе наибольший ненулевой.
  - `@dataclass TempGroup: id: str; label: str; kind: Literal["chip","wifi"]; value_c: float | None; sensors: list[tuple[str, float]]; shutdown_c: float | None`
  - `group_temperatures(zones: list[ThermalZone], wifi: dict[str, float | None]) -> list[TempGroup]` — группы и порядок: `cpu` «Процессор», `soc` «Чип целиком», `npu` «Сетевой ускоритель», `ports` «Порты и коммутатор», `wifi24` «Wi‑Fi 2,4 ГГц», `wifi5` «Wi‑Fi 5 ГГц»; сопоставление типов — таблица из спецификации; неизвестный тип — своя группа с `label = type`.
  - `memory_split(meminfo: str) -> dict` — `{"total_bytes","programs_bytes","cache_bytes","free_bytes","percent"}`, программы = Total−Available, кэш = Available−Free, свободно = Free, `percent` = программы / Total.
  - `procs_running(stat: str) -> int` — `procs_running − 1`, не меньше 0.
  - `per_core_busy(prev: dict, stat: str) -> tuple[dict, list[float]]` — проценты по ядрам.
  - `zram_state(swaps: str, reader) -> dict | None` — `{"size_bytes","used_bytes"}`, `None` если zram нет.
  - `cpu_frequency(reader) -> dict | None` — `{"current_mhz","max_mhz","throttled": current < max}`.

- [ ] **Step 1: Write the failing tests**

```python
def test_nc1812_groups():
    groups = group_temperatures(read_thermal_zones(*fixture("nc1812")), {"wifi24": 47, "wifi5": 53})
    assert [g.id for g in groups] == ["cpu", "soc", "npu", "ports", "wifi24", "wifi5"]
    assert len(next(g for g in groups if g.id == "ports").sensors) == 4
    assert next(g for g in groups if g.id == "cpu").shutdown_c == 125

def test_kn1811_single_zone_is_cpu_and_shutdown_from_active_trip():
    groups = group_temperatures(read_thermal_zones(*fixture("kn1811")), {"wifi24": 70, "wifi5": 63})
    assert [g.id for g in groups] == ["cpu", "wifi24", "wifi5"]
    assert groups[0].value_c == 61 and groups[0].shutdown_c == 125

def test_memory_split_sums_to_total():
    m = memory_split(read("kn1811/meminfo"))
    assert m["programs_bytes"] + m["cache_bytes"] + m["free_bytes"] == m["total_bytes"]
    assert round(m["percent"]) == 57

def test_procs_running_excludes_self(): assert procs_running("procs_running 1\n") == 0
def test_zram(): assert zram_state(read("nc1812/swaps"), reader("nc1812"))["size_bytes"] == 1073741824
def test_no_zram(): assert zram_state("Filename Type Size Used Priority\n", reader("kn1811")) is None
def test_throttle():
    files = {"scaling_cur_freq": "900000", "scaling_max_freq": "1350000"}
    f = cpu_frequency(lambda p: files[p.name])
    assert f == {"current_mhz": 900, "max_mhz": 1350, "throttled": True}

def test_no_cpufreq_on_nc1812(): assert cpu_frequency(reader("nc1812")) is None
```

- [ ] **Step 2: Run** `node scripts/run_python.mjs -m pytest tests/test_system_resources_sensors.py -q` — Expected: FAIL (`ModuleNotFoundError`).
- [ ] **Step 3: Implement** `sensors.py` по интерфейсам выше; чтение — через переданные `reader`/`lister`, по умолчанию `Path.read_text`/`os.listdir`, ошибки чтения датчика → датчик пропускается.
- [ ] **Step 4: Run** тот же pytest — Expected: PASS.
- [ ] **Step 5: Commit** («Разбор датчиков температуры, памяти и подкачки для новой диагностики»), перед коммитом `npm run inventory:refresh`.

---

### Task 2: Железо из прошивки: порты, Wi‑Fi, модель

**Files:**
- Create: `xkeen-ui/services/system_resources_history/hardware.py`
- Create: `tests/fixtures/system_resources_sensors/{nc1812,kn1811}/rci_show_interface.json`, `rci_show_version.json` — снять командой на роутере (только чтение, пароль спросить у владельца): `curl -s http://127.0.0.1:79/rci/show/interface` и `.../show/version` через `scratchpad/ssh_run.py`; вычистить MAC, адреса, серийные номера
- Test: `tests/test_system_resources_hardware.py`

**Interfaces:**
- Produces:
  - `@dataclass Port: id: str; label: str; is_wan: bool; link: bool; speed_mbps: int | None; duplex: str | None; description: str`
  - `parse_ports(show_interface: dict) -> list[Port]` — порты из записей `type == "Port"`; WAN — порт интерфейса с `defaultgw`/`security-level: public`; порядок: WAN, затем LAN по номеру.
  - `slow_ports(ports: list[Port]) -> list[Port]` — LAN с `speed_mbps == 100`, если среди портов есть 1000.
  - `wifi_temperatures(show_interface: dict) -> dict[str, float | None]` — `{"wifi24": WifiMaster0.temperature, "wifi5": WifiMaster1.temperature}`; выключенное радио → `None`.
  - `router_identity(show_version: dict) -> dict` — `{"model": description, "firmware": "KeeneticOS " + title}`.
  - `wan_interface(show_interface: dict) -> str | None` — имя WAN-интерфейса с `defaultgw: yes` в том виде, в каком оно стоит в `/proc/net/dev` (поле `interface-name`; на 45.1 это `ISP`). В фикстуры положить и `/proc/net/dev` с обоих роутеров; тест `test_wan_interface_matches_net_dev_name` проверяет, что имя есть среди строк `/proc/net/dev`.

- [ ] **Step 1: Write the failing tests** — `test_ports_nc1812`: 5 портов, первый WAN 1000 с описанием «МТС», порт «4» 100 Мбит/с; `test_slow_port_detected` → `["4"]`; `test_kn1811_six_ports_no_slow`; `test_wifi_temps` → `{"wifi24": 47, "wifi5": 53}`; `test_identity` → `"Netcraze Ultra (NC-1812)"`, `"KeeneticOS 5.1.8"`; `test_wan_interface_matches_net_dev_name`.
- [ ] **Step 2: Run** `node scripts/run_python.mjs -m pytest tests/test_system_resources_hardware.py -q` — Expected: FAIL.
- [ ] **Step 3: Implement** `hardware.py`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** («Порты, температура Wi‑Fi и модель роутера из прошивки»).

---

### Task 3: Ярусы истории

**Files:**
- Create: `xkeen-ui/services/system_resources_history/store.py`
- Test: `tests/test_system_resources_store.py`

**Interfaces:**
- Produces:
  - `TIERS = {"fresh": (15, 240), "day": (300, 288), "week": (1800, 336)}`
  - `class HistoryStore(metrics: tuple[str, ...])` — для каждой метрики и яруса два `array('f')` (среднее, пик) с NaN = «нет данных» и `array('l')` времени начала точки.
    - `add(ts: float, values: dict[str, float | None]) -> None` — копит замеры в текущей точке каждого яруса; при переходе границы точки закрывает её. Прыжок времени вперёд больше шага — промежуточные точки NaN; назад больше 60 с — сброс только свежего яруса.
    - `columns(range_id: Literal["15m","30m","1h","6h","24h","7d"], now: float) -> dict` — `{"step_s", "start", "metrics": {name: {"avg": [...], "max": [...]}}, "history_since": ts|None}`; NaN → `None`. Свёртка: 15m — fresh ×1 (60 точек), 30m — fresh ×2, 1h — fresh ×4, 6h — day ×1 (72), 24h — day ×3 (96 клеток), 7d — week ×1 (336). Среднее — по средним, пик — максимум пиков; клетка без данных — `None`.
    - `median(metric: str, tier: str = "week") -> float | None`
    - `to_dict() -> dict`, `@classmethod from_dict(data: dict, metrics) -> HistoryStore` (для Task 4).

- [ ] **Step 1: Write the failing tests** — `test_fresh_point_avg_and_max` (три замера 10/20/60 за 15 с → avg 30, max 60); `test_1h_has_60_columns_of_4_points`; `test_24h_96_cells`; `test_7d_336_cells`; `test_gap_is_none_not_zero` (нет замеров 10 мин → `None` в столбцах); `test_clock_jump_forward_makes_gap` (+3 ч → пробел, без интерполяции); `test_clock_jump_back_resets_only_fresh`; `test_ring_wraps_after_7_days`; `test_median_week`.
- [ ] **Step 2: Run** `node scripts/run_python.mjs -m pytest tests/test_system_resources_store.py -q` — Expected: FAIL.
- [ ] **Step 3: Implement** `store.py`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** («Хранение истории нагрузки за час, сутки и неделю»).

---

### Task 4: Сохранение и загрузка истории

**Files:**
- Create: `xkeen-ui/services/system_resources_history/persist.py`
- Test: `tests/test_system_resources_persist.py`

**Interfaces:**
- Consumes: `HistoryStore.to_dict/from_dict` (Task 3).
- Produces:
  - `FORMAT_VERSION = 1`
  - `save_history(path: str, store: HistoryStore, events: list[dict], *, now: float) -> None` — JSON `{"version", "saved_at", "metrics", "tiers", "store", "events"}` через `_atomic_write_json(..., indent=None)`; числа округлены до 0,1.
  - `load_history(paths: list[str], metrics: tuple[str, ...]) -> tuple[HistoryStore, list[dict], float] | None` — читает все копии, берёт с наибольшим `saved_at`; отбрасывает при чужой версии, другом наборе метрик или шагах ярусов, битом JSON; возвращает `saved_at` для пробела.

- [ ] **Step 1: Write the failing tests** — `test_roundtrip`; `test_picks_freshest_of_tmp_and_flash`; `test_version_mismatch_returns_none`; `test_metric_set_mismatch_returns_none` (файл с другого роутера); `test_truncated_json_returns_none`; `test_events_restored`; `test_uses_atomic_helper` (запись идёт через `services.io.atomic`, monkeypatch).
- [ ] **Step 2: Run** `node scripts/run_python.mjs -m pytest tests/test_system_resources_persist.py -q` — Expected: FAIL.
- [ ] **Step 3: Implement** `persist.py`.
- [ ] **Step 4: Run** — Expected: PASS; `node scripts/run_python.mjs -m pytest tests/test_atomic_write_single_source.py -q` — PASS.
- [ ] **Step 5: Commit** («История нагрузки сохраняется и переживает перезапуск панели и роутера»).

---

### Task 5: Зоны, правило проблем и события

**Files:**
- Create: `xkeen-ui/services/system_resources_history/zones.py`
- Create: `xkeen-ui/services/system_resources_history/problems.py`
- Test: `tests/test_system_resources_problems.py`

**Interfaces:**
- Produces:
  - `zone(metric: str, value: float | None, *, cores: int = 1, kind: str | None = None) -> int | None` — 0/1/2 по порогам из Global Constraints; метрики: `cpu`, `memory`, `link_up`, `link_down` (проценты тарифа; > 100 → 2), `queue` (абсолютное, сравнивается с `0.7*cores`/`cores`), `temp:<group_id>` (`kind` = `chip`|`wifi`).
  - `hotter_than_usual(value: float, median: float | None) -> int | None` — разница, если ≥ 15 °C, иначе `None`.
  - `class ProblemTracker(clock)`:
    - `update(ts: float, zones: dict[str, int | None], details: dict[str, str]) -> list[dict]` — новые события; красная ≥ 180 с подряд → событие начала; ≥ 120 с вне красной → событие конца с длительностью. Типы событий: `internet_lost`, `internet_restored`, `dns_failed`, `cpu_overload`, `memory_low`, `link_saturated`, `overheat`, `cpu_throttled` (сразу, без 3 мин), `port_slow`, `router_rebooted`.
    - `active() -> list[dict]` — текущие проблемы для строки состояния.
    - `events(since: float) -> list[dict]`; хранение 7 дней.
    - `note_start(uptime_s: float, persisted_uptime_s: float | None) -> None` — `router_rebooted`, если `uptime < 600` или аптайм меньше сохранённого.
  - Каждое событие: `{"id","type","at","until","severity","title","detail"}`; `title` по-русски («Процессор перегружен», «Память занята больше чем на 90 %», «Связь с интернетом потеряна», «Роутер перезагружен», «Порт 4 работает на 100 Мбит/с», «Процессор замедлился из-за нагрева»…).

- [ ] **Step 1: Write the failing tests** — `test_zone_thresholds_table` (параметризованный по всем строкам таблицы зон спецификации, включая границы 60/85, 75/90, 70/90, 80/95, 85/100 и `queue` при `cores=3`); `test_link_over_100_is_red`; `test_red_needs_3_minutes`; `test_short_spike_no_event`; `test_clear_needs_2_minutes_and_reports_duration`; `test_throttle_is_immediate`; `test_reboot_detected_by_uptime`; `test_events_kept_7_days`.
- [ ] **Step 2: Run** `node scripts/run_python.mjs -m pytest tests/test_system_resources_problems.py -q` — Expected: FAIL.
- [ ] **Step 3: Implement** `zones.py`, `problems.py`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** («Пороги зон и журнал проблем: три минуты в красной зоне — проблема»).

---

### Task 6: Фоновый сборщик

**Files:**
- Create: `xkeen-ui/services/system_resources_history/collector.py`
- Modify: `xkeen-ui/routes/__init__.py:460-470` — после регистрации блюпринта `system_resources` вызвать `start_collector(ui_state_dir=ctx.ui_state_dir)`
- Modify: `xkeen-ui/app_factory.py:957-966` — в `background_tasks` добавить `("diagnostics.resource_history", "tool.advanced-diagnostics")`
- Modify: `xkeen-ui/services/ui_settings.py` — раздел `diagnostics` (`tariff_up_mbps`, `tariff_down_mbps`: целые 1…10000 или `null`) в схеме по умолчанию, `_canonical_empty`, `_sanitize_full`, `_sanitize_patch`; функция `get_diagnostics_tariff(ui_state_dir) -> tuple[int | None, int | None]`; иное значение в патче → ошибка «Скорость тарифа — целое число от 1 до 10000 Мбит/с»
- Test: `tests/test_system_resources_collector.py`, `tests/test_ui_settings_diagnostics_tariff.py`

**Interfaces:**
- Consumes: Tasks 1–5; `cached_router_diagnostics()` (связь, DNS, conntrack, интерфейсы) из `services/router_diagnostics.py`; `fetch_rci_json` для `show/interface`, `show/version`; `get_diagnostics_tariff` (этот же таск).
- Produces:
  - `get_diagnostics_tariff(ui_state_dir: str) -> tuple[int | None, int | None]` — (отдача, приём).
  - `METRICS: tuple[str, ...]` — `cpu, memory, queue, link_up, link_down, rate_up, rate_down, online` + `temp:<id>` по найденным при первом опросе группам (набор фиксируется до перезапуска).
  - `class Collector(ui_state_dir, *, reader, clock, sleeper, rci, tmp_dir="/tmp/xkeen-ui")` с методами `tick() -> None` (один 5-секундный шаг; 30/60-секундные задачи по счётчику), `snapshot() -> dict` (последние значения, зоны, активные проблемы, железо), `history(range_id) -> dict` (столбцы + зоны столбцов, посчитанные `zone()`), `hardware() -> dict`, `events(since) -> list`, `save(kind: Literal["tmp","flash"])`.
  - `start_collector(*, ui_state_dir: str) -> Collector` (поток `xkeen-resource-history`, daemon, идемпотентно), `get_collector() -> Collector | None`, `stop_collector() -> None` (сохраняет во флеш; регистрируется в `atexit`).
  - Скорость WAN: разница счётчиков WAN-интерфейса; отрицательная разница или смена интерфейса → точка `None`. `link_up/down` = скорость / тариф × 100, без тарифа — `None`.

- [ ] **Step 1: Write the failing tests** — `test_tariff_valid_saved`, `test_tariff_rejects_zero_negative_text_huge` (в `test_ui_settings_diagnostics_tariff.py`); на подменных `reader`/`clock`/`rci`: `test_tick_records_all_metrics`; `test_counter_reset_skips_point` (счётчик уменьшился → `None`, без отрицательной скорости); `test_wan_change_skips_point`; `test_rci_every_60s_not_every_tick` (счётчик вызовов `rci`); `test_saves_tmp_every_300s_and_flash_every_21600s`; `test_restores_and_marks_gap_on_start`; `test_no_tariff_link_none`; `test_start_twice_one_thread`.
- [ ] **Step 2: Run** `node scripts/run_python.mjs -m pytest tests/test_system_resources_collector.py -q` — Expected: FAIL.
- [ ] **Step 3: Implement** `collector.py` и подключение; цикл по образцу `services/memory_guard.py` (`_run`, остановка по событию).
- [ ] **Step 4: Run** — Expected: PASS; затем `npm run test:py` — Expected: всё зелёное, кроме известных падений из заметки `project_local_test_failures`.
- [ ] **Step 5: Commit** («Фоновый сборщик истории нагрузки для диагностики роутера»), с `npm run inventory:refresh`.

---

### Task 7: API и тариф

**Files:**
- Modify: `xkeen-ui/routes/system_resources.py` — новые маршруты
- Modify: `xkeen-ui/routes/devtools.py:90-120` — в ответ `/api/system/resources` (монитор в шапке) добавить `link: {"up_percent","down_percent"}` из `get_collector().snapshot()`, если сборщик запущен и тариф задан
- Modify: `xkeen-ui/services/system_resources.py:61-91` — `_memory` дополняется полями из `memory_split`; `sample_system_resources` — `cpu.queue` из `procs_running`
- Modify: `xkeen-ui/services/router_diagnostics.py:1127-1175` — `apply_router_resource_telemetry` больше не подменяет `memory` цифрой прошивки, если есть данные `/proc/meminfo`
- Test: `tests/test_system_resources_api.py`, правки `tests/test_system_resources.py`, `tests/test_router_diagnostics.py`

**Interfaces:**
- Produces:
  - `GET /api/system/history?range=15m|30m|1h|6h|24h|7d` → `{"ok", "range", "step_s", "start", "history_since", "metrics": {name: {"avg": [...], "max": [...], "zone": [...], "peak_zone": [...]}}, "tariff": {"up_mbps","down_mbps"}|null}`; неверный `range` → 400 `code="bad_range"`; сборщик не запущен → 503 `code="history_unavailable"`.
  - `GET /api/system/hardware` → `{"ok", "identity", "cores", "temperatures": [TempGroup + "zone" + "hotter_by"], "throttle": {...}|null, "memory": memory_split, "zram": ...|null, "storage": ..., "conntrack": ..., "ports": [...], "slow_ports": [...]}`.
  - `GET /api/system/events?since=<ts>` → `{"ok", "events": [...], "active": [...]}`.
  - `GET /api/system/summary` → `snapshot()` сборщика: `{"status": {"tone","problems":[...]}, "identity", "uptime_s", "cards": {cpu, memory, internet, link} c значением, зоной, строкой пояснения и индикатором за 30 мин (40 столбцов по 45 с из свежего яруса ×3), "router": последний cached_router_diagnostics() (цепочка связи, адрес, интерфейс, авторизация), "rci_available": bool}`.

- [ ] **Step 1: Write the failing tests** — `test_history_ranges_shapes` (длины 60/60/60/72/96/336); `test_history_bad_range_400`; `test_history_zone_fields`; `test_hardware_payload_from_fixtures`; `test_events_since`; `test_summary_has_router_chain_and_rci_flag`; `test_resources_has_link_percent_when_tariff`; `test_memory_not_overridden_by_firmware_when_procfs_present`; `test_queue_from_procs_running`.
- [ ] **Step 2: Run** `node scripts/run_python.mjs -m pytest tests/test_system_resources_api.py -q` — Expected: FAIL.
- [ ] **Step 3: Implement** маршруты (заголовок `Cache-Control: no-store` как у существующих).
- [ ] **Step 4: Run** те же тесты и `tests/test_system_resources.py tests/test_router_diagnostics.py` — Expected: PASS.
- [ ] **Step 5: Commit** («Адреса истории, железа и событий для диагностики роутера»).

---

### Task 8: Рисование на canvas

**Files:**
- Create: `xkeen-ui/static/js/features/resource_monitor/canvas_charts.js`
- Test: `e2e/resource_monitor_charts.spec.mjs` (импорт модуля на странице панели и проверка пикселей)

**Interfaces:**
- Consumes: формат столбцов из `GET /api/system/history` (Task 7): массивы `avg`, `max`, `zone`, `peak_zone`, `None` = нет данных.
- Produces (все функции рисуют в переданный `<canvas>`, учитывают `devicePixelRatio`, цвета берут из `getComputedStyle(host)` переменных `--op-success`, `--op-warning`, `--op-danger`, `--op-surface-3`, `--op-muted`):
  - `drawLevelChart(canvas, series, { segments: 20, scaleMax, axisLabels, hoverIndex }) -> { columnAt(x): number }` — сегменты по среднему, чёрточка пика цвета `peak_zone`, погасшие сегменты бледным цветом своей зоны, `None` — контуры.
  - `drawMirrorChart(canvas, up, down, { segmentsPerSide: 10, percent: boolean, neutral: boolean })` — отдача вверх, приём вниз.
  - `drawMiniIndicator(canvas, series, { segments: 7, wholeColumn: true })`, `drawMiniMirror(canvas, up, down, { segmentsPerSide: 4 })`, `drawAvailabilityStrip(canvas, cells)` (0 — в сети, 2 — сбой, `null` — серая).
  - `drawCellGrid(canvas, rows: { label, cells: (zone|null)[], peakDots: boolean[] }[], { columns }) -> { cellAt(x, y) }` — для «24 ч» (96) и «7 д» (строки-дни, 48).
  - `redrawColumn(handle, index, column)` — перерисовка одного столбца без очистки остального.

- [ ] **Step 1: Write the failing test** — e2e: на `/` загрузить модуль через `page.evaluate(import(...))`, нарисовать `drawLevelChart` по 3 столбцам (`zone` 0/1/2) и проверить цвет пикселя в центре нижнего сегмента каждого столбца (зелёный/оранжевый/красный), пиксель погасшего сегмента бледнее; `columnAt` возвращает 1 для центра второго столбца; `drawMirrorChart` — пиксель над линией окрашен по отдаче, под линией по приёму; `drawCellGrid().cellAt` для 96 клеток.
- [ ] **Step 2: Run** `npm run frontend:build && npx playwright test e2e/resource_monitor_charts.spec.mjs --workers=1` — Expected: FAIL.
- [ ] **Step 3: Implement** `canvas_charts.js`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** («Графики-индикаторы диагностики рисуются на canvas»).

---

### Task 9: Окно в shadow DOM: шапка, строка состояния, карточки, подключение, железо

**Files:**
- Create: `xkeen-ui/static/js/features/resource_monitor/view_css.js` (`export const VIEW_CSS`, по образцу `static/js/features/xray_log_view.js:38-132`, `adoptedStyleSheets` с запасным `<style>`)
- Create: `xkeen-ui/static/js/features/resource_monitor/view.js`
- Modify: `xkeen-ui/templates/panel/modals/diagnostics.html` — модальное окно с шапкой (заголовок, «Обновлено N с назад», «Обновить», «⋯» со «Снимок JSON», закрыть) и пустым хостом `<div id="xk-resource-dashboard-view">`; убрать интервалы и список частоты
- Test: `e2e/router_resource_dashboard.spec.mjs` (переписать; ответы API подменять `page.route`, данные — из фикстур Task 1–2, переведённых в JSON)

**Interfaces:**
- Consumes: ответы `/api/system/summary`, `/api/system/hardware` (Task 7); `canvas_charts.js` (Task 8).
- Produces:
  - `mountDashboardView(host: HTMLElement) -> View`, где `View` имеет `renderSummary(summary)`, `renderHardware(hw)`, `renderConnection(router)`, `onCardClick(cb: (metric) => void)`, `onLinkClick(cb)`, `chartHost`, `toolsHost`.
  - Раскладка по спецификации: карточки одной высоты, одна строка пояснений, индикатор прижат к низу (34 px); промежутки = отступ раздела 14 px; железо — три раздела, сетка температур `ceil(n/2)` колонок при n > 3, память 2×2 при n ≤ 3 или 0, порты — `repeat(n, 1fr)`; телефон (< 760 px) — разделы столбиком, температура по 2, порты по 3.
  - Нижние разделы (график, вкладки) получают `content-visibility: auto`.

- [ ] **Step 1: Write the failing tests** — `dashboard renders cards with aligned indicators` (у четырёх карточек `getBoundingClientRect().bottom` индикаторов совпадают ±1 px); `hardware layout NC-1812` (6 плиток, 2 строки по 3, порты: промежуток между гнёздами = отступу от края ±1 px); `hardware layout KN-1811` (3 плитки, память 2×2, нижние края трёх разделов ±2 px); `no sensors hides temperature section`; `problem state` (строка состояния «Есть проблемы: 2», метка памяти «критично» при 94 %, подпись «выше 90 % уже 6 мин»); `rci unavailable` (`rci_available: false` → строка состояния «Часть данных недоступна», карточки процессора и памяти показывают значения); `hotter than usual` (`hotter_by: 18` → в плитке «на 18 °C горячее обычного — проверьте, не закрыт ли роутер», зона плитки не меняется); `throttled` (`throttle.throttled` → плитка «Процессор» красная и в строке состояния «процессор замедлился из-за нагрева: 900 из 1350 МГц»); `no horizontal scroll at 1600/1024/390`; `panel-operator.css does not style inside shadow root` (вычисленный стиль внутреннего элемента не меняется при добавлении в документ правила `body.panel-page .xkm-card{color:red}`).
- [ ] **Step 2: Run** `npm run frontend:build && npx playwright test e2e/router_resource_dashboard.spec.mjs --workers=1` — Expected: FAIL.
- [ ] **Step 3: Implement** `view_css.js`, `view.js`, шаблон.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** («Новое окно диагностики: карточки, подключение и железо»), с `npm run inventory:refresh`.

---

### Task 10: График, интервалы, тариф и управление окном

**Files:**
- Create: `xkeen-ui/static/js/features/resource_monitor/dashboard.js`
- Create: `xkeen-ui/static/js/features/resource_monitor/tariff_form.js`
- Modify: `xkeen-ui/static/js/features/resource_monitor.js` — оставить точку входа `initResourceMonitor` и экспорт `resourceMonitorApi` (их импортирует `static/js/pages/panel.diagnostics.bundle.js`), тело заменить делегированием в `dashboard.js`; старую историю в браузере, `selectHistory`, опрос и canvas-графики удалить
- Modify: `xkeen-ui/static/js/features/resource_monitor_model.js` — удалить неиспользуемое (`selectHistory`, `historyGaps`, `gapAtTime`, `collectionGap`), оставить `buildResourceSnapshot` (снимок JSON, без IP и клиентов)
- Test: `e2e/router_resource_dashboard.spec.mjs` (дополнить)

**Interfaces:**
- Consumes: Tasks 7–9.
- Produces: `openDashboard()`, `closeDashboard()`; состояние `{ metric: "cpu"|"memory"|"net"|"queue"|"all", range: "15m"|"30m"|"1h"|"6h"|"24h"|"7d" }`.
  - При открытии: `/api/system/summary`, `/api/system/hardware`, `/api/system/history?range=1h` параллельно; затем раз в 5 с `summary` и, если закрылся столбец, `history` того же интервала и `redrawColumn` только последнего столбца.
  - Скрытая вкладка (`visibilitychange`) или закрытое окно — таймеры остановлены; возврат — один запрос истории.
  - «24 ч» — сетка по показателям, вкладки показателей скрыты; «7 д» — строки-дни, вкладки + «Все». Клик по клетке «24 ч» → «6 ч» с подсветкой (последний час → «1 ч»); клик по клетке последних суток в «7 д» → «24 ч».
  - Сеть: при тарифе — проценты и зоны, всплывашка «↓ Приём 54 % · 53,7 Мбит/с», > 100 % — «105 % — выше тарифа»; без тарифа — Мбит/с, нейтральный цвет, ссылка «указать скорость тарифа».
  - Форма тарифа: два поля (отдача, приём), подсказка «за сутки приём доходил до N Мбит/с, отдача до M — проверьте, верно ли указан тариф» (пики из `7d`/`24h`), сохранение патчем ui_settings, ошибка сервера — под полем.
  - Всплывашка по наведению и по касанию; строка итогов «Сейчас · В среднем · Пик в HH:MM · В оранжевой зоне N мин · В красной N мин» (ноль — нейтральным).

- [ ] **Step 1: Write the failing tests** — `range buttons change column count` (60/60/60/72 столбцов по `columnAt`, «24 ч» показывает сетку из 96 клеток, «7 д» — 7 строк); `card click switches chart metric`; `net chart percent and over-tariff tooltip`; `no tariff shows Mbit and link`; `tariff form rejects text and saves numbers`; `hidden tab stops polling` (через `page.clock` и `document.visibilityState` подмену: за 60 с без видимости 0 запросов, после возврата ровно 1 запрос истории); `only last column redrawn on tick` (шпион на `clearRect` ширины одного столбца).
- [ ] **Step 2: Run** `npm run frontend:build && npx playwright test e2e/router_resource_dashboard.spec.mjs --workers=1` — Expected: FAIL.
- [ ] **Step 3: Implement** `dashboard.js`, `tariff_form.js`, правки точки входа.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** («Графики за час, сутки и неделю, загрузка канала и тариф в окне диагностики»).

---

### Task 11: Вкладки инструментов

**Files:**
- Create: `xkeen-ui/static/js/features/resource_monitor/tools.js`
- Create: `xkeen-ui/static/js/features/resource_monitor/virtual_rows.js` (оконный рендер строк фиксированной высоты, по образцу виртуальной таблицы `static/js/features/xray_log_view.js`)
- Modify: `xkeen-ui/static/js/features/resource_monitor.js` — перенос загрузчиков `loadClients`, `runChannelCheck`, `loadLte`, `loadProcesses`, интерфейсов и событий в `tools.js` (API те же: `/api/system/router/clients`, `/channel-check`, `/lte`, `/api/system/processes`, `/api/system/events`)
- Modify: `e2e/router_modem_controls.spec.mjs` — под новую разметку вкладки «Модемы»
- Test: `e2e/router_resource_dashboard.spec.mjs` (дополнить)

**Interfaces:**
- Consumes: `View.toolsHost` (Task 9).
- Produces: `mountTools(host, api) -> { show(tab: "devices"|"ping"|"ifaces"|"procs"|"modems"|"events") }`; данные грузятся при первом показе вкладки; содержимое на всю ширину по макету: «Проверка связи» — строка формы, 4 плитки равной ширины, маршрут шкалой узлов с названием самого медленного участка; «Модемы» — карточка на модем с плитками частот агрегации (`carriers`), сведения в 4 колонки, IMEI замаскирован, без модемов вкладка скрыта; «События» — фильтр «Все / Только проблемы», счётчик на вкладке; «Устройства» — 5 самых активных, «Показать все» включает виртуальный список при > 50 устройств.

- [ ] **Step 1: Write the failing tests** — `tabs load lazily` (до нажатия нет запросов к clients/channel/lte/processes); `modems render carriers` (3 плитки частот, метка «агрегация 3 частот · 50 МГц»); `modems tab hidden without modems`; `ping layout full width` (правый край плитки вердикта = правому краю области −14 px ±1); `events filter and counter`; `500 devices virtualized` (в DOM ≤ 60 строк, прокрутка до конца показывает последнее устройство).
- [ ] **Step 2: Run** `npm run frontend:build && npx playwright test e2e/router_resource_dashboard.spec.mjs e2e/router_modem_controls.spec.mjs --workers=1` — Expected: FAIL.
- [ ] **Step 3: Implement** `tools.js`, `virtual_rows.js`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** («Вкладки инструментов диагностики на всю ширину, модемы с агрегацией частот»).

---

### Task 12: Уборка старого, производительность, описи

**Files:**
- Modify: `xkeen-ui/static/panel-operator.css:22531-23100` (блок `.xk-resource-dashboard-*`, `.xk-dashboard-*`, `.xk-resource-chart-*`, `.xk-internet-*`, `.xk-conntrack-*`, `.xk-stage2-*`, `.xk-channel-*`, `.xk-lte-*`, `.xk-interface-*`, `.xk-process-*`) — удалить; стили монитора в шапке (`.xk-resource-monitor*`) оставить
- Create: `e2e/resource_monitor_perf.spec.mjs` (метка `@perf`, в обычный прогон не входит)
- Test: весь e2e и pytest

**Interfaces:** нет новых.

- [ ] **Step 1: Write the perf test** — CDP `Emulation.setCPUThrottlingRate {rate: 4}`; открыть окно с историей 7 дней (подменный ответ на 14 метрик); замерить `performance.now()` от клика до первого кадра с графиком (≤ 150 мс) и длительность 20 тиков перерисовки по 5 с (`page.clock`) — каждый ≤ 8 мс; в скрытой вкладке за 5 минут 0 вызовов `requestAnimationFrame` из окна.
- [ ] **Step 2: Run** `npm run frontend:build && npx playwright test e2e/resource_monitor_perf.spec.mjs --workers=1 --trace off` — Expected: PASS (если нет — профилировать и чинить до прохождения).
- [ ] **Step 3: Remove** старые стили; `grep -n "xk-resource-chart\|xk-dashboard-tile\|xk-conntrack" xkeen-ui/static xkeen-ui/templates -r` (без `frontend-build`) — Expected: пусто.
- [ ] **Step 4: Run** `npm run inventory:refresh`, `npm run frontend:build`, `npm run test:py`, полный e2e параллельно (как в заметке `project_e2e_parallel_research`) — Expected: pytest зелёный, e2e 0 failed (12 skipped как ориентир из `project_e2e_spec_sync`).
- [ ] **Step 5: Commit** («Убраны стили старого окна диагностики, замер скорости отрисовки»).

---

### Task 13: Приёмка на роутерах (вручную, с владельцем)

**Files:** нет.

- [ ] **Step 1:** Перед установкой сверить чужие коммиты: `git log <версия на роутере>..HEAD` (заметка `feedback_check_foreign_commits_before_router_install`), собрать архив по команде владельца, поставить на 45.1 и 10.1.
- [ ] **Step 2:** Через сутки: «24 ч» заполнен, числа карточек совпадают с `/proc` (`probe_sensors.sh`) и веб-интерфейсом роутера; на KN-1811 очередь задач около 0, а не 1; температуры по группам как в макете.
- [ ] **Step 3:** Обновить панель из панели и перезагрузить 10.1 — история на месте, на время простоя пробел, в событиях «Роутер перезагружен».
- [ ] **Step 4:** Прогрев (когда владелец сможет): полчаса скачивания или видео через прокси с устройства по Wi‑Fi; по графику температуры решить, оставлять ли пороги 80/95 и 85/100.
- [ ] **Step 5:** Записать итог приёмки в заметку `project_router_diagnostics_redesign`; агрегацию частот проверить, когда включат модем на 20.1.
