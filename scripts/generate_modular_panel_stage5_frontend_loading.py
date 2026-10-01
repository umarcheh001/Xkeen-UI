"""Generate the Stage 5 frontend module-loading contract."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


PROFILE_MODULES: dict[str, tuple[str, ...] | None] = {
    "legacy-full": None,
    "full": (
        "core",
        "engine.xray",
        "engine.mihomo",
        "tool.editor",
        "tool.terminal",
        "tool.files",
        "tool.backups",
        "integration.happ",
        "tool.advanced-diagnostics",
    ),
    "xray-minimal": ("core", "tool.editor", "engine.xray"),
    "mihomo-minimal": ("core", "tool.editor", "engine.mihomo"),
    "core-only": ("core",),
}


def _load_descriptor_builder(root: Path):
    ui_root = str((root / "xkeen-ui").resolve())
    if ui_root not in sys.path:
        sys.path.insert(0, ui_root)
    from routes.pages import build_panel_frontend_modules

    return build_panel_frontend_modules


def build_contract(root: Path) -> dict[str, Any]:
    """Return a stable, source-derived dynamic-loading matrix."""

    build_descriptor = _load_descriptor_builder(root)
    profiles: list[dict[str, Any]] = []
    for profile, active_module_ids in PROFILE_MODULES.items():
        descriptor = build_descriptor(
            None if active_module_ids is None else set(active_module_ids)
        )
        bundles = list(descriptor["bundles"])
        profiles.append(
            {
                "id": profile,
                "active_module_ids": descriptor["activeModuleIds"],
                "bundles": bundles,
                "startup_bundle_keys": [
                    item["key"] for item in bundles if item["loadMode"] == "startup"
                ],
                "lazy_bundle_keys": [
                    item["key"] for item in bundles if item["loadMode"] != "startup"
                ],
                "lazy_css": {
                    item["key"]: item["cssKeys"]
                    for item in bundles
                    if item["cssKeys"]
                },
            }
        )

    return {
        "schema_version": 1,
        "generated_from": "scripts/generate_modular_panel_stage5_frontend_loading.py",
        "stage": {
            "id": "5",
            "name": "Динамическая frontend-загрузка",
            "status": "closed",
            "closed_on": "2026-10-01",
        },
        "loader": {
            "entrypoint": "xkeen-ui/static/js/pages/panel.module_loader.js",
            "descriptor_path": "window.XKeen.pageConfig.frontendModules",
            "loader_registry": "fixed local import() allow-list",
            "shared_compatibility_css": ["styles.css", "panel-operator.css"],
        },
        "profiles": profiles,
    }


def render_markdown(payload: dict[str, Any]) -> str:
    lines = [
        "# Этап 5: динамическая frontend-загрузка",
        "",
        "**Статус:** закрыт 1 октября 2026 года.",
        "",
        "Панель получает серверный allow-listed descriptor в "
        "`window.XKeen.pageConfig.frontendModules`. Локальный loader сопоставляет "
        "его ключи с фиксированными `import()`-фабриками; persisted state не может "
        "задавать browser import path.",
        "",
            "`styles.css` и `panel-operator.css` остаются общими compatibility CSS. "
            "`xterm.css` принадлежит `terminal-lazy` и добавляется только при загрузке терминала.",
            "",
            "`pageConfig.runtime.websocket` сообщает о фактической способности "
            "сервера принять WebSocket upgrade. Когда она выключена, журнал операций "
            "остаётся на HTTP-поллинге и не пытается открыть `/ws/events`.",
            "",
            "## Матрица профилей",
        "",
        "| Профиль | Startup bundles | Lazy bundles | Lazy CSS |",
        "| --- | --- | --- | --- |",
    ]
    for profile in payload["profiles"]:
        startup = ", ".join(profile["startup_bundle_keys"]) or "-"
        lazy = ", ".join(profile["lazy_bundle_keys"]) or "-"
        styles = ", ".join(
            css for values in profile["lazy_css"].values() for css in values
        ) or "-"
        lines.append(f"| `{profile['id']}` | {startup} | {lazy} | {styles} |")

    lines.extend(
        [
            "",
            "## Проверки",
            "",
            "- Python-контракт проверяет descriptor, allow-list, DOM guards, lazy CSS и generated snapshot.",
            "- E2E fixture принимает `XKEEN_E2E_MODULE_PROFILE` (`full`, `xray-minimal`, `mihomo-minimal`, `core-only`) и записывает свой `modules.json` до запуска Flask.",
            "- Browser profile tests наблюдают Network, WebSocket и console, не обращаясь к локальному рабочему стенду разработчика.",
            "",
        ]
    )
    return "\n".join(lines)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate Stage 5 frontend-loading docs.")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--json-out", type=Path, default=None)
    parser.add_argument("--markdown-out", type=Path, default=None)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = args.root.resolve()
    payload = build_contract(root)
    json_out = args.json_out or root / "docs" / "modular-panel-stage5-frontend-loading.json"
    markdown_out = args.markdown_out or root / "docs" / "modular-panel-stage5-frontend-loading.md"
    json_out.parent.mkdir(parents=True, exist_ok=True)
    markdown_out.parent.mkdir(parents=True, exist_ok=True)
    json_out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    markdown_out.write_text(render_markdown(payload), encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
