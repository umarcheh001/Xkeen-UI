"""Read optional HiLink telemetry from the modem address reported by RCI."""

import ipaddress
import re
import time
import urllib.request
import xml.etree.ElementTree as ET


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def modem_web_address(item):
    try:
        host = ipaddress.IPv4Address(item.get("web_address", ""))
        network = ipaddress.IPv4Network(f"{item['address']}/{item['mask']}", strict=False)
        if (host.is_private and not host.is_loopback and not host.is_link_local
                and not host.is_unspecified and not host.is_multicast
                and network.prefixlen >= 16 and host in network
                and host not in (network.network_address, network.broadcast_address)
                and str(host) != item["address"]):
            return str(host)
    except (ValueError, KeyError, TypeError):
        pass
    return None


def _fetch(host, path, timeout):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
    with opener.open(f"http://{host}/api/{path}", timeout=timeout) as response:
        data = response.read(65537)
    if len(data) > 65536 or b"<!" in data:
        raise ValueError("invalid_modem_xml")
    root = ET.fromstring(data)
    if root.tag != "response":
        return {}
    if path == "dialup/profiles":
        current = root.findtext("CurrentProfile")
        for profile in root.findall("./Profiles/Profile"):
            if profile.findtext("Index") == current:
                return {key: (profile.findtext(key) or "")[:96] for key in ("Name", "ApnName")}
        return {}
    return {child.tag: (child.text or "").strip()[:256] for child in root if len(child) == 0}


def _number(value):
    match = re.fullmatch(r"\s*(-?\d+(?:\.\d+)?)\s*(?:dBm|dB|MHz|kHz)?\s*", str(value or ""))
    return float(match[1]) if match else None


def enrich_modem(item, *, fetcher=_fetch, clock=time.monotonic, budget=6):
    """Fixed GETs only; an unavailable/authenticated API leaves RCI usable."""
    host = modem_web_address(item)
    if not host or item.get("interface_type") != "CdcEthernet":
        return
    deadline = clock() + min(6, max(0, budget))
    details = item.setdefault("details", {})
    succeeded = False
    for path in ("device/information", "device/signal", "dialup/profiles", "monitoring/traffic-statistics", "net/current-plmn"):
        remaining = deadline - clock()
        if remaining <= 0:
            break
        try:
            data = fetcher(host, path, min(1.5, remaining))
        except (OSError, ValueError, ET.ParseError):
            if path == "device/information":
                return
            continue
        if path == "device/information" and (not item.get("imei") or data.get("Imei") != item["imei"]):
            return
        if not data:
            continue
        succeeded = True
        if path == "device/signal":
            for source, target in (("rsrp", "rsrp"), ("rsrq", "rsrq"), ("rssi", "rssi"), ("sinr", "cinr"), ("dlbandwidth", "bandwidth")):
                value = _number(data.get(source))
                if value is not None:
                    item[target] = value
            for source, target in (("band", "band"), ("pci", "phy_cell_id"), ("tac", "tac"), ("cell_id", "base_station"), ("enodeb_id", "enb_id")):
                if data.get(source):
                    item[target] = data[source]
            earfcn = re.search(r"(?:DL:)?\s*(\d+)", data.get("earfcn", ""))
            if earfcn:
                item["earfcn"] = int(earfcn[1])
            cell, station = data.get("cell_id", ""), data.get("enodeb_id", "")
            if cell.isdecimal() and station.isdecimal() and int(cell) // 256 == int(station):
                item["sector_id"] = str(int(cell) % 256)
            # A single reported band does not prove carrier aggregation.
            for key in ("cell_id", "earfcn", "ulbandwidth", "dlbandwidth", "ulfrequency", "dlfrequency", "txpower", "transmode", "rrc_status", "cqi0", "cqi1", "ul_mcs", "dl_mcs", "rscp", "ecio", "lac", "rac", "plmn"):
                if data.get(key):
                    details[key] = data[key]
        elif path == "device/information":
            for source, target in (("HardwareVersion", "hardware"), ("SoftwareVersion", "software"), ("WebUIVersion", "webui"), ("WanIPAddress", "wan_address"), ("WanIPv6Address", "wan_ipv6"), ("wan_dns_address", "wan_dns"), ("wan_ipv6_dns_address", "wan_ipv6_dns"), ("supportmode", "supported_networks"), ("workmode", "workmode"), ("iniversion", "customization")):
                if data.get(source):
                    details[target] = data[source]
            for source, target in (("SerialNumber", "serial"), ("Iccid", "iccid"), ("Imsi", "imsi"), ("Msisdn", "phone")):
                if data.get(source):
                    details[target] = "•••• " + data[source][-4:]
        elif path == "dialup/profiles":
            if data.get("ApnName"):
                item["apn"] = data["ApnName"]
            if data.get("Name"):
                details["profile"] = data["Name"]
        elif path == "monitoring/traffic-statistics":
            traffic = {}
            for source, target in (("CurrentConnectTime", "session_seconds"), ("CurrentUpload", "sent_bytes"), ("CurrentDownload", "received_bytes"), ("CurrentUploadRate", "send_bytes_per_second"), ("CurrentDownloadRate", "receive_bytes_per_second"), ("TotalUpload", "total_sent_bytes"), ("TotalDownload", "total_received_bytes"), ("TotalConnectTime", "total_seconds")):
                value = data.get(source, "")
                if re.fullmatch(r"\d{1,20}", value):
                    traffic[target] = int(value)
            item["traffic"] = traffic
        elif data.get("Numeric"):
            details["plmn"] = data["Numeric"]
    item["web_telemetry"] = succeeded
