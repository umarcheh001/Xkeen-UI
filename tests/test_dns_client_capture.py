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


@pytest.fixture()
def firewall(monkeypatch):
    fake = Firewall()
    monkeypatch.setattr(cap, "_run", fake.run)
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
    # Both protocols: a client that gets no answer over UDP retries over TCP.
    assert len(firewall.chain) == 2
    assert "-p udp" in firewall.chain[0] and "--mac-source 10:f6:0a:a5:e7:9a" in firewall.chain[0]
    assert "-p tcp" in firewall.chain[1]
    assert "--to-ports 53" in firewall.chain[0]
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
