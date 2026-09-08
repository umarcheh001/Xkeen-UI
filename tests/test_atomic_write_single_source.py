"""Атомарную запись ведёт один модуль, а не копия в каждом файле.

Пять модулей писали во временный файл со своим кодом и одинаковым именем
«путь + .tmp». Это та же гонка, что уронила сохранение раскладки окна
DNS-over-VLESS (см. tests/test_atomic_write_concurrency.py): двое пишущих
берут одно имя, один уносит tmp из-под другого. Чинить это по месту каждый
раз — значит однажды пропустить очередную копию.
"""

from __future__ import annotations

import re
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "xkeen-ui"))

SOURCE_DIR = ROOT / "xkeen-ui"

# Имя временного файла, собранное из пути и постоянного суффикса: у двух
# одновременных пишущих оно совпадает. Уникальные имена (с uuid, pid, временем)
# под эти образцы не подходят — их трогать не надо.
_FIXED_TMP_PATTERNS = (
    re.compile(r"""=\s*[^\n]*\+\s*["']\.tmp["']"""),
    re.compile(r"""=\s*f["']\{[^}]+\}\.tmp["']"""),
)

_SKIP_DIRS = {"frontend-build", "__pycache__", "node_modules", "vendor"}


def _sources():
    for path in SOURCE_DIR.rglob("*.py"):
        if any(part in _SKIP_DIRS for part in path.parts):
            continue
        yield path


def test_no_module_builds_its_own_fixed_temp_name():
    hits = []
    for path in _sources():
        if path.name == "atomic.py":
            continue
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if any(pattern.search(line) for pattern in _FIXED_TMP_PATTERNS):
                hits.append(f"{path.relative_to(ROOT).as_posix()}:{number}: {line.strip()}")
    assert not hits, "своя атомарная запись с общим именем tmp:\n" + "\n".join(hits)


def test_write_status_survives_concurrent_writers(tmp_path):
    """Обновление пишет свой статус, пока панель его же перечитывает.

    Проверка свойства, а не ловушка на прежний код: write_status глотает любые
    ошибки, поэтому на старой записи гонка чаще всего проходила незамеченной.
    От возврата общего имени tmp сторожит
    test_no_module_builds_its_own_fixed_temp_name.
    """
    from services.self_update.state import read_status, write_status

    status_file = str(tmp_path / "status.json")
    failures: list[str] = []

    # Статус пишется целиком, и чем он длиннее, тем шире окно, в котором
    # второй пишущий успевает влезть в тот же временный файл.
    filler = ["x" * 1000] * 200

    def worker(index: int) -> None:
        for step in range(40):
            try:
                write_status(
                    status_file,
                    {"phase": f"worker-{index}", "step": step, "log": filler},
                )
            except Exception as exc:  # noqa: BLE001
                failures.append(f"{type(exc).__name__}: {exc}")

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not failures, failures[:3]
    # Статус переживает гонку целым: пустой или обрезанный файл панель
    # показала бы как «обновление не запускалось».
    assert read_status(status_file).get("phase", "").startswith("worker-")
    # Сама write_status ошибки глотает (статус диагностический, ронять API им
    # нельзя), поэтому о сорванной подмене говорит только оставшийся мусор.
    leftovers = sorted(p.name for p in tmp_path.iterdir() if p.name != "status.json")
    assert leftovers == [], f"остался мусор: {leftovers}"


def test_operation_diagnostic_survives_concurrent_writers(tmp_path):
    from services.operation_diagnostics import read_operation_diagnostic, save_operation_diagnostic

    failures: list[str] = []

    def worker(index: int) -> None:
        for step in range(30):
            try:
                save_operation_diagnostic(
                    str(tmp_path),
                    "job-1",
                    kind="restart",
                    payload={"who": index, "step": step},
                )
            except Exception as exc:  # noqa: BLE001
                failures.append(f"{type(exc).__name__}: {exc}")

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not failures, failures[:3]
    assert read_operation_diagnostic(str(tmp_path), "job-1") is not None
