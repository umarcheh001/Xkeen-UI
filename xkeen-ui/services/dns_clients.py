"""Which clients actually reach DNS-over-VLESS, and which the firmware takes away.

The panel used to answer "is port 53 ours?" and call that success.  On a live
router that answer is true and useless at the same time: KeeneticOS redirects
port 53 to its own ``ndnproxy`` before the packet can reach the Xray socket, so
a device can sit behind a perfectly configured tunnel and never use it.  The
redirect is per access policy, which is why the same network splits in two --
devices in a policy are taken away, devices in none arrive.

Three sources answer the question together:

* ``iptables -t nat -S _NDM_HOTSPOT_DNSREDIR`` -- which policy marks have their
  port 53 redirected, and on which segment;
* ``ndmc -c "show ip policy"`` -- the mark behind every policy name;
* ``ndmc -c "show ip hotspot"`` -- the devices and the policy each one is in.
"""

from __future__ import annotations

import re
import subprocess
from typing import Any, Dict, List, Optional

from utils.firmware import run_ndmc

REDIR_CHAIN = "_NDM_HOTSPOT_DNSREDIR"
IPTABLES_BINARIES = ("/opt/sbin/iptables", "iptables")

# Verdicts a device can get.
REACHES = "reaches"
INTERCEPTED = "intercepted"
UNKNOWN = "unknown"


def _normalize_mark(value: Any) -> str:
    """Marks are written ``ffffaaa`` in one place and ``0xffffaaa`` in another."""
    text = str(value or "").strip().lower()
    if text.startswith("0x"):
        text = text[2:]
    text = text.lstrip("0")
    return text


def parse_policies(text: str) -> Dict[str, Dict[str, str]]:
    """Policy name -> its mark and the description the user sees.

    ``show ip policy`` writes one line naming the policy and an indented line
    with its mark::

        policy, name = Policy0, description = XKeen:
              mark: ffffaaa
    """
    policies: Dict[str, Dict[str, str]] = {}
    current = ""
    for line in str(text or "").splitlines():
        named = re.search(r"policy,\s*name\s*=\s*([^,]+),\s*description\s*=\s*(.*?)\s*:?\s*$", line)
        if named:
            current = named.group(1).strip()
            policies[current] = {"name": current, "description": named.group(2).strip(), "mark": ""}
            continue
        marked = re.search(r"^\s*mark:\s*(\S+)\s*$", line)
        if marked and current:
            policies[current]["mark"] = _normalize_mark(marked.group(1))
    return policies


def parse_redirects(text: str) -> List[Dict[str, str]]:
    """The port 53 redirects, one entry per rule.

    Only rules that actually take DNS away are of interest; the same chain also
    carries redirects for 1900 and 5351, which have nothing to do with names.
    """
    found: List[Dict[str, str]] = []
    for line in str(text or "").splitlines():
        if "--dport 53 " not in line + " " or "REDIRECT" not in line:
            continue
        mark = re.search(r"--mark\s+(\S+)", line)
        bridge = re.search(r"-i\s+(\S+)", line)
        address = re.search(r"-d\s+([0-9.]+)", line)
        port = re.search(r"--to-ports\s+(\d+)", line)
        if not mark:
            continue
        found.append(
            {
                "mark": _normalize_mark(mark.group(1)),
                "interface": bridge.group(1) if bridge else "",
                "address": address.group(1) if address else "",
                "to_port": port.group(1) if port else "",
            }
        )
    return found


def _usable_address(value: str) -> str:
    """An address the user can act on, or nothing.

    A device that has been away long enough loses its lease and the firmware
    prints ``0.0.0.0`` for it.  Showing that in the list is worse than showing
    nothing: it reads as a real address and there is no such host.
    """
    text = str(value or "").strip()
    return "" if text in {"0.0.0.0", "::", "0:0:0:0:0:0:0:0"} else text


def _bridge_of(interface_id: str) -> str:
    """``Bridge1`` in the device list is ``br1`` in the firewall rules."""
    match = re.match(r"^Bridge(\d+)$", str(interface_id or "").strip())
    return f"br{match.group(1)}" if match else ""


def parse_hosts(text: str) -> List[Dict[str, Any]]:
    """Devices from ``show ip hotspot``.

    The record is nested and reuses key names -- ``name`` belongs both to the
    device and to the interface block inside it -- so nesting has to be read
    rather than guessed.  The firmware right-aligns its keys, which means the
    indentation differs from line to line while the colon stays in one column:
    depth is the colon's position, not the leading spaces.  Everything deeper
    than the device's own fields is inside a nested block and is skipped,
    except the interface id, which says what segment the device is on.
    """
    hosts: List[Dict[str, Any]] = []
    current: Optional[Dict[str, Any]] = None
    own_depth = -1
    block = ""
    for raw in str(text or "").splitlines():
        line = raw.rstrip()
        if not line.strip():
            continue
        key_value = re.match(r"^\s*([A-Za-z0-9_-]+):\s*(.*)$", line)
        if not key_value:
            continue
        key, value = key_value.group(1), key_value.group(2).strip()
        depth = key_value.end(1)

        if key == "host":
            current = {
                "mac": "",
                "ip": "",
                "hostname": "",
                "name": "",
                "interface": "",
                "policy": "",
                "registered": False,
                "active": False,
            }
            hosts.append(current)
            own_depth = -1
            block = ""
            continue
        if current is None:
            continue

        # The first field after ``host:`` sets the depth of the device's own
        # keys; anything deeper is inside a nested block.
        if own_depth < 0:
            own_depth = depth
        if depth > own_depth:
            if block == "interface" and key == "id":
                current["interface"] = value
            continue
        block = key if not value else ""

        if key == "mac":
            current["mac"] = value.lower()
        elif key == "ip":
            current["ip"] = _usable_address(value)
        elif key == "hostname":
            current["hostname"] = value
        elif key == "name":
            current["name"] = value
        elif key == "policy":
            current["policy"] = value
        elif key == "registered":
            current["registered"] = value.lower() == "yes"
        elif key == "active":
            current["active"] = value.lower() == "yes"
    return hosts


