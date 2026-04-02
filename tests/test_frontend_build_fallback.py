from __future__ import annotations

import json
import os
import sys
import types
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
STATIC_DIR = ROOT / "xkeen-ui" / "static"
BUILD_DIR = STATIC_DIR / "frontend-build"
MANIFEST_PATH = BUILD_DIR / ".vite" / "manifest.json"

EXPECTED_BUILD_ENTRIES = {
    "panel": "static/js/pages/panel.entry.js",
    "xkeen": "static/js/pages/xkeen.entry.js",
    "backups": "static/js/pages/backups.entry.js",
    "devtools": "static/js/pages/devtools.entry.js",
    "mihomo_generator": "static/js/pages/mihomo_generator.entry.js",
}


def _import_ui_assets_module():
    fake_flask = types.ModuleType("flask")

    class _Flask:
        pass

    class _Response:
        pass

    fake_flask.Flask = _Flask
    fake_flask.Response = _Response
    fake_flask.current_app = None
    fake_flask.request = None
    fake_flask.send_file = lambda *args, **kwargs: None
    fake_flask.url_for = lambda *args, **kwargs: ""

    sys.modules.setdefault("flask", fake_flask)

    import routes.ui_assets as ui_assets

    return ui_assets


def test_frontend_build_manifest_still_matches_known_entrypoints():
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))

    assert set(manifest) == set(EXPECTED_BUILD_ENTRIES.values())

    for entry_name, source_entry in EXPECTED_BUILD_ENTRIES.items():
        manifest_entry = manifest[source_entry]
        build_relpath = manifest_entry["file"]
        build_path = BUILD_DIR / build_relpath
        assert build_path.is_file(), f"missing build asset for {entry_name}: {build_relpath}"


def test_frontend_asset_helper_falls_back_to_source_when_build_entry_uses_legacy_loader(tmp_path):
    ui_assets = _import_ui_assets_module()
    previous = os.environ.get("XKEEN_UI_FRONTEND_BUILD_PAGES")
    os.environ["XKEEN_UI_FRONTEND_BUILD_PAGES"] = "all"

    try:
        static_dir = tmp_path / "static"
        manifest_dir = static_dir / "frontend-build" / ".vite"
        asset_dir = static_dir / "frontend-build" / "assets"
        manifest_dir.mkdir(parents=True, exist_ok=True)
        asset_dir.mkdir(parents=True, exist_ok=True)

        manifest = {
            EXPECTED_BUILD_ENTRIES["panel"]: {
                "file": "assets/panel-legacy.js",
                "isEntry": True,
                "name": "panel",
                "src": EXPECTED_BUILD_ENTRIES["panel"],
            }
        }
        (manifest_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        (asset_dir / "panel-legacy.js").write_text(
            "import './legacy_script_loader.js';\nbootLegacyEntry('panel');\n",
            encoding="utf-8",
        )

        helper = ui_assets.FrontendAssetHelper(static_folder=str(static_dir))
        assert helper.build_entry_exists("panel")
        assert helper.build_entry_uses_legacy_loader("panel")
        assert not helper.should_use_build_entry("panel")
    finally:
        if previous is None:
            os.environ.pop("XKEEN_UI_FRONTEND_BUILD_PAGES", None)
        else:
            os.environ["XKEEN_UI_FRONTEND_BUILD_PAGES"] = previous


def test_frontend_asset_helper_prefers_current_build_wrappers_when_they_are_modern():
    ui_assets = _import_ui_assets_module()
    previous = os.environ.get("XKEEN_UI_FRONTEND_BUILD_PAGES")
    os.environ["XKEEN_UI_FRONTEND_BUILD_PAGES"] = "all"

    try:
        helper = ui_assets.FrontendAssetHelper(static_folder=str(STATIC_DIR))
        for entry_name, source_entry in EXPECTED_BUILD_ENTRIES.items():
            assert helper.build_entry_exists(entry_name), f"expected build entry for {entry_name}"
            assert not helper.build_entry_uses_legacy_loader(entry_name), (
                f"{entry_name} build wrapper should hand off to canonical source entrypoint without legacy loader"
            )
            assert helper.should_use_build_entry(entry_name), (
                f"{entry_name} should use manifest-managed build wrapper in the current project state"
            )
            build_path = BUILD_DIR / json.loads(MANIFEST_PATH.read_text(encoding='utf-8'))[source_entry]["file"]
            text = build_path.read_text(encoding="utf-8")
            assert f"import '../../{source_entry[7:]}';" in text
    finally:
        if previous is None:
            os.environ.pop("XKEEN_UI_FRONTEND_BUILD_PAGES", None)
        else:
            os.environ["XKEEN_UI_FRONTEND_BUILD_PAGES"] = previous
