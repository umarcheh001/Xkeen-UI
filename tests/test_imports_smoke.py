from __future__ import annotations

import importlib
import sys

import pytest


def test_import_app_factory(isolated_runtime_env):
    module = importlib.import_module("app_factory")
    assert module is not None


@pytest.mark.linux_only
def test_import_app_module(isolated_runtime_env):
    if sys.platform.startswith("win"):
        pytest.skip("app module pulls Unix-only runtime pieces on Windows")

    module = importlib.import_module("app")
    assert module is not None
