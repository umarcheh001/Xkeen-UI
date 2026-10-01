"""Which observatory an Xray config directory has, and which one it needs.

Xray ships two observatories.  ``leastLoad`` reads the sample statistics only
``burstObservatory`` produces; with the plain ``observatory`` it silently
degrades into "fastest by the last probe".  When both sections are present the
core registers the plain one first and every strategy reads it, so the burst
one probes for nothing.  The directory is merged as a whole, hence everything
here looks at every file, not only at 07_observatory.json.
"""

from __future__ import annotations

import copy
import json
import os
from typing import Any, Dict, Iterable, List

from utils.jsonc import strip_json_comments_text

OBSERVATORY_FILE = "07_observatory.json"
KIND_PLAIN = "observatory"
KIND_BURST = "burstObservatory"
KINDS = (KIND_PLAIN, KIND_BURST)

# Measured on the routers on 2026-10-01: a probe costs ~20-30 ms of CPU, so the
# cycle length is chosen by how long a dead node may stay selectable, not by load.
BURST_INTERVAL = "2m"
BURST_SAMPLING = 3
BURST_TIMEOUT = "5s"
# DNS rides the two steadiest nodes: three samples are too few to trust one pick.
LEAST_LOAD_EXPECTED = 2
LEAST_LOAD_TOLERANCE = 0.5


def read_fragment(path: str) -> Dict[str, Any] | None:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            text = fh.read()
    except Exception:
        return None
    for candidate in (text, strip_json_comments_text(text)):
        try:
            obj = json.loads(candidate)
        except Exception:
            continue
        return obj if isinstance(obj, dict) else None
    return None


def clean_selectors(raw: Any) -> List[str]:
    out: List[str] = []
    for item in raw if isinstance(raw, list) else []:
        value = str(item or "").strip()
        if value and value not in out:
            out.append(value)
    return out


def _balancer_strategies(obj: Dict[str, Any]) -> List[str]:
    routing = obj.get("routing") if isinstance(obj.get("routing"), dict) else {}
    found: List[str] = []
    for holder in (routing, obj):
        balancers = holder.get("balancers")
        for item in balancers if isinstance(balancers, list) else []:
            strategy = item.get("strategy") if isinstance(item, dict) else None
            kind = str(strategy.get("type") or "").strip().lower() if isinstance(strategy, dict) else ""
            if kind:
                found.append(kind)
    return found


def collect_catalog(configs_dir: str) -> Dict[str, Any]:
    strategies: List[str] = []
    sections: List[Dict[str, Any]] = []
    try:
        names = sorted(os.listdir(str(configs_dir or "")))
    except Exception:
        names = []
    for name in names:
        if not name.lower().endswith(".json"):
            continue
        path = os.path.join(str(configs_dir), name)
        if not os.path.isfile(path):
            continue
        obj = read_fragment(path)
        if obj is None:
            continue
        strategies.extend(_balancer_strategies(obj))
        for kind in KINDS:
            if isinstance(obj.get(kind), dict):
                sections.append({"file": name, "kind": kind, "section": obj[kind]})
    return {
        "strategies": strategies,
        "has_least_load": "leastload" in strategies,
        "sections": sections,
    }


def effective_section(catalog: Dict[str, Any], kind: str) -> Dict[str, Any] | None:
    found = [item for item in catalog.get("sections", []) if item.get("kind") == kind]
    return found[-1] if found else None


def effective_kind(catalog: Dict[str, Any]) -> str:
    if effective_section(catalog, KIND_PLAIN) is not None:
        return KIND_PLAIN
    if effective_section(catalog, KIND_BURST) is not None:
        return KIND_BURST
    return ""


def covers(selectors: Iterable[str], tag: str) -> bool:
    value = str(tag or "")
    return any(value.startswith(str(prefix)) for prefix in selectors if str(prefix or ""))


def new_burst_section(selectors: List[str], destination: str) -> Dict[str, Any]:
    return {
        "subjectSelector": list(selectors),
        "pingConfig": {
            "destination": str(destination),
            "interval": BURST_INTERVAL,
            "sampling": BURST_SAMPLING,
            "timeout": BURST_TIMEOUT,
        },
    }


def burst_from_plain(section: Dict[str, Any], default_destination: str) -> Dict[str, Any]:
    source = section if isinstance(section, dict) else {}
    destination = str(source.get("probeUrl") or "").strip() or str(default_destination)
    return new_burst_section(clean_selectors(source.get("subjectSelector")), destination)


def replace_section(obj: Dict[str, Any], kind: str, section: Dict[str, Any]) -> Dict[str, Any]:
    """Put ``section`` under ``kind``, dropping the twin key, keeping key order."""
    out: Dict[str, Any] = {}
    placed = False
    for key, value in obj.items():
        if key in KINDS:
            if not placed:
                out[kind] = copy.deepcopy(section)
                placed = True
            continue
        out[key] = value
    if not placed:
        out[kind] = copy.deepcopy(section)
    return out
