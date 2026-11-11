"""Read XKeen command capabilities without executing its scripts."""

from __future__ import annotations

import os
import re
import shutil
import stat

_MAX_BYTES = 1024 * 1024
_CASE = re.compile(r'^( *)case\s+"\$1"\s+in\s*(?:#.*)?$')
_ANCHORS = {'-i', '-start', '-stop', '-restart', '-h'}


def parse_xkeen_dispatcher(source: str) -> set[str] | None:
    if not source.startswith('#!') or '\x00' in source:
        return None
    lines = source.splitlines()
    candidates: list[set[str]] = []
    for index, line in enumerate(lines):
        start = _CASE.fullmatch(line)
        if not start:
            continue
        indent = start.group(1)
        branch_indent = indent + '    '
        valid = re.compile(r'^' + re.escape(branch_indent) + r'(-[a-z][a-z0-9_-]*(?:\|-[a-z][a-z0-9_-]*)*)\)')
        maybe_branch = re.compile(r'^' + re.escape(branch_indent) + r'-\S*\)')
        flags: set[str] = set()
        fallback = False
        for row in lines[index + 1:]:
            if row == indent + 'esac':
                if _ANCHORS <= flags and fallback:
                    candidates.append(flags)
                break
            if '<<' in row and not row.lstrip().startswith('#'):
                flags.clear()
                break
            match = valid.match(row)
            if match:
                flags.update(match.group(1).split('|'))
            elif maybe_branch.match(row):
                flags.clear()
                break
            elif row.startswith(branch_indent + '*)'):
                fallback = True
    return candidates[0] if len(candidates) == 1 else None


def detect_xkeen_commands(command: str) -> set[str] | None:
    path = command if os.path.dirname(command) else shutil.which(command)
    if not path:
        return None
    try:
        if not stat.S_ISREG(os.stat(path).st_mode):
            return None
        with open(path, 'rb') as source:
            data = source.read(_MAX_BYTES + 1)
        if len(data) > _MAX_BYTES:
            return None
        return parse_xkeen_dispatcher(data.decode('utf-8'))
    except (OSError, UnicodeError, ValueError):
        return None
