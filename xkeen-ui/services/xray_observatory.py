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

from utils.fs import load_text
from utils.jsonc import strip_json_comments_text

DEFAULT_PROBE_URL = "https://www.gstatic.com/generate_204"
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
    # The core takes Windows-1251 comments too; a file the panel cannot decode
    # would look empty here and get a fresh section written over it.
    try:
        text = load_text(path, default=None)
    except Exception:
        return None
    if text is None:
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


def locate_section(catalog: Dict[str, Any]) -> Dict[str, Any] | None:
    """The section the panel works on: the one this directory needs, else the one it has."""
    plain = effective_section(catalog, KIND_PLAIN)
    burst = effective_section(catalog, KIND_BURST)
    if plain is not None and burst is not None:
        return burst if catalog.get("has_least_load") else plain
    return plain if plain is not None else burst


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


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def describe_config(cfg_obj: Dict[str, Any], want_burst: bool = False) -> Dict[str, Any]:
    """Flatten whichever section the file holds into the fields the form shows.

    ``want_burst`` matters only when the file holds both kinds: it names the one
    a save would keep, so the form shows what it is about to edit.
    """
    obj = cfg_obj if isinstance(cfg_obj, dict) else {}
    burst_chosen = bool(want_burst) and isinstance(obj.get(KIND_BURST), dict)
    if isinstance(obj.get(KIND_PLAIN), dict) and not burst_chosen:
        section = obj[KIND_PLAIN]
        concurrency = section.get("enableConcurrency")
        return {
            "kind": KIND_PLAIN,
            "subjectSelector": clean_selectors(section.get("subjectSelector")),
            "probeUrl": str(section.get("probeUrl") or ""),
            "probeInterval": str(section.get("probeInterval") or ""),
            "enableConcurrency": concurrency if isinstance(concurrency, bool) else True,
        }
    if isinstance(obj.get(KIND_BURST), dict):
        section = obj[KIND_BURST]
        ping = section.get("pingConfig") if isinstance(section.get("pingConfig"), dict) else {}
        return {
            "kind": KIND_BURST,
            "subjectSelector": clean_selectors(section.get("subjectSelector")),
            "probeUrl": str(ping.get("destination") or ""),
            "probeInterval": str(ping.get("interval") or ""),
            "enableConcurrency": True,
        }
    return {"kind": "", "subjectSelector": [], "probeUrl": "", "probeInterval": "", "enableConcurrency": True}


def apply_generate_request(
    cfg_obj: Dict[str, Any],
    *,
    subject: List[str],
    probe_url: Any,
    probe_interval: Any,
    enable_concurrency: Any,
    want_burst: bool,
) -> Dict[str, Any]:
    """Apply the form to the file, keeping exactly one observatory section."""
    obj = copy.deepcopy(cfg_obj) if isinstance(cfg_obj, dict) else {}
    plain = obj.get(KIND_PLAIN) if isinstance(obj.get(KIND_PLAIN), dict) else None
    burst = obj.get(KIND_BURST) if isinstance(obj.get(KIND_BURST), dict) else None
    if plain is not None and burst is not None:
        # Both at once: keep the one the directory needs, as the subscription sync does.
        if want_burst:
            plain = None
        else:
            burst = None

    if burst is not None or want_burst:
        fresh = burst is None
        if fresh:
            burst = burst_from_plain(plain or {}, DEFAULT_PROBE_URL)
        ping = burst.get("pingConfig") if isinstance(burst.get("pingConfig"), dict) else {}
        if _text(probe_url):
            ping["destination"] = _text(probe_url)
        # The form always sends its plain-observatory interval; a burst made in
        # this call keeps the panel's own cycle, an existing one takes the form's.
        if _text(probe_interval) and not fresh:
            ping["interval"] = _text(probe_interval)
        burst["subjectSelector"] = list(subject)
        burst["pingConfig"] = ping
        # enable_concurrency is ignored here: burstObservatory has no such field.
        return replace_section(obj, KIND_BURST, burst)

    section = plain if plain is not None else {}
    section["subjectSelector"] = list(subject)
    if _text(probe_url):
        section["probeUrl"] = _text(probe_url)
    else:
        section.setdefault("probeUrl", DEFAULT_PROBE_URL)
    if _text(probe_interval):
        section["probeInterval"] = _text(probe_interval)
    else:
        section.setdefault("probeInterval", "60s")
    if isinstance(enable_concurrency, bool):
        section["enableConcurrency"] = enable_concurrency
    else:
        section.setdefault("enableConcurrency", True)
    return replace_section(obj, KIND_PLAIN, section)
