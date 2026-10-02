from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "xkeen-ui" / "scripts" / "module_profile_install.py"


def _module():
    spec = importlib.util.spec_from_file_location("module_profile_install", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _source(root: Path) -> Path:
    src = root / "source"
    files = {
        "app.py": "app = None",
        "services/module_registry.py": "# registry",
        "services/xray_subscriptions.py": "# xray subscriptions",
        "services/mihomo_subscriptions.py": "# mihomo subscriptions",
        "routes/routing/__init__.py": "# xray package",
        "routes/routing/blueprint.py": "# xray route",
        "routes/mihomo.py": "# mihomo route",
        "static/js/pages/terminal.lazy.entry.js": "terminal",
        "static/js/pages/file_manager.lazy.entry.js": "files",
        "templates/backups.html": "backups",
        "routes/happ_decryptor.py": "# happ route",
        "services/happ_decryptor/__init__.py": "# happ service",
        "routes/devtools.py": "# devtools route",
        "templates/devtools.html": "devtools",
        "static/js/pages/panel.routing.bundle.js": "xray bundle",
        "static/js/pages/panel.mihomo.bundle.js": "mihomo bundle",
        "static/js/pages/codemirror6.shared.js": "light editor",
        "static/monaco-editor/vs/editor.js": "monaco",
        "templates/panel/screens/routing.html": "xray screen",
        "templates/panel/screens/mihomo.html": "mihomo screen",
        "static/frontend-build/assets/panel.routing.bundle-123.js": "compiled xray",
        "static/frontend-build/assets/panel.mihomo.bundle-123.js": "compiled mihomo",
        "static/frontend-build/assets/panel-123.js": "compiled shared",
    }
    for name, data in files.items():
        path = src / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(data, encoding="utf-8")
    return src


def test_minimal_profile_copies_owned_backend_frontend_and_assets(tmp_path):
    helper = _module()
    src = _source(tmp_path)
    dest = tmp_path / "installed"

    transaction = helper.apply_profile(src, dest, "xray-minimal")
    helper.commit_profile(transaction)

    assert (dest / "app.py").is_file()
    assert (dest / "routes/routing/blueprint.py").is_file()
    assert (dest / "static/js/pages/panel.routing.bundle.js").is_file()
    assert (dest / "templates/panel/screens/routing.html").is_file()
    assert (dest / "static/frontend-build/assets/panel.routing.bundle-123.js").is_file()
    assert (dest / "static/js/pages/codemirror6.shared.js").is_file()
    assert not (dest / "routes/mihomo.py").exists()
    assert not (dest / "static/js/pages/panel.mihomo.bundle.js").exists()
    assert not (dest / "static/frontend-build/assets/panel.mihomo.bundle-123.js").exists()
    assert not (dest / "static/monaco-editor").exists()
    state = json.loads((dest / "modules.json").read_text(encoding="utf-8"))
    assert state["profile"] == "xray-minimal"
    assert state["editor"] == {"variant": "light"}
    installed = json.loads((dest / "module-installed.json").read_text(encoding="utf-8"))
    assert installed["modules"]["engine.xray"] is True
    assert installed["modules"]["engine.mihomo"] is False


def test_switching_from_full_quarantines_disabled_payload_and_keeps_user_state(tmp_path):
    helper = _module()
    src = _source(tmp_path)
    dest = tmp_path / "installed"
    helper.commit_profile(helper.apply_profile(src, dest, "full"))
    (dest / "secret.key").write_text("user-secret", encoding="utf-8")
    (dest / "xray-jsonc").mkdir()
    (dest / "xray-jsonc/custom.jsonc").write_text("user config", encoding="utf-8")
    (dest / "opt/etc/mihomo/profiles").mkdir(parents=True)
    (dest / "opt/etc/mihomo/config.yaml").write_text("user mihomo config", encoding="utf-8")
    (dest / "opt/etc/mihomo/profiles/custom.yaml").write_text("user mihomo profile", encoding="utf-8")

    transaction = helper.apply_profile(src, dest, "mihomo-minimal")
    helper.commit_profile(transaction)

    assert not (dest / "routes/routing/blueprint.py").exists()
    assert not (dest / "static/frontend-build/assets/panel.routing.bundle-123.js").exists()
    assert (dest / "routes/mihomo.py").is_file()
    assert (dest / "secret.key").read_text(encoding="utf-8") == "user-secret"
    assert (dest / "xray-jsonc/custom.jsonc").read_text(encoding="utf-8") == "user config"
    assert (dest / "opt/etc/mihomo/config.yaml").read_text(encoding="utf-8") == "user mihomo config"
    assert (dest / "opt/etc/mihomo/profiles/custom.yaml").read_text(encoding="utf-8") == "user mihomo profile"
    assert (transaction / "quarantine/routes/routing/blueprint.py").is_file()
    assert json.loads((dest / "modules.json").read_text(encoding="utf-8"))["profile"] == "mihomo-minimal"


def test_failed_profile_install_restores_prior_files_and_profile(tmp_path):
    helper = _module()
    src = _source(tmp_path)
    dest = tmp_path / "installed"
    helper.commit_profile(helper.apply_profile(src, dest, "full"))
    old_state = (dest / "modules.json").read_bytes()
    (src / "app.py").write_text("app = 'new'", encoding="utf-8")

    transaction = helper.apply_profile(src, dest, "xray-minimal")
    helper.rollback_profile(transaction)

    assert (dest / "app.py").read_text(encoding="utf-8") == "app = None"
    assert (dest / "routes/mihomo.py").is_file()
    assert (dest / "modules.json").read_bytes() == old_state


def test_rejects_insufficient_space_before_modifying_install(tmp_path, monkeypatch):
    helper = _module()
    src = _source(tmp_path)
    dest = tmp_path / "installed"
    dest.mkdir()
    (dest / "secret.key").write_text("keep", encoding="utf-8")
    monkeypatch.setattr(helper.shutil, "disk_usage", lambda _path: shutil._ntuple_diskusage(100, 100, 0))

    with pytest.raises(helper.ProfileInstallError, match="space"):
        helper.apply_profile(src, dest, "full")

    assert (dest / "secret.key").read_text(encoding="utf-8") == "keep"
    assert not (dest / "modules.json").exists()


def test_missing_selected_module_marker_rejects_payload(tmp_path):
    helper = _module()
    src = _source(tmp_path)
    (src / "services/xray_subscriptions.py").unlink()
    dest = tmp_path / "installed"

    with pytest.raises(helper.ProfileInstallError, match="install markers"):
        helper.apply_profile(src, dest, "xray-minimal")

    assert not (dest / "modules.json").exists()


def test_custom_profile_requires_editor_for_engine(tmp_path):
    helper = _module()
    src = _source(tmp_path)
    dest = tmp_path / "installed"

    with pytest.raises(helper.ProfileInstallError, match="tool.editor"):
        helper.apply_profile(src, dest, "custom", module_ids=["core", "engine.xray"])

    assert not dest.exists()


def test_custom_profile_installs_only_requested_optional_module(tmp_path):
    helper = _module()
    src = _source(tmp_path)
    dest = tmp_path / "installed"

    helper.apply_profile(src, dest, "custom", module_ids=["core", "tool.files"])

    assert (dest / "static/js/pages/file_manager.lazy.entry.js").is_file()
    assert not (dest / "routes/mihomo.py").exists()
    assert not (dest / "routes/routing/blueprint.py").exists()
    state = json.loads((dest / "modules.json").read_text(encoding="utf-8"))
    assert state["modules"]["tool.files"]["enabled"] is True
    assert state["modules"]["engine.xray"]["enabled"] is False


def test_real_frontend_manifest_excludes_opposite_engine_entry():
    helper = _module()
    frontend = helper._frontend_files(
        ROOT / "xkeen-ui", {"core", "engine.xray", "tool.editor"}, "light"
    )
    assert frontend is not None
    files, manifest, bridge = frontend
    assert "js/pages/panel.routing.bundle.js" in manifest
    assert "js/pages/panel.mihomo.bundle.js" not in manifest
    assert "js/pages/mihomo_generator.entry.js" not in manifest
    assert "static/frontend-build/assets/panel.mihomo.bundle-DyoOXfvB.js" not in files
    # A chunk the panel bootstrap imports statically has to come along even when
    # it carries the other engine's name.  Which chunk that is and what Vite
    # calls it changes from build to build, so check the rule, not the name:
    # nothing that stays may import a file that was left out.
    full = json.loads(
        (ROOT / "xkeen-ui/static/frontend-build/.vite/manifest.build.json").read_text(encoding="utf-8")
    )
    for key in manifest:
        for dependency in full[key].get("imports", []):
            assert dependency in manifest, f"{key} statically imports {dependency}, which was left out"
            assert "static/frontend-build/" + full[dependency]["file"] in files
    assert "static/js/pages/mihomo_generator.entry.js" not in files
    assert "static/js/pages/panel.routing.bundle.js" not in files
    assert "static/js/pages/mihomo_generator.entry.js" not in bridge


def test_upgrade_keeps_custom_editor_variant(tmp_path):
    helper = _module()
    src = _source(tmp_path)
    dest = tmp_path / "installed"
    helper.commit_profile(helper.apply_profile(src, dest, "full"))
    state = json.loads((dest / "modules.json").read_text(encoding="utf-8"))
    state["editor"]["variant"] = "advanced"
    (dest / "modules.json").write_text(json.dumps(state), encoding="utf-8")

    helper.commit_profile(helper.apply_profile(src, dest, "full"))

    assert json.loads((dest / "modules.json").read_text(encoding="utf-8"))["editor"] == {"variant": "advanced"}


def test_reinstalling_minimal_profile_does_not_restore_disabled_engine(tmp_path):
    helper = _module()
    src = _source(tmp_path)
    dest = tmp_path / "installed"
    helper.commit_profile(helper.apply_profile(src, dest, "xray-minimal"))

    helper.commit_profile(helper.apply_profile(src, dest, "xray-minimal"))

    assert not (dest / "routes/mihomo.py").exists()
    assert json.loads((dest / "modules.json").read_text(encoding="utf-8"))["profile"] == "xray-minimal"


def test_real_frontend_manifest_has_resolved_static_imports():
    helper = _module()
    frontend = helper._frontend_files(
        ROOT / "xkeen-ui", {"core", "engine.xray", "tool.editor"}, "light"
    )
    assert frontend is not None
    files, manifest, _bridge = frontend
    for entry in manifest.values():
        assert all(key in manifest for key in entry.get("imports", []))
        assert "static/frontend-build/" + entry["file"] in files
        assert (ROOT / "xkeen-ui" / "static/frontend-build" / entry["file"]).is_file()


def test_stale_precompressed_asset_is_quarantined_and_restored_on_rollback(tmp_path):
    helper = _module()
    src = _source(tmp_path)
    dest = tmp_path / "installed"
    helper.commit_profile(helper.apply_profile(src, dest, "full"))
    stale = dest / "static/js/old.js.gz"
    stale.parent.mkdir(parents=True, exist_ok=True)
    stale.write_bytes(b"old-gzip")

    transaction = helper.apply_profile(src, dest, "xray-minimal")
    assert not stale.exists()
    assert (transaction / "quarantine/static/js/old.js.gz").read_bytes() == b"old-gzip"

    helper.rollback_profile(transaction)
    assert stale.read_bytes() == b"old-gzip"


def test_legacy_install_without_managed_manifest_quarantines_old_generated_asset(tmp_path):
    helper = _module()
    src = _source(tmp_path)
    dest = tmp_path / "installed"
    stale = dest / "static/frontend-build/assets/obsolete-shared.js"
    stale.parent.mkdir(parents=True)
    stale.write_text("old", encoding="utf-8")

    transaction = helper.apply_profile(src, dest, "xray-minimal")

    assert not stale.exists()
    assert (transaction / "quarantine/static/frontend-build/assets/obsolete-shared.js").is_file()


def test_untrusted_managed_manifest_cannot_escape_install_root(tmp_path):
    helper = _module()
    src = _source(tmp_path)
    dest = tmp_path / "installed"
    dest.mkdir()
    outside = tmp_path / "outside.txt"
    outside.write_text("user data", encoding="utf-8")
    (dest / "install-managed.json").write_text(
        json.dumps({"paths": ["../outside.txt"]}), encoding="utf-8"
    )

    helper.apply_profile(src, dest, "xray-minimal")

    assert outside.read_text(encoding="utf-8") == "user data"


@pytest.mark.parametrize("profile,expected,excluded", [
    ("xray-minimal", "engine.xray", "engine.mihomo"),
    ("mihomo-minimal", "engine.mihomo", "engine.xray"),
])
def test_minimal_package_imports_real_panel(tmp_path, profile, expected, excluded):
    helper = _module()
    installed = tmp_path / "installed"
    helper.commit_profile(helper.apply_profile(ROOT / "xkeen-ui", installed, profile))
    env = dict(os.environ, PYTHONPATH=str(installed), XKEEN_UI_STATE_DIR=str(installed))
    process = subprocess.run(
        [sys.executable, "-c", (
            "from services.module_registry import ModuleRegistry; "
            "original = ModuleRegistry._is_requirement_available; "
            "ModuleRegistry._is_requirement_available = lambda self, key: True if key in ('xkeen', 'xray', 'mihomo') else original(self, key); "
            "import app; print(app.app.extensions['xkeen.module_activation']['active_module_ids'])"
        )],
        cwd=installed, env=env, capture_output=True, text=True, timeout=30,
    )
    assert process.returncode == 0, process.stderr
    assert expected in process.stdout
    assert excluded not in process.stdout
    assert not (installed / ("routes/mihomo.py" if excluded == "engine.mihomo" else "routes/routing/blueprint.py")).exists()
