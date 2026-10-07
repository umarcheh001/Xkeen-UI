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
LIFECYCLE_DOC = ROOT / "docs" / "modular-panel-stage8-lifecycle-api.md"
PANEL_PROFILE_DOC = ROOT / "docs" / "modular-panel-stage8-panel-profile.md"


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
        "panel_profile_runbook": "docs/modular-panel-stage8-panel-profile.md",
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
        "payload_root": "/opt/etc/xkeen-ui (ownership paths from the module manifest)",
        "apply": "journaled per-file replace with backup",
        "registry": "module-installed.json + module-ownership.json",
        "transaction_root": "/opt/etc/xkeen-ui.module-transactions/<operation-id>/",
        "user_data_root": "var/ and declared core/engine config paths",
        "module_version": "equal to the installed panel release",
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
        "architectures": ["aarch64", "mips", "mipsel"],
        "architecture_source": "services.module_package_contract.detect_platform_architecture: uname -m normalized to catalog architecture ids; MIPS byte order decides between mips and mipsel",
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
    assert payload["release_assets"] == {
        "builder": "scripts/build_modular_panel_release.py",
        "panel_archive": "xkeen-ui-panel-<version>.tar.gz",
        "module_archive": "xkeen-module-<module-id>-<version>.tar.gz",
        "catalog": "catalog.json",
        "catalog_signature": "catalog.json.sig",
        "checksums": "<asset>.sha256",
        "metadata": "release-metadata.json",
        "channel": "stable",
        "signing_key_id": "release-2026",
    }
    assert payload["trust_client"] == {
        "algorithm": "Ed25519",
        "signature_asset": "catalog.json.sig",
        "discovery": "https://api.github.com/repos/umarcheh001/Xkeen-UI/releases/latest",
        "cache_ttl_seconds": 86400,
        "allowed_redirect_hosts": [
            "github.com",
            "objects.githubusercontent.com",
            "release-assets.githubusercontent.com",
        ],
        "stale_fallback": "transport failures only",
        "anti_rollback": "highest verified release version",
    }
    assert payload["determinism"] == {
        "tar_format": "ustar",
        "member_order": "POSIX path ascending",
        "uid_gid": 0,
        "owner_names": "empty",
        "mtime": "SOURCE_DATE_EPOCH",
        "gzip_filename": "empty",
        "gzip_mtime": "SOURCE_DATE_EPOCH",
        "module_layout": ["module-manifest.json", "payload/<ownership-path>"],
    }
    assert payload["ci_publication"] == {
        "workflow": ".github/workflows/build-user-archive.yml",
        "push_validation": True,
        "tag_condition": "startsWith(github.ref, 'refs/tags/v')",
        "catalog_signing": {
            "script": "scripts/sign_modular_panel_catalog.py",
            "private_key_environment": "XKEEN_RELEASE_ED25519_PRIVATE_KEY",
            "tag_only": True,
        },
        "artifact_path": "dist/modular-panel/**",
        "release_asset_source": "release-metadata.json",
        "legacy_bootstrap_archive": "xkeen-ui-routing.tar.gz",
    }


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
    assert "Упаковка и release assets — закрыт" in plan
    assert "Trust и клиент каталога — закрыт" in plan
    assert "modular-panel-stage8-contract.json" in plan
    assert "modular-panel-stage8-contract.md" in docs_index
    assert "generate_modular_panel_stage8_contract.py" in docs_index
    assert "build_modular_panel_release.py" in docs_index
    assert "sign_modular_panel_catalog.py" in docs_index


def test_stage8_contract_rejects_unsafe_or_non_official_sources():
    text = CONTRACT.read_text(encoding="utf-8")
    for fragment in (
        "неизвестном signing_key_id",
        "SHA-256",
        "path traversal",
        "symlink escape",
        "arbitrary repositories",
        "install/uninstall shell hooks",
        "xkeen-ui-panel-<version>.tar.gz",
        "SOURCE_DATE_EPOCH",
        "release-metadata.json",
        "Ed25519",
        "catalog.json.sig",
        "XKEEN_RELEASE_ED25519_PRIVATE_KEY",
    ):
        assert fragment in text


def test_stage8_contract_describes_the_shared_root_transaction_engine() -> None:
    payload = json.loads((ROOT / "docs" / "modular-panel-stage8-contract.json").read_text(encoding="utf-8"))
    markdown = (ROOT / "docs" / "modular-panel-stage8-contract.md").read_text(encoding="utf-8")

    matrix = {item["id"]: item["expected"] for item in payload["acceptance_matrix"]}
    assert matrix["module-only-file-diff"] == "change only manifest files of the selected module and state files"
    assert matrix["checksum-mismatch"] == "reject before unpack and leave the panel tree untouched"
    operations = payload["operations"]
    assert operations["module_only"] == [
        "catalog", "plan", "stage", "verify", "apply", "state", "restart", "health", "commit_or_rollback",
    ]
    assert operations["post_restart_owner"] == "detached module runner; the init script undoes an interrupted operation"
    assert "pointer" not in json.dumps(payload["topology"])
    assert "modules/<module-id>" not in markdown
    assert "module-ownership.json" in markdown
    assert "xkeen-ui.module-transactions" in markdown


