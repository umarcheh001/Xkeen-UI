"""Persist the official update channel independently of the installed build."""

from __future__ import annotations

import json
from pathlib import Path

from services.io.atomic import _atomic_write_json

CHANNELS = frozenset({"stable", "prerelease"})


def panel_update_available(source: str, target: str, channel: str) -> bool:
    from services.module_package_contract import compare_semver

    comparison = compare_semver(target, source)
    return comparison > 0 or (
        comparison < 0 and channel == "stable"
        and "-" in source.partition("+")[0] and "-" not in target.partition("+")[0]
    )


def read_channel(state_dir: Path) -> str:
    try:
        data = json.loads((Path(state_dir) / "module-update-channel.json").read_text(encoding="utf-8"))
        return data["channel"] if data.get("channel") in CHANNELS else "stable"
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        return "stable"


def write_channel(state_dir: Path, channel: str) -> str:
    if channel not in CHANNELS:
        raise ValueError("unsupported update channel")
    _atomic_write_json(str(Path(state_dir) / "module-update-channel.json"), {"channel": channel}, mode=0o600)
    return channel
