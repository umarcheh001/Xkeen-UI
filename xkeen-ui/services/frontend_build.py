"""Compatibility wrappers for frontend build helpers.

The manifest-aware implementation now lives in routes.ui_assets so Flask can
initialize it centrally during app creation. Keep these wrappers for older
imports and tests.
"""

from __future__ import annotations

from routes.ui_assets import FrontendAssetHelper, frontend_page_entry_url


def _helper() -> FrontendAssetHelper:
    from routes.ui_assets import _get_frontend_asset_helper

    return _get_frontend_asset_helper()


def get_source_entry_filename(entry_name: str) -> str:
    return _helper().get_source_entry_filename(entry_name)


def get_build_entry_filename(entry_name: str) -> str | None:
    return _helper().get_build_entry_filename(entry_name)


def get_enabled_build_pages() -> set[str] | None:
    return _helper().get_enabled_build_pages()


def is_build_enabled_for_page(entry_name: str) -> bool:
    return _helper().is_build_enabled_for_page(entry_name)


def build_entry_exists(entry_name: str) -> bool:
    return _helper().build_entry_exists(entry_name)


def should_use_build_entry(entry_name: str) -> bool:
    return _helper().should_use_build_entry(entry_name)


def iter_known_frontend_entries() -> tuple[str, ...]:
    return _helper().iter_known_frontend_entries()


__all__ = [
    "build_entry_exists",
    "frontend_page_entry_url",
    "get_build_entry_filename",
    "get_enabled_build_pages",
    "get_source_entry_filename",
    "is_build_enabled_for_page",
    "iter_known_frontend_entries",
    "should_use_build_entry",
]
