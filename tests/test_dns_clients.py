from __future__ import annotations

from services import dns_clients as dc


# Настоящий вывод роутера Keenetic-6005, снятый 1 сентября 2026.
POLICIES = """
           policy, name = Policy0, description = XKeen:
                 mark: ffffaaa
           policy, name = Policy1, description = XKeen-ALL:
                 mark: ffffaab
           policy, name = Policy2, description = Незарегистрированные клиенты:
                 mark: ffffaac
"""

REDIRECTS = """
-N _NDM_HOTSPOT_DNSREDIR
-A _NDM_HOTSPOT_DNSREDIR -d 192.168.10.1/32 -i br0 -p udp -m mark --mark 0xffffaaa -m pkttype --pkt-type unicast -m udp --dport 53 -j REDIRECT --to-ports 41100
-A _NDM_HOTSPOT_DNSREDIR -d 192.168.10.1/32 -i br0 -p tcp -m mark --mark 0xffffaaa -m pkttype --pkt-type unicast -m tcp --dport 53 -j REDIRECT --to-ports 41100
-A _NDM_HOTSPOT_DNSREDIR -d 192.168.10.1/32 -i br0 -p udp -m mark --mark 0xffffaaa -m pkttype --pkt-type unicast -m udp --dport 1900 -j REDIRECT --to-ports 41300
-A _NDM_HOTSPOT_DNSREDIR -d 192.168.11.1/32 -i br1 -p udp -m mark --mark 0xffffaaa -m pkttype --pkt-type unicast -m udp --dport 53 -j REDIRECT --to-ports 41100
-A _NDM_HOTSPOT_DNSREDIR -d 192.168.10.1/32 -i br0 -p udp -m mark --mark 0xffffaac -m pkttype --pkt-type unicast -m udp --dport 53 -j REDIRECT --to-ports 41102
"""

HOSTS = """
             host:
                  mac: 88:51:F2:72:21:5A
                  via: 88:51:f2:72:21:5a
                   ip: 192.168.11.74
                  ip6:
             hostname: iPhone16ProMax
                 name: iPhone 16 Pro Max
         mws-backhaul: no

            interface:
                       id: Bridge1
                     name: Guest
              description:

                 dhcp:
                  expires: 8032

           registered: yes
               access: permit
               policy: Policy0
               active: no

             host:
                  mac: 00:30:18:A6:C4:72
                   ip: 192.168.10.202
             hostname: nas
                 name: Хранилище
            interface:
                       id: Bridge0
                     name: Home
           registered: yes
               policy:
               active: yes

             host:
                  mac: 10:F6:0A:A5:E7:9A
                   ip: 192.168.10.72
             hostname: laptop
                 name: Ноутбук
            interface:
                       id: Bridge0
                     name: Home
           registered: yes
               policy: Policy1
               active: yes
"""


def test_policies_are_read_with_their_marks():
    policies = dc.parse_policies(POLICIES)

    assert set(policies) == {"Policy0", "Policy1", "Policy2"}
    assert policies["Policy0"]["mark"] == "ffffaaa"
    # The description is what the user recognises, not the internal name.
    assert policies["Policy0"]["description"] == "XKeen"
    assert policies["Policy2"]["description"] == "Незарегистрированные клиенты"


def test_only_the_port_53_redirects_are_collected():
    rules = dc.parse_redirects(REDIRECTS)

    # The chain also redirects 1900 and 5351, which have nothing to do with names.
    assert len(rules) == 4
    assert {rule["to_port"] for rule in rules} == {"41100", "41102"}
    first = rules[0]
    assert first["mark"] == "ffffaaa"
    assert first["interface"] == "br0"
    assert first["address"] == "192.168.10.1"


def test_marks_written_two_ways_are_the_same_mark():
    # The device list writes ``ffffaaa``; the firewall writes ``0xffffaaa``.
    assert dc._normalize_mark("0xffffaaa") == dc._normalize_mark("ffffaaa")


