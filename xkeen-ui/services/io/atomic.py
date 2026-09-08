"""Atomic file writes.

Write to a temporary file in the same directory and then `os.replace()`.
This keeps updates crash-safe and avoids partial writes.

Временное имя уникально для каждой записи. Общее имя «путь + .tmp» ломало
одновременных пишущих: панель живёт на gevent-сервере, и один и тот же файл
пишут два запроса подряд (окно DNS-over-VLESS шлёт PATCH на каждое нажатие
кнопки раскладки). Один переименовывал файл и уносил tmp, второй падал на
os.replace с FileNotFoundError и отвечал 500, а при другом порядке публиковал
наполовину записанное чужим потоком.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
from typing import Any, Callable, Dict


# Замок на путь: подмена сама по себе атомарна, но выстраивать пишущих в
# очередь дешевле, чем разбирать, чья версия победила. Ключ — абсолютный путь,
# так что словарь растёт ровно по числу файлов, которые панель пишет.
_PATH_LOCKS: Dict[str, threading.Lock] = {}
_PATH_LOCKS_GUARD = threading.Lock()


def _path_lock(path: str) -> threading.Lock:
    key = os.path.abspath(path)
    with _PATH_LOCKS_GUARD:
        lock = _PATH_LOCKS.get(key)
        if lock is None:
            lock = threading.Lock()
            _PATH_LOCKS[key] = lock
        return lock


def _sync_dir(path: str) -> None:
    """Best-effort fsync каталога: без него подмена может пережить не всё."""
    directory = os.path.dirname(path) or "."
    try:
        fd = os.open(directory, getattr(os, "O_DIRECTORY", os.O_RDONLY))
    except Exception:
        return
    try:
        os.fsync(fd)
    except Exception:
        pass
    finally:
        try:
            os.close(fd)
        except Exception:
            pass


def _write_and_replace(path: str, write_body: Callable[[Any], None], mode: int, newline: str) -> None:
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)

    with _path_lock(path):
        # Уникальное имя в том же каталоге: os.replace атомарен только внутри
        # одной файловой системы, а суффикс не даёт двум пишущим встретиться.
        fd, tmp = tempfile.mkstemp(
            prefix=os.path.basename(path) + ".",
            suffix=".tmp",
            dir=directory,
        )
        try:
            with open(fd, "w", encoding="utf-8", errors="ignore", newline=newline) as f:
                write_body(f)
                f.flush()
                # Иначе после сбоя питания на месте настроек оказывается
                # пустой файл: подмена доехала, содержимое — нет.
                try:
                    os.fsync(f.fileno())
                except Exception:
                    pass
            try:
                os.chmod(tmp, mode)
            except Exception:
                pass
            os.replace(tmp, path)
        except BaseException:
            # Мусор рядом с настройками переживает перезагрузку и потом путает
            # и людей, и файловый менеджер панели.
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        _sync_dir(path)


def _atomic_write_text(path: str, text: str, mode: int = 0o644, *, newline: str = "\n") -> None:
    # Use a fixed newline to keep diffs predictable across platforms.
    _write_and_replace(path, lambda f: f.write(text), mode, newline)


def _atomic_write_json(
    path: str,
    obj: Any,
    mode: int = 0o644,
    *,
    ensure_ascii: bool = False,
    indent: int = 2,
    newline: str = "\n",
) -> None:
    def body(f: Any) -> None:
        json.dump(obj, f, ensure_ascii=ensure_ascii, indent=indent)
        f.write("\n")

    _write_and_replace(path, body, mode, newline)
