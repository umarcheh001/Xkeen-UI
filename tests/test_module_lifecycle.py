from __future__ import annotations

import pytest

from services.module_catalog_client import CatalogTransportError, official_release_asset_url
from services.module_lifecycle import ModuleLifecycleError
from tests.support.module_lifecycle import make_service
from tests.support.module_tx import VERSION, make_panel, make_release


def test_installed_uses_actual_install_manifest_without_fetching_catalog(tmp_path):
    panel = make_panel(tmp_path)
    service, catalog = make_service(panel, make_release())

    payload = service.installed()

    assert payload["ok"] is True
    assert payload["installed_module_ids"] == ["core", "engine.xray", "tool.editor"]
    assert {item["id"] for item in payload["modules"]} == {
        "core",
        "engine.xray",
        "tool.editor",
    }
    assert payload["lifecycle"] == {"available": True, "code": None}
    assert catalog.requested_versions == []


def test_installed_remains_readable_when_install_manifest_is_missing(tmp_path):
    panel = make_panel(tmp_path)
    service, catalog = make_service(panel, make_release())
    panel.path("module-installed.json").unlink()

    payload = service.installed()

    assert payload["ok"] is True
    assert payload["lifecycle"] == {
        "available": False,
        "code": "module_state_unavailable",
    }
    assert payload["installed_module_ids"]
    assert catalog.requested_versions == []


def test_available_uses_installed_release_and_exposes_only_stage83_actions(tmp_path):
    panel = make_panel(tmp_path)
    service, catalog = make_service(panel, make_release())

    payload = service.available()
    modules = {item["id"]: item for item in payload["modules"]}

    assert catalog.requested_versions == [VERSION]
    assert payload["release_version"] == VERSION
    assert payload["catalog_url"] == official_release_asset_url(VERSION, "catalog.json")
    assert payload["freshness"] == "fresh"
    assert modules["core"]["lifecycle_actions"] == []
    assert modules["tool.editor"]["lifecycle_actions"] == ["repair"]
    assert modules["engine.xray"]["lifecycle_actions"] == ["repair", "remove"]
    assert modules["tool.terminal"]["lifecycle_actions"] == ["install"]
    assert all(item["update_available"] is False for item in modules.values())


def test_available_never_offers_install_for_absent_repair_only_editor(tmp_path):
    panel = make_panel(tmp_path, installed=("core",))
    service, _ = make_service(panel, make_release())

    modules = {item["id"]: item for item in service.available()["modules"]}

    assert modules["tool.editor"]["installed"] is False
    assert modules["tool.editor"]["lifecycle_actions"] == []


def test_available_maps_exact_release_transport_failure_to_503(tmp_path):
    panel = make_panel(tmp_path)
    release = make_release()
    for url in list(release.transport.responses):
        release.transport.fail[url] = CatalogTransportError(
            "catalog_transport_unavailable", "offline"
        )
    service, _ = make_service(panel, release)

    with pytest.raises(ModuleLifecycleError) as raised:
        service.available()

    assert raised.value.code == "catalog_unavailable"
    assert raised.value.status == 503
    assert raised.value.details == {}
