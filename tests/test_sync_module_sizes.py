"""Размеры модулей для экрана модулей (scripts/sync_module_sizes.py).

Размер модуля — это то, что ляжет на роутер: только файлы пакета xkeen-ui/.
Тесты, e2e и конфигурация сборки в репозитории на роутер не ставятся, и новый
тест в выпуске модуля не должен менять запись core.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _sync(tmp_path: Path, inventory: dict) -> dict:
    inventory_path = tmp_path / "inventory.json"
    output = tmp_path / "module-sizes.json"
    inventory_path.write_text(json.dumps(inventory), encoding="utf-8")
    subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "sync_module_sizes.py"), "--inventory", str(inventory_path), "--output", str(output)],
        check=True,
    )
    return json.loads(output.read_text(encoding="utf-8"))["modules"]


def test_only_package_files_count(tmp_path):
    inventory = {
        "modules": [{"id": "core", "size_bytes": 999}, {"id": "tool.files", "size_bytes": 999}, {"id": "tool.empty", "size_bytes": 5}],
        "units": [
            {"module_id": "core", "path": "xkeen-ui/app.py", "size_bytes": 10},
            {"module_id": "core", "path": "tests/test_app.py", "size_bytes": 100},
            {"module_id": "core", "path": "package.json", "size_bytes": 1000},
            {"module_id": "tool.files", "path": "xkeen-ui/routes/files.py", "size_bytes": 7},
            {"module_id": "tool.files", "path": "e2e/files.spec.mjs", "size_bytes": 70},
            {"module_id": "tool.empty", "path": "tests/test_empty.py", "size_bytes": 5},
        ],
    }
    assert _sync(tmp_path, inventory) == {"core": 10, "tool.files": 7, "tool.empty": 0}


def test_committed_sizes_match_the_package_files_of_the_inventory():
    inventory = json.loads((ROOT / "docs" / "modular-panel-stage0-inventory.json").read_text(encoding="utf-8"))
    sizes = json.loads((ROOT / "xkeen-ui" / "module-sizes.json").read_text(encoding="utf-8"))["modules"]
    expected = {item["id"]: 0 for item in inventory["modules"]}
    for unit in inventory["units"]:
        if unit["path"].startswith("xkeen-ui/"):
            expected[unit["module_id"]] += unit["size_bytes"]
    assert sizes == expected
