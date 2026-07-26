from __future__ import annotations

from services import happ_links


def test_helper_command_uses_bundled_helper_when_env_is_missing(monkeypatch):
    monkeypatch.delenv(happ_links.HAPP_HELPER_CMD_ENV, raising=False)

    command = happ_links.helper_command()

    assert "happ_transport_helper.py" in command
    assert "xkeen-ui" in command
    assert happ_links.helper_configured() is True


def test_decryptor_command_is_empty_without_dropin_or_env(monkeypatch):
    monkeypatch.delenv(happ_links.HAPP_DECRYPTOR_CMD_ENV, raising=False)
    monkeypatch.setattr(happ_links, "_bundled_decryptor_command_parts", lambda: [])

    assert happ_links.decryptor_command() == ""
    assert happ_links.decryptor_configured() is False


def test_command_parts_from_path_uses_node_for_node_shebang(tmp_path, monkeypatch):
    script = tmp_path / "happ-decrypt-universal"
    script.write_text("#!/usr/bin/env node\nconsole.log('ok')\n", encoding="utf-8")

    monkeypatch.setattr(happ_links.shutil, "which", lambda name: "/usr/bin/node" if name == "node" else None)

    assert happ_links._command_parts_from_path(str(script)) == ["/usr/bin/node", str(script)]


def test_normalize_helper_output_supports_decrypted_url_json():
    parsed = happ_links._normalize_helper_output('{"decryptedUrl":"https://example.com/sub"}')

    assert parsed == {"kind": "url", "value": "https://example.com/sub", "headers": {}}


def test_extract_happ_links_from_connector_query_url():
    encoded = "happ%3A%2F%2Fcrypt4%2Fdemo-token"
    source = f"https://connector.example/mobile.html?link={encoded}&cb=c2"

    assert happ_links.extract_happ_links_from_url(source) == ["happ://crypt4/demo-token"]


def test_resolve_source_uses_happ_link_embedded_in_http_connector_url(monkeypatch):
    calls = []

    def fake_run_decryptor(value):
        calls.append(value)
        return {"kind": "text", "value": "vless://resolved@example.com:443"}

    monkeypatch.setattr(happ_links, "helper_configured", lambda: False)
    monkeypatch.setattr(happ_links, "decryptor_configured", lambda: True)
    monkeypatch.setattr(happ_links, "run_decryptor", fake_run_decryptor)

    resolved = happ_links.resolve_source(
        "https://connector.example/mobile.html?link=happ%3A%2F%2Fcrypt4%2Fdemo-token"
    )

    assert resolved["kind"] == "text"
    assert resolved["via"] == "decryptor"
    assert resolved["candidate"] == "happ://crypt4/demo-token"
    assert calls == ["happ://crypt4/demo-token"]


def test_remote_decryptor_template_url_supports_encoded_and_raw_tokens():
    built = happ_links._remote_decryptor_template_url(
        "https://example.com/p/?u=%LINK_ENCODED%&raw=%LINK%",
        "happ://crypt5/demo token",
    )

    assert built == (
        "https://example.com/p/?u=happ%3A%2F%2Fcrypt5%2Fdemo%20token"
        "&raw=happ://crypt5/demo token"
    )


def test_run_remote_decryptor_supports_get_template(monkeypatch):
    captured = {}

    class _Response:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def read(self):
            return b"vless://demo"

    def fake_urlopen(request, timeout=0):
        captured["url"] = request.full_url
        captured["method"] = request.get_method()
        captured["data"] = request.data
        captured["timeout"] = timeout
        return _Response()

    monkeypatch.setenv(
        happ_links.HAPP_DECRYPTOR_REMOTE_URL_ENV,
        "https://example.com/p/?u=%LINK_ENCODED%",
    )
    monkeypatch.setattr(happ_links.urllib.request, "urlopen", fake_urlopen)

    parsed = happ_links.run_remote_decryptor("happ://crypt5/demo-token")

    assert captured["url"] == "https://example.com/p/?u=happ%3A%2F%2Fcrypt5%2Fdemo-token"
    assert captured["method"] == "GET"
    assert captured["data"] is None
    assert parsed["kind"] == "url"
    assert parsed["value"] == "vless://demo"


def test_decryptor_timeout_defaults_to_longer_budget(monkeypatch):
    monkeypatch.delenv(happ_links.HAPP_HELPER_TIMEOUT_ENV, raising=False)
    monkeypatch.delenv(happ_links.HAPP_DECRYPTOR_TIMEOUT_ENV, raising=False)

    assert happ_links.helper_timeout_seconds() == 15.0
    assert happ_links.decryptor_timeout_seconds() == 45.0


def test_decryptor_timeout_respects_explicit_override(monkeypatch):
    monkeypatch.setenv(happ_links.HAPP_HELPER_TIMEOUT_ENV, "15")
    monkeypatch.setenv(happ_links.HAPP_DECRYPTOR_TIMEOUT_ENV, "75")

    assert happ_links.decryptor_timeout_seconds() == 75.0


