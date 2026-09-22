"""Документ панели должен уходить по сети сжатым.

Предсжатие (см. test_static_precompressed_serving) достаёт только до файлов на
диске, а страница панели собирается на каждый запрос и весит около 500 КБ.
Замер на роутере 22.09.2026 (`ARMv8`, его же python): сжатие этого тела уровнем
1 стоит 11 мс и убирает 398 КБ, тогда как те же байты уходят даже по идеальному
стомегабитному проводу 40 мс. Поэтому такие ответы жмём на лету.

Жмём осторожно: только HTML, только крупное, только тем, кто просил, и не
трогая статику — там уже лежит готовая `.gz`.
"""

from __future__ import annotations

import gzip

import pytest
from flask import Flask, Response

from routes.ui_assets import compress_response_if_worthwhile

GZIP_ENV = "XKEEN_UI_GZIP_MIN_BYTES"
BIG_HTML = ("<p>панель</p>" * 4000).encode("utf-8")
SMALL_HTML = b"<p>ok</p>"


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(GZIP_ENV, raising=False)


@pytest.fixture()
def app() -> Flask:
    return Flask(__name__)


def _run(app: Flask, resp: Response, path: str = "/", accept: str | None = "gzip") -> Response:
    headers = {"Accept-Encoding": accept} if accept is not None else {}
    with app.test_request_context(path, headers=headers):
        return compress_response_if_worthwhile(resp)


def _html(body: bytes = BIG_HTML, status: int = 200) -> Response:
    return Response(body, status=status, mimetype="text/html")


def test_large_html_document_is_compressed(app: Flask) -> None:
    resp = _run(app, _html())

    assert resp.headers.get("Content-Encoding") == "gzip"
    assert gzip.decompress(resp.get_data()) == BIG_HTML


def test_compressed_answer_reports_its_real_length(app: Flask) -> None:
    """Иначе браузер ждёт продолжения тела, которого не будет."""

    resp = _run(app, _html())

    assert int(resp.headers["Content-Length"]) == len(resp.get_data())
    assert len(resp.get_data()) < len(BIG_HTML)


def test_compressed_answer_varies_on_accept_encoding(app: Flask) -> None:
    """Без Vary промежуточный кэш отдаст сжатое тело тому, кто его не просил."""

    resp = _run(app, _html())

    assert "accept-encoding" in str(resp.headers.get("Vary", "")).lower()


def test_client_refusing_gzip_gets_the_plain_document(app: Flask) -> None:
    resp = _run(app, _html(), accept="gzip;q=0")

    assert "Content-Encoding" not in resp.headers
    assert resp.get_data() == BIG_HTML


def test_client_without_accept_encoding_gets_the_plain_document(app: Flask) -> None:
    resp = _run(app, _html(), accept=None)

    assert "Content-Encoding" not in resp.headers
    assert resp.get_data() == BIG_HTML


def test_small_document_is_left_alone(app: Flask) -> None:
    """Ниже порога экономия — единицы килобайт, а цена та же."""

    resp = _run(app, _html(SMALL_HTML))

    assert "Content-Encoding" not in resp.headers
    assert resp.get_data() == SMALL_HTML


def test_json_answers_are_left_alone(app: Flask) -> None:
    """Все 20 ответов API на старте панели весят 25 КБ — жать их незачем."""

    body = b'{"rules": []}' + b" " * 200000
    resp = _run(app, Response(body, mimetype="application/json"), path="/api/routing")

    assert "Content-Encoding" not in resp.headers
    assert resp.get_data() == body


def test_static_files_are_left_to_precompression(app: Flask) -> None:
    """Рядом со статикой лежит готовая .gz — второй раз жать нечего."""

    resp = _run(app, _html(), path="/static/styles.css")

    assert "Content-Encoding" not in resp.headers


def test_already_encoded_answer_is_not_touched(app: Flask) -> None:
    resp = _html(b"\x1f\x8b already packed")
    resp.headers["Content-Encoding"] = "gzip"

    result = _run(app, resp)

    assert result.get_data() == b"\x1f\x8b already packed"


def test_error_pages_are_left_alone(app: Flask) -> None:
    """Жмём только нормальные ответы: с 304 тела нет, а 500 отдаётся как есть."""

    resp = _run(app, _html(status=500))

    assert "Content-Encoding" not in resp.headers


def test_streamed_answer_is_not_collapsed_into_memory(app: Flask) -> None:
    """Потоковый ответ (журналы, выгрузка) нельзя целиком втянуть в память."""

    chunks = [b"<p>" + b"x" * 20000 + b"</p>" for _ in range(4)]
    resp = Response(iter(chunks), mimetype="text/html")

    result = _run(app, resp)

    assert "Content-Encoding" not in result.headers


def test_threshold_is_configurable(app: Flask, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(GZIP_ENV, "8")

    resp = _run(app, _html(SMALL_HTML))

    assert resp.headers.get("Content-Encoding") == "gzip"
    assert gzip.decompress(resp.get_data()) == SMALL_HTML


def test_zero_threshold_turns_compression_off(app: Flask, monkeypatch: pytest.MonkeyPatch) -> None:
    """Аварийный выключатель для слабых роутеров — без выката новой версии."""

    monkeypatch.setenv(GZIP_ENV, "0")

    resp = _run(app, _html())

    assert "Content-Encoding" not in resp.headers
    assert resp.get_data() == BIG_HTML


def test_broken_threshold_value_falls_back_to_the_default(
    app: Flask, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(GZIP_ENV, "не число")

    resp = _run(app, _html())

    assert resp.headers.get("Content-Encoding") == "gzip"


def test_whole_app_serves_a_compressed_page(monkeypatch: pytest.MonkeyPatch) -> None:
    """Сквозная проверка: через настоящий Flask, а не только на функции."""

    monkeypatch.delenv(GZIP_ENV, raising=False)
    app = Flask(__name__)

    @app.route("/")
    def index() -> Response:
        return Response(BIG_HTML, mimetype="text/html")

    @app.after_request
    def _compress(resp: Response) -> Response:
        return compress_response_if_worthwhile(resp)

    client = app.test_client()
    got = client.get("/", headers={"Accept-Encoding": "gzip"})

    assert got.headers.get("Content-Encoding") == "gzip"
    # Flask-клиент распаковывает сам, поэтому сверяем и по сырым байтам.
    assert gzip.decompress(got.get_data()) == BIG_HTML
