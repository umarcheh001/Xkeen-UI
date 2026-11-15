from __future__ import annotations

import json
from pathlib import Path

import pytest


@pytest.fixture
def debug(tmp_path, monkeypatch):
    from services import xray_routing_debug as api
    monkeypatch.setattr(api.time, 'time', lambda: 100)
    monkeypatch.setattr('services.cores.read_last_core', lambda: None)
    configs = tmp_path / 'configs'
    configs.mkdir()
    (configs / 'routing.json').write_bytes(b'{"routing":{"rules":[{"ruleTag":"ads","network":"tcp,udp","outboundTag":"block"}]}}\n')
    monkeypatch.setattr(api.xray_transactions, 'check_staged', lambda *a, **k: {'ok': True})
    service = api.RoutingDebug(str(configs), str(tmp_path / 'state'))
    monkeypatch.setattr(service, 'version', lambda: '26.11.9')
    return service


def test_version_floor_and_unknown_are_explicit(debug, monkeypatch):
    for version, supported in [('26.3.26', False), ('26.3.27', True), ('26.11.9', True), ('', False)]:
        monkeypatch.setattr(debug, 'version', lambda v=version: v)
        assert debug.status()['supported'] is supported
        if not supported:
            with pytest.raises(ValueError):
                debug.configure(True, logging=False, restart=lambda: pytest.fail('restart'))


def test_default_off_and_intent_persists_without_touching_configs(debug):
    from services.xray_routing_debug import RoutingDebug
    path = debug.configs / 'routing.json'
    original = path.read_bytes()
    assert debug.status()['enabled'] is False
    debug.configure(True, logging=False, restart=lambda: pytest.fail('restart'))
    assert path.read_bytes() == original
    loaded = RoutingDebug(str(debug.configs), str(debug.state_path.parent))
    assert loaded.status()['enabled'] is True
    assert loaded.status()['active'] is False
    assert 'token' not in debug.status()


def test_only_owned_hooks_are_removed_and_original_bytes_restored(debug):
    path = debug.configs / 'routing.json'
    original = path.read_bytes()
    external = {'url': 'https://example.org/events', 'headers': {'User': 'kept'}}
    other = debug.configs / 'other.json'
    other.write_bytes(json.dumps({'routing': {'rules': [{'ruleTag': 'user', 'outboundTag': 'direct', 'webhook': external}]}}).encode())
    calls = []
    debug.configure(True, logging=True, restart=lambda: (calls.append(1) or True, 'ok'))
    assert len(calls) == 1
    state = json.loads(debug.state_path.read_text(encoding='utf8'))
    hook = json.loads(path.read_bytes())['routing']['rules'][0]['webhook']
    assert hook['url'].startswith('http://127.0.0.1:')
    assert hook['headers']['X-Xkeen-Routing-Token'] == state['token']
    assert debug.status()['skipped_rules'] == 1
    debug.configure(False, logging=True, restart=lambda: (True, 'ok'))
    assert path.read_bytes() == original
    assert json.loads(other.read_bytes())['routing']['rules'][0]['webhook'] == external


def test_edits_while_active_survive_disable(debug):
    path = debug.configs / 'routing.json'
    debug.configure(True, logging=True, restart=lambda: (True, 'ok'))
    obj = json.loads(path.read_bytes())
    obj['routing']['rules'][0]['domain'] = ['domain:edited.example']
    path.write_bytes(json.dumps(obj).encode())
    debug.configure(False, logging=True, restart=lambda: (True, 'ok'))
    rule = json.loads(path.read_bytes())['routing']['rules'][0]
    assert rule['domain'] == ['domain:edited.example']
    assert 'webhook' not in rule


def test_failed_restart_rolls_back_every_file_and_setting(debug):
    path = debug.configs / 'routing.json'
    original = path.read_bytes()
    with pytest.raises(ValueError, match='перезапуск'):
        debug.configure(True, logging=True, restart=lambda: (False, 'failure'))
    assert path.read_bytes() == original
    assert debug.status()['enabled'] is False
    assert debug.status()['active'] is False


def test_rejected_staged_config_never_changes_files(debug, monkeypatch):
    from services import xray_routing_debug as api
    original = (debug.configs / 'routing.json').read_bytes()
    monkeypatch.setattr(api.xray_transactions, 'check_staged', lambda *a, **k: {'ok': False})
    with pytest.raises(ValueError):
        debug.configure(True, logging=True, restart=lambda: pytest.fail('restart'))
    assert (debug.configs / 'routing.json').read_bytes() == original
    assert not debug.status()['enabled']


