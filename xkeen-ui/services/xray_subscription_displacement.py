"""Журнал вытеснения: что подписки убрали или изменили в файлах владельца.

Свои объекты панель узнаёт по тегам и вычитает.  Сюда попадает только то, что
вычитанием не вернуть: правило владельца, переведённое на пул, удалённый
балансировщик, убранный сервер, заменённый селектор.  При уходе подписок панель
кладёт на место ровно эти куски -- и ничего больше: всё, что владелец поправил
в своих файлах за это время, остаётся как есть.

Объект, который владелец успел изменить сам, не затирается: такая запись
пропускается и возвращается вызывающему в списке ``skipped``, чтобы об этом
можно было сказать в окне.

Модуль ничего не читает и не пишет: только словари в памяти.
"""

from __future__ import annotations

import copy
from typing import Any, Dict, Iterable, List


RULE_STAMP_PREFIX = "xk_auto_sub_only_"

_SECTIONS = ("rules", "taken_rules", "balancers", "outbounds")


def normalize(journal: Any) -> Dict[str, Any]:
    src = journal if isinstance(journal, dict) else {}
    out: Dict[str, Any] = {}
    for key in _SECTIONS:
        items = [copy.deepcopy(item) for item in src.get(key) or [] if isinstance(item, dict)]
        if items:
            out[key] = items
    selectors = src.get("selectors")
    if isinstance(selectors, dict):
        clean = {
            str(tag): _clean_terms(terms)
            for tag, terms in selectors.items()
            if str(tag or "").strip() and _clean_terms(terms)
        }
        if clean:
            out["selectors"] = clean
    comments = src.get("comments")
    if isinstance(comments, dict):
        clean_comments: Dict[str, Dict[str, List[str]]] = {}
        for file_name, by_key in comments.items():
            if not isinstance(by_key, dict):
                continue
            kept = {
                str(key): [str(line) for line in lines if str(line).strip()]
                for key, lines in by_key.items()
                if isinstance(lines, list) and any(str(line).strip() for line in lines)
            }
            if kept:
                clean_comments[str(file_name)] = kept
        if clean_comments:
            out["comments"] = clean_comments
    observatory = src.get("observatory")
    if isinstance(observatory, dict):
        clean_obs: Dict[str, Any] = {}
        if _clean_terms(observatory.get("subjects")):
            clean_obs["subjects"] = _clean_terms(observatory.get("subjects"))
        if isinstance(observatory.get("plain"), dict):
            clean_obs["plain"] = copy.deepcopy(observatory["plain"])
            clean_obs["file"] = str(observatory.get("file") or "")
        if clean_obs:
            out["observatory"] = clean_obs
    return out


def is_empty(journal: Any) -> bool:
    return not normalize(journal)


def _clean_terms(values: Any) -> List[str]:
    out: List[str] = []
    for value in values if isinstance(values, (list, tuple)) else []:
        term = str(value or "").strip()
        if term and term not in out:
            out.append(term)
    return out


def _tag(obj: Any, key: str = "tag") -> str:
    return str(obj.get(key) or "").strip() if isinstance(obj, dict) else ""


def _skip(skipped: List[Dict[str, str]], kind: str, name: str, reason: str) -> None:
    skipped.append({"kind": kind, "name": name, "reason": reason})


def _insert(items: List[Any], index: Any, value: Any) -> None:
    try:
        position = int(index)
    except (TypeError, ValueError):
        position = len(items)
    items.insert(max(0, min(position, len(items))), value)


# --------------------------------------------------------------- правила


def _rule_target(rule: Dict[str, Any]) -> Dict[str, str]:
    for key in ("outboundTag", "balancerTag"):
        value = _tag(rule, key)
        if value:
            return {key: value}
    return {}


def _set_target(rule: Dict[str, Any], target: Dict[str, str]) -> None:
    """Сменить цель правила, не сдвигая её с места среди ключей.

    Файл владельца после возврата должен читаться как прежде: цель, уехавшая
    в конец правила, выглядела бы правкой, которой никто не делал.
    """
    items = list(rule.items())
    rule.clear()
    placed = False
    for key, value in items:
        if key in ("outboundTag", "balancerTag"):
            if not placed:
                rule.update(target)
                placed = True
            continue
        rule[key] = value
    if not placed:
        rule.update(target)


def _next_stamp(journal: Dict[str, Any], rules: Iterable[Any]) -> str:
    taken = {_tag(rule, "ruleTag") for rule in rules}
    taken.update(str(entry.get("tag") or "") for entry in journal.get("rules") or [])
    index = 1
    while f"{RULE_STAMP_PREFIX}{index:03d}" in taken:
        index += 1
    return f"{RULE_STAMP_PREFIX}{index:03d}"


