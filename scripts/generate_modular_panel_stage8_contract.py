from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


SCHEMA_VERSION = 1
STAGE = {
    "id": "8.0",
    "name": "Контракты и границы менеджера официальных модулей",
    "status": "closed",
    "closed_on": "2026-10-03",
}

MODULE_REGISTRY = "xkeen-ui/services/module_registry.py"
PROFILE_INSTALLER = "xkeen-ui/scripts/module_profile_install.py"
STATIC_PACKAGE_VALIDATOR = "xkeen-ui/services/module_package_contract.py"


def _load_sources(root: Path):
    sys.path.insert(0, str(root / "xkeen-ui"))
    from services.module_registry import MODULE_DEFINITIONS, PROFILE_PRESETS  # noqa: PLC0415
    from services.module_package_contract import TRUSTED_SIGNING_KEY_IDS  # noqa: PLC0415

    import importlib.util

    path = root / PROFILE_INSTALLER
    spec = importlib.util.spec_from_file_location("stage8_profile_installer", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    installer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(installer)
    return MODULE_DEFINITIONS, PROFILE_PRESETS, TRUSTED_SIGNING_KEY_IDS, installer


def _module_payload(definitions) -> list[dict[str, Any]]:
    return [
        {
            "id": item.id,
            "name": item.name,
            "version": item.version,
            "dependencies": list(item.dependencies),
            "conflicts": list(item.conflicts),
            "requires_restart": item.requires_restart,
            "removable": item.removable,
            "can_disable": item.can_disable,
        }
        for item in definitions
    ]


def _profile_payload(presets) -> dict[str, dict[str, Any]]:
    return {
        profile: {
            "module_ids": list(module_ids),
            "transition_kind": "profile-transition",
            "source": "Stage 7 installer/profile transaction",
        }
        for profile, module_ids in presets.items()
    }


def build_contract(root: Path) -> dict[str, Any]:
    definitions, presets, trusted_signing_key_ids, installer = _load_sources(root)
    ownership = {
        "install_root": "/opt/etc/xkeen-ui",
        "managed_payload_roots": [
            "core/",
            "routes/",
            "services/",
            "static/",
            "templates/",
            "scripts/",
        ],
        "state_files": sorted(installer.STATE_FILES),
        "user_files": sorted(installer.USER_FILES),
        "user_top_level": sorted(installer.USER_TOP_LEVEL),
        "user_prefixes": list(installer.USER_PREFIXES),
        "ambiguous_files_default_to": "core",
        "legacy_rule": "reuse Stage 7 owner(path); quarantine unknown managed files before removal",
        "core_owned_runtime_maps": ["xkeen-ui/services/module_registry.py", "xkeen-ui/module-sizes.json"],
    }
    topology = {
        "payload_root": "modules/<module-id>/<version>/",
        "active_pointer": "modules/<module-id>/current",
        "registry": "modules/registry.json",
        "transaction_root": "module-transactions/<operation-id>/",
        "user_data_root": "var/ and declared core/engine config paths",
        "pointer_switch": "atomic rename within one filesystem",
    }
    catalog_fields = [
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
    acceptance = [
        {
            "id": "unknown-signing-key",
            "operation": "catalog trust",
            "expected": "reject before display or download",
        },
        {
            "id": "checksum-mismatch",
            "operation": "archive verification",
            "expected": "reject before unpack and preserve active pointer",
        },
        {
            "id": "unsupported-api",
            "operation": "compatibility preflight",
            "expected": "reject panel_api/module_api/min_core mismatch",
        },
        {
            "id": "module-only-file-diff",
            "operation": "module-only update",
            "expected": "change selected versioned module, pointer and registry only",
        },
        {
            "id": "panel-update-preserves-state",
            "operation": "panel update",
            "expected": "preserve profile, modules.json, config and enabled state",
        },
        {
            "id": "profile-transition-separate-transaction",
            "operation": "profile transition",
            "expected": "use Stage 7 transaction path, never module-only path",
        },
        {
            "id": "offline-cached-catalog",
            "operation": "catalog fetch",
            "expected": "use last successful cache and expose stale/error state",
        },
        {
            "id": "archive-path-safety",
            "operation": "manifest validation",
            "expected": "reject traversal, absolute paths, symlink escape and hooks",
        },
        {
            "id": "stable-release-reproducibility",
            "operation": "release assets",
            "expected": "rebuild the same catalog/archive/checksum from CI inputs",
        },
    ]
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_from": "scripts/generate_modular_panel_stage8_contract.py",
        "stage": STAGE,
        "source_of_truth": {
            "stage0_inventory": "docs/modular-panel-stage0-inventory.json",
            "stage7_profiles": "docs/modular-panel-stage7-installer-profiles.md",
            "module_registry": MODULE_REGISTRY,
            "profile_installer": PROFILE_INSTALLER,
            "static_package_validator": STATIC_PACKAGE_VALIDATOR,
        },
        "modules": _module_payload(definitions),
        "profiles": _profile_payload(presets),
        "legacy_ownership": ownership,
        "topology": topology,
        "catalog": {
            "source": "https://github.com/umarcheh001/Xkeen-UI/releases/download/<version>/catalog.json",
            "signature": "catalog.json.sig",
            "channel_policy": {
                "required": "stable",
                "allowed": ["stable"],
                "branch_urls": False,
                "user_urls": False,
                "arbitrary_repositories": False,
            },
            "required_fields": catalog_fields,
            "archive_assets": [
                "xkeen-ui-panel-<version>.tar.gz",
                "xkeen-module-<module-id>-<version>.tar.gz",
            ],
        },
        "manifest": {
            "required_fields": [
                "schema_version",
                "id",
                "version",
                "panel_api",
                "module_api",
                "requires",
                "conflicts",
                "min_core",
                "architectures",
                "channel",
                "ownership",
                "max_size",
                "requires_restart",
            ],
            "forbidden_payloads": [
                "absolute paths",
                ".. path components",
                "symlinks escaping the module root",
                "install/uninstall shell hooks",
            ],
            "ownership_rule": "module archive may write only its declared module root and allow-listed paths",
        },
        "static_preflight": {
            "validator": STATIC_PACKAGE_VALIDATOR,
            "trusted_signing_key_ids": sorted(trusted_signing_key_ids),
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
        },
        "compatibility": {
            "panel_api": "1",
            "module_api": "1",
            "manifest_schema_version": 1,
            "catalog_schema_version": 1,
            "version_format": "semver",
            "architecture_source": "uname -m normalized to catalog architecture ids",
        },
        "operations": {
            "module_only": ["catalog", "plan", "stage", "verify", "pointer", "registry", "health", "commit_or_rollback"],
            "panel_update": ["backup", "stage_core", "health", "commit_or_full_rollback"],
            "profile_transition": ["stage7_profile_transaction", "diff", "backup", "restart", "health", "rollback"],
            "request_thread_policy": "never install inside the Flask request thread",
            "post_restart_owner": "external init/service supervisor",
        },
        "acceptance_matrix": acceptance,
        "deferred": [
            "arbitrary GitHub repositories",
            "user-provided archive URLs",
            "marketplace and third-party publishing",
            "delta or patch updates",
            "automatic dependency removal or update",
            "install/uninstall shell hooks",
            "OCI registry and extra channels",
        ],
    }


def render_markdown(payload: dict[str, Any]) -> str:
    stage = payload["stage"]
    ownership = payload["legacy_ownership"]
    catalog = payload["catalog"]
    manifest = payload["manifest"]
    lines = [
        "# Этап 8.0: контракты и границы",
        "",
        f"**Статус:** закрыт {stage['closed_on']}. Это статический baseline для менеджера официальных модулей; updater, trust-клиент и UI относятся к следующим подэтапам.",
        "",
        "## Источники истины",
        "",
        "- Stage 0 inventory фиксирует состав модулей и размеры.",
        "- Stage 7 installer profiles фиксирует legacy ownership и profile transaction.",
        "- `ModuleRegistry` фиксирует API version, зависимости, конфликты и profile presets.",
        "- `module_profile_install.py` остаётся консервативным классификатором legacy-файлов.",
        "",
        "## Модули и legacy-границы",
        "",
        "| ID | Dependencies | Restart | Removable |",
        "| --- | --- | --- | --- |",
    ]
    for item in payload["modules"]:
        lines.append(
            f"| `{item['id']}` | {', '.join(f'`{dep}`' for dep in item['dependencies']) or '-'} | "
            f"{'yes' if item['requires_restart'] else 'no'} | {'yes' if item['removable'] else 'no'} |"
        )
    lines.extend(
        [
            "",
            f"Legacy install root: `{ownership['install_root']}`. Managed payload roots: "
            + ", ".join(f"`{item}`" for item in ownership["managed_payload_roots"]) + ".",
            "State files, `secret.key`, runtime/config directories and Mihomo profiles/backups остаются пользовательскими данными.",
            "Неизвестные или неоднозначные файлы по умолчанию принадлежат `core` и перед удалением попадают в quarantine.",
            "",
            "## Топология будущих пакетов",
            "",
            "| Область | Контракт |",
            "| --- | --- |",
        ]
    )
    for key, value in payload["topology"].items():
        lines.append(f"| `{key}` | `{value}` |")
    lines.extend(
        [
            "",
            "Module-only update не меняет соседние модули, пользовательские конфигурации, ядра или профиль. Profile transition остаётся отдельной транзакцией Stage 7.",
            "",
            "## Catalog и manifest",
            "",
            f"Единственный обязательный канал — `{catalog['channel_policy']['required']}` из allow-listed GitHub Releases официального репозитория. Ветки, пользовательские URL и arbitrary repositories запрещены.",
            "",
            "Обязательные catalog keys: " + ", ".join(f"`{key}`" for key in catalog["required_fields"]) + ".",
            "",
            "Обязательные manifest keys: " + ", ".join(f"`{key}`" for key in manifest["required_fields"]) + ".",
            "Архив отклоняется до распаковки при неизвестном signing_key_id, SHA-256 mismatch, API mismatch, path traversal, абсолютном пути, symlink escape или наличии install/uninstall shell hooks.",
            "Статический preflight выполняет `services.module_package_contract`: source/catalog проверяются до скачивания, а `module-manifest.json` и точный allow-list `payload/` — до staging. Разрешены только directory и regular_file; symlink запрещён. Криптографическая Ed25519-проверка подписи остаётся границей подэтапа 8.2.",
            "",
            "## Compatibility и операции",
            "",
            "Совместимость проверяется по `panel_api`, `module_api`, `min_core`, архитектуре, dependencies, conflicts и semver до скачивания/распаковки.",
            "Установка не выполняется внутри Flask request thread; post-restart health и rollback принадлежат внешнему init/service supervisor.",
            "",
            "| Операция | Граница |",
            "| --- | --- |",
            "| module-only | versioned module payload, pointer, registry, optional restart |",
            "| panel update | core-owned payload, backup и полный rollback |",
            "| profile transition | Stage 7 transaction, diff, restart и rollback |",
            "",
            "## Acceptance matrix",
            "",
            "| ID | Operation | Expected result |",
            "| --- | --- | --- |",
        ]
    )
    for item in payload["acceptance_matrix"]:
        lines.append(f"| `{item['id']}` | {item['operation']} | {item['expected']} |")
    lines.extend(
        [
            "",
            "## Отложено",
            "",
            "Произвольные репозитории, marketplace, пользовательские archive URLs, delta updates, автоматическое удаление зависимостей, shell hooks и OCI registry не входят в MVP.",
            "",
            "Snapshot пересобирается командой `python .\\scripts\\generate_modular_panel_stage8_contract.py --root .`.",
            "",
        ]
    )
    return "\n".join(lines)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate Stage 8.0 contracts and boundaries.")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--json-out", type=Path, default=None)
    parser.add_argument("--markdown-out", type=Path, default=None)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = args.root.resolve()
    payload = build_contract(root)
    json_out = args.json_out or root / "docs/modular-panel-stage8-contract.json"
    markdown_out = args.markdown_out or root / "docs/modular-panel-stage8-contract.md"
    json_out.parent.mkdir(parents=True, exist_ok=True)
    markdown_out.parent.mkdir(parents=True, exist_ok=True)
    json_out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    markdown_out.write_text(render_markdown(payload), encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
