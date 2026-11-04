"""Окно диагностики, сетка «24 ч»: плавный цвет по средней, подсказки и итог суток (04.11.2026).

Сутки собраны руками: 96 четвертей часа, всё спокойно, кроме того, что задаёт тест.
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

STEP = 900
COUNT = 96
END = 1793725200  # Tue 03.11.2026 20:00 MSK: the newest column ends here.
START = END - COUNT * STEP

BANDS = {
    "cpu": {"orange": 60, "red": 85},
    "memory": {"orange": 75, "red": 90},
    "link": {"orange": 70, "red": 90},
    "queue": {"orange": 2.1, "red": 3, "scale_max": 6},
}
TEMP_BANDS = (80, 95)
CALM = {
    "cpu": (12, 30),
    "memory": (50, 52),
    "queue": (0.6, 1.1),
    "link_down:ISP": (5, 9),
    "link_up:ISP": (2, 3),
    "temp:cpu": (55, 56),
    "online": (1, 1),
}
# Rows of the grid in their order.
CPU, MEMORY, LINK, QUEUE, ONLINE, TEMP = range(6)


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


def zone(name: str, value: float) -> int:
    if name == "online":
        return 0 if value >= 1 else 2
    if name.startswith("temp:"):
        orange, red = TEMP_BANDS
    else:
        band = BANDS["link" if name.startswith("link_") else name]
        orange, red = band["orange"], band["red"]
    return 2 if value >= red else 1 if value >= orange else 0


def day(values: dict[str, dict[int, tuple[float, float]]] | None = None) -> dict:
    """A day of history: calm everywhere, ``values[name][i] = (avg, max)`` where a test says so."""
    values = values or {}

    def metric(name: str) -> dict:
        pairs = [values.get(name, {}).get(i, CALM[name]) for i in range(COUNT)]
        avg = [p[0] for p in pairs]
        peak = [p[1] for p in pairs]
        return {
            "avg": avg,
            "max": peak,
            "zone": [zone(name, v) for v in avg],
            "peak_zone": [0 if name == "online" else zone(name, v) for v in peak],
        }

    return {
        "range": "24h",
        "step_s": STEP,
        "start": START,
        "history_since": START,
        "cores": 3,
        "bands": BANDS,
        "metrics": {name: metric(name) for name in CALM},
        "links": [{"id": "ISP", "label": "МТС", "tariff": {"up_mbps": 50, "down_mbps": 100}}],
        "top": [],
    }


LEVELS = """
const model = chart.grid24Model(data.history);
return data.cells.map(([row, column]) => model.rows[row].levels[column]);
"""

TIP = """
const model = chart.grid24Model(data.history);
return data.columns.map((column) => chart.grid24CellTip(model, column));
"""

SUMMARY = """
const model = chart.grid24Model(data.history);
return chart.grid24Summary(model, data.history);
"""


def test_the_rows_are_in_the_expected_order():
    out = run_js("return chart.grid24Model(data.history).rows.map((r) => r.key);", {"history": day()})
    assert out == ["cpu", "memory", "link:ISP", "queue", "online", "temp"]


def test_a_cell_is_painted_by_a_smooth_level_of_its_average():
    hist = day({
        "cpu": {10: (45, 60), 11: (72.5, 80), 12: (90, 95)},
        "queue": {13: (1.8, 3.4)},
        "link_down:ISP": {14: (63, 70)},
    })
    cells = [[CPU, 10], [CPU, 11], [CPU, 12], [QUEUE, 13], [LINK, 14]]
    out = run_js(LEVELS, {"history": hist, "cells": cells})
    # 45 of 60 % is three quarters of the way to «высокая»; 72,5 is half way to «перегрузка»;
    # both directions of a link make one row, the warmer wins (63 of 70 %).
    assert out == [0.75, 1.5, 2, 0.857, 0.9]


def test_internet_and_temperature_keep_the_zone_colours():
    hist = day({"online": {20: (0.6, 1)}, "temp:cpu": {21: (85, 86)}})
    out = run_js(LEVELS, {"history": hist, "cells": [[ONLINE, 20], [ONLINE, 22], [TEMP, 21], [TEMP, 22]]})
    assert out == [None, None, None, None]
    zones = run_js(
        "const m = chart.grid24Model(data.history); return [m.rows[4].cells[20], m.rows[5].cells[21], m.rows[5].cells[22]];",
        {"history": hist},
    )
    assert zones == [2, 1, 0]


def test_the_day_has_no_peak_dots():
    hist = day({"queue": {i: (1.2, 3.4) for i in range(COUNT)}})
    out = run_js("return chart.grid24Model(data.history).rows.some((r) => 'peakDots' in r);", {"history": hist})
    assert out is False


def test_the_hint_title_says_why_the_column_is_coloured():
    hist = day({
        "cpu": {11: (72.5, 80), 12: (90, 95)},
        "queue": {13: (1.8, 3.4)},
    })
    out = run_js(TIP, {"history": hist, "columns": [10, 11, 12, 13]})
    assert [(t["title"], t["tone"]) for t in out] == [
        ("Всё в норме", 0),
        ("Высокая нагрузка: процессор", 1),
        ("Перегрузка: процессор", 2),
        ("Близко к высокой: очередь задач", 1),
    ]
    high = {line["label"]: line for line in out[1]["lines"]}
    assert high["Процессор"] == {"label": "Процессор", "value": "73 %", "peak": "пик 80 %", "strong": True}
    assert "strong" not in high["Память"]
    near = {line["label"]: line for line in out[3]["lines"]}
    # the minute peak of the queue above «перегрузка» is coloured, the line is bold
    assert near["Очередь задач"] == {"label": "Очередь задач", "value": "1,8", "peak": "пик 3,4", "peakTone": 2, "strong": True}


def test_the_hint_lines_of_a_calm_column():
    hist = day({"online": {20: (0.6, 1)}})
    out = run_js(TIP, {"history": hist, "columns": [20]})[0]
    assert out["title"] == "Всё в норме"
    assert out["lines"] == [
        {"label": "Процессор", "value": "12 %", "peak": "пик 30 %"},
        {"label": "Память", "value": "50 %", "peak": "пик 52 %"},
        {"label": "Канал · МТС", "value": "↓ 5 % / ↑ 2 %", "peak": "пик ↓ 9 % / ↑ 3 %"},
        {"label": "Очередь задач", "value": "0,6", "peak": "пик 1,1"},
        {"label": "Интернет", "value": "были перебои", "tone": 2},
        {"label": "Температура", "value": "до 56 °C"},
    ]


def test_a_calm_day_has_no_heaviest_time_even_with_minute_peaks():
    hist = day({"queue": {i: (1.2, 3.4) for i in range(COUNT)}})
    out = run_js(SUMMARY, {"history": hist})
    assert out["heavy"] is None
    assert out["red"] == []


def test_the_heaviest_time_is_the_deepest_into_the_zone_not_the_most_metrics():
    # column 30: the processor at 84 % (nearly «перегрузка»); column 60: memory and queue
    # just over «высокая». The deeper one wins.
    hist = day({"cpu": {30: (84, 90)}, "memory": {60: (76, 78)}, "queue": {60: (2.2, 2.5)}})
    out = run_js(SUMMARY, {"history": hist})
    assert out["heavy"] == "03:30–03:45"
    assert out["red"] == []
    assert out["breaks"] == 0


def test_red_minutes_and_breaks_are_counted_by_the_averages():
    hist = day({"cpu": {40: (90, 95), 41: (88, 99)}, "online": {50: (0.6, 1), 51: (0.5, 1), 70: (0.6, 1)}})
    out = run_js(SUMMARY, {"history": hist})
    assert out["red"] == [{"label": "Процессор", "minutes": 30}]
    assert out["breaks"] == 2
