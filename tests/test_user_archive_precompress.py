"""Упаковщик кладёт рядом со статикой предсжатые .gz.

Панель отдаёт статику через gevent pywsgi, который ничего не сжимает, а жать
950 КБ CSS на лету на процессоре роутера дороже, чем сэкономить на трафике.
Поэтому сжатие уезжает на этап сборки архива: роутер только читает готовый
файл с диска.

Два свойства здесь не косметические. Сжатие обязано быть побайтово
воспроизводимым, иначе `tree_sha256` в BUILD.json перестанет опознавать
сборку. И mtime у .gz должен совпадать с исходником — на нём держится
сторож в routes/ui_assets.py, который не даёт отдать устаревший .gz.
"""

from __future__ import annotations

import gzip
import importlib.util
import json
import os
import random
import sys
import tarfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _load_builder():
    spec = importlib.util.spec_from_file_location(
        "build_user_archive", ROOT / "scripts" / "build_user_archive.py"
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(spec.name, None)
        raise
    return module


def _make_static(root: Path) -> Path:
    static = root / "static"
    static.mkdir(parents=True, exist_ok=True)
    return static


def test_large_stylesheet_gets_a_gzip_sibling(tmp_path):
    builder = _load_builder()
    static = _make_static(tmp_path)
    source = static / "styles.css"
    source.write_text(".a{color:red}\n" * 400, encoding="utf-8")

    builder.precompress_static_assets(tmp_path)

    packed = source.with_name("styles.css.gz")
    assert packed.is_file()
    assert gzip.decompress(packed.read_bytes()) == source.read_bytes()


def test_gzip_sibling_is_smaller_than_the_source(tmp_path):
    builder = _load_builder()
    static = _make_static(tmp_path)
    source = static / "panel-operator.css"
    source.write_text(".panel{display:flex}\n" * 400, encoding="utf-8")

    builder.precompress_static_assets(tmp_path)

    packed = source.with_name("panel-operator.css.gz")
    assert packed.stat().st_size < source.stat().st_size


def test_small_files_are_not_worth_a_second_file(tmp_path):
    builder = _load_builder()
    static = _make_static(tmp_path)
    source = static / "tiny.css"
    source.write_text(".a{color:red}\n", encoding="utf-8")

    builder.precompress_static_assets(tmp_path)

    assert not source.with_name("tiny.css.gz").exists()


def test_already_compressed_formats_are_left_alone(tmp_path):
    builder = _load_builder()
    static = _make_static(tmp_path)
    image = static / "logo.png"
    image.write_bytes(b"\x89PNG\r\n\x1a\n" + bytes(range(256)) * 8)
    font = static / "inter.woff2"
    font.write_bytes(b"wOF2" + bytes(range(256)) * 8)

    builder.precompress_static_assets(tmp_path)

    assert not image.with_name("logo.png.gz").exists()
    assert not font.with_name("inter.woff2.gz").exists()


def test_files_outside_static_are_left_alone(tmp_path):
    builder = _load_builder()
    _make_static(tmp_path)
    templates = tmp_path / "templates"
    templates.mkdir()
    page = templates / "panel.html"
    page.write_text("<div>x</div>\n" * 400, encoding="utf-8")

    builder.precompress_static_assets(tmp_path)

    assert not page.with_name("panel.html.gz").exists()


def test_monaco_editor_is_excluded_from_precompression(tmp_path):
    """Monaco стоил бы больше половины прироста архива, а грузится лениво.

    Редактор весит 15 МБ и подключается, только если пользователь выбрал его
    движком вместо CodeMirror. Его .gz добавили бы к архиву 3.6 МБ — больше,
    чем вся остальная статика вместе взятая, — ради пути, по которому ходят
    единицы. Браузер всё равно кладёт эти файлы в кэш после первой загрузки.
    """

    builder = _load_builder()
    static = _make_static(tmp_path)
    monaco = static / "monaco-editor" / "vs"
    monaco.mkdir(parents=True)
    inside = monaco / "editor.api.js"
    inside.write_text("const editor = 1;\n" * 400, encoding="utf-8")
    outside = static / "styles.css"
    outside.write_text(".a{color:red}\n" * 400, encoding="utf-8")

    result = builder.precompress_static_assets(tmp_path)

    assert not inside.with_name("editor.api.js.gz").exists()
    assert outside.with_name("styles.css.gz").is_file()
    assert result.files == 1


def test_incompressible_payload_does_not_get_a_useless_sibling(tmp_path):
    """Случайные байты gzip только раздувает — такой .gz нам не нужен."""

    builder = _load_builder()
    static = _make_static(tmp_path)
    source = static / "noise.json"
    source.write_bytes(random.Random(20260921).randbytes(8192))

    builder.precompress_static_assets(tmp_path)

    assert not source.with_name("noise.json.gz").exists()


def test_compression_is_byte_for_byte_reproducible(tmp_path):
    """Иначе tree_sha256 будет разным у двух сборок одного и того же кода.

    Каталоги намеренно разные: gzip по умолчанию зашивает в заголовок и время,
    и имя исходного файла, и тогда одинаковое содержимое дало бы разные байты.
    """

    builder = _load_builder()
    payload = "body{margin:0}\n" * 400

    first_root = tmp_path / "first"
    first_source = _make_static(first_root) / "alpha.css"
    first_source.write_text(payload, encoding="utf-8")

    second_root = tmp_path / "second"
    second_source = _make_static(second_root) / "beta.css"
    second_source.write_text(payload, encoding="utf-8")

    builder.precompress_static_assets(first_root)
    builder.precompress_static_assets(second_root)

    first = first_source.with_name("alpha.css.gz").read_bytes()
    second = second_source.with_name("beta.css.gz").read_bytes()
    assert first == second


def test_gzip_sibling_carries_the_source_mtime(tmp_path):
    """Сторож отдачи сравнивает mtime, поэтому .gz не должен быть «старше»."""

    builder = _load_builder()
    static = _make_static(tmp_path)
    source = static / "styles.css"
    source.write_text(".a{color:red}\n" * 400, encoding="utf-8")
    import os

    os.utime(source, (1_600_000_000, 1_600_000_000))

    builder.precompress_static_assets(tmp_path)

    packed = source.with_name("styles.css.gz")
    assert int(packed.stat().st_mtime) == int(source.stat().st_mtime)


def test_result_reports_what_was_packed(tmp_path):
    builder = _load_builder()
    static = _make_static(tmp_path)
    (static / "a.css").write_text(".a{color:red}\n" * 400, encoding="utf-8")
    (static / "b.js").write_text("const a = 1;\n" * 400, encoding="utf-8")
    (static / "skip.png").write_bytes(b"\x89PNG\r\n\x1a\n" + bytes(range(256)) * 8)

    result = builder.precompress_static_assets(tmp_path)

    assert result.files == 2
    assert result.compressed_bytes < result.original_bytes


def _pack(builder, tmp_path, monkeypatch) -> Path:
    """Собрать архив из игрушечного дерева, не трогая настоящий репозиторий."""

    project = tmp_path / "xkeen-ui"
    static = project / "static"
    static.mkdir(parents=True)
    (static / "styles.css").write_text(".a{color:red}\n" * 400, encoding="utf-8")

    monkeypatch.setattr(builder, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(builder, "PROJECT_ROOT", project)
    archive = tmp_path / "out.tar.gz"
    monkeypatch.setattr(
        sys,
        "argv",
        ["build_user_archive.py", "--skip-frontend-build", "--output", str(archive)],
    )

    assert builder.main() == 0
    return archive


def test_packaged_archive_carries_the_gzip_siblings(tmp_path, monkeypatch):
    builder = _load_builder()

    archive = _pack(builder, tmp_path, monkeypatch)

    with tarfile.open(archive) as tar:
        names = set(tar.getnames())
    assert "xkeen-ui/static/styles.css.gz" in names


def test_tree_hash_describes_the_archive_together_with_its_gzip_siblings(
    tmp_path, monkeypatch
):
    """Сжатие обязано случиться до write_build_json.

    Иначе BUILD.json опишет дерево без .gz, и проверка соответствия сборки
    на роутере будет сравнивать хэш с тем, чего в архиве нет.
    """

    builder = _load_builder()
    archive = _pack(builder, tmp_path, monkeypatch)

    unpacked = tmp_path / "unpacked"
    with tarfile.open(archive) as tar:
        tar.extractall(unpacked, filter="data")
    root = unpacked / "xkeen-ui"
    recorded = json.loads((root / "BUILD.json").read_text(encoding="utf-8"))["tree_sha256"]

    assert recorded == builder.compute_tree_sha256(root, exclude={"BUILD.json"})
