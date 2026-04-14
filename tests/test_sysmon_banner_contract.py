from __future__ import annotations

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_SRC = REPO_ROOT / "xkeen-ui" / "tools" / "sysmon_keenetic.sh"


def test_sysmon_banner_uses_wider_first_value_column() -> None:
    source = SCRIPT_SRC.read_text(encoding="utf-8")

    assert '%-32s${B_WHT}%-14s${_bc}%s${NC}\\n' in source
    assert '%-28s${B_WHT}%-14s${_bc}%s${NC}\\n' not in source


def test_sysmon_banner_accessed_ip_uses_helper_with_fallbacks() -> None:
    source = SCRIPT_SRC.read_text(encoding="utf-8")

    assert "get_banner_accessed_ip()" in source
    assert '_accessed_ip="$(get_banner_accessed_ip 2>/dev/null || echo' in source
    assert 'SSH_CONNECTION' in source
    assert 'XKEEN_UI_ACCESSED_IP' in source
    assert 'hostname -i' in source
    assert 'ip -4 -o addr show scope global' in source
    assert 'ifconfig 2>/dev/null' in source
    assert '_accessed_ip="$(hostname -i 2>/dev/null || echo' not in source