def retarget_rule(journal: Dict[str, Any], rules: List[Any], rule: Dict[str, Any], pool_tag: str) -> bool:
    """Перевести правило владельца на пул, запомнив, куда оно вело.

    Правилу без ``ruleTag`` панель ставит свой -- иначе его потом не найти:
    порядок правил владелец может поменять.  При возврате метка снимается.
    """
    target = _rule_target(rule)
    if target == {"balancerTag": pool_tag}:
        return False
    entries = journal.setdefault("rules", [])
    tag = _tag(rule, "ruleTag")
    known = None
    if tag:
        # Тег у владельца может повторяться.  Запись «занята», если другое
        # правило с тем же тегом уже стоит на пуле; свободная -- это наше
        # правило, которое владелец успел увести с пула.
        same_tag = [entry for entry in entries if entry.get("tag") == tag]
        others_on_pool = sum(
            1
            for item in rules
            if item is not rule and _tag(item, "ruleTag") == tag and _rule_target(item) == {"balancerTag": pool_tag}
        )
        if len(same_tag) > others_on_pool:
            known = same_tag[others_on_pool]
    if known is not None:
        # Правило уже в журнале, но снова ведёт не на пул: владелец поменял
        # цель, пока режим работал.  Возвращать будем его последний выбор.
        if target:
            known["target"] = target
    else:
        stamped = not tag
        if stamped:
            tag = _next_stamp(journal, rules)
            rule["ruleTag"] = tag
        entries.append({"tag": tag, "target": target, "stamped": stamped, "to": pool_tag})
    _set_target(rule, {"balancerTag": pool_tag})
    return True


def return_rules(journal: Dict[str, Any], rules: List[Any]) -> List[Dict[str, str]]:
    skipped: List[Dict[str, str]] = []
    used: set[int] = set()
    for entry in journal.pop("rules", None) or []:
        tag = str(entry.get("tag") or "")
        rule = next(
            (
                item
                for item in rules
                if isinstance(item, dict) and _tag(item, "ruleTag") == tag and id(item) not in used
            ),
            None,
        )
        if rule is None:
            _skip(skipped, "rule", tag, "removed")
            continue
        used.add(id(rule))
        still_ours = _rule_target(rule) == {"balancerTag": str(entry.get("to") or "")}
        if entry.get("stamped"):
            rule.pop("ruleTag", None)
        if not still_ours:
            _skip(skipped, "rule", tag, "changed")
            continue
        target = entry.get("target") if isinstance(entry.get("target"), dict) else {}
        if not target:
            continue
        _set_target(rule, target)
    return skipped


def take_over_rule(journal: Dict[str, Any], rule: Dict[str, Any], index: int, service_rule_tag: str) -> bool:
    """Правило владельца занято под служебное: запомнить, каким оно было."""
    if not isinstance(rule, dict) or not rule or _tag(rule, "ruleTag") == service_rule_tag:
        return False
    journal.setdefault("taken_rules", []).append({"rule": copy.deepcopy(rule), "index": int(index)})
    return True


def return_taken_rules(journal: Dict[str, Any], rules: List[Any], service_rule_tag: str) -> List[Dict[str, str]]:
    """Вернуть занятые правила на место служебного (или на прежнее место)."""
    skipped: List[Dict[str, str]] = []
    for entry in journal.pop("taken_rules", None) or []:
        original = entry.get("rule")
        if not isinstance(original, dict):
            continue
        if any(item == original for item in rules):
            _skip(skipped, "rule", _tag(original, "ruleTag") or "catch-all", "exists")
            continue
        service_index = next(
            (idx for idx, item in enumerate(rules) if _tag(item, "ruleTag") == service_rule_tag),
            -1,
        )
        if service_index >= 0:
            rules.pop(service_index)
            rules.insert(service_index, copy.deepcopy(original))
        else:
            _insert(rules, entry.get("index"), copy.deepcopy(original))
    return skipped


# ------------------------------------------------------- объекты с тегом


def _remove_tagged(journal: Dict[str, Any], section: str, key: str, items: List[Any], index: int) -> Dict[str, Any]:
    removed = items.pop(index)
    entries = journal.setdefault(section, [])
    tag = _tag(removed)
    # Тот же тег убран второй раз: владелец вернул объект сам, а режим убрал
    # снова.  Нужна последняя версия, а не две.
    entries[:] = [entry for entry in entries if _tag(entry.get(key)) != tag or not tag]
    entries.append({key: copy.deepcopy(removed), "index": int(index)})
    return removed


def _return_tagged(journal: Dict[str, Any], section: str, key: str, kind: str, items: List[Any]) -> List[Dict[str, str]]:
    skipped: List[Dict[str, str]] = []
    present = {_tag(item) for item in items}
    entries = sorted(journal.pop(section, None) or [], key=lambda entry: int(entry.get("index") or 0))
    for entry in entries:
        obj = entry.get(key)
        if not isinstance(obj, dict):
            continue
        tag = _tag(obj)
        if tag and tag in present:
            _skip(skipped, kind, tag, "exists")
            continue
        _insert(items, entry.get("index"), copy.deepcopy(obj))
        present.add(tag)
    return skipped


