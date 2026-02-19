"""Read/write helper for xkeen *.lst lists (ports / excludes).

PR13: moved out of app.py to keep app.py thin.
"""

from __future__ import annotations

import os
from typing import Dict, Tuple

from core.paths import BASE_ETC_DIR
from utils.fs import load_text, save_text


def _env_or_default_file(env_key: str, default_path: str) -> str:
    v = os.environ.get(env_key, "")
    if v and str(v).strip():
        vv = str(v).strip()
        return vv if vv.startswith("/") else os.path.join(BASE_ETC_DIR, vv)
    return default_path


# ---- Paths (with env overrides) ------------------------------------------------

PORT_PROXYING_FILE = _env_or_default_file(
    "XKEEN_PORT_PROXYING_FILE",
    os.path.join(BASE_ETC_DIR, "xkeen", "port_proxying.lst"),
)

PORT_EXCLUDE_FILE = _env_or_default_file(
    "XKEEN_PORT_EXCLUDE_FILE",
    os.path.join(BASE_ETC_DIR, "xkeen", "port_exclude.lst"),
)

# ip_exclude.lst historically lived in two possible locations:
#   - /opt/etc/xkeen/ip_exclude.lst (new)
#   - /opt/etc/xkeen_exclude.lst (legacy; v1.1.3.8)
# We support explicit override via XKEEN_IP_EXCLUDE_FILE and also auto-fallback
# to the legacy path if the new file doesn't exist.
_ip_exclude_default = os.path.join(BASE_ETC_DIR, "xkeen", "ip_exclude.lst")
_ip_exclude_legacy = os.path.join(BASE_ETC_DIR, "xkeen_exclude.lst")
IP_EXCLUDE_FILE = _env_or_default_file("XKEEN_IP_EXCLUDE_FILE", _ip_exclude_default)
try:
    if "XKEEN_IP_EXCLUDE_FILE" not in os.environ:
        if not os.path.exists(_ip_exclude_default) and os.path.exists(_ip_exclude_legacy):
            IP_EXCLUDE_FILE = _ip_exclude_legacy
except Exception:
    # best-effort
    pass


# ---- Defaults ------------------------------------------------------------------

DEFAULT_PORT_PROXYING = """#80
#443
#596:599

# (Раскомментируйте/добавьте по образцу) единичные порты и диапазоны для проскирования
"""
DEFAULT_PORT_EXCLUDE = """#
# Одновременно использовать порты проксирования и исключать порты нельзя
# Приоритет у портов проксирования
"""
DEFAULT_IP_EXCLUDE = """#192.168.0.0/16
#2001:db8::/32

# Добавьте необходимые IP и подсети без комментария # для исключения их из проксирования
"""


KIND_PORT_PROXYING = "port-proxying"
KIND_PORT_EXCLUDE = "port-exclude"
KIND_IP_EXCLUDE = "ip-exclude"

SUPPORTED_KINDS: Tuple[str, ...] = (
    KIND_PORT_PROXYING,
    KIND_PORT_EXCLUDE,
    KIND_IP_EXCLUDE,
)

_KIND_TO_PATH = {
    KIND_PORT_PROXYING: PORT_PROXYING_FILE,
    KIND_PORT_EXCLUDE: PORT_EXCLUDE_FILE,
    KIND_IP_EXCLUDE: IP_EXCLUDE_FILE,
}

_KIND_TO_DEFAULT = {
    KIND_PORT_PROXYING: DEFAULT_PORT_PROXYING,
    KIND_PORT_EXCLUDE: DEFAULT_PORT_EXCLUDE,
    KIND_IP_EXCLUDE: DEFAULT_IP_EXCLUDE,
}


def get_list_content(kind: str) -> str:
    if kind not in _KIND_TO_PATH:
        raise KeyError(f"Unsupported kind: {kind}")
    path = _KIND_TO_PATH[kind]
    default = _KIND_TO_DEFAULT.get(kind, "")
    return load_text(path, default=default)


def set_list_content(kind: str, content: str) -> None:
    if kind not in _KIND_TO_PATH:
        raise KeyError(f"Unsupported kind: {kind}")
    path = _KIND_TO_PATH[kind]
    save_text(path, content)
