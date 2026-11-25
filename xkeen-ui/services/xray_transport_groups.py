"""Identifiers and routing objects for subscription transport groups."""

import hashlib
import re


PREFIX = "xk-sub-transports-"
BLOCK = PREFIX + "block"
OUTBOUNDS_FILE = "99_xkeen_transport_groups_tail.json"


def tag_for(outbound_tag):
    return PREFIX + hashlib.sha256(outbound_tag.encode("utf-8")).hexdigest()[:24]


def is_group(tag):
    return isinstance(tag, str) and re.fullmatch(PREFIX + r"[0-9a-f]{24}", tag) is not None


def dispatch_rule(tag):
    return {"type": "field", "ruleTag": tag, "inboundTag": [tag], "balancerTag": tag}


def outbound(tag):
    return {"tag": tag, "protocol": "loopback", "settings": {"inboundTag": tag}}
