"""Where the firmware still answers DNS after Xray has taken port 53.

KeeneticOS runs one ``ndnproxy`` per access policy plus a main one.  The main
process names no port in its config, which means it listens on 53 -- and 53 is
ours the moment DNS-over-VLESS is on, so the only resolvers left that can
answer for home names are the per-policy ones on their own ports.

Read the config files rather than the firewall.  ``dns_clients`` learns a
device's resolver port from ``_NDM_HOTSPOT_DNSREDIR``, but the firmware writes
those rules only for policies that already hold a host, while a config file
exists for every policy.  Files are also fast enough for the status call, which
``ndmc`` is not.

Which policy the resolver belongs to does not matter here: measured on a
router, the per-policy configs carry identical ``static_a`` substitutions and
share one ``/var/ndnproxyhostmap.conf``, and all three answered a KeenDNS name
with the same address.  They differ only in the path they take outwards, and
this resolver is never asked about anything but local zones.
"""

from __future__ import annotations

import glob
import os
import re
from typing import List, Optional

# The firmware writes its generated configs here.
NDNPROXY_CONF_DIR = "/var"
# ``ndnproxymain.conf`` deliberately does not match: see the module docstring.
NDNPROXY_CONF_PATTERN = "ndnproxy_*.conf"
LOOPBACK = "127.0.0.1"
# The port DNS-over-VLESS itself listens on; a resolver there would loop.
LISTENER_PORT = 53
# Same ceiling as MAX_LOCAL_RESOLVERS in dns_over_vless: the whole list is
# offered as local resolvers, so it must fit there.
MAX_RESOLVERS = 16
# The range ``discover`` can actually produce: port 41100 plus one per policy.
# A guard uses this to tell "an address we could have written" from anything
# else that happens to sit on loopback -- see ``looks_like_ours``.
RESOLVER_PORT_BASE = 41100
RESOLVER_PORT_CEILING = RESOLVER_PORT_BASE + MAX_RESOLVERS

_PORT_RE = re.compile(r"^\s*dns_udp_port\s*=\s*(\d+)\s*(?:#.*)?$", re.MULTILINE)


def parse_listen_port(text: str) -> int:
    """The UDP port one ndnproxy config listens on, or 0 when it names none."""
    match = _PORT_RE.search(str(text or ""))
    if not match:
        return 0
    try:
        port = int(match.group(1))
    except ValueError:
        return 0
    return port if 1 <= port <= 65535 else 0


def looks_like_ours(address: str) -> bool:
    """Could ``discover`` plausibly have produced this address?

    Used by the guard to tell a firmware resolver it once wrote from a
    resolver the user pointed at something else entirely -- a home server,
    Pi-hole, AdGuard -- which just as legitimately sits outside ``found`` and
    must never be treated as stale.  Never raises: garbage in means "no".
    """
    text = str(address or "").strip()
    if not text or ":" not in text:
        return False
    host, _, raw_port = text.rpartition(":")
    if host != LOOPBACK:
        return False
    try:
        port = int(raw_port)
    except ValueError:
        return False
    return RESOLVER_PORT_BASE <= port <= RESOLVER_PORT_CEILING


def discover(conf_dir: Optional[str] = None) -> List[str]:
    """Addresses of the firmware's own resolvers, lowest port first.

    Never raises: a machine that is not a Keenetic simply has no such files,
    and the caller shows an empty list instead of an error.
    """
    if conf_dir is None:
        conf_dir = NDNPROXY_CONF_DIR
    try:
        paths = sorted(glob.glob(os.path.join(str(conf_dir), NDNPROXY_CONF_PATTERN)))
    except Exception:
        return []
    ports: List[int] = []
    for path in paths:
        try:
            text = _read_text(path)
        except Exception:
            continue
        port = parse_listen_port(text)
        if not port or port == LISTENER_PORT or port in ports:
            continue
        ports.append(port)
    ports.sort()
    return [f"{LOOPBACK}:{port}" for port in ports[:MAX_RESOLVERS]]


def _read_text(path: str) -> str:
    with open(path, encoding="utf-8", errors="replace") as handle:
        return handle.read()
