"""The trimmed frontend build of a profile keeps every core file Xray names.

The Xray chunks import the core by the name `xk-core/<path>`, which the
importmap resolves through the installed `manifest.build.json`. Nothing in the
manifest points at such an entry, so the installer has to follow these names in
the built files it keeps: a missing entry fails the static import, and the whole
Xray part with it.
"""

from __future__ import annotations

import importlib.util
import re
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
PANEL = ROOT / "xkeen-ui"
MANIFEST = PANEL / "static/frontend-build/.vite/manifest.build.json"

# Minified static forms: `from"xk-core/..."` and `import"xk-core/..."`;
# `import("xk-core/...")` is dynamic and is not followed by the installer.
STATIC_CORE_IMPORT = re.compile(r"""(?:\bfrom|\bimport)\s*["'`]xk-core/([^"'`]+)["'`]""")

pytestmark = pytest.mark.skipif(not MANIFEST.is_file(), reason="needs npm run frontend:build")

SETS = {
    "xray": {"core", "tool.editor", "engine.xray"},
    "xray+mihomo": {"core", "tool.editor", "engine.mihomo", "engine.xray"},
}


def _installer():
    path = PANEL / "scripts" / "module_profile_install.py"
    spec = importlib.util.spec_from_file_location("module_profile_install_xk_core", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("variant", ["light", "full"])
@pytest.mark.parametrize("modules", sorted(SETS))
def test_kept_chunks_find_every_core_public_name(modules: str, variant: str) -> None:
    files, manifest, _ = _installer()._frontend_files(PANEL, set(SETS[modules]), variant)
    missing: list[str] = []
    seen = 0

    for rel in sorted(files):
        if not (rel.startswith("static/frontend-build/") and rel.endswith(".js")):
            continue
        for public in STATIC_CORE_IMPORT.findall((PANEL / rel).read_text(encoding="utf-8")):
            seen += 1
            entry = manifest.get(public)
            if not isinstance(entry, dict):
                missing.append(f"{rel} -> {public}: no manifest entry")
            elif "static/frontend-build/" + entry["file"] not in files:
                missing.append(f"{rel} -> {public}: {entry['file']} not installed")

    assert seen >= 20
    assert missing == []


def test_light_editor_still_leaves_the_advanced_editor_out() -> None:
    # Routing loads these two through import() and copes without them; only
    # static names are followed, as the manifest `imports` always were.
    _, manifest, _ = _installer()._frontend_files(PANEL, set(SETS["xray"]), "light")

    assert "js/ui/schema_semantic_validation.js" in manifest
    assert "js/ui/prettier_loader.js" not in manifest
    assert "js/ui/schema_quickfixes.js" not in manifest
