from __future__ import annotations

import importlib


def test_import_routes_pages_module(isolated_runtime_env):
    module = importlib.import_module("routes.pages")
    assert module is not None


def test_import_routes_utils_module(isolated_runtime_env):
    module = importlib.import_module("routes.utils")
    assert module is not None
