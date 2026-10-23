from __future__ import annotations

import pytest

from services import dns_client_capture as cap


class Firewall:
    """A stand-in for the nat table: remembers what it was told to do."""

    def __init__(self, chain: list[str] | None = None, parent: list[str] | None = None):
        self.chain = list(chain) if chain is not None else None
        self.parent = list(parent) if parent is not None else [
            f"-A {cap.PARENT_CHAIN} -j _NDM_DNS_REDIRECT",
        ]
        self.calls: list[list[str]] = []

    def run(self, args: list[str]) -> tuple[int, str, str]:
        self.calls.append(list(args))
        verb = args[0]
        if verb == "-S" and args[1] == cap.CHAIN:
            if self.chain is None:
                return 1, "", f"iptables: No chain/target/match by that name."
            return 0, "\n".join([f"-N {cap.CHAIN}", *self.chain]) + "\n", ""
        if verb == "-S" and args[1] == cap.PARENT_CHAIN:
            return 0, "\n".join([f"-P {cap.PARENT_CHAIN} ACCEPT", *self.parent]) + "\n", ""
        if verb == "-N":
            self.chain = []
            return 0, "", ""
        if verb == "-F":
            self.chain = []
            return 0, "", ""
        if verb == "-X":
            self.chain = None
            return 0, "", ""
        if verb == "-A":
            self.chain = (self.chain or []) + [" ".join(args)]
            return 0, "", ""
        if verb == "-I":
            self.parent.insert(int(args[2]) - 1, f"-A {cap.PARENT_CHAIN} -j {cap.CHAIN}")
            return 0, "", ""
        if verb == "-D":
            self.parent = [item for item in self.parent if not item.endswith(f"-j {cap.CHAIN}")]
            return 0, "", ""
        return 1, "", f"unexpected {args}"


LAN = ["192.168.45.1", "192.168.46.1"]


@pytest.fixture()
def firewall(monkeypatch):
    fake = Firewall()
    monkeypatch.setattr(cap, "_run", fake.run)
    monkeypatch.setattr(cap, "lan_addresses", lambda: list(LAN))
    # XKeen's deny set, empty as on 45.1; a test puts members in when it needs them.
    fake.denied = set()
    monkeypatch.setattr(cap, "_xkeen_denied_macs", lambda: fake.denied)
    return fake


def test_a_mac_is_accepted_however_the_user_typed_it():
    assert cap.normalize_macs("10:F6:0A:A5:E7:9A") == ["10:f6:0a:a5:e7:9a"]
    assert cap.normalize_macs("10-f6-0a-a5-e7-9a") == ["10:f6:0a:a5:e7:9a"]
    # Repeats collapse, order is the user's.
    assert cap.normalize_macs(["aa:bb:cc:dd:ee:01", "AA:BB:CC:DD:EE:01"]) == ["aa:bb:cc:dd:ee:01"]
    assert cap.normalize_macs("") == []


def test_something_that_is_not_a_mac_is_refused_rather_than_written():
    for value in ("192.168.10.5", "10:f6:0a:a5:e7", "не адрес"):
        with pytest.raises(cap.CaptureError):
            cap.normalize_macs([value])
    with pytest.raises(cap.CaptureError):
        cap.normalize_macs([f"aa:bb:cc:dd:ee:{i:02x}" for i in range(cap.MAX_CAPTURE_CLIENTS + 1)])


def test_the_chain_is_created_filled_and_put_first(firewall):
    result = cap.ensure(["10:f6:0a:a5:e7:9a"])

    assert result["changed"] is True
    # Two protocols per segment: a client that gets no answer over UDP retries
    # over TCP, and the router answers on every home segment it has.
    assert len(firewall.chain) == 4
    assert "-p udp" in firewall.chain[0] and "--mac-source 10:f6:0a:a5:e7:9a" in firewall.chain[0]
    assert "-p tcp" in firewall.chain[1]
    assert "--to-ports 53" in firewall.chain[0]
    # Only queries aimed at the router itself.  A blanket rule also swallows a
    # resolver the user set by hand on the device, and such a connection dies:
    # measured on a router, a captured device could not reach 77.88.8.8 while
    # 1.1.1.1 answered.
    assert [rule[1] for rule in cap.parse_rules("\n".join(firewall.chain))] == [
        "192.168.45.1",
        "192.168.45.1",
        "192.168.46.1",
        "192.168.46.1",
    ]
    # Below the firmware's own redirect the chain would be decoration: that
    # rule ends the nat table before ours is reached.
    assert firewall.parent[0].endswith(f"-j {cap.CHAIN}")