def remove_balancer(journal: Dict[str, Any], balancers: List[Any], index: int) -> Dict[str, Any]:
    return _remove_tagged(journal, "balancers", "balancer", balancers, index)


def return_balancers(journal: Dict[str, Any], balancers: List[Any]) -> List[Dict[str, str]]:
    return _return_tagged(journal, "balancers", "balancer", "balancer", balancers)


def remove_outbound(journal: Dict[str, Any], outbounds: List[Any], index: int) -> Dict[str, Any]:
    return _remove_tagged(journal, "outbounds", "outbound", outbounds, index)


def return_outbounds(journal: Dict[str, Any], outbounds: List[Any]) -> List[Dict[str, str]]:
    return _return_tagged(journal, "outbounds", "outbound", "outbound", outbounds)


def has_outbounds(journal: Any) -> bool:
    return bool(isinstance(journal, dict) and journal.get("outbounds"))


# ------------------------------------------------------------- селекторы


def displace_selector_terms(journal: Dict[str, Any], balancer_tag: str, owner_terms: Iterable[Any]) -> None:
    """Запомнить термы владельца, которые панель сейчас уберёт из селектора.

    Вызывается при каждом проходе, пока режим работает: то, что владелец
    дописал в селектор уже после входа в режим, тоже должно вернуться.
    """
    terms = _clean_terms(list(owner_terms))
    if not terms:
        return
    selectors = journal.setdefault("selectors", {})
    known = _clean_terms(selectors.get(balancer_tag))
    selectors[balancer_tag] = known + [term for term in terms if term not in known]


def return_selectors(journal: Dict[str, Any], balancers: List[Any]) -> List[Dict[str, str]]:
    skipped: List[Dict[str, str]] = []
    for tag, terms in (journal.pop("selectors", None) or {}).items():
        balancer = next((item for item in balancers if _tag(item) == tag), None)
        if balancer is None:
            _skip(skipped, "selector", str(tag), "removed")
            continue
        current = _clean_terms(balancer.get("selector"))
        owner = _clean_terms(terms)
        merged = owner + [term for term in current if term not in owner]
        if merged != current:
            balancer["selector"] = merged
    return skipped


# ----------------------------------------------------------- обсерватория


def displace_subjects(journal: Dict[str, Any], owner_subjects: Iterable[Any]) -> None:
    terms = _clean_terms(list(owner_subjects))
    if not terms:
        return
    observatory = journal.setdefault("observatory", {})
    known = _clean_terms(observatory.get("subjects"))
    observatory["subjects"] = known + [term for term in terms if term not in known]


def take_subjects(journal: Dict[str, Any]) -> List[str]:
    """Отдать запомненные селекторы обсерватории и забыть их."""
    observatory = journal.get("observatory")
    if not isinstance(observatory, dict):
        return []
    subjects = _clean_terms(observatory.pop("subjects", None))
    if not observatory:
        journal.pop("observatory", None)
    return subjects


def remember_plain_observatory(journal: Dict[str, Any], file_name: str, section: Dict[str, Any]) -> None:
    """Запомнить обычную секцию владельца перед переводом её в burst."""
    observatory = journal.setdefault("observatory", {})
    if isinstance(observatory.get("plain"), dict):
        return
    observatory["plain"] = copy.deepcopy(section)
    observatory["file"] = str(file_name or "")


def plain_observatory(journal: Any) -> Dict[str, Any] | None:
    observatory = journal.get("observatory") if isinstance(journal, dict) else None
    if not isinstance(observatory, dict) or not isinstance(observatory.get("plain"), dict):
        return None
    return {"file": str(observatory.get("file") or ""), "section": copy.deepcopy(observatory["plain"])}


def forget_plain_observatory(journal: Dict[str, Any]) -> None:
    observatory = journal.get("observatory")
    if not isinstance(observatory, dict):
        return
    observatory.pop("plain", None)
    observatory.pop("file", None)
    if not observatory:
        journal.pop("observatory", None)


# ------------------------------------------------------------ комментарии


def comment_stash(journal: Dict[str, Any], file_name: str) -> Dict[str, List[str]]:
    """Куда складывать комментарии объектов, убранных из этого файла.

    Комментарий владельца стоит над его сервером или балансировщиком.  Пока
    объекта в файле нет, комментарию не к чему крепиться; он ждёт здесь и
    возвращается на место вместе с объектом.
    """
    return journal.setdefault("comments", {}).setdefault(str(file_name), {})


def take_comments(journal: Dict[str, Any], file_name: str) -> Dict[str, List[str]]:
    comments = journal.get("comments")
    if not isinstance(comments, dict):
        return {}
    taken = comments.pop(str(file_name), None)
    if not comments:
        journal.pop("comments", None)
    return taken if isinstance(taken, dict) else {}
