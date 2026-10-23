"""Разбор строк access.log и error.log Xray для таблицы и потока логов."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
MODULE = "./xkeen-ui/static/js/features/xray_log_parser.js"


def run_parser(lines: dict[str, str], fn: str = "parseXrayAccessLine") -> dict:
    if shutil.which("node") is None:
        pytest.skip("node is not available in this environment")
    script = f"""
    import * as parser from '{MODULE}';
    const lines = {json.dumps(lines, ensure_ascii=False)};
    const out = {{}};
    for (const [key, line] of Object.entries(lines)) out[key] = parser.{fn}(line);
    console.log(JSON.stringify(out));
    """
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT,
        check=True,
        capture_output=True,
        encoding="utf-8",
    )
    return json.loads(result.stdout)


def test_access_line_with_rule_route_and_email():
    out = run_parser({
        "line": "2026/10/22 14:03:11.482173 from 192.168.1.34:53122 accepted tcp:www.youtube.com:443 [tproxy-in -> sub--Frankfurt-2] email: phone",
    })["line"]
    assert out["time"] == "14:03:11"
    assert out["frac"] == ".482173"
    assert out["srcIp"] == "192.168.1.34"
    assert out["status"] == "accepted"
    assert (out["proto"], out["host"], out["port"]) == ("tcp", "www.youtube.com", "443")
    assert (out["inTag"], out["mark"], out["outTag"]) == ("tproxy-in", "->", "sub--Frankfurt-2")
    assert out["kind"] == "proxy"
    assert out["email"] == "phone"
    assert out["reason"] == ""


def test_access_route_marks_and_service_outbounds():
    out = run_parser({
        "default": "2026/10/22 14:03:12 from 192.168.1.20:61002 accepted tcp:api.github.com:443 [redirect-in >> direct]",
        "balancer": "2026/10/22 14:03:12 from 192.168.1.20:61003 accepted tcp:chatgpt.com:443 [tproxy-in ==> sub--Helsinki]",
        "block": "2026/10/22 14:03:12 from 192.168.1.51:40211 accepted tcp:ads.doubleclick.net:443 [redirect-in -> block]",
        "dns": "2026/10/22 14:03:13 from 192.168.1.51:40219 accepted udp:8.8.8.8:53 [tproxy-in -> dns-out]",
        "bare": "2026/10/22 14:03:13 from 127.0.0.1:40219 accepted tcp:example.com:443 [my_proxy]",
        "none": "2026/10/22 14:03:13 from 127.0.0.1:40219 accepted tcp:example.com:443",
    })
    assert (out["default"]["mark"], out["default"]["kind"]) == (">>", "direct")
    assert (out["balancer"]["mark"], out["balancer"]["outTag"]) == ("==>", "sub--Helsinki")
    assert out["block"]["kind"] == "block"
    assert (out["dns"]["kind"], out["dns"]["outKind"]) == ("dns", "dns")
    assert (out["default"]["outKind"], out["block"]["outKind"]) == ("direct", "block")
    assert (out["bare"]["inTag"], out["bare"]["outTag"], out["bare"]["kind"]) == ("", "my_proxy", "proxy")
    assert (out["none"]["outTag"], out["none"]["kind"]) == ("", "")


def test_access_line_with_protocol_prefix_and_ipv6():
    out = run_parser({
        "prefixed": "2026/10/22 14:03:13 from tcp:127.0.0.1:50122 accepted tcp:www.google.com:443 [socks >> direct]",
        "ipv6": "2026/10/22 14:03:13.902 from [fd00::1c4]:50122 accepted tcp:[2a00:1450:4010:c05::64]:443 [tproxy-in -> sub--Amsterdam]",
    })
    assert (out["prefixed"]["srcProto"], out["prefixed"]["srcIp"]) == ("tcp", "127.0.0.1")
    assert out["ipv6"]["srcIp"] == "fd00::1c4"
    assert (out["ipv6"]["host"], out["ipv6"]["port"]) == ("2a00:1450:4010:c05::64", "443")


def test_lines_seen_on_a_router():
    """Строки с живого роутера (22.10.2026): DNS-клиент Xray пишет источник без порта."""
    out = run_parser({
        "dns_client": "2026/10/22 19:15:33.342080 from DNS accepted udp:8.8.8.8:53 [dns-in -> VPS_CH_SUB--CH_reality-Node-16k3]",
        "dns_listener": "2026/10/22 19:15:33.341456 from 192.168.46.52:59759 accepted udp:127.0.0.1:53 [xk-dns-listener -> dns-out]",
        "subscription": "2026/10/22 19:15:40.100200 from 192.168.46.52:52211 accepted tcp:www.google.com:443 [redirect -> VPS_LV_SUB--LV_reality-Node-16k3]",
    })
    assert (out["dns_client"]["srcIp"], out["dns_client"]["srcPort"]) == ("DNS", "")
    # Свой DNS-клиент ядра — это DNS, хотя уходит через узел: маршрут красится по outKind.
    assert (out["dns_client"]["host"], out["dns_client"]["kind"], out["dns_client"]["outKind"]) == ("8.8.8.8", "dns", "proxy")
    assert (out["dns_listener"]["inTag"], out["dns_listener"]["kind"]) == ("xk-dns-listener", "dns")
    assert out["subscription"]["outTag"] == "VPS_LV_SUB--LV_reality-Node-16k3"


def test_rejected_line_keeps_reason_without_destination():
    out = run_parser({
        "rejected": "2026/10/22 14:03:14 from 203.0.113.7:51234 rejected  proxy/vless/encoding: invalid request user id",
    })["rejected"]
    assert out["status"] == "rejected"
    assert out["host"] == ""
    assert out["kind"] == "block"
    assert out["reason"] == "proxy/vless/encoding: invalid request user id"


def test_foreign_lines_stay_unparsed():
    out = run_parser({
        "dns": "2026/10/22 14:03:14 localhost got answer: www.google.com. -> [142.250.74.36] 1ms",
        "error": "2026/10/22 14:03:14 [Info] [3021554] proxy/vless/outbound: tunneling request",
        "empty": "",
        "garbage": "from nowhere accepted",
    })
    assert out == {"dns": None, "error": None, "empty": None, "garbage": None}


def test_error_lines_give_level_session_module_and_message():
    out = run_parser({
        "info": "2026/10/22 14:02:58.114 [Info] [3021554] proxy/vless/outbound: tunneling request to tcp:www.youtube.com:443 via 203.0.113.10:443",
        "warn": "2026/10/22 14:03:01 [Warning] app/dispatcher: default route for tcp:149.154.167.51:443",
        "plain": "2026/10/22 14:03:01 [Error] failed to start: something",
        "access": "2026/10/22 14:03:11 from 192.168.1.34:53122 accepted tcp:www.youtube.com:443",
    }, fn="parseXrayErrorLine")
    assert (out["info"]["level"], out["info"]["session"], out["info"]["module"]) == ("info", "3021554", "proxy/vless/outbound")
    assert out["info"]["message"].startswith("tunneling request")
    assert (out["warn"]["level"], out["warn"]["session"], out["warn"]["module"]) == ("warning", "", "app/dispatcher")
    assert (out["plain"]["level"], out["plain"]["module"], out["plain"]["message"]) == ("error", "", "failed to start: something")
    assert out["access"] is None


def test_registrable_domain_groups_hosts_for_the_summary():
    out = run_parser({
        "cdn": "rr3---sn-4g5e6nsz.googlevideo.com",
        "two": "github.com",
        "uk": "news.bbc.co.uk",
        "ip": "149.154.167.51",
        "v6": "2a00:1450::64",
    }, fn="xrayRegistrableDomain")
    assert out == {"cdn": "googlevideo.com", "two": "github.com", "uk": "bbc.co.uk", "ip": "149.154.167.51", "v6": "2a00:1450::64"}
