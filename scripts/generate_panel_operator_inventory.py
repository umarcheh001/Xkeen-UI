from __future__ import annotations

import argparse
import hashlib
import json
import re
import struct
from collections import Counter, defaultdict
from html.parser import HTMLParser
from pathlib import Path
from typing import Iterable


TEMPLATE_REL = "xkeen-ui/templates/panel.html"
OPERATOR_CSS_REL = "xkeen-ui/static/panel-operator.css"
LEGACY_CSS_REL = "xkeen-ui/static/styles.css"
EDITOR_ENGINE_REL = "xkeen-ui/static/js/ui/editor_engine.js"
BASELINE_DIR_REL = "docs/panel-operator-stage0-baseline"

VIEW_STATE_MATRIX = {
    "routing": [
        "active",
        "gui-focus",
        "raw-focus",
        "accordion-open",
        "accordion-closed",
        "loading",
        "loaded",
        "error",
        "narrow",
    ],
    "mihomo": ["active", "loading", "loaded", "error", "narrow"],
    "xkeen": ["active", "save-pending", "save-success", "error", "narrow"],
    "xray-logs": ["active", "loading", "live", "paused", "empty", "error", "narrow"],
    "commands": ["active", "loading", "loaded", "error", "narrow"],
    "files": [
        "active",
        "loading",
        "loaded",
        "empty",
        "error",
        "selected",
        "drag-drop",
        "remote",
        "narrow",
    ],
}

MODAL_FAMILIES = {
    "xray-context-modal": "master-detail",
    "xray-devices-modal": "master-detail",
    "terminal-history-modal": "drawer-help",
    "core-modal": "confirm-compact-form",
    "confirm-modal": "confirm-compact-form",
    "inbounds-apply-modal": "confirm-compact-form",
    "routing-balancer-help-modal": "drawer-help",
    "xray-snapshot-modal": "editor-workbench",
    "routing-template-modal": "master-detail",
    "routing-template-save-modal": "confirm-compact-form",
    "routing-template-edit-modal": "editor-workbench",
    "outbounds-generator-modal": "master-detail",
    "outbounds-pool-modal": "master-detail",
    "mihomo-import-modal": "editor-workbench",
    "mihomo-proxy-tools-modal": "master-detail",
    "mihomo-hwid-modal": "master-detail",
    "fm-upload-conflict-modal": "confirm-compact-form",
    "fm-editor-modal": "editor-workbench",
    "github-export-modal": "confirm-compact-form",
    "github-catalog-modal": "master-detail",
    "donate-modal": "confirm-compact-form",
    "ui-settings-modal": "master-detail",
    "json-editor-modal": "editor-workbench",
    "routing-dat-contents-modal": "master-detail",
    "mihomo-validation-modal": "master-detail",
    "ssh-modal": "master-detail",
    "ssh-edit-modal": "confirm-compact-form",
    "ssh-confirm-modal": "confirm-compact-form",
    "ssh-transfer-modal": "editor-workbench",
    "fm-connect-modal": "confirm-compact-form",
    "fm-knownhosts-modal": "master-detail",
    "fm-create-modal": "confirm-compact-form",
    "fm-rename-modal": "confirm-compact-form",
    "fm-archive-modal": "confirm-compact-form",
    "fm-extract-modal": "confirm-compact-form",
    "fm-folder-picker-modal": "master-detail",
    "fm-archive-list-modal": "master-detail",
    "fm-mask-modal": "confirm-compact-form",
    "fm-props-modal": "confirm-compact-form",
    "fm-hash-modal": "confirm-compact-form",
    "fm-chmod-modal": "confirm-compact-form",
    "fm-chown-modal": "confirm-compact-form",
    "fm-dropop-modal": "confirm-compact-form",
    "fm-conflicts-modal": "master-detail",
    "fm-bookmarks-modal": "master-detail",
    "fm-download-multi-modal": "confirm-compact-form",
    "fm-progress-modal": "confirm-compact-form",
    "fm-ops-modal": "master-detail",
    "fm-volumes-modal": "master-detail",
    "fm-help-modal": "drawer-help",
}

FAMILY_STATES = {
    "confirm-compact-form": ["closed", "open", "validation-error", "narrow"],
    "editor-workbench": ["closed", "open", "loading", "loaded", "error", "narrow"],
    "master-detail": ["closed", "open", "loading", "loaded", "empty", "error", "narrow"],
    "drawer-help": ["closed", "open", "loaded", "narrow"],
}

