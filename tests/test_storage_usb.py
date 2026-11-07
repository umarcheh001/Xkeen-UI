from __future__ import annotations

from copy import deepcopy

import pytest

from services import storage_usb


MEDIA = {
    "FlashStorage": {"bus": "mtd", "partition": {"Partition1": {"fstype": "ubifs"}}},
    "Media0": {
        "bus": "usb", "product": "USB DISK", "serial": "serial-1", "ejectable": True,
        "size": "31042043904", "usb": {"port": 1, "version": "3.20"},
        "partition": {
            "Partition3": {"uuid": "opkg-uuid", "label": "OPKG", "fstype": "ext4",
                           "state": "MOUNTED", "used-by": ["cifs", "opkg"],
                           "format-supported": ["ext4"], "check-supported": True},
            "Partition4": {"uuid": "test-uuid", "label": "KEEN2", "fstype": "ext4",
                           "state": "MOUNTED", "used-by": ["cifs"],
                           "format-supported": ["ext4", "exfat"], "check-supported": True,
                           "total": "1000", "free": "800"},
        },
    },
}


@pytest.fixture(autouse=True)
def media(monkeypatch):
    monkeypatch.setattr(storage_usb, "fetch_rci_json", lambda *_a, **_k: deepcopy(MEDIA))
    monkeypatch.setattr(storage_usb, "_mounts", lambda: [
        ("/dev/sda3", "/tmp/mnt/opkg-uuid", "ext4"),
        ("/dev/sda4", "/tmp/mnt/test-uuid", "ext4"),
    ])


def test_inventory_uses_media_partitions_and_marks_opkg():
    result = storage_usb.list_usb_filesystems()
    assert result["ok"] is True
    assert len(result["disks"]) == 1
    assert result["disks"][0]["id"] == "Media0"
    assert result["disks"][0]["protected"] is True
    assert [p["partition_id"] for p in result["items"]] == ["Partition3", "Partition4"]
    assert result["items"][0]["protected"] is True
    assert result["items"][1]["mountpoint"] == "/tmp/mnt/test-uuid"
    assert result["items"][1]["free"] == 800


def test_format_label_options_require_installed_label_tool(monkeypatch):
    monkeypatch.setattr(storage_usb, "_tool", lambda name: "/opt/sbin/tune2fs" if name == "tune2fs" else "")
    result = storage_usb.list_usb_filesystems()
    assert result["items"][1]["format_types"] == ["ext4", "exfat"]
    assert result["items"][1]["labelable_format_types"] == ["ext4"]


@pytest.mark.parametrize("action", ["unmount", "check", "format"])
def test_opkg_partition_never_reaches_rci(monkeypatch, action):
    monkeypatch.setattr(storage_usb, "_command", lambda *_a: pytest.fail("RCI command reached"))
    result = storage_usb.operate_partition(action, "Media0", "Partition3", "opkg-uuid",
                                           fstype="ext4", confirm="FORMAT Media0/Partition3")
    assert result["code"] == "opkg_protected"


def test_eject_protects_whole_disk(monkeypatch):
    monkeypatch.setattr(storage_usb, "_command", lambda *_a: pytest.fail("RCI command reached"))
    assert storage_usb.eject_disk("Media0", "serial-1")["code"] == "opkg_protected"


def test_repartition_protects_opkg_and_revalidates_serial(monkeypatch):
    monkeypatch.setattr(storage_usb, "_command", lambda *_a: pytest.fail("RCI command reached"))
    monkeypatch.setattr(storage_usb, "_disk_device", lambda *_a: pytest.fail("device resolution reached"))
    parts = [{"partition_id": "Partition3", "uuid": "opkg-uuid"},
             {"partition_id": "Partition4", "uuid": "test-uuid"}]
    result = storage_usb.repartition_disk("Media0", "serial-1", parts, [1024, 0],
                                          "REPARTITION Media0/serial-1")
    assert result["code"] == "opkg_protected"
    assert storage_usb.repartition_disk("Media0", "wrong", parts, [1024, 0],
                                        "REPARTITION Media0/wrong")["code"] == "stale_target"


def test_repartition_rejects_changed_layout_and_oversized_parts(monkeypatch):
    safe = deepcopy(MEDIA)
    safe["Media0"]["partition"].pop("Partition3")
    monkeypatch.setattr(storage_usb, "fetch_rci_json", lambda *_a, **_k: deepcopy(safe))
    monkeypatch.setattr(storage_usb, "_disk_device", lambda *_a: "/dev/sdb")
    monkeypatch.setattr(storage_usb, "_tool", lambda name: "/opt/sbin/parted" if name == "parted" else "")
    monkeypatch.setattr(storage_usb, "_parted_layout", lambda *_a: None)
    monkeypatch.setattr(storage_usb.subprocess, "run", lambda *_a, **_k: pytest.fail("parted reached"))
    base = ("Media0", "serial-1")
    confirmation = "REPARTITION Media0/serial-1"
    assert storage_usb.repartition_disk(*base, [], [1024, 0], confirmation)["code"] == "stale_target"
    expected = [{"partition_id": "Partition4", "uuid": "test-uuid"}]
    assert storage_usb.repartition_disk(*base, expected, [40000, 0], confirmation)["code"] == "bad_layout"


