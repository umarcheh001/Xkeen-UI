"""Shared port-53 guard for both DNS protections.

XKeen ships two assistants that take DNS away from the firmware: DNS-over-VLESS
for Xray (``services.dns_over_vless``) and DNS protection for Mihomo
(``services.mihomo_dns``).  They are built the same way — own the ``dns`` config,
flip ``opkg dns-override``, listen on port 53 — but only the Xray one used to be
guarded, and its guard assumed Xray was the only core that could ever answer.

That assumption failed on a two-core router: switching to Mihomo looked exactly
like a crashed Xray, so the guard burned its restart budget fighting the user's
own core choice and then tore the configuration down.  Meanwhile the Mihomo
assistant had no guard at all, so a Mihomo crash left the whole LAN without DNS
and nothing brought it back.

This module keeps one loop for both.  Health is measured by an actual DNS query,
which does not care which core answers it, and the guard only decides *whose*
protection is on and what to do when nobody answers:

* the expected core is running (or nothing is) — a real outage: restart, then
  hand DNS back if the restarts do not help;
* a *different* core is running — the operator switched cores, which restarts
  cannot undo, so hand DNS back at once and say so plainly.
"""

from __future__ import annotations

import threading
import time
from typing import Any, Callable, Dict, List, Optional

from services import dns_over_vless, mihomo_dns
from services.cores import detect_running_core

_GUARD_LOCK = threading.Lock()
_GUARD_STARTED = False


class Protection:
    """One DNS assistant as the guard sees it: is it on, and how to stand down."""

    def __init__(
        self,
        name: str,
        *,
        expected_core: str,
        is_enabled: Callable[[], bool],
        release: Callable[[str], Dict[str, Any]],
        reconcile: Optional[Callable[[], Any]] = None,
    ) -> None:
        self.name = name
        self.expected_core = expected_core
        self._is_enabled = is_enabled
        self._release = release
        self._reconcile = reconcile

    def enabled(self) -> bool:
        try:
            return bool(self._is_enabled())
        except Exception:
            # A protection whose state cannot be read is not one we can guard;
            # claiming it is on would let the guard release a config it never saw.
            return False

    def release(self, reason: str) -> Dict[str, Any]:
        return self._release(reason)

    def reconcile(self) -> str:
        """Put back whatever the firmware may have undone since the last tick.

        Only for changes made outside our own files: KeeneticOS rebuilds its
        firewall chains on any policy or interface change, and a rule of ours
        can end up below the one it is meant to precede.  A failure here is
        reported, never fatal -- the DNS itself is answering, which is what the
        tick was checking.
        """
        if not self._reconcile:
            return ""
        try:
            self._reconcile()
        except Exception as exc:  # noqa: BLE001 - reported to the audit line
            return str(exc)
        return ""


def build_protections(
    *,
    configs_dir: str,
    routing_file: str,
    ui_state_dir: str,
    mihomo_config_file: str,
    save_mihomo_config: Optional[Callable[[str], Any]],
    restart_xkeen: Callable[..., Any],
) -> List[Protection]:
    """Wire both assistants to the guard, skipping any that is not available."""

    def _watch_xray_dns() -> None:
        """Everything about the Xray protection a healthy tick has to re-check.

        The capture rule can be pushed out of place by the firmware, and the
        node that carries the other record types can go quiet without the
        shared probe noticing -- it asks for ``A``, which the built-in DNS
        answers whatever happened to the pass-through.
        """
        dns_over_vless.reapply_client_capture(ui_state_dir=ui_state_dir)
        dns_over_vless.check_pass_non_ip(
            configs_dir=configs_dir,
            routing_file=routing_file,
            ui_state_dir=ui_state_dir,
            restart_xkeen=restart_xkeen,
        )

    protections: List[Protection] = [
        Protection(
            "dns-over-vless",
            expected_core="xray",
            is_enabled=lambda: bool(dns_over_vless._load_state(ui_state_dir).get("enabled")),
            release=lambda reason: dns_over_vless._emergency_release(
                configs_dir=configs_dir,
                routing_file=routing_file,
                ui_state_dir=ui_state_dir,
                restart_xkeen=restart_xkeen,
                reason=reason,
            ),
            reconcile=_watch_xray_dns,
        ),
    ]

    # The Mihomo assistant rewrites a whole YAML profile, so it can only be
    # released where the caller supplied the same writer the panel uses.
    if mihomo_config_file and callable(save_mihomo_config):
        protections.append(
            Protection(
                "mihomo-dns",
                expected_core="mihomo",
                is_enabled=lambda: mihomo_dns.is_enabled(
                    config_file=mihomo_config_file, ui_state_dir=ui_state_dir
                ),
                release=lambda reason: mihomo_dns.emergency_release(
                    config_file=mihomo_config_file,
                    ui_state_dir=ui_state_dir,
                    save_config=save_mihomo_config,
                    restart_xkeen=restart_xkeen,
                    reason=reason,
                ),
            )
        )
    return protections


