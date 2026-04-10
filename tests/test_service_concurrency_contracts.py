from pathlib import Path


def test_events_service_exposes_locked_subscriber_helpers_and_run_server_uses_them():
    events_text = Path('xkeen-ui/services/events.py').read_text(encoding='utf-8')
    app_text = Path('xkeen-ui/app.py').read_text(encoding='utf-8')
    server_text = Path('xkeen-ui/run_server.py').read_text(encoding='utf-8')
    wsgi_text = Path('xkeen-ui/services/ws_wsgi.py').read_text(encoding='utf-8')

    assert 'import threading' in events_text
    assert '_EVENT_SUBSCRIBERS_LOCK: threading.Lock = threading.Lock()' in events_text
    assert 'def subscribe(ws: Any) -> None:' in events_text
    assert 'def unsubscribe(ws: Any) -> None:' in events_text
    assert 'with _EVENT_SUBSCRIBERS_LOCK:' in events_text
    assert 'snapshot = list(EVENT_SUBSCRIBERS)' in events_text
    assert 'subscribers=len(snapshot),' in events_text

    assert 'from services.events import EVENT_SUBSCRIBERS, subscribe as _subscribe_ws, unsubscribe as _unsubscribe_ws' in app_text
    assert '"_subscribe_ws",' in app_text
    assert '"_unsubscribe_ws",' in app_text

    assert '_subscribe_ws,' in server_text
    assert '_unsubscribe_ws,' in server_text
    assert 'subscribe_ws=_subscribe_ws' in server_text
    assert 'unsubscribe_ws=_unsubscribe_ws' in server_text
    assert 'subscribe_ws(ws)' in wsgi_text
    assert 'unsubscribe_ws(ws)' in wsgi_text
    assert 'EVENT_SUBSCRIBERS.append(ws)' not in server_text
    assert 'EVENT_SUBSCRIBERS.remove(ws)' not in server_text


def test_geodat_and_xray_log_caches_are_guarded_by_locks():
    geodat_text = Path('xkeen-ui/services/geodat/cache.py').read_text(encoding='utf-8')
    xray_log_api_text = Path('xkeen-ui/services/xray_log_api.py').read_text(encoding='utf-8')

    assert '_GEODAT_CACHE_LOCK = threading.Lock()' in geodat_text
    assert geodat_text.count('with _GEODAT_CACHE_LOCK:') >= 2
    assert '_LOG_CACHE_LOCK: threading.Lock = threading.Lock()' in xray_log_api_text
    assert 'with _LOG_CACHE_LOCK:' in xray_log_api_text
    assert 'return xray_logs.tail_lines(path, max_lines=max_lines, cache=LOG_CACHE)' in xray_log_api_text
    assert 'LOG_CACHE.pop(actual, None)' in xray_log_api_text


def test_github_index_cache_reads_and_writes_are_locked_around_future_snapshot():
    text = Path('xkeen-ui/services/config_exchange_github.py').read_text(encoding='utf-8')

    assert 'with _GH_INDEX_LOCK:' in text
    assert 'future = _GH_INDEX_FUTURE' in text
    assert 'items = future.result(timeout=max(0.1, float(wait_seconds)))' in text
    assert text.count('cached = _GH_INDEX_CACHE["items"]') >= 3
    assert 'return cached, True' in text


def test_mihomo_generator_escapes_rule_group_labels_before_innerhtml_injection():
    text = Path('xkeen-ui/static/js/features/mihomo_generator.js').read_text(encoding='utf-8')

    assert 'function escapeHtml(str) {' in text
    assert 'span.innerHTML = "<strong>" + escapeHtml(preset.label) + "</strong>";' in text


def test_pty_runtime_is_extracted_from_run_server_into_dedicated_service_module():
    server_text = Path('xkeen-ui/run_server.py').read_text(encoding='utf-8')
    pty_text = Path('xkeen-ui/services/ws_pty.py').read_text(encoding='utf-8')

    assert 'class PtySession:' in pty_text
    assert 'def cleanup_sessions(now: float | None = None) -> None:' in pty_text
    assert 'def start_cleanup_loop() -> bool:' in pty_text
    assert 'def handle_pty_request(' in pty_text
    assert 'class PtySession:' not in server_text
    assert 'def _pty_cleanup_loop()' not in server_text