def test_repartition_checks_kernel_mounts_before_parted(monkeypatch):
    safe = deepcopy(MEDIA)
    safe["Media0"]["partition"].pop("Partition3")
    safe["Media0"]["partition"]["Partition4"]["state"] = "UNMOUNTED"
    monkeypatch.setattr(storage_usb, "fetch_rci_json", lambda *_a, **_k: deepcopy(safe))
    monkeypatch.setattr(storage_usb, "_disk_device", lambda *_a: "/dev/sda")
    monkeypatch.setattr(storage_usb, "_tool", lambda name: "/opt/sbin/parted" if name == "parted" else "")
    monkeypatch.setattr(storage_usb, "_parted_layout", lambda *_a: None)
    monkeypatch.setattr(storage_usb.subprocess, "run", lambda *_a, **_k: pytest.fail("parted reached"))
    result = storage_usb.repartition_disk(
        "Media0", "serial-1", [{"partition_id": "Partition4", "uuid": "test-uuid"}],
        [1024, 0], "REPARTITION Media0/serial-1",
    )
    assert result["code"] == "disk_in_use"


def test_new_partition_without_uuid_can_be_formatted(monkeypatch):
    safe = deepcopy(MEDIA)
    safe["Media0"]["partition"].pop("Partition3")
    safe["Media0"]["partition"]["Partition4"] = {
        "uuid": "", "state": "UNSUPPORTED", "format-supported": ["ext4"],
    }
    monkeypatch.setattr(storage_usb, "fetch_rci_json", lambda *_a, **_k: deepcopy(safe))
    calls = []
    monkeypatch.setattr(storage_usb, "_command", lambda path, data: calls.append((path, data)) or {"ok": True})
    assert storage_usb.operate_partition("mount", "Media0", "Partition4", "")["code"] == "invalid_state"
    assert storage_usb.operate_partition("format", "Media0", "Partition4", "", fstype="ext4",
                                         confirm="FORMAT Media0/Partition4")["ok"]
    assert calls == [("media.partition.format", {"name": "Media0", "partition": "Partition4", "type": "ext4"})]


def test_format_checks_uuid_confirmation_and_supported_type(monkeypatch):
    calls = []
    monkeypatch.setattr(storage_usb, "_command", lambda path, data: calls.append((path, data)) or {"ok": True})
    base = ("format", "Media0", "Partition4", "test-uuid")
    assert storage_usb.operate_partition(*base, fstype="ext4")["code"] == "confirmation_required"
    assert storage_usb.operate_partition(*base, fstype="vfat", confirm="FORMAT Media0/Partition4")["code"] == "unsupported_format"
    assert storage_usb.operate_partition("format", "Media0", "Partition4", "old-uuid",
                                         fstype="ext4", confirm="FORMAT Media0/Partition4")["code"] == "stale_target"
    assert not calls
    assert storage_usb.operate_partition(*base, fstype="ext4", confirm="FORMAT Media0/Partition4")["ok"]
    assert calls == [("media.partition.format", {"name": "Media0", "partition": "Partition4", "type": "ext4"})]


def test_mount_uses_uuid_and_label_requires_unmount(monkeypatch):
    calls = []
    monkeypatch.setattr(storage_usb, "_command", lambda path, data: calls.append((path, data)) or {"ok": True})
    assert storage_usb.operate_partition("unmount", "Media0", "Partition4", "test-uuid")["ok"]
    assert calls == [("system.mount", {"filesystem": "test-uuid:", "no": True})]
    assert storage_usb.set_volume_label("Media0", "Partition4", "test-uuid", "NEW")["code"] == "must_unmount"


def test_rci_error_response_is_not_reported_as_success(monkeypatch):
    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def read(self, _size):
            return b'{"system":{"mount":{"status":[{"status":"error","message":"busy"}]}}}'

    monkeypatch.setattr(storage_usb.urllib.request, "urlopen", lambda *_a, **_k: Response())
    result = storage_usb._command("system.mount", {"filesystem": "test-uuid:", "no": True})
    assert result["code"] == "rci_failed"
    assert result["hint"] == "busy"


