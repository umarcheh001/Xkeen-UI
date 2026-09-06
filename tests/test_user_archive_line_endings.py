"""Скрипты в архиве обязаны уезжать на роутер с LF.

BusyBox-шелл читает `set -e\r` как опцию `-e\r` и падает на второй строке
(«illegal option -»), поэтому один-единственный CR в install.sh делает офлайн-
установку невозможной. На Windows такие файлы появляются в рабочем дереве сами
собой: клон с core.autocrlf=true выписал их с CRLF ещё до того, как в репозиторий
добавили .gitattributes, а задним числом git рабочее дерево не перевыписывает.
Значит защищаться надо в упаковщике, а не в настройках машины сборщика.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _load_builder():
    spec = importlib.util.spec_from_file_location(
        "build_user_archive", ROOT / "scripts" / "build_user_archive.py"
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    # dataclass со строковыми аннотациями ищет собственный модуль в sys.modules,
    # поэтому регистрируем его до выполнения.
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(spec.name, None)
        raise
    return module


def test_shell_scripts_lose_crlf_before_packaging(tmp_path):
    builder = _load_builder()
    script = tmp_path / "install.sh"
    script.write_bytes(b"#!/bin/sh\r\nset -e\r\n\r\necho ok\r\n")

    builder.normalize_script_line_endings(tmp_path)

    assert script.read_bytes() == b"#!/bin/sh\nset -e\n\necho ok\n"


def test_shebang_scripts_without_suffix_lose_crlf(tmp_path):
    builder = _load_builder()
    script = tmp_path / "nested" / "runner"
    script.parent.mkdir()
    script.write_bytes(b"#!/opt/bin/python3\r\nprint('ok')\r\n")

    builder.normalize_script_line_endings(tmp_path)

    assert script.read_bytes() == b"#!/opt/bin/python3\nprint('ok')\n"


def test_binaries_and_other_files_are_left_untouched(tmp_path):
    builder = _load_builder()
    binary = tmp_path / "happ-decrypt-universal"
    binary.write_bytes(b"\x7fELF\x02\x01\x01\x00\r\n\x00\r\npayload\r\n")
    template = tmp_path / "panel.html"
    template.write_bytes(b"<div>\r\n</div>\r\n")

    builder.normalize_script_line_endings(tmp_path)

    assert binary.read_bytes() == b"\x7fELF\x02\x01\x01\x00\r\n\x00\r\npayload\r\n"
    assert template.read_bytes() == b"<div>\r\n</div>\r\n"


def test_real_installer_reaches_the_archive_without_carriage_returns(tmp_path):
    """Проверяем настоящий install.sh, а не состояние рабочего дерева.

    Само дерево на Windows вполне может лежать с CRLF — важно, что в архив
    установщик попадает пригодным для BusyBox.
    """

    builder = _load_builder()
    packaged = tmp_path / "xkeen-ui"
    packaged.mkdir()
    installer = packaged / "install.sh"
    installer.write_bytes((ROOT / "xkeen-ui" / "install.sh").read_bytes())

    builder.normalize_script_line_endings(packaged)
    content = installer.read_bytes()

    assert b"\r" not in content
    assert content.startswith(b"#!/bin/sh\nset -e\n")


def test_gitattributes_keeps_shell_scripts_on_lf():
    attributes = (ROOT / ".gitattributes").read_text(encoding="utf-8")

    assert "*.sh text eol=lf" in attributes
    assert "*.py text eol=lf" in attributes
