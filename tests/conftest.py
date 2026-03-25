from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
APP_DIR = ROOT / "xkeen-ui"

if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))


def _platform_supports_full_app() -> bool:
    return not sys.platform.startswith("win")


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "linux_only: test requires Unix-only modules such as pty/termios and is skipped on Windows",
    )


def pytest_collection_modifyitems(config, items):
    if _platform_supports_full_app():
        return

    skip_linux_only = pytest.mark.skip(reason="Requires Unix-only modules (pty/termios); skipped on Windows.")
    for item in items:
        if "linux_only" in item.keywords:
            item.add_marker(skip_linux_only)


@pytest.fixture
def isolated_runtime_env(tmp_path, monkeypatch):
    home_dir = tmp_path / "home"
    xdg_dir = tmp_path / "xdg"
    state_dir = tmp_path / "state"
    log_dir = tmp_path / "logs"

    for path in (home_dir, xdg_dir, state_dir, log_dir):
        path.mkdir(parents=True, exist_ok=True)

    monkeypatch.setenv("HOME", str(home_dir))
    monkeypatch.setenv("USERPROFILE", str(home_dir))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(xdg_dir))
    monkeypatch.setenv("XKEEN_UI_STATE_DIR", str(state_dir))
    monkeypatch.setenv("XKEEN_LOG_DIR", str(log_dir))
    monkeypatch.setenv("XKEEN_UI_SECRET_KEY", "test-secret-key")
    monkeypatch.setenv("PYTHONPATH", str(APP_DIR))

    return {
        "home_dir": home_dir,
        "xdg_dir": xdg_dir,
        "state_dir": state_dir,
        "log_dir": log_dir,
    }


@pytest.fixture
def app_client(isolated_runtime_env):
    if not _platform_supports_full_app():
        pytest.skip("Full Flask app startup requires Unix-only modules (pty/termios).")

    app_factory = importlib.import_module("app_factory")
    app = app_factory.create_app(ws_runtime=False)
    app.config["TESTING"] = True
    return app.test_client()
