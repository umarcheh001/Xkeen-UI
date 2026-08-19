"""Durable, controller-only switching between Xkeen Clash API and a user UI.

The user's dashboard (Zashboard, MetaCubeXD, etc.) is selected by ``external-ui``
and is intentionally never changed here.  Xkeen only needs to replace the
controller transport.  Keeping the original controller directives separately
lets us restore the dashboard without rolling back unrelated edits in
``config.yaml``.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping

from services.mihomo_clash_migration import build_safe_mihomo_config


STATE_VERSION = 1
_DIRECTIVE_RE = re.compile(
    r"^(?P<indent>[ \t]*)(?P<key>external-controller(?:-unix)?|secret)[ \t]*:[ \t]*.*$",
    re.MULTILINE,
)
_XKEEN_COMMENT_RE = re.compile(
    r"^[ \t]*#[ \t]*(?:external-controller отключён: используется Unix socket|secret не требуется для Unix socket)[ \t]*$",
    re.MULTILINE,
)
_EXTERNAL_UI_RE = re.compile(r"^[ \t]*external-ui[ \t]*:[ \t]*(.*?)[ \t]*$", re.MULTILINE)


@dataclass(frozen=True)
class PanelSwitchPreview:
    target: str
    content: str
    panel_name: str

    @property
    def preview_id(self) -> str:
        digest = hashlib.sha256()
        digest.update(self.target.encode("utf-8"))
        digest.update(b"\0")
        digest.update(self.content.encode("utf-8"))
        return digest.hexdigest()


def state_path(ui_state_dir: str, config_file: str) -> Path:
    root = Path(str(ui_state_dir or "").strip() or Path(config_file).parent)
    return root / "mihomo_clash_panel_switch.json"


def _clean_scalar(value: str) -> str:
    text = str(value or "").strip()
    if " #" in text:
        text = text.split(" #", 1)[0].rstrip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in {"'", '"'}:
        text = text[1:-1]
    return text.strip()


def panel_name_from_config(text: str) -> str:
    match = _EXTERNAL_UI_RE.search(str(text or ""))
    raw = _clean_scalar(match.group(1)) if match else ""
    lowered = raw.lower()
    if "zashboard" in lowered:
        return "Zashboard"
    if "metacubex" in lowered:
        return "MetaCubeXD"
    if "yacd" in lowered:
        return "Yacd"
    return raw[:64] or "прежнюю панель"


def controller_directives(text: str) -> list[str]:
    return [match.group(0).rstrip("\r\n") for match in _DIRECTIVE_RE.finditer(str(text or ""))]


def has_browser_dashboard_controller(text: str) -> bool:
    for line in controller_directives(text):
        match = _DIRECTIVE_RE.match(line)
        if not match or match.group("key") != "external-controller":
            continue
        value = _clean_scalar(line.split(":", 1)[1])
        host = value.rsplit(":", 1)[0].strip().strip("[]").lower() if ":" in value else ""
        if host not in {"127.0.0.1", "localhost", "::1"}:
            return True
    return False


def has_tcp_controller(text: str) -> bool:
    return any(
        bool(re.match(r"^[ \t]*external-controller[ \t]*:", line))
        for line in controller_directives(text)
    )


def load_state(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return {}
    if not isinstance(payload, dict) or payload.get("version") != STATE_VERSION:
        return {}
    directives = payload.get("external_directives")
    if not isinstance(directives, list) or not all(isinstance(item, str) for item in directives):
        return {}
    return payload


def save_state(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = dict(payload)
    data["version"] = STATE_VERSION
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.chmod(tmp_name, 0o600)
        except OSError:
            pass
        os.replace(tmp_name, path)
    finally:
        try:
            if os.path.exists(tmp_name):
                os.unlink(tmp_name)
        except OSError:
            pass


def remember_external_config(path: Path, text: str, *, force: bool = False) -> dict[str, Any]:
    current = load_state(path)
    directives = controller_directives(text)
    if not has_tcp_controller(text):
        return current
    if current.get("external_directives") and not force:
        return current
    payload = {
        **current,
        "external_directives": directives,
        "panel_name": panel_name_from_config(text),
        "mode": current.get("mode") or "external",
    }
    save_state(path, payload)
    return payload


def recover_external_config(path: Path, candidates: Iterable[str]) -> dict[str, Any]:
    current = load_state(path)
    if current.get("external_directives"):
        return current
    for text in candidates:
        if has_tcp_controller(text):
            return remember_external_config(path, text)
    return current


def mark_mode(path: Path, mode: str) -> dict[str, Any]:
    payload = load_state(path)
    if not payload:
        return {}
    payload["mode"] = "external" if mode == "external" else "xkeen"
    save_state(path, payload)
    return payload


def _without_controller_directives(text: str) -> str:
    cleaned = _DIRECTIVE_RE.sub("", str(text or ""))
    cleaned = _XKEEN_COMMENT_RE.sub("", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).rstrip()
    return cleaned + "\n"


def build_switch_preview(text: str, state: Mapping[str, Any], target: str) -> PanelSwitchPreview:
    normalized = str(target or "").strip().lower()
    panel_name = str(state.get("panel_name") or panel_name_from_config(text))
    if normalized == "xkeen":
        # Keep the protected Xkeen facade on loopback TCP. This preserves the
        # delay-probe behaviour of browser dashboards on embedded Mihomo builds
        # while still closing LAN access and generating a private credential at
        # apply time.
        content = build_safe_mihomo_config(text, prefer_unix=False).content
        return PanelSwitchPreview("xkeen", content, panel_name)
    if normalized != "external":
        raise ValueError("panel_switch_target_invalid")
    directives = state.get("external_directives")
    if not isinstance(directives, list) or not directives:
        raise ValueError("external_panel_backup_missing")
    content = _without_controller_directives(text).rstrip() + "\n" + "\n".join(directives) + "\n"
    return PanelSwitchPreview("external", content, panel_name)


def public_status(text: str, state: Mapping[str, Any]) -> dict[str, Any]:
    directives = controller_directives(text)
    if any(re.match(r"^[ \t]*external-controller-unix[ \t]*:", line) for line in directives):
        mode = "xkeen"
    elif (
        str(state.get("mode") or "") == "xkeen"
        and has_tcp_controller(text)
        and not has_browser_dashboard_controller(text)
    ):
        # Protected Xkeen mode uses loopback TCP. Honour the persisted switch
        # marker so it is not mistaken for a pre-existing loopback dashboard.
        mode = "xkeen"
    elif has_browser_dashboard_controller(text):
        mode = "external"
    elif str(state.get("mode") or "") in {"xkeen", "external"}:
        mode = str(state.get("mode"))
    elif has_tcp_controller(text):
        # An installation discovered before Xkeen created its own state is a
        # pre-existing dashboard, including loopback + same-origin proxy setups.
        mode = "external"
    else:
        mode = str(state.get("mode") or "external")
    available = bool(state.get("external_directives"))
    return {
        "mode": mode,
        "can_restore_external": available,
        "can_enable_xkeen": True,
        "panel_name": str(state.get("panel_name") or panel_name_from_config(text)),
        "external_url": "/mihomo_panel/ui/" if available else None,
    }


__all__ = [
    "PanelSwitchPreview",
    "build_switch_preview",
    "controller_directives",
    "has_browser_dashboard_controller",
    "has_tcp_controller",
    "load_state",
    "mark_mode",
    "panel_name_from_config",
    "public_status",
    "recover_external_config",
    "remember_external_config",
    "save_state",
    "state_path",
]
