#!/usr/bin/env python3
"""Отметка о полном e2e на коммит и проверка тегов выпуска перед пушем.

e2e нет в CI, поэтому зелёный CI не говорит, что браузерные тесты прошли.

  python scripts/e2e_gate.py run         весь e2e на текущем коммите; при успехе — отметка
  python scripts/e2e_gate.py check-push  pre-push: тег v* только на коммит с отметкой

Разовые сбои (смена сети на ноутбуке, плавающие тесты) добираются одним повтором
упавших тестов. Отметка лежит в каталоге git и в коммиты не попадает.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

BUILD = "npm run frontend:build"
FULL_RUN = "npx playwright test"
RETRY_FAILED = "npx playwright test --last-failed"
RELEASE_TAG = re.compile(r"^refs/tags/v\d")
ZERO_SHA = re.compile(r"^0+$")


def _git(cwd, *args) -> str:
    done = subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)
    return done.stdout.strip()


def marker_path(sha: str, cwd=".") -> Path:
    return Path(cwd, _git(cwd, "rev-parse", "--git-common-dir"), "xkeen-e2e-passed", sha)


def tags_missing_e2e(lines, cwd=".") -> list[str]:
    """Теги выпуска из ввода pre-push, у коммита которых нет отметки."""
    missing = []
    for line in lines:
        parts = line.split()
        if len(parts) != 4:
            continue
        _local_ref, local_sha, remote_ref, _remote_sha = parts
        if ZERO_SHA.match(local_sha) or not RELEASE_TAG.match(remote_ref):
            continue
        commit = _git(cwd, "rev-parse", f"{local_sha}^{{commit}}")
        if not marker_path(commit, cwd).exists():
            missing.append(remote_ref)
    return missing


def _tree_is_dirty(cwd) -> bool:
    return bool(_git(cwd, "status", "--porcelain", "--untracked-files=no"))


def run_gate(runner, cwd=".") -> int:
    if _tree_is_dirty(cwd):
        print("[e2e] есть незакоммиченные правки: отметка относилась бы к другому коду.", file=sys.stderr)
        return 1
    sha = _git(cwd, "rev-parse", "HEAD")

    if runner(BUILD) != 0:
        print("[e2e] сборка фронта не прошла.", file=sys.stderr)
        return 1
    retried = False
    if runner(FULL_RUN) != 0:
        retried = True
        print("[e2e] есть падения, повторяем только упавшие тесты.")
        if runner(RETRY_FAILED) != 0:
            print("[e2e] падения повторились, отметка не поставлена.", file=sys.stderr)
            return 1

    if _git(cwd, "rev-parse", "HEAD") != sha or _tree_is_dirty(cwd):
        print("[e2e] код изменился во время прогона, отметка не поставлена.", file=sys.stderr)
        return 1

    path = marker_path(sha, cwd)
    path.parent.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    path.write_text(json.dumps({"at": stamp, "retried_failed": retried}) + "\n", encoding="utf-8")
    note = " (упавшие прошли при повторе)" if retried else ""
    print(f"[e2e] весь e2e пройден{note}, коммит {sha[:8]} отмечен.")
    return 0


def main(argv: list[str]) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    mode = argv[1] if len(argv) > 1 else ""
    if mode == "run":
        return run_gate(lambda command: subprocess.run(command, shell=True).returncode)
    if mode == "check-push":
        missing = tags_missing_e2e(sys.stdin.read().splitlines())
        if not missing:
            return 0
        print("Пуш не прошёл: для этих тегов нет отметки о полном e2e:", file=sys.stderr)
        for ref in missing:
            print(f"  {ref}", file=sys.stderr)
        print("Исправить: перейти на коммит тега и выполнить npm run e2e:gate.", file=sys.stderr)
        print("Пропустить разово: XKEEN_SKIP_E2E_GATE=1 git push ...", file=sys.stderr)
        return 1
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
