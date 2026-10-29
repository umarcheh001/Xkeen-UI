"""Exercise stop_service with a deterministic process/clock, without real signals."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from tests.test_panel_init_pid_identity import _function
from tests.test_install_terminal_ui import _shell


def _stop(tmp_path: Path, saves_after: int, *, slow_audit: bool = False) -> dict:
    script = tmp_path / 'stop.sh'
    # The external process stays alive until its final write completes. sleep
    # advances its clock; SIGKILL prevents that write. No wall-clock sleeps.
    script.write_text('\n'.join([
        'set -e', f'cd "{tmp_path.as_posix()}"', 'PID_FILE=panel.pid',
        'echo 4242 > "$PID_FILE"', 'elapsed=0', 'alive=1', 'forced=0',
        'term_at=-1', 'kill_at=-1',
        'panel_pid() { echo 4242; }',
        ('audit_boot() { sleep 5; printf "%s\\n" "$*" >> audit.log; }' if slow_audit
         else 'audit_boot() { printf "%s\\n" "$*" >> audit.log; }'),
        'kill() {',
        '  case "$1" in',
        '    -0) [ "$alive" = 1 ] ;;',
        '    -9) alive=0; forced=1; kill_at=$elapsed ;;',
        '    *) term_at=$elapsed ;;',
        '  esac',
        '}',
        'sleep() {',
        '  elapsed=$((elapsed + $1))',
        f'  if [ "$elapsed" -ge {saves_after} ] && [ "$alive" = 1 ]; then',
        '    echo fresh-history > saved; alive=0',
        '  fi',
        '}', _function('stop_service'), 'stop_service',
        # Only the harness joins background loggers, after stop_service returned.
        'wait',
        'printf \'{"elapsed":%s,"forced":%s,"term_at":%s,"kill_at":%s}\\n\' "$elapsed" "$forced" "$term_at" "$kill_at" > result.json',
        '',
    ]), encoding='utf-8', newline='\n')
    run = subprocess.run([_shell(), script.as_posix()], capture_output=True, text=True, timeout=10)
    assert run.returncode == 0, run.stdout + run.stderr
    result = json.loads((tmp_path / 'result.json').read_text())
    result['saved'] = (tmp_path / 'saved').exists()
    result['audit'] = (tmp_path / 'audit.log').read_text() if (tmp_path / 'audit.log').exists() else ''
    return result


def test_slow_final_write_is_not_killed_after_three_seconds(tmp_path):
    result = _stop(tmp_path, saves_after=6)
    assert result['saved'], 'Process killed before completing its final history write'
    assert result['forced'] == 0


def test_stuck_shutdown_is_bounded_and_audited(tmp_path):
    result = _stop(tmp_path, saves_after=100)
    assert not result['saved']
    assert result['forced'] == 1
    assert 1 <= result['elapsed'] <= 15
    assert 'SIGKILL' in result['audit']


def test_fast_final_write_does_not_wait_for_full_budget(tmp_path):
    result = _stop(tmp_path, saves_after=1)
    assert result['saved'] and result['forced'] == 0
    assert result['elapsed'] == 1


def test_slow_boot_log_cannot_delay_term_or_kill(tmp_path):
    result = _stop(tmp_path, saves_after=100, slow_audit=True)
    assert result['term_at'] == 0
    assert 0 < result['kill_at'] <= 15
