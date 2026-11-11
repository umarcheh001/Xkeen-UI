"""Keenetic USB storage operations via structured firmware RCI."""

from __future__ import annotations

import json
import os
import re
import shutil
import stat
import subprocess
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from services.keenetic_rci import RCI_BASE_URL, build_rci_request, fetch_rci_json


_LOCK = threading.Lock()
_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_UUID = re.compile(r"^[A-Za-z0-9-]{1,64}$")
_LABEL_TOOLS = {"ext2": "tune2fs", "ext3": "tune2fs", "ext4": "tune2fs",
                "vfat": "fatlabel", "exfat": "exfatlabel", "ntfs": "ntfslabel"}


def _error(code: str, message: str, hint: str = "") -> dict[str, Any]:
    result: dict[str, Any] = {"ok": False, "code": code, "message": message}
    if hint:
        result["hint"] = hint
    return result


def _tool(name: str) -> str:
    if not name:
        return ""
    for directory in ("/opt/sbin", "/opt/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"):
        path = os.path.join(directory, name)
        if os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    return shutil.which(name) or ""


def _mounts() -> list[tuple[str, str, str]]:
    rows = []
    try:
        with open("/proc/mounts", encoding="utf-8") as handle:
            for line in handle:
                parts = line.split()
                if len(parts) >= 3:
                    rows.append(tuple(re.sub(r"\\([0-7]{3})", lambda m: chr(int(m[1], 8)), x)
                                      for x in parts[:3]))
    except OSError:
        pass
    return rows


def _integer(value: Any) -> int | None:
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return None


def _block_info() -> dict[str, tuple[str, str]]:
    blkid = _tool("blkid")
    if not blkid:
        return {}
    try:
        names = os.listdir("/sys/class/block")
    except OSError:
        return {}
    found = {}
    ambiguous = set()
    for name in names:
        if not re.fullmatch(r"(?:sd[a-z]+[0-9]+|nvme[0-9]+n[0-9]+p[0-9]+|mmcblk[0-9]+p[0-9]+)", name):
            continue
        path = "/dev/" + name
        try:
            if not stat.S_ISBLK(os.stat(path).st_mode):
                continue
            result = subprocess.run([blkid, path], capture_output=True, text=True, errors="replace",
                                    timeout=2, check=False)
        except (OSError, subprocess.TimeoutExpired):
            continue
        uuid = re.search(r'\bUUID="([A-Za-z0-9-]{1,64})"', result.stdout)
        label = re.search(r'\bLABEL="([^"]*)"', result.stdout)
        if uuid:
            if uuid[1] in found:
                ambiguous.add(uuid[1])
            else:
                found[uuid[1]] = (path, label[1] if label else "")
    for uuid in ambiguous:
        found.pop(uuid, None)
    return found


def _disk_device(disk: dict[str, Any]) -> str:
    serial = str(disk.get("serial") or "").strip()
    if not serial:
        return ""
    try:
        names = os.listdir("/sys/class/block")
    except OSError:
        return ""
    matches = []
    for name in names:
        if not re.fullmatch(r"(?:sd[a-z]+|nvme[0-9]+n[0-9]+|mmcblk[0-9]+)", name):
            continue
        sys_path = Path("/sys/class/block") / name
        try:
            actual_size = int((sys_path / "size").read_text().strip()) * 512
            if disk.get("size") != actual_size:
                continue
            device_path = (sys_path / "device").resolve()
            if not any((parent / "serial").read_text().strip() == serial
                       for parent in (device_path, *device_path.parents)
                       if (parent / "serial").is_file()):
                continue
            device = "/dev/" + name
            if stat.S_ISBLK(os.stat(device).st_mode):
                matches.append(device)
        except (OSError, ValueError):
            continue
    return matches[0] if len(matches) == 1 else ""


def _empty_mount(path: str) -> bool:
    if not path or not os.path.ismount(path):
        return False
    try:
        with os.scandir(path) as entries:
            for entry in entries:
                if entry.name not in {"lost+found", ".webdav-temp"} or not entry.is_dir(follow_symlinks=False):
                    return False
                with os.scandir(entry.path) as recovered:
                    if next(recovered, None) is not None:
                        return False
        return True
    except OSError:
        return False


