"""Bounded, read-only inspector for Mihomo rule-provider content.

The browser selects a provider by name only.  Paths and inline payload are
resolved from the active Mihomo config and never accepted from request input.
"""

from __future__ import annotations

import hashlib
import os
import re
import selectors
import shutil
import stat
import subprocess
import tempfile
import threading
import time
from collections import OrderedDict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    import yaml as _yaml
except Exception:  # pragma: no cover - optional on router images
    _yaml = None


SCHEMA_VERSION = 1
MAX_CONFIG_BYTES = 2 * 1024 * 1024
MAX_PROVIDER_FILE_BYTES = 16 * 1024 * 1024
MAX_CONVERTED_BYTES = 8 * 1024 * 1024
MAX_RULES = 20_000
MAX_RETURNED_ROWS = 500
MAX_QUERY_CHARS = 256
MAX_RULE_CHARS = 4096
MAX_YAML_NODES = 50_000
MAX_YAML_ALIASES = 1_000
MAX_CACHE_ENTRIES = 8
CONVERT_TIMEOUT_SECONDS = 12
_ALLOWED_FORMATS = {"yaml", "text", "mrs"}
_ALLOWED_BEHAVIORS = {"domain", "ipcidr", "classical"}
_ALLOWED_TYPES = {"file", "http", "inline"}


class RuleProviderInspectorError(RuntimeError):
    """Safe product error raised by the inspector service."""

    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


@dataclass(frozen=True)
class _ProviderSpec:
    name: str
    provider_type: str
    behavior: str
    format: str
    payload: tuple[str, ...]
    path: Path | None


@dataclass(frozen=True)
class _CachedRules:
    rules: tuple[str, ...]
    total_rules: int
    source_truncated: bool
    size_bytes: int
    mtime_ns: int | None


_cache: OrderedDict[tuple[Any, ...], _CachedRules] = OrderedDict()
_cache_lock = threading.Lock()
_mrs_converter_lock = threading.Lock()


def clear_rule_provider_inspector_cache() -> None:
    with _cache_lock:
        _cache.clear()


def _read_bounded(
    path: Path,
    limit: int,
    *,
    code: str,
    no_follow: bool = False,
    expected_stat: os.stat_result | None = None,
) -> bytes:
    """Read at most ``limit`` bytes, optionally refusing a final symlink.

    Provider paths have already been confined to the Mihomo root.  Opening the
    resolved file with ``O_NOFOLLOW`` also closes the symlink-swap window
    between validation and reading.
    """

    descriptor = -1
    try:
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
        if no_follow:
            flags |= getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
        info = os.fstat(descriptor)
        if no_follow and not stat.S_ISREG(info.st_mode):
            raise RuleProviderInspectorError("provider_path_blocked", "Rule-provider должен быть обычным файлом.", 403)
        if expected_stat is not None and (info.st_dev, info.st_ino) != (expected_stat.st_dev, expected_stat.st_ino):
            raise RuleProviderInspectorError(
                "provider_file_changed",
                "Rule-provider изменился во время чтения. Повторите попытку.",
                409,
            )
        if info.st_size > limit:
            raise RuleProviderInspectorError(code, "Файл rule-provider слишком большой.", 413)
        with os.fdopen(descriptor, "rb") as stream:
            descriptor = -1
            payload = stream.read(limit + 1)
    except RuleProviderInspectorError:
        raise
    except FileNotFoundError as exc:
        raise RuleProviderInspectorError("provider_file_missing", "Файл rule-provider ещё не создан.", 404) from exc
    except OSError as exc:
        raise RuleProviderInspectorError("provider_file_unreadable", "Не удалось прочитать rule-provider.", 409) from exc
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    if len(payload) > limit:
        raise RuleProviderInspectorError(code, "Файл rule-provider слишком большой.", 413)
    return payload


