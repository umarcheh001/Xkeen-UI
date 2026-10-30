import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'xkeen-ui'))
from services.system_resources_history.event_preferences import EventPreferences


def test_preferences_persist_and_scope_exceptions(tmp_path):
    prefs = EventPreferences(str(tmp_path))
    prefs.acknowledge('port_slow-123-1')
    prefs.suppress('port_slow', '4')
    restored = EventPreferences(str(tmp_path))
    assert restored.is_acknowledged('port_slow-123-1')
    assert restored.is_suppressed('port_slow', '4')
    assert not restored.is_suppressed('port_slow', '3')
    assert not restored.is_suppressed('overheat', '4')
    restored.unsuppress('port_slow', '4')
    assert not EventPreferences(str(tmp_path)).is_suppressed('port_slow', '4')


def test_unknown_and_informational_events_cannot_be_suppressed(tmp_path):
    prefs = EventPreferences(str(tmp_path))
    for name in ('router_rebooted', 'internet_restored', 'unknown'):
        with pytest.raises(ValueError):
            prefs.suppress(name, '')


def test_failed_write_does_not_change_runtime_preferences(tmp_path, monkeypatch):
    prefs = EventPreferences(str(tmp_path))
    def fail():
        raise OSError('disk full')
    monkeypatch.setattr(prefs, 'save', fail)
    with pytest.raises(OSError):
        prefs.suppress('port_slow', '4')
    assert not prefs.is_suppressed('port_slow', '4')


def test_corrupt_preferences_are_not_silently_overwritten(tmp_path):
    path = tmp_path / 'resource-event-preferences.json'
    path.write_text('{broken', encoding='utf-8')
    prefs = EventPreferences(str(tmp_path))
    assert prefs.read_error
    with pytest.raises(OSError):
        prefs.suppress('port_slow', '4')
    assert path.read_text(encoding='utf-8') == '{broken'


@pytest.mark.parametrize('content', ['{"exclusions":"bad"}', '{"acknowledged":42}', '{"exclusions":[{"type":"bogus","key":"4"}]}'])
def test_invalid_preference_structure_is_not_overwritten(tmp_path, content):
    path = tmp_path / 'resource-event-preferences.json'
    path.write_text(content, encoding='utf-8')
    prefs = EventPreferences(str(tmp_path))
    assert prefs.read_error
    with pytest.raises(OSError):
        prefs.acknowledge('event-1')
    assert path.read_text(encoding='utf-8') == content
