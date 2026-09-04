from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "xkeen-ui"))

from services.ui_settings import (  # noqa: E402
    DEFAULTS,
    _sanitize_full,
    _sanitize_patch,
    load_settings,
    patch_settings,
)


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


def test_patch_keeps_layout():
    """PATCH-путь отдельный от полной валидации: раскладка должна доезжать."""
    out, rep = _sanitize_patch({"routing": {"dnsOverVlessLayout": "single"}})
    assert out["routing"]["dnsOverVlessLayout"] == "single"
    assert not any(w.get("path") == "routing.dnsOverVlessLayout" for w in rep.warnings)


def test_patch_layout_is_case_insensitive():
    out, _rep = _sanitize_patch({"routing": {"dnsOverVlessLayout": "SPLIT"}})
    assert out["routing"]["dnsOverVlessLayout"] == "split"


def test_patch_rejects_unknown_layout():
    _out, rep = _sanitize_patch({"routing": {"dnsOverVlessLayout": "three-columns"}})
    assert any(e.get("path") == "routing.dnsOverVlessLayout" for e in rep.errors)


def test_patch_settings_persists_layout(tmp_path):
    cfg, _rep = patch_settings({"routing": {"dnsOverVlessLayout": "split"}}, str(tmp_path))
    assert cfg["routing"]["dnsOverVlessLayout"] == "split"
    assert load_settings(str(tmp_path))["routing"]["dnsOverVlessLayout"] == "split"
