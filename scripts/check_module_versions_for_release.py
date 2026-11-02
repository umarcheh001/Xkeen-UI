#!/usr/bin/env python3
"""Checks of module versions at a panel release (tag `v*`).

    python scripts/check_module_versions_for_release.py --tag v3.1.0

1. A version in module-versions.json is not below any issued tag `module-<id>-*`
   (a module release branch was not merged into the panel line).
2. A module whose sources changed since the previous panel tag of the same
   channel got a version bump.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Iterable, Mapping, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.check_module_release import (  # noqa: E402
    PACKAGE_DIRNAME,
    PANEL_TAG_RE,
    _git,
    _module_ownership,
    _panel_key,
    _version_key,
    parse_module_tag,
)

# Files that a build or an inventory refresh writes: they change without a source
# change of the module. Chosen from the builder (build_modular_panel_release.py:
# BUILD.json is ignored, module-ownership/module-versions are laid in by the
# builder, precompressed .gz copies and static/frontend-build, static/vendor are
# build output kept out of git) and from the pre-commit inventory
# (xkeen-ui/module-sizes.json is the only tracked generated file in xkeen-ui/).
GENERATED_FILES = {
    "BUILD.json",
    "module-ownership.json",
    "module-sizes.json",
    "module-versions.json",
}
GENERATED_PREFIXES = ("static/frontend-build/", "static/vendor/")
GENERATED_SUFFIXES = (".gz", ".pyc", ".pyo")


def _tag_version(tag: str) -> tuple[str, tuple[int, ...]] | None:
    try:
        module_id, version = parse_module_tag(tag)
    except ValueError:
        return None
    return module_id, _version_key(version)


def missing_merges(versions: Mapping[str, str], module_tags: Sequence[str]) -> list[str]:
    errors: list[str] = []
    for tag in module_tags:
        parsed = _tag_version(tag)
        if parsed is None or parsed[0] not in versions:
            continue
        module_id, issued = parsed
        try:
            current = _version_key(versions[module_id])
        except ValueError:
            errors.append(f"в module-versions.json у {module_id} некорректная версия {versions[module_id]}")
            continue
        if current < issued:
            errors.append(
                f"версия {module_id} в module-versions.json ({versions[module_id]}) ниже выданного тега {tag}: "
                "не влита ветка выпуска модуля"
            )
    return errors


def _is_generated(relative: str) -> bool:
    return (
        relative in GENERATED_FILES
        or relative.startswith(GENERATED_PREFIXES)
        or relative.endswith(GENERATED_SUFFIXES)
    )


def unbumped_modules(
    changed: Iterable[str],
    ownership: Mapping[str, Sequence[str]],
    old_versions: Mapping[str, str],
    new_versions: Mapping[str, str],
) -> list[str]:
    owner = {}
    for module_id, paths in ownership.items():
        if module_id == "core":
            continue
        for path in paths:
            owner[str(path).replace("\\", "/")] = module_id
    touched: set[str] = set()
    prefix = PACKAGE_DIRNAME + "/"
    for raw in changed:
        path = str(raw).replace("\\", "/")
        if not path.startswith(prefix):
            continue
        relative = path[len(prefix):]
        if _is_generated(relative):
            continue
        if relative in owner:
            touched.add(owner[relative])
    result = []
    for module_id in sorted(touched):
        old = old_versions.get(module_id)
        if old is None:
            continue
        new = new_versions.get(module_id, old)
        if _version_key(new) <= _version_key(old):
            result.append(module_id)
    return result


def previous_panel_tag(tag: str, all_tags: Iterable[str]) -> str | None:
    """The nearest lower panel tag of the same channel (betas and stable apart)."""

    if not PANEL_TAG_RE.match(tag):
        return None
    beta = "-beta." in tag
    lower = [
        other
        for other in all_tags
        if PANEL_TAG_RE.match(other) and ("-beta." in other) == beta and _panel_key(other) < _panel_key(tag)
    ]
    return max(lower, key=_panel_key) if lower else None


def _versions_at(root: Path, ref: str) -> dict[str, str]:
    result = subprocess.run(
        ["git", "show", f"{ref}:module-versions.json"], cwd=root, capture_output=True, text=True, encoding="utf-8"
    )
    if result.returncode != 0:
        return {}
    try:
        data = json.loads(result.stdout)
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--tag", required=True, help="panel tag vX.Y.Z or vX.Y.Z-beta.N")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args(argv)
    root = args.root.resolve()
    if not PANEL_TAG_RE.match(args.tag):
        print(f"ОШИБКА: не тег панели: {args.tag}", file=sys.stderr)
        return 1
    new_versions = json.loads((root / "module-versions.json").read_text(encoding="utf-8"))
    errors = missing_merges(new_versions, _git(root, "tag", "-l", "module-*"))
    previous = previous_panel_tag(args.tag, _git(root, "tag", "-l", "v*"))
    if previous:
        old_versions = _versions_at(root, previous)
        changed = _git(root, "diff", "--name-only", f"{previous}..{args.tag}")
        for module_id in unbumped_modules(changed, _module_ownership(root), old_versions, new_versions):
            errors.append(
                f"исходники модуля {module_id} менялись с {previous}, а версия не поднята "
                f"({new_versions.get(module_id)}): поднимите её в module-versions.json"
            )
    for error in errors:
        print(f"ОШИБКА: {error}", file=sys.stderr)
    if errors:
        return 1
    print(f"Версии модулей для {args.tag} согласованы" + (f" (сравнение с {previous})" if previous else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