PROTECTION_LABELS = {
    "dns-over-vless": "DNS-over-VLESS (Xray)",
    "mihomo-dns": "защита DNS Mihomo",
}


def protection_owner(*, ui_state_dir: str, mihomo_config_file: str = "") -> str:
    """Which assistant currently holds port 53, if any.

    Both flip the same firmware switch, so letting the second one turn on would
    overwrite the first one's record of the original ``dns-override`` value and
    leave nothing able to restore it.  The panel uses this to refuse instead.
    """

    try:
        if bool(dns_over_vless._load_state(ui_state_dir).get("enabled")):
            return "dns-over-vless"
    except Exception:
        pass
    if mihomo_config_file:
        try:
            if mihomo_dns.is_enabled(config_file=mihomo_config_file, ui_state_dir=ui_state_dir):
                return "mihomo-dns"
        except Exception:
            pass
    return ""


def conflicting_protection(*, want: str, ui_state_dir: str, mihomo_config_file: str = "") -> str:
    """The label of the *other* protection when it is already on, else ``''``."""

    owner = protection_owner(ui_state_dir=ui_state_dir, mihomo_config_file=mihomo_config_file)
    if not owner or owner == want:
        return ""
    return PROTECTION_LABELS.get(owner, owner)


def watchdog_settings() -> Dict[str, Any]:
    """The knobs the guard is actually running with.

    They were never Xray-specific — one guard watches whichever protection is
    on — so both panels read them from here instead of from the Xray module.
    """

    return dns_over_vless.watchdog_settings()


def _probe_ok() -> bool:
    """Ask the network, not the process table: does anything resolve names?"""

    try:
        return bool(dns_over_vless._dns_probe().get("ok"))
    except Exception:
        return False


def _core_switch_reason(active: List[Protection], running: str) -> str:
    expected = ", ".join(sorted({item.expected_core for item in active})) or "?"
    return (
        "Активно ядро %s, а защита DNS рассчитана на %s; перезапуски делу не помогут, "
        "DNS возвращён прошивке." % (running, expected)
    )


def guard_tick(
    *,
    protections: List[Protection],
    counters: Optional[Dict[str, Any]] = None,
    fail_threshold: Optional[int] = None,
    restart_attempts: Optional[int] = None,
    restart_xkeen: Callable[..., Any],
) -> Dict[str, Any]:
    """Run one health check and return updated counters plus the action taken.

    Actions: ``idle`` (no protection on), ``ok``, ``watching`` (a failure seen,
    still below the threshold), ``restarted``, ``released`` (DNS handed back)
    and ``core-switched`` (released because another core took over).
    """

    if fail_threshold is None or restart_attempts is None:
        settings = dns_over_vless.watchdog_settings()
        if fail_threshold is None:
            fail_threshold = int(settings["fail_threshold"])
        if restart_attempts is None:
            restart_attempts = int(settings["restart_attempts"])

    result = dict(counters or {})
    result.setdefault("fails", 0)
    result.setdefault("restarts", 0)
    result.setdefault("released", False)

    active = [item for item in protections if item.enabled()]
    if not active:
        result.update({"fails": 0, "restarts": 0, "action": "idle"})
        return result
    if result.get("released"):
        result["action"] = "released"
        return result

    result["protections"] = [item.name for item in active]

    if _probe_ok():
        result.update({"fails": 0, "restarts": 0, "action": "ok"})
        problems = [note for note in (item.reconcile() for item in active) if note]
        if problems:
            result["reconcile_error"] = "; ".join(problems)
        return result

    running = str(detect_running_core() or "")
    expected_cores = {item.expected_core for item in active}

    # A core that is up but different from the one the protection was built for
    # is a deliberate switch, not an outage.  Restarting would only relaunch the
    # very core the operator moved away from, so stand down immediately.
    if running and running not in expected_cores:
        reason = _core_switch_reason(active, running)
        result["release"] = _release_all(active, reason)
        result.update({"released": True, "action": "core-switched", "reason": reason})
        return result

    result["fails"] = int(result["fails"]) + 1
    if result["fails"] < fail_threshold:
        result["action"] = "watching"
        return result

    if int(result["restarts"]) < restart_attempts:
        result["restarts"] = int(result["restarts"]) + 1
        result["fails"] = 0
        try:
            restart_xkeen(source="dns-guard")
        except Exception:
            pass
        result["action"] = "restarted"
        return result

    attempts = int(result["restarts"])
    core_label = running or "ядро"
    reason = (
        "%s не отвечает после %d попыток перезапуска; DNS возвращён прошивке." % (core_label, attempts)
        if attempts
        # Restarts turned off by configuration: give DNS back straight away.
        else "%s не отвечает, перезапуски отключены; DNS возвращён прошивке." % core_label
    )
    result["release"] = _release_all(active, reason)
    result.update({"released": True, "action": "released", "reason": reason})
    return result


