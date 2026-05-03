"""Persistent operation diagnostics snapshots.

Used by the operations journal to reopen rich error details after the browser
page or localStorage cache has been reset.
"""
from __future__ import annotations

import json
import os
import re
import time
from typing import Any, Dict, Optional


_REF_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$")
_DEFAULT_LIMIT = 50
_MAX_LIMIT = 200


def normalize_operation_ref(value: object) -> str:
    ref = str(value or "").strip()
    if not ref or not _REF_RE.match(ref):
        return ""
    return ref


def _diagnostics_dir(ui_state_dir: str) -> str:
    return os.path.join(str(ui_state_dir or ""), "operation-diagnostics")


def _diagnostic_path(ui_state_dir: str, ref: str) -> str:
    safe_ref = normalize_operation_ref(ref)
    if not safe_ref:
        raise ValueError("invalid operation diagnostic ref")
    return os.path.join(_diagnostics_dir(ui_state_dir), safe_ref + ".json")


def _configured_limit(limit: Optional[int] = None) -> int:
    raw = limit
    if raw is None:
        try:
            raw = int(str(os.environ.get("XKEEN_OPERATION_DIAGNOSTICS_LIMIT") or _DEFAULT_LIMIT))
        except Exception:
            raw = _DEFAULT_LIMIT
    try:
        value = int(raw)
    except Exception:
        value = _DEFAULT_LIMIT
    return max(1, min(_MAX_LIMIT, value))


def prune_operation_diagnostics(ui_state_dir: str, *, keep: Optional[int] = None) -> None:
    diag_dir = _diagnostics_dir(ui_state_dir)
    if not os.path.isdir(diag_dir):
        return

    items: list[tuple[float, str]] = []
    for name in os.listdir(diag_dir):
        if not name.endswith(".json"):
            continue
        full = os.path.join(diag_dir, name)
        try:
            st = os.stat(full)
        except OSError:
            continue
        items.append((float(st.st_mtime), full))

    keep_count = _configured_limit(keep)
    items.sort(key=lambda item: item[0], reverse=True)
    for _, full in items[keep_count:]:
        try:
            os.remove(full)
        except OSError:
            pass


def save_operation_diagnostic(
    ui_state_dir: str,
    ref: str,
    payload: Dict[str, Any],
    *,
    kind: str = "generic",
    keep: Optional[int] = None,
) -> Dict[str, Any]:
    safe_ref = normalize_operation_ref(ref)
    if not safe_ref:
        raise ValueError("invalid operation diagnostic ref")

    diag_dir = _diagnostics_dir(ui_state_dir)
    os.makedirs(diag_dir, exist_ok=True)

    created_at = time.strftime("%Y-%m-%d %H:%M:%S")
    record: Dict[str, Any] = {
        "ok": True,
        "ref": safe_ref,
        "kind": str(kind or "generic"),
        "created_at": created_at,
        "created_ts": int(time.time()),
        "payload": dict(payload or {}),
    }

    path = _diagnostic_path(ui_state_dir, safe_ref)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(record, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, path)
    prune_operation_diagnostics(ui_state_dir, keep=keep)
    return record


def read_operation_diagnostic(ui_state_dir: str, ref: str) -> Optional[Dict[str, Any]]:
    safe_ref = normalize_operation_ref(ref)
    if not safe_ref:
        return None
    try:
        path = _diagnostic_path(ui_state_dir, safe_ref)
    except ValueError:
        return None
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    if normalize_operation_ref(data.get("ref")) != safe_ref:
        data["ref"] = safe_ref
    return data
