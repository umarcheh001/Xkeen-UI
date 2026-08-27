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

# Top-level settings that conventionally precede the Clash API directives.
# Keeping these in one place gives generated configs a stable, human-friendly
# layout while leaving unrelated sections untouched.
_API_ORDER_ANCHORS = (
    "log-level",
    "allow-lan",
    "redir-port",
    "tproxy-port",
    "routing-mark",
    "find-process-mode",
    "unified-delay",
)


def _top_level_insert(text: str, block: str) -> str:
    source = str(text or "").rstrip() + "\n"
    lines = source.splitlines(keepends=True)
    index = next((i for i, line in enumerate(lines)
                  if line.strip() and not line.lstrip().startswith("#")
                  and line[:1] not in {" ", "\t"}), len(lines))
    return "".join(lines[:index]) + str(block).rstrip("\n") + "\n" + "".join(lines[index:])


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
    return _top_level_insert(text, line), False


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


def _reposition_tcp_directives(text: str, *, secret_line: str) -> str:
    """Place ``external-controller`` and ``secret`` together in the header.

    Older migrations inserted the controller before the first YAML key and
    appended a newly-created secret to EOF.  Besides looking untidy this made
    subsequent round-trips move the two settings farther apart.  Strip only
    top-level API directives, then insert a canonical pair after the standard
    global settings (or before the first setting when no anchor exists).
    """

    source = str(text or "").rstrip() + "\n"
    # Restrict removal to column-zero directives; nested ``secret`` values in
    # proxy/provider definitions must remain intact.
    lines = source.splitlines(keepends=True)
    kept: list[str] = []
    for line in lines:
        if line[:1] in {" ", "\t"}:
            kept.append(line)
            continue
        if re.match(r"^(?:external-controller|external-controller-unix|secret)\s*:", line):
            continue
        kept.append(line)

    # Find the last known global setting.  Inserting after it yields the
    # conventional order shown in the UI (controller, secret, external-ui).
    insert_at = None
    for index, line in enumerate(kept):
        if line[:1] in {" ", "\t"} or not line.strip() or line.lstrip().startswith("#"):
            continue
        key = line.split(":", 1)[0].strip()
        if key in _API_ORDER_ANCHORS:
            insert_at = index + 1
    if insert_at is None:
        insert_at = next(
            (i for i, line in enumerate(kept)
             if line.strip() and not line.lstrip().startswith("#")
             and line[:1] not in {" ", "\t"}),
            len(kept),
        )

    block = ["external-controller: 127.0.0.1:9090\n", f"secret: {secret_line}\n"]
    return "".join(kept[:insert_at] + block + kept[insert_at:])


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
    had_controller = bool(_CONTROLLER_RE.search(updated))
    # Rebuild the pair in a canonical header position.  This deliberately
    # removes/reinserts only top-level directives, preserving nested values.
    updated = _reposition_tcp_directives(
        updated, secret_line="__XKEEN_GENERATED_SECRET__"
    )
    if not had_controller:
        changes.append("Добавить локальный TCP controller")
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
