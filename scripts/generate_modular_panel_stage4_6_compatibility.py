"""Generate the server-rendered compatibility contract for modular panel Stage 4.6."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


STAGE4_1_CONTRACT = "docs/modular-panel-stage4.1-contract.json"
PANEL_TEMPLATE = "xkeen-ui/templates/panel.html"
ROUTE_PATHS = {"mihomo_generator_page": "/mihomo_generator"}


def _load_stage4_1_contract(root: Path) -> dict[str, Any]:
    return json.loads((root / STAGE4_1_CONTRACT).read_text(encoding="utf-8"))


def _load_manifests(root: Path):
    ui_root = str((root / "xkeen-ui").resolve())
    if ui_root not in sys.path:
        sys.path.insert(0, ui_root)
    from routes.pages import PANEL_COMPOSITION, PANEL_NAVIGATION

    return PANEL_COMPOSITION, PANEL_NAVIGATION


def _navigation_for(active_module_ids: list[str] | None, navigation) -> list[dict[str, str | None]]:
    active = None if active_module_ids is None else set(active_module_ids)
    result: list[dict[str, str | None]] = []
    for item in navigation:
        if active is not None and not set(item.owners) <= active:
            continue
        result.append(
            {
                "section": item.section,
                "view": item.view,
                "id": item.element_id,
                "href": ROUTE_PATHS.get(item.href_endpoint),
                "top_nav": "1" if item.top_nav else None,
            }
        )
    return result


def _required_data_attributes(screen_sections: list[str], active_module_ids: list[str] | None) -> dict[str, dict[str, str]]:
    attributes = {
        f"view-{section}": {"data-xk-section": section}
        for section in screen_sections
    }
    active = None if active_module_ids is None else set(active_module_ids)
    if active is None or "engine.xray" in active:
        attributes["xray-logs-badge"] = {"data-state": "off", "data-live": "off"}
        attributes["routing-dns-over-vless-modal"] = {
            "data-operator-modal-family": "confirm-compact-form",
            "data-modal-noresize": "1",
            "data-modal-nopos": "1",
            "data-modal-remember": "0",
            "data-modal-backdrop-close": "0",
        }
    if active is None or "engine.mihomo" in active:
        attributes["mihomo-dns-modal"] = {
            "data-operator-modal-family": "confirm-compact-form",
            "data-modal-noresize": "1",
            "data-modal-nopos": "1",
            "data-modal-remember": "0",
        }
    if active is None or "tool.advanced-diagnostics" in active:
        attributes["xk-resource-dashboard-modal"] = {
            "data-operator-modal-family": "master-detail",
            "data-modal-key": "resource-dashboard",
        }
    if active is None or "core" in active:
        attributes["core-modal"] = {
            "data-operator-modal-family": "confirm-compact-form",
            "data-modal-remember": "0",
            "data-modal-nopos": "1",
        }
    return attributes


def _profile_contract(
    source: dict[str, Any],
    *,
    active_module_ids: list[str] | None,
    navigation,
    forbidden_dom_ids: list[str],
) -> dict[str, Any]:
    screen_sections = list(source["expected_views"])
    return {
        "id": source["id"],
        "active_module_ids": active_module_ids,
        "screen_sections": screen_sections,
        "forbidden_screen_sections": list(source["forbidden_views"]),
        "navigation": _navigation_for(active_module_ids, navigation),
        "required_modal_ids": list(source["expected_modal_ids"]),
        "forbidden_modal_ids": list(source["forbidden_modal_ids"]),
        "forbidden_dom_ids": forbidden_dom_ids,
        "required_data_attributes": _required_data_attributes(
            screen_sections, active_module_ids
        ),
    }


def build_contract(root: Path) -> dict[str, Any]:
    """Return profile expectations anchored to Stage 4.1 and the live manifest."""

    stage4_1 = _load_stage4_1_contract(root)
    composition, navigation = _load_manifests(root)
    profiles = {item["id"]: item for item in stage4_1["profiles"]}
    all_screen_sections = [item["id"] for item in stage4_1["screens"]]
    static_core_modals = [
        item["id"] for item in stage4_1["modals"] if item["target_module_id"] == "core"
    ]
    static_optional_modals = [
        item["id"] for item in stage4_1["modals"] if item["target_module_id"] != "core"
    ]

    core_only = {
        "id": "core-only",
        "expected_views": ["xkeen"],
        "forbidden_views": [section for section in all_screen_sections if section != "xkeen"],
        "expected_modal_ids": static_core_modals,
        "forbidden_modal_ids": static_optional_modals,
    }
    empty = {
        "id": "empty-active-set",
        "expected_views": [],
        "forbidden_views": all_screen_sections,
        "expected_modal_ids": [],
        "forbidden_modal_ids": [item["id"] for item in stage4_1["modals"]],
    }

    xray_forbidden = [
        "view-mihomo",
        "mihomo-editor",
        "mihomo-clash-runtime",
        "view-commands",
        "terminal-overlay",
        "view-files",
        "fm-root",
        "xk-resource-monitor",
    ]
    mihomo_forbidden = [
        "view-routing",
        "routing-dat-header",
        "view-xray-logs",
        "xray-log-output",
        "xray-logs-badge",
        "routing-focus-switch",
        "view-commands",
        "terminal-overlay",
        "view-files",
        "fm-root",
        "xk-resource-monitor",
    ]
    core_forbidden = [
        "view-routing",
        "view-mihomo",
        "view-commands",
        "view-files",
        "view-xray-logs",
        "routing-dat-header",
        "mihomo-editor",
        "terminal-overlay",
        "fm-root",
        "xray-logs-badge",
        "routing-focus-switch",
        "xk-resource-monitor",
    ]

    profile_contracts = [
        _profile_contract(
            profiles["legacy-full"],
            active_module_ids=None,
            navigation=navigation,
            forbidden_dom_ids=[],
        ),
        _profile_contract(
            profiles["full"],
            active_module_ids=list(profiles["full"]["active_module_ids"]),
            navigation=navigation,
            forbidden_dom_ids=[],
        ),
        _profile_contract(
            profiles["xray-minimal"],
            active_module_ids=list(profiles["xray-minimal"]["active_module_ids"]),
            navigation=navigation,
            forbidden_dom_ids=xray_forbidden,
        ),
        _profile_contract(
            profiles["mihomo-minimal"],
            active_module_ids=list(profiles["mihomo-minimal"]["active_module_ids"]),
            navigation=navigation,
            forbidden_dom_ids=mihomo_forbidden,
        ),
        _profile_contract(
            core_only,
            active_module_ids=["core"],
            navigation=navigation,
            forbidden_dom_ids=core_forbidden,
        ),
        _profile_contract(
            empty,
            active_module_ids=[],
            navigation=navigation,
            forbidden_dom_ids=[*core_forbidden, "view-xkeen", "core-modal"],
        ),
    ]

    panel_source = (root / PANEL_TEMPLATE).read_text(encoding="utf-8")
    return {
        "schema_version": 1,
        "stage": {
            "id": "4.6",
            "name": "Совместимость, тесты и удаление монолита",
            "status": "closed",
            "closed_on": "2026-10-01",
        },
        "entrypoint": {
            "template": PANEL_TEMPLATE,
            "role": "thin-composition-root",
            "line_count": len(panel_source.splitlines()),
            "literal_includes": ["panel/head.html", "panel/shell.html"],
            "dynamic_collections": [
                "pre_screen_modal_partials",
                "screen_partials",
                "modal_partials",
            ],
            "owns_screen_markup": 'id="view-' in panel_source,
            "owns_modal_markup": 'class="modal' in panel_source,
        },
        "composition_manifest": [
            {
                "collection": item.collection,
                "owners": list(item.owners),
                "template": item.template,
            }
            for item in composition
        ],
        "navigation_manifest": [
            {
                "owners": list(item.owners),
                "section": item.section,
                "view": item.view,
                "id": item.element_id,
                "href": ROUTE_PATHS.get(item.href_endpoint),
                "top_nav": bool(item.top_nav),
            }
            for item in navigation
        ],
        "full_legacy_equivalence": {
            "profiles": ["legacy-full", "full"],
            "compared_surfaces": [
                "all DOM ids in document order",
                "data-* attributes on every id-bearing element",
                "top navigation data-view/data-xk-section/id/href",
                "modal root ids",
            ],
        },
        "profiles": profile_contracts,
        "non_goals": [
            "frontend bundle loading and static imports",
            "dynamic import() and lazy CSS loading",
            "frontend API and WebSocket calls for inactive modules",
        ],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate the Stage 4.6 modular panel compatibility contract."
    )
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--json-out", type=Path, default=None)
    parser.add_argument("--stdout", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = args.root.resolve()
    payload = build_contract(root)
    rendered = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    json_out = args.json_out or root / "docs/modular-panel-stage4.6-compatibility.json"
    json_out.parent.mkdir(parents=True, exist_ok=True)
    json_out.write_text(rendered, encoding="utf-8", newline="\n")
    if args.stdout:
        print(rendered, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
