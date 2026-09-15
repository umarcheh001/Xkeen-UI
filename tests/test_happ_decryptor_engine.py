"""happ-decrypt-universal binary: asset choice, ELF checks, checksum-gated install with backup."""

from __future__ import annotations

import hashlib
import json
import os
import struct
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
APP_DIR = ROOT / "xkeen-ui"
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

from services.happ_decryptor import engine  # noqa: E402
from services.happ_decryptor.errors import HappDecryptorError  # noqa: E402

BASE = "https://github.com/umarcheh001/Xkeen-UI/releases/latest/download/"
ARM64 = "happ-decrypt-universal-linux-arm64"
FULL_SELFTEST = {
    "version": "v1", "assets_dir": "x", "formats": ["crypt", "crypt2", "crypt3", "crypt4", "crypt5"],
    "crypt5_keys": {"present": True, "keys": 36, "invalid": 0},
    "legacy_keys": {"present": True, "keys": 4, "invalid": 0},
    "keyset_sha256": "f" * 64,
}


def _elf(arch: str) -> bytes:
    if arch == "arm64":
        head = b"\x7fELF\x02\x01\x01" + b"\0" * 11 + struct.pack("<H", 183)
    elif arch == "mipsle":
        head = b"\x7fELF\x01\x01\x01" + b"\0" * 11 + struct.pack("<H", 8)
    else:
        head = b"\x7fELF\x01\x02\x01" + b"\0" * 11 + struct.pack(">H", 8)
    return head + os.urandom(512)


class FakeFetch:
    def __init__(self, by_url: dict[str, bytes]) -> None:
        self.by_url = by_url
        self.calls: list[str] = []

    def __call__(self, url: str, dest: str, max_bytes: int) -> int:
        self.calls.append(url)
        if url not in self.by_url:
            raise RuntimeError("http_404")
        Path(dest).write_bytes(self.by_url[url])
        return len(self.by_url[url])


class FakeRun:
    def __init__(self, version=(0, "happ-decrypt-universal v9.9.9 (abc1234)\n", ""), selftest=None) -> None:
        self.version = version
        self.selftest_result = selftest
        self.calls: list[list[str]] = []

    def __call__(self, argv, timeout):
        self.calls.append(list(argv))
        if "-version" in argv:
            return self.version
        if "-selftest" in argv:
            return self.selftest_result or (3, json.dumps({"formats": []}), "")
        return (2, "", "usage")


def _sums(**entries: bytes) -> bytes:
    return "".join(f"{hashlib.sha256(data).hexdigest()}  dist/{name}\n" for name, data in entries.items()).encode()


@pytest.fixture()
def bin_path(tmp_path):
    (tmp_path / "bin").mkdir()
    path = tmp_path / "bin" / "happ-decrypt-universal"
    path.write_bytes(b"#!/usr/bin/env node\nconsole.log('old');\n")
    return path


@pytest.mark.parametrize(
    "machine,opkg,endian,asset",
    [
        ("aarch64", "aarch64-3.10", "le", ARM64),
        ("mips", "mipsel-3.4", "", "happ-decrypt-universal-linux-mipsle"),
        ("mips", "mips-3.4", "be", "happ-decrypt-universal-linux-mips"),
        ("mips", "", "le", "happ-decrypt-universal-linux-mipsle"),
        ("mips", "", "", "happ-decrypt-universal-linux-mipsle"),
        ("x86_64", "", "le", ""),
    ],
)
def test_release_asset_matches_router_platform(machine, opkg, endian, asset):
    assert engine.release_asset(machine, opkg, endian) == asset


@pytest.mark.parametrize("arch", ["arm64", "mips", "mipsle"])
def test_elf_arch_reads_machine_and_byte_order(tmp_path, arch):
    path = tmp_path / "bin"
    path.write_bytes(_elf(arch))
    assert engine.elf_arch(str(path)) == arch


def test_elf_arch_rejects_other_files(tmp_path):
    path = tmp_path / "page.html"
    path.write_bytes(b"<!doctype html><title>blocked</title>")
    assert engine.elf_arch(str(path)) is None


def test_parse_sha256sums_matches_whole_asset_name():
    mips, mipsle = "a" * 64, "b" * 64
    text = f"{mipsle}  dist/happ-decrypt-universal-linux-mipsle\n{mips} *happ-decrypt-universal-linux-mips\n"
    assert engine.parse_sha256sums(text, "happ-decrypt-universal-linux-mips") == mips
    assert engine.parse_sha256sums(text, "happ-decrypt-universal-linux-mipsle") == mipsle
    assert engine.parse_sha256sums(text, ARM64) is None


def test_install_engine_downloads_checks_and_replaces_with_backup(bin_path):
    binary = _elf("arm64")
    old = bin_path.read_bytes()
    fetch = FakeFetch({BASE + ARM64: binary, BASE + "SHA256SUMS": _sums(**{ARM64: binary})})
    run = FakeRun()

    result = engine.install_engine(str(bin_path), asset=ARM64, release_base=BASE, fetch=fetch, run=run)

    assert bin_path.read_bytes() == binary
    assert Path(str(bin_path) + ".bak").read_bytes() == old
    assert result["version"] == "happ-decrypt-universal v9.9.9 (abc1234)"
    assert sorted(p.name for p in bin_path.parent.iterdir()) == ["happ-decrypt-universal", "happ-decrypt-universal.bak"]
    if os.name != "nt":
        assert os.access(bin_path, os.X_OK)
    assert run.calls and run.calls[0][0] != str(bin_path), "the candidate runs before it replaces the old binary"


