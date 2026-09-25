"""После обновления панели браузер не должен показывать смесь старого и нового JS.

Случай 25.09.2026, роутер 20.1: панель обновили из неё самой и сразу открыли.
На роутере всё было новым, а обычное окно показывало «наполовину старую»
панель, приватное — нормальную. Модули до обновления получили окно кэша
(`max-age=600`, см. test_static_revalidation_window), а ES-импорты идут без
`?v=`, так что браузер до 10 минут брал старые копии, не спрашивая роутер.

Отозвать выданный `max-age` сервер не может. Поэтому страница (она всегда
`no-store`) несёт номер сборки, а скрипт `js/ui/build_refresh.js` при его смене
перекачивает статику в обход кэша и один раз перезагружает страницу.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from flask import Flask, render_template

from routes.ui_assets import register_build_stamp_global
from services.build_info import build_stamp

ROOT = Path(__file__).resolve().parents[1]
APP_DIR = ROOT / "xkeen-ui"
HEAD_PARTIAL = "_top_level_host_head_assets.html"


@pytest.fixture()
def state_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    # Кандидаты BUILD.json включают каталог пакета и cwd — уводим cwd в пустой
    # каталог, чтобы локальный BUILD.json разработчика не влиял на тест.
    monkeypatch.chdir(tmp_path)
    state = tmp_path / "state"
    state.mkdir()
    return state


def _write_build(state_dir: Path, **fields: object) -> None:
    data = {"version": "v.2.8.6", "commit": "1d28c5a8", "tree_sha256": "aa" * 32, "built_utc": "2026-09-25T17:47:09Z"}
    data.update(fields)
    (state_dir / "BUILD.json").write_text(json.dumps(data), encoding="utf-8")


def _package_build_exists() -> bool:
    return (APP_DIR / "BUILD.json").is_file()


def test_stamp_is_stable_for_the_same_build(state_dir: Path) -> None:
    _write_build(state_dir)

    first = build_stamp(str(state_dir))

    assert first
    assert build_stamp(str(state_dir)) == first


def test_stamp_changes_when_the_tree_changes(state_dir: Path) -> None:
    """Локальный архив с правками поверх того же коммита — тоже новая сборка."""

    _write_build(state_dir)
    before = build_stamp(str(state_dir))

    _write_build(state_dir, tree_sha256="bb" * 32)

    assert build_stamp(str(state_dir)) != before


def test_stamp_is_safe_for_html_attributes(state_dir: Path) -> None:
    _write_build(state_dir, version='"><script>', commit="<x>")

    stamp = build_stamp(str(state_dir))

    assert stamp.isalnum()


@pytest.mark.skipif(_package_build_exists(), reason="в каталоге пакета лежит BUILD.json локальной сборки")
def test_no_build_file_means_no_stamp(state_dir: Path) -> None:
    """Без BUILD.json (разработка, e2e) сверять нечего — скрипт не подключается."""

    assert build_stamp(str(state_dir)) == ""


def _render_head(state_dir: Path) -> str:
    app = Flask(
        "build_refresh_probe",
        static_folder=str(APP_DIR / "static"),
        template_folder=str(APP_DIR / "templates"),
    )
    register_build_stamp_global(app, str(state_dir))
    with app.test_request_context("/"):
        return render_template(HEAD_PARTIAL)


def test_head_carries_refresh_script_with_build_stamp(state_dir: Path) -> None:
    _write_build(state_dir)
    stamp = build_stamp(str(state_dir))

    html = _render_head(state_dir)

    assert "js/ui/build_refresh.js" in html
    assert f'data-build-stamp="{stamp}"' in html
    # Адрес самого скрипта меняется вместе со сборкой: окно кэша не может
    # подсунуть его старую копию.
    assert f"build_refresh.js?v={stamp}" in html
    assert 'data-static-base="/static/"' in html


@pytest.mark.skipif(_package_build_exists(), reason="в каталоге пакета лежит BUILD.json локальной сборки")
def test_head_has_no_refresh_script_without_build(state_dir: Path) -> None:
    html = _render_head(state_dir)

    assert "build_refresh.js" not in html


def test_refresh_script_skips_the_same_immutable_roots_as_the_server() -> None:
    """Файлы с хэшем в имени и так уникальны для сборки — перекачивать их незачем."""

    from routes import ui_assets

    script = (APP_DIR / "static" / "js" / "ui" / "build_refresh.js").read_text(encoding="utf-8")

    for root in ui_assets._IMMUTABLE_ASSET_ROOTS:
        assert f"'{root}'" in script, root
    assert ui_assets._HASHED_ASSET_BASENAME_RE.pattern.replace("\\-", "-") in script.replace("\\-", "-")
