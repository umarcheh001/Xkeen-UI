from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from flask import Flask

from services import xkeen as xkeen_service



def test_build_xkeen_control_cmds_prefers_init_script_before_cli(monkeypatch):
    monkeypatch.setattr(xkeen_service, 'resolve_xkeen_init_script', lambda: '/opt/etc/init.d/S05xkeen')
    monkeypatch.setattr(xkeen_service, 'build_xkeen_cmd', lambda flag: ['xkeen', flag])

    commands = xkeen_service.build_xkeen_control_cmds('restart', prefer_init=True)

    assert commands == [
        ['/opt/etc/init.d/S05xkeen', 'restart'],
        ['xkeen', '-restart'],
    ]



def test_control_xkeen_action_falls_back_when_first_command_does_not_change_runtime_state(monkeypatch):
    monkeypatch.setattr(
        xkeen_service,
        'build_xkeen_control_cmds',
        lambda action, primary_cmd=None, prefer_init=True: [
            ['xkeen', f'-{action}'],
            ['/opt/etc/init.d/S05xkeen', action],
        ],
    )

    dispatched: list[tuple[str, ...]] = []
    monkeypatch.setattr(
        xkeen_service,
        '_dispatch_xkeen_control_command',
        lambda cmd, dispatch_timeout: dispatched.append(tuple(cmd)) or True,
    )

    attempts = {'count': 0}

    def fake_wait(expected_running: bool, *, timeout: float, poll_interval: float = 0.25) -> bool:
        attempts['count'] += 1
        return attempts['count'] >= 2 and expected_running is True

    monkeypatch.setattr(xkeen_service, '_wait_xkeen_running', fake_wait)
    monkeypatch.setattr(xkeen_service, 'is_xkeen_running', lambda: False)

    assert xkeen_service.control_xkeen_action('start', prefer_init=True) is True
    assert dispatched == [
        ('xkeen', '-start'),
        ('/opt/etc/init.d/S05xkeen', 'start'),
    ]



def test_restart_xkeen_logs_result_from_verified_control_flow(tmp_path, monkeypatch):
    log_file = tmp_path / 'restart.log'
    seen: list[tuple[str, tuple[str, ...] | None]] = []

    def fake_control(action: str, **kwargs) -> bool:
        primary = kwargs.get('primary_cmd')
        seen.append((action, tuple(primary) if primary else None))
        return True

    monkeypatch.setattr(xkeen_service, 'control_xkeen_action', fake_control)
    monkeypatch.setattr(xkeen_service, 'detect_xkeen_runtime_core', lambda: 'xray')

    ok = xkeen_service.restart_xkeen(['xkeen', '-restart'], str(log_file), source='api-button')

    assert ok is True
    assert seen == [('restart', ('xkeen', '-restart'))]
    text = log_file.read_text(encoding='utf-8')
    assert 'source=api-button' in text
    assert 'result=OK' in text
    assert 'runtime_status=running' in text
    assert 'runtime_core=xray' in text
    assert 'duration_ms=' in text



def test_service_routes_use_verified_control_helper_for_start_and_stop():
    text = Path('xkeen-ui/routes/service.py').read_text(encoding='utf-8')

    assert 'ok = control_xkeen_action("start", prefer_init=True)' in text
    assert 'ok = control_xkeen_action("stop", prefer_init=True)' in text
    assert 'subprocess.check_call(build_xkeen_cmd("-start"))' not in text
    assert 'subprocess.check_call(build_xkeen_cmd("-stop"))' not in text