def _load_config(config_file: str) -> Mapping[str, Any]:
    raw = _read_bounded(Path(config_file), MAX_CONFIG_BYTES, code="config_too_large")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise RuleProviderInspectorError("config_invalid", "Активный config.yaml не удалось разобрать.", 409) from exc
    if _yaml is None:
        return {"rule-providers": _fallback_rule_provider_specs(text)}
    try:
        parsed = _safe_load_yaml(text)
    except (UnicodeDecodeError, ValueError, TypeError) as exc:
        raise RuleProviderInspectorError("config_invalid", "Активный config.yaml не удалось разобрать.", 409) from exc
    except Exception as exc:
        raise RuleProviderInspectorError("config_invalid", "Активный config.yaml не удалось разобрать.", 409) from exc
    return parsed if isinstance(parsed, Mapping) else {}


def _display_scalar(value: Any) -> str:
    text = str(value or "").strip()
    if " #" in text:
        text = text.split(" #", 1)[0].rstrip()
    if len(text) >= 2 and text[:1] == text[-1:] and text[:1] in {"'", '"'}:
        quote = text[:1]
        text = text[1:-1]
        if quote == "'":
            text = text.replace("''", "'")
    return text.strip()


def _flow_parts(value: str) -> list[str]:
    """Split a small YAML flow collection without implementing YAML itself."""

    parts: list[str] = []
    start = 0
    depth = 0
    quote = ""
    escaped = False
    for index, char in enumerate(value):
        if quote:
            if quote == '"' and char == "\\" and not escaped:
                escaped = True
                continue
            if char == quote and not escaped:
                quote = ""
            escaped = False
            continue
        if char in {"'", '"'}:
            quote = char
        elif char in "[{(":
            depth += 1
        elif char in "]})":
            depth = max(0, depth - 1)
        elif char == "," and depth == 0:
            parts.append(value[start:index].strip())
            start = index + 1
    parts.append(value[start:].strip())
    return [part for part in parts if part]


def _flow_mapping(value: str) -> dict[str, Any]:
    text = str(value or "").strip()
    if text.startswith("{") and text.endswith("}"):
        text = text[1:-1]
    result: dict[str, Any] = {}
    for part in _flow_parts(text):
        key, separator, raw_value = part.partition(":")
        if not separator:
            continue
        key = _display_scalar(key)
        raw_value = raw_value.strip()
        if raw_value.startswith("[") and raw_value.endswith("]"):
            result[key] = [_display_scalar(item) for item in _flow_parts(raw_value[1:-1])]
        else:
            result[key] = _display_scalar(raw_value)
    return result


