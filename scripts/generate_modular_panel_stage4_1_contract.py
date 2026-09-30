from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any

from panel_template_source import compose_panel_template


SCHEMA_VERSION = 1
STAGE = {
    "id": "4.1",
    "name": "Контракт границ shell, экранов и модальных окон",
    "status": "closed",
    "closed_on": "2026-09-29",
}

PANEL_TEMPLATE = "xkeen-ui/templates/panel.html"
INVENTORY_PATH = "docs/modular-panel-stage0-inventory.json"

MODULE_IDS = (
    "core",
    "engine.xray",
    "engine.mihomo",
    "tool.editor",
    "tool.terminal",
    "tool.files",
    "tool.backups",
    "integration.happ",
    "tool.advanced-diagnostics",
)

VIEW_SPECS: tuple[dict[str, Any], ...] = (
    {
        "id": "routing",
        "module_id": "engine.xray",
        "target_partial": "xkeen-ui/templates/panel/screens/routing.html",
        "root_id": "view-routing",
        "frontend_roots": ["panel-routing"],
        "api_groups": ["/api/routing/*", "/api/xray/*", "/api/dns/*"],
        "dependencies": ["core", "tool.editor"],
    },
    {
        "id": "mihomo",
        "module_id": "engine.mihomo",
        "target_partial": "xkeen-ui/templates/panel/screens/mihomo.html",
        "root_id": "view-mihomo",
        "frontend_roots": ["panel-mihomo"],
        "api_groups": ["/api/mihomo/*", "/api/mihomo/clash/*"],
        "dependencies": ["core", "tool.editor"],
    },
    {
        "id": "xkeen",
        "module_id": "core",
        "target_partial": "xkeen-ui/templates/panel/screens/xkeen.html",
        "root_id": "view-xkeen",
        "frontend_roots": ["panel-core"],
        "api_groups": ["/api/service/*", "/api/cores/*", "/api/settings/*"],
        "dependencies": ["core"],
    },
    {
        "id": "xray-logs",
        "module_id": "engine.xray",
        "target_partial": "xkeen-ui/templates/panel/screens/xray_logs.html",
        "root_id": "view-xray-logs",
        "frontend_roots": ["panel-core", "panel-routing"],
        "api_groups": ["/api/xray/logs", "/api/xray/*"],
        "dependencies": ["core"],
    },
    {
        "id": "commands",
        "module_id": "tool.terminal",
        "target_partial": "xkeen-ui/templates/panel/screens/commands.html",
        "root_id": "view-commands",
        "frontend_roots": ["panel-core", "terminal-lazy"],
        "api_groups": ["/api/run-command", "/api/command-jobs/*", "/ws/*"],
        "dependencies": ["core"],
    },
    {
        "id": "files",
        "module_id": "tool.files",
        "target_partial": "xkeen-ui/templates/panel/screens/files.html",
        "root_id": "view-files",
        "frontend_roots": ["panel-core", "file-manager-lazy"],
        "api_groups": ["/api/fs/*", "/api/fileops/*", "/api/remotefs/*"],
        "dependencies": ["core"],
    },
)

