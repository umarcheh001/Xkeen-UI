"""Safe, minimal migration helpers for the local Mihomo Clash API.

Only top-level controller settings are changed.  The default Unix transport
keeps credentials out of the browser and avoids exposing the API to the LAN.
The returned preview is intentionally a compact change summary; the complete
user configuration stays on the server.
"""

from __future__ import annotations

import hashlib
import re
import secrets
from dataclasses import dataclass


_CONTROLLER_RE = re.compile(
    r"^(?P<indent>\s*)external-controller\s*:\s*.*$", re.MULTILINE
)
_UNIX_RE = re.compile(
    r"^(?P<indent>\s*)external-controller-unix\s*:\s*.*$", re.MULTILINE
)
_SECRET_RE = re.compile(r"^(?P<indent>\s*)secret\s*:\s*.*$", re.MULTILINE)


@dataclass(frozen=True)
class MigrationPreview:
    content: str
    transport: str
    changes: tuple[str, ...]

    @property
    def preview_id(self) -> str:
        digest = hashlib.sha256()
        digest.update(self.transport.encode("utf-8"))
        digest.update(b"\0")
        digest.update(self.content.encode("utf-8"))
        return digest.hexdigest()

    def public_dict(self, *, include_content: bool = False) -> dict[str, object]:
        payload: dict[str, object] = {
            "transport": self.transport,
            "changes": list(self.changes),
            "preview_id": self.preview_id,
        }
        # Full configs can contain subscription URLs, credentials and private
        # paths.  Keep them server-side unless a legacy/internal caller opts in.
        if include_content:
            payload["content"] = self.content
        return payload


def _replace_or_insert(
    text: str, pattern: re.Pattern[str], line: str
) -> tuple[str, bool]:
    match = pattern.search(text)
    if match:
        return text[: match.start()] + f"{match.group('indent')}{line}" + text[
            match.end() :
        ], True
    return text.rstrip() + "\n" + line + "\n", False


def _replace_or_insert_near(
    text: str,
    pattern: re.Pattern[str],
    line: str,
    anchor: re.Pattern[str],
) -> tuple[str, bool]:
    """Replace a top-level setting or add it next to its companion.

    Keeping API transport settings together makes the generated change visible
    where users expect it in config.yaml instead of silently appending it after
    the rules section.
    """

    match = pattern.search(text)
    if match:
        return text[: match.start()] + f"{match.group('indent')}{line}" + text[
            match.end() :
        ], True
    anchor_match = anchor.search(text)
    if anchor_match:
        return text[: anchor_match.start()] + line + "\n" + text[anchor_match.start() :], False
    return text.rstrip() + "\n" + line + "\n", False


def _replace_if_present(
    text: str, pattern: re.Pattern[str], line: str
) -> tuple[str, bool]:
    match = pattern.search(text)
    if not match:
        return text, False
    return text[: match.start()] + f"{match.group('indent')}{line}" + text[
        match.end() :
    ], True


def build_safe_mihomo_config(
    text: str, *, prefer_unix: bool = True
) -> MigrationPreview:
    """Return a preview without exposing/generated secrets.

    Unix sockets remain available for explicit/legacy callers. The protected
    loopback TCP path is selected by the panel by default; its secret is
    generated only during apply.
    """

    original = str(text or "")
    changes: list[str] = []
    if prefer_unix:
        updated, existed = _replace_or_insert_near(
            original,
            _UNIX_RE,
            "external-controller-unix: ./mihomo-api.sock",
            _CONTROLLER_RE,
        )
        if not existed:
            changes.append("Добавить локальный Unix socket Mihomo API")
        updated, existed_tcp = _replace_if_present(
            updated,
            _CONTROLLER_RE,
            "# external-controller отключён: используется Unix socket",
        )
        if existed_tcp:
            changes.append("Закрыть прежний LAN/TCP controller")
        updated, existed_secret = _replace_if_present(
            updated, _SECRET_RE, "# secret не требуется для Unix socket"
        )
        if existed_secret:
            changes.append("Убрать больше не нужный secret")
        return MigrationPreview(updated, "unix", tuple(changes))

    # Do not leave a legacy Unix controller behind: Mihomo prefers the Unix
    # target when both directives are present, which would make the newly
    # protected TCP API appear inactive after migration.
    updated = _UNIX_RE.sub("", original)
    updated = re.sub(
        r"^[ \t]*#[ \t]*(?:external-controller отключён: используется Unix socket|secret не требуется для Unix socket)[ \t]*$\n?",
        "",
        updated,
        flags=re.MULTILINE,
    )
    updated = re.sub(r"\n{3,}", "\n\n", updated)
    updated, existed = _replace_or_insert(
        updated, _CONTROLLER_RE, "external-controller: 127.0.0.1:9090"
    )
    if not existed:
        changes.append("Добавить локальный TCP controller")
    if _SECRET_RE.search(updated):
        updated = _SECRET_RE.sub(
            lambda m: f"{m.group('indent')}secret: __XKEEN_GENERATED_SECRET__",
            updated,
            count=1,
        )
    else:
        updated = updated.rstrip() + "\nsecret: __XKEEN_GENERATED_SECRET__\n"
    changes.append("Сгенерировать непустой secret при применении")
    return MigrationPreview(updated, "tcp-loopback", tuple(changes))


def materialize_generated_secret(text: str) -> str:
    token = secrets.token_urlsafe(24)
    return str(text or "").replace("__XKEEN_GENERATED_SECRET__", token)


__all__ = [
    "MigrationPreview",
    "build_safe_mihomo_config",
    "materialize_generated_secret",
]
