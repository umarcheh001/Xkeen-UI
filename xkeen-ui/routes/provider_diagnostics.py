"""Read-only, on-demand provider endpoint diagnostics API."""

from __future__ import annotations

from flask import Blueprint, jsonify, request

from services.provider_diagnostics import (
    compare_public_dns,
    current_mihomo_targets,
    current_xray_targets,
    lookup_public_lists,
    parse_source,
    probe_target,
)


def create_provider_diagnostics_blueprint(*, xray_configs_dir: str, mihomo_config_file: str) -> Blueprint:
    bp = Blueprint("provider_diagnostics", __name__)

    @bp.get("/api/provider-diagnostics/targets")
    def targets():
        core = str(request.args.get("core") or "").lower()
        if core == "xray":
            items = current_xray_targets(xray_configs_dir)
        elif core == "mihomo":
            items = current_mihomo_targets(mihomo_config_file)
        else:
            return jsonify({"ok": False, "error": "Выберите Xray или Mihomo."}), 400
        return jsonify({"ok": True, "targets": items, "source": "saved_config"})

    @bp.post("/api/provider-diagnostics/parse")
    def parse():
        payload = request.get_json(silent=True) or {}
        if not isinstance(payload, dict) or not isinstance(payload.get("source"), str):
            return jsonify({"ok": False, "error": "Введите данные для проверки."}), 400
        try:
            result = parse_source(payload["source"])
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        return jsonify({"ok": True, **result})

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