def test_asking_for_what_is_already_there_changes_nothing(firewall):
    cap.ensure(["10:f6:0a:a5:e7:9a"])
    firewall.calls.clear()

    result = cap.ensure(["10:f6:0a:a5:e7:9a"])

    assert result["changed"] is False
    assert not [call for call in firewall.calls if call[0] not in {"-S"}]


def test_a_jump_that_slipped_below_the_firmware_is_put_back_on_top(firewall):
    cap.ensure(["10:f6:0a:a5:e7:9a"])
    # The firmware rebuilds its chains on any policy or interface change and
    # inserts its own redirect at the top.
    firewall.parent.insert(0, f"-A {cap.PARENT_CHAIN} -j _NDM_HOTSPOT_DNSREDIR")

    result = cap.ensure(["10:f6:0a:a5:e7:9a"])

    assert result["changed"] is True
    assert firewall.parent[0].endswith(f"-j {cap.CHAIN}")
    assert firewall.parent.count(f"-A {cap.PARENT_CHAIN} -j {cap.CHAIN}") == 1
    # The journal has to be able to say what was mended and where the jump had
    # slid to -- a race with the firmware leaves no other trace.
    assert result["repairs"] == ["jump"]
    assert result["jump_was"] == 2
    # And who pushed it: the firmware's own chain and XKeen's deny rule both
    # land on top, and a user's report only helps if it names which one did.
    assert result["above"] == f"-A {cap.PARENT_CHAIN} -j _NDM_HOTSPOT_DNSREDIR"


# XKeen's netfilter hook puts this one on top of PREROUTING on every firewall
# event of the firmware (``proxy.sh``, ``add_prerouting``), as read on 45.1.
XKEEN_DENY = (
    f"-A {cap.PARENT_CHAIN} -m set --match-set xkeen_deny_mac src "
    "-m comment --comment xkeen_rule -j RETURN"
)


def test_xkeens_deny_rule_above_the_jump_is_left_alone(firewall):
    cap.ensure(["10:f6:0a:a5:e7:9a"])
    firewall.parent.insert(0, XKEEN_DENY)
    before = list(firewall.parent)
    firewall.calls.clear()

    result = cap.ensure(["10:f6:0a:a5:e7:9a"])

    # It lets out only the devices in XKeen's set, and none of the chosen ones
    # is there.  Moving our jump over it again would only start the tug of war
    # anew at XKeen's next event, and leave a line in core.log every time
    # (405 of 426 on 45.1 by 23.10.2026).
    assert result["changed"] is False
    assert result["repairs"] == []
    assert firewall.parent == before
    assert not [call for call in firewall.calls if call[0] not in {"-S"}]


def test_a_firmware_redirect_under_xkeens_rule_still_pushes_the_jump_back(firewall):
    cap.ensure(["10:f6:0a:a5:e7:9a"])
    firewall.parent.insert(0, f"-A {cap.PARENT_CHAIN} -j _NDM_DNAT")
    firewall.parent.insert(0, XKEEN_DENY)

    result = cap.ensure(["10:f6:0a:a5:e7:9a"])

    assert result["repairs"] == ["jump"]
    assert result["jump_was"] == 3
    assert firewall.parent[0].endswith(f"-j {cap.CHAIN}")
    # The line names the rule that mattered, not the harmless one on top.
    assert result["above"] == f"-A {cap.PARENT_CHAIN} -j _NDM_DNAT"


