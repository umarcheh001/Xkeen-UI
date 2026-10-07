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

PANEL_PROFILE = {
    "stage": {
        "id": "8.5",
        "status": "closed",
        "closed_on": "2026-10-07",
    },
    "panel_descriptor_fields": [
        "archive",
        "size",
        "sha256",
        "version",
        "signing_key_id",
        "architectures",
    ],
    "operations": {
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
    },
    "profile_transition": {
        "pending_fields": ["transition_required", "transition_target"],
        "restart_guard": "profile_transition_required",
        "stale_plan_code": "operation_plan_stale",
        "module_id_forbidden": True,
    },
    "devtools": {
        "stable": "delegates panel-update plan/apply/status to ModuleLifecycleService",
        "main": "legacy branch update path marked development_only",
        "rollback": "legacy panel backup rollback; never a module transaction rollback",
    },
    "rollback_scopes": {
        "module": "selected module files and state",
        "panel": "all replaced managed panel files and state",
        "profile": "all added/removed managed profile files and state",
    },
    "stable_error_codes": [
        "panel_update_unavailable",
        "panel_version_current",
        "panel_archive_invalid",
        "profile_transition_required",
        "profile_transition_not_required",
        "profile_payload_unavailable",
        "profile_target_invalid",
        "operation_free_space",
    ],
}


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
        "payload_root": "/opt/etc/xkeen-ui (ownership paths from the module manifest)",
        "apply": "journaled per-file replace with backup",
        "registry": "module-installed.json + module-ownership.json",
        "transaction_root": "/opt/etc/xkeen-ui.module-transactions/<operation-id>/",
        "user_data_root": "var/ and declared core/engine config paths",
        "module_version": "equal to the installed panel release",
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
            "expected": "reject before unpack and leave the panel tree untouched",
        },
        {
            "id": "unsupported-api",
            "operation": "compatibility preflight",
            "expected": "reject panel_api/module_api/min_core mismatch",
        },
        {
            "id": "module-only-file-diff",
            "operation": "module-only update",
            "expected": "change only manifest files of the selected module and state files",
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
            "panel_profile_runbook": "docs/modular-panel-stage8-panel-profile.md",
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
        "release_assets": {
            "builder": "scripts/build_modular_panel_release.py",
            "panel_archive": "xkeen-ui-panel-<version>.tar.gz",
            "module_archive": "xkeen-module-<module-id>-<version>.tar.gz",
            "catalog": "catalog.json",
            "catalog_signature": "catalog.json.sig",
            "checksums": "<asset>.sha256",
            "metadata": "release-metadata.json",
            "channel": "stable",
            "signing_key_id": "release-2026",
        },
        "trust_client": {
            "algorithm": "Ed25519",
            "signature_asset": "catalog.json.sig",
            "discovery": "https://api.github.com/repos/umarcheh001/Xkeen-UI/releases/latest",
            "cache_ttl_seconds": 24 * 60 * 60,
            "allowed_redirect_hosts": [
                "github.com",
                "objects.githubusercontent.com",
                "release-assets.githubusercontent.com",
            ],
            "stale_fallback": "transport failures only",
            "anti_rollback": "highest verified release version",
        },
        "determinism": {
            "tar_format": "ustar",
            "member_order": "POSIX path ascending",
            "uid_gid": 0,
            "owner_names": "empty",
            "mtime": "SOURCE_DATE_EPOCH",
            "gzip_filename": "empty",
            "gzip_mtime": "SOURCE_DATE_EPOCH",
            "module_layout": ["module-manifest.json", "payload/<ownership-path>"],
        },
        "ci_publication": {
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
        },
        "compatibility": {
            "panel_api": "1",
            "module_api": "1",
            "manifest_schema_version": 1,
            "catalog_schema_version": 1,
            "version_format": "semver",
            "architectures": ["aarch64", "mips", "mipsel"],
            "architecture_source": "services.module_package_contract.detect_platform_architecture: uname -m normalized to catalog architecture ids; MIPS byte order decides between mips and mipsel",
        },
        "operations": {
            "module_only": ["catalog", "plan", "stage", "verify", "apply", "state", "restart", "health", "commit_or_rollback"],
            "panel_update": ["backup", "stage_core", "health", "commit_or_full_rollback"],
            "profile_transition": ["stage7_profile_transaction", "diff", "backup", "restart", "health", "rollback"],
            "request_thread_policy": "never install inside the Flask request thread",
            "post_restart_owner": "detached module runner; the init script undoes an interrupted operation",
        },
        "lifecycle_api": {
            "stage": {
                "id": "8.4",
                "status": "closed",
                "closed_on": "2026-10-06",
            },
            "service": "xkeen-ui/services/module_lifecycle.py",
            "routes": [
                {"method": "GET", "path": "/api/modules/installed", "success_status": 200},
                {"method": "GET", "path": "/api/modules/available", "success_status": 200},
                {"method": "POST", "path": "/api/modules/operations/plan", "success_status": 200},
                {"method": "POST", "path": "/api/modules/operations/apply", "success_status": 202},
                {"method": "GET", "path": "/api/modules/operations/status", "success_status": 200},
                {"method": "POST", "path": "/api/modules/operations/<operation_id>/cancel", "success_status": 202},
                {"method": "POST", "path": "/api/modules/recovery", "success_status": 200},
                {"method": "POST", "path": "/api/modules/restart", "success_status": 200},
            ],
            "operations": ["install", "repair", "remove", "panel-update", "profile-transition"],
            "execution": "detached module transaction runner",
            "plan_guard": "lowercase SHA-256 of canonical server plan and dependency diff",
            "update_available": False,
            "recovery_restarts_implicitly": False,
        },
        "panel_profile": PANEL_PROFILE,
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
    release_assets = payload["release_assets"]
    trust_client = payload["trust_client"]
    ci_publication = payload["ci_publication"]
    lifecycle_api = payload["lifecycle_api"]
    panel_profile = payload["panel_profile"]
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
            "## Топология пакетов",
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
            "Файлы модуля лежат в общем корне панели по путям из manifest: панель загружает код, статику и шаблоны только оттуда. Замена ведётся под журналом — прежний файл сохраняется в каталоге операции, и по журналу дерево возвращается в исходное состояние после любой ошибки или обрыва питания (Stage 8.3).",
            "Какие файлы принадлежат модулю, панель знает из `module-ownership.json`: его пишет сборщик релиза, он лежит в panel archive и описывает то же дерево, из которого собраны module archives.",
            "Модуль ставится только из релиза, версия которого равна версии установленной панели; переход на новую версию происходит вместе с панелью.",
            "Module-only операция не меняет соседние модули, пользовательские конфигурации, ядра; профиль после неё становится `custom`. Profile transition остаётся отдельной транзакцией Stage 7.",
            "",
            "## Catalog и manifest",
            "",
            f"Единственный обязательный канал — `{catalog['channel_policy']['required']}` из allow-listed GitHub Releases официального репозитория. Ветки, пользовательские URL и arbitrary repositories запрещены.",
            "",
            "Обязательные catalog keys: " + ", ".join(f"`{key}`" for key in catalog["required_fields"]) + ".",
            "",
            "Обязательные manifest keys: " + ", ".join(f"`{key}`" for key in manifest["required_fields"]) + ".",
            "Архив отклоняется до распаковки при неизвестном signing_key_id, SHA-256 mismatch, API mismatch, path traversal, абсолютном пути, symlink escape или наличии install/uninstall shell hooks.",
            "Статический preflight выполняет `services.module_package_contract`: source/catalog проверяются до скачивания, а `module-manifest.json` и точный allow-list `payload/` — до staging. Разрешены только directory и regular_file; symlink запрещён.",
            "",
            "## Release assets 8.1",
            "",
            f"Сборщик `{release_assets['builder']}` выпускает `{release_assets['panel_archive']}`, `{release_assets['module_archive']}`, `{release_assets['catalog']}`, checksum sidecars `{release_assets['checksums']}` и `{release_assets['metadata']}`.",
            "Module archive содержит только `module-manifest.json` и `payload/<ownership-path>`; bootstrap hooks остаются в panel asset и не попадают в module payload.",
            "Ownership сначала определяется Stage 7 по имени файла, затем замыкается по графу импортов: файл, который скрипт страницы импортирует статически или Python-файл импортирует на уровне модуля без условия, переносится в самый глубокий пакет, от которого зависят обе стороны (в худшем случае `core`). Dynamic `import()` и импорт под `if`/`try` или внутри функции зависимостью не считаются — так подключаются необязательные модули. Поэтому каждый пакет вместе со своими зависимостями из registry загружается без остальных пакетов.",
            "Воспроизводимость фиксирует USTAR, POSIX-сортировку путей, uid/gid=0, пустые owner names и `SOURCE_DATE_EPOCH` для tar/gzip.",
            f"CI собирает и статически проверяет `dist/modular-panel/**` на каждом push. На tag build `{ci_publication['catalog_signing']['script']}` добавляет `{release_assets['catalog_signature']}` в `release-metadata.json`; публикация в GitHub Release разрешена только при `{ci_publication['tag_condition']}`. Legacy bootstrap archive `xkeen-ui-routing.tar.gz` сохраняется без изменения имени.",
            "Версия релиза берётся из тега и обязана быть semver, поэтому теги выпускаются как `vX.Y.Z`, без буквенного суффикса (решение 5 октября 2026 года): на теге вида `v2.9.2a` сборщик останавливается с понятной ошибкой, и релиз не публикуется.",
            "",
            "## Trust и клиент каталога 8.2",
            "",
            f"Core принимает только raw bytes `{release_assets['catalog']}`, проверенные `{trust_client['algorithm']}` envelope `{trust_client['signature_asset']}` с already-embedded key ID `{release_assets['signing_key_id']}`. Private key доступен только tag CI через environment `{ci_publication['catalog_signing']['private_key_environment']}` и не входит в assets.",
            f"Discovery ограничен `{trust_client['discovery']}`; принимается только published stable `v<semver>` release. Client сам строит immutable GitHub Releases URLs, принимает HTTPS redirects только на {', '.join(f'`{host}`' for host in trust_client['allowed_redirect_hosts'])} и отвергает user URLs/branch selectors.",
            f"Последний проверенный catalog cache хранится atomically с правами `0600`: до `{trust_client['cache_ttl_seconds']}` секунд он fresh, а stale fallback разрешён только при {trust_client['stale_fallback']}. `{trust_client['anti_rollback']}` запрещает downgrade. Archive bytes streamed во temporary file и сверяются по exact size/SHA-256 перед передачей будущему updater; unpack и transaction остаются 8.3.",
            "",
            "## Compatibility и операции",
            "",
            "Совместимость проверяется по `panel_api`, `module_api`, `min_core`, архитектуре, dependencies, conflicts и semver до скачивания/распаковки.",
            "Установка не выполняется внутри Flask request thread: её ведёт отдельный процесс `scripts/module_transaction.py`, он же проверяет запуск панели и откатывает. Прерванную операцию отменяет init-скрипт перед стартом панели.",
            "",
            "| Операция | Граница |",
            "| --- | --- |",
            "| module-only | файлы модуля из manifest, state-файлы, restart, health, commit или rollback |",
            "| panel update | core-owned payload, backup и полный rollback |",
            "| profile transition | Stage 7 transaction, diff, restart и rollback |",
            "",
            "## Lifecycle API 8.4",
            "",
            f"Подэтап {lifecycle_api['stage']['id']} закрыт {lifecycle_api['stage']['closed_on']}. `{lifecycle_api['service']}` повторно строит authoritative plan и передаёт его в {lifecycle_api['execution']}; Flask request не меняет файлы панели.",
            f"Допустимы только `{ '`, `'.join(lifecycle_api['operations']) }`. Plan guard — {lifecycle_api['plan_guard']}. Независимые версии модулей не входят в текущую модель релиза, поэтому module-only `update_available` всегда `false`.",
            "",
            "| Method | Path | Success |",
            "| --- | --- | --- |",
            *[
                f"| `{item['method']}` | `{item['path']}` | `{item['success_status']}` |"
                for item in lifecycle_api["routes"]
            ],
            "",
            "Cancel передаёт просьбу слушателю самого live runner на `127.0.0.1` после проверки journal и status; runner сам посылает себе SIGTERM, сигнал по PID не отправляется. Recovery не перезапускает панель автоматически; restart имеет отдельный guard от активной операции, update lock и rollback-failed state.",
            "",
            "## Panel update и profile transition 8.5",
            "",
            f"Подэтап {panel_profile['stage']['id']} закрыт {panel_profile['stage']['closed_on']}. Signed catalog теперь содержит обязательный panel descriptor: "
            + ", ".join(f"`{field}`" for field in panel_profile["panel_descriptor_fields"]) + ".",
            "`panel-update` использует scope `panel`, принимает только строго более новую stable-версию и заменяет весь managed target текущего профиля. `profile-transition` использует scope `profile`, остаётся на установленной версии и материализует профиль, сохранённый через `POST /api/modules/profile`.",
            "Обе full-scope операции передают в plan/apply только `operation` и server-generated `plan_id`; `module_id` запрещён. Любое изменение release/profile между review и apply возвращает `operation_plan_stale`.",
            f"Profile response публикует `{panel_profile['profile_transition']['pending_fields'][0]}` и `{panel_profile['profile_transition']['pending_fields'][1]}`. Пока физический профиль не совпадает с желаемым, отдельный restart возвращает `{panel_profile['profile_transition']['restart_guard']}`.",
            "Panel/profile journal сохраняет каждый заменённый или удалённый managed-файл и state; ошибка после apply вызывает полный rollback своего scope. `rollback_failed` блокирует новые операции до ручного восстановления backup. Module rollback, full-scope transaction rollback и legacy DevTools backup rollback не смешиваются.",
            "Stable DevTools check/run/status делегируются `ModuleLifecycleService`; branch channel `main` сохраняет legacy development-only path. Подробные payload, error codes, cancel/recovery semantics и manual runbook: `docs/modular-panel-stage8-panel-profile.md`.",
            "Stable full-scope codes: " + ", ".join(f"`{code}`" for code in panel_profile["stable_error_codes"]) + ".",
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
