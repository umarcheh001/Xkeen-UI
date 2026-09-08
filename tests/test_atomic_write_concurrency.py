"""Атомарная запись под несколькими пишущими сразу.

Панель живёт на gevent-сервере, и один и тот же файл настроек могут писать
два запроса подряд: окно DNS-over-VLESS шлёт PATCH на каждое нажатие кнопки
раскладки. Пока временный файл назывался «путь + .tmp», пишущие брали одно и
то же имя: один переименовывал файл и уносил tmp, второй падал на
os.replace, а в худшем случае публиковал наполовину записанное чужим потоком.
"""

from __future__ import annotations

import os
import sys
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "xkeen-ui"))

from services.io.atomic import _atomic_write_json, _atomic_write_text  # noqa: E402


# Текст должен быть заметно больше буфера записи: на коротких строках
# перекрытие ловится редко и тест становится флаком.
_CHUNK = 200_000
_ROUNDS = 40
_WRITERS = 4


def _texts(count: int) -> dict[int, str]:
    return {i: (chr(ord("A") + i) * _CHUNK + "\n") for i in range(count)}


def _run_writers(target, worker) -> list[str]:
    failures: list[str] = []
    lock = threading.Lock()

    def guarded(index: int) -> None:
        try:
            worker(index)
        except Exception as exc:  # noqa: BLE001
            with lock:
                failures.append(f"{type(exc).__name__}: {exc}")

    threads = [threading.Thread(target=guarded, args=(i,)) for i in range(_WRITERS)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return failures


def test_concurrent_text_writes_never_fail(tmp_path):
    path = str(tmp_path / "settings.json")
    texts = _texts(_WRITERS)

    def worker(index: int) -> None:
        for _ in range(_ROUNDS):
            _atomic_write_text(path, texts[index])

    failures = _run_writers(path, worker)
    assert not failures, f"запись упала {len(failures)} раз: {failures[:3]}"


def test_concurrent_text_writes_leave_one_whole_version(tmp_path):
    """Победитель гонки не важен, важно что файл целый, а не смесь двух."""
    path = str(tmp_path / "settings.json")
    texts = _texts(_WRITERS)

    def worker(index: int) -> None:
        for _ in range(_ROUNDS):
            try:
                _atomic_write_text(path, texts[index])
            except Exception:
                pass

    _run_writers(path, worker)
    assert os.path.isfile(path)
    assert Path(path).read_text(encoding="utf-8") in set(texts.values())


def test_concurrent_readers_always_see_a_whole_file(tmp_path):
    """Читающий никогда не должен увидеть пустоту вместо настроек."""
    path = str(tmp_path / "settings.json")
    texts = _texts(_WRITERS)
    _atomic_write_text(path, texts[0])

    missing: list[str] = []
    partial: list[int] = []
    stop = threading.Event()

    def reader() -> None:
        while not stop.is_set():
            try:
                data = Path(path).read_text(encoding="utf-8")
            except FileNotFoundError:
                missing.append("файл пропал во время подмены")
                continue
            except PermissionError:
                # Windows не даёт переименовать поверх открытого файла и
                # наоборот; на роутере (Linux) этого нет, и для нас это шум ОС.
                continue
            if data not in texts.values():
                partial.append(len(data))

    watcher = threading.Thread(target=reader, daemon=True)
    watcher.start()
    try:
        def worker(index: int) -> None:
            for _ in range(_ROUNDS):
                try:
                    _atomic_write_text(path, texts[index])
                except Exception:
                    pass

        _run_writers(path, worker)
    finally:
        stop.set()
        watcher.join(timeout=5)

    assert not missing, missing[:3]
    assert not partial, f"прочитаны куски длиной {partial[:5]}"


def test_concurrent_json_writes_never_fail(tmp_path):
    path = str(tmp_path / "state.json")
    payloads = {i: {"who": i, "filler": ["x" * 1000] * 200} for i in range(_WRITERS)}

    def worker(index: int) -> None:
        for _ in range(_ROUNDS):
            _atomic_write_json(path, payloads[index])

    failures = _run_writers(path, worker)
    assert not failures, f"запись упала {len(failures)} раз: {failures[:3]}"


def test_failed_write_leaves_no_temp_file(tmp_path, monkeypatch):
    """Сбой подмены не должен оставлять мусор рядом с настройками."""
    path = str(tmp_path / "settings.json")

    def boom(src, dst):  # noqa: ANN001
        raise OSError("подмена не удалась")

    monkeypatch.setattr(os, "replace", boom)
    with pytest.raises(OSError):
        _atomic_write_text(path, "не доедет\n")

    leftovers = sorted(p.name for p in tmp_path.iterdir())
    assert leftovers == [], f"остался мусор: {leftovers}"


def test_write_survives_a_stale_temp_file(tmp_path):
    """Прерванная прошлая запись не должна мешать следующей."""
    path = str(tmp_path / "settings.json")
    stale = tmp_path / "settings.json.tmp"
    stale.write_text("огрызок прошлой записи", encoding="utf-8")

    _atomic_write_text(path, "свежие настройки\n")
    assert Path(path).read_text(encoding="utf-8") == "свежие настройки\n"
