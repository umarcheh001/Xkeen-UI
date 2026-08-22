from __future__ import annotations

import sys

from services.geodat.install import _is_elf_binary
from services.geodat import runner


def test_geodat_binary_guard_accepts_elf_everywhere(tmp_path):
    binary = tmp_path / "xk-geodat"
    binary.write_bytes(b"\x7fELF" + b"fixture")

    assert _is_elf_binary(str(binary)) is True


def test_geodat_binary_guard_only_accepts_macho_on_macos(tmp_path):
    binary = tmp_path / "xk-geodat"
    binary.write_bytes(b"\xcf\xfa\xed\xfe" + b"fixture")

    assert _is_elf_binary(str(binary)) is (sys.platform == "darwin")


def test_geodat_helper_defaults_to_active_ui_state_dir(monkeypatch, tmp_path):
    monkeypatch.delenv("XKEEN_GEODAT_BIN", raising=False)
    monkeypatch.setattr(runner, "UI_STATE_DIR", str(tmp_path))

    assert runner._geodat_bin_path() == str(tmp_path / "bin" / "xk-geodat")
