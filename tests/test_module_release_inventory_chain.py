"""Выпуск модуля проходит после штатного обновления описей.

Хук pre-commit заставляет пересчитать описи при любой правке модуля, и вместе
с правкой в коммит идёт xkeen-ui/module-sizes.json. Тест повторяет это на копии
настоящего дерева: правка файла модуля и новый тест, затем генераторы описи и
размеров, затем обе проверки выпуска модуля — по списку изменённых путей и
сравнение module-sizes.json по смыслу. Без него хук и проверка могут
разойтись, и выпуск модуля упрётся в «Нужен выпуск панели» на настоящем теге.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

from scripts import build_modular_panel_release as builder
from scripts.check_module_release import NEEDS_PANEL, _without_module, check_changed_paths
from scripts.refresh_inventory import in_scope

ROOT = Path(__file__).resolve().parents[1]
MODULE = "tool.advanced-diagnostics"
MODULE_FILE = "xkeen-ui/static/js/features/resource_monitor/view.js"
SIZES = "xkeen-ui/module-sizes.json"
# what decides the sizes: the module inventory and the sizes synced from it
GENERATORS = ("generate_modular_panel_inventory.py", "sync_module_sizes.py")
GIT = ("git", "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "core.autocrlf=false")


def _git(repo: Path, *args: str) -> str:
    result = subprocess.run([*GIT, *args], cwd=repo, capture_output=True, text=True, encoding="utf-8", check=True)
    return result.stdout


def _copy_tree(destination: Path) -> None:
    listed = _git(ROOT, "ls-files", "-z", "--cached", "--others", "--exclude-standard")
    for rel in listed.split("\0"):
        if not rel or not (in_scope(rel) or rel == "module-versions.json"):
            continue
        source = ROOT / rel
        if source.is_file():
            target = destination / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)


def _refresh(repo: Path) -> None:
    # the inventory takes its file list from git: new files are added first, as the hook demands
    _git(repo, "add", "-A")
    for name in GENERATORS:
        subprocess.run([sys.executable, f"scripts/{name}"], cwd=repo, check=True, capture_output=True)
    _git(repo, "add", "-A")


def test_module_change_with_refreshed_inventory_passes_both_release_checks(tmp_path):
    repo = tmp_path / "repo"
    _copy_tree(repo)
    _git(repo, "init", "-q")
    _refresh(repo)
    _git(repo, "commit", "-q", "-m", "base")
    sizes_before = (repo / SIZES).read_bytes()

    with (repo / MODULE_FILE).open("ab") as handle:
        handle.write(b"\r\n// release change\r\n")
    (repo / "tests" / "test_release_change.py").write_text("def test_release_change():\n    assert True\n", encoding="utf-8")
    _refresh(repo)
    _git(repo, "commit", "-q", "-m", "module change")

    changed = _git(repo, "diff", "--name-only", "HEAD~1", "HEAD").split()
    assert SIZES in changed, "хук требует пересчитанных размеров — без них тест ничего не проверяет"
    owned = builder.build_ownership_map(ROOT)["modules"][MODULE]
    assert check_changed_paths(changed, owned) == []

    left, problems = _without_module((repo / SIZES).read_bytes(), MODULE, "module-sizes.json")
    right, more = _without_module(sizes_before, MODULE, "module-sizes.json")
    assert problems == [] and more == []
    assert left == right, "новый тест не должен менять размер core и соседних модулей"
    assert (repo / SIZES).read_bytes() != sizes_before

    errors = check_changed_paths([*changed, "xkeen-ui/app.py"], owned)
    assert errors and all(NEEDS_PANEL in error for error in errors)