def judge(
    hosts: List[Dict[str, Any]],
    policies: Dict[str, Dict[str, str]],
    redirects: List[Dict[str, str]],
) -> List[Dict[str, Any]]:
    """Say for every device whether its DNS reaches the feature."""
    by_mark: Dict[str, List[Dict[str, str]]] = {}
    for rule in redirects:
        by_mark.setdefault(rule["mark"], []).append(rule)

    verdicts: List[Dict[str, Any]] = []
    for host in hosts:
        policy_name = str(host.get("policy") or "").strip()
        policy = policies.get(policy_name) if policy_name else None
        label = (policy or {}).get("description") or policy_name
        mark = (policy or {}).get("mark") or ""

        if not policy_name:
            # No policy means no mark, and every redirect rule matches a mark.
            verdict, reason = REACHES, "устройство не состоит в политике доступа"
        elif not mark:
            verdict, reason = UNKNOWN, f"не удалось определить метку политики «{label}»"
        else:
            rules = by_mark.get(mark) or []
            bridge = _bridge_of(host.get("interface"))
            # Rules are per segment; without a readable segment stay cautious
            # and let any rule for this policy count.
            matched = [r for r in rules if not bridge or not r["interface"] or r["interface"] == bridge]
            if matched:
                verdict = INTERCEPTED
                reason = f"DNS перехватывает политика «{label}» и уводит на резолвер прошивки"
            else:
                verdict = REACHES
                reason = f"политика «{label}» DNS не перехватывает"

        verdicts.append(
            {
                "mac": host.get("mac") or "",
                "ip": host.get("ip") or "",
                "title": host.get("name") or host.get("hostname") or host.get("mac") or "",
                "policy": label,
                "active": bool(host.get("active")),
                "registered": bool(host.get("registered")),
                "verdict": verdict,
                "reason": reason,
            }
        )
    return verdicts


def _iptables_chain(chain: str) -> tuple[str, str]:
    """Dump one nat chain; returns the text and an error message, never raises."""
    last = ""
    for binary in IPTABLES_BINARIES:
        try:
            proc = subprocess.run(
                [binary, "-t", "nat", "-S", chain],
                capture_output=True,
                text=True,
                timeout=10,
            )
        except FileNotFoundError:
            last = "iptables не найден"
            continue
        except Exception as exc:  # noqa: BLE001 - reported, never raised on
            last = str(exc)
            continue
        if proc.returncode == 0:
            return proc.stdout or "", ""
        # A missing chain is an answer in itself: nothing is being redirected.
        text = (proc.stderr or "").strip()
        if "No chain" in text or "does not exist" in text:
            return "", ""
        last = text or f"iptables вернул код {proc.returncode}"
    return "", last or "не удалось прочитать правила"


def _ndmc(command: str) -> tuple[str, str]:
    try:
        run = run_ndmc(command)
    except FileNotFoundError:
        return "", "ndmc не найден — это не Keenetic"
    except Exception as exc:  # noqa: BLE001 - reported to the caller
        return "", str(exc)
    if run.rc != 0 and not run.stdout:
        return "", (run.stderr or "").strip() or f"ndmc вернул код {run.rc}"
    return run.stdout or "", ""


def client_report() -> Dict[str, Any]:
    """Everything the window needs to say who uses the feature and who does not."""
    redirect_text, redirect_error = _iptables_chain(REDIR_CHAIN)
    policy_text, policy_error = _ndmc("show ip policy")
    host_text, host_error = _ndmc("show ip hotspot")

    problem = redirect_error or policy_error or host_error
    if host_error or policy_error:
        return {
            "ok": False,
            "available": False,
            "error": problem,
            "clients": [],
            "counts": {"total": 0, "reaches": 0, "intercepted": 0, "unknown": 0},
        }

    policies = parse_policies(policy_text)
    redirects = parse_redirects(redirect_text)
    clients = judge(parse_hosts(host_text), policies, redirects)
    counts = {
        "total": len(clients),
        REACHES: sum(1 for item in clients if item["verdict"] == REACHES),
        INTERCEPTED: sum(1 for item in clients if item["verdict"] == INTERCEPTED),
        UNKNOWN: sum(1 for item in clients if item["verdict"] == UNKNOWN),
    }
    return {
        "ok": True,
        "available": True,
        # A failure to read the rules is not fatal -- say so instead of
        # quietly reporting that nothing is intercepted.
        "error": redirect_error,
        "clients": clients,
        "counts": counts,
        "policies": [
            {
                "name": item["name"],
                "description": item["description"],
                "intercepts": any(rule["mark"] == item["mark"] for rule in redirects),
            }
            for item in policies.values()
        ],
    }