def test_event_requires_loopback_secret_and_known_rule_and_valid_endpoints(debug):
    debug.configure(True, logging=True, restart=lambda: (True, 'ok'))
    state = json.loads(debug.state_path.read_bytes())
    key = next(iter(state['rules']))
    assert debug.authorize('127.0.0.1', state['token'])
    assert debug.authorize('::1', state['token'])
    assert not debug.authorize('192.168.1.2', state['token'])
    assert not debug.authorize('127.0.0.1', 'wrong')
    event = {'source': '[2001:db8::2]:12345', 'originalTarget': 'udp:[2001:db8::7]:443',
             'routeTarget': 'udp:ads.example:443', 'network': 'udp', 'inboundTag': 'tproxy', 'outboundTag': 'block', 'ts': 100}
    assert debug.ingest(key, event)
    row = debug.events()['events'][0]
    assert row['tag'] == 'ads' and row['domain'] == 'ads.example'
    assert row['host'] == '2001:db8::7'
    assert not debug.ingest('unknown', event)
    assert not debug.ingest(key, {**event, 'network': 'tcp'})
    assert not debug.ingest(key, {**event, 'source': 'malformed'})
    assert not debug.ingest(key, {**event, 'outboundTag': 'direct'})
    assert not debug.ingest(key, {**event, 'routeTarget': 'udp:ads.example:444'})


def test_events_are_bounded_expire_and_stop_does_not_forget_intent(debug, monkeypatch):
    from services import xray_routing_debug as api
    clock = [0.0]
    monkeypatch.setattr(api.time, 'monotonic', lambda: clock[0])
    debug.configure(True, logging=True, restart=lambda: (True, 'ok'))
    state = json.loads(debug.state_path.read_bytes())
    key = next(iter(state['rules']))
    event = {'source': '192.168.1.2:12345', 'originalTarget': 'tcp:1.1.1.1:443',
             'routeTarget': 'tcp:ads.example:443', 'network': 'tcp', 'inboundTag': 'redirect', 'outboundTag': 'block', 'ts': 100}
    for n in range(2050):
        assert debug.ingest(key, {**event, 'source': f'192.168.1.2:{10000 + n}'})
    payload = debug.events()
    assert len(payload['events']) == 2048 and payload['dropped'] == 2
    clock[0] = 31
    assert debug.events()['events'] == []
    debug.apply(False)
    assert debug.status()['enabled'] and not debug.status()['active']
    assert not debug.authorize('127.0.0.1', state['token'])


def test_unknown_version_still_allows_disabling(debug, monkeypatch):
    debug.configure(True, logging=True, restart=lambda: (True, 'ok'))
    monkeypatch.setattr(debug, 'version', lambda: '')
    debug.configure(False, logging=True, restart=lambda: (True, 'ok'))
    assert not debug.status()['enabled']


def _app(debug, monkeypatch, *, auth=False):
    from flask import Flask
    from routes.xray_logs import create_xray_logs_blueprint
    from services import xray_config_files, xray_log_api, xray_routing_debug
    from utils.jsonio import load_json, save_json
    path = debug.configs / '01_log.json'
    if not path.exists():
        path.write_bytes(b'{"log":{"loglevel":"none"}}')
    monkeypatch.setattr(xray_config_files, 'XRAY_CONFIGS_DIR', str(debug.configs))
    monkeypatch.setattr(xray_routing_debug.RoutingDebug, 'version', lambda s: '26.11.9')
    monkeypatch.setattr(xray_log_api, '_CONFIG_PATH', str(path))
    monkeypatch.setattr(xray_log_api, '_LOAD_JSON', load_json)
    monkeypatch.setattr(xray_log_api, '_SAVE_JSON', save_json)
    monkeypatch.setattr(xray_log_api, '_ACCESS_LOG', str(debug.configs / 'access.log'))
    monkeypatch.setattr(xray_log_api, '_ERROR_LOG', str(debug.configs / 'error.log'))
    calls = []
    app = Flask(__name__)
    app.register_blueprint(create_xray_logs_blueprint(ws_debug=lambda *a, **k: None,
        restart_xray_core=lambda **k: (calls.append(k) or True, 'ok'), ui_state_dir=str(debug.state_path.parent)))
    if auth:
        from services import auth_setup
        monkeypatch.setenv('XKEEN_UI_SECRET_KEY', 'test-routing-debug-key')
        monkeypatch.setattr(auth_setup, 'auth_is_configured', lambda: True)
        auth_setup.init_auth(app)
    return app, calls