def test_single_partition_layout_is_accepted_before_device_checks(monkeypatch):
    safe = deepcopy(MEDIA)
    safe["Media0"]["partition"].pop("Partition3")
    monkeypatch.setattr(storage_usb, "fetch_rci_json", lambda *_a, **_k: deepcopy(safe))
    monkeypatch.setattr(storage_usb, "_disk_device", lambda *_a: "/dev/sdb")
    monkeypatch.setattr(storage_usb, "_tool", lambda name: "/opt/sbin/parted" if name == "parted" else "")
    monkeypatch.setattr(storage_usb, "_parted_layout", lambda *_a: None)
    result = storage_usb.repartition_disk("Media0", "serial-1", [], [0], "REPARTITION Media0/serial-1")
    assert result["code"] == "stale_target"


def test_edit_partitions_never_touches_opkg_disk(monkeypatch):
    monkeypatch.setattr(storage_usb, "_disk_device", lambda *_a: pytest.fail("device resolution reached"))
    parts = [{"partition_id": "Partition3", "uuid": "opkg-uuid"},
             {"partition_id": "Partition4", "uuid": "test-uuid"}]
    for action in ("add", "delete", "split", "merge"):
        result = storage_usb.edit_partitions(action, "Media0", "serial-1", parts,
                                             confirm="EDIT Media0/serial-1")
        assert result["code"] == "opkg_protected"


def test_edit_partitions_rejects_stale_and_nonempty_targets(monkeypatch):
    safe = deepcopy(MEDIA)
    safe["Media0"]["partition"].pop("Partition3")
    safe["Media0"]["partition"]["Partition4"]["state"] = "UNMOUNTED"
    monkeypatch.setattr(storage_usb, "fetch_rci_json", lambda *_a, **_k: deepcopy(safe))
    monkeypatch.setattr(storage_usb, "_disk_device", lambda *_a: "/dev/sdb")
    monkeypatch.setattr(storage_usb, "_tool", lambda name: "/opt/sbin/parted" if name == "parted" else "")
    monkeypatch.setattr(storage_usb, "_parted_layout", lambda *_a: {
        "label": "gpt", "sector_size": 512,
        "partitions": [{"number": 4, "start": 2048, "end": 4196351}], "free": []})
    monkeypatch.setattr(storage_usb, "_parted_run", lambda *_a: pytest.fail("parted mutation reached"))
    expected = [{"partition_id": "Partition4", "uuid": "test-uuid"}]
    base = ("Media0", "serial-1", expected)
    assert storage_usb.edit_partitions("split", *base, partition_id="Partition4", uuid="test-uuid",
                                       size_mib=512, confirm="EDIT Media0/serial-1")["code"] == "disk_in_use"
    assert storage_usb.edit_partitions("add", *base, start_sector=999999, size_mib=128,
                                       confirm="EDIT Media0/serial-1")["code"] == "stale_target"
    assert storage_usb.edit_partitions("delete", "Media0", "serial-1", [], partition_id="Partition4",
                                       uuid="test-uuid", confirm="EDIT Media0/serial-1")["code"] == "stale_target"


def test_edit_partitions_add_uses_exact_free_geometry(monkeypatch):
    part = {"partition_id": "Partition1", "uuid": "first", "state": "unmounted",
            "used_by": [], "protected": False}
    disk = {"id": "Media1", "serial": "spare", "protected": False, "partitions": [part]}
    layout = {"label": "gpt", "sector_size": 512,
              "partitions": [{"number": 1, "start": 2048, "end": 526335}],
              "free": [{"number": 0, "start": 526336, "end": 900000}]}
    commands = []
    monkeypatch.setattr(storage_usb, "_inventory", lambda: ([disk], disk["partitions"]))
    monkeypatch.setattr(storage_usb, "_disk_device", lambda *_a: "/dev/sdb")
    monkeypatch.setattr(storage_usb, "_tool", lambda name: "/opt/sbin/parted" if name == "parted" else "")
    monkeypatch.setattr(storage_usb, "_parted_layout", lambda *_a: layout)
    monkeypatch.setattr(storage_usb, "_mounts", lambda: [])
    monkeypatch.setattr(storage_usb, "_partprobe", lambda *_a: None)
    monkeypatch.setattr(storage_usb, "_clear_new_partition_headers", lambda *_a: None)
    def run_parted(*args):
        commands.append(args[3:])
        layout["partitions"].append({"number": 2, "start": 526336, "end": 788479})
        return None

    monkeypatch.setattr(storage_usb, "_parted_run", run_parted)
    result = storage_usb.edit_partitions(
        "add", "Media1", "spare", [{"partition_id": "Partition1", "uuid": "first"}],
        start_sector=526336, size_mib=128, confirm="EDIT Media1/spare")
    assert result["ok"] is True
    assert commands == [("mkpart", "xkeen-1", "526336s", "788479s")]


