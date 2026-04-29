"""Tests for JSONC sidecar mtime-vs-content logic in routing GET endpoint.

When `xkeen -restart` touches the clean JSON after the UI saved a JSONC
sidecar, the main file gets a newer mtime.  The old code treated this as
"external edit" and discarded comments.  The fix compares stripped content
instead of blindly trusting mtime.
"""

from __future__ import annotations

import json
import os
import sys
import time
import types
from pathlib import Path
from typing import Any, Dict, Optional
from unittest.mock import patch

import pytest

# ---------------------------------------------------------------------------
# Stub Unix-only modules so the import chain works on Windows.
# ---------------------------------------------------------------------------
for _mod_name in ("termios", "tty", "pty"):
    if _mod_name not in sys.modules:
        sys.modules[_mod_name] = types.ModuleType(_mod_name)

# ---------------------------------------------------------------------------
# Minimal helpers that mirror production code just enough for unit testing.
# We call register_config_routes() directly with stubs instead of booting
# the full Flask app (which requires Unix-only modules on CI).
# ---------------------------------------------------------------------------

from flask import Flask

import routes.routing.config as _routing_config_mod
import services.xray_config_files as _xcf_mod


def _strip_json_comments_text(s: str) -> str:
    """Simplified comment stripper (handles // only — enough for tests)."""
    out: list[str] = []
    for line in s.splitlines(True):
        stripped = line.lstrip()
        if stripped.startswith("//"):
            continue
        idx = line.find("//")
        if idx >= 0:
            # naive: ignore // inside strings for test purposes
            out.append(line[:idx].rstrip() + "\n")
        else:
            out.append(line)
    return "".join(out)


