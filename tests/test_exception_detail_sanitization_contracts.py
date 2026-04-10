from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_routes_use_stable_error_codes_instead_of_raw_exception_text():
    config_exchange = (ROOT / "xkeen-ui" / "routes" / "config_exchange.py").read_text(encoding="utf-8")
    devtools = (ROOT / "xkeen-ui" / "routes" / "devtools.py").read_text(encoding="utf-8")
    geodat = (ROOT / "xkeen-ui" / "routes" / "routing" / "geodat.py").read_text(encoding="utf-8")

    assert 'f"read failed: {e}"' not in config_exchange
    assert 'f"invalid json: {e}"' not in config_exchange
    assert 'f"apply failed: {e}"' not in config_exchange
    assert '"meta": {"message": str(e)[:200]}' not in devtools
    assert '"details": str(e)' not in geodat

    assert '"read_failed"' in config_exchange
    assert '"invalid_json"' in config_exchange
    assert '"apply_failed"' in config_exchange
    assert '"spawn_failed"' in devtools
    assert '"install_failed"' in geodat


def test_frontend_prefers_server_hint_over_raw_error_code_for_sanitized_responses():
    github_js = (ROOT / "xkeen-ui" / "static" / "js" / "features" / "github.js").read_text(encoding="utf-8")
    update_js = (ROOT / "xkeen-ui" / "static" / "js" / "features" / "devtools" / "update.js").read_text(encoding="utf-8")

    assert "(data && (data.hint || data.error))" in github_js
    assert "const hint = data && data.hint ? String(data.hint) : '';" in update_js
    assert "const err = data && (data.hint || data.error) ? String(data.hint || data.error) : 'run_failed';" in update_js
    assert "const err = data && (data.hint || data.error) ? String(data.hint || data.error) : 'rollback_failed';" in update_js