def test_stage8_contract_describes_closed_lifecycle_api(tmp_path) -> None:
    payload, markdown = _generate(tmp_path)
    lifecycle = payload["lifecycle_api"]

    assert lifecycle["stage"] == {
        "id": "8.4",
        "status": "closed",
        "closed_on": "2026-10-06",
    }
    assert lifecycle["service"] == "xkeen-ui/services/module_lifecycle.py"
    assert [(item["method"], item["path"], item["success_status"]) for item in lifecycle["routes"]] == [
        ("GET", "/api/modules/installed", 200),
        ("GET", "/api/modules/available", 200),
        ("POST", "/api/modules/operations/plan", 200),
        ("POST", "/api/modules/operations/apply", 202),
        ("GET", "/api/modules/operations/status", 200),
        ("POST", "/api/modules/operations/<operation_id>/cancel", 202),
        ("POST", "/api/modules/recovery", 200),
        ("POST", "/api/modules/restart", 200),
    ]
    assert lifecycle["operations"] == [
        "install",
        "repair",
        "remove",
        "panel-update",
        "profile-transition",
    ]
    assert lifecycle["execution"] == "detached module transaction runner"
    assert lifecycle["plan_guard"] == "lowercase SHA-256 of canonical server plan and dependency diff"
    assert lifecycle["update_available"] is False
    assert lifecycle["recovery_restarts_implicitly"] is False
    assert "## Lifecycle API 8.4" in markdown


def test_stage8_lifecycle_document_and_roadmap_are_closed() -> None:
    assert LIFECYCLE_DOC.is_file()
    lifecycle = LIFECYCLE_DOC.read_text(encoding="utf-8")
    plan = PLAN.read_text(encoding="utf-8")
    docs_index = DOCS_INDEX.read_text(encoding="utf-8")

    for fragment in (
        "GET /api/modules/installed",
        "POST /api/modules/operations/apply",
        "module_plan_stale",
        "SIGTERM",
        "module_transaction.py",
        "POST /api/modules/recovery",
        "POST /api/modules/restart",
    ):
        assert fragment in lifecycle
    assert "8.3 и 8.4 закрыты 6 октября 2026 года" in plan
    assert "следующий — подэтап 8.6" in plan
    assert "modular-panel-stage8-lifecycle-api.md" in docs_index


def test_stage8_contract_describes_closed_panel_and_profile_transactions(tmp_path) -> None:
    payload, markdown = _generate(tmp_path)
    panel_profile = payload["panel_profile"]

    assert panel_profile["stage"] == {
        "id": "8.5",
        "status": "closed",
        "closed_on": "2026-10-07",
    }
    assert panel_profile["panel_descriptor_fields"] == [
        "archive",
        "size",
        "sha256",
        "version",
        "signing_key_id",
        "architectures",
    ]
    assert panel_profile["operations"] == {
        "panel-update": {
            "scope": "panel",
            "sequence": [
                "catalog",
                "download",
                "verify",
                "plan",
                "apply",
                "state",
                "restart",
                "health",
                "commit_or_full_rollback",
            ],
        },
        "profile-transition": {
            "scope": "profile",
            "sequence": [
                "current_release",
                "download",
                "verify",
                "plan",
                "apply",
                "state",
                "restart",
                "health",
                "commit_or_full_rollback",
            ],
        },
    }
    assert panel_profile["profile_transition"] == {
        "pending_fields": ["transition_required", "transition_target"],
        "restart_guard": "profile_transition_required",
        "stale_plan_code": "operation_plan_stale",
        "module_id_forbidden": True,
    }
    assert panel_profile["devtools"] == {
        "stable": "delegates panel-update plan/apply/status to ModuleLifecycleService",
        "main": "legacy branch update path marked development_only",
        "rollback": "legacy panel backup rollback; never a module transaction rollback",
    }
    assert panel_profile["rollback_scopes"] == {
        "module": "selected module files and state",
        "panel": "all replaced managed panel files and state",
        "profile": "all added/removed managed profile files and state",
    }
    assert panel_profile["stable_error_codes"] == [
        "panel_update_unavailable",
        "panel_version_current",
        "panel_archive_invalid",
        "profile_transition_required",
        "profile_transition_not_required",
        "profile_payload_unavailable",
        "profile_target_invalid",
        "operation_free_space",
    ]
    assert "## Panel update и profile transition 8.5" in markdown


def test_stage8_panel_profile_operator_contract_and_roadmap_are_closed() -> None:
    assert PANEL_PROFILE_DOC.is_file()
    operator = PANEL_PROFILE_DOC.read_text(encoding="utf-8")
    plan = PLAN.read_text(encoding="utf-8")
    docs_index = DOCS_INDEX.read_text(encoding="utf-8")

    for fragment in (
        '"operation": "panel-update"',
        '"operation": "profile-transition"',
        "transition_required",
        "profile_transition_required",
        "operation_plan_stale",
        "rollback_failed",
        "POST /api/modules/recovery",
        "Stable",
        "development_only",
        "Ручное восстановление",
    ):
        assert fragment in operator
    assert "Подэтап 8.5" in plan
    assert "закрыт 7 октября 2026 года" in plan
    assert "следующий — подэтап 8.6" in plan
    assert "modular-panel-stage8-panel-profile.md" in docs_index