SHELL_BOUNDARIES: tuple[dict[str, Any], ...] = (
    {
        "id": "head",
        "module_id": "core",
        "target_partial": "xkeen-ui/templates/panel/head.html",
        "anchor_regex": r"^<head>$",
        "dom_anchors": [
            "xk-terminal-theme-link",
            "xk-panel-operator-paint-guard",
        ],
        "template_context": [
            "csrf_token",
            "panel_sections_whitelist",
            "devtools_sections_whitelist",
            "has_xray",
            "has_mihomo",
            "available_cores",
            "detected_cores",
            "core_ui_fallback",
            "routing_file",
            "inbounds_file",
            "outbounds_file",
            "mihomo_config_file",
            "fm_right_default",
            "github_repo_url",
            "xkeen_runtime_debug",
            "terminal_supports_pty",
            "xkeen_terminal_enable_optional_addons",
            "terminal_theme_v",
        ],
        "asset_contract": [
            "styles.css",
            "panel-operator.css",
            "xterm/xterm.css",
            "js/ui/sections.js",
        ],
        "api_groups": [],
    },
    {
        "id": "page_config",
        "module_id": "core",
        "target_partial": "xkeen-ui/templates/panel/page_config.html",
        "anchor_regex": r"\{% set panel_page_config = frontend_page_config\(",
        "dom_anchors": ["window.XKeen.pageConfig", "var pageConfig"],
        "template_context": [
            "panel_sections_whitelist",
            "devtools_sections_whitelist",
            "has_xray",
            "has_mihomo",
            "is_mips",
            "multi_core",
            "mihomo_config_exists",
            "available_cores",
            "detected_cores",
            "core_ui_fallback",
            "routing_file",
            "inbounds_file",
            "outbounds_file",
            "mihomo_config_file",
            "fm_right_default",
            "github_repo_url",
            "xkeen_runtime_debug",
            "terminal_supports_pty",
            "xkeen_terminal_enable_optional_addons",
        ],
        "asset_contract": ["canonical window.XKeen.pageConfig"],
        "api_groups": [],
    },
    {
        "id": "startup",
        "module_id": "core",
        "target_partial": "xkeen-ui/templates/panel/shell.html",
        "anchor_regex": r'<body class="panel-page',
        "dom_anchors": [
            "global-xkeen-spinner",
            "xk-panel-operator-paint-guard",
            "xk-panel-operator-pending",
        ],
        "template_context": [
            "is_mips",
            "top_level_spinner_text",
            "top_level_spinner_class",
            "top_level_spinner_initial_active",
        ],
        "asset_contract": ["startup fail-open timer", "global spinner"],
        "api_groups": [],
    },
    {
        "id": "header",
        "module_id": "core",
        "target_partial": "xkeen-ui/templates/panel/header.html",
        "anchor_regex": r'<header class="panel-header panel-header-shell"',
        "dom_anchors": [
            "xk-brand-logo",
            "xkeen-service-lamp",
            "xkeen-service-text",
            "xkeen-core-text",
            "xray-logs-badge",
            "xk-resource-monitor",
            "theme-toggle-btn",
            "ui-settings-open-btn",
            "xk-update-link",
            "panel-core-ui-refresh-btn",
            "logout",
        ],
        "template_context": [
            "multi_core",
            "has_xray",
            "available_cores",
            "detected_cores",
            "core_ui_fallback",
            "has_diagnostics",
        ],
        "asset_contract": ["operator icon macro", "logout partial"],
        "api_groups": ["/api/service/*", "/api/cores/*", "/api/capabilities"],
    },
    {
        "id": "navigation",
        "module_id": "core",
        "target_partial": "xkeen-ui/templates/panel/navigation.html",
        "anchor_regex": r'<div class="top-tabs header-tabs"',
        "dom_anchors": [
            "data-view=routing",
            "data-view=mihomo",
            "data-view=xkeen",
            "data-view=xray-logs",
            "data-view=commands",
            "data-view=files",
            "top-tab-mihomo-generator",
            "top-tab-donate",
            "devtools_page link",
        ],
        "template_context": [
            "has_xray",
            "has_mihomo",
            "panel_sections_whitelist",
        ],
        "asset_contract": ["top-level navigation contract"],
        "api_groups": ["/api/capabilities"],
        "module_owned_slots": [
            {"id": "routing", "module_id": "engine.xray", "gate": "has_xray"},
            {"id": "mihomo", "module_id": "engine.mihomo", "gate": "has_mihomo"},
            {"id": "xray-logs", "module_id": "engine.xray", "gate": "has_xray"},
            {"id": "commands", "module_id": "tool.terminal", "gate": "has_terminal"},
            {"id": "files", "module_id": "tool.files", "gate": "has_files"},
            {
                "id": "mihomo-generator",
                "module_id": "engine.mihomo",
                "gate": "has_mihomo",
            },
            {
                "id": "devtools",
                "module_id": "tool.advanced-diagnostics",
                "gate": "has_diagnostics",
            },
            {"id": "donate", "module_id": "core", "gate": "always"},
        ],
    },
    {
        "id": "global_controls",
        "module_id": "core",
        "target_partial": "xkeen-ui/templates/panel/shell.html",
        "anchor_regex": r'<div class="xkeen-ctrl-row">',
        "dom_anchors": [
            "xkeen-start-btn",
            "xkeen-stop-btn",
            "xkeen-restart-btn",
            "global-autorestart-xkeen",
            "routing-focus-switch",
        ],
        "template_context": ["has_xray"],
        "asset_contract": ["service controls", "routing focus slot"],
        "api_groups": ["/api/service/*", "/api/settings/*"],
    },
)

