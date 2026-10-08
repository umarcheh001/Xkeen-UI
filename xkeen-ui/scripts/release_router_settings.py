#!/usr/bin/env python3
"""Give back to the router what the panel holds outside its own files.

    release_router_settings.py

Called by ``uninstall.sh`` before the panel is removed. The DNS protection
(DNS-over-VLESS of Xray or the DNS of Mihomo) switches the firmware's own DNS
off and keeps a managed piece in the config of the core: removing the panel
without undoing that would leave the router with settings nothing can take
back any more. The same code switches it off that the panel uses before it
stops the service.

Exit codes: 0 - nothing was held, or it was given back; 1 - it could not be
given back (the reason is the last line that starts with "[!]").
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any, Callable


PANEL_DIR = Path(__file__).resolve().parents[1]
if str(PANEL_DIR) not in sys.path:
    sys.path.insert(0, str(PANEL_DIR))


def _ui_state_dir() -> str:
    from core.settings import Settings

    return str(Settings.from_env().ui_state_dir)


def _xray_paths(ui_state_dir: str) -> tuple[str, str]:
    """The folder of Xray configs and the routing file, as the panel sees them."""

    try:
        from services.xray_config_files import ROUTING_FILE, XRAY_CONFIGS_DIR

        return str(XRAY_CONFIGS_DIR), str(ROUTING_FILE)
    except Exception:
        # The Xray module is not installed: the paths are only needed to find
        # out that nothing of it is switched on.
        configs = os.environ.get("XKEEN_XRAY_CONFIGS_DIR", "/opt/etc/xray/configs")
        return configs, os.environ.get("XKEEN_XRAY_ROUTING_FILE", os.path.join(configs, "05_routing.json"))


def _mihomo_config_file() -> str:
    # Only looked at, never prepared: the helpers the panel starts with create
    # the Mihomo folders, and an uninstall must not leave new ones behind.
    path = os.path.join(os.environ.get("MIHOMO_ROOT") or "/opt/etc/mihomo", "config.yaml")
    return path if os.path.isfile(path) else ""


def _restart_xkeen(ui_state_dir: str) -> Callable[..., Any]:
    from services.xkeen import restart_xkeen
    from services.xkeen_commands_catalog import build_xkeen_cmd

    command = build_xkeen_cmd("-restart")
    log_file = os.environ.get("XKEEN_RESTART_LOG_FILE", os.path.join(ui_state_dir, "restart.log"))

    def restart(source: str = "uninstall"):
        return restart_xkeen(command, log_file, source=source)

    return restart


def release_dns_protection(
    *,
    release: Callable[..., dict] | None = None,
    out: Callable[[str], None] = print,
) -> int:
    """Switch the DNS protection off if it is on; the exit code of the script."""

    try:
        if release is None:
            from services.dns_service_lifecycle import release_for_service_stop as release
    except Exception:
        # Neither engine module is installed: there is no protection to hold.
        out("[*] Защита DNS в этой установке панели не используется.")
        return 0
    try:
        ui_state_dir = _ui_state_dir()
        configs_dir, routing_file = _xray_paths(ui_state_dir)
        result = release(
            expected_owner="",
            configs_dir=configs_dir,
            routing_file=routing_file,
            ui_state_dir=ui_state_dir,
            mihomo_config_file=_mihomo_config_file(),
            restart_xkeen=_restart_xkeen(ui_state_dir),
        )
    except Exception as error:  # noqa: BLE001 - the reason goes to the owner
        out("[!] Не удалось выключить защиту DNS: %s" % (str(error).strip() or error.__class__.__name__))
        return 1
    if isinstance(result, dict) and result.get("released"):
        out("[*] Выключена %s: DNS возвращён роутеру." % (result.get("label") or "защита DNS"))
    else:
        out("[*] Защита DNS не включена.")
    return 0


def main(argv=None) -> int:
    return release_dns_protection()


if __name__ == "__main__":
    raise SystemExit(main())
