"""Read-only, explainable diagnostics for the Mihomo Clash facade."""

from __future__ import annotations

import ipaddress
import re
from collections.abc import Callable, Mapping, Sequence
from typing import Any


MAX_TRACE_RULES = 5000
MAX_TRACE_STEPS = 250
MAX_TRACE_CHAIN = 32
RuleSetMatcher = Callable[[str, str, Sequence[str]], tuple[str, str]]


def normalize_trace_domain(value: Any) -> str:
    """Normalize a user-entered host without accepting a URL or path."""

    if not isinstance(value, str):
        raise ValueError("domain_invalid")
    domain = value.strip().lower().rstrip(".")
    domain = re.sub(r"^[a-z][a-z0-9+.-]*://", "", domain)
    domain = domain.split("/", 1)[0]
    if ":" in domain and domain.count(":") == 1:
        domain = domain.rsplit(":", 1)[0]
    if not domain or len(domain) > 253 or any(ord(char) < 32 or char.isspace() for char in domain):
        raise ValueError("domain_invalid")
    labels = domain.split(".")
    if any(
        not label
        or len(label) > 63
        or label.startswith("-")
        or label.endswith("-")
        or not all(char.isalnum() or char == "-" or ord(char) >= 128 for char in label)
        for label in labels
    ):
        raise ValueError("domain_invalid")
    try:
        "".join(label.encode("idna").decode("ascii") for label in labels)
    except (UnicodeError, UnicodeEncodeError) as exc:
        raise ValueError("domain_invalid") from exc
    return domain


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _text(value: Any, limit: int = 256) -> str:
    if value is None or isinstance(value, (dict, list, tuple, set, bool)):
        return ""
    return str(value).replace("\x00", "").strip()[:limit]


def _answers(payload: Any) -> list[str]:
    raw = _mapping(payload).get("Answer")
    if raw is None:
        raw = _mapping(payload).get("answer")
    if not isinstance(raw, Sequence) or isinstance(raw, (str, bytes, bytearray)):
        return []
    result: list[str] = []
    for item in list(raw)[:64]:
        row = _mapping(item)
        value = _text(row.get("data") or row.get("Data"), 128)
        if value:
            try:
                result.append(str(ipaddress.ip_address(value)))
            except ValueError:
                continue
    return list(dict.fromkeys(result))


def _rule_parts(rule: Mapping[str, Any]) -> tuple[str, str, str]:
    raw_type = _text(rule.get("type"), 96)
    compact_type = re.sub(r"[^A-Z0-9]", "", raw_type.upper())
    rule_type = {
        "DOMAIN": "DOMAIN",
        "DOMAINSUFFIX": "DOMAIN-SUFFIX",
        "DOMAINSUFFIX6": "DOMAIN-SUFFIX6",
        "DOMAINKEYWORD": "DOMAIN-KEYWORD",
        "IPCIDR": "IP-CIDR",
        "IPCIDR6": "IP-CIDR6",
        "GEOIP": "GEOIP",
        "RULESET": "RULE-SET",
        "OR": "OR",
        "AND": "AND",
        "MATCH": "MATCH",
    }.get(compact_type, raw_type.upper().replace("_", "-"))
    payload = _text(rule.get("payload"), 1024)
    target = _text(rule.get("proxy") or rule.get("target"), 256) or "MATCH"
    return rule_type, payload, target


def _ip_matches(addresses: Sequence[str], payload: str) -> bool:
    try:
        network = ipaddress.ip_network(payload, strict=False)
    except ValueError:
        return False
    return any(
        ipaddress.ip_address(address) in network
        for address in addresses
        if address
    )


def _strip_outer_parentheses(value: str) -> str:
    text = str(value or "").strip()
    while text.startswith("(") and text.endswith(")"):
        depth = 0
        enclosed = True
        for index, char in enumerate(text):
            if char == "(":
                depth += 1
            elif char == ")":
                depth -= 1
                if depth == 0 and index != len(text) - 1:
                    enclosed = False
                    break
            if depth < 0:
                enclosed = False
                break
        if not enclosed or depth != 0:
            break
        text = text[1:-1].strip()
    return text


