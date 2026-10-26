"""Pure parsing of the router firmware's RCI JSON for the diagnostics history.

Ports, Wi-Fi radio temperatures, model and firmware come from
``show/interface`` and ``show/version``.  Nothing here does I/O.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

WAN_LABEL = "WAN"
SLOW_MBPS = 100
FAST_MBPS = 1000


@dataclass
class Port:
    id: str
    label: str
    is_wan: bool
    link: bool
    speed_mbps: int | None
    duplex: str | None
    description: str


def _dict(value: Any) -> dict:
    return value if isinstance(value, dict) else {}


def _int(value: Any) -> int | None:
    try:
        number = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _is_wan_interface(record: dict) -> bool:
    return record.get("defaultgw") is True or str(record.get("defaultgw")).lower() in ("yes", "true")


def _wan_record(show_interface: dict) -> dict | None:
    for record in show_interface.values():
        record = _dict(record)
        if record.get("type") == "Port" or not _is_wan_interface(record):
            continue
        if _dict(record.get("port")).get("type") == "Port":
            return record
    for record in show_interface.values():
        record = _dict(record)
        if record.get("type") != "Port" and _is_wan_interface(record):
            return record
    return None


def _port_records(show_interface: dict) -> list[dict]:
    """Every Port record once; the firmware lists each both nested and flat."""
    found: dict[str, dict] = {}

    def add(record: Any) -> None:
        record = _dict(record)
        if record.get("type") == "Port" and record.get("id") is not None:
            found.setdefault(str(record["id"]), record)

    for record in show_interface.values():
        record = _dict(record)
        add(record)
        nested = record.get("port")
        if isinstance(nested, dict):
            if nested.get("type") == "Port":
                add(nested)
            else:
                for child in nested.values():
                    add(child)
    return list(found.values())


def _port(record: dict, is_wan: bool, label: str, description: str) -> Port:
    link = str(record.get("link", "")).lower() == "up"
    duplex = record.get("duplex")
    return Port(
        id=WAN_LABEL if is_wan else label,
        label=label,
        is_wan=is_wan,
        link=link,
        speed_mbps=_int(record.get("speed")) if link else None,
        duplex=str(duplex) if link and duplex else None,
        description=description,
    )


def _lan_key(port: Port) -> tuple[int, str]:
    number = _int(port.id)
    return (number if number is not None else 10**6, port.id)


def parse_ports(show_interface: dict) -> list[Port]:
    """WAN first, then LAN ports by number."""
    if not isinstance(show_interface, dict):
        return []
    wan = _wan_record(show_interface)
    wan_port_id = str(_dict(wan.get("port")).get("id")) if wan and _dict(wan.get("port")) else None
    ports: list[Port] = []
    wan_port: Port | None = None
    for record in _port_records(show_interface):
        record_id = str(record["id"])
        name = str(record.get("label") or record.get("interface-name") or record_id)
        if wan_port_id is not None and record_id == wan_port_id:
            wan_port = _port(record, True, WAN_LABEL, str(wan.get("description") or ""))
        else:
            ports.append(_port(record, False, name, ""))
    ports.sort(key=_lan_key)
    return ([wan_port] if wan_port else []) + ports


def slow_ports(ports: list[Port]) -> list[Port]:
    """LAN ports negotiated at 100 Mbit/s while some port runs at 1000."""
    if not any(p.speed_mbps == FAST_MBPS for p in ports):
        return []
    return [p for p in ports if not p.is_wan and p.speed_mbps == SLOW_MBPS]


def wifi_temperatures(show_interface: dict) -> dict[str, float | None]:
    """Radio temperatures; a radio that is off or without a reading gives None."""
    data = _dict(show_interface)
    result: dict[str, float | None] = {}
    for key, name in (("wifi24", "WifiMaster0"), ("wifi5", "WifiMaster1")):
        record = _dict(data.get(name))
        value = None
        if str(record.get("link", "up")).lower() != "down":
            try:
                value = float(record["temperature"])
            except (KeyError, TypeError, ValueError):
                value = None
        result[key] = value
    return result


def router_identity(show_version: dict) -> dict:
    data = _dict(show_version)
    description = data.get("description")
    title = data.get("title")
    return {
        "model": str(description) if description else None,
        "firmware": f"KeeneticOS {title}" if title else None,
    }


def wan_interface(show_interface: dict) -> str | None:
    """RCI name of the default-gateway interface (for example ``ISP``).

    The kernel name used in ``/proc/net/dev`` comes from
    ``show/interface/system-name`` -- see :func:`parse_system_name`.
    """
    if not isinstance(show_interface, dict):
        return None
    record = _wan_record(show_interface)
    if not record:
        return None
    name = record.get("interface-name") or record.get("id")
    return str(name) if name else None


def internet_connections(show_interface: dict) -> list[dict]:
    """Connections to the internet (``global: true``), highest priority first.

    Cable, PPPoE, an LTE modem or a second WAN carry that flag; VPN tunnels and
    the Wi-Fi client do not.  ``id`` is the RCI id (the key of the tariff),
    ``interface_name`` is what ``show/interface/system-name`` takes.
    """
    if not isinstance(show_interface, dict):
        return []
    found: list[dict] = []
    for key, record in show_interface.items():
        record = _dict(record)
        if record.get("type") == "Port" or record.get("global") is not True:
            continue
        conn_id = str(record.get("id") or key)
        interface_name = str(record.get("interface-name") or conn_id)
        priority = _int(record.get("priority"))
        found.append(
            {
                "id": conn_id,
                "interface_name": interface_name,
                "label": str(record.get("description") or "").strip() or interface_name,
                "priority": priority if priority is not None else 0,
                "connected": str(record.get("connected", "")).lower() in ("yes", "true"),
            }
        )
    found.sort(key=lambda c: (-c["priority"], c["id"]))
    return found


def default_route_iface(proc_net_route: str) -> str | None:
    """Kernel interface of the main-table default route (lowest metric)."""
    best: tuple[int, str] | None = None
    for line in str(proc_net_route or "").splitlines()[1:]:
        cols = line.split()
        if len(cols) < 8:
            continue
        try:
            flags = int(cols[3], 16)
            metric = int(cols[6])
        except ValueError:
            continue
        if cols[1] != "00000000" or cols[7] != "00000000" or not flags & 0x1:
            continue
        if best is None or metric < best[0]:
            best = (metric, cols[0])
    return best[1] if best else None


def wan_label(show_interface: dict, kernel_iface: str, system_name: str | None) -> str:
    """Provider description if the RCI WAN is the default-route interface, else the kernel name."""
    if system_name and system_name == kernel_iface and isinstance(show_interface, dict):
        record = _wan_record(show_interface)
        description = str(record.get("description") or "").strip() if record else ""
        if description:
            return description
    return kernel_iface


def parse_system_name(payload: Any) -> str | None:
    """Kernel interface name from the ``system-name`` reply (a JSON string)."""
    if not isinstance(payload, str):
        return None
    return payload.strip() or None