def _fallback_rule_provider_specs(text: str) -> dict[str, dict[str, Any]]:
    """Extract rule-provider specs when PyYAML is absent on small routers.

    This intentionally understands only the bounded scalar/flow subset used by
    Mihomo provider configuration.  It resolves local merge anchors, but never
    interprets arbitrary YAML tags or constructs objects.
    """

    lines = str(text or "").replace("\r\n", "\n").replace("\r", "\n").splitlines()
    anchors: dict[str, dict[str, Any]] = {}
    anchor_pattern = re.compile(r"&([A-Za-z0-9_.-]+)\s*(\{.*\})\s*(?:#.*)?$")
    for line in lines:
        match = anchor_pattern.search(line)
        if match:
            anchors[match.group(1)] = _flow_mapping(match.group(2))

    providers: dict[str, dict[str, Any]] = {}
    in_section = False
    section_indent = -1
    current: dict[str, Any] | None = None
    current_indent = -1
    payload_indent = -1
    for raw_line in lines:
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(raw_line) - len(raw_line.lstrip(" "))
        if not in_section:
            if re.match(r"^\s*rule-providers\s*:\s*(?:#.*)?$", raw_line):
                in_section = True
                section_indent = indent
            continue
        if indent <= section_indent:
            break

        provider_match = re.match(r"^([^:#][^:]*)\s*:\s*(.*)$", stripped)
        if indent == section_indent + 2 and provider_match:
            name = _display_scalar(provider_match.group(1))
            remainder = provider_match.group(2).strip()
            current = {}
            current_indent = indent
            payload_indent = -1
            if remainder.startswith("{"):
                flow = _flow_mapping(remainder.split(" #", 1)[0])
                merge = str(flow.pop("<<", ""))
                if merge.startswith("*"):
                    current.update(anchors.get(merge[1:], {}))
                current.update(flow)
            providers[name] = current
            continue
        if current is None or indent <= current_indent:
            continue
        if payload_indent >= 0 and indent > payload_indent and stripped.startswith("-"):
            current.setdefault("payload", []).append(_display_scalar(stripped[1:]))
            continue
        pair = re.match(r"^([A-Za-z0-9_<>=.-]+)\s*:\s*(.*?)\s*$", stripped)
        if not pair:
            continue
        key, raw_value = pair.group(1), pair.group(2)
        raw_value = raw_value.split(" #", 1)[0].strip()
        if key == "payload" and not raw_value:
            current["payload"] = []
            payload_indent = indent
            continue
        if key == "<<" and raw_value.startswith("*"):
            merged = dict(anchors.get(raw_value[1:], {}))
            merged.update(current)
            current.clear()
            current.update(merged)
        elif raw_value.startswith("[") and raw_value.endswith("]"):
            current[key] = [_display_scalar(item) for item in _flow_parts(raw_value[1:-1])]
        else:
            current[key] = _display_scalar(raw_value)
    return providers


def _safe_load_yaml(text: str) -> Any:
    if _yaml is None:
        raise RuleProviderInspectorError("yaml_parser_unavailable", "На роутере нет YAML parser.", 503)

    class _BoundedSafeLoader(_yaml.SafeLoader):
        def __init__(self, stream: str):
            super().__init__(stream)
            self._xkeen_nodes = 0
            self._xkeen_aliases = 0

        def compose_node(self, parent: Any, index: Any) -> Any:
            if self.check_event(_yaml.AliasEvent):
                self._xkeen_aliases += 1
                if self._xkeen_aliases > MAX_YAML_ALIASES:
                    raise ValueError("too many YAML aliases")
            else:
                self._xkeen_nodes += 1
                if self._xkeen_nodes > MAX_YAML_NODES:
                    raise ValueError("too many YAML nodes")
            return super().compose_node(parent, index)

    return _yaml.load(text, Loader=_BoundedSafeLoader)


def _safe_root(root: str) -> Path:
    try:
        resolved = Path(root).expanduser().resolve(strict=True)
    except OSError as exc:
        raise RuleProviderInspectorError("mihomo_root_missing", "Каталог Mihomo недоступен.", 503) from exc
    if not resolved.is_dir():
        raise RuleProviderInspectorError("mihomo_root_missing", "Каталог Mihomo недоступен.", 503)
    return resolved


def _safe_provider_path(root: Path, configured: Any) -> Path:
    value = str(configured or "").strip()
    if not value or "\x00" in value:
        raise RuleProviderInspectorError("provider_path_missing", "Путь rule-provider не задан.", 409)
    candidate = Path(value).expanduser()
    if not candidate.is_absolute():
        candidate = root / candidate
    try:
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(root)
    except (OSError, ValueError) as exc:
        raise RuleProviderInspectorError(
            "provider_path_blocked",
            "Путь rule-provider находится вне каталога Mihomo или небезопасен.",
            403,
        ) from exc
    try:
        mode = resolved.stat().st_mode
    except OSError as exc:
        raise RuleProviderInspectorError("provider_file_missing", "Файл rule-provider ещё не создан.", 404) from exc
    if not stat.S_ISREG(mode):
        raise RuleProviderInspectorError("provider_path_blocked", "Rule-provider должен быть обычным файлом.", 403)
    return resolved