def _split_top_level(value: str, separator: str) -> list[str]:
    parts: list[str] = []
    start = 0
    depth = 0
    quote = ""
    for index, char in enumerate(value):
        if quote:
            if char == quote:
                quote = ""
            continue
        if char in {"'", '"'}:
            quote = char
        elif char == "(":
            depth += 1
        elif char == ")" and depth:
            depth -= 1
        elif depth == 0 and value.startswith(separator, index):
            parts.append(value[start:index].strip())
            start = index + len(separator)
    parts.append(value[start:].strip())
    return [part for part in parts if part]


def _combine_results(operator: str, results: Sequence[tuple[str, str]]) -> tuple[str, str]:
    if operator == "OR":
        if any(result == "match" for result, _reason in results):
            return "match", "Одно из условий составного правила совпало."
        if any(result == "unknown" for result, _reason in results):
            return "unknown", "Часть условий составного правила нельзя безопасно вычислить."
        return "skip", "Условия составного правила не совпали."
    if any(result == "skip" for result, _reason in results):
        return "skip", "Одно из условий составного правила не совпало."
    if any(result == "unknown" for result, _reason in results):
        return "unknown", "Часть условий составного правила нельзя безопасно вычислить."
    return "match", "Все условия составного правила совпали."


def _evaluate_expression(
    expression: str,
    domain: str,
    addresses: Sequence[str],
    rule_set_matcher: RuleSetMatcher | None,
) -> tuple[str, str]:
    value = _strip_outer_parentheses(expression)
    for separator, operator in (("||", "OR"), ("&&", "AND")):
        parts = _split_top_level(value, separator)
        if len(parts) > 1:
            return _combine_results(
                operator,
                [_evaluate_expression(part, domain, addresses, rule_set_matcher) for part in parts],
            )
    parts = _split_top_level(value, ",")
    if not parts:
        return "unknown", "Составное правило не содержит условий."
    raw_type = parts[0]
    payload = parts[1] if len(parts) > 1 else ""
    compact_type = re.sub(r"[^A-Z0-9]", "", raw_type.upper())
    rule_type = {
        "DOMAIN": "DOMAIN",
        "DOMAINSUFFIX": "DOMAIN-SUFFIX",
        "DOMAINSUFFIX6": "DOMAIN-SUFFIX6",
        "DOMAINKEYWORD": "DOMAIN-KEYWORD",
        "IPCIDR": "IP-CIDR",
        "IPCIDR6": "IP-CIDR6",
        "GEOIP": "GEOIP",
        "RULESET": "RULE-SET",
        "MATCH": "MATCH",
    }.get(compact_type, raw_type.upper().replace("_", "-"))
    return _evaluate_rule(rule_type, payload, domain, addresses, rule_set_matcher)


def _evaluate_rule(
    rule_type: str,
    payload: str,
    domain: str,
    addresses: Sequence[str],
    rule_set_matcher: RuleSetMatcher | None = None,
) -> tuple[str, str]:
    """Return ``match``, ``skip`` or ``unknown`` plus an operator-facing reason."""

    if rule_type == "DOMAIN":
        matched = domain == payload.lower().lstrip(".")
        return ("match" if matched else "skip", "Точное совпадение домена.")
    if rule_type in {"DOMAIN-SUFFIX", "DOMAIN-SUFFIX6"}:
        suffix = payload.lower().lstrip(".")
        matched = domain == suffix or domain.endswith(f".{suffix}")
        return ("match" if matched else "skip", "Домен входит в указанный suffix.")
    if rule_type == "DOMAIN-KEYWORD":
        matched = payload.lower() in domain
        return ("match" if matched else "skip", "Домен содержит keyword.")
    if rule_type in {"IP-CIDR", "IP-CIDR6", "GEOIP"}:
        if not addresses:
            return "unknown", "Нет IP-адресов для проверки."
        if rule_type == "GEOIP":
            return "unknown", "GEOIP требует базу геолокации ядра; панель не угадывает результат."
        matched = _ip_matches(addresses, payload)
        return ("match" if matched else "skip", "IP входит в указанную сеть.")
    if rule_type == "RULE-SET":
        if rule_set_matcher is None:
            return "unknown", "RULE-SET требует содержимое rule-provider; оно недоступно для этой проверки."
        return rule_set_matcher(payload, domain, addresses)
    if rule_type in {"OR", "AND"}:
        return _evaluate_expression(payload, domain, addresses, rule_set_matcher)
    if rule_type == "MATCH":
        return "match", "Финальное правило MATCH."
    return "unknown", "Тип правила нельзя безопасно вычислить только по домену."