def _inventory() -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    media = fetch_rci_json("/rci/show/media", timeout=5)
    if not isinstance(media, dict):
        raise ValueError("invalid show.media response")
    mounts = _mounts()
    block_info = _block_info()
    try:
        opt_device = os.stat("/opt").st_dev
    except OSError:
        opt_device = None
    disks: list[dict[str, Any]] = []
    volumes: list[dict[str, Any]] = []
    for media_id, drive in media.items():
        if not isinstance(drive, dict) or drive.get("bus") != "usb" or not _ID.fullmatch(str(media_id)):
            continue
        usb = drive.get("usb") if isinstance(drive.get("usb"), dict) else {}
        disk = {"id": media_id, "product": str(drive.get("product") or "").strip(),
                "manufacturer": str(drive.get("manufacturer") or "").strip(),
                "serial": str(drive.get("serial") or "").strip(),
                "size": _integer(drive.get("size")), "state": str(drive.get("state") or "").lower(),
                "port": str(usb.get("port") or ""), "version": str(usb.get("version") or ""),
                "ejectable": bool(drive.get("ejectable")), "partitions": []}
        parts = drive.get("partition") if isinstance(drive.get("partition"), dict) else {}
        for part_id, part in parts.items():
            if not isinstance(part, dict) or not _ID.fullmatch(str(part_id)):
                continue
            uuid = str(part.get("uuid") or "").strip()
            source, mountpoint = next(((src, path) for src, path, _ in mounts
                                       if path == "/tmp/mnt/" + uuid), ("", ""))
            used_by = [str(x).lower() for x in (part.get("used-by") or [])]
            protected = "opkg" in used_by
            if mountpoint and opt_device is not None:
                try:
                    protected = protected or os.stat(mountpoint).st_dev == opt_device
                except OSError:
                    pass
            fstype = str(part.get("fstype") or "").lower()
            firmware_label = str(part.get("label") or "")
            actual_label = block_info.get(uuid, ("", ""))[1]
            label_tool = _LABEL_TOOLS.get(fstype, "")
            volume = {"media_id": media_id, "partition_id": part_id, "name": uuid + ":",
                      "uuid": uuid, "label": actual_label or firmware_label,
                      "firmware_label": firmware_label,
                      "label_pending": bool(actual_label and actual_label != firmware_label),
                      "fstype": fstype,
                      "state": str(part.get("state") or "").lower(), "source": source,
                      "mountpoint": mountpoint, "total": _integer(part.get("total")),
                      "free": _integer(part.get("free")), "used_by": used_by,
                      "protected": protected,
                      "format_types": [str(x) for x in (part.get("format-supported") or [])],
                      "labelable_format_types": [str(x) for x in (part.get("format-supported") or [])
                                                 if _tool(_LABEL_TOOLS.get(str(x), ""))],
                      "check_supported": bool(part.get("check-supported")),
                      "label_tool": label_tool, "label_available": bool(_tool(label_tool))}
            volume["empty"] = bool(not protected and volume["state"] == "mounted"
                                   and set(used_by) <= {"cifs"} and _empty_mount(mountpoint))
            disk["partitions"].append(volume)
            volumes.append(volume)
        disk["protected"] = any(x["protected"] for x in disk["partitions"])
        disk["partitionable"] = bool(not disk["protected"]
                                     and not any(set(x["used_by"]) - {"cifs"} for x in disk["partitions"])
                                     and disk["size"] and disk["size"] >= 128 * 1048576
                                     and _tool("parted") and _disk_device(disk))
        # Editing a GPT entry does not require detaching unrelated volumes (OPKG included).
        parted = _tool("parted")
        # Avoid probing block devices when the partition editor cannot run (and
        # keep OPKG detection independent from optional host tooling).
        device = _disk_device(disk) if parted else ""
        layout = _parted_layout(device, parted) if device and parted else None
        disk["editable"] = bool(layout and layout["label"] == "gpt"
                                and layout["sector_size"] > 0 and 1048576 % layout["sector_size"] == 0)
        disk["edit_reason"] = ("Не найдена утилита parted." if not parted else
                               "Не удалось определить устройство накопителя." if not device else
                               "Не удалось прочитать таблицу разделов." if not layout else
                               "Для изменения отдельных разделов нужна таблица GPT." if not disk["editable"] else "")
        disk["free_ranges"] = []
        if disk["editable"]:
            if layout:
                sector_size = layout["sector_size"]
                disk["sector_size"] = sector_size
                if sector_size > 0 and 1048576 % sector_size == 0:
                    sectors_mib = 1048576 // sector_size
                    for row in layout["free"]:
                        aligned = ((row["start"] + sectors_mib - 1) // sectors_mib) * sectors_mib
                        usable = (row["end"] - aligned + 1) * sector_size
                        if usable >= 64 * 1048576:
                            disk["free_ranges"].append(dict(start_sector=row["start"],
                                                            end_sector=row["end"], size_bytes=usable))
                for volume in disk["partitions"]:
                    _, row = _disk_partition_target(volume, layout)
                    if row:
                        volume["start_sector"] = row["start"]
                        volume["end_sector"] = row["end"]
        disks.append(disk)
    return disks, volumes


def list_usb_filesystems() -> dict[str, Any]:
    try:
        disks, volumes = _inventory()
    except Exception:
        return _error("rci_unavailable", "Не удалось получить список накопителей через Keenetic RCI.",
                      "Проверьте доступ RCI и токен xkeen.rci_token.")
    return {"ok": True, "disks": disks, "items": volumes, "ts": int(time.time())}


def _target(media_id: str, partition_id: str, expected_uuid: str):
    if not _ID.fullmatch(media_id) or not _ID.fullmatch(partition_id) or (expected_uuid and not _UUID.fullmatch(expected_uuid)):
        return None, None, _error("bad_request", "Некорректный идентификатор раздела.")
    disks, _ = _inventory()
    disk = next((x for x in disks if x["id"] == media_id), None)
    part = next((x for x in disk["partitions"] if x["partition_id"] == partition_id), None) if disk else None
    if not part or part["uuid"] != expected_uuid:
        return None, None, _error("stale_target", "Состав диска изменился. Обновите список.")
    return disk, part, None


def _command(path: str, payload: dict[str, Any]) -> dict[str, Any]:
    body: Any = payload
    for segment in reversed(path.split(".")):
        body = {segment: body}
    request = build_rci_request(RCI_BASE_URL + "/rci/", data=json.dumps(body).encode(), method="POST")
    request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=25) as response:  # noqa: S310 - fixed local RCI endpoint
            result = json.loads(response.read(128 * 1024).decode())
    except (urllib.error.URLError, ValueError, OSError) as exc:
        return _error("rci_failed", "Прошивка не выполнила операцию.", str(exc)[:300])
    node: Any = result
    for segment in path.split("."):
        node = node.get(segment) if isinstance(node, dict) else None
    statuses = node.get("status") if isinstance(node, dict) else None
    if isinstance(statuses, dict):
        statuses = [statuses]
    if not isinstance(statuses, list):
        return _error("rci_failed", "Прошивка вернула неожиданный ответ.")
    errors = [x for x in statuses if isinstance(x, dict) and x.get("status") == "error"]
    if errors:
        return _error("rci_failed", "Прошивка отклонила операцию.", str(errors[0].get("message") or "")[:300])
    return {"ok": True, "status": statuses}