def _provider_spec(config_file: str, mihomo_root: str, provider_name: str) -> _ProviderSpec:
    name = str(provider_name or "").strip()
    if not name or len(name) > 256 or any(ord(char) < 32 for char in name):
        raise RuleProviderInspectorError("invalid_provider", "Некорректный rule-provider.", 400)
    config = _load_config(config_file)
    providers = config.get("rule-providers")
    entry = providers.get(name) if isinstance(providers, Mapping) else None
    if not isinstance(entry, Mapping):
        raise RuleProviderInspectorError("provider_not_found", "Rule-provider отсутствует в активном config.yaml.", 404)
    provider_type = str(entry.get("type") or "http").strip().lower()
    behavior = str(entry.get("behavior") or "classical").strip().lower()
    format_name = str(entry.get("format") or "yaml").strip().lower()
    if provider_type not in _ALLOWED_TYPES or behavior not in _ALLOWED_BEHAVIORS or format_name not in _ALLOWED_FORMATS:
        raise RuleProviderInspectorError("provider_unsupported", "Формат rule-provider не поддерживается инспектором.", 409)
    if format_name == "mrs" and behavior == "classical":
        raise RuleProviderInspectorError("provider_unsupported", "MRS поддерживает только domain и ipcidr.", 409)
    payload_value = entry.get("payload")
    payload = tuple(
        _rule_text(item)
        for item in payload_value[: MAX_RULES + 1]
        if isinstance(item, (str, int, float)) and not isinstance(item, bool)
    ) if isinstance(payload_value, Sequence) and not isinstance(payload_value, (str, bytes, bytearray)) else ()
    path = None
    if provider_type != "inline":
        configured_path = entry.get("path")
        if not str(configured_path or "").strip() and provider_type == "http":
            url = str(entry.get("url") or "")
            configured_path = f"rules/{hashlib.md5(url.encode('utf-8')).hexdigest()}"
        path = _safe_provider_path(_safe_root(mihomo_root), configured_path)
    return _ProviderSpec(name, provider_type, behavior, format_name, payload, path)


def _rule_text(value: Any) -> str:
    rule = str(value).strip()
    if len(rule) > MAX_RULE_CHARS:
        raise RuleProviderInspectorError(
            "provider_rule_too_long",
            "Rule-provider содержит с��року, превышающую безопасный лимит.",
            413,
        )
    return rule


def _parse_text(data: bytes) -> list[str]:
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise RuleProviderInspectorError("provider_encoding_invalid", "Rule-provider не является UTF-8 текстом.", 409) from exc
    rules: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith(("#", "//")):
            continue
        rules.append(_rule_text(stripped))
        if len(rules) > MAX_RULES:
            break
    return rules


def _parse_yaml(data: bytes) -> list[str]:
    if _yaml is None:
        raise RuleProviderInspectorError("yaml_parser_unavailable", "На роутере нет YAML parser.", 503)
    try:
        parsed = _safe_load_yaml(data.decode("utf-8-sig"))
    except Exception as exc:
        raise RuleProviderInspectorError("provider_yaml_invalid", "YAML rule-provider не удалось разобрать.", 409) from exc
    if isinstance(parsed, Mapping):
        parsed = parsed.get("payload") if parsed.get("payload") is not None else parsed.get("rules")
    if not isinstance(parsed, Sequence) or isinstance(parsed, (str, bytes, bytearray)):
        raise RuleProviderInspectorError("provider_yaml_invalid", "В YAML rule-provider нет списка payload/rules.", 409)
    rules: list[str] = []
    for item in parsed:
        if not isinstance(item, (str, int, float)) or isinstance(item, bool):
            continue
        rule = _rule_text(item)
        if not rule:
            continue
        rules.append(rule)
        if len(rules) > MAX_RULES:
            break
    return rules


def _mihomo_binary(explicit: str | None) -> str:
    candidates = [explicit, os.environ.get("MIHOMO_BIN"), "/opt/sbin/mihomo", "/opt/bin/mihomo", shutil.which("mihomo")]
    for candidate in candidates:
        if candidate and Path(candidate).is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    raise RuleProviderInspectorError("mrs_converter_unavailable", "Для просмотра MRS не найден исполняемый файл Mihomo.", 503)


