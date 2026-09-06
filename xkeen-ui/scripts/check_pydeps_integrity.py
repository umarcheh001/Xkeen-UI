#!/opt/bin/python3
"""Проверка целостности установленных python-пакетов по dist-info/RECORD.

Зачем это нужно. Битую распаковку колеса не ловит ни `pip list`, ни `pip check`:
метаданные пакета целы, pip считает его установленным и на `pip install` отвечает
«Requirement already satisfied». Проваливается только импорт — и уже последствием,
где-нибудь в середине чужого traceback.

Реальный случай (роутер, 06.09.2026): у gevent 25.9.1 файл
`_gevent_c_greenlet_primitives.cpython-313-aarch64-linux-gnu.so` лежал на диске с
именем без последней буквы — `...gnu.s`. Содержимое целое, имя обрезано. Импорт
gevent падал, панель молча уходила на Werkzeug без WebSocket.

Скрипт сверяет список файлов из RECORD с тем, что реально лежит на диске, и
отдельно называет «обрезанные» файлы — те, чьё имя является префиксом ожидаемого.

Коды возврата: 0 — всё цело, 1 — есть потери, 2 — ошибка вызова.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
import sysconfig
from pathlib import Path
from typing import Dict, List, Optional

# Эти записи RECORD не считаем потерями: интерпретатор создаёт и чистит их сам.
_IGNORED_PARTS = ("__pycache__",)
_IGNORED_SUFFIXES = (".pyc", ".pyo")


def default_site_packages() -> Path:
    """Каталог site-packages текущего интерпретатора."""

    return Path(sysconfig.get_paths()["purelib"])


def _normalize(package: str) -> str:
    return package.replace("-", "_").lower()


def find_dist_info(site_packages: Path, package: str) -> Optional[Path]:
    """Ищет каталог `<package>-<version>.dist-info` без учёта регистра и дефисов."""

    wanted = _normalize(package)
    try:
        candidates = sorted(site_packages.glob("*.dist-info"))
    except OSError:
        return None

    for candidate in candidates:
        name = candidate.name[: -len(".dist-info")]
        dist_name = name.rsplit("-", 1)[0]
        if _normalize(dist_name) == wanted:
            return candidate
    return None


def _is_ignored(rel_path: str) -> bool:
    if rel_path.endswith(_IGNORED_SUFFIXES):
        return True
    parts = rel_path.replace("\\", "/").split("/")
    return any(part in _IGNORED_PARTS for part in parts)


def _read_record(record_path: Path) -> List[str]:
    entries: List[str] = []
    with record_path.open("r", encoding="utf-8", newline="") as fh:
        for row in csv.reader(fh):
            if not row or not row[0].strip():
                continue
            entries.append(row[0].strip())
    return entries


def _find_truncated_sibling(site_packages: Path, rel_path: str) -> Optional[str]:
    """Ищет файл, чьё имя — обрезанный вариант ожидаемого.

    Именно так выглядел сбой на роутере: `...gnu.so` в RECORD, `...gnu.s` на диске.
    """

    expected = site_packages / rel_path
    parent = expected.parent
    if not parent.is_dir():
        return None

    name = expected.name
    try:
        siblings = list(parent.iterdir())
    except OSError:
        return None

    best: Optional[str] = None
    for sibling in siblings:
        candidate = sibling.name
        if candidate == name or not candidate:
            continue
        if not name.startswith(candidate):
            continue
        if best is None or len(candidate) > len(best):
            best = candidate

    if best is None:
        return None
    return (parent / best).relative_to(site_packages).as_posix()


def check_record_integrity(site_packages: Path, package: str) -> Dict[str, object]:
    """Сверяет файлы пакета с его RECORD.

    Возвращает словарь со статусом `ok` / `broken` / `missing_metadata`, списком
    потерянных путей и картой «ожидаемый путь → найденный обрезанный файл».
    """

    site_packages = Path(site_packages)
    report: Dict[str, object] = {
        "package": package,
        "status": "missing_metadata",
        "dist_info": None,
        "missing": [],
        "truncated": {},
    }

    dist_info = find_dist_info(site_packages, package)
    if dist_info is None:
        return report

    report["dist_info"] = dist_info.name
    record_path = dist_info / "RECORD"
    if not record_path.is_file():
        return report

    missing: List[str] = []
    truncated: Dict[str, str] = {}
    for rel_path in _read_record(record_path):
        if _is_ignored(rel_path):
            continue
        if (site_packages / rel_path).exists():
            continue
        missing.append(rel_path)
        sibling = _find_truncated_sibling(site_packages, rel_path)
        if sibling:
            truncated[rel_path] = sibling

    report["missing"] = missing
    report["truncated"] = truncated
    report["status"] = "broken" if missing else "ok"
    return report


def _print_human(report: Dict[str, object]) -> None:
    package = report["package"]
    status = report["status"]

    if status == "ok":
        print("[*] %s: все файлы на месте." % package)
        return
    if status == "missing_metadata":
        print("[*] %s: не установлен (нет dist-info), пропускаю." % package)
        return

    missing = report["missing"]
    truncated = report["truncated"]
    print("[!] %s: установка повреждена, потеряно файлов: %d" % (package, len(missing)))
    for rel_path in missing[:10]:
        sibling = truncated.get(rel_path) if isinstance(truncated, dict) else None
        if sibling:
            print("    - %s (на диске лежит обрезанное имя: %s)" % (rel_path, sibling))
        else:
            print("    - %s" % rel_path)
    if len(missing) > 10:
        print("    ... и ещё %d" % (len(missing) - 10))


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("packages", nargs="+", help="имена пакетов, например gevent")
    parser.add_argument(
        "--site-packages",
        default=None,
        help="каталог site-packages (по умолчанию — текущего интерпретатора)",
    )
    parser.add_argument("--json", action="store_true", help="выдать отчёт в JSON")
    args = parser.parse_args(argv)

    site_packages = Path(args.site_packages) if args.site_packages else default_site_packages()

    reports = {pkg: check_record_integrity(site_packages, pkg) for pkg in args.packages}
    broken = any(rep["status"] == "broken" for rep in reports.values())

    if args.json:
        print(json.dumps(reports, ensure_ascii=False, indent=2))
    else:
        for report in reports.values():
            _print_human(report)

    return 1 if broken else 0


if __name__ == "__main__":
    sys.exit(main())
