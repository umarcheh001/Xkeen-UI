"""USB storage helpers (Keenetic).

This module provides a small, focused API for the File Manager UI:

  - list USB filesystems via `ndmc -c "show usb"`
  - mount / unmount a filesystem via `ndmc -c "system\nmount <fs>"`

We intentionally keep the parsing best-effort and resilient:
different Keenetic firmware versions may include slightly different fields.

Returned items are *enriched* with runtime mount information from /proc/mounts
and disk usage (when mounted).
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple


_SAFE_FS_NAME_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")


@dataclass
class NdmcResult:
    rc: int
    out: str
    err: str


def ndmc_exists() -> bool:
    try:
        return bool(shutil.which("ndmc"))
    except Exception:
        return False


def _run_ndmc(commands: List[str], *, timeout_s: float = 6.0) -> NdmcResult:
    """Run ndmc with a sequence of CLI commands.

    We use a multi-line `-c` payload to support group mode (e.g. `system`).
    """

    payload = "\n".join([str(c or "").strip() for c in commands if str(c or "").strip()])
    if not payload:
        return NdmcResult(rc=2, out="", err="empty command")

    try:
        cp = subprocess.run(
            ["ndmc", "-c", payload],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=float(timeout_s),
        )
        return NdmcResult(rc=int(cp.returncode or 0), out=str(cp.stdout or ""), err=str(cp.stderr or ""))
    except FileNotFoundError:
        return NdmcResult(rc=127, out="", err="ndmc not found")
    except subprocess.TimeoutExpired:
        return NdmcResult(rc=124, out="", err="ndmc timeout")
    except Exception as e:  # noqa: BLE001
        return NdmcResult(rc=1, out="", err=str(e))


def _read_proc_mounts() -> List[Tuple[str, str, str]]:
    """Return list of (src, mountpoint, fstype)."""
    items: List[Tuple[str, str, str]] = []

    def _unescape(token: str) -> str:
        # /proc/mounts uses octal escapes (e.g. \040 for space).
        try:
            return re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), token)
        except Exception:
            return token

    try:
        with open("/proc/mounts", "r", encoding="utf-8") as f:
            for line in f:
                parts = line.strip().split()
                if len(parts) >= 3:
                    items.append((_unescape(parts[0]), _unescape(parts[1]), parts[2]))
    except Exception:
        return []
    return items


def _disk_usage_best_effort(path: str) -> Tuple[Optional[int], Optional[int]]:
    try:
        du = shutil.disk_usage(path)
        return int(du.total), int(du.free)
    except Exception:
        return None, None


def _parse_show_usb_filesystems(text: str) -> List[Dict[str, Any]]:
    """Best-effort parser for `ndmc -c "show usb"`.

    Keenetic firmware versions differ, and the CLI output is hierarchical.
    What we *need* for the UI is the list of *filesystems* (volumes/partitions),
    not the list of USB devices (modems, hubs, etc.).

    A common shape (indentation may vary):

      device:
        name: ...
        subsystem: storage
        filesystem: Media0:
          name: Media0:
          label: BACKUPS
          type: exfat
          state: mounted
          mount: /tmp/mnt/BACKUPS
        filesystem: Media1:
          ...

    We parse device context (notably `subsystem`) and extract every `filesystem:`
    block into a separate item, carrying the parent subsystem.

    Real-world output variance we must tolerate:
      - `device:` may be printed as `device:` **or** `device: <name>:`.
      - indentation may use spaces, tabs, or be inconsistent.
      - some firmwares keep the same indentation level for filesystem fields.

    The parser intentionally treats a filesystem block as spanning until the
    next `device:`/`filesystem:` boundary.
    """

    out: List[Dict[str, Any]] = []

    device_ctx: Dict[str, Any] = {}
    fs_cur: Optional[Dict[str, Any]] = None
    fs_indent: Optional[int] = None

    def _flush_fs() -> None:
        nonlocal fs_cur, fs_indent
        if not fs_cur:
            fs_indent = None
            return
        # Normalize name
        if "name" not in fs_cur:
            if fs_cur.get("filesystem"):
                fs_cur["name"] = fs_cur.get("filesystem")
        if fs_cur.get("name"):
            out.append(fs_cur)
        fs_cur = None
        fs_indent = None

    # Keep indentation; we use it to detect entering/leaving filesystem blocks.
    # IMPORTANT: count any leading whitespace (spaces OR tabs).
    for raw in (text or "").splitlines():
        line = raw.rstrip("\n")
        if not line.strip():
            continue

        indent = len(line) - len(line.lstrip())
        s = line.strip()

        m = re.match(r"^([A-Za-z0-9_.-]+)\s*:\s*(.*)$", s)
        if not m:
            continue
        k = m.group(1).strip().lower()
        v = (m.group(2) or "").strip()

        # Device boundary: accept both `device:` and `device: <name>:`.
        if k == "device":
            _flush_fs()
            device_ctx = {}
            if v:
                device_ctx["device"] = v
            continue

        # Start of a filesystem block.
        if k == "filesystem":
            _flush_fs()
            fs_cur = {"filesystem": v, "subsystem": device_ctx.get("subsystem", "")}
            fs_indent = indent
            continue

        # While inside a filesystem block, accept keys at the same or deeper indentation.
        # Some firmwares do not add extra indentation under `filesystem:`.
        if fs_cur is not None and (fs_indent is None or indent >= fs_indent) and k not in ("device", "filesystem"):
            fs_cur[k] = v
            continue

        # Otherwise treat as device-level attribute.
        device_ctx[k] = v

    _flush_fs()
    return out


def _parse_show_usb_flat(text: str) -> List[Dict[str, Any]]:
    """Fallback parser for older/atypical `show usb` outputs.

    Some firmware versions do not emit nested `filesystem:` blocks, and instead
    print a flat list of devices with a single `name:` (which may already be the
    filesystem name).
    """

    items: List[Dict[str, Any]] = []
    cur: Dict[str, Any] = {}

    def _flush() -> None:
        nonlocal cur
        if cur and (cur.get("name") or cur.get("filesystem")):
            if "filesystem" in cur and "name" not in cur:
                cur["name"] = cur.get("filesystem")
            items.append(cur)
        cur = {}

    for raw in (text or "").splitlines():
        s = raw.strip()
        if not s:
            continue

        m = re.match(r"^([A-Za-z0-9_.-]+)\s*:\s*(.*)$", s)
        if not m:
            continue
        k = m.group(1).strip().lower()
        v = (m.group(2) or "").strip()

        # Device boundary: accept both `device:` and `device: <name>:`.
        if k == "device":
            _flush()
            if v:
                cur["device"] = v
            continue

        cur[k] = v

    _flush()
    return items


def list_usb_filesystems() -> Dict[str, Any]:
    """Return USB filesystem list enriched with mount state.

    Returns payload:
      { ok, items:[{name,label,fstype,state,mountpoint,total,free}], raw? }
    """

    if not ndmc_exists():
        return {"ok": False, "code": "ndmc_missing", "message": "ndmc not found"}

    # Firmware variance: some builds provide richer output with more specific
    # subcommands. Try a small cascade and pick the first one that yields a
    # usable filesystem list.
    candidates = [
        "show usb storage",
        "show usb filesystem",
        "show usb",
    ]

    last_res: Optional[NdmcResult] = None
    parsed: List[Dict[str, Any]] = []

    def _looks_like_filesystems(items: List[Dict[str, Any]]) -> bool:
        if not items:
            return False
        # If we see any FS-ish fields, it's probably the right view.
        for it in items:
            for k in ("label", "type", "fstype", "format", "fs", "state", "status", "mount", "mountpoint"):
                if str(it.get(k) or "").strip():
                    return True
        # Otherwise still accept a non-empty list (allows mount/unmount),
        # but we may rely more on /proc/mounts enrichment.
        return True

    for cmd in candidates:
        r = _run_ndmc([cmd], timeout_s=8.0)
        last_res = r
        if r.rc != 0 or not (r.out or "").strip():
            continue
        tmp = _parse_show_usb_filesystems(r.out)
        if not tmp:
            tmp = _parse_show_usb_flat(r.out)
        if _looks_like_filesystems(tmp):
            parsed = tmp
            break

    if not parsed:
        details = ""
        if last_res is not None:
            details = (last_res.err or last_res.out or "").strip()[:8000]
        return {"ok": False, "code": "ndmc_failed", "message": "failed to query usb", "details": details}

    mounts = _read_proc_mounts()
    # Map basename(/tmp/mnt/<id>) -> mount info
    m_by_base: Dict[str, Dict[str, str]] = {}
    # Map mount source -> mount info (helps when we cannot match by label/name).
    m_by_src: Dict[str, Dict[str, str]] = {}
    for src, mnt, fstype in mounts:
        try:
            if not mnt.startswith("/tmp/mnt/"):
                continue
            base = os.path.basename(mnt.rstrip("/"))
            if not base:
                continue
            m_by_base[base] = {"src": src, "mountpoint": mnt, "fstype": fstype}
            if src:
                m_by_src[src] = {"src": src, "mountpoint": mnt, "fstype": fstype}
        except Exception:
            continue

    def _norm_token(x: str) -> str:
        return str(x or "").strip().strip('"').rstrip(":")

    def _first_nonempty(d: Dict[str, Any], keys: List[str]) -> str:
        for kk in keys:
            v = str(d.get(kk) or "").strip()
            if v:
                return v
        return ""

    items: List[Dict[str, Any]] = []
    for it in parsed:
        subsystem = str(it.get("subsystem") or "").strip()
        subs_l = subsystem.lower()
        # If subsystem is explicitly non-storage, skip.
        if subs_l and ("stor" not in subs_l) and ("disk" not in subs_l) and ("mmc" not in subs_l) and ("sd" not in subs_l):
            continue

        name_raw = str(it.get("name") or "").strip()
        if not name_raw:
            continue
        name_norm = _norm_token(name_raw)

        # Extra guard: do not show modem/network interfaces in the volumes list.
        n_low = name_norm.lower()
        if n_low.startswith(("usbqmi", "usblte", "usbcdc", "ttyusb", "cdc", "wwan")):
            continue

        label_raw = _first_nonempty(it, ["label", "volume", "volume-label", "volume_label"])
        label_norm = _norm_token(label_raw)

        mp_raw = _first_nonempty(it, ["mount", "mountpoint", "mount-point", "mounted", "mounted-to", "mounted_to"])
        mp_raw = str(mp_raw or "").strip()
        # Some firmwares use boolean-ish fields; ignore those.
        if mp_raw and not mp_raw.startswith("/"):
            mp_raw = ""

        mnt = None
        if mp_raw:
            base = os.path.basename(mp_raw.rstrip("/"))
            mnt = m_by_base.get(base)
        else:
            # Try matching by mount source (/dev/xxx, UUID=..., LABEL=...).
            src_hint = _first_nonempty(it, ["src", "source", "device", "dev", "block", "node", "path", "partition"])
            src_hint = _norm_token(src_hint)
            if src_hint:
                mnt = m_by_src.get(src_hint)
                if not mnt and not src_hint.startswith("/"):
                    # Common case: show usb prints `sda1`, /proc/mounts prints `/dev/sda1`.
                    mnt = m_by_src.get("/dev/" + src_hint)
            if not mnt:
                for key in [label_norm, name_norm, _norm_token(label_raw), _norm_token(name_raw)]:
                    if not key:
                        continue
                    mnt = m_by_base.get(key)
                    if mnt:
                        break

        mountpoint = mp_raw or (mnt or {}).get("mountpoint") or ""
        fstype = (mnt or {}).get("fstype") or _first_nonempty(it, ["type", "fstype", "format", "fs"])

        st_raw = _first_nonempty(it, ["state", "status"]).lower()
        if st_raw in ("mounted", "mount", "yes", "true", "1"):
            mounted = True
        elif st_raw in ("unmounted", "no", "false", "0"):
            mounted = False
        else:
            mounted = bool(mountpoint)

        total, free = _disk_usage_best_effort(mountpoint) if mounted and mountpoint else (None, None)

        label_out = label_norm or (os.path.basename(mountpoint.rstrip("/")) if mountpoint else "")

        items.append(
            {
                "name": name_norm or name_raw,
                "id": name_norm,
                "label": label_out,
                "subsystem": subsystem,
                "fstype": str(fstype or "").strip(),
                "state": "mounted" if mounted else "unmounted",
                "mountpoint": mountpoint,
                "total": total,
                "free": free,
            }
        )

    return {"ok": True, "items": items, "ts": int(time.time())}


def mount_filesystem(name: str) -> Dict[str, Any]:
    if not ndmc_exists():
        return {"ok": False, "code": "ndmc_missing", "message": "ndmc not found"}

    fs = str(name or "").strip()
    # Some firmware prints names with a trailing ':' (formatting), but the CLI expects plain name.
    fs_exec = fs.rstrip(":")
    if not fs_exec or not _SAFE_FS_NAME_RE.match(fs_exec):
        return {"ok": False, "code": "bad_name", "message": "invalid filesystem name"}

    res = _run_ndmc(["system", f"mount {fs_exec}"], timeout_s=12.0)
    if res.rc != 0:
        return {
            "ok": False,
            "code": "ndmc_failed",
            "message": "mount failed",
            "details": (res.err or res.out or "").strip()[:8000],
        }
    return {"ok": True, "stdout": (res.out or "").strip(), "stderr": (res.err or "").strip()}


def unmount_filesystem(name: str) -> Dict[str, Any]:
    if not ndmc_exists():
        return {"ok": False, "code": "ndmc_missing", "message": "ndmc not found"}

    fs = str(name or "").strip()
    fs_exec = fs.rstrip(":")
    if not fs_exec or not _SAFE_FS_NAME_RE.match(fs_exec):
        return {"ok": False, "code": "bad_name", "message": "invalid filesystem name"}

    res = _run_ndmc(["system", f"no mount {fs_exec}"], timeout_s=12.0)
    if res.rc != 0:
        return {
            "ok": False,
            "code": "ndmc_failed",
            "message": "unmount failed",
            "details": (res.err or res.out or "").strip()[:8000],
        }
    return {"ok": True, "stdout": (res.out or "").strip(), "stderr": (res.err or "").strip()}
