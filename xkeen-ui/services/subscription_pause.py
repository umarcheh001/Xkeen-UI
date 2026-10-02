"""One switch for all Xray subscriptions, with DNS-over-VLESS kept on a live route.

Pausing takes every subscription out of the running config and resuming puts
them back; both are ``services.xray_subscriptions``' work.  What this module
adds is the part neither side can do alone: DNS-over-VLESS holds a snapshot of
the route it was pointed at, so when that route is made of subscription nodes
a pause would leave every client of the router without DNS.

DNS-over-VLESS cannot change its route in place -- only by being switched off
and on again -- so a move costs two restarts of Xray.  Where the route survives
the change there is one restart and DNS is not touched at all.
"""

from __future__ import annotations

import os
import threading
import time
import uuid
from typing import Any, Callable, Dict, List, Optional

from services import dns_over_vless as dov
from services import xray_subscriptions as subs
from services.io.atomic import _atomic_write_json

RECORD_FILENAME = "xray_subscriptions_pause.json"

_LOCK = threading.RLock()


class PauseError(Exception):
    def __init__(self, message: str, *, code: str, details: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.code = code
        self.details = details or {}


class _ChoiceNeeded(Exception):
    def __init__(self, candidates: List[Dict[str, str]]):
        super().__init__("choice needed")
        self.candidates = candidates


# --- what was done to DNS at pause time, so resume can undo exactly that ---------


def _record_path(ui_state_dir: str) -> str:
    return os.path.join(str(ui_state_dir or ""), RECORD_FILENAME)


def _read_record(ui_state_dir: str) -> Dict[str, Any]:
    value = subs._read_json_file(_record_path(ui_state_dir), {})
    return value if isinstance(value, dict) else {}


def _drop_record(ui_state_dir: str) -> None:
    try:
        os.remove(_record_path(ui_state_dir))
    except FileNotFoundError:
        pass


# --- reading DNS-over-VLESS ----------------------------------------------------


def _dns_now(ui_state_dir: str, xray_configs_dir: str, routing_file: str) -> Dict[str, Any]:
    state = dov._load_state(ui_state_dir)
    routing, _raw = dov._read_routing_with_raw(routing_file)
    enabled = bool(state.get("enabled"))
    return {
        "enabled": enabled,
        "selection": dov._stored_selection(state) if enabled else [],
        "state": state,
        "routing": routing,
        "runtime": dov._collect_runtime(xray_configs_dir, routing),
        "presence": dov._managed_presence(xray_configs_dir, routing),
    }


def _brief(view: Dict[str, Any]) -> Dict[str, Any]:
    return {"enabled": bool(view.get("enabled")), "selection": list(view.get("selection") or [])}


def _usable(runtime: Dict[str, Any], routing: Dict[str, Any]) -> List[Dict[str, str]]:
    return [
        {"tag": item["tag"], "kind": item["kind"]}
        for item in dov._usable_candidates(dov.list_candidates(runtime, routing))
    ]


def _with_kinds(tags: List[str], known: List[Dict[str, str]]) -> List[Dict[str, str]]:
    kinds = {item["tag"]: item["kind"] for item in known}
    return [{"tag": tag, "kind": kinds.get(tag, "outbound")} for tag in tags]


def _drift(runtime: Dict[str, Any], routing: Dict[str, Any], selection: List[str]) -> Any:
    if not selection or not dov._find_managed_clone(routing):
        return None
    if len(selection) == 1:
        return dov._route_drift(runtime, routing, selection[0])
    return dov._combined_drift(runtime, routing, selection)


def _survives(
    selection: List[str],
    state: Dict[str, Any],
    runtime: Dict[str, Any],
    routing: Dict[str, Any],
) -> bool:
    """Whether DNS can stay exactly as it is on the given configuration."""
    tags = {item["tag"] for item in _usable(runtime, routing)}
    if not selection or any(tag not in tags for tag in selection):
        return False
    if _drift(runtime, routing, selection):
        return False
    if state.get("pass_non_ip"):
        live = {item["tag"] for item in dov._proxy_outbounds(runtime)}
        if dov._clean_tag(state.get("pass_non_ip_node")) not in live:
            return False
    return True


def _intact(view: Dict[str, Any]) -> bool:
    presence = view["presence"]
    if not dov._managed_config_complete(presence) or dov._managed_config_tampered(presence):
        return False
    return _survives(view["selection"], view["state"], view["runtime"], view["routing"])


# --- what the configs will look like once the subscriptions are out ------------


def _predict_paused(ui_state_dir: str, xray_configs_dir: str, view: Dict[str, Any]) -> tuple[Dict[str, Any], Dict[str, Any]]:
    """Runtime and routing after a pause, worked out without touching a file.

    Only a forecast for the confirmation window: the pause itself looks at the
    real files afterwards and does not trust this.
    """
    state = subs.load_subscription_state(ui_state_dir)
    active = [
        item
        for item in state.get("subscriptions") or []
        if isinstance(item, dict) and not item.get("paused")
    ]
    files = {str(item.get("output_file") or "") for item in active}
    terms = {term for item in active for term in subs._subscription_runtime_selector_terms(item)}

    runtime = dict(view["runtime"])
    outbounds = [item for item in runtime.get("outbounds", []) if item.get("file") not in files]
    known = {item["tag"] for item in outbounds}
    # "Subscription only" moved the owner's servers aside; a pause brings them back.
    aside = subs._read_json_file(
        subs._disabled_config_path(subs._config_fragment_path(xray_configs_dir, subs.OUTBOUNDS_FILE)), None
    )
    for item in (aside.get("outbounds") if isinstance(aside, dict) else None) or []:
        tag = dov._clean_tag(item.get("tag")) if isinstance(item, dict) else ""
        if tag and tag not in known:
            known.add(tag)
            outbounds.append(
                {
                    "tag": tag,
                    "protocol": dov._clean_tag(item.get("protocol")).lower(),
                    "file": os.path.basename(subs.OUTBOUNDS_FILE),
                    "mark": None,
                }
            )

    model = view["routing"].get("routing") if isinstance(view["routing"].get("routing"), dict) else {}
    balancers = [item for item in model.get("balancers") or [] if isinstance(item, dict)]
    baseline = (state.get(subs.MANAGED_BASELINES_KEY) or {}).get(subs.MANAGED_BASELINE_ROUTING_KEY)
    subscription_only = (
        subs._effective_subscription_routing_mode(ui_state_dir) == subs.ROUTING_MODE_SUBSCRIPTION_ONLY
    )
    if subscription_only and isinstance(baseline, dict) and baseline.get("exists"):
        # This mode is undone by writing the remembered routing back whole.
        before = subs._load_jsonc_text(str(baseline.get("text") or "")) or {}
        before_model = before.get("routing") if isinstance(before.get("routing"), dict) else {}
        clone = dov._find_managed_clone(view["routing"])
        balancers = [item for item in before_model.get("balancers") or [] if isinstance(item, dict)]
        if clone:
            balancers.append(clone)
    else:
        # Otherwise the panel's own pool goes away once only the owner's
        # preserved server would be left in it.
        pool_tag = subs._choose_auto_balancer_tag(model)
        preserved = set(subs._preserved_balancer_tags(xray_configs_dir))
        kept = []
        for item in balancers:
            if dov._clean_tag(item.get("tag")) == pool_tag:
                selector = [str(value).strip() for value in item.get("selector") or []]
                left = [value for value in selector if value and value not in terms]
                if len(left) != len(selector) and all(value in preserved for value in left):
                    continue
            kept.append(item)
        balancers = kept

    runtime["outbounds"] = outbounds
    runtime["balancers"] = balancers
    routing = {"routing": dict(model, balancers=balancers)}
    return runtime, routing


def _pause_outlook(ui_state_dir: str, xray_configs_dir: str, view: Dict[str, Any]) -> Dict[str, Any]:
    if not view["enabled"]:
        return {"outcome": "none", "to": None, "candidates": [], "restarts": 1}
    runtime, routing = _predict_paused(ui_state_dir, xray_configs_dir, view)
    usable = _usable(runtime, routing)
    tags = {item["tag"] for item in usable}
    selection = view["selection"]
    if selection and all(tag in tags for tag in selection):
        same = _survives(selection, view["state"], runtime, routing)
        return {"outcome": "keep" if same else "resync", "to": None, "candidates": [], "restarts": 1 if same else 2}
    if not usable:
        return {"outcome": "disable", "to": None, "candidates": [], "restarts": 2}
    if len(usable) == 1:
        return {"outcome": "retarget", "to": usable[0], "candidates": usable, "restarts": 2}
    return {"outcome": "choose", "to": None, "candidates": usable, "restarts": 2}


def _wants_restore(record: Dict[str, Any], view: Dict[str, Any]) -> bool:
    """Resume undoes the DNS move only while it is still exactly as the pause left it."""
    before = record.get("before") if isinstance(record.get("before"), dict) else {}
    after = record.get("after") if isinstance(record.get("after"), dict) else {}
    if not before.get("enabled") or not before.get("selection"):
        return False
    return before != after and _brief(view) == after


def plan(*, ui_state_dir: str, xray_configs_dir: str, routing_file: str) -> Dict[str, Any]:
    """What the switch would do right now.  Reads only."""
    items = subs.list_subscriptions(ui_state_dir)
    paused = any(item.get("paused") for item in items)
    view = _dns_now(ui_state_dir, xray_configs_dir, routing_file)
    current = _usable(view["runtime"], view["routing"])

    if paused:
        record = _read_record(ui_state_dir)
        if _wants_restore(record, view):
            before = record["before"]
            kinds = record.get("before_kinds") if isinstance(record.get("before_kinds"), list) else []
            outlook = {
                "outcome": "restore",
                "to": (_with_kinds(before["selection"], kinds) or [None])[0],
                "candidates": [],
                "restarts": 2 if view["enabled"] else 1,
            }
        elif not view["enabled"]:
            outlook = {"outcome": "none", "to": None, "candidates": [], "restarts": 1}
        else:
            takes_own_servers = any(
                item.get("paused") and item.get("routing_mode") == subs.ROUTING_MODE_SUBSCRIPTION_ONLY
                for item in items
            )
            outlook = {
                "outcome": "recheck" if takes_own_servers else "keep",
                "to": None,
                "candidates": [],
                "restarts": 2 if takes_own_servers else 1,
            }
    else:
        outlook = _pause_outlook(ui_state_dir, xray_configs_dir, view)

    return {
        "ok": True,
        "paused": paused,
        "total": len(items),
        "dns": {
            "enabled": view["enabled"],
            "from": _with_kinds(view["selection"], current),
            **outlook,
        },
    }


# --- undoing a half-done change --------------------------------------------------


class _Guard:
    """Byte copy of everything a pause or resume may rewrite."""

    def __init__(self, ui_state_dir: str, xray_configs_dir: str):
        jsonc_dir = os.path.dirname(subs.jsonc_path_for(subs._config_fragment_path(xray_configs_dir, subs.ROUTING_FILE)))
        self._dirs = [path for path in dict.fromkeys([xray_configs_dir, jsonc_dir]) if path and os.path.isdir(path)]
        self._snap: Dict[str, Optional[bytes]] = {}
        for directory in self._dirs:
            for name in os.listdir(directory):
                path = os.path.join(directory, name)
                if os.path.isfile(path):
                    self._snap[path] = self._read(path)
        for path in (
            subs.subscription_state_path(ui_state_dir),
            dov._state_path(ui_state_dir),
            _record_path(ui_state_dir),
        ):
            self._snap[path] = self._read(path)

    @staticmethod
    def _read(path: str) -> Optional[bytes]:
        try:
            with open(path, "rb") as handle:
                return handle.read()
        except FileNotFoundError:
            return None

    def restore(self) -> None:
        for directory in self._dirs:
            for name in os.listdir(directory):
                path = os.path.join(directory, name)
                if os.path.isfile(path) and path not in self._snap:
                    os.remove(path)
        for path, data in self._snap.items():
            if data is None:
                try:
                    os.remove(path)
                except FileNotFoundError:
                    pass
            elif self._read(path) != data:
                temp = f"{path}.{uuid.uuid4().hex}.tmp"
                with open(temp, "wb") as handle:
                    handle.write(data)
                os.replace(temp, path)


def _restart(restart_xkeen: Callable[..., Any], source: str) -> bool:
    try:
        return bool(restart_xkeen(source=source))
    except TypeError:
        return bool(restart_xkeen())
    except Exception:
        return False


def _dns_result(before: Dict[str, Any], after: Dict[str, Any], *, round_trip: bool, restored: bool) -> Dict[str, Any]:
    if not before["enabled"] and not after["enabled"]:
        action = "none"
    elif before["enabled"] and not after["enabled"]:
        action = "disabled"
    elif not before["enabled"]:
        action = "enabled"
    elif before["selection"] != after["selection"]:
        action = "moved"
    else:
        action = "resynced" if round_trip else "kept"
    return {
        "action": action,
        "from": list(before["selection"]),
        "to": list(after["selection"]),
        "restored": bool(restored and action in {"moved", "enabled"}),
    }


def _switch(
    direction: str,
    *,
    ui_state_dir: str,
    xray_configs_dir: str,
    routing_file: str,
    snapshot: Callable[[str], None] | None,
    restart_xkeen: Callable[..., Any],
    dns_target: Any = "",
) -> Dict[str, Any]:
    pausing = direction == "pause"
    source = f"xray-subscriptions-{direction}"
    dns_args = {
        "configs_dir": xray_configs_dir,
        "routing_file": routing_file,
        "ui_state_dir": ui_state_dir,
        "restart_xkeen": restart_xkeen,
    }

    with _LOCK:
        items = subs.list_subscriptions(ui_state_dir)
        pending = [item for item in items if bool(item.get("paused")) != pausing]
        view = _dns_now(ui_state_dir, xray_configs_dir, routing_file)
        before = _brief(view)
        if not pending:
            return {
                "ok": True,
                "changed": False,
                "paused": subs.subscriptions_paused(ui_state_dir),
                "count": 0,
                "restarted": False,
                "restarts": 0,
                "dns": _dns_result(before, before, round_trip=False, restored=False),
            }

        record = {} if pausing else _read_record(ui_state_dir)
        restore = (not pausing) and _wants_restore(record, view)
        before_kinds = _with_kinds(before["selection"], _usable(view["runtime"], view["routing"]))
        outlook = _pause_outlook(ui_state_dir, xray_configs_dir, view) if pausing else {}

        def _apply_files() -> Dict[str, Any]:
            operation = subs.pause_subscriptions if pausing else subs.resume_subscriptions
            return operation(ui_state_dir, xray_configs_dir=xray_configs_dir, snapshot=snapshot)

        def _finish(*, restarts: int, restarted: bool, round_trip: bool) -> Dict[str, Any]:
            after = _brief(_dns_now(ui_state_dir, xray_configs_dir, routing_file))
            if pausing:
                _atomic_write_json(
                    _record_path(ui_state_dir),
                    {
                        "paused_at": int(time.time()),
                        "before": before,
                        "before_kinds": before_kinds,
                        "after": after,
                    },
                )
            else:
                _drop_record(ui_state_dir)
            return {
                "ok": True,
                "changed": True,
                "paused": pausing,
                "count": len(pending),
                "restarted": bool(restarted),
                "restarts": restarts,
                "dns": _dns_result(before, after, round_trip=round_trip, restored=restore),
            }

        # One restart, DNS untouched: nothing to protect, or the route survives.
        dns_idle = not view["enabled"] and not restore
        if dns_idle or (view["enabled"] and not restore and (not pausing or outlook.get("outcome") == "keep")):
            guard = _Guard(ui_state_dir, xray_configs_dir)
            try:
                _apply_files()
                if dns_idle or _intact(_dns_now(ui_state_dir, xray_configs_dir, routing_file)):
                    restarted = _restart(restart_xkeen, source)
                    return _finish(restarts=1, restarted=restarted, round_trip=False)
            except Exception:
                guard.restore()
                raise
            # The forecast was wrong: put the files back and go the long way.
            guard.restore()

        if pausing and outlook.get("outcome") == "choose" and not dov.normalize_target_request(dns_target):
            raise PauseError(
                "Выберите, через какой ваш сервер пустить DNS-over-VLESS.",
                code="dns_target_choice_required",
                details={"candidates": outlook.get("candidates") or []},
            )

        restarts = 0
        if view["enabled"]:
            try:
                dov.apply_action("disable", **dns_args)
            except dov.DnsOverVlessError as exc:
                raise PauseError(
                    f"Не удалось перевести DNS-over-VLESS: {exc}",
                    code="dns_switch_failed",
                    details={"rolled_back": True, "stage": "disable", "dns_code": exc.code},
                )
            restarts += 1

        guard = _Guard(ui_state_dir, xray_configs_dir)
        try:
            _apply_files()
            after_view = _dns_now(ui_state_dir, xray_configs_dir, routing_file)
            usable = _usable(after_view["runtime"], after_view["routing"])
            tags = {item["tag"] for item in usable}
            preferred = [record["before"]["selection"]] if restore else []
            preferred.append(before["selection"])
            preferred.append(dov.normalize_target_request(dns_target))
            target = next(
                (choice for choice in preferred if choice and all(tag in tags for tag in choice)),
                None,
            )
            if target is None and len(usable) == 1:
                target = [usable[0]["tag"]]
            if target is None and usable:
                raise _ChoiceNeeded(usable)
            if target:
                dov.apply_action("enable", target_tag=target, **dns_args)
                restarted = True
            else:
                restarted = _restart(restart_xkeen, source)
            restarts += 1
        except Exception as exc:
            guard.restore()
            rolled_back = True
            if view["enabled"]:
                try:
                    dov.apply_action("enable", target_tag=before["selection"], **dns_args)
                except Exception:  # noqa: BLE001 - reported below, nothing more to try
                    rolled_back = False
            else:
                rolled_back = _restart(restart_xkeen, source + "-rollback")
            if isinstance(exc, _ChoiceNeeded):
                raise PauseError(
                    "Выберите, через какой ваш сервер пустить DNS-over-VLESS.",
                    code="dns_target_choice_required",
                    details={"candidates": exc.candidates, "rolled_back": rolled_back},
                )
            if isinstance(exc, dov.DnsOverVlessError):
                raise PauseError(
                    f"Не удалось перевести DNS-over-VLESS: {exc}",
                    code="dns_switch_failed",
                    details={"rolled_back": rolled_back, "stage": "enable", "dns_code": exc.code},
                )
            raise

        return _finish(restarts=restarts, restarted=restarted, round_trip=True)


def pause_all(**kwargs: Any) -> Dict[str, Any]:
    return _switch("pause", **kwargs)


def resume_all(**kwargs: Any) -> Dict[str, Any]:
    return _switch("resume", **kwargs)
