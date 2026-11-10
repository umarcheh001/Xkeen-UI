"""Read-only, on-demand provider endpoint diagnostics API."""

from __future__ import annotations

from flask import Blueprint, jsonify, request

from services.provider_diagnostics import (
    compare_public_dns,
    current_mihomo_targets,
    compare_tls_path,
    compare_resource_paths,
    lookup_public_lists,
    parse_source,
    probe_proxy_context,
    probe_target,
    read_current_xray_targets,
    register_proxy_context,
)
from services.provider_diagnostics_extended import advanced_probe, tls_profile_probe


def create_provider_diagnostics_blueprint(*, xray_configs_dir: str, mihomo_config_file: str) -> Blueprint:
    bp = Blueprint("provider_diagnostics", __name__)

    @bp.get("/api/provider-diagnostics/targets")
    def targets():
        core = str(request.args.get("core") or "").lower()
        if core == "xray":
            try:
                offset = int(request.args.get("offset", "0"))
            except ValueError:
                return jsonify({"ok": False, "error": "Некорректная страница серверов."}), 400
            if not 0 <= offset <= 100_000:
                return jsonify({"ok": False, "error": "Некорректная страница серверов."}), 400
            outbounds = []
            result = read_current_xray_targets(xray_configs_dir, offset=offset, probe_outbounds=outbounds)
            ref = register_proxy_context(outbounds, len(result["targets"]), result["targets"])
            if ref:
                for index, (target, outbound) in enumerate(zip(result["targets"], outbounds)):
                    if outbound is not None:
                        target.update(proxy_ref=ref, proxy_index=index)
        elif core == "mihomo":
            outbounds = []
            items = current_mihomo_targets(mihomo_config_file, probe_proxies=outbounds)
            result = {"targets": items, "has_more": False, "next_offset": len(items)}
            ref = register_proxy_context(outbounds, len(items), items)
            if ref:
                for index, (target, outbound) in enumerate(zip(items, outbounds)):
                    if outbound is not None:
                        target.update(proxy_ref=ref, proxy_index=index, proxy_engine="mihomo")
        else:
            return jsonify({"ok": False, "error": "Выберите Xray или Mihomo."}), 400
        return jsonify({"ok": True, "source": "saved_config", **result})

    @bp.post("/api/provider-diagnostics/parse")
    def parse():
        payload = request.get_json(silent=True) or {}
        if not isinstance(payload, dict) or not isinstance(payload.get("source"), str):
            return jsonify({"ok": False, "error": "Введите данные для проверки."}), 400
        try:
            outbounds = []
            core = payload.get("core", "xray")
            if core not in {"xray", "mihomo"}:
                raise ValueError("Выберите Xray или Mihomo.")
            result = parse_source(payload["source"], probe_outbounds=outbounds, core=core)
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        ref = register_proxy_context(outbounds, len(result["targets"]), result["targets"])
        if ref:
            for index, (target, outbound) in enumerate(zip(result["targets"], outbounds)):
                if outbound is not None:
                    engine = outbound.get("_diagnostics_engine", "xray")
                    target.update(proxy_ref=ref, proxy_index=index, proxy_engine=engine)
        return jsonify({"ok": True, **result})

    @bp.post("/api/provider-diagnostics/advanced-probe")
    def advanced():
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify({"ok": False, "error": "Некорректная расширенная проверка."}), 400
        try:
            result = advanced_probe(payload)
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        return jsonify({"ok": True, "result": result})

    @bp.post("/api/provider-diagnostics/tls-profile")
    def tls_profile():
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify({"ok": False, "error": "Некорректная проверка TLS-профиля."}), 400
        try:
            result = tls_profile_probe(payload)
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        return jsonify({"ok": True, "result": result})

    @bp.post("/api/provider-diagnostics/proxy-probe")
    def proxy_probe():
        payload = request.get_json(silent=True) or {}
        if not isinstance(payload, dict):
            return jsonify({"ok": False, "error": "Некорректная проверка прокси."}), 400
        try:
            result = probe_proxy_context(payload.get("ref"), payload.get("index"))
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        return jsonify({"ok": True, "result": result})

    @bp.post("/api/provider-diagnostics/resource-compare")
    def resource_compare():
        payload = request.get_json(silent=True) or {}
        if not isinstance(payload, dict):
            return jsonify({"ok": False, "error": "Некорректная проверка ресурса."}), 400
        try:
            result = compare_resource_paths(payload)
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        return jsonify({"ok": True, "result": result})

    @bp.post("/api/provider-diagnostics/probe")
    def probe():
        payload = request.get_json(silent=True) or {}
        if not isinstance(payload, dict):
            return jsonify({"ok": False, "error": "Некорректная цель проверки."}), 400
        try:
            result = probe_target(payload)
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        return jsonify({"ok": True, "result": result})

    @bp.post("/api/provider-diagnostics/dns-compare")
    def dns_compare():
        payload = request.get_json(silent=True) or {}
        if not isinstance(payload, dict):
            return jsonify({"ok": False, "error": "Некорректное имя для DNS-сравнения."}), 400
        try:
            result = compare_public_dns(payload)
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        return jsonify({"ok": True, "result": result})

    @bp.post("/api/provider-diagnostics/compare-tls")
    def compare_tls():
        payload = request.get_json(silent=True) or {}
        if not isinstance(payload, dict):
            return jsonify({"ok": False, "error": "Некорректная цель сравнительной проверки."}), 400
        try:
            result = compare_tls_path(payload)
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        return jsonify({"ok": True, "result": result})

    @bp.post("/api/provider-diagnostics/public-lists")
    def public_lists():
        payload = request.get_json(silent=True) or {}
        if not isinstance(payload, dict):
            return jsonify({"ok": False, "error": "Некорректный адрес для проверки по спискам."}), 400
        try:
            result = lookup_public_lists(payload)
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        return jsonify({"ok": True, "result": result})

    return bp