BASELINE_VIEWPORTS = [
    (1920, 1080),
    (1440, 900),
    (1280, 720),
    (1024, 768),
    (390, 844),
    (360, 800),
]
BASELINE_THEMES = ["dark", "light"]

CRITICAL_HIDDEN_RUNTIME_SELECTORS = [
    "#routing-focus-note",
    "#json-editor-file-label",
    "#inbounds-file-code",
    "#outbounds-file-code",
    ".xk-mihomo-topbar .xk-routing-active-inline",
]

STYLE_ATTR_RE = re.compile(r"\bstyle\s*=\s*([\"'])(.*?)\1", re.IGNORECASE | re.DOTALL)
ATTR_RE_TEMPLATE = r"\b{name}\s*=\s*([\"'])(.*?)\1"
STRING_LITERAL_RE = re.compile(r"(?P<quote>['\"])(?P<value>[A-Za-z0-9_.:#-]+)(?P=quote)")


class TemplateParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.elements: list[dict[str, object]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.elements.append(
            {
                "tag": tag,
                "attrs": {name: value if value is not None else "" for name, value in attrs},
                "line": self.getpos()[0],
            }
        )


def _classes(attrs: dict[str, str]) -> list[str]:
    return [item for item in attrs.get("class", "").split() if item]


def _locator(tag: str, attrs: dict[str, str], line: int) -> str:
    element_id = attrs.get("id")
    if element_id:
        return f"#{element_id}"
    classes = _classes(attrs)
    if classes:
        return tag + "".join(f".{name}" for name in classes[:3]) + f"@L{line}"
    return f"{tag}@L{line}"


def _attr_from_tag(tag_source: str, name: str) -> str | None:
    match = re.search(ATTR_RE_TEMPLATE.format(name=re.escape(name)), tag_source, re.IGNORECASE | re.DOTALL)
    return match.group(2) if match else None


def _parse_declarations(style: str) -> list[dict[str, str]]:
    declarations: list[dict[str, str]] = []
    for raw in style.split(";"):
        if ":" not in raw:
            continue
        prop, value = raw.split(":", 1)
        prop = prop.strip().lower()
        value = value.strip()
        if prop:
            declarations.append({"property": prop, "value": value})
    return declarations


def _declaration_kind(prop: str, value: str) -> str:
    normalized = re.sub(r"\s+", "", value.lower())
    if prop == "display" and normalized == "none":
        return "state-visibility"
    if prop == "visibility" and normalized in {"hidden", "collapse"}:
        return "state-visibility"
    return "presentation-geometry"


def _build_inline_styles(source: str) -> dict[str, object]:
    entries: list[dict[str, object]] = []
    property_counts: Counter[str] = Counter()
    declaration_kind_counts: Counter[str] = Counter()
    attribute_kind_counts: Counter[str] = Counter()

    for index, match in enumerate(STYLE_ATTR_RE.finditer(source), start=1):
        line = source.count("\n", 0, match.start()) + 1
        tag_start = source.rfind("<", 0, match.start())
        tag_end = source.find(">", match.end())
        tag_source = source[tag_start : tag_end + 1] if tag_start >= 0 and tag_end >= 0 else ""
        tag_match = re.match(r"<\s*([A-Za-z][\w:-]*)", tag_source)
        tag = tag_match.group(1).lower() if tag_match else "unknown"
        attrs = {
            "id": _attr_from_tag(tag_source, "id") or "",
            "class": _attr_from_tag(tag_source, "class") or "",
        }
        declarations = _parse_declarations(match.group(2))
        kinds = {_declaration_kind(item["property"], item["value"]) for item in declarations}
        if kinds == {"state-visibility"}:
            attribute_kind = "state-visibility-hook"
        elif kinds == {"presentation-geometry"} or not kinds:
            attribute_kind = "presentation-geometry"
        else:
            attribute_kind = "mixed-state-and-presentation"

        for item in declarations:
            property_counts[item["property"]] += 1
            declaration_kind_counts[_declaration_kind(item["property"], item["value"])] += 1
        attribute_kind_counts[attribute_kind] += 1
        entries.append(
            {
                "index": index,
                "locator": _locator(tag, attrs, line),
                "line": line,
                "kind": attribute_kind,
                "source": match.group(2).strip(),
                "declarations": declarations,
            }
        )

    return {
        "attribute_count": len(entries),
        "attribute_kind_counts": dict(sorted(attribute_kind_counts.items())),
        "declaration_count": sum(property_counts.values()),
        "declaration_kind_counts": dict(sorted(declaration_kind_counts.items())),
        "property_counts": dict(sorted(property_counts.items())),
        "migration_rule": (
            "Keep state-visibility declarations as runtime hooks. Move only presentation-geometry "
            "declarations to panel-operator.css; split mixed attributes before moving presentation."
        ),
        "entries": entries,
    }


def _find_target(elements: Iterable[dict[str, object]], target_id: str | None) -> dict[str, object] | None:
    if not target_id:
        return None
    for element in elements:
        attrs = element["attrs"]
        if isinstance(attrs, dict) and attrs.get("id") == target_id:
            return element
    return None


def _initial_visibility(element: dict[str, object] | None) -> str:
    if element is None:
        return "unknown"
    attrs = element["attrs"]
    assert isinstance(attrs, dict)
    classes = _classes(attrs)
    style = re.sub(r"\s+", "", attrs.get("style", "").lower())
    if "hidden" in classes or "display:none" in style:
        return "hidden"
    return "visible"


def _build_views(elements: list[dict[str, object]]) -> list[dict[str, object]]:
    views: list[dict[str, object]] = []
    for element in elements:
        attrs = element["attrs"]
        assert isinstance(attrs, dict)
        view_name = attrs.get("data-view")
        if not view_name:
            continue
        target_id = f"view-{view_name}"
        target = _find_target(elements, target_id)
        views.append(
            {
                "name": view_name,
                "control_locator": _locator(str(element["tag"]), attrs, int(element["line"])),
                "target_id": target_id,
                "target_present": target is not None,
                "initial_visibility": _initial_visibility(target),
                "states": VIEW_STATE_MATRIX[view_name],
            }
        )
    return views


def _build_top_level_actions(elements: list[dict[str, object]]) -> list[dict[str, str]]:
    actions: list[dict[str, str]] = []
    for element in elements:
        attrs = element["attrs"]
        assert isinstance(attrs, dict)
        classes = _classes(attrs)
        if "top-tab-btn" not in classes or attrs.get("data-view"):
            continue
        actions.append(
            {
                "id": attrs.get("id", ""),
                "section": attrs.get("data-xk-section", ""),
                "navigation_kind": "route" if attrs.get("data-nav-href") else "modal-action",
            }
        )
    return actions


def _build_accordions(elements: list[dict[str, object]]) -> list[dict[str, object]]:
    accordions: list[dict[str, object]] = []
    for element in elements:
        attrs = element["attrs"]
        assert isinstance(attrs, dict)
        classes = _classes(attrs)
        is_commands_header = "commands-header" in classes
        is_explicit_collapsible = bool(attrs.get("aria-controls") and attrs.get("aria-expanded") != "")
        if not is_commands_header and not is_explicit_collapsible:
            continue
        if attrs.get("id") == "last-load":
            continue

        control_id = attrs.get("id", "")
        target_id = attrs.get("aria-controls", "")
        if not target_id and control_id.endswith("-header"):
            candidate = control_id[: -len("-header")] + "-body"
            if _find_target(elements, candidate):
                target_id = candidate
        if not target_id and not attrs.get("data-xk-toggle"):
            continue
        target = _find_target(elements, target_id)
        expanded = attrs.get("aria-expanded")
        if expanded not in {"true", "false"}:
            expanded = "true" if _initial_visibility(target) == "visible" else "false"

        accordions.append(
            {
                "control_id": control_id or None,
                "control_locator": _locator(str(element["tag"]), attrs, int(element["line"])),
                "toggle_key": attrs.get("data-xk-toggle") or None,
                "target_id": target_id or None,
                "target_present": target is not None if target_id else None,
                "initial_expanded": expanded == "true",
                "states": ["collapsed", "expanded"],
            }
        )
    return accordions


def _editor_engine_contract(engine_source: str, elements: list[dict[str, object]]) -> dict[str, object]:
    valid_match = re.search(r"const\s+VALID\s*=\s*\[([^\]]+)\]", engine_source)
    valid = re.findall(r"['\"]([^'\"]+)['\"]", valid_match.group(1)) if valid_match else []
    default_match = re.search(r"const\s+DEFAULT_ENGINE\s*=\s*['\"]([^'\"]+)['\"]", engine_source)
    default = default_match.group(1) if default_match else None

    selectors: list[dict[str, object]] = []
    for element in elements:
        attrs = element["attrs"]
        assert isinstance(attrs, dict)
        element_id = attrs.get("id", "")
        if element["tag"] != "select" or "engine" not in element_id:
            continue
        selectors.append(
            {
                "id": element_id,
                "valid_values": valid,
                "default": default,
            }
        )
    return {
        "runtime_source": EDITOR_ENGINE_REL,
        "valid": valid,
        "default": default,
        "state_matrix": ["codemirror", "monaco", "loading", "fallback", "error"],
        "selectors": selectors,
    }


def _build_modals(elements: list[dict[str, object]]) -> list[dict[str, object]]:
    modals: list[dict[str, object]] = []
    for element in elements:
        attrs = element["attrs"]
        assert isinstance(attrs, dict)
        if "modal" not in _classes(attrs) or not attrs.get("id"):
            continue
        modal_id = attrs["id"]
        family = MODAL_FAMILIES.get(modal_id)
        modals.append(
            {
                "id": modal_id,
                "family": family,
                "initial_visibility": _initial_visibility(element),
                "aria_modal": attrs.get("aria-modal") or None,
                "aria_label": attrs.get("aria-label") or None,
                "data_modal_key": attrs.get("data-modal-key") or None,
                "states": FAMILY_STATES.get(family or "", []),
            }
        )
    return modals


def _build_js_id_references(root: Path, template_ids: set[str]) -> dict[str, list[str]]:
    references: defaultdict[str, set[str]] = defaultdict(set)
    js_root = root / "xkeen-ui/static/js"
    for path in sorted(js_root.rglob("*.js")):
        if "vendor" in path.parts:
            continue
        source = path.read_text(encoding="utf-8", errors="replace")
        literals = {match.group("value") for match in STRING_LITERAL_RE.finditer(source)}
        for value in literals & template_ids:
            references[value].add(path.relative_to(root).as_posix())
        for value in literals:
            if value.startswith("#") and value[1:] in template_ids:
                references[value[1:]].add(path.relative_to(root).as_posix())
    return {key: sorted(value) for key, value in sorted(references.items())}


def _build_dom_contract(root: Path, source: str, elements: list[dict[str, object]]) -> dict[str, object]:
    ids = [
        attrs["id"]
        for element in elements
        if isinstance((attrs := element["attrs"]), dict) and attrs.get("id")
    ]
    id_counts = Counter(ids)
    duplicate_ids = sorted(key for key, count in id_counts.items() if count > 1)
    template_ids = set(ids)

    data_attributes: list[dict[str, str]] = []
    hidden_ids: set[str] = set()
    for element in elements:
        attrs = element["attrs"]
        assert isinstance(attrs, dict)
        locator = _locator(str(element["tag"]), attrs, int(element["line"]))
        for name, value in sorted(attrs.items()):
            if name.startswith("data-"):
                data_attributes.append({"locator": locator, "name": name, "value": value})
        if attrs.get("id") and _initial_visibility(element) == "hidden":
            hidden_ids.add(attrs["id"])

    # HTMLParser can lose a few attributes around Jinja control blocks. Recover
    # id-bearing display:none hooks directly from source so the contract remains complete.
    for match in STYLE_ATTR_RE.finditer(source):
        if "display:none" not in re.sub(r"\s+", "", match.group(2).lower()):
            continue
        tag_start = source.rfind("<", 0, match.start())
        tag_end = source.find(">", match.end())
        tag_source = source[tag_start : tag_end + 1]
        element_id = _attr_from_tag(tag_source, "id")
        if element_id:
            hidden_ids.add(element_id)

    references = _build_js_id_references(root, template_ids)
    return {
        "id_count": len(ids),
        "unique_id_count": len(template_ids),
        "duplicate_ids": duplicate_ids,
        "ids": sorted(template_ids),
        "data_attribute_count": len(data_attributes),
        "data_attributes": data_attributes,
        "hidden_runtime_node_count": len(hidden_ids),
        "hidden_runtime_node_ids": sorted(hidden_ids),
        "critical_hidden_runtime_selectors": CRITICAL_HIDDEN_RUNTIME_SELECTORS,
        "js_referenced_template_id_count": len(references),
        "js_referenced_template_ids": references,
        "handler_guard": (
            "Static JS references preserve handler anchors; e2e/panel_operator_contract.spec.mjs "
            "executes critical theme, view, accordion and modal handlers."
        ),
    }


def _read_png_size(path: Path) -> list[int] | None:
    if not path.is_file():
        return None
    with path.open("rb") as stream:
        header = stream.read(24)
    if len(header) != 24 or header[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    width, height = struct.unpack(">II", header[16:24])
    return [width, height]


def _build_baselines(root: Path) -> dict[str, object]:
    captures: list[dict[str, object]] = []
    for theme in BASELINE_THEMES:
        for width, height in BASELINE_VIEWPORTS:
            rel = f"{BASELINE_DIR_REL}/routing-{theme}-{width}x{height}.png"
            path = root / rel
            captures.append(
                {
                    "theme": theme,
                    "viewport": [width, height],
                    "state": "routing/default/codemirror",
                    "path": rel,
                    "present": path.is_file(),
                    "png_size": _read_png_size(path),
                    "sha256": hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None,
                }
            )
    return {
        "route": "/",
        "capture_command": (
            "XKEEN_CAPTURE_STAGE0_BASELINE=1 npx playwright test "
            "e2e/panel_operator_baseline.spec.mjs --project=chromium"
        ),
        "captures": captures,
    }


def _legacy_panel_rule_guard(source: str) -> dict[str, object]:
    without_comments = re.sub(r"/\*.*?\*/", "", source, flags=re.DOTALL)
    blocks: list[str] = []
    for match in re.finditer(r"([^{}]+)\{([^{}]*)\}", without_comments):
        prelude = " ".join(match.group(1).split())
        declarations = " ".join(match.group(2).split())
        if "body.panel-page" in prelude:
            blocks.append(f"{prelude}{{{declarations}}}")
    payload = "\n".join(blocks) + "\n"
    return {
        "frozen_rule_block_count": len(blocks),
        "frozen_rule_blocks_sha256": hashlib.sha256(payload.encode("utf-8")).hexdigest(),
        "policy": "Existing legacy blocks are frozen; do not add or edit panel redesign rules here.",
    }


class PanelOperatorInventoryGenerator:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve()

    def build(self) -> dict[str, object]:
        template_path = self.root / TEMPLATE_REL
        source = template_path.read_text(encoding="utf-8")
        parser = TemplateParser()
        parser.feed(source)
        elements = parser.elements
        modals = _build_modals(elements)

        modal_ids = {item["id"] for item in modals}
        family_ids = set(MODAL_FAMILIES)
        missing_family_ids = sorted(modal_ids - family_ids)
        stale_family_ids = sorted(family_ids - modal_ids)

        return {
            "schema_version": 1,
            "generated_from": "scripts/generate_panel_operator_inventory.py",
            "sources": {
                "template": TEMPLATE_REL,
                "operator_stylesheet": OPERATOR_CSS_REL,
                "legacy_stylesheet": LEGACY_CSS_REL,
            },
            "ownership_contract": {
                "body_scope": "body.panel-page",
                "operator_stylesheet_must_be_last": True,
                "panel_redesign_rules_allowed_in_legacy_stylesheet": False,
                "operator_stylesheet_owns_presentation_only": True,
                "legacy_panel_rule_guard": _legacy_panel_rule_guard(
                    (self.root / LEGACY_CSS_REL).read_text(encoding="utf-8")
                ),
            },
            "top_level_views": _build_views(elements),
            "top_level_actions": _build_top_level_actions(elements),
            "accordions": _build_accordions(elements),
            "editor_engines": _editor_engine_contract(
                (self.root / EDITOR_ENGINE_REL).read_text(encoding="utf-8"), elements
            ),
            "modal_inventory": {
                "count": len(modals),
                "family_counts": dict(sorted(Counter(item["family"] for item in modals).items())),
                "missing_family_ids": missing_family_ids,
                "stale_family_ids": stale_family_ids,
                "items": modals,
            },
            "inline_styles": _build_inline_styles(source),
            "dom_contract": _build_dom_contract(self.root, source, elements),
            "visual_baselines": _build_baselines(self.root),
        }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate the Operator Console Stage 0 inventory.")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--json-out", type=Path, default=None)
    parser.add_argument("--stdout", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    generator = PanelOperatorInventoryGenerator(args.root)
    payload = generator.build()
    rendered = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    if args.stdout:
        print(rendered, end="")
    output = args.json_out or (generator.root / "docs/panel-operator-stage0-inventory.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(rendered, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
