"""Служебные данные панели, которые файловый менеджер только показывает.

По этим файлам панель возвращает владельцу его настройки: журнал вытеснения и
отложенные узлы подписок, снимки DNS-over-VLESS и DNS Mihomo, журнал операций с
модулями и копия прежней версии для отката. Правка руками здесь опаснее любого
сбоя: сломанный журнал молча не сработает ровно тогда, когда нужен.

Имена записаны здесь, а не взяты у владельцев: подписки и DNS-over-VLESS живут в
модуле Xray, DNS Mihomo -- в модуле Mihomo, и без них панель тоже запускается.
Совпадение с владельцами сторожит tests/test_panel_service_data_protection.py.
"""

from __future__ import annotations

import os
from typing import List, Tuple

# Пути и «вместе с содержимым»; относительно каталога состояния панели.
_INSIDE_PANEL: Tuple[Tuple[str, bool], ...] = (
    ("xray_subscriptions.json", False),
    ("xray-subscriptions", True),
    ("dns_over_vless.json", False),
    ("dns-over-vless", True),
    ("mihomo-dns", True),
    ("modules.json", False),
    ("module-installed.json", False),
    ("install-profile.json", False),
    ("install-managed.json", False),
    ("module-ownership-overrides.json", False),
    ("module-runtime.json", False),
)
# Каталоги рядом с панелью: журнал операций с модулями и прежняя версия.
_BESIDE_PANEL_SUFFIXES = (".module-transactions", ".previous-version")


def protected_panel_paths(ui_state_dir: str) -> List[Tuple[str, bool]]:
    """Путь и «вместе с содержимым» для всего служебного."""
    root = os.path.normpath(str(ui_state_dir or "/opt/etc/xkeen-ui"))
    paths: List[Tuple[str, bool]] = [(root, False)]
    paths += [(os.path.join(root, name), subtree) for name, subtree in _INSIDE_PANEL]
    paths += [(root + suffix, True) for suffix in _BESIDE_PANEL_SUFFIXES]
    return paths


def register_panel_data_protection(ui_state_dir: str) -> None:
    from services.fs_common.local import protect_local_path

    for path, subtree in protected_panel_paths(ui_state_dir):
        protect_local_path(path, subtree=subtree)
