"""Повторный вход в панель не должен перепроверять всю статику заново.

Замер 22.09.2026: повторная загрузка панели — 186 запросов, и только один
ответ пришёл из кэша браузера. Остальное — условные запросы с пустым телом:
трафика почти нет, но на процессоре роутера это сотни лишних обработок на
каждый переход между вкладками.

Файлы с хэшем в имени уже получают вечный кэш (см.
test_static_immutable_cache_policy). Здесь — про обычную статику: ей даётся
короткое окно без перепроверки, но только если файл давно не менялся. Правка
файла прямо на роутере по SSH обязана быть видна сразу.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import pytest

from routes.ui_assets import get_static_asset_max_age

IMMUTABLE = 31536000
DEFAULT_WINDOW = 600


@pytest.fixture()
def static_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    for name in ("XKEEN_UI_STATIC_CACHE_SECONDS", "XKEEN_DEV", "FLASK_DEBUG", "FLASK_ENV"):
        monkeypatch.delenv(name, raising=False)
    # Каталог должен называться именно static: от его имени Flask берёт
    # префикс URL, и на tmp_path отдача уехала бы на другой адрес.
    root = tmp_path / "static"
    root.mkdir()
    return root


def _make_file(root: Path, rel: str, age_seconds: float) -> None:
    target = root / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("// файл панели\n", encoding="utf-8")
    stamp = time.time() - age_seconds
    os.utime(target, (stamp, stamp))


def test_long_untouched_file_gets_a_revalidation_free_window(static_root: Path) -> None:
    _make_file(static_root, "js/util/helpers.js", age_seconds=7 * 24 * 3600)

    assert get_static_asset_max_age("js/util/helpers.js", static_root) == DEFAULT_WINDOW


def test_recently_changed_file_is_always_rechecked(static_root: Path) -> None:
    """Правка по SSH и перезапись файла обновлением — видны сразу."""

    _make_file(static_root, "js/util/helpers.js", age_seconds=30)

    assert get_static_asset_max_age("js/util/helpers.js", static_root) == 0


def test_hashed_asset_stays_immutable_regardless_of_age(static_root: Path) -> None:
    _make_file(static_root, "frontend-build/assets/panel-CUjr_s6j.js", age_seconds=5)

    assert (
        get_static_asset_max_age("frontend-build/assets/panel-CUjr_s6j.js", static_root)
        == IMMUTABLE
    )


def test_window_is_configurable_and_zero_turns_caching_off(
    static_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _make_file(static_root, "styles.css", age_seconds=7 * 24 * 3600)

    monkeypatch.setenv("XKEEN_UI_STATIC_CACHE_SECONDS", "120")
    assert get_static_asset_max_age("styles.css", static_root) == 120

    monkeypatch.setenv("XKEEN_UI_STATIC_CACHE_SECONDS", "0")
    assert get_static_asset_max_age("styles.css", static_root) == 0


def test_development_runtime_never_caches(
    static_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _make_file(static_root, "styles.css", age_seconds=7 * 24 * 3600)
    monkeypatch.setenv("XKEEN_DEV", "1")

    assert get_static_asset_max_age("styles.css", static_root) == 0


def test_unknown_root_or_missing_file_falls_back_to_rechecking(static_root: Path) -> None:
    assert get_static_asset_max_age("js/util/helpers.js", None) == 0
    assert get_static_asset_max_age("js/util/helpers.js", static_root) == 0


def test_escaping_the_static_root_is_not_cached(static_root: Path) -> None:
    assert get_static_asset_max_age("../secrets.env", static_root) == 0


# --- то же самое, но через настоящую отдачу файла ---------------------------

import gzip  # noqa: E402

from flask import Flask  # noqa: E402

from routes.ui_assets import PrecompressedStaticMixin  # noqa: E402


class _StaticApp(PrecompressedStaticMixin, Flask):
    """Те же два слоя, что стоят на XkeenFlask в app_factory."""

    def get_send_file_max_age(self, filename):  # type: ignore[override]
        return get_static_asset_max_age(filename, self.static_folder)


def _client(static_dir: Path):
    # TESTING здесь включать нельзя: для панели это режим разработки, а мы
    # проверяем как раз боевые заголовки.
    return _StaticApp(__name__, static_folder=str(static_dir)).test_client()


def test_served_old_file_carries_the_window_header(static_root: Path) -> None:
    _make_file(static_root, "js/util/helpers.js", age_seconds=7 * 24 * 3600)

    response = _client(static_root).get("/static/js/util/helpers.js")

    assert response.status_code == 200
    assert f"max-age={DEFAULT_WINDOW}" in response.headers["Cache-Control"]


def test_served_fresh_file_keeps_recheck_header(static_root: Path) -> None:
    _make_file(static_root, "js/util/helpers.js", age_seconds=10)

    response = _client(static_root).get("/static/js/util/helpers.js")

    assert response.status_code == 200
    assert "no-cache" in response.headers["Cache-Control"]


def test_precompressed_copy_gets_the_same_window(static_root: Path) -> None:
    """Окно должно доживать и до сжатой копии, а не теряться по дороге."""

    _make_file(static_root, "styles.css", age_seconds=7 * 24 * 3600)
    source = static_root / "styles.css"
    packed = static_root / "styles.css.gz"
    packed.write_bytes(gzip.compress(source.read_bytes()))
    os.utime(packed, (source.stat().st_atime, source.stat().st_mtime))

    response = _client(static_root).get(
        "/static/styles.css", headers={"Accept-Encoding": "gzip"}
    )

    assert response.status_code == 200
    assert response.headers["Content-Encoding"] == "gzip"
    assert f"max-age={DEFAULT_WINDOW}" in response.headers["Cache-Control"]