def test_api_intent_start_stop_apply_one_restart_and_warning_is_preserved(debug, monkeypatch):
    app, calls = _app(debug, monkeypatch)
    client = app.test_client()
    result = client.post('/api/xray-logs/routing-debug', json={'enabled': True})
    assert result.status_code == 200 and result.json['enabled']
    assert calls == []
    assert client.post('/api/xray-logs/enable', json={'loglevel': 'warning'}).status_code == 200
    assert len(calls) == 1
    status = client.get('/api/xray-logs/status').json
    assert status['routing_debug']['active'] and status['loglevel'] == 'warning'
    assert client.post('/api/xray-logs/disable').status_code == 200
    assert len(calls) == 2
    status = client.get('/api/xray-logs/status').json
    assert status['routing_debug']['enabled'] and not status['routing_debug']['active']
    assert 'webhook' not in json.loads((debug.configs / 'routing.json').read_bytes())['routing']['rules'][0]


def test_machine_endpoint_has_narrow_auth_and_limits_without_session_or_csrf(debug, monkeypatch):
    debug.configure(True, logging=True, restart=lambda: (True, 'ok'))
    state = json.loads(debug.state_path.read_bytes())
    key = next(iter(state['rules']))
    app, _calls = _app(debug, monkeypatch, auth=True)
    client = app.test_client()
    url = '/api/xray-logs/routing-event/' + key
    headers = {'X-Xkeen-Routing-Token': state['token']}
    event = {'source': '192.168.1.2:12345', 'originalTarget': 'tcp:1.1.1.1:443',
             'routeTarget': 'tcp:ads.example:443', 'network': 'tcp', 'inboundTag': 'redirect', 'outboundTag': 'block', 'ts': 100}
    assert client.post(url, json=event, headers=headers).status_code == 204
    assert client.post(url, json=event).status_code == 403
    assert client.post(url, json=event, headers=headers, environ_overrides={'REMOTE_ADDR': '192.168.1.2'}).status_code == 403
    assert client.post(url, data='x' * 16385, headers=headers, content_type='application/json').status_code == 413
    assert client.post(url, json={'invalid': True}, headers=headers).status_code == 400
    assert client.get('/api/xray-logs/routing-debug/events', headers=headers).status_code == 401
    assert client.post('/api/xray-logs/routing-debug', json={'enabled': False}, headers=headers).status_code == 401


def test_switch_rejects_non_boolean_input(debug, monkeypatch):
    app, _calls = _app(debug, monkeypatch)
    for value in ['false', 1, None, {}]:
        assert app.test_client().post('/api/xray-logs/routing-debug', json={'enabled': value}).status_code == 400


def test_non_ascii_token_is_rejected(debug):
    debug.configure(True, logging=True, restart=lambda: (True, 'ok'))
    assert not debug.authorize('127.0.0.1', 'токен')
    assert not debug.authorize(None, 'wrong')


def test_stopped_intent_does_not_parse_configs_or_require_panel_port(debug, monkeypatch):
    (debug.configs / 'routing.json').write_bytes(b'incomplete editor file')
    monkeypatch.setenv('XKEEN_UI_PORT', 'invalid')
    debug.configure(True, logging=False, restart=lambda: pytest.fail('restart'))
    debug.configure(False, logging=False, restart=lambda: pytest.fail('restart'))
    assert not debug.status()['enabled']


def test_failed_recovery_is_reported_and_state_permissions_restored(debug, monkeypatch):
    from services import xray_routing_debug as api
    debug.configure(True, logging=False, restart=lambda: pytest.fail('restart'))
    modes = []
    chmod = api.os.chmod
    def track_mode(path, mode):
        if str(path) == str(debug.state_path):
            modes.append(mode)
        chmod(path, mode)
    monkeypatch.setattr(api.os, 'chmod', track_mode)
    with pytest.raises(ValueError, match='восстанов.*запуск'):
        debug.configure(False, logging=True, restart=lambda: (False, 'failed'))
    assert debug.status()['enabled'] and not debug.status()['active']
    assert modes[-1] == 0o600