def test_hosts_are_read_without_mixing_in_the_nested_interface_block():
    hosts = dc.parse_hosts(HOSTS)

    assert len(hosts) == 3
    first = hosts[0]
    # ``name`` belongs both to the device and to the interface inside it; the
    # device's own name must win.
    assert first["name"] == "iPhone 16 Pro Max"
    assert first["interface"] == "Bridge1"
    assert first["mac"] == "88:51:f2:72:21:5a"
    assert first["ip"] == "192.168.11.74"
    assert first["policy"] == "Policy0"
    assert first["registered"] is True
    assert first["active"] is False
    # An empty policy field is a real answer: the device is in no policy.
    assert hosts[1]["policy"] == ""


def test_a_device_in_a_policy_is_taken_away_and_one_without_arrives():
    policies = dc.parse_policies(POLICIES)
    redirects = dc.parse_redirects(REDIRECTS)
    verdicts = dc.judge(dc.parse_hosts(HOSTS), policies, redirects)

    phone, nas, laptop = verdicts
    # Policy0 has a redirect on the guest segment too, so the phone loses its DNS.
    assert phone["verdict"] == dc.INTERCEPTED
    assert "XKeen" in phone["reason"]
    # No policy, no mark, no rule to match: this one reaches the feature.
    assert nas["verdict"] == dc.REACHES
    # Policy1 exists but has no redirect rule of its own in this dump.
    assert laptop["verdict"] == dc.REACHES
    assert "XKeen-ALL" in laptop["reason"]


def test_a_rule_on_another_segment_does_not_condemn_this_one():
    policies = dc.parse_policies(POLICIES)
    # Policy1 redirected on the guest bridge only.
    redirects = dc.parse_redirects(
        "-A _NDM_HOTSPOT_DNSREDIR -d 192.168.11.1/32 -i br1 -p udp -m mark"
        " --mark 0xffffaab -m udp --dport 53 -j REDIRECT --to-ports 41101"
    )
    verdicts = dc.judge(dc.parse_hosts(HOSTS), policies, redirects)

    # The laptop sits on Bridge0, so a rule bound to br1 says nothing about it.
    assert verdicts[2]["verdict"] == dc.REACHES


def test_an_unreadable_policy_mark_is_admitted_rather_than_guessed():
    verdicts = dc.judge(
        dc.parse_hosts(HOSTS),
        {"Policy1": {"name": "Policy1", "description": "XKeen-ALL", "mark": ""}},
        dc.parse_redirects(REDIRECTS),
    )

    assert verdicts[2]["verdict"] == dc.UNKNOWN


def test_report_counts_and_survives_an_unreadable_firewall(monkeypatch):
    monkeypatch.setattr(dc, "_iptables_chain", lambda chain: ("", "iptables не найден"))
    monkeypatch.setattr(
        dc,
        "_ndmc",
        lambda command: ((POLICIES, "") if "policy" in command else (HOSTS, "")),
    )

    report = dc.client_report()

    # Without the rules nothing can be called intercepted -- but the window has
    # to say why instead of reporting that all is well.
    assert report["ok"] is True
    assert report["error"] == "iptables не найден"
    assert report["counts"]["total"] == 3
    assert report["counts"][dc.REACHES] == 3


def test_report_gives_up_when_the_device_list_cannot_be_read(monkeypatch):
    monkeypatch.setattr(dc, "_iptables_chain", lambda chain: (REDIRECTS, ""))
    monkeypatch.setattr(
        dc,
        "_ndmc",
        lambda command: ((POLICIES, "") if "policy" in command else ("", "ndmc не найден — это не Keenetic")),
    )

    report = dc.client_report()

    assert report["ok"] is False
    assert report["available"] is False
    assert "Keenetic" in report["error"]


def test_report_marks_which_policies_intercept(monkeypatch):
    monkeypatch.setattr(dc, "_iptables_chain", lambda chain: (REDIRECTS, ""))
    monkeypatch.setattr(
        dc,
        "_ndmc",
        lambda command: ((POLICIES, "") if "policy" in command else (HOSTS, "")),
    )

    report = dc.client_report()
    intercepting = {item["description"] for item in report["policies"] if item["intercepts"]}

    assert intercepting == {"XKeen", "Незарегистрированные клиенты"}
    assert report["counts"][dc.INTERCEPTED] == 1
