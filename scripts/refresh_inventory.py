"""Rebuild every generated inventory in the right order, or check a commit.

The modular-panel inventory takes its file list from ``git ls-files``. Run
before ``git add`` it leaves new files out, the local run stays green, and the
server goes red after the push; module sizes feed back into the inventory, so
the generators also have to run until nothing changes. This script does both.

    npm run inventory:refresh          # rebuild in the working tree
    npm run inventory:check            # what the pre-commit hook runs

``--check`` exports the index (exactly what is being committed) to a temporary
directory, runs the generators there and compares. It never touches the
working tree.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Generators that write tracked snapshots, in dependency order. The stage 0
# inventory and module sizes go last: they read the other files.
GENERATORS = (
    ("generate_frontend_inventory.py", True),
    ("generate_panel_operator_inventory.py", True),
    ("generate_modular_panel_stage4_1_contract.py", True),
    ("generate_modular_panel_stage4_6_compatibility.py", True),
    ("generate_modular_panel_stage5_frontend_loading.py", True),
    ("generate_modular_panel_stage8_contract.py", True),
    ("generate_module_manager_e2e_fixtures.py", False),
    ("generate_operator_icon_inventory.py", False),
    ("generate_modular_panel_inventory.py", True),
    ("sync_module_sizes.py", True),
)
MAX_PASSES = 4

# Paths the snapshots are built from. Untracked files here are what the stage 0
# inventory silently drops; a commit touching none of them cannot make it stale.
SCOPE_PREFIXES = (
    "xkeen-ui/", "tests/", "e2e/", "scripts/", "docs/", "packaging/", ".github/workflows/",
)
SCOPE_FILES = (
    "package.json", "pyproject.toml", "requirements-dev.txt", "vite.config.mjs", "playwright.config.mjs",
)
# Generated outputs live here; their hashes tell whether a pass changed anything.
OUTPUT_DIRS = ("docs", "e2e/fixtures")
OUTPUT_FILES = ("xkeen-ui/module-sizes.json",)


def in_scope(rel: str) -> bool:
    rel = rel.replace("\\", "/")
    if "__pycache__/" in rel:
        return False
    return rel.startswith(SCOPE_PREFIXES) or rel in SCOPE_FILES


def git(*args: str, cwd: Path = ROOT) -> str:
    res = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, encoding="utf-8")
    if res.returncode != 0:
        raise SystemExit(f"git {' '.join(args)}: {res.stderr.strip()}")
    return res.stdout


def untracked_in_scope() -> list[str]:
    out = git("ls-files", "--others", "--exclude-standard", "-z")
    return sorted(p for p in out.split("\0") if p and in_scope(p))


def staged_in_scope() -> list[str]:
    out = git("diff", "--cached", "--name-only", "-z")
    return sorted(p for p in out.split("\0") if p and in_scope(p))


def snapshot(root: Path) -> dict[str, str]:
    hashes: dict[str, str] = {}
    paths: list[Path] = [root / f for f in OUTPUT_FILES]
    for d in OUTPUT_DIRS:
        base = root / d
        if base.is_dir():
            paths.extend(p for p in base.rglob("*") if p.is_file())
    for path in paths:
        if path.is_file():
            # Compare text with normalised line endings: Windows checkouts
            # carry CRLF where the generators write LF.
            data = path.read_bytes().replace(b"\r\n", b"\n")
            hashes[path.relative_to(root).as_posix()] = hashlib.sha256(data).hexdigest()
    return hashes


def run_pass(root: Path) -> None:
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", PYTHONIOENCODING="utf-8")
    for script, takes_root in GENERATORS:
        cmd = [sys.executable, str(root / "scripts" / script)]
        if takes_root:
            cmd += ["--root", str(root)]
        res = subprocess.run(cmd, cwd=root, capture_output=True, text=True, encoding="utf-8", errors="replace", env=env)
        if res.returncode != 0:
            raise SystemExit(f"{script} завершился с ошибкой:\n{res.stdout}{res.stderr}")


def rebuild(root: Path) -> list[str]:
    """Run passes until nothing changes; return the files that changed."""
    start = snapshot(root)
    before = start
    for _ in range(MAX_PASSES):
        run_pass(root)
        after = snapshot(root)
        if after == before:
            break
        before = after
    else:
        raise SystemExit(f"Описи не сошлись за {MAX_PASSES} прохода — генераторы зависят друг от друга по кругу.")
    return sorted(k for k in set(start) | set(after) if start.get(k) != after.get(k))


def refresh(allow_untracked: bool) -> int:
    untracked = untracked_in_scope()
    if untracked and not allow_untracked:
        print("Есть новые файлы, ещё не добавленные в git. Опись строится по git, без них она выйдет неполной:", file=sys.stderr)
        for path in untracked:
            print("  " + path, file=sys.stderr)
        print("Сначала `git add` этих файлов (или удалите лишние), потом снова `npm run inventory:refresh`.", file=sys.stderr)
        return 1
    changed = rebuild(ROOT)
    if changed:
        print("Обновлены описи:")
        for path in changed:
            print("  " + path)
        print("Добавьте их в коммит: git add " + " ".join(changed))
    else:
        print("Описи актуальны.")
    return 0


def check() -> int:
    if not staged_in_scope():
        return 0
    tmp = Path(tempfile.mkdtemp(prefix="xk-inventory-"))
    try:
        git("checkout-index", "-a", f"--prefix={tmp.as_posix()}/")
        changed = rebuild(tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if not changed:
        return 0
    print("Коммит не прошёл: описи не совпадают с тем, что вы коммитите.", file=sys.stderr)
    for path in changed:
        print("  " + path, file=sys.stderr)
    print("Исправить: npm run inventory:refresh, затем git add этих файлов и коммит ещё раз.", file=sys.stderr)
    return 1


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass
    parser = argparse.ArgumentParser(description="Rebuild or check generated inventories.")
    parser.add_argument("--check", action="store_true", help="check the staged commit (pre-commit hook)")
    parser.add_argument("--allow-untracked", action="store_true", help="rebuild even with untracked files in scope")
    args = parser.parse_args(argv)
    return check() if args.check else refresh(args.allow_untracked)


if __name__ == "__main__":
    raise SystemExit(main())
