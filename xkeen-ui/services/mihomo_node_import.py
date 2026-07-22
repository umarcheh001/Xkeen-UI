"""Draft-only Mihomo node import used by native clients.

The importer deliberately returns patched YAML without writing ``config.yaml``.  Saving and
restarting remain explicit editor actions, matching the mobile configuration workflow.
"""

from __future__ import annotations

import re
import urllib.parse
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Mapping, Optional, Sequence

from services.mihomo_proxy_config import apply_proxy_insert
from services.mihomo_proxy_parsers import (
    ProxyParseResult,
    _yaml_str,
    parse_openvpn,
    parse_proxy_uri,
    parse_tailscale,
    parse_wireguard,
)


SUPPORTED_MODES = {"auto", "proxy", "subscription", "wireguard", "openvpn", "tailscale"}
_URL_RE = re.compile(r"^(?:https?://|happ://crypt)", re.IGNORECASE)
_PROXY_NAME_RE = re.compile(r"^(\s*)-\s+name\s*:\s*(.+?)\s*$")
_TOP_LEVEL_KEY_RE = re.compile(r"^(?!\s|#)[A-Za-z0-9_.-]+\s*:")


XraySubscriptionParser = Callable[
    [str, Sequence[str]],
    Optional[tuple[Sequence[ProxyParseResult], int]],
]
ProviderTarget = str | tuple[str, Mapping[str, Any]]
ProviderUrlFactory = Callable[[str], ProviderTarget]


@dataclass(frozen=True)
class MihomoNodeDraftResult:
    content: str
    inserted_names: tuple[str, ...]
    inserted_kind: str
    skipped_count: int
    highlight_start: int
    highlight_end: int


def proxy_group_names(content: str) -> list[str]:
    """Return top-level ``proxy-groups`` names in document order."""
    names: list[str] = []
    in_groups = False
    for line in _normalise(content).splitlines():
        stripped = line.lstrip()
        indent = len(line) - len(stripped)
        if indent == 0 and stripped.startswith("proxy-groups:"):
            in_groups = True
            continue
        if in_groups and indent == 0 and stripped and not stripped.startswith("#"):
            in_groups = False
        if not in_groups:
            continue
        match = _PROXY_NAME_RE.match(line)
        if match:
            name = _normalise_yaml_scalar(match.group(2))
            if name and name not in names:
                names.append(name)
    return names


def proxy_names(content: str) -> list[str]:
    names: list[str] = []
    in_proxies = False
    for line in _normalise(content).splitlines():
        stripped = line.lstrip()
        indent = len(line) - len(stripped)
        if indent == 0 and stripped.startswith("proxies:"):
            in_proxies = True
            continue
        if in_proxies and indent == 0 and stripped and not stripped.startswith("#"):
            in_proxies = False
        if not in_proxies:
            continue
        match = _PROXY_NAME_RE.match(line)
        if match:
            name = _normalise_yaml_scalar(match.group(2))
            if name and name not in names:
                names.append(name)
    return names


