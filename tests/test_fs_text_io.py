from __future__ import annotations

from pathlib import Path

from utils.fs import load_text, save_text


def test_load_text_reads_utf8_unicode_content(tmp_path: Path):
    path = tmp_path / "zkeen.yaml"
    content = 'name: "⚡️ Fastest"\nexclude-filter: "🇷🇺"\n'
    path.write_text(content, encoding="utf-8")

    assert load_text(str(path), default=None) == content


def test_load_text_falls_back_to_cp1251_for_legacy_files(tmp_path: Path):
    path = tmp_path / "legacy.txt"
    content = "Привет из старого файла\n"
    path.write_text(content, encoding="cp1251")

    assert load_text(str(path), default=None) == content


def test_save_text_writes_utf8_unicode_content(tmp_path: Path):
    path = tmp_path / "template.yaml"
    content = "Заблок. сервисы ⚡️ 🇷🇺\n"

    save_text(str(path), content)

    assert path.read_text(encoding="utf-8") == content