def _load_json(path: str, default: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def _noop_restart(**kw) -> bool:
    return False


def _make_app(
    *,
    routing_file: str,
    routing_file_raw: str,
    xray_configs_dir: str,
    xray_configs_dir_real: str,
) -> Flask:
    """Build a tiny Flask app with only the routing config blueprint."""
    app = Flask(__name__)
    app.config["TESTING"] = True

    from routes.routing.config import register_config_routes
    from flask import Blueprint

    bp = Blueprint("routing_test", __name__)
    register_config_routes(
        bp,
        routing_file=routing_file,
        routing_file_raw=routing_file_raw,
        xray_configs_dir=xray_configs_dir,
        xray_configs_dir_real=xray_configs_dir_real,
        backup_dir="",
        backup_dir_real="",
        load_json=_load_json,
        strip_json_comments_text=_strip_json_comments_text,
        restart_xkeen=_noop_restart,
    )
    app.register_blueprint(bp)
    return app


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def routing_env(tmp_path: Path):
    """Create a temp configs dir + JSONC dir and return paths."""
    configs_dir = tmp_path / "configs"
    jsonc_dir = tmp_path / "jsonc"
    configs_dir.mkdir()
    jsonc_dir.mkdir()

    main_file = configs_dir / "05_routing.json"
    raw_file = jsonc_dir / "05_routing.jsonc"

    return {
        "configs_dir": str(configs_dir),
        "jsonc_dir": str(jsonc_dir),
        "main_file": main_file,
        "raw_file": raw_file,
    }


SAMPLE_OBJ = {"routing": {"rules": [{"type": "field", "outboundTag": "direct"}]}}
SAMPLE_JSONC = (
    "// User routing comments\n"
    + json.dumps(SAMPLE_OBJ, indent=2, ensure_ascii=False)
    + "\n"
)
SAMPLE_CLEAN = json.dumps(SAMPLE_OBJ, indent=2, ensure_ascii=False) + "\n"


def _set_mtime(path: Path, offset_s: float):
    """Shift file mtime by offset_s relative to now."""
    t = time.time() + offset_s
    os.utime(str(path), (t, t))


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_jsonc_returned_when_mtime_newer(routing_env):
    """Normal case: JSONC is newer than clean JSON — must return JSONC."""
    env = routing_env
    env["main_file"].write_text(SAMPLE_CLEAN, encoding="utf-8")
    env["raw_file"].write_text(SAMPLE_JSONC, encoding="utf-8")

    _set_mtime(env["main_file"], -10)
    _set_mtime(env["raw_file"], 0)

    with patch.object(_routing_config_mod, "XRAY_JSONC_DIR_REAL", env["jsonc_dir"]), \
         patch.object(_xcf_mod, "XRAY_JSONC_DIR", env["jsonc_dir"]):
        app = _make_app(
            routing_file=str(env["main_file"]),
            routing_file_raw=str(env["raw_file"]),
            xray_configs_dir=env["configs_dir"],
            xray_configs_dir_real=env["configs_dir"],
        )
        with app.test_client() as c:
            resp = c.get("/api/routing")
            assert resp.status_code == 200
            body = resp.get_data(as_text=True)
            assert "//" in body, "Expected JSONC comments in response"
            assert resp.headers.get("X-XKeen-JSONC-Using") == "1"


def test_jsonc_returned_when_main_touched_but_content_same(routing_env):
    """Bug-fix case: main JSON is newer (e.g. xkeen restart touched it)
    but content is identical — must still return JSONC with comments."""
    env = routing_env
    env["main_file"].write_text(SAMPLE_CLEAN, encoding="utf-8")
    env["raw_file"].write_text(SAMPLE_JSONC, encoding="utf-8")

    # Simulate xkeen restart touching main JSON after JSONC was written.
    _set_mtime(env["raw_file"], -10)
    _set_mtime(env["main_file"], 0)

    with patch.object(_routing_config_mod, "XRAY_JSONC_DIR_REAL", env["jsonc_dir"]), \
         patch.object(_xcf_mod, "XRAY_JSONC_DIR", env["jsonc_dir"]):
        app = _make_app(
            routing_file=str(env["main_file"]),
            routing_file_raw=str(env["raw_file"]),
            xray_configs_dir=env["configs_dir"],
            xray_configs_dir_real=env["configs_dir"],
        )
        with app.test_client() as c:
            resp = c.get("/api/routing")
            assert resp.status_code == 200
            body = resp.get_data(as_text=True)
            assert "//" in body, "JSONC comments must be preserved when content matches"
            assert resp.headers.get("X-XKeen-JSONC-Using") == "1"


def test_clean_json_returned_when_genuinely_edited_externally(routing_env):
    """When main JSON was changed externally (different content), JSONC
    sidecar is stale — must return the clean JSON."""
    env = routing_env

    different_obj = {"routing": {"rules": [{"type": "field", "outboundTag": "proxy"}]}}
    env["main_file"].write_text(
        json.dumps(different_obj, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    env["raw_file"].write_text(SAMPLE_JSONC, encoding="utf-8")

    # Main is newer AND has different content.
    _set_mtime(env["raw_file"], -10)
    _set_mtime(env["main_file"], 0)

    with patch.object(_routing_config_mod, "XRAY_JSONC_DIR_REAL", env["jsonc_dir"]), \
         patch.object(_xcf_mod, "XRAY_JSONC_DIR", env["jsonc_dir"]):
        app = _make_app(
            routing_file=str(env["main_file"]),
            routing_file_raw=str(env["raw_file"]),
            xray_configs_dir=env["configs_dir"],
            xray_configs_dir_real=env["configs_dir"],
        )
        with app.test_client() as c:
            resp = c.get("/api/routing")
            assert resp.status_code == 200
            body = resp.get_data(as_text=True)
            assert "proxy" in body, "Should return the externally-edited content"
            assert resp.headers.get("X-XKeen-JSONC-Using") == "0"


def test_clean_json_returned_when_main_reformatted_externally(routing_env):
    """Main JSON has same semantic content but different formatting.
    Content comparison uses json.loads equality, so reformatting should
    still be detected as 'same' and JSONC should be returned."""
    env = routing_env

    # Write compact (no indent) version of the same object.
    env["main_file"].write_text(
        json.dumps(SAMPLE_OBJ, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    env["raw_file"].write_text(SAMPLE_JSONC, encoding="utf-8")

    _set_mtime(env["raw_file"], -10)
    _set_mtime(env["main_file"], 0)

    with patch.object(_routing_config_mod, "XRAY_JSONC_DIR_REAL", env["jsonc_dir"]), \
         patch.object(_xcf_mod, "XRAY_JSONC_DIR", env["jsonc_dir"]):
        app = _make_app(
            routing_file=str(env["main_file"]),
            routing_file_raw=str(env["raw_file"]),
            xray_configs_dir=env["configs_dir"],
            xray_configs_dir_real=env["configs_dir"],
        )
        with app.test_client() as c:
            resp = c.get("/api/routing")
            assert resp.status_code == 200
            body = resp.get_data(as_text=True)
            assert "//" in body, "JSONC should be returned when semantic content matches"
            assert resp.headers.get("X-XKeen-JSONC-Using") == "1"


def test_routing_get_loads_cp1251_legacy_json_without_empty_file_fallback(routing_env):
    env = routing_env
    legacy_obj = {
        "routing": {
            "rules": [
                {
                    "type": "field",
                    "outboundTag": "direct",
                    "domain": ["domain:рф", "domain:рус", "domain:москва", "domain:бел"],
                }
            ]
        }
    }
    env["main_file"].write_text(
        json.dumps(legacy_obj, indent=2, ensure_ascii=False) + "\n",
        encoding="cp1251",
    )

    with patch.object(_routing_config_mod, "XRAY_JSONC_DIR_REAL", env["jsonc_dir"]), \
         patch.object(_xcf_mod, "XRAY_JSONC_DIR", env["jsonc_dir"]):
        app = _make_app(
            routing_file=str(env["main_file"]),
            routing_file_raw=str(env["raw_file"]),
            xray_configs_dir=env["configs_dir"],
            xray_configs_dir_real=env["configs_dir"],
        )
        with app.test_client() as c:
            resp = c.get("/api/routing")
            assert resp.status_code == 200
            body = resp.get_data(as_text=True)
            assert "domain:рф" in body
            assert "domain:рус" in body
            assert "domain:москва" in body
            assert "domain:бел" in body
            assert resp.headers.get("X-XKeen-JSONC-Using") == "0"
