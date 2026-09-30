from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
GENERATOR = ROOT / "scripts/generate_modular_panel_stage3r1_baseline.py"
SNAPSHOT = ROOT / "docs/modular-panel-stage3r1-initial-html-baseline.json"
CONTRACT = ROOT / "docs/modular-panel-stage3r1-runtime-safety.md"
PLAN = ROOT / "README-modular-panel-plan.md"


def test_stage3r1_baseline_is_reproducible(tmp_path):
    json_out = tmp_path / "baseline.json"
    markdown_out = tmp_path / "baseline.md"
    result = subprocess.run(
        [
            sys.executable,
            str(GENERATOR),
            "--root",
            str(ROOT),
            "--json-out",
            str(json_out),
            "--markdown-out",
            str(markdown_out),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr or result.stdout
    assert SNAPSHOT.is_file()
    payload = json.loads(json_out.read_text(encoding="utf-8"))
    assert payload == json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    assert payload["stage"]["id"] == "3R.1.6"
    assert payload["source"]["duplicate_dom_ids"] == []
    assert {item["id"] for item in payload["profiles"]} == {
        "legacy-full",
        "full",
        "xray-only",
        "mihomo-only",
    }


def test_stage3r1_documentation_closes_the_stage():
    plan = PLAN.read_text(encoding="utf-8")
    contract = CONTRACT.read_text(encoding="utf-8")
    assert "## Этап 3R.1. Доработка runtime safety по сверке с кодом" in plan
    assert "**Статус:** закрыт 30 сентября 2026 года." in plan
    assert "### Критерий готовности 3R.1" in plan
    assert "3R.1 закрывает" in contract
