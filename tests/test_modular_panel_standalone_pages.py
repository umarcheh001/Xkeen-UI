"""Standalone pages must render for every module set, not only for Full."""

from __future__ import annotations

import re

import pytest

from tests.support.panel_render import (
    FULL_MODULE_IDS,
    MIHOMO_MINIMAL_MODULE_IDS,
    ROOT,
    XRAY_MINIMAL_MODULE_IDS,
    build_panel_app,
)


MODULE_SETS = {
    "legacy": None,
    "full": FULL_MODULE_IDS,
    "xray-minimal": XRAY_MINIMAL_MODULE_IDS,
    "mihomo-minimal": MIHOMO_MINIMAL_MODULE_IDS,
    "core-only": ["core"],
    "backups-without-diagnostics": ["core", "tool.editor", "engine.xray", "tool.backups"],
    "diagnostics-only": ["core", "tool.advanced-diagnostics"],
}


def _app(module_ids, tmp_path):
    app = build_panel_app(module_ids, tmp_path)
    if module_ids is None or "tool.backups" in module_ids:
        from routes.backups import create_backups_blueprint

        app.register_blueprint(
            create_backups_blueprint(
                BACKUP_DIR=str(tmp_path / "backups"),
                ROUTING_FILE=str(tmp_path / "05_routing.json"),
                ROUTING_FILE_RAW=str(tmp_path / "05_routing.jsonc"),
                INBOUNDS_FILE=str(tmp_path / "03_inbounds.json"),
                OUTBOUNDS_FILE=str(tmp_path / "04_outbounds.json"),
                load_json=lambda path, default=None: default,
                save_json=lambda path, data: None,
                list_backups=lambda: [],
                _detect_backup_target_file=lambda name: name,
                _find_latest_auto_backup_for=lambda path: (None, None),
                strip_json_comments_text=lambda text: text,
                restart_xkeen=lambda *args, **kwargs: True,
            )
        )
    return app


def _has(module_ids, module_id):
    return module_ids is None or module_id in module_ids


@pytest.mark.parametrize("name", sorted(MODULE_SETS))
def test_standalone_pages_never_fail_for_a_module_set(name, tmp_path):
    # A page of one module linked to a page of another one with a bare
    # url_for(), so turning the second module off broke the first page.
    module_ids = MODULE_SETS[name]
    client = _app(module_ids, tmp_path).test_client()

    expected = {
        "/": 200,
        "/xkeen": 200,
        "/mihomo_generator": 200 if _has(module_ids, "engine.mihomo") else 404,
        "/devtools": 200 if _has(module_ids, "tool.advanced-diagnostics") else 404,
        "/backups": 200 if _has(module_ids, "tool.backups") else 404,
    }
    assert {path: client.get(path).status_code for path in expected} == expected


@pytest.mark.parametrize("name", sorted(MODULE_SETS))
def test_standalone_pages_link_to_devtools_only_when_it_is_registered(name, tmp_path):
    module_ids = MODULE_SETS[name]
    client = _app(module_ids, tmp_path).test_client()
    has_devtools = _has(module_ids, "tool.advanced-diagnostics")

    for path in ("/xkeen", "/mihomo_generator", "/backups"):
        response = client.get(path)
        if response.status_code != 200:
            continue
        html = response.get_data(as_text=True)
        links = re.findall(r'href="/devtools[^"]*"', html)
        assert bool(links) == has_devtools, f"{name}: {path}"
        assert ('id="xk-update-link"' in html) == has_devtools, f"{name}: {path}"


@pytest.mark.parametrize("name", sorted(MODULE_SETS))
def test_devtools_shows_the_link_utility_card_only_with_its_module(name, tmp_path):
    # The card's API exists only with integration.happ; without the module the
    # page drew dead buttons and asked for a status that answered 404.
    module_ids = MODULE_SETS[name]
    response = _app(module_ids, tmp_path).test_client().get("/devtools")
    if response.status_code != 200:
        return
    html = response.get_data(as_text=True)
    assert ('id="dt-happ-decryptor-card"' in html) == _has(module_ids, "integration.happ")
    assert 'id="dt-update-card"' in html
    assert 'id="dt-logging-card"' in html


def test_devtools_does_not_start_the_link_utility_card_without_its_markup():
    source = (
        ROOT / "xkeen-ui" / "static" / "js" / "features" / "devtools.js"
    ).read_text(encoding="utf-8")
    wiring = re.search(r"_wireDeferredModuleInit\('happDecryptor'[^\n]*", source)
    assert wiring and "requireTarget: true" in wiring.group(0)
    assert re.search(r"if \(!target\) \{\s*if \(cfg\.requireTarget\) return;", source)
