from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "xkeen-ui"))

from services.ui_settings import DEFAULTS, _sanitize_full  # noqa: E402


def test_layout_defaults_to_auto():
    assert DEFAULTS["routing"]["dnsOverVlessLayout"] == "auto"


def test_layout_accepts_known_values():
    for value in ("auto", "single", "split"):
        out, _rep = _sanitize_full({"routing": {"dnsOverVlessLayout": value}})
        assert out["routing"]["dnsOverVlessLayout"] == value


def test_layout_is_case_insensitive():
    out, _rep = _sanitize_full({"routing": {"dnsOverVlessLayout": "SPLIT"}})
    assert out["routing"]["dnsOverVlessLayout"] == "split"


def test_unknown_layout_falls_back_to_auto_and_warns():
    out, rep = _sanitize_full({"routing": {"dnsOverVlessLayout": "three-columns"}})
    assert out["routing"]["dnsOverVlessLayout"] == "auto"
    assert any(w.get("path") == "routing.dnsOverVlessLayout" for w in rep.warnings)


def test_wrong_type_falls_back_to_auto():
    out, rep = _sanitize_full({"routing": {"dnsOverVlessLayout": 5}})
    assert out["routing"]["dnsOverVlessLayout"] == "auto"
    assert rep.changed is True
