from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_local_user_archive_script_matches_ci_packaging_expectations():
    script = (ROOT / "scripts" / "build_user_archive.py").read_text(encoding="utf-8")

    assert 'PROJECT_DIRNAME = "xkeen-ui"' in script
    assert '"__pycache__"' in script
    assert '"BUILD.json"' in script
    assert 'Path("opt/etc/mihomo/backup")' in script
    assert '["npm", "run", "frontend:build"]' in script
    assert 'tarfile.open(archive_path, "w:gz", format=tarfile.USTAR_FORMAT)' in script
    assert 'write_build_json(package_root, stamp=stamp, update_url=update_url)' in script
    assert 'filter=normalize_archive_tarinfo' in script
    assert 'happ-decrypt-universal' in script
    assert 'replace_file_with_retries(temp_archive, archive_path)' in script
    assert 'derive_fallback_archive_path(archive_path)' in script
    assert 'Path(str(archive_path) + ".sha256")' in script


def test_happ_decryptor_aarch64_build_script_is_local_only():
    script = (ROOT / "scripts" / "build_happ_decryptor_aarch64.py").read_text(encoding="utf-8")
    gitignore = (ROOT / ".gitignore").read_text(encoding="utf-8")

    assert "LeeeeT/happ-decryptor.git" in script
    assert "PKCS1_KEYS_B64" in script
    assert "public/data/expanded_rsa_keys.json" in script
    assert '"GOARCH": goarch' in script
    assert '"arm64"' in script
    assert "/xkeen-ui/bin/happ-decrypt*" in gitignore
    assert "!/xkeen-ui/bin/README.happ-decryptor.txt" in gitignore
    assert "/.tmp/leeeet-happ-decryptor/" in gitignore


def test_happ_decryptor_node_build_script_uses_current_local_emulator_assets():
    script = (ROOT / "scripts" / "build_happ_decryptor_node.py").read_text(encoding="utf-8")
    gitignore = (ROOT / ".gitignore").read_text(encoding="utf-8")

    assert "LeeeeT/happ-decryptor.git" in script
    assert "public/emu/liberror-code.so" in script
    assert "public/data/keytable.json" in script
    assert "happ-decrypt-universal.assets" in script
    assert "XKEEN_HAPP_DECRYPTOR_CMD" in script
    assert "async function initRuntime()" in script
    assert "import('node:fs')" in script
    assert "createRequire" in script or "moduleMod.createRequire" in script
    assert "pathToFileURL" in script
    assert "import fs from 'node:fs';" not in script
    assert "/xkeen-ui/bin/happ-decrypt*" in gitignore


def test_package_json_exposes_local_user_archive_commands():
    package_json = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    scripts = package_json.get("scripts") or {}

    assert scripts.get("archive:user") == "node scripts/run_python.mjs scripts/build_user_archive.py"
    assert scripts.get("archive:user:skip-build") == "node scripts/run_python.mjs scripts/build_user_archive.py --skip-frontend-build"
