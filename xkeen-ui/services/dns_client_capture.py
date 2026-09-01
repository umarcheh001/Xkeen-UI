"""Bringing chosen devices back to DNS-over-VLESS when the firmware takes them.

KeeneticOS redirects port 53 to its own ``ndnproxy`` before a packet can reach
the Xray socket, and it does so per access policy: a device that belongs to any
policy never reaches the feature, a device in none arrives.  ``dns_clients``
answers who is on which side; this module is the other half -- it puts a chain
of our own first in ``nat PREROUTING`` and sends the chosen devices' port 53
back to the router's own 53, where Xray listens.  ``REDIRECT`` terminates the
nat table for that packet, so being first is what decides the outcome.

Everything is written per MAC rather than per address: the address changes with
every lease, the MAC does not, and the choice has to survive the device being
away.

The chain is ours alone -- created, filled and removed as a whole.  The
firmware's own chains are never edited: that is what makes the feature
removable, and what makes a leftover rule easy to spot.
"""

from __future__ import annotations

import re
import subprocess
from typing import Any, Dict, List

CHAIN = "XKEEN_UI_DNS"
PARENT_CHAIN = "PREROUTING"
IPTABLES_BINARIES = ("/opt/sbin/iptables", "iptables")
MAX_CAPTURE_CLIENTS = 64
DNS_PORT = 53

MAC_RE = re.compile(r"^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$")


class CaptureError(RuntimeError):
    """A firewall change could not be made; the caller decides how loud to be."""


def normalize_macs(value: Any) -> List[str]:
    """Accept a list or a separated string; keep order, drop repeats."""
    if isinstance(value, (list, tuple, set)):
        parts = [str(item) for item in value]
    else:
        parts = re.split(r"[,;\s]+", str(value or ""))
    result: List[str] = []
    for part in parts:
        text = part.strip().lower().replace("-", ":")
        if not text:
            continue
        if not MAC_RE.match(text):
            raise CaptureError(f"«{part.strip()}» не похоже на MAC-адрес устройства.")
        if text not in result:
            result.append(text)
    if len(result) > MAX_CAPTURE_CLIENTS:
        raise CaptureError(
            f"Слишком много устройств: не больше {MAX_CAPTURE_CLIENTS}."
        )
    return result


def _run(args: List[str]) -> tuple[int, str, str]:
    """Run iptables once; returns code, stdout and stderr, never raises."""
    last = "iptables не найден"
    for binary in IPTABLES_BINARIES:
        try:
            proc = subprocess.run(
                [binary, "-t", "nat", *args],
                capture_output=True,
                text=True,
                timeout=10,
            )
        except FileNotFoundError:
            continue
        except Exception as exc:  # noqa: BLE001 - reported to the caller
            last = str(exc)
            continue
        return proc.returncode, proc.stdout or "", (proc.stderr or "").strip()
    return 127, "", last


def _must(args: List[str]) -> None:
    rc, _out, err = _run(args)
    if rc != 0:
        raise CaptureError(err or f"iptables вернул код {rc} на {' '.join(args)}")


def _rules_for(mac: str) -> List[List[str]]:
    """The pair of rules that sends one device's DNS to our own port 53."""
    return [
        [
            "-A", CHAIN,
            "-p", protocol,
            "-m", "mac", "--mac-source", mac,
            "-m", protocol, "--dport", str(DNS_PORT),
            "-j", "REDIRECT", "--to-ports", str(DNS_PORT),
        ]
        for protocol in ("udp", "tcp")
    ]


def parse_macs(text: str) -> List[str]:
    """Devices named by the chain as it stands now."""
    found: List[str] = []
    for line in str(text or "").splitlines():
        if "REDIRECT" not in line or f"--dport {DNS_PORT} " not in line + " ":
            continue
        mac = re.search(r"--mac-source\s+(\S+)", line)
        if not mac:
            continue
        value = mac.group(1).strip().lower()
        if value not in found:
            found.append(value)
    return found


def _jump_index(text: str) -> int:
    """Position of the jump into our chain inside PREROUTING, 0 when absent.

    Position matters and nothing else does: the firmware's redirect sits in the
    same chain, and whichever ``REDIRECT`` is reached first ends the table.
    """
    index = 0
    for line in str(text or "").splitlines():
        if not line.startswith(f"-A {PARENT_CHAIN} "):
            continue
        index += 1
        if line.rstrip().endswith(f"-j {CHAIN}"):
            return index
    return 0


def status() -> Dict[str, Any]:
    """What the firewall holds right now, without changing anything."""
    rc, chain_text, chain_err = _run(["-S", CHAIN])
    if rc != 0:
        # A missing chain is an answer: iptables works, nothing is captured.
        missing = "No chain" in chain_err or "does not exist" in chain_err
        return {
            "available": missing,
            "present": False,
            "first": False,
            "macs": [],
            "error": "" if missing else chain_err,
        }
    rc, parent_text, parent_err = _run(["-S", PARENT_CHAIN])
    position = _jump_index(parent_text) if rc == 0 else 0
    return {
        "available": True,
        "present": True,
        "first": position == 1,
        "macs": parse_macs(chain_text),
        "error": parent_err if rc != 0 else "",
    }


def remove() -> bool:
    """Take the chain away entirely; returns whether anything was there.

    Order matters: the jump goes first, so that no packet can enter a chain
    that is being emptied.  A chain that was never created is not an error --
    this runs on every disable, including the ones that had nothing to undo.
    """
    changed = False
    rc, parent_text, _err = _run(["-S", PARENT_CHAIN])
    while rc == 0 and _jump_index(parent_text):
        _must(["-D", PARENT_CHAIN, "-j", CHAIN])
        changed = True
        rc, parent_text, _err = _run(["-S", PARENT_CHAIN])
    rc, _out, _err = _run(["-S", CHAIN])
    if rc == 0:
        _must(["-F", CHAIN])
        _must(["-X", CHAIN])
        changed = True
    return changed


def ensure(macs: Any) -> Dict[str, Any]:
    """Make the firewall say exactly what was asked, and nothing more.

    Called on every apply and on every guard tick, so it has to be cheap when
    there is nothing to do and exact when there is: the firmware rebuilds its
    own chains whenever policies or interfaces change, and our jump can end up
    below the redirect it is meant to precede.
    """
    wanted = normalize_macs(macs)
    if not wanted:
        return {"ok": True, "changed": remove(), "macs": []}

    changed = False
    rc, chain_text, chain_err = _run(["-S", CHAIN])
    if rc != 0:
        if not ("No chain" in chain_err or "does not exist" in chain_err):
            raise CaptureError(chain_err or "не удалось прочитать правила")
        _must(["-N", CHAIN])
        chain_text = ""
        changed = True

    if parse_macs(chain_text) != wanted:
        if chain_text.strip():
            _must(["-F", CHAIN])
        for mac in wanted:
            for rule in _rules_for(mac):
                _must(rule)
        changed = True

    rc, parent_text, parent_err = _run(["-S", PARENT_CHAIN])
    if rc != 0:
        raise CaptureError(parent_err or "не удалось прочитать PREROUTING")
    position = _jump_index(parent_text)
    if position != 1:
        # Below the firmware's own redirect the chain is decoration: that rule
        # ends the table before ours is reached.
        if position:
            _must(["-D", PARENT_CHAIN, "-j", CHAIN])
        _must(["-I", PARENT_CHAIN, "1", "-j", CHAIN])
        changed = True

    return {"ok": True, "changed": changed, "macs": wanted}