SHARED_MODAL_IDS = {
    "core-modal",
    "confirm-modal",
    "github-export-modal",
    "github-catalog-modal",
    "donate-modal",
    "ui-settings-modal",
}

MODAL_TARGET_OVERRIDES = {
    "fm-upload-conflict-modal": "tool.files",
    "ssh-modal": "tool.terminal",
    "ssh-edit-modal": "tool.terminal",
    "ssh-confirm-modal": "tool.terminal",
    "ssh-transfer-modal": "tool.terminal",
    "fm-connect-modal": "tool.files",
    "fm-knownhosts-modal": "tool.files",
    "fm-create-modal": "tool.files",
    "fm-rename-modal": "tool.files",
    "fm-archive-modal": "tool.files",
    "fm-extract-modal": "tool.files",
    "fm-folder-picker-modal": "tool.files",
    "fm-archive-list-modal": "tool.files",
    "fm-mask-modal": "tool.files",
    "fm-props-modal": "tool.files",
    "fm-hash-modal": "tool.files",
    "fm-chmod-modal": "tool.files",
    "fm-chown-modal": "tool.files",
    "fm-dropop-modal": "tool.files",
    "fm-conflicts-modal": "tool.files",
    "fm-bookmarks-modal": "tool.files",
    "fm-download-multi-modal": "tool.files",
    "fm-progress-modal": "tool.files",
    "fm-ops-modal": "tool.files",
    "fm-volumes-modal": "tool.files",
    "fm-help-modal": "tool.files",
}

MODAL_PARTIALS = {
    "core": "xkeen-ui/templates/panel/modals/shared.html",
    "engine.xray": "xkeen-ui/templates/panel/modals/routing.html",
    "engine.mihomo": "xkeen-ui/templates/panel/modals/mihomo.html",
    "tool.editor": "xkeen-ui/templates/panel/modals/editor.html",
    "tool.terminal": "xkeen-ui/templates/panel/modals/commands.html",
    "tool.files": "xkeen-ui/templates/panel/modals/files.html",
    "integration.happ": "xkeen-ui/templates/panel/modals/happ.html",
    "tool.advanced-diagnostics": "xkeen-ui/templates/panel/modals/diagnostics.html",
}

MODAL_DEPENDENCIES = {
    "core": ["core"],
    "engine.xray": ["core", "engine.xray"],
    "engine.mihomo": ["core", "engine.mihomo"],
    "tool.editor": ["core", "tool.editor"],
    "tool.terminal": ["core", "tool.terminal"],
    "tool.files": ["core", "tool.files"],
    "integration.happ": ["core", "engine.mihomo", "integration.happ"],
    "tool.advanced-diagnostics": ["core", "tool.advanced-diagnostics"],
}

