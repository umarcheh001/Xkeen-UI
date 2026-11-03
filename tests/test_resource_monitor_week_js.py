"""Окно диагностики, вкладка «7 дней»: подсказки ячеек, подписи дней и итог недели (03.11.2026).

Неделя собрана руками: история ведётся с субботы 31.10 01:56 (как на 10.1 после очистки),
до неё ячейки пустые.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
MODULE = "./xkeen-ui/static/js/features/resource_monitor/chart_data.js"

STEP = 1800
COUNT = 336
# Tue 03.11.2026 20:00 MSK: the newest column ends here.
END = 1793725200 + 3600
START = END - COUNT * STEP
SINCE = 1793400960  # Sat 31.10.2026 01:56 MSK


def run_js(body: str, data) -> object:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not available in this environment")
    script = f"""
    import * as chart from '{MODULE}';
    const data = {json.dumps(data, ensure_ascii=False)};
    const out = (() => {{ {body} }})();
    console.log(JSON.stringify(out));
    """
    env = dict(os.environ, TZ="Europe/Moscow")
    result = subprocess.run(
        [node, "--input-type=module", "-e", script],
        cwd=ROOT,
        check=True,
        capture_output=True,
        encoding="utf-8",
        env=env,
    )
    return json.loads(result.stdout)


def week(zones: dict[str, dict[int, int]] | None = None, peaks: set[int] | None = None) -> dict:
    """A week of history: every metric at zone 0 since SINCE, unless ``zones`` says otherwise."""
    zones = zones or {}
    peaks = peaks or set()
    first = (SINCE - START) // STEP + 1

    def metric(name: str) -> dict:
        zone = [None if i < first else zones.get(name, {}).get(i, 0) for i in range(COUNT)]
        peak = [None if z is None else (2 if (name == "cpu" and i in peaks) else z) for i, z in enumerate(zone)]
        avg = [None if z is None else 10 for z in zone]
        return {"avg": avg, "max": avg, "zone": zone, "peak_zone": peak}

    return {
        "step_s": STEP,
        "start": START,
        "history_since": SINCE,
        "metrics": {name: metric(name) for name in ("cpu", "memory", "queue", "link_down:ISP")},
        "links": [{"id": "ISP", "label": "МТС"}],
        "top": [],
    }


def column_of(ts: int) -> int:
    return (ts - START) // STEP


CELL = """
const model = chart.grid7Model(data.history, data.metric || 'all', null);
return data.cells.map(([row, column]) => chart.grid7CellTip(model, data.history, row, column).title);
"""

TIP = """
const model = chart.grid7Model(data.history, data.metric || 'all', null);
return data.cells.map(([row, column]) => chart.grid7CellTip(model, data.history, row, column));
"""

LEVELS = """
const model = chart.grid7Model(data.history, data.metric || 'all', null);
return data.cells.map(([row, column]) => model.rows[row].levels[column]);
"""

BANDS = {
    "cpu": {"orange": 60, "red": 85},
    "memory": {"orange": 75, "red": 90},
    "link": {"orange": 70, "red": 90},
    "queue": {"orange": 2.1, "red": 3, "scale_max": 6},
}
CALM = {"cpu": (12, 30), "memory": (50, 52), "queue": (0.6, 1.1), "link_down:ISP": (5, 9), "link_up:ISP": (2, 3)}


def measured(values: dict[str, dict[int, tuple[float, float]]] | None = None) -> dict:
    """A week with real averages and peaks: calm since SINCE, ``values[name][i] = (avg, max)``."""
    values = values or {}
    first = (SINCE - START) // STEP + 1

    def zone(name: str, value: float) -> int:
        band = BANDS["link" if name.startswith("link_") else name]
        return 2 if value >= band["red"] else 1 if value >= band["orange"] else 0

    def metric(name: str) -> dict:
        pairs = [None if i < first else values.get(name, {}).get(i, CALM[name]) for i in range(COUNT)]
        avg = [None if p is None else p[0] for p in pairs]
        peak = [None if p is None else p[1] for p in pairs]
        return {
            "avg": avg,
            "max": peak,
            "zone": [None if v is None else zone(name, v) for v in avg],
            "peak_zone": [None if v is None else zone(name, v) for v in peak],
        }

    return {
        "step_s": STEP,
        "start": START,
        "history_since": SINCE,
        "cores": 3,
        "bands": BANDS,
        "metrics": {name: metric(name) for name in CALM},
        "links": [{"id": "ISP", "label": "МТС"}],
        "top": [],
    }


MON_10 = 1793602800  # Mon 02.11 10:00 MSK: row 1 (yesterday), column 20


def test_a_cell_is_painted_by_a_smooth_level_of_its_worst_average():
    at = column_of(MON_10)
    hist = measured({"cpu": {at: (45, 60), at + 1: (72.5, 80), at + 2: (90, 95)}, "memory": {at + 3: (60, 61)}})
    out = run_js(LEVELS, {"history": hist, "cells": [[1, 20], [1, 21], [1, 22], [1, 23], [1, 24]]})
    # 45 % of a processor whose «высокая» starts at 60 % is three quarters of the way;
    # a calm cell is as warm as its warmest metric (memory 50 of 75 %).
    assert out == [0.75, 1.5, 2, 0.8, 0.667]


def test_the_week_has_no_peak_dots_and_no_peak_counter():
    at = column_of(MON_10)
    hist = measured({"queue": {i: (1.2, 3.4) for i in range(at - 40, at + 40)}})
    body = """
    const model = chart.grid7Model(data.history, 'all', null);
    return { dots: model.rows.some((r) => (r.peakDots || []).some(Boolean)), summary: chart.grid7Summary(model, data.history) };
    """
    out = run_js(body, {"history": hist})
    assert out["dots"] is False
    assert "peaks" not in out["summary"]
    assert out["summary"]["heavy"] is None


def test_the_hint_of_a_calm_cell_gives_every_metric_with_its_peak():
    out = run_js(TIP, {"history": measured(), "cells": [[1, 20]]})[0]
    assert out["title"] == "Всё в норме"
    assert out["tone"] == 0
    lines = {line["label"]: line for line in out["lines"]}
    # From the metric nearest to its threshold to the calmest one.
    assert list(lines) == ["Память", "Очередь задач", "Процессор", "Канал ↓ / ↑"]
    assert lines["Процессор"]["value"] == "12 %"
    assert lines["Процессор"]["peak"] == "пик 30 %"
    assert lines["Очередь задач"]["value"] == "0,6"
    assert lines["Канал ↓ / ↑"]["value"] == "5 % / 2 %"
    assert not any(line.get("strong") for line in out["lines"])


def test_a_warm_cell_names_the_metric_close_to_high_and_puts_it_first():
    at = column_of(MON_10)
    hist = measured({"memory": {at: (68, 71)}, "queue": {at: (1.4, 3.1)}})
    out = run_js(TIP, {"history": hist, "cells": [[1, 20]]})[0]
    assert out["title"] == "Близко к высокой: память"
    assert out["tone"] == 1
    first = out["lines"][0]
    assert (first["label"], first["value"], first.get("strong")) == ("Память", "68 %", True)
    queue = next(line for line in out["lines"] if line["label"] == "Очередь задач")
    # A peak above the red threshold is told in the hint, not by a dot on the grid.
    assert (queue["value"], queue["peak"], queue["peakTone"]) == ("1,4", "пик 3,1", 2)


def test_a_single_metric_gives_its_values_and_the_threshold_it_is_measured_by():
    at = column_of(MON_10)
    hist = measured({"queue": {at: (1.4, 3.1), at + 1: (2.4, 3.3)}})
    out = run_js(TIP, {"history": hist, "metric": "queue", "cells": [[1, 20], [1, 21]]})
    assert out[0]["title"] is None
    assert out[0]["lines"][0] == {"label": "Очередь задач", "value": "1,4", "peak": "пик 3,1", "peakTone": 2}
    assert out[0]["lines"][1] == {"label": "Норма", "value": "высокая — от 2,1 на 3 ядра", "muted": True}
    assert out[1]["lines"][1] == {"label": "Высокая", "value": "перегрузка — от 3 на 3 ядра", "muted": True}


def test_a_cell_in_the_norm_says_so_without_a_worst_metric():
    # Monday 02.11 10:00 is row 1 (yesterday), column 20.
    out = run_js(CELL, {"history": week(), "cells": [[1, 20]]})
    assert out == ["Всё в норме"]


def test_a_loaded_cell_names_every_metric_of_its_zone():
    at = column_of(1793602800)  # Mon 02.11 10:00 MSK
    hist = week({"cpu": {at: 1}, "link_down:ISP": {at: 1}, "memory": {at + 1: 2}})
    out = run_js(CELL, {"history": hist, "cells": [[1, 20], [1, 21]]})
    assert out == ["Высокая нагрузка: процессор, канал", "Перегрузка: память"]


def test_an_empty_cell_before_the_history_tells_when_it_began():
    # Saturday 31.10 (row 3): 00:00 is before the history, later cells are inside it.
    hist = week()
    gap = column_of(1793602800)
    hist["metrics"] = {name: {**m, "zone": [None if i == gap else z for i, z in enumerate(m["zone"])]} for name, m in hist["metrics"].items()}
    out = run_js(CELL, {"history": hist, "cells": [[3, 0], [1, 20]]})
    assert out == ["История ведётся с 31.10 01:56", "нет данных"]


def test_days_before_the_history_are_named_without_a_suffix():
    out = run_js("return chart.grid7Model(data.history, 'all', null).rows.map((r) => r.label);", {"history": week()})
    assert out[:4] == ["Сегодня", "Вчера", "вс, 01.11", "сб, 31.10"]
    # Before the history: just the day, the cells and their hint tell the rest.
    assert out[4:] == ["пт, 30.10", "чт, 29.10", "ср, 28.10"]


def test_a_day_without_data_inside_the_history_keeps_its_suffix():
    hist = week()
    lo, hi = column_of(1793480400), column_of(1793480400 + 86400)  # Sun 01.11 00:00 .. 24:00 MSK
    hist["metrics"] = {name: {**m, "zone": [None if lo <= i < hi else z for i, z in enumerate(m["zone"])]} for name, m in hist["metrics"].items()}
    out = run_js("return chart.grid7Model(data.history, 'all', null).rows.map((r) => r.label);", {"history": hist})
    assert out[2] == "вс, 01.11 · нет данных"


SUMMARY = """
const model = chart.grid7Model(data.history, 'all', null);
return chart.grid7Summary(model, data.history);
"""


def test_the_heaviest_hour_is_the_one_with_the_worst_zone():
    at = column_of(1793602800)
    out = run_js(SUMMARY, {"history": week({"cpu": {at: 1}}, peaks={at + 5})})
    assert out["heavy"] == "пн, 02.11, 10:00–10:30"


def test_the_start_of_the_history_names_its_day_when_it_is_not_today():
    body = ("const today = { ...data.history, history_since: data.today };"
            "return [chart.historySinceText(data.history, data.now), chart.historySinceText(today, data.now)];")
    out = run_js(body, {"history": {"start": START, "step_s": STEP, "history_since": SINCE}, "today": 1793687760, "now": END})
    assert out == ["история с 31.10 01:56", "история с 09:36"]
