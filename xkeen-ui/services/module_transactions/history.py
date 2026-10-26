"""What the module operations did, kept for DevTools -> Logs.

status.json holds the current or the last operation only. Each operation that
ends is also kept here, one JSON object a line, the last few dozen of them:
DevTools shows them on the «Обновления» tab. With it goes the tail of what the
shared environment script printed for that operation (opkg and the like),
which the runner reads and would otherwise throw away.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping

from services.io.atomic import _atomic_write_text

HISTORY_LIMIT = 50
ENVIRONMENT_TAIL = 200

_KEPT_FIELDS = (
    "operation_id",
    "scope",
    "operation",
    "module_id",
    "version",
    "source_version",
    "result",
    "error_code",
    "error",
    "error_detail",
    "failed_path",
    "started_at",
    "finished_at",
    "log",
    "warnings",
)


def history_path(state_dir: Path) -> Path:
    return Path(state_dir) / "module-operations" / "history.jsonl"


def environment_log_path(state_dir: Path) -> Path:
    return Path(state_dir) / "module-operations" / "environment.log"


def read_history(state_dir: Path) -> list[dict[str, Any]]:
    """The kept operations, oldest first; a line cut short by a crash is skipped."""

    try:
        text = history_path(state_dir).read_text(encoding="utf-8")
    except OSError:
        return []
    entries: list[dict[str, Any]] = []
    for line in text.splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if isinstance(entry, dict) and entry.get("operation_id"):
            entries.append(entry)
    return entries


def _module_name(module_id: Any) -> str | None:
    if not module_id:
        return None
    try:
        from services.module_registry import MODULE_DEFINITIONS
    except Exception:  # noqa: BLE001 - a name is a nicety, the record is not
        return None
    for definition in MODULE_DEFINITIONS:
        if definition.id == module_id:
            return definition.name
    return None


def _environment_tail(state_dir: Path) -> list[str]:
    try:
        text = environment_log_path(state_dir).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    return [line for line in text.splitlines() if line.strip()][-ENVIRONMENT_TAIL:]


def record_history(state_dir: Path, status: Mapping[str, Any]) -> None:
    """Keep an ended operation; the same operation told again replaces its line."""

    operation_id = status.get("operation_id")
    if not operation_id:
        return
    entry = {key: status.get(key) for key in _KEPT_FIELDS if key in status}
    name = _module_name(status.get("module_id"))
    if name:
        entry["module_name"] = name
    try:
        from services.module_update_channel import read_channel

        entry["channel"] = read_channel(state_dir)
    except Exception:  # noqa: BLE001 - the channel is a nicety, the record is not
        pass
    environment = _environment_tail(state_dir)
    if environment:
        entry["environment"] = environment
    entries = [item for item in read_history(state_dir) if item.get("operation_id") != operation_id]
    entries.append(entry)
    entries = entries[-HISTORY_LIMIT:]
    path = history_path(state_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    _atomic_write_text(str(path), "".join(json.dumps(item, ensure_ascii=False) + "\n" for item in entries))


def start_environment_log(state_dir: Path) -> None:
    """A new operation does not inherit what the script printed for the last one."""

    try:
        environment_log_path(state_dir).unlink()
    except FileNotFoundError:
        pass


def append_environment_output(log_path: Path, phase: str, output: str) -> None:
    log_path = Path(log_path)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("a", encoding="utf-8") as handle:
        handle.write(f"=== {phase} ===\n")
        handle.write(output if output.endswith("\n") or not output else output + "\n")
