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
    assert 'happ-decrypt-universal' in script
    assert 'LOCAL_DECRYPTOR_BIN_DIR' in script
    assert 'replace_file_with_retries(temp_archive, archive_path)' in script
    assert 'derive_fallback_archive_path(archive_path)' in script
    assert 'Path(str(archive_path) + ".sha256")' in script


def test_local_happ_decryptor_files_stay_out_of_git():
    # Happ key material lives in bin/happ-decrypt-universal.assets/, research copies in .tmp/.
    gitignore = (ROOT / ".gitignore").read_text(encoding="utf-8")

    assert "/xkeen-ui/bin/happ-decrypt*" in gitignore
    assert "!/xkeen-ui/bin/README.happ-decryptor.txt" in gitignore
    assert "/.tmp/leeeet-happ-decryptor/" in gitignore
    assert "\n.tmp/" in gitignore
    assert "/handoff/" in gitignore
    assert not (ROOT / "scripts" / "build_happ_decryptor_aarch64.py").exists(), "old builder embedded Happ keys"
    assert not (ROOT / "scripts" / "build_happ_decryptor_node.py").exists(), "the Go engine replaced the Node emulator build"


def test_package_json_exposes_local_user_archive_commands():
    package_json = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    scripts = package_json.get("scripts") or {}

    assert scripts.get("archive:user") == "node scripts/run_python.mjs scripts/build_user_archive.py"
    assert scripts.get("archive:user:skip-build") == "node scripts/run_python.mjs scripts/build_user_archive.py --skip-frontend-build"
