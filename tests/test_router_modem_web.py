import pytest

from services.router_modem_web import _fetch, enrich_modem, modem_web_address


def modem():
    return {"interface_type": "CdcEthernet", "web_address": "192.168.8.1", "address": "192.168.8.129", "mask": "255.255.255.0", "imei": "111111111111111", "rsrp": -110}


@pytest.mark.parametrize("host", ["127.0.0.1", "169.254.1.1", "8.8.8.8", "192.168.9.1", "192.168.8.129", "192.168.8.255", "modem.example", "192.168.8.1:8080", "http://192.168.8.1"])
def test_rejects_addresses_outside_modem_subnet(host):
    assert modem_web_address({**modem(), "web_address": host}) is None


def test_combines_only_whitelisted_fields_from_same_modem():
    item = modem()
    responses = {
        "device/information": {"Imei": item["imei"], "HardwareVersion": "CL5E3372M", "Imsi": "secret", "WanIPAddress": "10.0.0.2"},
        "device/signal": {"rsrp": "-108dBm", "band": "1", "dlbandwidth": "15MHz", "pci": "445", "cell_id": "67130726", "tac": "3626", "earfcn": "DL:525 UL:18525"},
        "dialup/profiles": {"Name": "internet", "ApnName": "internet.example"},
        "monitoring/traffic-statistics": {"CurrentDownload": "41217928", "CurrentUploadRate": "0", "TotalDownload": "invalid"},
        "net/current-plmn": {"Numeric": "25099"},
    }
    calls = []

    def fetch(host, path, timeout):
        assert host == "192.168.8.1" and 0 < timeout <= 1.5
        calls.append(path)
        return responses[path]

    enrich_modem(item, fetcher=fetch)
    assert len(calls) == 5 and item["web_telemetry"]
    assert item["rsrp"] == -108 and item["bandwidth"] == 15
    assert item["earfcn"] == 525 and item["tac"] == "3626"
    assert item["apn"] == "internet.example"
    assert item["details"]["hardware"] == "CL5E3372M"
    assert "Imsi" not in item["details"]
    assert item["traffic"] == {"received_bytes": 41217928, "send_bytes_per_second": 0}


@pytest.mark.parametrize("identity", [None, "222222222222222"])
def test_no_enrichment_when_identity_cannot_be_confirmed(identity):
    item = modem()
    calls = []

    def fetch(host, path, timeout):
        calls.append(path)
        return {"Imei": identity}

    enrich_modem(item, fetcher=fetch)
    assert calls == ["device/information"]
    assert item["rsrp"] == -110 and not item.get("web_telemetry")


def test_unavailable_api_keeps_rci_data():
    item = modem()

    def fail(*args):
        raise OSError("unavailable")

    enrich_modem(item, fetcher=fail)
    assert item["rsrp"] == -110 and not item.get("web_telemetry")


def test_profile_parser_returns_only_active_profile_without_credentials(monkeypatch):
    import io
    from services import router_modem_web as web

    xml = b'''<response><CurrentProfile>2</CurrentProfile><Profiles>
      <Profile><Index>1</Index><Name>old</Name><ApnName>old.example</ApnName></Profile>
      <Profile><Index>2</Index><Name>active</Name><ApnName>internet.example</ApnName><Password>secret</Password></Profile>
    </Profiles></response>'''

    class Opener:
        def open(self, url, timeout):
            assert url == "http://192.168.8.1/api/dialup/profiles"
            return io.BytesIO(xml)

    monkeypatch.setattr(web.urllib.request, "build_opener", lambda *args: Opener())
    assert _fetch("192.168.8.1", "dialup/profiles", 1) == {"Name": "active", "ApnName": "internet.example"}


def test_web_requests_stop_at_overall_deadline():
    item = modem()
    now = [0]
    calls = []

    def fetch(host, path, timeout):
        calls.append(path)
        now[0] += 3
        return {"Imei": item["imei"]}

    enrich_modem(item, fetcher=fetch, clock=lambda: now[0])
    assert calls == ["device/information", "device/signal"]