def test_only_xkeens_own_deny_rule_counts_as_harmless(firewall):
    lookalikes = [
        # Same set, but sent somewhere that may redirect.
        f"-A {cap.PARENT_CHAIN} -m set --match-set xkeen_deny_mac src -m comment --comment xkeen_rule -j xkeen",
        # A RETURN that holds back devices of some other set -- ours among them, maybe.
        f"-A {cap.PARENT_CHAIN} -m set --match-set other_mac src -j RETURN",
        # A RETURN for everybody.
        f"-A {cap.PARENT_CHAIN} -j RETURN",
    ]
    for rule in lookalikes:
        cap.ensure(["10:f6:0a:a5:e7:9a"])
        firewall.parent.insert(0, rule)

        result = cap.ensure(["10:f6:0a:a5:e7:9a"])

        assert result["repairs"] == ["jump"], rule
        firewall.parent.remove(rule)


def test_a_chosen_device_excluded_from_xkeen_still_gets_the_jump_on_top(firewall):
    cap.ensure(["10:f6:0a:a5:e7:9a"])
    firewall.parent.insert(0, XKEEN_DENY)
    # The window promises such a device's DNS still goes to the tunnel, though
    # XKeen leaves the rest of its traffic alone: only a jump above XKeen's
    # RETURN keeps that promise.
    firewall.denied = {"10:f6:0a:a5:e7:9a"}

    result = cap.ensure(["10:f6:0a:a5:e7:9a"])

    assert result["repairs"] == ["jump"]
    assert result["jump_was"] == 2
    assert firewall.parent[0].endswith(f"-j {cap.CHAIN}")
    assert result["above"] == XKEEN_DENY


def test_an_unreadable_deny_set_is_not_relied_on(firewall):
    cap.ensure(["10:f6:0a:a5:e7:9a"])
    firewall.parent.insert(0, XKEEN_DENY)
    firewall.denied = None

    assert cap.ensure(["10:f6:0a:a5:e7:9a"])["repairs"] == ["jump"]


def test_status_counts_the_jump_first_under_xkeens_deny_rule(firewall):
    firewall.chain = [" ".join(rule) for rule in cap._rules_for("10:f6:0a:a5:e7:9a", LAN)]
    firewall.parent = [XKEEN_DENY, f"-A {cap.PARENT_CHAIN} -j {cap.CHAIN}", f"-A {cap.PARENT_CHAIN} -j _NDM_DNAT"]

    assert cap.status()["first"] is True

    firewall.denied = {"10:f6:0a:a5:e7:9a"}
    assert cap.status()["first"] is False


def test_the_deny_set_is_read_from_ipsets_listing(monkeypatch):
    # As printed by `ipset list xkeen_deny_mac` on the router (members added).
    listing = (
        "Name: xkeen_deny_mac\nType: hash:mac\nRevision: 0\n"
        "Header: hashsize 1024 maxelem 65536\nSize in memory: 96\nReferences: 4\n"
        "Members:\n10:F6:0A:A5:E7:9A\nAA:BB:CC:DD:EE:01\n"
    )

    class Proc:
        returncode = 0
        stdout = listing
        stderr = ""

    monkeypatch.setattr(cap.subprocess, "run", lambda *a, **k: Proc())
    assert cap._xkeen_denied_macs() == {"10:f6:0a:a5:e7:9a", "aa:bb:cc:dd:ee:01"}

    Proc.stdout = listing.split("Members:")[0] + "Members:\n"
    assert cap._xkeen_denied_macs() == set()

    Proc.returncode = 1
    assert cap._xkeen_denied_macs() is None


def test_the_result_names_every_part_that_had_to_be_rebuilt(firewall):
    created = cap.ensure(["10:f6:0a:a5:e7:9a"])
    assert created["repairs"] == ["chain", "rules", "jump"]
    assert created["jump_was"] == 0
    assert created["above"] == f"-A {cap.PARENT_CHAIN} -j _NDM_DNS_REDIRECT"

    untouched = cap.ensure(["10:f6:0a:a5:e7:9a"])
    assert untouched["repairs"] == []
    assert untouched["above"] == ""

    removed = cap.ensure([])
    assert removed["repairs"] == ["removed"]


