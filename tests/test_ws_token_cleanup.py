from __future__ import annotations

import importlib
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
APP_DIR = ROOT / "xkeen-ui"

if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))


def _reload_ws_tokens():
    module = sys.modules.get("services.ws_tokens")
    if module is not None:
        return importlib.reload(module)
    return importlib.import_module("services.ws_tokens")


def test_validate_ws_token_cleans_up_other_expired_entries():
    ws_tokens = _reload_ws_tokens()

    with ws_tokens._WS_TOKENS_LOCK:
        ws_tokens._WS_TOKENS.clear()
        ws_tokens._WS_TOKENS["expired-token"] = (1.0, "logs")
        ws_tokens._WS_TOKENS["fresh-token"] = (10_000_000_000.0, "logs")

    assert ws_tokens.validate_ws_token("fresh-token", scope="logs") is True

    with ws_tokens._WS_TOKENS_LOCK:
        assert "expired-token" not in ws_tokens._WS_TOKENS
        assert "fresh-token" not in ws_tokens._WS_TOKENS


def test_validate_ws_token_rejects_expired_token_and_removes_it():
    ws_tokens = _reload_ws_tokens()

    with ws_tokens._WS_TOKENS_LOCK:
        ws_tokens._WS_TOKENS.clear()
        ws_tokens._WS_TOKENS["expired-token"] = (1.0, "pty")

    assert ws_tokens.validate_ws_token("expired-token", scope="pty") is False

    with ws_tokens._WS_TOKENS_LOCK:
        assert "expired-token" not in ws_tokens._WS_TOKENS