def _stop_converter(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=1)


def _convert_mrs_bounded(binary: str, behavior: str, input_path: Path, output_pipe: Path) -> bytes:
    """Decode MRS through a bounded FIFO, never an unbounded output file."""

    descriptor = os.open(output_pipe, os.O_RDWR | os.O_NONBLOCK)
    process: subprocess.Popen[bytes] | None = None
    selector = selectors.DefaultSelector()
    chunks: list[bytes] = []
    total = 0
    deadline = time.monotonic() + CONVERT_TIMEOUT_SECONDS
    try:
        selector.register(descriptor, selectors.EVENT_READ)
        process = subprocess.Popen(
            [binary, "convert-ruleset", behavior, "mrs", str(input_path), str(output_pipe)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env={"PATH": os.environ.get("PATH", "")},
        )
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                _stop_converter(process)
                raise RuleProviderInspectorError(
                    "mrs_conversion_timeout",
                    "Декодирование MRS превысило лимит времени.",
                    504,
                )
            for _key, _events in selector.select(min(0.05, remaining)):
                while True:
                    try:
                        chunk = os.read(descriptor, 64 * 1024)
                    except BlockingIOError:
                        break
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_CONVERTED_BYTES:
                        _stop_converter(process)
                        raise RuleProviderInspectorError(
                            "mrs_output_too_large",
                            "Декодированный MRS превышает безопасный лимит.",
                            413,
                        )
                    chunks.append(chunk)
            returncode = process.poll()
            if returncode is None:
                continue
            while True:
                try:
                    chunk = os.read(descriptor, 64 * 1024)
                except BlockingIOError:
                    break
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_CONVERTED_BYTES:
                    raise RuleProviderInspectorError(
                        "mrs_output_too_large",
                        "Декодированный MRS превышает безопасный лимит.",
                        413,
                    )
                chunks.append(chunk)
            if returncode != 0:
                raise RuleProviderInspectorError("mrs_conversion_failed", "MRS rule-provider не удалось декодировать.", 409)
            return b"".join(chunks)
    finally:
        selector.close()
        os.close(descriptor)
        if process is not None and process.poll() is None:
            _stop_converter(process)


def _parse_mrs(
    path: Path,
    behavior: str,
    mihomo_binary: str | None,
    expected_stat: os.stat_result,
) -> list[str]:
    if not _mrs_converter_lock.acquire(timeout=1):
        raise RuleProviderInspectorError(
            "mrs_converter_busy",
            "Другой MRS rule-provider уже декодируется. Повторите попытку.",
            429,
        )
    try:
        binary = _mihomo_binary(mihomo_binary)
        # Convert a bounded snapshot rather than handing the configured path to a
        # child process. Both input and output live in an automatically removed
        # private directory and no command shell is involved.
        source = _read_bounded(
            path,
            MAX_PROVIDER_FILE_BYTES,
            code="provider_file_too_large",
            no_follow=True,
            expected_stat=expected_stat,
        )
        with tempfile.TemporaryDirectory(prefix="xkeen-mrs-") as directory:
            input_path = Path(directory) / "provider.mrs"
            output_pipe = Path(directory) / "rules.pipe"
            descriptor = os.open(input_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(source)
            os.mkfifo(output_pipe, 0o600)
            data = _convert_mrs_bounded(binary, behavior, input_path, output_pipe)
    except RuleProviderInspectorError:
        raise
    except OSError as exc:
        raise RuleProviderInspectorError("mrs_converter_unavailable", "Не удалось запустить Mihomo для просмотра MRS.", 503) from exc
    finally:
        _mrs_converter_lock.release()
    return _parse_text(data)


def _cache_get(key: tuple[Any, ...]) -> _CachedRules | None:
    with _cache_lock:
        value = _cache.get(key)
        if value is not None:
            _cache.move_to_end(key)
        return value


def _cache_put(key: tuple[Any, ...], value: _CachedRules) -> None:
    with _cache_lock:
        _cache[key] = value
        _cache.move_to_end(key)
        while len(_cache) > MAX_CACHE_ENTRIES:
            _cache.popitem(last=False)


def _load_rules(spec: _ProviderSpec, mihomo_binary: str | None) -> tuple[_CachedRules, bool]:
    if spec.provider_type == "inline":
        raw_rules = list(spec.payload)
        digest = hashlib.sha256("\0".join(spec.payload).encode("utf-8", "replace")).hexdigest()
        key = ("inline", spec.name, spec.behavior, spec.format, digest)
        cached = _cache_get(key)
        if cached is not None:
            return cached, True
        size_bytes = sum(len(item.encode("utf-8", "replace")) for item in raw_rules)
        mtime_ns = None
    else:
        assert spec.path is not None
        try:
            info = spec.path.stat()
        except OSError as exc:
            raise RuleProviderInspectorError("provider_file_missing", "Файл rule-provider ещё не создан.", 404) from exc
        key = (str(spec.path), info.st_mtime_ns, info.st_size, spec.behavior, spec.format)
        cached = _cache_get(key)
        if cached is not None:
            return cached, True
        size_bytes = info.st_size
        mtime_ns = info.st_mtime_ns
        if spec.format == "mrs":
            raw_rules = _parse_mrs(spec.path, spec.behavior, mihomo_binary, info)
        else:
            data = _read_bounded(
                spec.path,
                MAX_PROVIDER_FILE_BYTES,
                code="provider_file_too_large",
                no_follow=True,
                expected_stat=info,
            )
            raw_rules = _parse_yaml(data) if spec.format == "yaml" else _parse_text(data)
    total = len(raw_rules)
    bounded = tuple(raw_rules[:MAX_RULES])
    value = _CachedRules(bounded, total, total > MAX_RULES, size_bytes, mtime_ns)
    _cache_put(key, value)
    return value, False


def inspect_rule_provider(
    *,
    config_file: str,
    mihomo_root: str,
    provider_name: str,
    query: str = "",
    limit: int = 200,
    offset: int = 0,
    mihomo_binary: str | None = None,
) -> dict[str, Any]:
    """Return one bounded page of provider rules and no filesystem path."""

    needle = str(query or "").strip()
    if len(needle) > MAX_QUERY_CHARS:
        raise RuleProviderInspectorError("query_too_long", "Поисковый запрос слишком длинный.", 400)
    try:
        page_limit = max(1, min(MAX_RETURNED_ROWS, int(limit)))
        page_offset = max(0, int(offset))
    except (TypeError, ValueError, OverflowError) as exc:
        raise RuleProviderInspectorError("invalid_pagination", "Некорректные параметры страницы.", 400) from exc
    spec = _provider_spec(config_file, mihomo_root, provider_name)
    cached, cache_hit = _load_rules(spec, mihomo_binary)
    normalized = needle.casefold()
    matches = [rule for rule in cached.rules if not normalized or normalized in rule.casefold()]
    page = matches[page_offset : page_offset + page_limit]
    return {
        "ok": True,
        "schema_version": SCHEMA_VERSION,
        "provider": {
            "name": spec.name,
            "type": spec.provider_type,
            "behavior": spec.behavior,
            "format": "inline" if spec.provider_type == "inline" else spec.format,
        },
        "rules": page,
        "query": needle,
        "offset": page_offset,
        "limit": page_limit,
        "total_rules": cached.total_rules,
        "matched_rules": len(matches),
        "truncated": cached.source_truncated or page_offset + len(page) < len(matches),
        "cache": {"hit": cache_hit, "key": "inline" if cached.mtime_ns is None else "mtime"},
        "source": {"size_bytes": cached.size_bytes, "mtime_ns": cached.mtime_ns},
    }