def build_mihomo_node_draft(
    *,
    content: str,
    source: str,
    mode: str,
    groups: Iterable[str] = (),
    xray_subscription_parser: XraySubscriptionParser | None = None,
    provider_url_factory: ProviderUrlFactory | None = None,
) -> MihomoNodeDraftResult:
    """Parse node material and insert it into an in-memory Mihomo config draft."""
    config = _normalise(content)
    raw_source = _normalise(source).strip()
    clean_mode = str(mode or "auto").strip().lower() or "auto"
    if clean_mode not in SUPPORTED_MODES:
        raise ValueError("Неизвестный тип импорта Mihomo.")
    if not config.strip():
        raise ValueError("Активный config.yaml пуст.")
    if not raw_source:
        raise ValueError("Вставьте ссылку узла, подписку или конфигурацию.")

    selected_groups = _clean_strings(groups)
    existing_names = proxy_names(config)
    inserted_names: list[str] = []
    inserted_kinds: list[str] = []
    skipped_count = 0

    def insert_proxy(result: ProxyParseResult) -> None:
        nonlocal config
        config = _normalise_patchable_section(config, "proxies")
        name = str(result.name or "").strip()
        yaml = str(result.yaml or "").strip()
        if not name or not yaml:
            raise ValueError("Парсер вернул пустой узел Mihomo.")
        if name in existing_names:
            raise ValueError(f"Узел с именем «{name}» уже существует в config.yaml.")
        config = apply_proxy_insert(config, yaml, name, selected_groups)
        existing_names.append(name)
        inserted_names.append(name)
        inserted_kinds.append("proxy")

    config_mode = clean_mode if clean_mode in {"wireguard", "openvpn", "tailscale"} else (
        _detect_config_mode(raw_source) if clean_mode == "auto" else None
    )
    if config_mode is not None:
        parser = {
            "wireguard": parse_wireguard,
            "openvpn": parse_openvpn,
            "tailscale": parse_tailscale,
        }[config_mode]
        parsed = parser(raw_source)
        unique = _unique_name(parsed.name, existing_names)
        if unique != parsed.name:
            parsed = parser(raw_source, custom_name=unique)
        insert_proxy(parsed)
    else:
        entries = [line.strip() for line in raw_source.splitlines() if line.strip()]
        if not entries:
            raise ValueError("Не найдено данных для импорта.")

        def import_entry(entry: str) -> None:
            nonlocal config, skipped_count
            is_url = bool(_URL_RE.match(entry))
            if clean_mode == "proxy" and is_url:
                raise ValueError("Для ссылки подписки выберите тип «Подписка» или «Авто».")
            if clean_mode == "subscription" and not is_url:
                raise ValueError("В режиме подписки ожидается HTTP(S) или Happ-ссылка.")

            if is_url and clean_mode != "proxy":
                parsed_subscription = (
                    xray_subscription_parser(entry, tuple(existing_names))
                    if xray_subscription_parser is not None
                    else None
                )
                if parsed_subscription is not None:
                    proxies, skipped = parsed_subscription
                    if not proxies:
                        raise ValueError("В подписке не найдено поддерживаемых узлов.")
                    for parsed in proxies:
                        insert_proxy(parsed)
                    skipped_count += max(0, int(skipped or 0))
                    return
                if entry.lower().startswith("happ://"):
                    raise ValueError("Happ-ссылка не содержит распознаваемой Xray-подписки.")
                provider_name = _unique_provider_name(entry, config)
                provider_target = provider_url_factory(entry) if provider_url_factory else entry
                if isinstance(provider_target, tuple):
                    provider_url, provider_headers = provider_target
                else:
                    provider_url, provider_headers = provider_target, {}
                snippet = _provider_yaml(provider_name, provider_url, provider_headers)
                config = _normalise_patchable_section(config, "proxy-providers")
                config = _insert_top_level_section(config, "proxy-providers", snippet)
                inserted_names.append(provider_name)
                inserted_kinds.append("provider")
                return

            parsed = parse_tailscale(entry) if entry.lower().startswith("tailscale://") else parse_proxy_uri(entry)
            unique = _unique_name(parsed.name, existing_names)
            if unique != parsed.name:
                parsed = (
                    parse_tailscale(entry, custom_name=unique)
                    if entry.lower().startswith("tailscale://")
                    else parse_proxy_uri(entry, custom_name=unique)
                )
            insert_proxy(parsed)

        errors: list[Exception] = []
        for entry in entries:
            try:
                import_entry(entry)
            except Exception as exc:
                skipped_count += 1
                errors.append(exc)

        if not inserted_names and errors:
            raise ValueError(str(errors[0]) or "Не удалось распознать данные.") from errors[0]

    if not inserted_names:
        raise ValueError("Не удалось добавить узел в config.yaml.")

    ranges = _inserted_ranges(config, inserted_names, inserted_kinds)
    kind = inserted_kinds[0] if len(set(inserted_kinds)) == 1 else "mixed"
    if kind == "mixed" and ranges:
        start, end = ranges[-1]
    else:
        start = min((item[0] for item in ranges), default=0)
        end = max((item[1] for item in ranges), default=min(len(config), start + 1))
    return MihomoNodeDraftResult(
        content=config,
        inserted_names=tuple(inserted_names),
        inserted_kind=kind,
        skipped_count=skipped_count,
        highlight_start=start,
        highlight_end=end,
    )


