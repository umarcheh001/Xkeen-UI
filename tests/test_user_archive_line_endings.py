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


# --- Остальные текстовые файлы: локальный архив = релизный -------------------
#
# 25.09.2026: локальный архив с Windows вёз шаблоны, JS и HTML с CRLF, релиз из
# CI — с LF. Роутер, который ставил то один, то другой, «менял» каждый файл, а
# установщик копил резервные копии шаблонов. Приводим к LF ровно то, что git
# хранит с LF: такие CRLF в рабочем дереве добавил сам git при выгрузке. Файлы,
# которые и в репозитории лежат со смешанными окончаниями, CI отдаёт как есть —
# значит, и мы их не трогаем.

import shutil  # noqa: E402
import subprocess  # noqa: E402

import pytest  # noqa: E402


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=str(repo), check=True, capture_output=True)


@pytest.mark.skipif(shutil.which("git") is None, reason="нужен git")
def test_tracked_lf_text_is_packed_with_lf_and_mixed_files_stay_as_stored(tmp_path):
    builder = _load_builder()
    repo = tmp_path / "repo"
    project = repo / "xkeen-ui"
    (project / "templates").mkdir(parents=True)
    _git(repo, "init", "-q")
    _git(repo, "config", "core.autocrlf", "false")
    (project / "templates" / "base.jsonc").write_bytes(b"{\n  \"a\": 1\n}\n")
    (project / "mixed.js").write_bytes(b"a\r\nb\n")
    (project / "logo.png").write_bytes(b"\x89PNG\r\n\x1a\n\x00\x00")
    _git(repo, "add", "-A")
    _git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init")
    # Так их выписал бы git на Windows с core.autocrlf=true.
    (project / "templates" / "base.jsonc").write_bytes(b"{\r\n  \"a\": 1\r\n}\r\n")

    packaged = tmp_path / "pkg" / "xkeen-ui"
    shutil.copytree(project, packaged)
    lf_paths = builder.git_lf_text_paths(repo, "xkeen-ui")
    changed = builder.normalize_tracked_text_line_endings(packaged, lf_paths)

    assert changed == 1
    assert (packaged / "templates" / "base.jsonc").read_bytes() == b"{\n  \"a\": 1\n}\n"
    assert (packaged / "mixed.js").read_bytes() == b"a\r\nb\n"
    assert (packaged / "logo.png").read_bytes() == b"\x89PNG\r\n\x1a\n\x00\x00"


def test_no_git_means_nothing_extra_is_touched(tmp_path):
    builder = _load_builder()

    assert builder.git_lf_text_paths(tmp_path / "not-a-repo", "xkeen-ui") == set()


@pytest.mark.skipif(shutil.which("git") is None, reason="нужен git")
def test_real_template_is_packed_exactly_as_stored_in_git(tmp_path):
    builder = _load_builder()
    rel = "opt/etc/xray/templates/routing/05_routing_base.jsonc"
    packaged = tmp_path / "xkeen-ui"
    target = packaged / rel
    target.parent.mkdir(parents=True)
    target.write_bytes((ROOT / "xkeen-ui" / rel).read_bytes())

    builder.normalize_tracked_text_line_endings(packaged, builder.git_lf_text_paths(ROOT, "xkeen-ui"))

    stored = subprocess.run(
        ["git", "show", f"HEAD:xkeen-ui/{rel}"], cwd=str(ROOT), check=True, capture_output=True
    ).stdout
    assert target.read_bytes() == stored
