"""Панель отдаёт предсжатый .gz, когда он есть и не устарел.

Сжатые файлы кладёт упаковщик (scripts/build_user_archive.py). Здесь
проверяется вторая половина: отдать .gz можно далеко не всегда.

Главный сторож — mtime. install.sh раскладывает обновление через `rsync -a`
без `--delete`, поэтому однажды приехавший .gz остаётся на роутере навсегда;
а правка .css прямо на роутере по SSH — штатный способ отладки в этом
проекте. И в том, и в другом случае исходник оказывается новее .gz, и тогда
сжатый файл отдавать нельзя: пользователь увидит старую панель.
"""

from __future__ import annotations

import gzip
import os
from pathlib import Path

import pytest
from flask import Flask, Response

from routes.ui_assets import (
    PrecompressedStaticMixin,
    apply_response_cache_policy,
    client_accepts_gzip,
    resolve_precompressed_static,
)


CSS_PAYLOAD = (".panel{display:flex;color:red}\n" * 400).encode("utf-8")


class _StaticApp(PrecompressedStaticMixin, Flask):
    """Тот же миксин, что стоит на XkeenFlask, но без остального приложения."""


@pytest.fixture
def static_dir(tmp_path):
    static = tmp_path / "static"
    static.mkdir()
    source = static / "styles.css"
    source.write_bytes(CSS_PAYLOAD)
    packed = static / "styles.css.gz"
    packed.write_bytes(gzip.compress(CSS_PAYLOAD))
    os.utime(packed, (source.stat().st_atime, source.stat().st_mtime))
    return static


@pytest.fixture
def client(static_dir):
    app = _StaticApp(__name__, static_folder=str(static_dir))
    app.config["TESTING"] = True
    return app.test_client()


def test_accept_encoding_header_is_read_correctly():
    assert client_accepts_gzip("gzip, deflate, br") is True
    assert client_accepts_gzip("br;q=1.0, gzip;q=0.8") is True
    assert client_accepts_gzip("*") is True
    assert client_accepts_gzip("identity") is False
    assert client_accepts_gzip("") is False
    assert client_accepts_gzip(None) is False


def test_client_refusing_gzip_explicitly_is_respected():
    """`gzip;q=0` означает «именно gzip мне не присылай»."""

    assert client_accepts_gzip("gzip;q=0") is False
    assert client_accepts_gzip("deflate, gzip;q=0.000") is False


def test_stale_gzip_is_ignored(static_dir):
    """Исходник новее .gz — значит .css правили, а .gz остался прежним."""

    source = static_dir / "styles.css"
    os.utime(source, (1_700_000_100, 1_700_000_100))
    os.utime(static_dir / "styles.css.gz", (1_700_000_000, 1_700_000_000))

    resolved = resolve_precompressed_static(str(static_dir), "styles.css", "gzip")

    assert resolved is None


def test_fresh_gzip_is_resolved(static_dir):
    resolved = resolve_precompressed_static(str(static_dir), "styles.css", "gzip")

    assert resolved is not None
    assert Path(resolved).name == "styles.css.gz"


def test_missing_gzip_resolves_to_nothing(static_dir):
    (static_dir / "plain.css").write_bytes(CSS_PAYLOAD)

    resolved = resolve_precompressed_static(str(static_dir), "plain.css", "gzip")

    assert resolved is None


def test_path_traversal_resolves_to_nothing(tmp_path, static_dir):
    outside = tmp_path / "secret.css"
    outside.write_bytes(CSS_PAYLOAD)
    (tmp_path / "secret.css.gz").write_bytes(gzip.compress(CSS_PAYLOAD))

    resolved = resolve_precompressed_static(str(static_dir), "../secret.css", "gzip")

    assert resolved is None


def test_gzip_capable_client_gets_the_compressed_file(client):
    resp = client.get("/static/styles.css", headers={"Accept-Encoding": "gzip"})

    assert resp.status_code == 200
    assert resp.headers["Content-Encoding"] == "gzip"
    assert gzip.decompress(resp.get_data()) == CSS_PAYLOAD


def test_compressed_response_keeps_the_original_content_type(client):
    """Иначе браузер увидит application/gzip и предложит скачать файл."""

    resp = client.get("/static/styles.css", headers={"Accept-Encoding": "gzip"})

    assert resp.headers["Content-Type"].startswith("text/css")


def test_compressed_response_declares_vary(client):
    resp = client.get("/static/styles.css", headers={"Accept-Encoding": "gzip"})

    assert "Accept-Encoding" in resp.headers["Vary"]


def test_client_without_gzip_gets_the_plain_file(client):
    resp = client.get("/static/styles.css", headers={"Accept-Encoding": "identity"})

    assert resp.status_code == 200
    assert "Content-Encoding" not in resp.headers
    assert resp.get_data() == CSS_PAYLOAD


def test_asset_without_a_gzip_sibling_still_works(client, static_dir):
    (static_dir / "plain.css").write_bytes(CSS_PAYLOAD)

    resp = client.get("/static/plain.css", headers={"Accept-Encoding": "gzip"})

    assert resp.status_code == 200
    assert "Content-Encoding" not in resp.headers
    assert resp.get_data() == CSS_PAYLOAD


def test_missing_asset_still_returns_404(client):
    resp = client.get("/static/nope.css", headers={"Accept-Encoding": "gzip"})

    assert resp.status_code == 404


def test_plain_static_responses_also_declare_vary():
    """Без Vary промежуточный кэш может отдать сжатое тело тому, кто его не просил."""

    app = Flask(__name__)

    with app.test_request_context("/static/js/features/routing.js"):
        resp = apply_response_cache_policy(Response(""))

    assert "Accept-Encoding" in resp.headers["Vary"]


def test_hashed_build_assets_keep_immutable_caching_and_gain_vary():
    app = Flask(__name__)

    with app.test_request_context("/static/frontend-build/assets/panel-A1b2C3d4.js"):
        resp = apply_response_cache_policy(Response(""))

    assert resp.headers["Cache-Control"] == "public, max-age=31536000, immutable"
    assert "Accept-Encoding" in resp.headers["Vary"]


def test_app_factory_puts_the_mixin_on_its_flask_subclass():
    text = Path("xkeen-ui/app_factory.py").read_text(encoding="utf-8")

    assert "PrecompressedStaticMixin," in text
    assert "class XkeenFlask(PrecompressedStaticMixin, Flask):" in text
