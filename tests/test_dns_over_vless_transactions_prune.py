"""Снимки транзакций DNS-over-VLESS не копятся без конца.

Снимок нужен только для отката внутри той операции, что его сделала: после
неё его никто не читает.  На роутерах 45.1 и 10.1 к 29.09.2026 набралось по
60–70 каталогов с конца августа.  Каждый новый снимок убирает старые, кроме
последних ``TRANSACTIONS_KEEP``.
"""
from __future__ import annotations

from pathlib import Path

from services import dns_over_vless as dns


def _tx_dir(state: Path) -> Path:
    return state / "dns-over-vless" / "transactions"


def test_new_snapshot_keeps_only_the_latest_transactions(tmp_path):
    state = tmp_path / "state"
    tx = _tx_dir(state)
    tx.mkdir(parents=True)
    old = [f"20260801-0000{i:02d}-deadbeef" for i in range(dns.TRANSACTIONS_KEEP + 5)]
    for name in old:
        (tx / name).mkdir()
        (tx / name / "manifest.json").write_text("{}", encoding="utf-8")
    config = tmp_path / "05_routing.json"
    config.write_text("{}", encoding="utf-8")

    directory, manifest = dns._snapshot([str(config)], str(state))

    left = sorted(p.name for p in tx.iterdir())
    assert len(left) == dns.TRANSACTIONS_KEEP
    assert Path(directory).name in left
    assert Path(manifest["files"][0]["backup"]).is_file()
    assert old[0] not in left
    assert old[-1] in left


def test_prune_leaves_foreign_entries_alone(tmp_path):
    state = tmp_path / "state"
    tx = _tx_dir(state)
    tx.mkdir(parents=True)
    for i in range(dns.TRANSACTIONS_KEEP + 3):
        (tx / f"20260801-0000{i:02d}-deadbeef").mkdir()
    (tx / "notes.txt").write_text("keep me", encoding="utf-8")
    (tx / "manual-copy").mkdir()

    dns._prune_transactions(str(state))

    names = {p.name for p in tx.iterdir()}
    assert "notes.txt" in names
    assert "manual-copy" in names
    assert len([n for n in names if n.startswith("2026")]) == dns.TRANSACTIONS_KEEP


def test_prune_without_directory_is_quiet(tmp_path):
    dns._prune_transactions(str(tmp_path / "missing"))