def operate_partition(action: str, media_id: str, partition_id: str, expected_uuid: str,
                      *, fstype: str = "", confirm: str = "") -> dict[str, Any]:
    if action not in {"mount", "unmount", "check", "format"}:
        return _error("bad_request", "Неизвестная операция.")
    with _LOCK:
        try:
            _, part, error = _target(media_id, partition_id, expected_uuid)
        except Exception:
            return _error("rci_unavailable", "Не удалось перепроверить состояние раздела.")
        if error:
            return error
        assert part is not None
        if part["state"] in {"formatting", "checking", "mounting", "unmounting"}:
            return _error("invalid_state", "Раздел занят другой операцией.")
        if action != "mount" and part["protected"]:
            return _error("opkg_protected", "Раздел с активным OPKG защищён от этой операции.")
        if action == "format":
            if confirm != f"FORMAT {media_id}/{partition_id}":
                return _error("confirmation_required", "Требуется подтверждение форматирования.")
            if fstype not in part["format_types"]:
                return _error("unsupported_format", "Файловая система не поддерживается прошивкой.")
            return _command("media.partition.format", {"name": media_id, "partition": partition_id, "type": fstype})
        if action == "check":
            if not part["check_supported"]:
                return _error("unsupported_check", "Проверка раздела не поддерживается.")
            return _command("media.partition.check", {"name": media_id, "partition": partition_id})
        if not expected_uuid:
            return _error("invalid_state", "Раздел ещё не имеет файловой системы.")
        if action == "unmount" and part["state"] != "mounted":
            return _error("invalid_state", "Раздел уже отключён.")
        if action == "mount" and part["state"] == "mounted":
            return {"ok": True}
        return _command("system.mount", {"filesystem": expected_uuid + ":", "no": action == "unmount"})


def eject_disk(media_id: str, serial: str) -> dict[str, Any]:
    if not _ID.fullmatch(media_id) or not serial:
        return _error("bad_request", "Некорректный идентификатор накопителя.")
    with _LOCK:
        try:
            disks, _ = _inventory()
        except Exception:
            return _error("rci_unavailable", "Не удалось перепроверить состояние накопителя.")
        disk = next((x for x in disks if x["id"] == media_id), None)
        if not disk or disk["serial"] != serial:
            return _error("stale_target", "Накопитель изменился. Обновите список.")
        if disk["protected"]:
            return _error("opkg_protected", "Нельзя извлечь накопитель с активным OPKG.")
        if not disk["ejectable"]:
            return _error("unsupported_eject", "Извлечение не поддерживается.")
        return _command("system.eject", {"name": media_id})


