#!/usr/bin/env python3
"""Checks that guard a release of one module separately from the panel.

A module release is a tag `module-<id>-X.Y.Z` on a branch `module/<id>-<version>`
cut from a panel tag `v*`. Every check returns a list of violations (empty means
the check passed); `main` runs them in order and stops at the first violation.

    python scripts/check_module_release.py --tag module-tool.files-1.0.1 \\
        --panel-archive xkeen-ui-panel-3.1.0.tar.gz

"Правка требует выпуска панели" is the normal outcome, not a failure: the change
touches core or a neighbour module and must go out with a panel release.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path
from typing import Collection, Iterable, Mapping, Sequence

PACKAGE_DIRNAME = "xkeen-ui"
NEEDS_PANEL = "правка требует выпуска панели"

MODULE_TAG_RE = re.compile(r"^module-([a-z][a-z0-9._-]*?)-(\d+\.\d+\.\d+)$")
PANEL_TAG_RE = re.compile(r"^v(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$")

# Outside xkeen-ui/ these paths may change in a module release.
ALLOWED_OUTSIDE = ("tests/", "e2e/", "docs/")
ALLOWED_OUTSIDE_FILES = {"module-versions.json"}

# Not compared with the panel archive: taken at build time or never touched by a module.
IGNORED = {"BUILD.json", "module-versions.json", "retired-files.json", "scripts/entware_mirrors.txt"}
# Compared by meaning: only the entry of the released module may differ.
SEMANTIC = {"module-ownership.json", "module-sizes.json"}

# One module id, several variants (light/full); an update entry cannot yet carry
# per-variant ownership, so applying it would delete the other variant's files.
VARIANT_MODULES = {"tool.editor"}

# Exit codes of main: 0 passed, 1 a real violation, 2 the change needs a panel release.
EXIT_NEEDS_PANEL = 2


def parse_module_tag(tag: str) -> tuple[str, str]:
    match = MODULE_TAG_RE.match(str(tag or "").strip())
    if not match:
        raise ValueError(f"тег не соответствует формату module-<id>-X.Y.Z: {tag}")
    return match.group(1), match.group(2)


def _version_key(version: str) -> tuple[int, ...]:
    return tuple(int(part) for part in version.split("."))


def check_module_releasable(module_id: str) -> list[str]:
    if module_id == "core":
        return [f"core не имеет собственной версии: {NEEDS_PANEL}"]
    if module_id in VARIANT_MODULES:
        return [
            f"{NEEDS_PANEL}: у модуля {module_id} есть варианты (light и full) под одним идентификатором, "
            "а запись обновления пока не несёт принадлежности по вариантам, "
            "поэтому её применение удалило бы файлы другого варианта"
        ]
    return []


def check_tag_version(tag: str, versions: Mapping[str, str], issued: Sequence[str]) -> list[str]:
    try:
        module_id, version = parse_module_tag(tag)
    except ValueError as error:
        return [str(error)]
    errors: list[str] = []
    declared = versions.get(module_id)
    if declared is None:
        errors.append(f"в module-versions.json нет модуля {module_id}")
    elif declared != version:
        errors.append(f"тег {tag} не совпадает с module-versions.json ({module_id}: {declared})")
    for other in issued:
        if other == tag:
            continue
        try:
            other_id, other_version = parse_module_tag(other)
        except ValueError:
            continue
        if other_id == module_id and _version_key(other_version) >= _version_key(version):
            errors.append(f"версия {version} не выше уже выданной {other}")
    return errors


def find_panel_tag(tags_reachable: Sequence[str]) -> str:
    """The nearest ancestor panel tag; `tags_reachable` goes from the nearest."""

    for tag in tags_reachable:
        if PANEL_TAG_RE.match(str(tag).strip()):
            return str(tag).strip()
    raise ValueError("среди предков нет тега панели v*")


def _panel_key(tag: str) -> tuple[tuple[int, int, int], int, int]:
    """Order of panel tags: a stable X.Y.Z is above every beta of X.Y.Z."""

    match = PANEL_TAG_RE.match(tag)
    assert match
    base = (int(match.group(1)), int(match.group(2)), int(match.group(3)))
    beta = match.group(4)
    return base, 0 if beta else 1, int(beta or 0)


def check_earlier_releases_included(
    tag: str, panel_tag: str, panel_of: Mapping[str, str | None], included: Collection[str]
) -> list[str]:
    """Every issued release of the module from the same panel tag is an ancestor of HEAD.

    `panel_of` maps the module's issued tags to their nearest panel ancestor,
    `included` holds the ones that are ancestors of HEAD.
    """

    errors: list[str] = []
    for other in sorted(panel_of):
        if other == tag or panel_of[other] != panel_tag or other in included:
            continue
        errors.append(
            f"выпуск {other} от той же панели {panel_tag} не входит в историю {tag}: "
            f"ветку выпуска надо отрезать от {other}, иначе его правка пропадёт"
        )
    return errors


def check_latest_in_channel(panel_tag: str, published: Sequence[str]) -> list[str]:
    if not PANEL_TAG_RE.match(panel_tag):
        return [f"не тег панели: {panel_tag}"]
    beta = "-beta." in panel_tag
    same_channel = [
        tag for tag in published if PANEL_TAG_RE.match(tag) and ("-beta." in tag) == beta
    ]
    channel = "бет" if beta else "стабильных выпусков"
    if panel_tag not in same_channel:
        return [f"у тега {panel_tag} нет опубликованного выпуска"]
    newest = max(same_channel, key=_panel_key)
    if newest != panel_tag:
        return [f"{panel_tag} не последний среди {channel}: есть {newest}, выпуск модуля делается от него"]
    return []


def check_changed_paths(changed: Iterable[str], module_files: Collection[str]) -> list[str]:
    owned = {str(path).replace("\\", "/") for path in module_files}
    prefix = PACKAGE_DIRNAME + "/"
    errors: list[str] = []
    for raw in changed:
        path = str(raw).replace("\\", "/")
        while path.startswith("./"):
            path = path[2:]
        if path.startswith(prefix):
            relative = path[len(prefix):]
            if relative not in owned and path not in owned:
                errors.append(f"{NEEDS_PANEL}: {path} не принадлежит модулю")
        elif path in ALLOWED_OUTSIDE_FILES or path.startswith(ALLOWED_OUTSIDE):
            continue
        else:
            errors.append(f"{NEEDS_PANEL}: {path} вне модуля")
    return errors


def _read_archive(path: Path) -> dict[str, bytes]:
    files: dict[str, bytes] = {}
    prefix = PACKAGE_DIRNAME + "/"
    with tarfile.open(path, "r:gz") as archive:
        for member in archive.getmembers():
            if not member.isfile() or not member.name.startswith(prefix):
                continue
            handle = archive.extractfile(member)
            if handle is not None:
                files[member.name[len(prefix):]] = handle.read()
    return files


def _read_build(root: Path) -> dict[str, bytes]:
    return {
        path.relative_to(root).as_posix(): path.read_bytes()
        for path in sorted(Path(root).rglob("*"))
        if path.is_file()
    }


def _without_module(data: bytes, module_id: str, name: str) -> tuple[dict | None, list[str]]:
    try:
        payload = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None, [f"{name}: не читается как JSON"]
    if not isinstance(payload, dict) or not isinstance(payload.get("modules", {}), dict):
        return None, [f"{name}: неожиданная структура"]
    modules = dict(payload.get("modules", {}))
    modules.pop(module_id, None)
    return {**payload, "modules": modules}, []


def _module_files(files: Mapping[str, bytes], module_id: str) -> set[str]:
    data = files.get("module-ownership.json")
    if data is None:
        return set()
    try:
        entry = json.loads(data.decode("utf-8")).get("modules", {}).get(module_id, [])
    except (UnicodeDecodeError, ValueError, AttributeError):
        return set()
    return {str(path) for path in entry} if isinstance(entry, list) else set()


def compare_with_panel_archive(build_root: Path, panel_archive: Path, module_id: str) -> list[str]:
    """Compare the built package (files relative to xkeen-ui/) with the panel archive."""

    built = _read_build(Path(build_root))
    published = _read_archive(Path(panel_archive))
    own = _module_files(built, module_id) | _module_files(published, module_id)
    errors: list[str] = []
    for name in sorted(set(built) | set(published)):
        if name in IGNORED:
            continue
        if name in SEMANTIC:
            if name not in built or name not in published:
                errors.append(f"{NEEDS_PANEL}: {name} есть только в одной из сборок")
                continue
            left, problems = _without_module(built[name], module_id, name)
            right, more = _without_module(published[name], module_id, name)
            errors.extend(problems + more)
            if left is not None and right is not None and left != right:
                errors.append(f"{NEEDS_PANEL}: {name} отличается не только записью модуля {module_id}")
            continue
        if name in own:
            continue
        if name not in published:
            errors.append(f"{NEEDS_PANEL}: новый файл {name} не из модуля и не в списке исключений")
        elif name not in built:
            errors.append(f"{NEEDS_PANEL}: файл {name} исчез из сборки")
        elif built[name] != published[name]:
            errors.append(f"{NEEDS_PANEL}: {name} отличается от архива панели")
    return errors


def extract_panel_archive(archive: Path, destination: Path) -> Path:
    """Lay the package files of a panel archive (relative to xkeen-ui/) into `destination`."""

    destination.mkdir(parents=True, exist_ok=True)
    for name, data in _read_archive(archive).items():
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    return destination


def _builder(root: Path):
    # The builder of the checked-out tree, not of the checkout running the check.
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    from scripts import build_modular_panel_release as builder

    return builder


def _module_ownership(root: Path) -> Mapping[str, Sequence[str]]:
    return _builder(root).build_ownership_map(root)["modules"]


def _build_package_tree(root: Path, panel_tag: str, work: Path) -> Path:
    built = _builder(root).build_panel_archive(root, work, version=panel_tag.lstrip("v"), epoch=0)
    return extract_panel_archive(built.path, work / "tree")


def _git(root: Path, *args: str) -> list[str]:
    result = subprocess.run(
        ["git", *args], cwd=root, capture_output=True, text=True, encoding="utf-8", check=True
    )
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def _ancestor_tags(root: Path, ref: str = "HEAD") -> list[str]:
    tags: list[str] = []
    for line in _git(root, "log", "--simplify-by-decoration", "--format=%D", ref):
        on_commit = [part.strip()[5:] for part in line.split(",") if part.strip().startswith("tag: ")]
        # Several panel tags on one commit: the newest counts as the nearest.
        on_commit.sort(key=lambda tag: _panel_key(tag) if PANEL_TAG_RE.match(tag) else ((0, 0, 0), 0, 0), reverse=True)
        tags.extend(on_commit)
    return tags


def _is_ancestor(root: Path, ref: str, of: str = "HEAD") -> bool:
    result = subprocess.run(["git", "merge-base", "--is-ancestor", ref, of], cwd=root, capture_output=True)
    return result.returncode == 0


def _earlier_releases(root: Path, module_id: str, issued: Sequence[str]) -> tuple[dict[str, str | None], set[str]]:
    panel_of: dict[str, str | None] = {}
    included: set[str] = set()
    for other in issued:
        try:
            other_id, _ = parse_module_tag(other)
        except ValueError:
            continue
        if other_id != module_id:
            continue
        try:
            panel_of[other] = find_panel_tag(_ancestor_tags(root, f"refs/tags/{other}"))
        except ValueError:
            panel_of[other] = None
        if _is_ancestor(root, f"refs/tags/{other}"):
            included.add(other)
    return panel_of, included


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--tag", required=True, help="module-<id>-X.Y.Z")
    parser.add_argument("--panel-archive", required=True, type=Path, help="published panel archive of the base tag")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--published-file", type=Path, help="panel tags that have a GitHub Release, one per line")
    args = parser.parse_args(argv)
    root = args.root.resolve()

    def stop(errors: list[str]) -> int:
        # Exit 2 is the normal outcome (the change goes out with a panel
        # release); exit 1 is a real failure of the release.
        failures = [error for error in errors if NEEDS_PANEL not in error]
        for error in errors:
            label = "ОШИБКА" if error in failures else "ВЫПУСК ПАНЕЛИ"
            print(f"{label}: {error}", file=sys.stderr)
        return 1 if failures else EXIT_NEEDS_PANEL

    try:
        module_id, _ = parse_module_tag(args.tag)
    except ValueError as error:
        return stop([str(error)])
    errors = check_module_releasable(module_id)
    if errors:
        return stop(errors)
    versions = json.loads((root / "module-versions.json").read_text(encoding="utf-8"))
    issued = _git(root, "tag", "-l", "module-*")
    errors = check_tag_version(args.tag, versions, issued)
    if errors:
        return stop(errors)
    try:
        panel_tag = find_panel_tag(_ancestor_tags(root))
    except ValueError as error:
        return stop([str(error)])
    panel_of, included = _earlier_releases(root, module_id, issued)
    errors = check_earlier_releases_included(args.tag, panel_tag, panel_of, included)
    if errors:
        return stop(errors)
    if args.published_file:
        published = args.published_file.read_text(encoding="utf-8").split()
    else:
        published = _git(root, "tag", "-l", "v*")
    errors = check_latest_in_channel(panel_tag, published)
    if errors:
        return stop(errors)

    ownership = _module_ownership(root)
    errors = check_changed_paths(_git(root, "diff", "--name-only", f"{panel_tag}..HEAD"), ownership.get(module_id, []))
    if errors:
        return stop(errors)
    with tempfile.TemporaryDirectory() as tmp:
        extracted = _build_package_tree(root, panel_tag, Path(tmp))
        errors = compare_with_panel_archive(extracted, args.panel_archive, module_id)
    if errors:
        return stop(errors)
    print(f"Проверки выпуска {args.tag} от {panel_tag} пройдены")
    return 0


if __name__ == "__main__":
    sys.exit(main())
