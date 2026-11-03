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
import tarfile
import tempfile
import sys
from pathlib import Path
from typing import Iterable, Mapping, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.check_module_release import (  # noqa: E402
    PACKAGE_DIRNAME,
    PANEL_TAG_RE,
    _git,
    _builder,
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


def merge_ownership(*maps: Mapping[str, Sequence[str]]) -> dict[str, list[str]]:
    """Union of several ownership maps: a path counts for every module that owned it."""

    merged: dict[str, list[str]] = {}
    for ownership in maps:
        for module_id, paths in ownership.items():
            known = merged.setdefault(module_id, [])
            known.extend(path for path in paths if path not in known)
    return merged


def nearest_ancestor_panel_tag(tag: str, ordered_tags: Iterable[str]) -> str | None:
    """The first panel tag (either channel) of `ordered_tags`, nearest ancestor first, except `tag`."""

    for other in ordered_tags:
        if other != tag and PANEL_TAG_RE.match(other):
            return other
    return None


def _ancestor_panel_tags(root: Path, tag: str) -> list[str]:
    """Tags on the ancestors of `tag`, nearest first (several on one commit: the newest first)."""

    try:
        lines = _git(root, "log", "--simplify-by-decoration", "--format=%D", f"{tag}^")
    except subprocess.CalledProcessError:
        return []
    tags: list[str] = []
    for line in lines:
        on_commit = [part.strip()[5:] for part in line.split(",") if part.strip().startswith("tag: ")]
        on_commit = [item for item in on_commit if PANEL_TAG_RE.match(item)]
        on_commit.sort(key=_panel_key, reverse=True)
        tags.extend(on_commit)
    return tags


def _versions_at(root: Path, ref: str) -> dict[str, str] | None:
    """module-versions.json at `ref`; None when the tag has none (older than module versions)."""

    result = subprocess.run(
        ["git", "show", f"{ref}:module-versions.json"], cwd=root, capture_output=True, text=True, encoding="utf-8"
    )
    if result.returncode != 0:
        return None
    try:
        data = json.loads(result.stdout)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def _old_ownership(root: Path, ref: str) -> Mapping[str, Sequence[str]]:
    """Ownership of the tree at `ref`, built by the current builder from `git archive`."""

    with tempfile.TemporaryDirectory() as tmp:
        archive = Path(tmp) / "tree.tar"
        subprocess.run(
            ["git", "archive", "--format=tar", "-o", str(archive), ref, PACKAGE_DIRNAME], cwd=root, check=True
        )
        tree = Path(tmp) / "tree"
        tree.mkdir()
        with tarfile.open(archive) as handle:
            # git archive of our own tree; the filter keeps it to plain files and silences the 3.14 warning
            handle.extractall(tree, filter="data")
        return _builder(root).build_ownership_map(tree)["modules"]


ZERO_SHA = "0" * 40
TAG_REF = "refs/tags/"


def check_panel_tag(root: Path, tag: str, *, from_git: bool = False) -> tuple[list[str], list[str]]:
    """Errors and notes of the module-version checks for the panel tag `tag`.

    `from_git` reads module-versions.json and the ownership from the tag itself, not from the
    working tree: before a push the checkout may be elsewhere (pre-push hook).
    """

    notes: list[str] = []
    if from_git:
        new_versions = _versions_at(root, tag)
        if new_versions is None:
            return [], [f"В {tag} нет module-versions.json: проверка версий модулей пропущена"]
    else:
        new_versions = json.loads((root / "module-versions.json").read_text(encoding="utf-8"))
    errors = missing_merges(new_versions, _git(root, "tag", "-l", "module-*"))
    previous = nearest_ancestor_panel_tag(tag, _ancestor_panel_tags(root, tag))
    if not previous:
        notes.append("Предыдущего тега панели среди предков нет: проверка подъёма версий пропущена")
        return errors, notes
    old_versions = _versions_at(root, previous)
    if old_versions is None:
        notes.append(f"В {previous} нет module-versions.json: проверка подъёма версий пропущена")
        return errors, notes
    current = (lambda: _old_ownership(root, tag)) if from_git else (lambda: _module_ownership(root))
    try:
        ownership = merge_ownership(_old_ownership(root, previous), current())
    except Exception as error:  # old tags may predate the ownership map
        notes.append(f"Принадлежность файлов в {previous} построить не удалось ({error}): берётся текущая")
        ownership = current()
    changed = _git(root, "diff", "--name-only", "--no-renames", f"{previous}..{tag}")
    for module_id in unbumped_modules(changed, ownership, old_versions, new_versions):
        errors.append(
            f"исходники модуля {module_id} менялись с {previous}, а версия не поднята "
            f"({new_versions.get(module_id)}): поднимите её в module-versions.json"
        )
    notes.append(f"Версии модулей для {tag} согласованы (сравнение с {previous})")
    return errors, notes


def check_pushed_tags(root: Path, lines: Iterable[str]) -> int:
    """pre-push: the panel tags being pushed must pass the checks the release workflow runs.

    Checked here, a bad tag never reaches GitHub; checked only in CI, the tag is already issued
    and its beta number is lost.
    """

    failed = False
    for line in lines:
        parts = line.split()
        if len(parts) != 4:
            continue
        _local_ref, local_sha, remote_ref, _remote_sha = parts
        if local_sha == ZERO_SHA or not remote_ref.startswith(TAG_REF):
            continue
        tag = remote_ref[len(TAG_REF):]
        if not PANEL_TAG_RE.match(tag):
            continue
        errors, _notes = check_panel_tag(root, tag, from_git=True)
        if errors:
            failed = True
            print(f"Пуш тега {tag} остановлен: версии модулей не согласованы.", file=sys.stderr)
            for error in errors:
                print(f"  {error}", file=sys.stderr)
    if failed:
        print(
            "Исправить: поднять версии в module-versions.json (или влить ветку выпуска модуля), "
            "закоммитить, перенести тег на новый коммит. Подробно — RELEASING.md, «Выпуск одного модуля».",
            file=sys.stderr,
        )
        print("Свежие теги модулей коллег: git fetch --tags. Пропустить разово: XKEEN_SKIP_MODULE_VERSIONS=1 git push ...", file=sys.stderr)
        return 1
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--tag", help="panel tag vX.Y.Z or vX.Y.Z-beta.N")
    parser.add_argument("--pre-push", action="store_true", help="check the tags git passes to the pre-push hook on stdin")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args(argv)
    root = args.root.resolve()
    if args.pre_push:
        return check_pushed_tags(root, sys.stdin.read().splitlines())
    if not args.tag or not PANEL_TAG_RE.match(args.tag):
        print(f"ОШИБКА: не тег панели: {args.tag}", file=sys.stderr)
        return 1
    errors, notes = check_panel_tag(root, args.tag)
    for error in errors:
        print(f"ОШИБКА: {error}", file=sys.stderr)
    if errors:
        return 1
    for note in notes:
        print(note)
    return 0


if __name__ == "__main__":
    sys.exit(main())
