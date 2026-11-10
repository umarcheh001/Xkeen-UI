"""Authenticated USB storage API. POST endpoints use the global CSRF guard."""

from __future__ import annotations

from flask import Blueprint, jsonify, request

from services.storage_usb import (
    edit_partitions,
    eject_disk,
    list_usb_filesystems,
    operate_partition,
    repartition_disk,
    set_volume_label,
)


def create_storage_usb_blueprint() -> Blueprint:
    bp = Blueprint("storage_usb", __name__)

    @bp.get("/api/storage/usb")
    def list_storage():
        payload = list_usb_filesystems()
        return jsonify(payload), 200 if payload["ok"] else 503

    @bp.post("/api/storage/usb/<action>")
    def operate_storage(action: str):
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return jsonify({"ok": False, "code": "bad_request", "message": "Нужен JSON-объект."}), 400
        media_id = str(data.get("media_id") or "")
        partition_id = str(data.get("partition_id") or "")
        uuid = str(data.get("uuid") or "")
        if action in {"mount", "unmount", "check", "format"}:
            payload = operate_partition(action, media_id, partition_id, uuid,
                                        fstype=str(data.get("fstype") or ""),
                                        confirm=str(data.get("confirm") or ""))
        elif action == "label":
            payload = set_volume_label(media_id, partition_id, uuid, str(data.get("label") or ""))
        elif action == "eject":
            payload = eject_disk(media_id, str(data.get("serial") or ""))
        elif action == "repartition":
            payload = repartition_disk(media_id, str(data.get("serial") or ""),
                                       data.get("expected_parts"), data.get("sizes_mib"),
                                       str(data.get("confirm") or ""))
        elif action in {"add", "delete", "split", "merge"}:
            payload = edit_partitions(
                action, media_id, str(data.get("serial") or ""), data.get("expected_parts"),
                partition_id=partition_id, uuid=uuid,
                other_id=str(data.get("other_id") or ""), other_uuid=str(data.get("other_uuid") or ""),
                merge_parts=data.get("merge_parts"),
                start_sector=data.get("start_sector", -1), size_mib=data.get("size_mib", 0),
                confirm=str(data.get("confirm") or ""),
            )
        else:
            return jsonify({"ok": False, "code": "bad_request", "message": "Неизвестная операция."}), 404
        if payload["ok"]:
            return jsonify(payload), 200
        code = payload.get("code")
        status = 503 if code in {"rci_unavailable", "rci_failed"} else 409 if code in {
            "opkg_protected", "stale_target", "must_unmount", "invalid_state", "disk_in_use"} else 400
        return jsonify(payload), status

    return bp
