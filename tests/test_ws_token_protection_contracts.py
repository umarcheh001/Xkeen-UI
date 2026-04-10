from pathlib import Path


def test_ws_token_scopes_cover_logs_and_events():
    text = Path('xkeen-ui/services/ws_tokens.py').read_text(encoding='utf-8')

    assert 'WS_TOKEN_SCOPES = {"pty", "cmd", "logs", "events"}' in text


def test_wsgi_ws_handlers_require_scoped_tokens_for_raw_logs_and_events_and_redact_qs():
    text = Path('xkeen-ui/services/ws_wsgi.py').read_text(encoding='utf-8')
    pty_text = Path('xkeen-ui/services/ws_pty.py').read_text(encoding='utf-8')

    assert 'def redact_ws_query_string(qs: str) -> str:' in text
    assert 'params["token"] = ["***" for _ in vals] or ["***"]' in text
    assert 'if not validate_ws_token(token, scope="logs"):' in text
    assert 'if not validate_ws_token(token, scope="events"):' in text
    assert (text.count('qs=qs_safe') + pty_text.count('qs=qs_safe')) >= 5


def test_run_server_delegates_ws_runtime_to_extracted_service_modules():
    text = Path('xkeen-ui/run_server.py').read_text(encoding='utf-8')

    assert 'from services.ws_pty import handle_pty_request, start_cleanup_loop as start_pty_cleanup_loop' in text
    assert 'from services.ws_wsgi import (' in text
    assert 'handle_xray_logs_request(' in text
    assert 'handle_xray_logs2_request(' in text
    assert 'handle_command_status_request(' in text
    assert 'handle_events_request(' in text
    assert 'start_pty_cleanup_loop()' in text


def test_xray_logs_frontend_requests_logs_ws_token_before_opening_socket():
    text = Path('xkeen-ui/static/js/features/xray_logs.js').read_text(encoding='utf-8')

    assert "async function requestXrayLogsWsToken(scope)" in text
    assert "fetch('/api/ws-token'" in text
    assert "body: JSON.stringify({ scope: normalizedScope })" in text
    assert "const wsToken = await requestXrayLogsWsToken('logs');" in text
    assert "params.set('token', wsToken);" in text
    assert "const url = debugUrl + '&token=' + encodeURIComponent(wsToken);" in text
    assert "wsDebug('WS2: connecting', { url: debugUrl, file: file, filter: !!filter });" in text
    assert "wsDebug('WS: connecting', { url: debugUrl, file: file });" in text


def test_flask_ws_stream_routes_match_logs_token_contract():
    text = Path('xkeen-ui/routes/ws_streams.py').read_text(encoding='utf-8')

    assert 'from services.ws_tokens import validate_ws_token' in text
    assert text.count('if not validate_ws_token(token, scope="logs"):') >= 2
