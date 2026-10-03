from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
GENERATOR = ROOT / "scripts" / "generate_modular_panel_stage8_contract.py"
SNAPSHOT = ROOT / "docs" / "modular-panel-stage8-contract.json"
CONTRACT = ROOT / "docs" / "modular-panel-stage8-contract.md"
PLAN = ROOT / "README-modular-panel-plan.md"
DOCS_INDEX = ROOT / "docs" / "README.md"


def _generate(tmp_path: Path) -> tuple[dict, str]:
    json_out = tmp_path / "stage8-contract.json"
    markdown_out = tmp_path / "stage8-contract.md"
    result = subprocess.run(
        [
            sys.executable,
            str(GENERATOR),
            "--root",
            str(ROOT),
            "--json-out",
            str(json_out),
            "--markdown-out",
            str(markdown_out),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr or result.stdout
    return (
        json.loads(json_out.read_text(encoding="utf-8")),
        markdown_out.read_text(encoding="utf-8"),
    )


def test_stage8_contract_generator_covers_boundaries_and_acceptance_matrix(tmp_path):
    payload, _markdown = _generate(tmp_path)

    assert payload["schema_version"] == 1
    assert payload["stage"] == {
        "id": "8.0",
        "name": "Контракты и границы менеджера официальных модулей",
        "status": "closed",
        "closed_on": "2026-10-03",
    }
    assert payload["source_of_truth"] == {
        "stage0_inventory": "docs/modular-panel-stage0-inventory.json",
        "stage7_profiles": "docs/modular-panel-stage7-installer-profiles.md",
        "module_registry": "xkeen-ui/services/module_registry.py",
        "profile_installer": "xkeen-ui/scripts/module_profile_install.py",
        "static_package_validator": "xkeen-ui/services/module_package_contract.py",
    }

    module_ids = [item["id"] for item in payload["modules"]]
    assert module_ids == [
        "core",
        "engine.xray",
        "engine.mihomo",
        "tool.editor",
        "tool.terminal",
        "tool.files",
        "tool.backups",
        "integration.happ",
        "tool.advanced-diagnostics",
    ]
    assert payload["profiles"]["xray-minimal"]["module_ids"] == [
        "core",
        "engine.xray",
        "tool.editor",
    ]

    ownership = payload["legacy_ownership"]
    assert ownership["install_root"] == "/opt/etc/xkeen-ui"
    assert "modules.json" in ownership["state_files"]
    assert "secret.key" in ownership["user_files"]
    assert "opt/etc/mihomo/profiles/" in ownership["user_prefixes"]
    assert ownership["ambiguous_files_default_to"] == "core"

    topology = payload["topology"]
    assert topology == {
        "payload_root": "modules/<module-id>/<version>/",
        "active_pointer": "modules/<module-id>/current",
        "registry": "modules/registry.json",
        "transaction_root": "module-transactions/<operation-id>/",
        "user_data_root": "var/ and declared core/engine config paths",
        "pointer_switch": "atomic rename within one filesystem",
    }

    catalog = payload["catalog"]
    assert catalog["channel_policy"] == {
        "required": "stable",
        "allowed": ["stable"],
        "branch_urls": False,
        "user_urls": False,
        "arbitrary_repositories": False,
    }
    assert catalog["required_fields"] == [
        "id",
        "version",
        "channel",
        "panel_api",
        "module_api",
        "min_core",
        "architectures",
        "requires",
        "conflicts",
        "requires_restart",
        "archive",
        "size",
        "sha256",
        "signing_key_id",
    ]
    assert payload["manifest"]["forbidden_payloads"] == [
        "absolute paths",
        ".. path components",
        "symlinks escaping the module root",
        "install/uninstall shell hooks",
    ]
    assert payload["static_preflight"] == {
        "validator": "xkeen-ui/services/module_package_contract.py",
        "trusted_signing_key_ids": ["release-2026"],
        "catalog_source": "official GitHub Releases HTTPS endpoint only",
        "archive_layout": {
            "manifest_path": "module-manifest.json",
            "payload_root": "payload/",
            "allowed_entry_types": ["directory", "regular_file"],
            "symlinks": False,
            "ownership": "exact normalized payload file list",
        },
        "entry_points": [
            "validate_catalog_source",
            "validate_catalog_entry",
            "validate_module_archive",
        ],
    }

    assert payload["compatibility"] == {
        "panel_api": "1",
        "module_api": "1",
        "manifest_schema_version": 1,
        "catalog_schema_version": 1,
        "version_format": "semver",
        "architecture_source": "uname -m normalized to catalog architecture ids",
    }
    assert [item["id"] for item in payload["acceptance_matrix"]] == [
        "unknown-signing-key",
        "checksum-mismatch",
        "unsupported-api",
        "module-only-file-diff",
        "panel-update-preserves-state",
        "profile-transition-separate-transaction",
        "offline-cached-catalog",
        "archive-path-safety",
        "stable-release-reproducibility",
    ]


def test_stage8_contract_snapshot_and_documentation_are_current(tmp_path):
    assert SNAPSHOT.is_file()
    assert CONTRACT.is_file()
    payload, markdown = _generate(tmp_path)
    assert json.loads(SNAPSHOT.read_text(encoding="utf-8")) == payload
    assert CONTRACT.read_text(encoding="utf-8") == markdown

    plan = PLAN.read_text(encoding="utf-8")
    docs_index = DOCS_INDEX.read_text(encoding="utf-8")
    assert "Подэтап 8.0 —" in plan
    assert "Контракты и границы — закрыт" in plan
    assert "modular-panel-stage8-contract.json" in plan
    assert "modular-panel-stage8-contract.md" in docs_index
    assert "generate_modular_panel_stage8_contract.py" in docs_index


def test_stage8_contract_rejects_unsafe_or_non_official_sources():
    text = CONTRACT.read_text(encoding="utf-8")
    for fragment in (
        "неизвестном signing_key_id",
        "SHA-256",
        "path traversal",
        "symlink escape",
        "arbitrary repositories",
        "install/uninstall shell hooks",
    ):
        assert fragment in text