def _release_all(active: List[Protection], reason: str) -> Dict[str, Any]:
    """Stand every active protection down.

    Normally exactly one is on — the panel refuses to enable both.  An install
    that predates that rule can still carry two, and since both flipped the same
    firmware switch, releasing only one would leave the override on.
    """

    released: Dict[str, Any] = {}
    for item in active:
        try:
            released[item.name] = item.release(reason)
        except Exception as exc:  # noqa: BLE001
            released[item.name] = {"error": str(exc)}
    return released


def start_guard(
    *,
    configs_dir: str,
    routing_file: str,
    ui_state_dir: str,
    mihomo_config_file: str = "",
    save_mihomo_config: Optional[Callable[[str], Any]] = None,
    restart_xkeen: Callable[..., Any],
    interval: Optional[float] = None,
    audit: Optional[Callable[..., None]] = None,
) -> bool:
    """Start the background check once per process.

    The knobs keep the documented ``XKEEN_DNS_OVER_VLESS_WATCHDOG*`` names: they
    were never Xray-specific in meaning, and installs already carry them.
    """

    settings = dns_over_vless.watchdog_settings()
    if not settings["enabled"]:
        return False
    tick = float(interval if interval else settings["interval"])
    low, high = dns_over_vless.WATCHDOG_INTERVAL_BOUNDS
    tick = max(low, min(high, tick))
    fail_threshold = int(settings["fail_threshold"])
    restart_attempts = int(settings["restart_attempts"])

    global _GUARD_STARTED
    with _GUARD_LOCK:
        if _GUARD_STARTED:
            return False
        _GUARD_STARTED = True

    protections = build_protections(
        configs_dir=configs_dir,
        routing_file=routing_file,
        ui_state_dir=ui_state_dir,
        mihomo_config_file=mihomo_config_file,
        save_mihomo_config=save_mihomo_config,
        restart_xkeen=restart_xkeen,
    )

    def _loop() -> None:
        counters: Dict[str, Any] = {}
        while True:
            time.sleep(tick)
            try:
                counters = guard_tick(
                    protections=protections,
                    counters=counters,
                    fail_threshold=fail_threshold,
                    restart_attempts=restart_attempts,
                    restart_xkeen=restart_xkeen,
                )
                action = counters.get("action")
                if action in {"restarted", "released", "core-switched"} and audit is not None:
                    # The guard acts unattended; leave a trace in the log.
                    try:
                        audit(
                            action == "restarted",
                            source="dns-guard",
                            summary=_audit_summary(action, counters),
                        )
                    except Exception:
                        pass
                if action in {"released", "core-switched"}:
                    # Nothing left to guard; a new enable restarts the cycle.
                    counters = {}
            except Exception:
                counters = {}

    thread = threading.Thread(target=_loop, name="xkeen-dns-guard", daemon=True)
    thread.start()
    return True


def _audit_summary(action: str, counters: Dict[str, Any]) -> str:
    names = ", ".join(counters.get("protections") or []) or "защита DNS"
    if action == "restarted":
        return "Защита DNS (%s): сторож перезапустил ядро" % names
    if action == "core-switched":
        return "Защита DNS (%s) снята: сменилось ядро, DNS возвращён прошивке" % names
    return "Защита DNS (%s) снята сторожем, DNS возвращён прошивке" % names


__all__ = [
    "PROTECTION_LABELS",
    "Protection",
    "build_protections",
    "conflicting_protection",
    "guard_tick",
    "protection_owner",
    "start_guard",
    "watchdog_settings",
]