PROFILE_SPECS: tuple[dict[str, Any], ...] = (
    {
        "id": "legacy-full",
        "kind": "legacy",
        "active_module_ids": list(MODULE_IDS),
        "description": "Старые установки сохраняют полный набор поставляемых модулей.",
    },
    {
        "id": "full",
        "kind": "custom",
        "active_module_ids": list(MODULE_IDS),
        "description": "Полный профиль с тем же составом UI, что и Legacy.",
    },
    {
        "id": "xray-minimal",
        "kind": "custom",
        "active_module_ids": ["core", "tool.editor", "engine.xray"],
        "description": "Минимальный Xray-профиль без Mihomo, terminal и file manager.",
    },
    {
        "id": "mihomo-minimal",
        "kind": "custom",
        "active_module_ids": ["core", "tool.editor", "engine.mihomo"],
        "description": "Минимальный Mihomo-профиль без Xray, terminal и file manager.",
    },
)


def _find_line(lines: list[str], pattern: str) -> int:
    compiled = re.compile(pattern)
    for index, line in enumerate(lines, start=1):
        if compiled.search(line):
            return index
    raise ValueError(f"Required panel marker not found: {pattern}")


def _find_modal_lines(text: str, modal_ids: set[str]) -> dict[str, int]:
    result: dict[str, int] = {}
    for modal_id in modal_ids:
        match = re.search(rf'\bid=["\']{re.escape(modal_id)}["\']', text)
        if not match:
            continue
        result[modal_id] = text.count("\n", 0, match.start()) + 1
    return result


def _find_all_ids(text: str) -> Counter[str]:
    return Counter(re.findall(r'\bid=["\']([^"\']+)["\']', text))


def _load_inventory(root: Path) -> dict[str, Any]:
    return json.loads((root / INVENTORY_PATH).read_text(encoding="utf-8"))


def _build_modal_contract(
    text: str,
    inventory: dict[str, Any],
) -> list[dict[str, Any]]:
    inventory_modals = {
        item["id"]: item for item in inventory["ui_surfaces"]["panel_modals"]
    }
    modal_lines = _find_modal_lines(text, set(inventory_modals))
    if set(modal_lines) != set(inventory_modals):
        missing = sorted(set(inventory_modals) - set(modal_lines))
        extra = sorted(set(modal_lines) - set(inventory_modals))
        raise ValueError(f"Modal inventory drift: missing={missing}, extra={extra}")

    result = []
    for modal_id in inventory_modals:
        current_module_id = inventory_modals[modal_id]["module_id"]
        target_module_id = MODAL_TARGET_OVERRIDES.get(modal_id, current_module_id)
        boundary = "shared" if modal_id in SHARED_MODAL_IDS else "owned"
        if current_module_id != target_module_id:
            boundary = "mixed-current-classification"
        result.append(
            {
                "id": modal_id,
                "line": modal_lines[modal_id],
                "current_inventory_module_id": current_module_id,
                "target_module_id": target_module_id,
                "target_partial": MODAL_PARTIALS[target_module_id],
                "boundary": boundary,
                "dependencies": MODAL_DEPENDENCIES[target_module_id],
                "dom_contract": [
                    f"#{modal_id}",
                    "id attributes of all descendants remain stable",
                    "aria-* and data-modal-* attributes remain stable",
                ],
            }
        )
    return result


def _build_view_contract(lines: list[str]) -> list[dict[str, Any]]:
    result = []
    for spec in VIEW_SPECS:
        item = dict(spec)
        item["line"] = _find_line(lines, rf'id="{re.escape(spec["root_id"])}"')
        item["dom_contract"] = [
            f'#{spec["root_id"]}',
            f'data-xk-section="{spec["id"]}"',
            "all descendant DOM ids remain stable",
        ]
        result.append(item)
    return result


