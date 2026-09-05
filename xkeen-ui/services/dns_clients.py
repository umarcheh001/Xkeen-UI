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
* ``ndmc -c "show ip hotspot"`` -- the devices and the policy each one is in;
* ``ndmc -c "show sc ip hotspot"`` -- the same binding as it is *configured*.

The last source exists because the state view cannot be relied on to carry it.
KeeneticOS 4.03.C.9.0 prints no ``policy`` field for any device at all, while
the build on the other test router prints it for every device, empty ones
included.  Read from the state view alone, a router of the first kind reports
that nobody is in a policy and therefore that everybody uses the feature --
which is the opposite of the truth for exactly the devices the window is about.
The configuration answers the same question on both builds, so it fills the
gaps; where the state view does say something, it stays the authority.
"""

from __future__ import annotations

import re
import subprocess
from typing import Any, Dict, List, Optional

from services import dns_client_capture
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
                "interface_name": "",
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
            elif block == "interface" and key == "name":
                # The configuration names segments the way the user does
                # (``Guest``), the device list by id (``Bridge1``); a policy
                # bound to a whole segment has to be matched by either.
                current["interface_name"] = value
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


def parse_hotspot_config(text: str) -> Dict[str, Dict[str, str]]:
    """Policy bindings from ``show sc ip hotspot``: per device and per segment.

    The configuration tree names each entry rather than nesting silently::

        config, name = host:
               mac: 10:f6:0a:a5:e7:9a
            config, name = policy, final = yes:
                policy: Policy1

    Only two entries matter -- ``host``, which binds one device, and
    ``policy``, which binds a whole segment.  They sit at one depth; the blocks
    inside them are deeper and never change which entry is being read.
    """
    hosts: Dict[str, str] = {}
    segments: Dict[str, str] = {}
    entry = ""
    entry_depth = -1
    subject = ""
    for raw in str(text or "").splitlines():
        opened = re.match(r"^(\s*)config,\s*name\s*=\s*([A-Za-z0-9_-]+)", raw)
        if opened:
            depth, name = len(opened.group(1)), opened.group(2)
            if name == "hotspot":
                continue
            if entry_depth < 0:
                entry_depth = depth
            if depth <= entry_depth:
                entry = name if name in {"host", "policy"} else ""
                subject = ""
            continue
        pair = re.match(r"^\s*([A-Za-z0-9_-]+):\s*(.*)$", raw)
        if not pair or not entry:
            continue
        key, value = pair.group(1), pair.group(2).strip()
        if entry == "host" and key == "mac" and value:
            subject = value.lower()
        elif entry == "policy" and key == "interface" and value:
            subject = value
        elif key == "policy" and value and subject:
            (hosts if entry == "host" else segments)[subject] = value
    return {"hosts": hosts, "segments": segments}


def apply_config_policies(
    hosts: List[Dict[str, Any]],
    bindings: Dict[str, Dict[str, str]],
) -> None:
    """Fill in the policy of every device the state view left blank.

    Only the blanks: a firmware that does report the binding keeps the last
    word, so reading the configuration cannot change what such a router shows.
    """
    by_mac = bindings.get("hosts") or {}
    by_segment = bindings.get("segments") or {}
    for host in hosts:
        if str(host.get("policy") or "").strip():
            continue
        segment = next(
            (
                by_segment[name]
                for name in (host.get("interface"), host.get("interface_name"))
                if name and name in by_segment
            ),
            "",
        )
        host["policy"] = by_mac.get(str(host.get("mac") or "").lower(), "") or segment


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

        # The resolver this device is being sent to instead of ours.  It is
        # also the address that answers its home names, so the window can name
        # it rather than make the user hunt for the right port.
        resolver = ""
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
                port = next((rule["to_port"] for rule in matched if rule["to_port"]), "")
                resolver = f"127.0.0.1:{port}" if port else ""
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
                # Only a device the firmware takes away has anything to gain
                # from a rule of ours; one that already arrives does not.
                "can_capture": verdict in (INTERCEPTED, UNKNOWN),
                "firmware_resolver": resolver,
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
    # A firmware that does not know this command leaves the state view to
    # answer alone, exactly as before it was asked for: not being able to read
    # the configuration is never a reason to refuse the report.
    config_text, _config_error = _ndmc("show sc ip hotspot")

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
    hosts = parse_hosts(host_text)
    apply_config_policies(hosts, parse_hotspot_config(config_text))
    clients = judge(hosts, policies, redirects)
    # What the firewall holds right now, not what the panel asked for: the two
    # part company whenever the firmware rebuilds its chains.
    captured = dns_client_capture.status()
    # Below the firmware's own redirect our chain is decoration -- but only for
    # a device that redirect matches at all.  It matches on the policy mark, so
    # a device no policy takes away falls through to our chain wherever the
    # chain sits, and its rule works.  Saying "заведено" for the first kind
    # would be a lie the user has no way to check; saying "не действует" for
    # the second would be one too.
    first = bool(captured.get("first"))
    for item in clients:
        item["captured"] = item["mac"] in captured.get("macs", [])
        if not item["captured"]:
            continue
        if first or item["verdict"] == REACHES:
            item["verdict"] = REACHES
            item["reason"] = "DNS заведён в туннель правилом панели"
        else:
            item["reason"] = (
                "правило панели есть, но стоит ниже правила прошивки и не действует"
            )
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
        "capture": captured,
        "policies": [
            {
                "name": item["name"],
                "description": item["description"],
                "intercepts": any(rule["mark"] == item["mark"] for rule in redirects),
            }
            for item in policies.values()
        ],
    }
