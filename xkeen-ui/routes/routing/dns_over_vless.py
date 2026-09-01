"""HTTP API for the guarded DNS-over-VLESS assistant."""

from __future__ import annotations

from typing import Any, Callable

from flask import Blueprint, jsonify, request

from services.dns_clients import client_report
from services.dns_guard import conflicting_protection
from services.dns_over_vless import DnsOverVlessError, apply_action, get_status


def register_dns_over_vless_routes(
    bp: Blueprint,
    *,
    xray_configs_dir: str,
    routing_file: str,
    ui_state_dir: str,
    restart_xkeen: Callable[..., Any],
    mihomo_config_file: str = "",
    append_restart_log: Callable[..., None] | None = None,
) -> None:
    def audit(ok: bool, **meta: Any) -> None:
        if append_restart_log is None:
            return
        try:
            append_restart_log(ok, source="dns-over-vless", **meta)
        except Exception:
            pass

    @bp.get("/api/routing/dns-over-vless")
    def api_dns_over_vless_status() -> Any:
        try:
            return jsonify(
                get_status(
                    configs_dir=xray_configs_dir,
                    routing_file=routing_file,
                    ui_state_dir=ui_state_dir,
                )
            )
        except DnsOverVlessError as exc:
            return jsonify({"ok": False, "error": str(exc), "code": exc.code, "details": exc.details}), 409
        except Exception:
            return jsonify({"ok": False, "error": "Не удалось проверить DNS-over-VLESS.", "code": "status_failed"}), 500

    @bp.get("/api/routing/dns-over-vless/clients")
    def api_dns_over_vless_clients() -> Any:
        # Kept out of the status call: reading the device list talks to the
        # firmware and is far slower than everything else the card needs.
        try:
            return jsonify(client_report())
        except Exception:
            return jsonify(
                {
                    "ok": False,
                    "available": False,
                    "error": "Не удалось выяснить, кто из устройств пользуется DNS-over-VLESS.",
                    "clients": [],
                    "counts": {"total": 0, "reaches": 0, "intercepted": 0, "unknown": 0},
                }
            ), 200

    @bp.post("/api/routing/dns-over-vless")
    def api_dns_over_vless_apply() -> Any:
        payload = request.get_json(silent=True) or {}
        action = str(payload.get("action") or "").strip().lower()
        # Accept one tag or several: several plain proxies are balanced together.
        raw_target = payload.get("targets")
        if raw_target is None:
            raw_target = payload.get("target")
        target_tag = raw_target if isinstance(raw_target, list) else str(raw_target or "").strip()
        # Omitted keys mean "keep what this install already uses"; an empty
        # local resolver means "switch the local exception off".
        upstreams = payload.get("upstreams", None)
        local_resolver = payload.get("local_resolver", None)
        local_domains = payload.get("local_domains", None)
        direct_resolver = payload.get("direct_resolver", None)
        direct_domains = payload.get("direct_domains", None)
        # Whether the record types the built-in DNS cannot answer are let
        # through, and which node carries them.
        # Whether the DNS servers above are resolved at the exit node.
        upstreams_remote = payload.get("upstreams_remote", None)
        pass_non_ip = payload.get("pass_non_ip", None)
        pass_non_ip_node = payload.get("pass_non_ip_node", None)
        # Whether devices whose DNS the firmware takes away are brought back
        # with a rule of our own, and which of them.
        capture_clients = payload.get("capture_clients", None)
        capture_macs = payload.get("capture_macs", None)
        # Both assistants flip the same firmware switch and both want port 53.
        # Turning the second one on would overwrite the first one's record of the
        # original setting, leaving nothing able to put it back.
        if action == "enable":
            conflict = conflicting_protection(
                want="dns-over-vless",
                ui_state_dir=ui_state_dir,
                mihomo_config_file=mihomo_config_file,
            )
            if conflict:
                message = "Сначала выключите %s: обе защиты DNS одновременно работать не могут." % conflict
                audit(False, action=action, phase="dns_protection_conflict", summary=message)
                return jsonify(
                    {"ok": False, "error": message, "code": "dns_protection_conflict"}
                ), 409

        try:
            result = apply_action(
                action,
                configs_dir=xray_configs_dir,
                routing_file=routing_file,
                ui_state_dir=ui_state_dir,
                restart_xkeen=restart_xkeen,
                target_tag=target_tag,
                upstreams=upstreams,
                local_resolver=local_resolver,
                local_domains=local_domains,
                direct_resolver=direct_resolver,
                direct_domains=direct_domains,
                upstreams_remote=upstreams_remote,
                pass_non_ip=pass_non_ip,
                pass_non_ip_node=pass_non_ip_node,
                capture_clients=capture_clients,
                capture_macs=capture_macs,
            )
            audit(True, action=action, summary=("DNS-over-VLESS включён" if action == "enable" else "DNS-over-VLESS отключён"))
            return jsonify(result)
        except DnsOverVlessError as exc:
            audit(False, action=action, phase=exc.code, summary=str(exc))
            return jsonify(
                {
                    "ok": False,
                    "error": str(exc),
                    "code": exc.code,
                    "details": exc.details,
                    "rolled_back": True,
                }
            ), 409
        except Exception:
            audit(False, action=action, phase="unexpected", summary="Ошибка DNS-over-VLESS")
            return jsonify(
                {
                    "ok": False,
                    "error": "Не удалось применить DNS-over-VLESS; выполнен откат.",
                    "code": "apply_failed",
                    "rolled_back": True,
                }
            ), 500
