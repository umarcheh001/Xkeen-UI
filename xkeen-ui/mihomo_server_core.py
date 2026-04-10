# Частично основано на коде из проекта "Mihomo Studio"
# Copyright (c) 2024 l-ptrol
# Исходный репозиторий: https://github.com/l-ptrol/mihomo_studio
# Лицензия: MIT

"""Compatibility facade for XKeen UI Mihomo backend.

The actual implementation now lives in smaller service modules:
  1. ``services.mihomo_proxy_parsers``   - proxy/WireGuard parsing helpers.
  2. ``services.mihomo_proxy_config``    - config.yaml proxy/group editing.
  3. ``services.mihomo_runtime``         - profiles, backups, save/restart.

This module intentionally re-exports the legacy public surface so the rest of
the backend can migrate gradually without breaking old imports.
"""

from __future__ import annotations

from services.mihomo_runtime import (
    MIHOMO_ROOT,
    CONFIG_PATH,
    PROFILES_DIR,
    BACKUP_DIR,
    ProfileInfo,
    BackupInfo,
    ensure_mihomo_layout,
    get_active_profile_name,
    list_profiles,
    get_profile_content,
    create_profile,
    delete_profile,
    switch_active_profile,
    list_backups,
    create_backup_for_active_profile,
    delete_backup,
    read_backup,
    restore_backup,
    clean_backups,
    save_config,
    restart_mihomo_and_get_log,
    validate_config,
)
from services.mihomo_proxy_parsers import (
    ProxyParseResult,
    _yaml_list,
    _yaml_str,
    parse_hysteria2,
    parse_proxy_uri,
    parse_shadowsocks,
    parse_trojan,
    parse_vless,
    parse_vmess,
    parse_wireguard,
)
from services.mihomo_proxy_config import (
    insert_proxy_into_groups,
    replace_proxy_block,
    replace_proxy_in_config,
    rename_proxy_in_config,
    apply_proxy_insert,
    apply_insert,
)


__all__ = [
    # runtime paths
    'MIHOMO_ROOT',
    'CONFIG_PATH',
    'PROFILES_DIR',
    'BACKUP_DIR',
    # parsers
    '_yaml_str',
    '_yaml_list',
    'ProxyParseResult',
    'parse_proxy_uri',
    'parse_vless',
    'parse_trojan',
    'parse_vmess',
    'parse_shadowsocks',
    'parse_hysteria2',
    'parse_wireguard',
    # config manipulation
    'insert_proxy_into_groups',
    'replace_proxy_block',
    'replace_proxy_in_config',
    'rename_proxy_in_config',
    'apply_proxy_insert',
    'apply_insert',
    # profiles / backups
    'ProfileInfo',
    'BackupInfo',
    'ensure_mihomo_layout',
    'get_active_profile_name',
    'list_profiles',
    'get_profile_content',
    'create_profile',
    'delete_profile',
    'switch_active_profile',
    'list_backups',
    'create_backup_for_active_profile',
    'delete_backup',
    'read_backup',
    'restore_backup',
    'clean_backups',
    # save + restart
    'save_config',
    'restart_mihomo_and_get_log',
    'validate_config',
]
