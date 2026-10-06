"""Слепок и проверка конфигов Xray, общие для DNS-over-VLESS и подписок."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from services import xray_transactions as tx


def test_disk_snapshot_brings_back_changed_files_and_removes_new_ones(tmp_path: Path):
    kept = tmp_path / "05_routing.json"
    absent = tmp_path / "02_dns.json"
    kept.write_text("before", encoding="utf-8")

    directory, manifest = tx.snapshot([str(kept), str(absent)], str(tmp_path / "tx"))

    kept.write_text("after", encoding="utf-8")
    absent.write_text("new", encoding="utf-8")
    tx.restore_snapshot(manifest)

    assert kept.read_text(encoding="utf-8") == "before"
    assert not absent.exists()
    assert json.loads((Path(directory) / "manifest.json").read_text(encoding="utf-8"))["id"] == manifest["id"]


def test_old_disk_snapshots_are_pruned(tmp_path: Path):
    root = tmp_path / "tx"
    for index in range(4):
        (root / f"20260101-00000{index}-0000000{index}").mkdir(parents=True)
    (root / "not-a-transaction").mkdir()

    tx.prune_transactions(str(root), keep=2)

    assert sorted(path.name for path in root.iterdir()) == [
        "20260101-000002-00000002",
        "20260101-000003-00000003",
        "not-a-transaction",
    ]


def test_memory_guard_restores_a_directory_exactly(tmp_path: Path):
    configs = tmp_path / "configs"
    configs.mkdir()
    changed = configs / "05_routing.json"
    removed = configs / "04_outbounds.json"
    state = tmp_path / "state.json"
    changed.write_bytes(b"routing\r\n")
    removed.write_bytes(b"outbounds")

    guard = tx.MemoryGuard(dirs=[str(configs)], paths=[str(state)])

    changed.write_bytes(b"rewritten")
    removed.unlink()
    (configs / "04_outbounds.sub.json").write_bytes(b"generated")
    state.write_bytes(b"{}")
    guard.restore()

    assert changed.read_bytes() == b"routing\r\n"
    assert removed.read_bytes() == b"outbounds"
    assert not (configs / "04_outbounds.sub.json").exists()
    assert not state.exists()
    assert sorted(path.name for path in configs.iterdir()) == ["04_outbounds.json", "05_routing.json"]


def test_memory_guard_leaves_subdirectories_alone(tmp_path: Path):
    configs = tmp_path / "configs"
    (configs / "backups").mkdir(parents=True)
    (configs / "backups" / "05_routing.json").write_text("copy", encoding="utf-8")

    guard = tx.MemoryGuard(dirs=[str(configs)])
    (configs / "backups" / "later.json").write_text("later", encoding="utf-8")
    guard.restore()

    assert (configs / "backups" / "later.json").exists()


def _fake_run(returncode: int, stderr: str = "", seen: list | None = None):
    def run(cmd, **_kwargs):
        if seen is not None:
            seen.append(cmd)
        return SimpleNamespace(returncode=returncode, stdout="Configuration OK.", stderr=stderr)

    return run


def test_check_reports_acceptance(monkeypatch, tmp_path: Path):
    seen: list = []
    monkeypatch.setattr(tx.subprocess, "run", _fake_run(0, seen=seen))

    verdict = tx.check_confdir(str(tmp_path), xray="/opt/sbin/xray")

    assert verdict["ok"] is True
    assert seen == [["/opt/sbin/xray", "-test", "-confdir", str(tmp_path)]]


def test_check_reports_rejection_with_the_core_message(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(tx.subprocess, "run", _fake_run(23, stderr="failed to parse 05_routing.json"))

    verdict = tx.check_confdir(str(tmp_path), xray="/opt/sbin/xray")

    assert verdict["ok"] is False
    assert "05_routing.json" in verdict["details"]


@pytest.mark.parametrize("failure", ["missing", "timeout", "crash"])
def test_check_that_could_not_be_made_is_not_a_rejection(monkeypatch, tmp_path: Path, failure: str):
    def run(cmd, **_kwargs):
        if failure == "timeout":
            raise subprocess.TimeoutExpired(cmd, 1)
        raise OSError("exec format error")

    monkeypatch.setattr(tx.subprocess, "run", run)

    verdict = tx.check_confdir(str(tmp_path), xray="" if failure == "missing" else "/opt/sbin/xray")

    assert verdict["ok"] is None


def test_staged_check_sees_the_directory_as_it_will_be(monkeypatch, tmp_path: Path):
    configs = tmp_path / "configs"
    (configs / "backups").mkdir(parents=True)
    (configs / "03_inbounds.json").write_text("{}", encoding="utf-8")
    (configs / "02_dns.json").write_text("{}", encoding="utf-8")
    (configs / "backups" / "old.json").write_text("{}", encoding="utf-8")
    staged: dict = {}

    def run(cmd, **_kwargs):
        directory = Path(cmd[-1])
        staged["names"] = sorted(path.name for path in directory.iterdir())
        staged["routing"] = json.loads((directory / "05_routing.json").read_text(encoding="utf-8"))
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(tx.subprocess, "run", run)

    verdict = tx.check_staged(
        str(configs),
        {"05_routing.json": {"routing": {"rules": []}}, "02_dns.json": None},
        xray="/opt/sbin/xray",
    )

    assert verdict["ok"] is True
    assert staged["names"] == ["03_inbounds.json", "05_routing.json"]
    assert staged["routing"] == {"routing": {"rules": []}}
    # Настоящий каталог проверка не трогает.
    assert (configs / "02_dns.json").exists()
    assert not (configs / "05_routing.json").exists()