def test_resolve_source_uses_decryptor_for_raw_happ_link(monkeypatch):
    calls: list[str] = []

    def fake_run_decryptor(value):
        calls.append(value)
        return {"kind": "text", "value": "vless://demo", "headers": {}}

    monkeypatch.setattr(happ_links, "decryptor_configured", lambda: True)
    monkeypatch.setattr(happ_links, "run_decryptor", fake_run_decryptor)
    monkeypatch.setattr(happ_links, "helper_env_configured", lambda: False)

    resolved = happ_links.resolve_source("happ://crypt5/demo-token")

    assert resolved["kind"] == "text"
    assert resolved["via"] == "decryptor"
    assert resolved["candidate"] == "happ://crypt5/demo-token"
    assert calls == ["happ://crypt5/demo-token"]


def test_resolve_source_tries_http_helper_before_happ_deep_link(monkeypatch):
    calls: list[str] = []

    def fake_run_helper(value):
        calls.append(value)
        if value == "https://example.com/sub":
            return {"kind": "text", "value": "vless://demo", "headers": {}}
        raise RuntimeError("unexpected")

    monkeypatch.setattr(happ_links, "helper_configured", lambda: True)
    monkeypatch.setattr(happ_links, "run_helper", fake_run_helper)

    resolved = happ_links.resolve_source(
        "https://example.com/sub",
        body=(
            '<html><body><a href="happ://crypt5/demo-token">Happ</a>'
            '<a href="incy://import/https://example.com/sub">Incy</a></body></html>'
        ),
        content_type="text/html; charset=utf-8",
    )

    assert resolved["kind"] == "text"
    assert resolved["candidate"] == "https://example.com/sub"
    assert calls == ["https://example.com/sub"]


def test_resolve_source_falls_back_to_happ_link_when_http_helper_input_fails(monkeypatch):
    helper_calls: list[str] = []
    decryptor_calls: list[str] = []

    def fake_run_helper(value):
        helper_calls.append(value)
        if value == "https://example.com/sub":
            raise RuntimeError("unsupported")
        raise RuntimeError("unexpected")

    def fake_run_decryptor(value):
        decryptor_calls.append(value)
        if value == "happ://crypt5/demo-token":
            return {"kind": "text", "value": "vless://demo", "headers": {}}
        raise RuntimeError("unexpected")

    monkeypatch.setattr(happ_links, "helper_configured", lambda: True)
    monkeypatch.setattr(happ_links, "decryptor_configured", lambda: True)
    monkeypatch.setattr(happ_links, "run_helper", fake_run_helper)
    monkeypatch.setattr(happ_links, "run_decryptor", fake_run_decryptor)

    resolved = happ_links.resolve_source(
        "https://example.com/sub",
        body=(
            '<html><body><a href="happ://crypt5/demo-token">Happ</a>'
            '<a href="incy://import/https://example.com/sub">Incy</a></body></html>'
        ),
        content_type="text/html; charset=utf-8",
    )

    assert resolved["kind"] == "text"
    assert resolved["candidate"] == "happ://crypt5/demo-token"
    assert resolved["via"] == "decryptor"
    assert helper_calls == ["https://example.com/sub"]
    assert decryptor_calls == ["happ://crypt5/demo-token"]


def test_resolve_source_uses_remote_decryptor_after_local_failure(monkeypatch):
    local_calls: list[str] = []
    remote_calls: list[str] = []

    def fake_run_decryptor(value):
        local_calls.append(value)
        raise RuntimeError("happ_decryptor_failed:segment length missing")

    def fake_run_remote(value):
        remote_calls.append(value)
        return {"kind": "url", "value": "https://example.com/sub", "headers": {}}

    monkeypatch.setattr(happ_links, "decryptor_configured", lambda: True)
    monkeypatch.setattr(happ_links, "remote_decryptor_configured", lambda: True)
    monkeypatch.setattr(happ_links, "run_decryptor", fake_run_decryptor)
    monkeypatch.setattr(happ_links, "run_remote_decryptor", fake_run_remote)
    monkeypatch.setattr(happ_links, "helper_env_configured", lambda: False)

    resolved = happ_links.resolve_source("happ://crypt5/demo-token")

    assert resolved["kind"] == "url"
    assert resolved["value"] == "https://example.com/sub"
    assert resolved["via"] == "decryptor-remote"
    assert resolved["candidate"] == "happ://crypt5/demo-token"
    assert local_calls == ["happ://crypt5/demo-token"]
    assert remote_calls == ["happ://crypt5/demo-token"]


def test_resolve_source_uses_remote_decryptor_when_local_is_missing(monkeypatch):
    calls: list[str] = []

    def fake_run_remote(value):
        calls.append(value)
        return {"kind": "text", "value": "vless://demo", "headers": {}}

    monkeypatch.setattr(happ_links, "decryptor_configured", lambda: False)
    monkeypatch.setattr(happ_links, "remote_decryptor_configured", lambda: True)
    monkeypatch.setattr(happ_links, "run_remote_decryptor", fake_run_remote)
    monkeypatch.setattr(happ_links, "helper_env_configured", lambda: False)

    resolved = happ_links.resolve_source("happ://crypt5/demo-token")

    assert resolved["kind"] == "text"
    assert resolved["via"] == "decryptor-remote"
    assert resolved["candidate"] == "happ://crypt5/demo-token"
    assert calls == ["happ://crypt5/demo-token"]