@pytest.mark.parametrize('failure', ['write', 'state'])
def test_partial_write_rolls_back_multiple_configs(debug, monkeypatch, failure):
    from services import xray_routing_debug as api
    other = debug.configs / 'second.json'
    other.write_bytes((debug.configs / 'routing.json').read_bytes())
    before = {p: p.read_bytes() for p in debug.configs.iterdir()}
    write = api._atomic_write_json
    def fail(path, obj, **kwargs):
        if Path(path) == (other if failure == 'write' else debug.state_path):
            raise OSError('disk failure')
        return write(path, obj, **kwargs)
    monkeypatch.setattr(api, '_atomic_write_json', fail)
    with pytest.raises(OSError, match='disk failure'):
        debug.configure(True, logging=True, restart=lambda: pytest.fail('restart'))
    assert {p: p.read_bytes() for p in debug.configs.iterdir()} == before
    assert not debug.status()['enabled'] and not debug.status()['active']


def test_bom_jsonc_round_trip_preserves_comments_and_owner_edits(debug):
    path = debug.configs / 'routing.json'
    original = b'\xef\xbb\xbf{\n// keep comment\n"routing":{"rules":[{"ruleTag":"ads","outboundTag":"block"}]}}\n'
    path.write_bytes(original)
    debug.configure(True, logging=True, restart=lambda: (True, 'ok'))
    assert '// keep comment' in path.read_text(encoding='utf-8-sig')
    debug.configure(False, logging=True, restart=lambda: (True, 'ok'))
    assert path.read_bytes() == original


def test_old_event_during_state_write_cannot_leak_into_new_generation(debug, monkeypatch):
    from services import xray_routing_debug as api
    debug.configure(True, logging=True, restart=lambda: (True, 'ok'))
    key = next(iter(debug._state['rules']))
    event = {'source': '192.168.1.2:12345', 'originalTarget': 'tcp:1.1.1.1:443',
             'network': 'tcp', 'inboundTag': 'redirect', 'outboundTag': 'block', 'ts': 100}
    write = api._atomic_write_json
    def receive_during_write(path, obj, **kwargs):
        if Path(path) == debug.state_path:
            assert debug.ingest(key, event)
        return write(path, obj, **kwargs)
    monkeypatch.setattr(api, '_atomic_write_json', receive_during_write)
    debug.configure(False, logging=True, restart=lambda: (True, 'ok'))
    assert debug.events()['events'] == []


@pytest.mark.parametrize('change', [
    {'enabled': 'false'}, {'active': 1}, {'token': 'т' * 64},
    {'rules': {'key': None}}, {'originals': {'routing.json': {'bytes': 'invalid'}}},
])
def test_malformed_saved_state_fails_closed(debug, change):
    from services.xray_routing_debug import RoutingDebug
    debug.configure(True, logging=True, restart=lambda: (True, 'ok'))
    saved = json.loads(debug.state_path.read_bytes())
    debug.state_path.write_bytes(json.dumps({**saved, **change}).encode())
    loaded = RoutingDebug(str(debug.configs), str(debug.state_path.parent))
    assert not loaded.status()['enabled'] and not loaded.status()['active']
    assert not loaded.authorize('127.0.0.1', saved['token'])


def test_failed_restart_preserves_concurrent_editor_save(debug):
    path = debug.configs / 'routing.json'
    edited = b'{"routing":{"rules":[{"ruleTag":"owner-edit","outboundTag":"direct"}]}}'
    def restart():
        path.write_bytes(edited)
        return False, 'failed'
    with pytest.raises(ValueError, match='изменен'):
        debug.configure(True, logging=True, restart=restart)
    assert path.read_bytes() == edited
    assert not debug.status()['active']


def test_config_edit_invalidates_old_rule_map_and_delayed_callback(debug):
    debug.configure(True, logging=True, restart=lambda: (True, 'ok'))
    key = next(iter(debug._state['rules']))
    old_generation = debug.events()['generation']
    path = debug.configs / 'routing.json'
    obj = json.loads(path.read_bytes())
    obj['routing']['rules'][0]['ruleTag'] = 'changed'
    path.write_bytes(json.dumps(obj).encode())
    data = debug.events()
    assert not data['active'] and data['generation'] != old_generation
    assert not debug.authorize('127.0.0.1', debug._state['token'])
    debug.configure(True, logging=True, restart=lambda: (True, 'ok'))
    assert key not in debug._state['rules']
    assert next(iter(debug._state['rules'].values()))['tag'] == 'changed'


