"""Conservative REALITY rotation through a configured loopback HandlerService."""

from __future__ import annotations

import copy
import ipaddress
import json
import os
import subprocess
import tempfile
import threading
from pathlib import Path

from services import xray_transactions
from services.url_policy import env_flag
from utils.jsonc import strip_json_comments_text

_LOCK = threading.RLock()


def loopback_server(value):
    listen = str(value or "")
    try:
        host, port = listen.rsplit(":", 1)
        if ipaddress.ip_address(host.strip("[]")).is_loopback and 0 < int(port) < 65536:
            return listen
    except ValueError:
        pass
    return None


class HotApplyUncertain(RuntimeError):
    """API rollback could not prove that the previous runtime was restored."""


def _plan(before: dict[str, bytes], after: dict[str, bytes]):
    old, new = {}, {}
    api = None
    if set(before) != set(after):
        return None
    for name in sorted(before):
        if name.endswith((".yaml", ".yml", ".toml")):
            return None
        if not name.endswith((".json", ".jsonc")):
            continue
        left = json.loads(strip_json_comments_text(before[name].decode("utf-8-sig")))
        right = json.loads(strip_json_comments_text(after[name].decode("utf-8-sig")))
        left_out = left.pop("outbounds", [])
        right_out = right.pop("outbounds", [])
        if left != right:
            return None
        if "api" in left:
            if api is not None:
                return None
            api = left["api"]
        for dest, entries in ((old, left_out), (new, right_out)):
            for outbound in entries:
                tag = outbound.get("tag")
                if not isinstance(tag, str) or not tag or tag in dest:
                    return None
                dest[tag] = outbound
    if not old or old.keys() != new.keys() or not isinstance(api, dict):
        return None
    listen = loopback_server(api.get("listen"))
    if not listen:
        return None
    if "HandlerService" not in api.get("services", []):
        return None
    changed = [tag for tag in old if old[tag] != new[tag]]
    if not changed:
        return None
    for tag in changed:
        if tag.startswith("-") or old[tag].get("protocol") != "vless":
            return None
        for entry in (old[tag], new[tag]):
            if entry.get("mux", {}).get("enabled"):
                return None
        stripped = []
        for entry in (old[tag], new[tag]):
            entry = copy.deepcopy(entry)
            stream = entry.get("streamSettings", {})
            if stream.get("security") != "reality":
                return None
            reality = stream.get("realitySettings", {})
            reality.pop("serverName", None)
            reality.pop("shortId", None)
            stripped.append(entry)
        if stripped[0] != stripped[1]:
            return None
    return listen, old, new, changed


def _command(binary: str, *args: str):
    proc = subprocess.run([binary, *args], capture_output=True, text=True, timeout=10, check=False)
    if proc.returncode:
        # CLI output can contain subscription credentials.
        raise RuntimeError("xray_api_command_failed")
    return proc.stdout


def _api(binary: str, server: str, command: str, *args: str):
    return _command(binary, "api", command, f"--server={server}", "--timeout=3", *args)


def _json_output(output: str):
    # Some builds print config-reader logs before the JSON document.
    lines = output.splitlines()
    start = next(i for i, line in enumerate(lines) if line.lstrip().startswith("{"))
    return json.loads("\n".join(lines[start:]))


def _compiled(binary: str, files: dict[str, bytes], directory: Path):
    directory.mkdir()
    paths = []
    for name in sorted(files):
        if name.endswith((".json", ".jsonc")):
            obj = json.loads(strip_json_comments_text(files[name].decode("utf-8-sig")))
            path = directory / name
            path.write_text(json.dumps({"outbounds": obj.get("outbounds", [])}), encoding="utf-8")
            paths.append(str(path))
    result = _json_output(_command(binary, "convert", "pb", "-debug", "-type", *paths))
    entries = result["outbound"]
    return {item["tag"]: item for item in entries}, entries[0]["tag"]


def _runtime(binary: str, server: str):
    result = _json_output(_api(binary, server, "lso"))
    entries = result.get("outbounds", [])
    mapped = {item["tag"]: item for item in entries}
    if len(mapped) != len(entries):
        raise RuntimeError("xray_api_duplicate_tags")
    return mapped


def try_apply(configs_dir: str, previous: dict[str, bytes]):
    """Apply SNI/shortId-only changes, or leave them for the validated restart.

    HandlerService has no atomic replace: existing streams retain their old
    handler, while a new dial during remove/add may briefly need its fallback.
    Tags, selectors, routing, Observatory and DNS are never rewritten here.
    """
    if not env_flag("XKEEN_SUBSCRIPTIONS_HOT_APPLY", False):
        return None
    with _LOCK:
        try:
            current = {p.name: p.read_bytes() for p in Path(configs_dir).iterdir() if p.is_file()}
            plan = _plan(previous, current)
            if plan is None:
                return None
            server, old, new, changed = plan
            binary = xray_transactions.xray_binary()
            if not binary or xray_transactions.check_confdir(configs_dir).get("ok") is not True:
                return None
            with tempfile.TemporaryDirectory(prefix="xkeen-handler-") as temp:
                path = Path(temp) / "outbounds.json"
                expected_old, default = _compiled(binary, previous, Path(temp) / "before")
                expected_new, new_default = _compiled(binary, current, Path(temp) / "after")
                if _runtime(binary, server) != expected_old:
                    return None
                if default != new_default:
                    return None
                touched = []
                try:
                    for tag in changed:
                        touched.append(tag)
                        _api(binary, server, "rmo", "--", tag)
                        path.write_text(json.dumps({"outbounds": [new[tag]]}), encoding="utf-8")
                        _api(binary, server, "ado", str(path))
                    if _runtime(binary, server) != expected_new:
                        raise RuntimeError("xray_api_verification_failed")
                    return {"restarted": False, "hot_applied": True, "apply_method": "handler_service", "hot_applied_count": len(changed)}
                except Exception:
                    try:
                        for tag in reversed(touched):
                            _api(binary, server, "rmo", "--", tag)
                            path.write_text(json.dumps({"outbounds": [old[tag]]}), encoding="utf-8")
                            _api(binary, server, "ado", str(path))
                        if _runtime(binary, server) != expected_old:
                            raise RuntimeError("xray_api_rollback_verification_failed")
                    except Exception as exc:
                        raise HotApplyUncertain("xray_handler_rollback_failed") from exc
                    return {"hot_applied": False, "hot_apply_fallback": True}
        except HotApplyUncertain:
            raise
        except Exception:
            return None
