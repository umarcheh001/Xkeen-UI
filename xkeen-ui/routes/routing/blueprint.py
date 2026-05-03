"""Routing-related API routes blueprint.

This module wires routing endpoints that were historically located in the
monolithic routes_routing.py.

Refactor checklist: B3 step 6 (split routes) + step 7 (routes_routing.py shim).
"""

from __future__ import annotations

from flask import Blueprint
from typing import Any, Callable, Dict, Optional

from .dat import register_dat_routes
from .geodat import register_geodat_routes
from .fragments import register_fragments_routes
from .config import register_config_routes
from .templates import register_templates_routes


_TEMPLATE_META: Dict[str, Dict[str, str]] = {
    "05_routing_base.jsonc": {
        "title": "Базовый пример (JSONC)",
        "description": "Селективный прокси (vless-reality) для Telegram/YouTube/Discord и др.; блокирует рекламу/QUIC/опасные UDP; остальное — direct.",
    },
    "05_routing_zkeen_only.jsonc": {
        "title": "Только заблокированное (zkeen)",
        "description": "Проксирует только списки ext:zkeen.dat (domains/other/youtube) и IP крупных CDN/VPS (akamai, amazon, cloudflare, discord, hetzner, ovh и др.) через vless-reality; остальное — direct; блокирует QUIC.",
    },
    "05_routing_all_proxy_except_ru.jsonc": {
        "title": "Всё в proxy, кроме RU",
        "description": "Проксирует весь трафик через vless-reality; RU-домены (category-ru + steam) и ext:zkeenip.dat:ru идут direct; bittorrent — direct; блокирует QUIC.",
    },
}


def create_routing_blueprint(
    ROUTING_FILE: str,
    ROUTING_FILE_RAW: str,
    XRAY_CONFIGS_DIR: str,
    XRAY_CONFIGS_DIR_REAL: str,
    BACKUP_DIR: str,
    BACKUP_DIR_REAL: str,
    load_json: Callable[[str, Dict[str, Any]], Optional[Dict[str, Any]]],
    strip_json_comments_text: Callable[[str], str],
    restart_xkeen: Callable[..., bool],
    append_restart_log: Callable[..., None] | None = None,
) -> Blueprint:
    """Create blueprint with /api/routing endpoints.

    Signature is kept compatible with app_factory.py.
    """

    bp = Blueprint("routing", __name__)

    # endpoints
    register_geodat_routes(bp)
    register_dat_routes(bp)
    register_fragments_routes(bp, xray_configs_dir=XRAY_CONFIGS_DIR, routing_file=ROUTING_FILE)
    register_config_routes(
        bp,
        routing_file=ROUTING_FILE,
        routing_file_raw=ROUTING_FILE_RAW,
        xray_configs_dir=XRAY_CONFIGS_DIR,
        xray_configs_dir_real=XRAY_CONFIGS_DIR_REAL,
        backup_dir=BACKUP_DIR,
        backup_dir_real=BACKUP_DIR_REAL,
        load_json=load_json,
        strip_json_comments_text=strip_json_comments_text,
        restart_xkeen=restart_xkeen,
        append_restart_log=append_restart_log,
    )
    register_templates_routes(
        bp,
        routing_file=ROUTING_FILE,
        strip_json_comments_text=strip_json_comments_text,
        template_meta=_TEMPLATE_META,
    )

    return bp