def test_each_start_has_unique_hook_keys_but_repeated_setting_is_noop(debug):
    calls = []
    restart = lambda: (calls.append(1) or True, 'ok')
    debug.configure(True, logging=True, restart=restart)
    first = set(debug._state['rules'])
    debug.configure(True, logging=True, restart=restart)
    assert len(calls) == 1
    debug.perform(True, restart)
    assert first.isdisjoint(debug._state['rules'])


def test_save_between_snapshot_and_document_read_is_preserved(debug, monkeypatch):
    path = debug.configs / 'routing.json'
    edited = b'{"routing":{"rules":[{"ruleTag":"new","outboundTag":"direct"}]}}'
    read = debug._documents
    def edit_before_read():
        path.write_bytes(edited)
        return read()
    monkeypatch.setattr(debug, '_documents', edit_before_read)
    with pytest.raises(ValueError, match='изменен'):
        debug.configure(True, logging=True, restart=lambda: (False, 'failed'))
    assert path.read_bytes() == edited


def test_stop_after_invalidation_still_rolls_back_hooks_on_write_failure(debug, monkeypatch):
    from services import xray_routing_debug as api
    debug.configure(True, logging=True, restart=lambda: (True, 'ok'))
    path = debug.configs / 'routing.json'
    before = path.read_bytes() + b'\n'
    path.write_bytes(before)
    assert not debug.status()['active']
    write = api._atomic_write_json
    def fail_state(path, obj, **kwargs):
        if Path(path) == debug.state_path:
            raise OSError('state write failed')
        return write(path, obj, **kwargs)
    monkeypatch.setattr(api, '_atomic_write_json', fail_state)
    with pytest.raises(OSError, match='state write failed'):
        debug.perform(False, lambda: (True, 'ok'))
    assert path.read_bytes() == before


def test_log_save_is_atomic_and_uses_no_truncating_injected_writer(debug, monkeypatch):
    from services import xray_log_api
    app, _ = _app(debug, monkeypatch)
    client = app.test_client()
    assert client.post('/api/xray-logs/routing-debug', json={'enabled': True}).status_code == 200
    log_path = debug.configs / '01_log.json'
    before = log_path.read_bytes()
    def partial_save(path, obj):
        Path(path).write_bytes(b'')
        raise OSError('disk failure')
    monkeypatch.setattr(xray_log_api, '_SAVE_JSON', partial_save)
    assert client.post('/api/xray-logs/enable', json={'loglevel': 'warning'}).status_code == 200
    assert json.loads(log_path.read_bytes())['log']['loglevel'] == 'warning'


def test_delayed_event_before_current_session_is_rejected(debug):
    debug.configure(True, logging=True, restart=lambda: (True, 'ok'))
    key = next(iter(debug._state['rules']))
    event = {'source': '192.168.1.2:12345', 'originalTarget': 'tcp:1.1.1.1:443',
             'network': 'tcp', 'inboundTag': 'redirect', 'outboundTag': 'block', 'ts': 99}
    assert not debug.ingest(key, event)
    assert debug.ingest(key, {**event, 'ts': 100})


def test_general_runtime_restart_refreshes_hooks_and_stop_removes_them(debug, monkeypatch):
    from services import xkeen
    app, _ = _app(debug, monkeypatch)
    client = app.test_client()
    assert client.post('/api/xray-logs/routing-debug', json={'enabled': True}).status_code == 200
    assert client.post('/api/xray-logs/enable', json={'loglevel': 'warning'}).status_code == 200
    service = app.extensions['xkeen.xray_routing_debug']
    first = set(service._state['rules'])
    monkeypatch.setattr(xkeen, '_dispatch_xkeen_control_command', lambda *a, **k: True)
    monkeypatch.setattr(xkeen, '_wait_xkeen_restarted', lambda *a, **k: True)
    monkeypatch.setattr(xkeen, '_wait_xkeen_running', lambda *a, **k: True)
    monkeypatch.setattr(xkeen, 'is_xkeen_running', lambda: True)
    monkeypatch.setattr(xkeen, '_xkeen_runtime_identity', lambda: ('xray', (1,)))
    with app.app_context():
        assert xkeen.control_xkeen_action('restart')
        assert first.isdisjoint(service._state['rules'])
        assert xkeen.control_xkeen_action('stop')
    assert service.status()['enabled'] and not service.status()['active']
    assert 'webhook' not in json.loads((debug.configs / 'routing.json').read_bytes())['routing']['rules'][0]