def test_edit_partitions_blocks_nonempty_split_and_non_adjacent_merge(monkeypatch):
    first = {"partition_id": "Partition1", "uuid": "first", "state": "mounted",
             "used_by": [], "empty": False, "protected": False}
    second = {"partition_id": "Partition2", "uuid": "second", "state": "mounted",
              "used_by": [], "empty": True, "protected": False}
    disk = {"id": "Media1", "serial": "spare", "protected": False, "partitions": [first, second]}
    layout = {"label": "gpt", "sector_size": 512,
              "partitions": [{"number": 1, "start": 2048, "end": 526335},
                              {"number": 2, "start": 600000, "end": 1050623}], "free": []}
    monkeypatch.setattr(storage_usb, "_inventory", lambda: ([disk], disk["partitions"]))
    monkeypatch.setattr(storage_usb, "_disk_device", lambda *_a: "/dev/sdb")
    monkeypatch.setattr(storage_usb, "_tool", lambda name: "/opt/sbin/parted" if name == "parted" else "")
    monkeypatch.setattr(storage_usb, "_parted_layout", lambda *_a: layout)
    monkeypatch.setattr(storage_usb, "_mounts", lambda: [])
    assert storage_usb.edit_partitions("split", "Media1", "spare", [
        {"partition_id": "Partition1", "uuid": "first"}, {"partition_id": "Partition2", "uuid": "second"}],
        partition_id="Partition1", uuid="first", size_mib=128,
        confirm="EDIT Media1/spare")["code"] == "disk_in_use"
    first["empty"] = True
    assert storage_usb.edit_partitions("merge", "Media1", "spare", [
        {"partition_id": "Partition1", "uuid": "first"}, {"partition_id": "Partition2", "uuid": "second"}],
        partition_id="Partition1", uuid="first", other_id="Partition2", other_uuid="second",
        confirm="EDIT Media1/spare")["code"] == "bad_layout"


def test_split_remounts_unchanged_partition(monkeypatch):
    first = {"partition_id": "Partition1", "uuid": "first", "state": "mounted",
             "used_by": [], "empty": True, "protected": False}
    second = {"partition_id": "Partition2", "uuid": "second", "state": "mounted",
              "used_by": [], "empty": True, "protected": False}
    disk = {"id": "Media1", "serial": "spare", "protected": False, "partitions": [first, second]}
    layout = {"label": "gpt", "sector_size": 512, "free": [],
              "partitions": [{"number": 1, "start": 2048, "end": 526335},
                              {"number": 2, "start": 526336, "end": 1574911}]}
    calls = []
    monkeypatch.setattr(storage_usb, "_inventory", lambda: ([disk], disk["partitions"]))
    monkeypatch.setattr(storage_usb, "_disk_device", lambda *_a: "/dev/sdb")
    monkeypatch.setattr(storage_usb, "_tool", lambda name: "/opt/sbin/parted" if name == "parted" else "")
    monkeypatch.setattr(storage_usb, "_parted_layout", lambda *_a: layout)
    monkeypatch.setattr(storage_usb, "_mounts", lambda: [])
    monkeypatch.setattr(storage_usb, "_partprobe", lambda *_a: None)
    monkeypatch.setattr(storage_usb, "_clear_new_partition_headers", lambda *_a: None)

    def command(_path, data):
        calls.append(data)
        target = next(p for p in disk["partitions"] if p["uuid"] + ":" == data["filesystem"])
        target["state"] = "unmounted" if data["no"] else "mounted"
        return {"ok": True}

    def parted(_disk, _device, _tool, *args):
        if args[0] == "rm":
            layout["partitions"] = [p for p in layout["partitions"] if p["number"] != int(args[1])]
        else:
            number = next(n for n in range(1, 10) if all(p["number"] != n for p in layout["partitions"]))
            layout["partitions"].append({"number": number, "start": int(args[-2][:-1]),
                                         "end": int(args[-1][:-1])})
        return None

    monkeypatch.setattr(storage_usb, "_command", command)
    monkeypatch.setattr(storage_usb, "_parted_run", parted)
    result = storage_usb.edit_partitions("split", "Media1", "spare", [
        {"partition_id": "Partition1", "uuid": "first"}, {"partition_id": "Partition2", "uuid": "second"}],
        partition_id="Partition2", uuid="second", size_mib=128, confirm="EDIT Media1/spare")
    assert result["ok"] is True
    assert result["created_partition_ids"] == ["Partition2", "Partition3"]
    assert first["state"] == "mounted"
    assert calls[-1] == {"filesystem": "first:", "no": False}
