#!/usr/bin/env python3
"""Compare a saved `xkeen -h` output with the panel's explicit command catalog."""

from __future__ import annotations

import argparse
import ast
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "xkeen-ui" / "services" / "xkeen_commands_catalog.py"
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
FLAG = re.compile(r"^\s*(-[a-z][a-z0-9-]*)(?=\s|$)")


def catalog_flags() -> set[str]:
    tree = ast.parse(CATALOG.read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "COMMAND_GROUPS" for target in node.targets):
            groups = ast.literal_eval(node.value)
            return {item["flag"] for group in groups for item in group["items"]}
    raise ValueError("Каталог команд не найден")


def help_flags(content: str) -> set[str]:
    clean = ANSI.sub("", content)
    return {match.group(1) for line in clean.splitlines() if (match := FLAG.match(line))}


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="Сверить сохранённый вывод xkeen -h с каталогом панели")
    parser.add_argument("help_file", type=Path, help="UTF-8 файл с выводом xkeen -h")
    args = parser.parse_args()
    try:
        catalog = catalog_flags()
        flags = help_flags(args.help_file.read_text(encoding="utf-8-sig"))
        if not flags or not flags.intersection(catalog):
            raise ValueError("Справка не распознана: проверьте файл и формат вывода")
    except (OSError, UnicodeError, ValueError, SyntaxError) as exc:
        print(f"Ошибка: {exc}", file=sys.stderr)
        return 2
    print(f"Флагов в справке: {len(flags)}; в панели: {len(catalog)}")
    print("Есть в справке, отсутствуют в панели:")
    print("  " + (", ".join(sorted(flags - catalog)) or "нет"))
    print("Есть в панели, отсутствуют в справке:")
    print("  " + (", ".join(sorted(catalog - flags)) or "нет"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