def build_contract(root: Path) -> dict[str, Any]:
    template_path = root / PANEL_TEMPLATE
    raw_template_text = template_path.read_text(encoding="utf-8")
    template_text = compose_panel_template(root)
    lines = template_text.splitlines()
    inventory = _load_inventory(root)
    ids = _find_all_ids(template_text)
    duplicate_ids = sorted(identifier for identifier, count in ids.items() if count > 1)

    shell = []
    for spec in SHELL_BOUNDARIES:
        item = dict(spec)
        item["line"] = _find_line(lines, spec["anchor_regex"])
        item.pop("anchor_regex", None)
        shell.append(item)

    views = _build_view_contract(lines)
    modals = _build_modal_contract(template_text, inventory)
    panel_views = []
    for profile in PROFILE_SPECS:
        active = set(profile["active_module_ids"])
        expected_views = [
            item["id"] for item in views if item["module_id"] in active
        ]
        expected_nav_sections = list(expected_views)
        if "engine.mihomo" in active:
            expected_nav_sections.append("mihomo-generator")
        if "tool.advanced-diagnostics" in active:
            expected_nav_sections.append("devtools")
        expected_nav_sections.append("donate")
        forbidden_views = [
            item["id"] for item in views if item["module_id"] not in active
        ]
        expected_modal_ids = [
            item["id"] for item in modals if item["target_module_id"] in active
        ]
        forbidden_modal_ids = [
            item["id"] for item in modals if item["target_module_id"] not in active
        ]
        panel_views.append(
            {
                **profile,
                "expected_views": expected_views,
                "forbidden_views": forbidden_views,
                "expected_navigation_sections": expected_nav_sections,
                "expected_modal_ids": expected_modal_ids,
                "forbidden_modal_ids": forbidden_modal_ids,
            }
        )

    source_sha256 = hashlib.sha256(template_text.encode("utf-8")).hexdigest()
    return {
        "schema_version": SCHEMA_VERSION,
        "stage": STAGE,
        "source": {
            "template": PANEL_TEMPLATE,
            "composition_source": "scripts/panel_template_source.py",
            "inventory": INVENTORY_PATH,
            "sha256": source_sha256,
            "utf8_bytes": len(template_text.encode("utf-8")),
            "line_count": len(lines),
            "id_count": len(ids),
            "duplicate_ids": duplicate_ids,
            "entrypoint_sha256": hashlib.sha256(raw_template_text.encode("utf-8")).hexdigest(),
        },
        "composition": {
            "current_entrypoint": PANEL_TEMPLATE,
            "target_composition_root": PANEL_TEMPLATE,
            "target_directory": "xkeen-ui/templates/panel/",
            "render_order": [
                "head",
                "startup",
                "header",
                "navigation",
                "global_controls",
                "screens",
                "modals",
            ],
            "stable_rules": [
                "`panel.html` остаётся совместимой точкой входа и composition root",
                "DOM id, data-view, data-xk-section, data-xk-shell и modal data-* считаются замороженным контрактом",
                "screen и modal partials получают только используемые значения page_context",
                "разметка отключённого модуля отсутствует в серверном initial HTML",
                "загрузка frontend-бандлов и import() остаются задачей Этапа 5",
            ],
        },
        "shell": shell,
        "screens": views,
        "modals": modals,
        "mixed_boundaries": [
            {
                "id": "navigation",
                "current_location": PANEL_TEMPLATE,
                "decision": "Core owns the navigation shell; individual buttons and sections are gated by their module owner.",
                "owners": ["core", "engine.xray", "engine.mihomo", "tool.terminal", "tool.files"],
            },
            {
                "id": "global-controls",
                "current_location": PANEL_TEMPLATE,
                "decision": "Keep service controls in core shell; keep routing-focus markup as an engine.xray-owned slot.",
                "owners": ["core", "engine.xray"],
            },
            {
                "id": "routing-editor",
                "current_location": "#view-routing",
                "decision": "The screen belongs to engine.xray; editor widgets and schemas are delegated to tool.editor.",
                "owners": ["engine.xray", "tool.editor"],
            },
            {
                "id": "mihomo-editor",
                "current_location": "#view-mihomo and Mihomo modals",
                "decision": "The screen belongs to engine.mihomo; editor widgets and schemas are delegated to tool.editor.",
                "owners": ["engine.mihomo", "tool.editor"],
            },
            {
                "id": "mihomo-hwid",
                "current_location": "#mihomo-hwid-modal",
                "decision": "Happ-specific markup is integration.happ-owned and requires engine.mihomo at runtime.",
                "owners": ["engine.mihomo", "integration.happ"],
            },
            {
                "id": "file-editor",
                "current_location": "#fm-editor-modal",
                "decision": "File manager owns the workflow; editor markup is a separate tool.editor modal partial.",
                "owners": ["tool.files", "tool.editor"],
            },
            {
                "id": "ssh-file-manager",
                "current_location": "SSH and file-manager modals",
                "decision": "SSH belongs to tool.terminal; file operations belong to tool.files, despite the current inventory fallback to core.",
                "owners": ["tool.terminal", "tool.files"],
            },
        ],
        "profiles": panel_views,
        "decisions": [
            "Текущий монолит является baseline; этот подэтап пока не переносит блоки шаблона.",
            "Stage 0 inventory остаётся источником обнаружения текущих UI-поверхностей.",
            "Целевой владелец указан явно там, где inventory исторически классифицировал modal как core.",
            "Shared modal ограничен общими shell/core-сценариями; module-specific modal нельзя прятать в shared.html.",
        ],
    }