def test_core_switch_route_writes_restart_log_entry_with_metadata(monkeypatch, tmp_path):
    from routes import service

    seen: list[tuple[bool, str, dict[str, object]]] = []
    runtime_logs: list[str] = []

    monkeypatch.setattr(service, 'get_cores_status', lambda: (['xray', 'mihomo'], 'xray'))
    monkeypatch.setattr(service, 'get_xkeen_runtime_status', lambda: {
        'runtime_status': 'running',
        'runtime_core': 'mihomo',
    })
    def fake_switch_core(core, error_log, runtime_log=None):
        if runtime_log:
            runtime_log('[xkeen-ui] start: start cmd=xkeen -start timeout=60s\n')
            runtime_log('Proxy-client started\n')

    monkeypatch.setattr(service, 'switch_core', fake_switch_core)

    app = Flask('service-core-switch-log')
    app.register_blueprint(
        service.create_service_blueprint(
            restart_xkeen=lambda **_kwargs: True,
            append_restart_log=lambda ok, source='api', **meta: seen.append((ok, source, meta)),
            append_restart_log_text=lambda text: runtime_logs.append(text),
            XRAY_ERROR_LOG=str(tmp_path / 'xray-error.log'),
        )
    )

    response = app.test_client().post('/api/xkeen/core', json={'core': 'mihomo'})

    assert response.status_code == 200
    assert response.get_json()['restarted'] is True
    assert seen
    ok, source, meta = seen[-1]
    assert ok is True
    assert source == 'core-switch'
    assert meta['core'] == 'mihomo'
    assert meta['previous'] == 'xray'
    assert meta['runtime_status'] == 'running'
    assert meta['runtime_core'] == 'mihomo'
    assert isinstance(meta['duration_ms'], int)
    assert runtime_logs == ['[xkeen-ui] start: start cmd=xkeen -start timeout=60s\nProxy-client started\n']


def test_core_switch_start_does_not_wait_for_foreground_start_command(monkeypatch, tmp_path):
    from services import cores

    runtime_logs: list[str] = []
    start_seen = {'value': False}

    monkeypatch.setenv('XKEEN_CORE_START_GRACE_AFTER_RUNNING_MS', '0')
    monkeypatch.setattr(cores, 'build_xkeen_cmd', lambda flag: ['xkeen', flag])
    monkeypatch.setattr(cores, 'detect_running_core', lambda: 'mihomo' if start_seen['value'] else 'xray')
    monkeypatch.setattr(
        cores.subprocess,
        'run',
        lambda *_args, **_kwargs: SimpleNamespace(stdout='Прокси-клиент остановлен\n  Выполнена смена ядра на Mihomo\n'),
    )

    class FakeStartProcess:
        returncode = None

        def __init__(self, _cmd, stdin=None, stdout=None, stderr=None):
            start_seen['value'] = True
            if stdout is not None:
                output = (
                    'Прокси-клиент запущен в режиме Mihomo\n'
                    'infra/conf/serial: Reading config: noisy.yaml\n'
                    'INFO[2026-05-05T18:05:24Z] Initial configuration complete, total time: 8ms\n'
                )
                stdout.write(output.encode('utf-8'))
                stdout.flush()

        def poll(self):
            return self.returncode

        def terminate(self):
            self.returncode = -15

        def wait(self, timeout=None):
            return self.returncode

        def kill(self):
            self.returncode = -9

    monkeypatch.setattr(cores.subprocess, 'Popen', FakeStartProcess)

    cores.switch_core('mihomo', str(tmp_path / 'xray-error.log'), runtime_log=runtime_logs.append)

    combined = ''.join(runtime_logs)
    assert 'Прокси-клиент запущен в режиме Mihomo' in combined
    assert 'Initial configuration complete' in combined
    assert 'infra/conf/serial' not in combined
    assert '[xkeen-ui]' not in combined
    assert 'TIMEOUT' not in combined


def test_service_status_restart_button_uses_background_restart_job_with_pty_log_stream():
    text = Path('xkeen-ui/static/js/features/service_status.js').read_text(encoding='utf-8')

    assert "fetch('/api/run-command', {" in text
    assert "body: JSON.stringify({ flag: '-restart', pty: true })" in text
    assert 'waitForRestartJob(jobId' in text


def test_service_status_polls_runtime_status_without_http_cache():
    text = Path('xkeen-ui/static/js/features/service_status.js').read_text(encoding='utf-8')

    assert "fetch('/api/xkeen/status', {" in text
    assert "cache: 'no-store'" in text


def test_core_switch_modal_sets_loading_during_submit():
    text = Path('xkeen-ui/static/js/features/service_status.js').read_text(encoding='utf-8')
    confirm_src = text.split('async function confirmXkeenCoreChange()', 1)[1].split('function bindCoreModalUI()', 1)[0]

    assert '_coreModalLoading = true;' in confirm_src
    assert confirm_src.count('_coreModalLoading = false;') >= 2
