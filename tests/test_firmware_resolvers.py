# tests/test_firmware_resolvers.py
"""Порты резолверов прошивки берутся из её же конфигов.

KeeneticOS держит по одному ndnproxy на политику доступа, и порт каждого
записан в его конфиге. Главный ndnproxy порта не называет — он на 53,
а 53 после включения DNS-over-VLESS занимает Xray.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "xkeen-ui"))

from services import firmware_resolvers as fr  # noqa: E402

POLICY_CONF = """timeout = 7000
proceed = 500
stat_file = /var/ndnproxy_Policy0.stat
dns_server = 127.0.0.1:40516 . # 77.88.8.8:853@common.dot.dns.yandex.net
static_a = whatsapp.com 213.176.74.63 0
set-profile-ip 127.0.0.1 0
dns_tcp_port = {port}
dns_udp_port = {port}
"""

MAIN_CONF = """rpc_port = 54321
timeout = 7000
rr_port = 40901
set-profile-ip 127.0.0.1 0
"""


def _policy(dir_path: Path, index: int, port: int) -> None:
    (dir_path / f"ndnproxy_Policy{index}.conf").write_text(
        POLICY_CONF.format(port=port), encoding="utf-8"
    )


def test_finds_every_policy_resolver_sorted_by_port(tmp_path: Path):
    _policy(tmp_path, 1, 41101)
    _policy(tmp_path, 0, 41100)
    _policy(tmp_path, 2, 41102)

    assert fr.discover(str(tmp_path)) == [
        "127.0.0.1:41100",
        "127.0.0.1:41101",
        "127.0.0.1:41102",
    ]


def test_main_resolver_is_not_offered(tmp_path: Path):
    # У главного ndnproxy нет dns_udp_port: он слушает 53, а там Xray.
    (tmp_path / "ndnproxymain.conf").write_text(MAIN_CONF, encoding="utf-8")
    _policy(tmp_path, 0, 41100)

    assert fr.discover(str(tmp_path)) == ["127.0.0.1:41100"]


def test_port_53_is_never_offered(tmp_path: Path):
    # Такой адрес — это сам DNS-over-VLESS, запрос вернулся бы к нему же.
    _policy(tmp_path, 0, 53)

    assert fr.discover(str(tmp_path)) == []


def test_missing_directory_is_not_an_error(tmp_path: Path):
    assert fr.discover(str(tmp_path / "нет-такого")) == []


def test_parse_listen_port_reads_the_udp_port():
    assert fr.parse_listen_port(POLICY_CONF.format(port=41100)) == 41100
    assert fr.parse_listen_port(MAIN_CONF) == 0
    assert fr.parse_listen_port("dns_udp_port = не число") == 0
