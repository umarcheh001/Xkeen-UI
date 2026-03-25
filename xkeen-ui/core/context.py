"""Application context (typed).

Historically the project passed a plain ``dict`` named ``ctx`` around during
application composition / blueprint registration. That approach is fragile:
typos in magic keys surface as runtime ``KeyError`` far away from the source.

Commit O introduces :class:`~core.context.AppContext` as a typed container.
The goal is **no behavior change** while making the code safer to refactor.
"""

from __future__ import annotations

from dataclasses import dataclass
from logging import Logger
from typing import TYPE_CHECKING, Any, Callable, Optional

if TYPE_CHECKING:
    from core.settings import Settings


@dataclass
class AppContext:
    """Typed application context passed into blueprint registration."""

    # Core
    settings: "Settings"
    logger: Logger

    # Paths / repo info
    ui_state_dir: str
    github_owner: str
    github_repo: str

    mihomo_config_file: str
    mihomo_templates_dir: str
    mihomo_default_template: str

    xray_configs_dir: str
    xray_configs_dir_real: str

    routing_file: str
    routing_file_raw: str
    inbounds_file: str
    outbounds_file: str

    backup_dir: str
    backup_dir_real: str

    xray_error_log: str

    # Helpers / services (callables)
    load_json: Callable[..., Any]
    save_json: Callable[..., Any]
    strip_json_comments_text: Callable[..., Any]

    snapshot_xray_config_before_overwrite: Callable[..., Any]
    list_backups: Callable[..., Any]
    detect_backup_target_file: Callable[..., Any]
    find_latest_auto_backup_for: Callable[..., Any]

    restart_xkeen: Callable[..., Any]
    append_restart_log: Callable[..., Any]
    read_restart_log: Optional[Callable[..., Any]] = None
    clear_restart_log: Optional[Callable[..., Any]] = None

    ws_debug: Callable[..., Any] = lambda *a, **k: None  # type: ignore
    restart_xray_core: Callable[..., Any] = lambda *a, **k: (False, "")  # type: ignore