def repartition_disk(media_id: str, serial: str, expected_parts: list[dict[str, str]],
                     sizes_mib: list[int], confirm: str) -> dict[str, Any]:
    if not _ID.fullmatch(media_id) or not serial or confirm != f"REPARTITION {media_id}/{serial}":
        return _error("confirmation_required", "Требуется подтверждение выбранного накопителя.")
    if not isinstance(expected_parts, list) or not isinstance(sizes_mib, list) or not 1 <= len(sizes_mib) <= 4:
        return _error("bad_layout", "Укажите от 1 до 4 разделов.")
    if sizes_mib[-1] != 0 or any(type(x) is not int or x < 64 for x in sizes_mib[:-1]):
        return _error("bad_layout", "Размеры разделов должны быть не меньше 64 МиБ; последний занимает остаток.")
    with _LOCK:
        try:
            disks, _ = _inventory()
        except Exception:
            return _error("rci_unavailable", "Не удалось перепроверить состояние накопителя.")
        disk = next((x for x in disks if x["id"] == media_id), None)
        if not disk or disk["serial"] != serial:
            return _error("stale_target", "Накопитель изменился. Обновите список.")
        if disk["protected"]:
            return _error("opkg_protected", "Нельзя менять разделы накопителя с активным OPKG.")
        current = sorted((p["partition_id"], p["uuid"]) for p in disk["partitions"])
        try:
            expected = sorted((str(p["partition_id"]), str(p["uuid"])) for p in expected_parts)
        except (KeyError, TypeError):
            return _error("bad_request", "Некорректный состав накопителя.")
        if current != expected:
            return _error("stale_target", "Разделы накопителя изменились. Обновите список.")
        device = _disk_device(disk)
        parted = _tool("parted")
        if not device or not parted:
            return _error("tool_missing", "Не найдены накопитель или утилита parted.")
        if disk["size"] is None:
            return _error("bad_layout", "Размер накопителя неизвестен.")
        disk_mib = disk["size"] // 1048576
        end_mib = disk_mib - 2
        if 1 + sum(sizes_mib[:-1]) + 64 > end_mib:
            return _error("bad_layout", "Размеры разделов превышают ёмкость накопителя.")
        if any(set(p["used_by"]) - {"cifs"} for p in disk["partitions"]):
            return _error("disk_in_use", "Накопитель используется службой. Отключите её перед разметкой.")
        for part in disk["partitions"]:
            if part["state"] == "mounted":
                result = _command("system.mount", {"filesystem": part["uuid"] + ":", "no": True})
                if not result["ok"]:
                    return result
        for _ in range(10):
            try:
                fresh = next(x for x in _inventory()[0] if x["id"] == media_id)
            except Exception:
                return _error("rci_unavailable", "Накопитель исчез во время отключения.")
            if fresh["serial"] != serial or fresh["protected"]:
                return _error("stale_target", "Накопитель изменился до разметки.")
            if all(p["state"] == "unmounted" for p in fresh["partitions"]):
                break
            time.sleep(0.3)
        else:
            return _error("disk_in_use", "Не все разделы удалось отключить.")
        if any(re.fullmatch(re.escape(device) + r"(?:p)?[0-9]+", source) for source, _, _ in _mounts()):
            return _error("disk_in_use", "Раздел накопителя всё ещё смонтирован в системе.")

        def run_parted(*args: str) -> dict[str, Any] | None:
            if _disk_device(disk) != device:
                return _error("stale_target", "Накопитель изменился во время разметки.")
            try:
                result = subprocess.run([parted, "-s", "-a", "optimal", device, *args],
                                        capture_output=True, text=True, errors="replace", timeout=25, check=False)
            except (OSError, subprocess.TimeoutExpired):
                return _error("partition_failed", "Утилита parted не завершилась.")
            if result.returncode:
                return _error("partition_failed", "Не удалось изменить таблицу разделов.",
                              (result.stderr or result.stdout)[:300])
            return None

        failed = run_parted("mklabel", "gpt")
        if failed:
            return failed
        layout = _parted_layout(device, parted)
        if not layout or layout["label"] != "gpt" or 1048576 % layout["sector_size"]:
            return _error("partition_failed", "Таблица создана, но геометрию диска не удалось проверить.")
        sectors_mib = 1048576 // layout["sector_size"]
        starts = [1]
        for amount in sizes_mib[:-1]:
            starts.append(starts[-1] + amount)
        failed = _clear_new_partition_headers(
            disk, device, [(start * sectors_mib, (start + 1) * sectors_mib - 1) for start in starts],
            layout["sector_size"])
        if failed:
            return failed
        start = 1
        for index, size in enumerate(sizes_mib):
            end = start + size if size else end_mib
            failed = run_parted("mkpart", f"xkeen-{index + 1}", f"{start}MiB", f"{end}MiB")
            if failed:
                return failed
            start = end
        partprobe = _tool("partprobe")
        if partprobe:
            try:
                subprocess.run([partprobe, device], capture_output=True, timeout=10, check=False)
            except (OSError, subprocess.TimeoutExpired):
                pass
        return {"ok": True, "message": "Таблица разделов создана. Теперь отформатируйте разделы.",
                "created": len(sizes_mib)}