@pytest.mark.parametrize(
    "sums,code",
    [(b"", "checksum_missing"), (None, "checksum_missing"), ("mismatch", "checksum_mismatch")],
    ids=["no-entry", "no-file", "mismatch"],
)
def test_install_engine_requires_the_published_checksum(bin_path, sums, code):
    binary = _elf("arm64")
    by_url = {BASE + ARM64: binary}
    if sums == "mismatch":
        by_url[BASE + "SHA256SUMS"] = _sums(**{ARM64: b"other bytes"})
    elif sums is not None:
        by_url[BASE + "SHA256SUMS"] = sums
    old = bin_path.read_bytes()

    with pytest.raises(HappDecryptorError) as exc:
        engine.install_engine(str(bin_path), asset=ARM64, release_base=BASE, fetch=FakeFetch(by_url), run=FakeRun())

    assert exc.value.code == code
    assert bin_path.read_bytes() == old
    assert [p.name for p in bin_path.parent.iterdir()] == ["happ-decrypt-universal"]


@pytest.mark.parametrize(
    "payload,run,code",
    [
        (_elf("mips"), FakeRun(), "wrong_arch"),
        (b"<!doctype html>blocked", FakeRun(), "not_elf"),
        (_elf("arm64"), FakeRun(version=(126, "", "Exec format error")), "sanity_failed"),
        (_elf("arm64"), FakeRun(version=(0, "something else\n", "")), "sanity_failed"),
    ],
    ids=["wrong-arch", "html", "does-not-run", "other-program"],
)
def test_install_engine_keeps_old_binary_when_candidate_is_bad(bin_path, payload, run, code):
    fetch = FakeFetch({BASE + ARM64: payload, BASE + "SHA256SUMS": _sums(**{ARM64: payload})})
    old = bin_path.read_bytes()

    with pytest.raises(HappDecryptorError) as exc:
        engine.install_engine(str(bin_path), asset=ARM64, release_base=BASE, fetch=fetch, run=run)

    assert exc.value.code == code
    assert bin_path.read_bytes() == old
    assert [p.name for p in bin_path.parent.iterdir()] == ["happ-decrypt-universal"]


def test_install_engine_reports_download_failure(bin_path):
    with pytest.raises(HappDecryptorError) as exc:
        engine.install_engine(str(bin_path), asset=ARM64, release_base=BASE, fetch=FakeFetch({}), run=FakeRun())
    assert exc.value.code == "download_failed"


def test_install_engine_from_uploaded_file_skips_download(bin_path, tmp_path):
    upload = tmp_path / "upload"
    upload.write_bytes(_elf("arm64"))
    fetch = FakeFetch({})

    engine.install_engine(str(bin_path), asset=ARM64, fetch=fetch, run=FakeRun(), local_file=str(upload))

    assert fetch.calls == []
    assert bin_path.read_bytes() == upload.read_bytes()
    assert upload.exists(), "the caller owns the uploaded file"


def test_detect_kind(tmp_path):
    native, node, other = tmp_path / "native", tmp_path / "node", tmp_path / "other"
    native.write_bytes(_elf("arm64"))
    node.write_bytes(b"#!/usr/bin/env node\n")
    other.write_bytes(b"#!/bin/sh\necho hi\n")
    assert engine.detect_kind(str(native)) == "native"
    assert engine.detect_kind(str(node)) == "node"
    assert engine.detect_kind(str(other)) == "other"
    assert engine.detect_kind(str(tmp_path / "missing")) == "missing"


def test_verify_keys_with_engine_accepts_complete_usable_set(tmp_path):
    run = FakeRun(selftest=(0, json.dumps(FULL_SELFTEST), ""))
    engine.verify_keys_with_engine("/bin/engine", str(tmp_path), run)
    assert run.calls == [["/bin/engine", "-selftest", "-assets", str(tmp_path)]]


@pytest.mark.parametrize(
    "report",
    [
        {**FULL_SELFTEST, "crypt5_keys": {"present": True, "keys": 36, "invalid": 1}},
        {**FULL_SELFTEST, "formats": ["crypt", "crypt2", "crypt3", "crypt4"]},
        {**FULL_SELFTEST, "legacy_keys": {"present": True, "keys": 4, "invalid": 0, "error": "bad json"}},
        None,
    ],
    ids=["invalid-key", "missing-format", "file-error", "no-report"],
)
def test_verify_keys_with_engine_rejects_unusable_set(tmp_path, report):
    result = (3, "not json", "") if report is None else (0, json.dumps(report), "")
    with pytest.raises(HappDecryptorError) as exc:
        engine.verify_keys_with_engine("/bin/engine", str(tmp_path), FakeRun(selftest=result))
    assert exc.value.code == "keys_check_failed"


def test_status_reports_engine_keys_and_their_origin(bin_path):
    bin_path.write_bytes(_elf("arm64"))
    assets = Path(str(bin_path) + ".assets")
    assets.mkdir()
    (assets / "happ-keys.json").write_text(json.dumps({"files": {"crypt5-keys.json": {"commit": "a" * 40}}}), encoding="utf-8")
    run = FakeRun(selftest=(0, json.dumps(FULL_SELFTEST), ""))

    st = engine.status(str(bin_path), run, platform={"asset": ARM64, "supported": True})

    assert st["kind"] == "native" and st["installed"] is True
    assert st["version"] == "happ-decrypt-universal v9.9.9 (abc1234)"
    assert st["keys"]["formats"] == FULL_SELFTEST["formats"]
    assert st["keys_meta"]["files"]["crypt5-keys.json"]["commit"] == "a" * 40
    assert st["platform"] == {"asset": ARM64, "supported": True}


def test_status_for_the_old_node_decryptor_does_not_run_it(bin_path):
    run = FakeRun()
    st = engine.status(str(bin_path), run, platform={})
    assert st["kind"] == "node" and st["installed"] is False and st["keys"] is None
    assert run.calls == []