def _normalise(value: str) -> str:
    return str(value or "").replace("\r\n", "\n").replace("\r", "\n")


def _normalise_patchable_section(content: str, key: str) -> str:
    """Make empty/commented section headers patchable and reject non-empty flow style."""
    source = _normalise(content)
    pattern = re.compile(rf"^{re.escape(key)}[ \t]*:[ \t]*(.*?)[ \t]*$", re.MULTILINE)
    match = pattern.search(source)
    if match is None:
        return source
    tail = str(match.group(1) or "").strip()
    if not tail:
        return source
    empty_flow = re.fullmatch(r"(?:\[\]|\{\}|null|~)[ \t]*(#.*)?", tail)
    if empty_flow:
        comment = str(empty_flow.group(1) or "").strip()
        replacement = f"{key}:" + (f"\n  {comment}" if comment else "")
        return source[: match.start()] + replacement + source[match.end() :]
    if tail.startswith("#"):
        replacement = f"{key}:\n  {tail}"
        return source[: match.start()] + replacement + source[match.end() :]
    raise ValueError(
        f"Секция {key} использует непустой компактный YAML. "
        "Разверните её в блочный формат перед импортом узла."
    )


def _detect_config_mode(source: str) -> str | None:
    text = str(source or "")
    low = text.lower()
    if "[interface]" in low and "[peer]" in low:
        return "wireguard"
    if re.search(r"(?m)^\s*client\s*$", low) and re.search(r"(?m)^\s*remote\s+\S+", low):
        return "openvpn"
    if not re.search(r"(?mi)^\s*(?:vless|trojan|vmess|ss|hy2|hysteria2?)://", text) and (
        re.search(r"(?mi)^\s*auth-key\s*[:=]", text)
        or re.search(r"(?mi)^\s*state-dir\s*[:=]", text)
    ):
        return "tailscale"
    return None


def _clean_strings(values: Iterable[str]) -> list[str]:
    out: list[str] = []
    for value in values:
        item = str(value or "").strip()
        if item and item not in out:
            out.append(item)
    return out


def _normalise_yaml_scalar(value: str) -> str:
    text = str(value or "").strip()
    if " #" in text:
        text = text.split(" #", 1)[0].rstrip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in {"'", '"'}:
        text = text[1:-1]
    return text.replace("''", "'")


def _unique_name(base: str, existing: Sequence[str]) -> str:
    clean = str(base or "PROXY").strip() or "PROXY"
    if clean not in existing:
        return clean
    stem = re.sub(r"_\d+$", "", clean).strip() or "PROXY"
    suffix = 2
    while f"{stem}_{suffix}" in existing:
        suffix += 1
    return f"{stem}_{suffix}"


def _sanitise_provider_name(value: str) -> str:
    clean = re.sub(r"[^A-Za-z0-9._-]+", "_", str(value or "").strip())
    clean = re.sub(r"_+", "_", clean).strip("._-")
    return clean[:64]


def _unique_provider_name(url: str, content: str) -> str:
    parsed = urllib.parse.urlparse(url)
    base = _sanitise_provider_name(parsed.hostname or "subscription") or "subscription"
    existing = set(
        match.group(1)
        for match in re.finditer(r"^\s{2}([A-Za-z0-9._-]+)\s*:\s*(?:#.*)?$", content, re.MULTILINE)
    )
    if base not in existing:
        return base
    suffix = 2
    while f"{base}_{suffix}" in existing:
        suffix += 1
    return f"{base}_{suffix}"