def _block_device(uuid: str) -> str:
    return _block_info().get(uuid, ("", ""))[0]


def _partition_number(partition_id: str) -> int | None:
    match = re.fullmatch(r"Partition([1-9][0-9]*)", str(partition_id or ""))
    return int(match[1]) if match else None


def _parted_layout(device: str, parted: str) -> dict[str, Any] | None:
    try:
        result = subprocess.run(
            [parted, "-j", "-s", device, "unit", "s", "print", "free"],
            capture_output=True, text=True, errors="replace", timeout=15, check=False,
            env={**os.environ, "LC_ALL": "C"},
        )
        payload = json.loads(result.stdout) if result.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired, ValueError, TypeError):
        return None
    disk = payload.get("disk", {}) if isinstance(payload, dict) else {}
    if disk.get("path") != device:
        return None
    rows = disk.get("partitions", []) if isinstance(disk, dict) else []
    layout: dict[str, Any] = {"label": disk.get("label", ""), "sector_size": _integer(disk.get("logical-sector-size")) or 512,
                              "partitions": [], "free": []}
    for row in rows:
        if not isinstance(row, dict):
            continue
        try:
            start = str(row["start"])
            end = str(row["end"])
            if not start.endswith("s") or not end.endswith("s"):
                continue
            entry = {"number": int(row["number"]), "start": int(start[:-1]), "end": int(end[:-1])}
            layout["free" if row.get("type") == "free" else "partitions"].append(entry)
        except (KeyError, TypeError, ValueError):
            continue
    return layout


def _parted_run(disk: dict[str, Any], device: str, parted: str, *args: str) -> dict[str, Any] | None:
    if _disk_device(disk) != device:
        return _error("stale_target", "Накопитель изменился во время операции.")
    try:
        result = subprocess.run([parted, "-s", "-a", "none", device, *args],
                                capture_output=True, text=True, errors="replace", timeout=25, check=False,
                                env={**os.environ, "LC_ALL": "C"})
    except (OSError, subprocess.TimeoutExpired):
        return _error("partition_failed", "Утилита parted не завершилась.")
    if result.returncode:
        return _error("partition_failed", "Не удалось изменить таблицу разделов.",
                      (result.stderr or result.stdout)[:300])
    return None


def _partprobe(device: str) -> dict[str, Any] | None:
    partprobe = _tool("partprobe")
    if partprobe:
        try:
            result = subprocess.run([partprobe, device], capture_output=True, text=True,
                                    errors="replace", timeout=10, check=False)
            if result.returncode:
                return _error("partition_failed", "Ядро не перечитало таблицу разделов. Обновите список.",
                              (result.stderr or result.stdout)[:300])
        except (OSError, subprocess.TimeoutExpired):
            return _error("partition_failed", "Не удалось перечитать таблицу разделов. Обновите список.")
    return None


def _clear_new_partition_headers(disk: dict[str, Any], device: str,
                                 creates: list[tuple[int, int]], sector_size: int) -> dict[str, Any] | None:
    if not creates:
        return None
    if _disk_device(disk) != device:
        return _error("stale_target", "Накопитель заменён перед очисткой сигнатур.")
    try:
        if not stat.S_ISBLK(os.stat(device).st_mode):
            return _error("stale_target", "Устройство больше не является накопителем.")
        fd = os.open(device, os.O_WRONLY | os.O_SYNC)
        try:
            zeros = bytes(65536)
            for start, end in creates:
                remaining = min(1048576, (end - start + 1) * sector_size)
                offset = start * sector_size
                while remaining:
                    chunk = min(remaining, len(zeros))
                    if os.pwrite(fd, zeros[:chunk], offset) != chunk:
                        return _error("partition_failed", "Не удалось очистить старую сигнатуру файловой системы.")
                    offset += chunk
                    remaining -= chunk
        finally:
            os.close(fd)
    except OSError:
        return _error("partition_failed", "Не удалось очистить старую сигнатуру файловой системы.")
    return None


def _is_empty_volume(part: dict[str, Any]) -> bool:
    """Том можно считать пустым, не монтируя его.

    Два независимых случая: смонтированный том, прошивка уже сообщила, что он
    пуст; и том вовсе без файловой системы (нет uuid и fstype) в состоянии
    unmounted/unsupported — там нечего проверять. Скобки расставлены явно:
    приоритет ``and`` выше ``or``, но читать без них это выражение тяжело.
    """
    mounted_and_empty = bool(part.get("empty") and part.get("state") == "mounted")
    no_filesystem = (not part.get("uuid") and not part.get("fstype")
                     and part.get("state") in {"unmounted", "unsupported"})
    return bool(mounted_and_empty or no_filesystem)


