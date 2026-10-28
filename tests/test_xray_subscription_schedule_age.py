from pathlib import Path

import pytest

from services import xray_subscriptions as subs


def test_manual_failure_and_retries_do_not_start_age_before_scheduled_deadline(tmp_path: Path, monkeypatch):
    state, configs = tmp_path / 'state', tmp_path / 'configs'
    state.mkdir()
    configs.mkdir()
    clock = [100000.0]
    monkeypatch.setattr(subs, '_now', lambda: clock[0])
    monkeypatch.setattr(subs, 'fetch_subscription_body', lambda _url: (_ for _ in ()).throw(TimeoutError('timed out')))
    subs.upsert_subscription(str(state), {'id': 'demo', 'url': 'https://example.com/sub', 'interval_hours': 24})
    scheduled = clock[0] + 86400
    def saved():
        return subs.load_subscription_state(str(state))['subscriptions'][0]
    def refresh():
        return subs.refresh_subscription(str(state), 'demo', xray_configs_dir=str(configs), restart=False)
    assert saved()['scheduled_update_ts'] == scheduled
    clock[0] += 60
    assert not refresh()['ok']
    assert saved()['scheduled_update_ts'] == scheduled
    assert not saved().get('first_scheduled_failure_ts')
    clock[0] += 1800
    assert not refresh()['ok']
    assert not saved().get('first_scheduled_failure_ts')
    clock[0] = scheduled + 30
    assert not refresh()['ok']
    assert saved()['first_scheduled_failure_ts'] == scheduled + 30
    clock[0] += 1800
    assert not refresh()['ok']
    assert saved()['first_scheduled_failure_ts'] == scheduled + 30
    monkeypatch.setattr(subs, 'fetch_subscription_body', lambda _url: ('vless://11111111-1111-1111-1111-111111111111@example.com:443?type=tcp#Demo', {}))
    clock[0] += 1800
    assert refresh()['ok']
    assert not saved().get('first_scheduled_failure_ts')
    assert saved()['last_success_ts'] == clock[0]
    assert saved()['scheduled_update_ts'] == clock[0] + 86400


@pytest.mark.parametrize('last_ok', [True, False])
def test_legacy_records_do_not_invent_previous_failures(tmp_path, monkeypatch, last_ok):
    now = 200000.0
    monkeypatch.setattr(subs, '_now', lambda: now)
    monkeypatch.setattr(subs, 'fetch_subscription_body', lambda _url: (_ for _ in ()).throw(TimeoutError('timed out')))
    subs.upsert_subscription(str(tmp_path), {'id': 'legacy', 'url': 'https://example.com/sub'})
    state = subs.load_subscription_state(str(tmp_path))
    sub = state['subscriptions'][0]
    sub.pop('scheduled_update_ts')
    sub.update(last_ok=last_ok, last_update_ts=now - 1000, next_update_ts=now - 60)
    subs._write_state(str(tmp_path), state)
    subs.refresh_subscription(str(tmp_path), 'legacy', xray_configs_dir=str(tmp_path), restart=False)
    saved = subs.load_subscription_state(str(tmp_path))['subscriptions'][0]
    if last_ok:
        assert saved['last_success_ts'] == now - 1000
        assert saved['first_scheduled_failure_ts'] == now
    else:
        assert not saved.get('last_success_ts')
        assert not saved.get('first_scheduled_failure_ts')
