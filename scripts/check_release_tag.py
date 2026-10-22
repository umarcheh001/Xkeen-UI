"""Guard for release tags: format and strict order (see RELEASING.md).

A tag starts the release build, so a wrong tag is a wrong release for users.
The build runs this first and stops before anything is published.

    python scripts/check_release_tag.py --tag v3.0.3-beta.1   # check a tag
    python scripts/check_release_tag.py --next                # what to tag next

Rules:
  * format: vX.Y.Z (stable) or vX.Y.Z-beta.N (beta), N from 1;
  * the version is above the latest stable and one step from it:
    X.Y.(Z+1), X.(Y+1).0 or (X+1).0.0;
  * no going below a beta line that is already open;
  * beta.1 only when the version has no betas yet, beta.N right after beta.N-1;
  * a stable tag points to a commit that is already in main.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from typing import Iterable, NamedTuple

TAG_RE = re.compile(r"^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.([1-9]\d*))?$")


class Tag(NamedTuple):
    base: tuple[int, int, int]
    beta: int  # 0 for a stable tag

    @property
    def name(self) -> str:
        base = "v%d.%d.%d" % self.base
        return f"{base}-beta.{self.beta}" if self.beta else base


def parse_tag(value: str) -> Tag | None:
    m = TAG_RE.match(str(value or "").strip())
    if not m:
        return None
    return Tag((int(m.group(1)), int(m.group(2)), int(m.group(3))), int(m.group(4) or 0))


def _steps(stable: tuple[int, int, int]) -> list[tuple[int, int, int]]:
    x, y, z = stable
    return [(x, y, z + 1), (x, y + 1, 0), (x + 1, 0, 0)]


def _fmt(base: tuple[int, int, int]) -> str:
    return "%d.%d.%d" % base


def _known(existing: Iterable[str], skip: str = "") -> list[Tag]:
    out = []
    for name in existing:
        if name == skip:
            continue
        tag = parse_tag(name)
        if tag:
            out.append(tag)
    return out


def latest_stable(tags: list[Tag]) -> tuple[int, int, int] | None:
    stables = [t.base for t in tags if not t.beta]
    return max(stables) if stables else None


def check_tag(tag_name: str, existing: Iterable[str], on_main: bool | None = None) -> list[str]:
    """Return the reasons the tag is not allowed; an empty list means it is fine."""
    tag = parse_tag(tag_name)
    if tag is None:
        return [
            f"Тег {tag_name!r} не подходит по формату. Нужно vX.Y.Z для стабильного выпуска "
            "или vX.Y.Z-beta.N для беты: без букв в конце, без точки после v, N с 1."
        ]

    # The tag being built is already in the repository; git itself refuses to
    # push a tag name twice, so the tag is simply left out of the history here.
    tags = _known(existing, skip=tag_name)

    errors: list[str] = []
    stable = latest_stable(tags)
    if stable is not None:
        if tag.base <= stable:
            errors.append(
                f"Версия {_fmt(tag.base)} не выше последнего стабильного выпуска v{_fmt(stable)}. "
                f"Следующие допустимые версии: {', '.join(_fmt(b) for b in _steps(stable))}."
            )
        elif tag.base not in _steps(stable):
            errors.append(
                f"Версия {_fmt(tag.base)} перескакивает через номера после v{_fmt(stable)}. "
                f"Допустимо: {', '.join(_fmt(b) for b in _steps(stable))}."
            )

    open_lines = sorted({t.base for t in tags if t.beta and (stable is None or t.base > stable)})
    if open_lines and tag.base < open_lines[-1]:
        errors.append(
            f"Уже идут беты v{_fmt(open_lines[-1])}; версия {_fmt(tag.base)} ниже их. "
            f"Следующая бета: {next_beta(tags, open_lines[-1]).name}."
        )

    if tag.beta:
        same = sorted(t.beta for t in tags if t.base == tag.base and t.beta)
        expected = (same[-1] + 1) if same else 1
        if tag.beta != expected:
            if same:
                errors.append(
                    f"Для {_fmt(tag.base)} последняя бета — beta.{same[-1]}, следующая должна быть "
                    f"v{_fmt(tag.base)}-beta.{expected}, а не beta.{tag.beta}."
                )
            else:
                errors.append(
                    f"Для {_fmt(tag.base)} бет ещё нет: первая должна быть v{_fmt(tag.base)}-beta.1."
                )
    elif on_main is False:
        errors.append(
            f"Стабильный тег {tag.name} должен стоять на коммите из main. "
            "Сначала перемотайте main до этого коммита (см. RELEASING.md)."
        )
    return errors


def next_beta(tags: list[Tag], base: tuple[int, int, int]) -> Tag:
    same = [t.beta for t in tags if t.base == base and t.beta]
    return Tag(base, (max(same) + 1) if same else 1)


def suggest_next(existing: Iterable[str]) -> list[str]:
    tags = _known(existing)
    stable = latest_stable(tags)
    if stable is None:
        return ["v0.1.0-beta.1"]
    open_lines = sorted({t.base for t in tags if t.beta and t.base > stable})
    if open_lines:
        line = open_lines[-1]
        return [next_beta(tags, line).name, "v%d.%d.%d" % line]
    return [Tag(_steps(stable)[0], 1).name, Tag(_steps(stable)[1], 1).name]


def _git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], capture_output=True, text=True)


def _tags_from_git() -> list[str]:
    res = _git("tag", "-l", "v*")
    if res.returncode != 0:
        raise SystemExit("git tag -l не сработал: " + res.stderr.strip())
    return [line.strip() for line in res.stdout.splitlines() if line.strip()]


def _on_main(tag_name: str) -> bool | None:
    for ref in ("origin/main", "main"):
        if _git("rev-parse", "--verify", "--quiet", ref).returncode == 0:
            return _git("merge-base", "--is-ancestor", tag_name + "^{commit}", ref).returncode == 0
    return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check a release tag against RELEASING.md.")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--tag", help="tag to check, e.g. v3.0.3-beta.1")
    group.add_argument("--next", action="store_true", help="print the tags allowed next")
    args = parser.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass

    existing = _tags_from_git()
    if args.next:
        options = suggest_next(existing)
        print("Следующий тег: " + options[0])
        if len(options) > 1:
            print("Или: " + ", ".join(options[1:]))
        return 0

    tag = args.tag.strip()
    if tag.startswith("refs/tags/"):
        tag = tag[len("refs/tags/"):]
    parsed = parse_tag(tag)
    on_main = _on_main(tag) if parsed and not parsed.beta else None
    errors = check_tag(tag, existing, on_main=on_main)
    if errors:
        print(f"Тег {tag} отклонён — выпуск не собирается. Правила: RELEASING.md.", file=sys.stderr)
        for err in errors:
            print("  - " + err, file=sys.stderr)
        return 1
    print(f"Тег {tag} в порядке.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