def test_a_changed_device_list_is_rewritten_whole(firewall):
    cap.ensure(["10:f6:0a:a5:e7:9a", "aa:bb:cc:dd:ee:01"])

    cap.ensure(["aa:bb:cc:dd:ee:01"])

    assert cap.parse_macs("\n".join(firewall.chain)) == ["aa:bb:cc:dd:ee:01"]


def test_an_empty_list_takes_the_chain_away_entirely(firewall):
    cap.ensure(["10:f6:0a:a5:e7:9a"])

    result = cap.ensure([])

    # A leftover rule with Xray no longer listening leaves the device without
    # DNS at all -- the worst outcome of any, so nothing may stay behind.
    assert result["changed"] is True
    assert firewall.chain is None
    assert not [item for item in firewall.parent if item.endswith(f"-j {cap.CHAIN}")]


def test_removing_what_was_never_there_is_not_an_error(firewall):
    assert cap.remove() is False


def test_status_tells_the_chain_apart_from_a_firewall_it_cannot_read(monkeypatch):
    fake = Firewall(chain=[], parent=[f"-A {cap.PARENT_CHAIN} -j {cap.CHAIN}"])
    monkeypatch.setattr(cap, "_run", fake.run)
    assert cap.status() == {
        "available": True,
        "present": True,
        "first": True,
        "macs": [],
        "error": "",
    }

    monkeypatch.setattr(cap, "_run", lambda args: (127, "", "iptables не найден"))
    unreadable = cap.status()
    assert unreadable["available"] is False
    assert unreadable["error"] == "iptables не найден"


def test_a_chain_that_is_not_first_is_reported_as_such(monkeypatch):
    fake = Firewall(
        chain=[],
        parent=[
            f"-A {cap.PARENT_CHAIN} -j _NDM_HOTSPOT_DNSREDIR",
            f"-A {cap.PARENT_CHAIN} -j {cap.CHAIN}",
        ],
    )
    monkeypatch.setattr(cap, "_run", fake.run)

    assert cap.status()["first"] is False


def test_a_new_segment_reaches_the_chain_without_touching_the_device_list(firewall, monkeypatch):
    cap.ensure(["10:f6:0a:a5:e7:9a"])
    # A guest segment appears, or the router's address changes: the devices are
    # the same, the rules are not.
    monkeypatch.setattr(cap, "lan_addresses", lambda: ["192.168.45.1", "10.1.1.1"])

    result = cap.ensure(["10:f6:0a:a5:e7:9a"])

    assert result["changed"] is True
    assert sorted({rule[1] for rule in cap.parse_rules("\n".join(firewall.chain))}) == [
        "10.1.1.1",
        "192.168.45.1",
    ]


def test_without_a_readable_address_nothing_is_written(monkeypatch):
    fake = Firewall()
    monkeypatch.setattr(cap, "_run", fake.run)
    monkeypatch.setattr(cap, "lan_addresses", lambda: [])

    # A blanket rule would be worse than none: it also swallows the resolver a
    # device carries of its own, and that connection dies.
    with pytest.raises(cap.CaptureError):
        cap.ensure(["10:f6:0a:a5:e7:9a"])
    assert fake.chain is None


def test_the_addresses_are_read_from_the_router_not_assumed(monkeypatch):
    # Real output: the firmware repeats the interface name and puts a
    # backslash before the lifetimes.
    dump = "\n".join(
        [
            r"1: lo    inet 127.0.0.1/8 scope host lo\       valid_lft forever",
            r"8: eth3    inet 192.168.1.254/24 brd 192.168.1.255 scope global eth3\   valid_lft forever",
            r"31: br0    inet 192.168.45.1/24 brd 192.168.45.255 scope global br0\    valid_lft forever",
            r"32: br1    inet 192.168.46.1/24 brd 192.168.46.255 scope global br1\    valid_lft forever",
        ]
    )

    class Proc:
        returncode = 0
        stdout = dump
        stderr = ""

    monkeypatch.setattr(cap.subprocess, "run", lambda *a, **k: Proc())

    # Whatever the segments are called and whatever subnets they use: a list
    # written into the code would be wrong on the next router.  Loopback is the
    # listener itself, so it is the one address left out.
    assert cap.lan_addresses() == ["192.168.1.254", "192.168.45.1", "192.168.46.1"]