def _verify_empty_volume(disk: dict[str, Any], part: dict[str, Any]) -> dict[str, Any] | None:
    """Inspect an unmounted filesystem through firmware, without trusting cached emptiness."""
    if part["state"] != "unmounted" or not part["uuid"]:
        return None if _is_empty_volume(part) else _error("disk_in_use", "Раздел должен быть пустым.")
    result = _command("system.mount", {"filesystem": part["uuid"] + ":", "no": False})
    if not result["ok"]:
        return result
    failure = _error("disk_in_use", "Не удалось проверить содержимое раздела.")
    try:
        for _ in range(15):
            fresh = next((d for d in _inventory()[0] if d["id"] == disk["id"]), None)
            current = next((p for p in fresh["partitions"] if p["partition_id"] == part["partition_id"]
                            and p["uuid"] == part["uuid"]), None) if fresh and fresh["serial"] == disk["serial"] else None
            if not current or current["protected"]:
                failure = _error("stale_target", "Раздел изменился во время проверки.")
                break
            if current["state"] == "mounted":
                failure = None if _is_empty_volume(current) else _error("disk_in_use", "Раздел содержит файлы: операция отменена.")
                break
            time.sleep(0.3)
    except Exception:
        failure = _error("rci_unavailable", "Не удалось проверить содержимое раздела.")
    finally:
        # _target revalidates the UUID and OPKG protection before detaching.
        try:
            current_disk, current, error = _target(disk["id"], part["partition_id"], part["uuid"])
            if error:
                failure = error
            elif current_disk["serial"] != disk["serial"]:
                failure = _error("stale_target", "Накопитель заменён во время проверки.")
            elif current["protected"] or set(current["used_by"]) - {"cifs"}:
                failure = _error("disk_in_use", "Раздел используется службой.")
            elif current["state"] != "unmounted":
                result = _command("system.mount", {"filesystem": part["uuid"] + ":", "no": True})
                if not result["ok"]:
                    failure = result
        except Exception:
            failure = _error("rci_unavailable", "Не удалось отключить раздел после проверки содержимого.")
    return failure


def _disk_partition_target(part: dict[str, Any], layout: dict[str, Any]):
    number = _partition_number(part["partition_id"])
    row = next((item for item in layout["partitions"] if item["number"] == number), None)
    return number, row


