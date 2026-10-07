"""Блокировка обновления не переживает своего владельца.

Блокировка считалась живой, пока существует процесс с записанным номером. После
перезагрузки роутера номера раздаются заново и почти так же, как в прошлый раз:
чужой процесс получал номер погибшего владельца, и обновление вместе с
переключателями модулей оставалось запертым навсегда. Теперь блокировка помнит
загрузку роутера и момент старта своего процесса.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from services.self_update import state


@pytest.fixture
def identity(monkeypatch):
    """Загрузка роутера и время старта процессов под управлением теста."""

    world = {"boot": "boot-a", "starts": {os.getpid(): 1000}}
    monkeypatch.setattr(state, "_current_boot_id", lambda: world["boot"])
    monkeypatch.setattr(state, "_process_start_ticks", lambda pid: world["starts"].get(int(pid)))
    return world


def _lock(tmp_path: Path) -> str:
    return str(tmp_path / "update.lock")


def test_a_lock_records_the_boot_and_the_start_of_its_owner(tmp_path, identity):
    lock = _lock(tmp_path)

    acquired, info = state.try_acquire_lock(lock)

    recorded = json.loads(Path(lock).read_text(encoding="utf-8"))
    assert acquired and info["alive"]
    assert recorded["pid"] == os.getpid()
    assert recorded["boot_id"] == "boot-a"
    assert recorded["start_ticks"] == 1000
    assert state.read_lock(lock)["alive"] is True


def test_a_lock_from_before_the_reboot_is_abandoned_whoever_has_its_pid(tmp_path, identity):
    lock = _lock(tmp_path)
    assert state.try_acquire_lock(lock)[0]
    identity["boot"] = "boot-b"

    info = state.read_lock(lock)

    # Процесс с таким номером жив (это мы сами), но это уже другая загрузка.
    assert (info["alive"], info["stale"]) == (False, True)
    assert state.try_acquire_lock(lock)[0]


def test_a_lock_is_abandoned_when_its_pid_now_names_another_process(tmp_path, identity):
    lock = _lock(tmp_path)
    assert state.try_acquire_lock(lock)[0]
    identity["starts"][os.getpid()] = 2000

    info = state.read_lock(lock)

    assert (info["alive"], info["stale"]) == (False, True)


def test_a_lock_written_by_older_code_is_judged_by_the_pid_alone(tmp_path, identity):
    lock = _lock(tmp_path)
    Path(lock).write_text(json.dumps({"pid": os.getpid(), "created_ts": 1.0}), encoding="utf-8")

    assert state.read_lock(lock)["alive"] is True


def test_a_system_that_cannot_tell_the_boot_falls_back_to_the_pid(tmp_path, identity, monkeypatch):
    lock = _lock(tmp_path)
    assert state.try_acquire_lock(lock)[0]
    monkeypatch.setattr(state, "_current_boot_id", lambda: None)
    monkeypatch.setattr(state, "_process_start_ticks", lambda _pid: None)

    assert state.read_lock(lock)["alive"] is True


def test_a_transferred_lock_takes_the_identity_of_its_new_owner(tmp_path, identity):
    lock = _lock(tmp_path)
    Path(lock).write_text(
        json.dumps({"pid": 4242, "created_ts": 1.0, "boot_id": "boot-a", "start_ticks": 7}), encoding="utf-8"
    )

    assert state.transfer_lock(lock, 4242)

    recorded = json.loads(Path(lock).read_text(encoding="utf-8"))
    assert (recorded["pid"], recorded["boot_id"], recorded["start_ticks"]) == (os.getpid(), "boot-a", 1000)