def _provider_yaml(name: str, url: str, headers: Mapping[str, Any] | None = None) -> str:
    lines = [
        f"  {name}:",
        "    type: http",
        f"    url: {_yaml_str(url)}",
        "    interval: 43200",
        f"    path: {_yaml_str(f'./proxy_providers/{name}.yaml')}",
    ]
    clean_headers: list[tuple[str, list[str]]] = []
    for key, raw_values in (headers or {}).items():
        clean_key = str(key or "").strip()
        if not re.fullmatch(r"[A-Za-z0-9-]+", clean_key):
            continue
        values = raw_values if isinstance(raw_values, (list, tuple, set)) else [raw_values]
        clean_values = [str(value or "").strip() for value in values if str(value or "").strip()]
        if clean_values:
            clean_headers.append((clean_key, clean_values))
    if clean_headers:
        lines.append("    header:")
        for key, values in clean_headers:
            lines.append(f"      {key}:")
            lines.extend(f"        - {_yaml_str(value)}" for value in values)
    lines.extend(
        [
            "    health-check:",
            "      enable: true",
            "      url: https://www.gstatic.com/generate_204",
            "      interval: 300",
            "      expected-status: 204",
            "    override:",
            "      udp: true",
            "      tfo: true",
        ]
    )
    return "\n".join(lines)


def _insert_top_level_section(content: str, key: str, snippet: str) -> str:
    source = _normalise(content)
    if not source.endswith("\n"):
        source += "\n"
    source = re.sub(
        rf"^({re.escape(key)}[ \t]*:)[ \t]*(?:\[\]|\{{\}}|null|~)?[ \t]*(#.*)?$",
        lambda match: f"{key}:{(' ' + match.group(2).strip()) if match.group(2) else ''}",
        source,
        flags=re.MULTILINE,
    )
    lines = source.splitlines()
    section_index = next((idx for idx, line in enumerate(lines) if line.startswith(f"{key}:")), None)
    snippet_lines = snippet.rstrip("\n").splitlines()
    if section_index is None:
        while lines and not lines[-1].strip():
            lines.pop()
        if lines:
            lines.append("")
        lines.extend([f"{key}:", *snippet_lines])
        return "\n".join(lines).rstrip("\n") + "\n"

    section_end = len(lines)
    for idx in range(section_index + 1, len(lines)):
        if _TOP_LEVEL_KEY_RE.match(lines[idx]):
            section_end = idx
            break
    insert_at = section_end
    while insert_at > section_index + 1 and not lines[insert_at - 1].strip():
        insert_at -= 1
    if insert_at > section_index + 1:
        snippet_lines.insert(0, "")
    if insert_at < len(lines) and lines[insert_at].strip():
        snippet_lines.append("")
    lines[insert_at:insert_at] = snippet_lines
    return "\n".join(lines).rstrip("\n") + "\n"


def _inserted_ranges(content: str, names: Sequence[str], kinds: Sequence[str]) -> list[tuple[int, int]]:
    lines = content.splitlines(keepends=True)
    offsets: list[int] = []
    cursor = 0
    for line in lines:
        offsets.append(cursor)
        cursor += len(line)
    ranges: list[tuple[int, int]] = []
    for name, kind in zip(names, kinds):
        if kind == "provider":
            pattern = re.compile(rf"^\s{{2}}{re.escape(name)}\s*:\s*$")
            start_line = next((idx for idx, line in enumerate(lines) if pattern.match(line.rstrip("\n"))), None)
        else:
            start_line = next(
                (
                    idx
                    for idx, line in enumerate(lines)
                    if (match := _PROXY_NAME_RE.match(line.rstrip("\n")))
                    and _normalise_yaml_scalar(match.group(2)) == name
                ),
                None,
            )
        if start_line is None:
            continue
        indent = len(lines[start_line]) - len(lines[start_line].lstrip())
        end_line = len(lines)
        for idx in range(start_line + 1, len(lines)):
            stripped = lines[idx].lstrip()
            current_indent = len(lines[idx]) - len(stripped)
            if not stripped.strip() or stripped.startswith("#"):
                continue
            if current_indent < indent or (
                current_indent == indent and (stripped.startswith("- name:") or kind == "provider")
            ):
                end_line = idx
                break
        start = offsets[start_line]
        end = offsets[end_line] if end_line < len(offsets) else len(content)
        ranges.append((start, max(start + 1, end)))
    return ranges


__all__ = [
    "MihomoNodeDraftResult",
    "SUPPORTED_MODES",
    "build_mihomo_node_draft",
    "proxy_group_names",
    "proxy_names",
]
