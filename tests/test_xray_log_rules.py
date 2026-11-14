from __future__ import annotations

import json

from flask import Flask

from services import xray_config_files, xray_log_api
from routes.xray_logs import create_xray_logs_blueprint


def _client(monkeypatch, tmp_path):
    from utils.jsonio import load_json
    (tmp_path / "01_log.json").write_bytes(b'{"log":{"loglevel":"info"}}')
    monkeypatch.setattr(xray_log_api, "_LOAD_JSON", load_json)
    monkeypatch.setattr(xray_config_files, "XRAY_CONFIGS_DIR", str(tmp_path))
    monkeypatch.setattr(xray_log_api, "_CONFIG_PATH", str(tmp_path / "01_log.json"))
    monkeypatch.setattr(xray_log_api, "_ERROR_LOG", str(tmp_path / "error.log"))
    monkeypatch.setattr(xray_log_api, "_TZ_OFFSET_HOURS", 0)
    app = Flask(__name__)
    app.register_blueprint(create_xray_logs_blueprint(ws_debug=lambda *a, **kw: None, restart_xray_core=lambda: (True, "")))
    return app.test_client()


def test_status_reads_tags_from_applied_fragments_and_invalidates_cache(monkeypatch, tmp_path):
    client = _client(monkeypatch, tmp_path)
    fragment = tmp_path / "custom.json"
    fragment.write_bytes(b'{"routing":{"rules":[{"ruleTag":"","outboundTag":"direct"}]}}')
    (tmp_path / "disabled.jsonc").write_bytes(b'{"routing":{"rules":[{"ruleTag":"draft"}]}}')
    assert client.get('/api/xray-logs/status').json.get('has_rule_tags') is False
    fragment.write_bytes(b'{"routing":{"rules":[{"ruleTag":"confirmed","outboundTag":"direct"}]}}')
    assert client.get('/api/xray-logs/status').json['has_rule_tags'] is True
    fragment.write_bytes(b'{"routing":{"rules":[]}}')
    assert client.get('/api/xray-logs/status').json['has_rule_tags'] is False
    fragment.write_bytes(b'{broken')
    assert client.get('/api/xray-logs/status').json['has_rule_tags'] is None


def test_status_ignores_commented_rules_and_reuses_unchanged_files(monkeypatch, tmp_path):
    client = _client(monkeypatch, tmp_path)
    (tmp_path / 'routing.json').write_bytes(b'{"routing":{"rules":[/* {"ruleTag":"off"} */]}}')
    assert client.get('/api/xray-logs/status').json.get('has_rule_tags') is False
    from utils import jsonio
    monkeypatch.setattr(jsonio, 'load_json', lambda *a, **kw: (_ for _ in ()).throw(AssertionError('uncached read')))
    assert client.get('/api/xray-logs/status').json['has_rule_tags'] is False


def test_diagnostic_cursor_is_bounded_and_catches_up_after_overrun(monkeypatch, tmp_path):
    client = _client(monkeypatch, tmp_path)
    path = tmp_path / 'error.log'
    path.write_bytes(b'initial\n')
    first = client.get('/api/xray-logs?file=error&source=domain_hints&diagnostic=1').json
    assert first.get('reset') is True
    assert first['caught_up'] is True
    with path.open('ab') as stream:
        stream.write(b'old-' + b'x' * 300000 + b'\nlast-complete\nunfinished')
    next_data = client.get('/api/xray-logs', query_string={'file': 'error', 'diagnostic': '1', 'cursor': first['cursor']}).json
    assert next_data['skipped'] is True
    assert next_data['reset'] is True
    assert next_data['caught_up'] is True
    assert next_data['lines'] == ['last-complete\n']
    assert len(json.dumps(next_data)) < 4096
    with path.open('ab') as stream:
        stream.write(b'-finished\n')
    final = client.get('/api/xray-logs', query_string={'file': 'error', 'diagnostic': '1', 'cursor': next_data['cursor']}).json
    assert final['reset'] is False
    assert final['lines'] == ['unfinished-finished\n']


def test_diagnostic_same_inode_rewrite_resets_cursor(monkeypatch, tmp_path):
    client = _client(monkeypatch, tmp_path)
    path = tmp_path / 'error.log'
    path.write_bytes(b'old-log\n')
    first = client.get('/api/xray-logs?file=error&diagnostic=1').json
    path.write_bytes(b'new-log\nnew-data\n')
    data = client.get('/api/xray-logs', query_string={'file': 'error', 'diagnostic': '1', 'cursor': first['cursor']}).json
    assert data.get('reset') is True
    assert data['lines'] == ['new-log\n', 'new-data\n']


def test_known_clear_invalidates_diagnostic_generation(monkeypatch, tmp_path):
    client = _client(monkeypatch, tmp_path)
    path = tmp_path / 'error.log'
    path.write_bytes(b'same\n')
    first = client.get('/api/xray-logs?file=error&diagnostic=1').json
    client.post('/api/xray-logs/clear', json={'file': 'error'})
    path.write_bytes(b'same\nnew\n')
    data = client.get('/api/xray-logs', query_string={'file': 'error', 'diagnostic': '1', 'cursor': first['cursor']}).json
    assert data.get('reset') is True
