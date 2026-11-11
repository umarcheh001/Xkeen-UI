from __future__ import annotations

import os
from pathlib import Path

import pytest

from services.xkeen_command_capabilities import detect_xkeen_commands, parse_xkeen_dispatcher
from services.xkeen_commands_catalog import ALLOWED_FLAGS, COMMAND_GROUPS


def dispatcher(extra: str = "") -> str:
    return """#!/bin/sh
while [ $# -gt 0 ]; do
    case "$1" in
        -i|-install) echo install ;;
        -start) echo start ;;
        -stop) echo stop ;;
        -restart) echo restart ;;
        -h|-help) echo help ;;
""" + extra + """        *) echo unknown ;;
    esac
    shift
done
"""


def test_extracts_outer_flags_and_ignores_nested_cases_and_comments() -> None:
    source = dispatcher('''        -uy) echo update ;;
        -sb)
            case "$2" in
                -fake) echo fake ;;
            esac
            ;;
        # -comment) echo ignored ;;
''')
    flags = parse_xkeen_dispatcher(source)
    assert flags is not None
    assert {'-i', '-h', '-start', '-stop', '-restart', '-uy', '-sb'} <= flags
    assert '-fake' not in flags and '-comment' not in flags


@pytest.mark.parametrize('source', [
    '', dispatcher().replace('    esac\n', ''),
    dispatcher() + dispatcher(),
    dispatcher('        cat <<EOF\n        -uy) fake ;;\nEOF\n'),
    dispatcher().replace('        -h|-help)', '        -h|*)'),
])
def test_unrecognized_or_ambiguous_script_has_unknown_capabilities(source: str) -> None:
    assert parse_xkeen_dispatcher(source) is None


def test_detection_reads_file_without_executing_and_reflects_replacement(tmp_path: Path) -> None:
    path = tmp_path / 'xkeen'
    marker = tmp_path / 'ran'
    path.write_text(dispatcher(f'        -uy) touch {marker} ;;\n'), encoding='utf-8')
    first = detect_xkeen_commands(str(path))
    assert first is not None and '-uy' in first
    assert not marker.exists()
    path.write_text(dispatcher(), encoding='utf-8')
    second = detect_xkeen_commands(str(path))
    assert second is not None and '-uy' not in second


def test_missing_unreadable_invalid_and_oversized_are_unknown(tmp_path: Path) -> None:
    assert detect_xkeen_commands(str(tmp_path / 'missing')) is None
    path = tmp_path / 'xkeen'
    path.write_bytes(b'\xff')
    assert detect_xkeen_commands(str(path)) is None
    path.write_bytes(b'x' * (1024 * 1024 + 1))
    assert detect_xkeen_commands(str(path)) is None
    assert detect_xkeen_commands(str(tmp_path)) is None


def test_resolves_symlink_to_read_installed_command(tmp_path: Path) -> None:
    target = tmp_path / 'target'
    target.write_text(dispatcher(), encoding='utf-8')
    link = tmp_path / 'xkeen'
    try:
        os.symlink(target, link)
    except OSError:
        pytest.skip('creating symlinks is unavailable')
    assert '-start' in detect_xkeen_commands(str(link))


def test_new_catalog_entries_are_grouped_and_allowed() -> None:
    groups = {group['title']: {item['flag'] for item in group['items']} for group in COMMAND_GROUPS}
    assert '-health' in groups['Установка']
    assert {'-diag', '-cfd', '-xtest', '-mtest'} <= groups['Диагностика']
    assert {'-dscp', '-startvb'} <= groups['Настройки XKeen']
    assert {'-di', '-sb'} <= groups['Управление прокси-клиентом']
    assert {'-health', '-cfd', '-di', '-xtest', '-mtest', '-dscp', '-startvb', '-sb'} <= ALLOWED_FLAGS


def test_capability_endpoint_reports_unknown_and_known(monkeypatch: pytest.MonkeyPatch) -> None:
    from flask import Flask
    import routes.commands as commands

    app = Flask(__name__)
    app.register_blueprint(commands.create_commands_blueprint())
    monkeypatch.setattr(commands, 'detect_xkeen_commands', lambda _cmd: None)
    client = app.test_client()
    result = client.get('/api/xkeen/command-capabilities')
    assert result.json == {'known': False, 'flags': []}
    monkeypatch.setattr(commands, 'detect_xkeen_commands', lambda _cmd: {'-uy', '-start'})
    result = client.get('/api/xkeen/command-capabilities')
    assert result.json == {'known': True, 'flags': ['-start', '-uy']}
    assert 'no-store' in result.headers['Cache-Control']