def _safe_rule_list(payload: Any) -> list[Mapping[str, Any]]:
    raw = _mapping(payload).get("rules")
    if not isinstance(raw, Sequence) or isinstance(raw, (str, bytes, bytearray)):
        return []
    return [item for item in list(raw)[:MAX_TRACE_RULES] if isinstance(item, Mapping)]


def _proxy_chain(payload: Any, policy: str) -> tuple[list[str], str, str]:
    proxies = _mapping(payload).get("proxies")
    if not isinstance(proxies, Mapping) or not policy:
        return ([policy] if policy else []), policy, ""
    current = policy
    chain: list[str] = []
    visited: set[str] = set()
    group_types = {"Selector", "URLTest", "Fallback", "LoadBalance", "Relay", "Smart"}
    while current and current not in visited and len(chain) < MAX_TRACE_CHAIN:
        visited.add(current)
        chain.append(current)
        item = _mapping(proxies.get(current))
        next_name = _text(item.get("now"), 256)
        if not next_name and str(item.get("type") or "") in group_types:
            all_items = item.get("all")
            if isinstance(all_items, Sequence) and not isinstance(all_items, (str, bytes, bytearray)):
                next_name = _text(all_items[0] if all_items else "", 256)
        if not next_name or next_name in visited:
            break
        current = next_name
    leaf = chain[-1] if chain else policy
    leaf_type = _text(_mapping(proxies.get(leaf)).get("type"), 64)
    return chain, leaf, leaf_type


def build_trace_result(
    *,
    domain: str,
    dns_payload: Any,
    rules_payload: Any,
    proxies_payload: Any,
    rule_set_matcher: RuleSetMatcher | None = None,
) -> dict[str, Any]:
    """Build a bounded rule trace while clearly marking unknown semantics."""

    addresses = _answers(dns_payload)
    steps: list[dict[str, Any]] = []
    matched_rule: dict[str, Any] | None = None
    rules = _safe_rule_list(rules_payload)
    for index, raw_rule in enumerate(rules[:MAX_TRACE_STEPS]):
        rule_type, payload, target = _rule_parts(raw_rule)
        disabled = bool(_mapping(raw_rule).get("disabled") is True)
        if disabled:
            result, reason = "skip", "Правило отключено."
        else:
            result, reason = _evaluate_rule(rule_type, payload, domain, addresses, rule_set_matcher)
        step = {
            "index": index,
            "type": rule_type,
            "payload": payload,
            "target": target,
            "result": result,
            "reason": reason,
        }
        steps.append(step)
        if result in {"match", "unknown"}:
            matched_rule = step
            break

    if matched_rule is None:
        matched_rule = {
            "index": None,
            "type": "",
            "payload": "",
            "target": "",
            "result": "unknown",
            "reason": "Подходящее правило не удалось вычислить.",
        }
    policy = _text(matched_rule.get("target"), 256)
    if matched_rule.get("result") == "match":
        chain, leaf, leaf_type = _proxy_chain(proxies_payload, policy)
    else:
        chain, leaf, leaf_type = [], "", ""
    return {
        "schema_version": 1,
        "ok": bool(addresses) and matched_rule.get("result") == "match",
        "domain": domain,
        "dns": {
            "ok": bool(addresses),
            "addresses": addresses,
            "answer_count": len(addresses),
        },
        "matched_rule": matched_rule,
        "route": {
            "policy": policy or "—",
            "chain": chain,
            "leaf": leaf or "—",
            "leaf_type": leaf_type,
        },
        "steps": steps,
        "rule_count": len(rules),
        "truncated": len(rules) > MAX_TRACE_STEPS,
    }


__all__ = ["build_trace_result", "normalize_trace_domain"]