def test_external_core_restart_invalidates_session_without_parsing_each_callback(debug, monkeypatch):
    from services import xkeen
    pids = [1]
    monkeypatch.setattr(xkeen, '_process_ids', lambda name: tuple(pids))
    debug.configure(True, logging=True, restart=lambda: (True, 'ok'))
    generation = debug.events()['generation']
    pids[0] = 2
    assert not debug.events()['active']
    assert debug.events()['generation'] != generation


@pytest.mark.parametrize('reapply', [False, True])
def test_comment_only_edit_survives_disable_even_after_reapply(debug, reapply):
    path = debug.configs / 'routing.json'
    debug.configure(True, logging=True, restart=lambda: (True, 'ok'))
    path.write_bytes(path.read_bytes().replace(b'{', b'{\n// owner note\n', 1))
    if reapply:
        debug.perform(True, lambda: (True, 'ok'))
    debug.configure(False, logging=True, restart=lambda: (True, 'ok'))
    assert '// owner note' in path.read_text(encoding='utf8')


def test_server_expiry_reports_a_barrier_for_a_fresh_browser(debug, monkeypatch):
    from services import xray_routing_debug as api
    clock = [0.0]
    monkeypatch.setattr(api.time, 'monotonic', lambda: clock[0])
    debug.configure(True, logging=True, restart=lambda: (True, 'ok'))
    key = next(iter(debug._state['rules']))
    event = {'source': '192.168.1.2:12345', 'originalTarget': 'udp:1.1.1.1:443',
             'network': 'udp', 'inboundTag': 'redirect', 'outboundTag': 'block', 'ts': 100}
    assert debug.ingest(key, event)
    clock[0] = 1
    assert debug.ingest(key, {**event, 'ts': 101})
    clock[0] = 30.5
    data = debug.events()
    assert len(data['events']) == 1
    assert data['expired_until'] == 102000


def test_runtime_failure_preserves_bool_contract_for_normal_recovery(debug, monkeypatch):
    from services import xkeen
    app, _ = _app(debug, monkeypatch)
    service = app.extensions['xkeen.xray_routing_debug']
    service.configure(True, logging=False, restart=lambda: (True, 'ok'))
    monkeypatch.setattr(xkeen, '_control_xkeen_action', lambda *a, **k: False)
    with app.app_context():
        assert xkeen.control_xkeen_action('restart') is False


def test_idempotent_start_does_not_replace_hooks_of_the_running_core(debug, monkeypatch):
    from services import xkeen
    app, _ = _app(debug, monkeypatch)
    service = app.extensions['xkeen.xray_routing_debug']
    service.configure(True, logging=True, restart=lambda: (True, 'ok'))
    keys = set(service._state['rules'])
    monkeypatch.setattr(xkeen, 'is_xkeen_running', lambda: True)
    with app.app_context():
        assert xkeen.control_xkeen_action('start') is True
    assert set(service._state['rules']) == keys


def test_mihomo_restart_is_independent_of_wanted_debug_and_broken_xray_config(debug, monkeypatch):
    from types import SimpleNamespace
    from services import cores, xkeen
    app, _ = _app(debug, monkeypatch)
    (debug.configs / '01_log.json').write_bytes(b'{"log":{"loglevel":"warning"}}')
    service = app.extensions['xkeen.xray_routing_debug']
    service.configure(True, logging=False, restart=lambda: pytest.fail('restart'))
    (debug.configs / 'routing.json').write_bytes(b'{broken')
    monkeypatch.setattr(cores, 'core_runtime', lambda: SimpleNamespace(owner='mihomo'))
    monkeypatch.setattr(xkeen, '_control_xkeen_action', lambda *a, **k: True)
    with app.app_context():
        assert xkeen.control_xkeen_action('restart') is True