def _markdown_table(rows: list[list[str]], headers: list[str]) -> list[str]:
    lines = [
        "| " + " | ".join(headers) + " |",
        "| " + " | ".join("---" for _ in headers) + " |",
    ]
    lines.extend("| " + " | ".join(row) + " |" for row in rows)
    return lines


def render_markdown(payload: dict[str, Any]) -> str:
    source = payload["source"]
    lines = [
        "# Этап 4.1. Контракт границ shell, экранов и модальных окон",
        "",
        "Статус: **закрыт 29 сентября 2026 года**.",
        "",
        "Документ фиксирует границы до начала физического переноса разметки. "
        "На этом этапе `panel.html` остаётся монолитным baseline; следующие "
        "подэтапы будут переносить его блоки в partials без изменения DOM/API-контрактов.",
        "",
        "## Артефакты и baseline",
        "",
        f"- исходный шаблон: `{source['template']}`;",
        f"- Stage 0 inventory: `{source['inventory']}`;",
        "- machine-readable contract: `docs/modular-panel-stage4.1-contract.json`;",
        "- пересборка: `python .\\scripts\\generate_modular_panel_stage4_1_contract.py --root .`;",
        f"- UTF-8 размер: `{source['utf8_bytes']}` байт;",
        f"- строк: `{source['line_count']}`;",
        f"- статических `id`: `{source['id_count']}`, дубликатов: `{len(source['duplicate_ids'])}`;",
        f"- SHA-256 текущего baseline: `{source['sha256']}`.",
        "",
        "## Правила composition",
        "",
    ]
    lines.extend(f"- {rule}." for rule in payload["composition"]["stable_rules"])
    lines.extend(
        [
            "",
            "Порядок рендера:",
            "",
            "```text",
            "head → startup → header → navigation → global_controls → screens → modals",
            "```",
            "",
            "## Shell boundaries",
            "",
        ]
    )
    shell_rows = [
        [
            item["id"],
            item["module_id"],
            item["target_partial"],
            str(item["line"]),
            ", ".join(f"`{anchor}`" for anchor in item["dom_anchors"][:5]),
        ]
        for item in payload["shell"]
    ]
    lines.extend(
        _markdown_table(
            shell_rows,
            ["Область", "Владелец", "Целевой partial", "Якорь, строка", "DOM-контракт"],
        )
    )
    lines.extend(["", "## Screen boundaries", ""])
    view_rows = [
        [
            item["id"],
            item["module_id"],
            item["target_partial"],
            f"`#{item['root_id']}` / {item['line']}",
            ", ".join(item["frontend_roots"]),
            ", ".join(item["api_groups"]),
        ]
        for item in payload["screens"]
    ]
    lines.extend(
        _markdown_table(
            view_rows,
            ["Screen", "Владелец", "Целевой partial", "Корень", "Frontend roots", "API groups"],
        )
    )
    lines.extend(
        [
            "",
            "Все дочерние `id`, `data-*`, `aria-*` и trigger selectors screen должны "
            "сохраниться при переносе. `mihomo_generator.html` не входит в эту таблицу: "
            "это отдельная canonical page с собственным entrypoint.",
            "",
            "## Modal boundaries",
            "",
            "В таблице отдельно показаны текущая классификация inventory и целевой "
            "владелец. Это позволяет безопасно исправить историческую классификацию "
            "file-manager/SSH modal, не теряя baseline Stage 0.",
            "",
        ]
    )
    modal_rows = [
        [
            item["id"],
            item["current_inventory_module_id"],
            item["target_module_id"],
            item["boundary"],
            item["target_partial"],
            str(item["line"]),
        ]
        for item in payload["modals"]
    ]
    lines.extend(
        _markdown_table(
            modal_rows,
            ["Modal id", "Inventory", "Целевой владелец", "Boundary", "Целевой partial", "Строка"],
        )
    )
    lines.extend(["", "## Mixed boundaries и решения", ""])
    for item in payload["mixed_boundaries"]:
        lines.extend(
            [
                f"### `{item['id']}`",
                "",
                f"- текущая область: `{item['current_location']}`;",
                f"- владельцы: {', '.join(f'`{owner}`' for owner in item['owners'])};",
                f"- решение: {item['decision']}",
                "",
            ]
        )
    lines.extend(["## Profile baseline", ""])
    profile_rows = [
        [
            item["id"],
            ", ".join(item["active_module_ids"]),
            ", ".join(item["expected_views"]),
            ", ".join(item["forbidden_views"]) or "—",
            str(len(item["expected_modal_ids"])),
            str(len(item["forbidden_modal_ids"])),
        ]
        for item in payload["profiles"]
    ]
    lines.extend(
        _markdown_table(
            profile_rows,
            [
                "Профиль",
                "Active modules",
                "Ожидаемые screens",
                "Запрещённые screens",
                "Разрешено modal",
                "Запрещено modal",
            ],
        )
    )
    lines.extend(
        [
            "",
            "## Критерий завершения Этапа 4.1",
            "",
            "Критерий готовности **выполнен**:",
            "",
            "- для каждого screen определены `module_id`, partial, root id, frontend roots и API groups;",
            "- для каждого modal определены текущая классификация, целевой владелец, partial и DOM-контракт;",
            "- shell, navigation и mixed-boundaries имеют явные решения;",
            "- зафиксированы профили `legacy-full`, `full`, `xray-minimal` и `mihomo-minimal`;",
            "- baseline защищён генератором и тестом синхронности.",
            "",
            "Физическое создание partials и перенос markup относятся к подэтапу 4.2 и последующим.",
            "",
        ]
    )
    return "\n".join(lines)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate the Stage 4.1 frontend boundary contract."
    )
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--json-out", type=Path, default=None)
    parser.add_argument("--markdown-out", type=Path, default=None)
    parser.add_argument("--stdout", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = args.root.resolve()
    payload = build_contract(root)
    rendered_json = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    rendered_markdown = render_markdown(payload)

    json_out = args.json_out or (root / "docs/modular-panel-stage4.1-contract.json")
    markdown_out = args.markdown_out or (root / "docs/modular-panel-stage4.1-contract.md")
    json_out.parent.mkdir(parents=True, exist_ok=True)
    markdown_out.parent.mkdir(parents=True, exist_ok=True)
    json_out.write_text(rendered_json, encoding="utf-8", newline="\n")
    markdown_out.write_text(rendered_markdown, encoding="utf-8", newline="\n")

    if args.stdout:
        print(rendered_json, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
