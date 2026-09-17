"""Coordinate protected DNS with explicit xkeen service stops."""

from __future__ import annotations

from typing import Any, Callable, Dict

from services import dns_over_vless, mihomo_dns
from services.dns_guard import PROTECTION_LABELS, protection_owner


class DnsServiceLifecycleError(RuntimeError):
    """The DNS owner could not be released safely before service stop."""


def get_stop_protection(*, ui_state_dir: str, mihomo_config_file: str) -> Dict[str, Any]:
    owner = protection_owner(
        ui_state_dir=ui_state_dir,
        mihomo_config_file=mihomo_config_file,
    )
    # The shared watchdog treats transient status errors as "no owner" so it
    # can keep ticking. An explicit stop must be stricter: with a Mihomo
    # listener on port 53 and an unreadable firmware override, stopping xkeen
    # could strand every LAN client without DNS.
    if not owner and mihomo_config_file:
        status = mihomo_dns.get_status(
            config_file=mihomo_config_file,
            ui_state_dir=ui_state_dir,
        )
        if status.get("enabled"):
            owner = "mihomo-dns"
        elif (
            status.get("dns_listener_configured")
            and status.get("dns_override") is None
            and status.get("active_core") in {"", "mihomo"}
        ):
            raise DnsServiceLifecycleError(
                "Не удалось определить DNS override Keenetic при активном listener Mihomo."
            )
    return {
        "active": bool(owner),
        "owner": owner,
        "label": PROTECTION_LABELS.get(owner, owner),
    }


def release_for_service_stop(
    *,
    expected_owner: str,
    configs_dir: str,
    routing_file: str,
    ui_state_dir: str,
    mihomo_config_file: str,
    restart_xkeen: Callable[..., Any],
) -> Dict[str, Any]:
    """Transactionally return DNS to Keenetic before stopping xkeen."""

    current = get_stop_protection(
        ui_state_dir=ui_state_dir,
        mihomo_config_file=mihomo_config_file,
    )
    owner = str(current.get("owner") or "")
    expected = str(expected_owner or "")
    if not owner:
        return {"released": False, "owner": "", "already_inactive": True}
    if expected and owner != expected:
        raise DnsServiceLifecycleError(
            "Владелец защищённого DNS изменился; остановка отменена."
        )

    if owner == "dns-over-vless":
        result = dns_over_vless.apply_action(
            "disable",
            configs_dir=configs_dir,
            routing_file=routing_file,
            ui_state_dir=ui_state_dir,
            restart_xkeen=restart_xkeen,
        )
    elif owner == "mihomo-dns":
        from mihomo_server_core import save_config, validate_config

        status = mihomo_dns.get_status(
            config_file=mihomo_config_file,
            ui_state_dir=ui_state_dir,
        )
        action = "release" if status.get("can_release") else "disable"
        result = mihomo_dns.apply_action(
            action,
            config_file=mihomo_config_file,
            ui_state_dir=ui_state_dir,
            validate_config=validate_config,
            save_config=save_config,
            restart_xkeen=restart_xkeen,
        )
    else:
        raise DnsServiceLifecycleError("Неизвестный владелец защищённого DNS.")

    remaining = get_stop_protection(
        ui_state_dir=ui_state_dir,
        mihomo_config_file=mihomo_config_file,
    )
    if remaining.get("active"):
        raise DnsServiceLifecycleError(
            "Защищённый DNS остался активен; остановка xkeen отменена."
        )
    return {
        "released": True,
        "owner": owner,
        "label": PROTECTION_LABELS.get(owner, owner),
        "result": result,
    }


__all__ = [
    "DnsServiceLifecycleError",
    "get_stop_protection",
    "release_for_service_stop",
]