def edit_partitions(action: str, media_id: str, serial: str, expected_parts: list[dict[str, str]],
                    *, partition_id: str = "", uuid: str = "", other_id: str = "", other_uuid: str = "",
                    merge_parts: list[dict[str, str]] | None = None,
                    start_sector: int = -1, size_mib: int = 0, confirm: str = "") -> dict[str, Any]:
    if action not in {"add", "delete", "split", "merge"}:
        return _error("bad_request", "Неизвестная операция с разделами.")
    if not _ID.fullmatch(media_id) or not serial or confirm != f"EDIT {media_id}/{serial}":
        return _error("confirmation_required", "Подтвердите выбранный накопитель.")
    if not isinstance(expected_parts, list):
        return _error("bad_request", "Некорректный состав накопителя.")
    with _LOCK:
        try:
            disks, _ = _inventory()
        except Exception:
            return _error("rci_unavailable", "Не удалось проверить накопитель.")
        disk = next((item for item in disks if item["id"] == media_id), None)
        if not disk or disk["serial"] != serial:
            return _error("stale_target", "Накопитель изменился. Обновите список.")
        try:
            expected = sorted((str(p["partition_id"]), str(p["uuid"])) for p in expected_parts)
        except (KeyError, TypeError):
            return _error("bad_request", "Некорректный состав накопителя.")
        if expected != sorted((p["partition_id"], p["uuid"]) for p in disk["partitions"]):
            return _error("stale_target", "Разделы накопителя изменились. Обновите список.")
        requested_part = next((p for p in disk["partitions"]
                               if p["partition_id"] == partition_id and p["uuid"] == uuid), None)
        if action != "add" and requested_part and requested_part["protected"]:
            return _error("opkg_protected", "Нельзя изменять раздел с активным OPKG.")
        device, parted = _disk_device(disk), _tool("parted")
        if not device or not parted:
            return _error("tool_missing", "Не найдены накопитель или утилита parted.")
        layout = _parted_layout(device, parted)
        if not layout or layout["label"] != "gpt":
            return _error("unsupported_layout", "Для изменения отдельных разделов нужна таблица GPT.")
        sector_size = layout["sector_size"]
        if sector_size <= 0 or 1048576 % sector_size:
            return _error("unsupported_layout", "Неподдерживаемый размер сектора.")
        sectors_mib = 1048576 // sector_size
        part = next((p for p in disk["partitions"] if p["partition_id"] == partition_id and p["uuid"] == uuid), None)
        if action != "add" and not part:
            return _error("stale_target", "Раздел изменился. Обновите список.")
        targets = [part] if part and action != "add" else []
        if action == "merge":
            requested = merge_parts if merge_parts is not None else [
                {"partition_id": partition_id, "uuid": uuid}, {"partition_id": other_id, "uuid": other_uuid}]
            if not isinstance(requested, list) or not 2 <= len(requested) <= len(disk["partitions"]):
                return _error("bad_request", "Выберите как минимум два раздела.")
            try:
                keys = [(str(p["partition_id"]), str(p["uuid"])) for p in requested]
            except (KeyError, TypeError):
                return _error("bad_request", "Некорректный список разделов.")
            if len(set(keys)) != len(keys) or (partition_id, uuid) not in keys:
                return _error("bad_request", "Список разделов содержит повторы или не включает исходный раздел.")
            targets = [p for p in disk["partitions"] if (p["partition_id"], p["uuid"]) in keys]
            if len(targets) != len(keys):
                return _error("stale_target", "Выбранные разделы изменились. Обновите список.")
        if any(p["protected"] for p in targets):
            return _error("opkg_protected", "Нельзя изменять раздел с активным OPKG.")
        number, row = _disk_partition_target(part, layout) if part else (None, None)
        target_rows = [_disk_partition_target(p, layout)[1] for p in targets]
        if any(r is None for r in target_rows):
            return _error("stale_target", "Геометрия разделов изменилась.")
        if any(set(p["used_by"]) - {"cifs"} for p in targets):
            return _error("disk_in_use", "Выбранный раздел используется службой.")
        if action == "add":
            if type(start_sector) is not int or type(size_mib) is not int or size_mib < 64:
                return _error("bad_layout", "Укажите свободную область и размер от 64 МиБ.")
            free = next((r for r in layout["free"] if r["start"] == start_sector), None)
            if not free:
                return _error("stale_target", "Свободная область изменилась.")
            start = ((free["start"] + sectors_mib - 1) // sectors_mib) * sectors_mib
            end = start + size_mib * sectors_mib - 1
            if end > free["end"]:
                return _error("bad_layout", "Размер превышает свободную область.")
            removes: list[int] = []
            creates = [(start, end)]
        elif action == "delete":
            if part["state"] not in {"unmounted", "unsupported"}:
                return _error("must_unmount", "Перед удалением отключите раздел.")
            removes, creates = [number], []
        elif action == "split":
            if type(size_mib) is not int or size_mib < 64:
                return _error("bad_layout", "Размер первого раздела должен быть от 64 МиБ.")
            boundary = row["start"] + size_mib * sectors_mib
            if row["end"] - boundary + 1 < 64 * sectors_mib:
                return _error("bad_layout", "Для второго раздела осталось меньше 64 МиБ.")
            removes, creates = [number], [(row["start"], boundary - 1), (boundary, row["end"])]
        else:
            rows = sorted(target_rows, key=lambda item: item["start"])
            if any(left["end"] + 1 != right["start"] for left, right in zip(rows, rows[1:])):
                return _error("bad_layout", "Разделы должны соседствовать без промежутка.")
            removes, creates = [r["number"] for r in rows], [(rows[0]["start"], rows[-1]["end"])]
        if any(p["state"] not in {"mounted", "unmounted", "unsupported"} for p in disk["partitions"]):
            return _error("disk_in_use", "Дождитесь завершения текущей операции с разделами.")
        mounted_before = [(p["partition_id"], p["uuid"]) for p in disk["partitions"]
                          if p["state"] == "mounted" and not p["protected"]
                          and _partition_number(p["partition_id"]) not in removes]
        if action in {"split", "merge"}:
            for volume in targets:
                failed = _verify_empty_volume(disk, volume)
                if failed:
                    return failed
        # Keep OPKG mounted, but detach other filesystems while the GPT is edited.
        for volume in disk["partitions"]:
            if volume["protected"]:
                continue
            if volume["state"] == "mounted":
                if not volume["uuid"]:
                    return _error("disk_in_use", "Не удалось определить файловую систему подключённого раздела.")
                result = _command("system.mount", {"filesystem": volume["uuid"] + ":", "no": True})
                if not result["ok"]:
                    return result
        for _ in range(15):
            try:
                fresh = next(d for d in _inventory()[0] if d["id"] == media_id)
            except Exception:
                return _error("rci_unavailable", "Накопитель исчез во время отключения.")
            if fresh["serial"] != serial or sorted(
                    (p["partition_id"], p["uuid"]) for p in fresh["partitions"]) != expected:
                return _error("stale_target", "Накопитель изменился во время операции.")
            fresh_targets = [p for p in fresh["partitions"] if _partition_number(p["partition_id"]) in removes]
            if any(p["protected"] or set(p["used_by"]) - {"cifs"} for p in fresh_targets):
                return _error("disk_in_use", "Выбранный раздел занят службой.")
            if all(p["state"] in {"unmounted", "unsupported"} for p in fresh_targets):
                break
            time.sleep(0.3)
        else:
            return _error("disk_in_use", "Не все разделы удалось отключить.")
        target_sources = {device + ("p" if device[-1].isdigit() else "") + str(n) for n in removes}
        if any(source in target_sources or source == device for source, _, _ in _mounts()):
            return _error("disk_in_use", "Выбранный раздел всё ещё смонтирован в системе.")
        if _disk_device(disk) != device:
            return _error("stale_target", "Накопитель заменён перед изменением таблицы.")
        for removed in removes:
            failed = _parted_run(disk, device, parted, "rm", str(removed))
            if failed:
                return failed
        failed = _clear_new_partition_headers(disk, device, creates, sector_size)
        if failed:
            return failed
        for index, (start, end) in enumerate(creates):
            failed = _parted_run(disk, device, parted, "mkpart", f"xkeen-{index + 1}",
                                 f"{start}s", f"{end}s")
            if failed:
                return failed
        failed = _partprobe(device)
        if failed:
            return failed
        updated = _parted_layout(device, parted)
        if not updated:
            return _error("partition_failed", "Таблица изменена, но её не удалось перечитать. Обновите список.")
        created_ids = []
        for start, end in creates:
            match = next((p for p in updated["partitions"] if p["start"] == start and p["end"] == end), None)
            if not match:
                return _error("partition_failed", "Таблица изменена, но геометрия не совпала. Обновите список.")
            created_ids.append(f"Partition{match['number']}")
        remount_failed = []
        for original_id, original_uuid in mounted_before:
            for _ in range(20):
                try:
                    fresh = next(d for d in _inventory()[0] if d["id"] == media_id)
                except Exception:
                    break
                current = next((p for p in fresh["partitions"] if p["partition_id"] == original_id
                                and p["uuid"] == original_uuid), None)
                if current:
                    if current["state"] != "mounted":
                        result = _command("system.mount", {"filesystem": current["uuid"] + ":", "no": False})
                        if not result["ok"]:
                            remount_failed.append(original_id)
                    break
                time.sleep(0.3)
            else:
                remount_failed.append(original_id)
        return {"ok": True, "created_partition_ids": created_ids,
                "remount_failed": remount_failed,
                "message": "Таблица разделов обновлена."}


def set_volume_label(media_id: str, partition_id: str, expected_uuid: str, label: str) -> dict[str, Any]:
    with _LOCK:
        try:
            _, part, error = _target(media_id, partition_id, expected_uuid)
        except Exception:
            return _error("rci_unavailable", "Не удалось перепроверить состояние раздела.")
        if error:
            return error
        assert part is not None
        if part["protected"]:
            return _error("opkg_protected", "Метка активного OPKG-раздела защищена.")
        if part["state"] != "unmounted":
            return _error("must_unmount", "Перед сменой метки отключите раздел.")
        tool_name = part["label_tool"]
        tool = _tool(tool_name)
        if not tool:
            return _error("tool_missing", "Утилита смены метки недоступна.",
                          f"Установите {tool_name}." if tool_name else "")
        text = str(label or "").strip()
        max_bytes = 16 if part["fstype"].startswith("ext") else 11 if part["fstype"] == "vfat" else 30
        if not text or len(text.encode()) > max_bytes or any(ord(c) < 32 or c in "/\\" for c in text):
            return _error("bad_label", f"Метка должна содержать 1–{max_bytes} байт без / и \\.")
        device = _block_device(expected_uuid)
        if not device:
            return _error("device_unresolved", "Не удалось определить устройство по UUID.")
        argv = [tool, "-L", text, device] if tool_name == "tune2fs" else [tool, device, text]
        try:
            result = subprocess.run(argv, capture_output=True, text=True, errors="replace",
                                    timeout=15, check=False)
        except (OSError, subprocess.TimeoutExpired):
            return _error("label_failed", "Утилита смены метки не завершилась.")
        if result.returncode:
            return _error("label_failed", "Не удалось изменить метку.", (result.stderr or result.stdout)[:300])
        try:
            _, volumes = _inventory()
            refreshed = next((x for x in volumes if x["uuid"] == expected_uuid), None)
            pending = bool(refreshed and refreshed["label_pending"])
        except Exception:
            pending = True
        return {"ok": True, "label_pending": pending}
