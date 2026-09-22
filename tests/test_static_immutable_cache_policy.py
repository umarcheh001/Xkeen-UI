"""Вечный кэш положен только файлам, у которых хэш стоит в имени.

Редактор Monaco занимает ~15 МБ и собран с хэшами в именах, но лежит не в
`assets/`, а в своём каталоге. Из-за этого он получал `max-age=0`, и браузер
перепроверял все 15 МБ при каждой загрузке панели.

Обратная сторона важнее: внутри того же каталога есть файлы БЕЗ хэша
(`loader.js`, `editor.main.js`, `monaco.contribution.js`, `nls.messages.*`).
Если выдать вечный кэш им, после обновления панели браузер останется со старым
загрузчиком и новый редактор не подхватит.

Здесь проверяется только вечный кэш, поэтому корень статики не передаётся и
ответ считается по имени файла. Короткое окно, которое обычная статика всё же
получает, живёт в tests/test_static_revalidation_window.py.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from routes.ui_assets import (
    get_static_asset_max_age,
    is_hashed_build_asset_filename,
    is_hashed_build_asset_path,
)

IMMUTABLE = 31536000
STATIC_ROOT = Path("xkeen-ui/static")


@pytest.mark.parametrize(
    "filename",
    [
        "monaco-editor/vs/abap-D-t0cyap.js",
        "monaco-editor/vs/_commonjsHelpers-CT9FvmAN.js",
        "monaco-editor/vs/assets/editor.worker-Be8ye1pW.js",
        "monaco-editor/vs/language/typescript/tsMode-BRuWHLnd.js",
    ],
)
def test_hashed_monaco_files_are_immutable(filename: str) -> None:
    assert get_static_asset_max_age(filename) == IMMUTABLE


@pytest.mark.parametrize(
    "filename",
    [
        "monaco-editor/vs/loader.js",
        "monaco-editor/vs/editor/editor.main.js",
        "monaco-editor/vs/editor/editor.main.css",
        "monaco-editor/vs/basic-languages/monaco.contribution.js",
        "monaco-editor/vs/nls.messages.ru.js.js",
        "monaco-editor/vs/nls.messages-loader.js",
    ],
)
def test_unhashed_monaco_files_are_not_immutable(filename: str) -> None:
    assert get_static_asset_max_age(filename) == 0


@pytest.mark.parametrize(
    "filename",
    [
        "frontend-build/assets/panel-CUjr_s6j.js",
        "assets/panel-CUjr_s6j.js",
    ],
)
def test_bundle_assets_stay_immutable(filename: str) -> None:
    assert get_static_asset_max_age(filename) == IMMUTABLE


@pytest.mark.parametrize(
    "filename",
    [
        # Дефис и восемь символов после него ещё не делают имя хэшированным:
        # эти файлы правятся на месте и обязаны перепроверяться.
        "auth-operator.css",
        "panel-operator.css",
        "js/ui/xk_brand.js",
        "styles.css",
    ],
)
def test_ordinary_static_is_never_immutable(filename: str) -> None:
    assert get_static_asset_max_age(filename) == 0


def test_path_form_agrees_with_filename_form() -> None:
    path = "/static/monaco-editor/vs/abap-D-t0cyap.js"
    assert is_hashed_build_asset_path(path)
    assert is_hashed_build_asset_filename("monaco-editor/vs/abap-D-t0cyap.js")


@pytest.mark.skipif(not STATIC_ROOT.is_dir(), reason="нет дерева статики")
def test_every_real_monaco_file_is_classified_by_its_own_name() -> None:
    """Сверка с настоящим деревом: решает имя файла, а не каталог."""

    hashed_basename = re.compile(r"^.+-[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9]+$")
    mismatched = []
    for path in sorted((STATIC_ROOT / "monaco-editor").rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(STATIC_ROOT).as_posix()
        expected = IMMUTABLE if hashed_basename.match(path.name) else 0
        if get_static_asset_max_age(rel) != expected:
            mismatched.append(rel)

    assert mismatched == []
