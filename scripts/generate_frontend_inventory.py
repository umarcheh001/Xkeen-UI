from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


PROJECT_DIRNAME = "xkeen-ui"

PAGE_SPECS = {
    "panel": {
        "route": "/",
        "template": "templates/panel.html",
        "entry": "static/js/pages/panel.entry.js",
        "init": "static/js/pages/panel.init.js",
    },
    "backups": {
        "route": "/backups",
        "template": "templates/backups.html",
        "entry": "static/js/pages/backups.entry.js",
        "init": "static/js/pages/backups.init.js",
    },
    "devtools": {
        "route": "/devtools",
        "template": "templates/devtools.html",
        "entry": "static/js/pages/devtools.entry.js",
        "init": "static/js/pages/devtools.init.js",
    },
    "xkeen": {
        "route": "/xkeen",
        "template": "templates/xkeen.html",
        "entry": "static/js/pages/xkeen.entry.js",
        "init": "static/js/pages/xkeen.init.js",
    },
    "mihomo_generator": {
        "route": "/mihomo_generator",
        "template": "templates/mihomo_generator.html",
        "entry": "static/js/pages/mihomo_generator.entry.js",
        "init": "static/js/pages/mihomo_generator.init.js",
    },
}

STATIC_IMPORT_RE = re.compile(
    r"""(?m)^\s*import\s+(?:[\w*${}\n\r\t ,]+\s+from\s+)?['"]([^'"]+)['"]\s*;?"""
)
DYNAMIC_IMPORT_RE = re.compile(r"""import\(\s*['"]([^'"]+)['"]\s*\)""")
SCRIPT_TAG_SRC_RE = re.compile(r'<script\b[^>]*\bsrc="([^"]+)"', re.IGNORECASE)
GLOBAL_REF_RE = re.compile(r"""(?<![\w$])(?:window\.)?(XKeen|XK)(\.[A-Za-z_$][\w$]*)+""")
LAZY_FEATURE_RE = re.compile(
    r"""(?:ensurePanelLazyFeature|ensureFeature)\(\s*['"]([^'"]+)['"]\s*\)"""
)


@dataclass(frozen=True)
class ModuleScan:
    static_imports: list[str]
    dynamic_imports: list[str]
    globals: list[str]
    lazy_features: list[str]


class InventoryGenerator:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        self.project_root = self.root / PROJECT_DIRNAME
        self.docs_root = self.root / "docs"
        self._scan_cache: dict[Path, ModuleScan] = {}

    def build_inventory(self) -> dict[str, object]:
        pages: dict[str, object] = {}
        for page_name, spec in PAGE_SPECS.items():
            pages[page_name] = self._build_page_inventory(page_name, spec)
        return {
            "generated_from": "scripts/generate_frontend_inventory.py",
            "pages": pages,
        }

    def _build_page_inventory(self, page_name: str, spec: dict[str, str]) -> dict[str, object]:
        entry_rel = spec["entry"]
        init_rel = spec["init"]
        entry_path = self.project_root / entry_rel
        init_path = self.project_root / init_rel
        template_path = self.project_root / spec["template"]

        entry_scan = self._scan_module(entry_path)
        init_scan = self._scan_module(init_path)
        graph_paths = self._collect_static_graph(entry_path)

        payload: dict[str, object] = {
            "route": spec["route"],
            "template": spec["template"],
            "entry": entry_rel,
            "init": init_rel,
            "shared_imports": entry_scan.static_imports,
            "dynamic_imports": entry_scan.dynamic_imports,
            "template_script_tags": self._parse_template_script_tags(template_path),
            "esm_bootstrap_files": [self._serialize_module(path) for path in graph_paths],
            "direct_init_globals": init_scan.globals,
            "direct_init_lazy_features": init_scan.lazy_features,
            "all_bootstrap_globals": self._merge_module_field(graph_paths, "globals"),
            "all_bootstrap_lazy_features": self._merge_module_field(graph_paths, "lazy_features"),
            "lazy_runtime_inventory": None,
        }

        lazy_runtime_path = self.project_root / "static/js/runtime/lazy_runtime.js"
        if lazy_runtime_path.resolve() in graph_paths:
            payload["lazy_runtime_inventory"] = self._parse_lazy_runtime_inventory(lazy_runtime_path)

        return payload

    def _scan_module(self, path: Path) -> ModuleScan:
        resolved = path.resolve()
        cached = self._scan_cache.get(resolved)
        if cached is not None:
            return cached

        text = resolved.read_text(encoding="utf-8")
        scan = ModuleScan(
            static_imports=[match.group(1) for match in STATIC_IMPORT_RE.finditer(text)],
            dynamic_imports=[match.group(1) for match in DYNAMIC_IMPORT_RE.finditer(text)],
            globals=self._extract_globals(text),
            lazy_features=self._extract_lazy_features(text),
        )
        self._scan_cache[resolved] = scan
        return scan

    def _collect_static_graph(self, entry_path: Path) -> list[Path]:
        seen: set[Path] = set()
        ordered: list[Path] = []

        def visit(module_path: Path) -> None:
            scan = self._scan_module(module_path)
            for import_spec in scan.static_imports:
                resolved = self._resolve_import(module_path, import_spec)
                if resolved is None or resolved in seen:
                    continue
                seen.add(resolved)
                ordered.append(resolved)
                visit(resolved)

        visit(entry_path.resolve())
        return ordered

    def _resolve_import(self, owner_path: Path, import_spec: str) -> Path | None:
        cleaned = self._strip_query(import_spec)
        if not cleaned.startswith("."):
            return None

        candidate = (owner_path.parent / cleaned).resolve()
        if candidate.is_file():
            return candidate

        if not candidate.suffix:
            js_candidate = candidate.with_suffix(".js")
            if js_candidate.is_file():
                return js_candidate

        return None

    @staticmethod
    def _strip_query(value: str) -> str:
        return re.sub(r"[?#].*$", "", value)

    def _serialize_module(self, path: Path) -> dict[str, object]:
        scan = self._scan_module(path)
        return {
            "path": path.relative_to(self.project_root).as_posix(),
            "globals": scan.globals,
            "lazy_features": scan.lazy_features,
        }

    def _merge_module_field(self, graph_paths: Iterable[Path], field_name: str) -> list[str]:
        ordered: list[str] = []
        seen: set[str] = set()
        for path in graph_paths:
            values = getattr(self._scan_module(path), field_name)
            for value in values:
                if value in seen:
                    continue
                seen.add(value)
                ordered.append(value)
        return ordered

    def _extract_globals(self, text: str) -> list[str]:
        ordered: list[str] = []
        seen: set[str] = set()
        for match in GLOBAL_REF_RE.finditer(text):
            normalized = match.group(0).replace("window.", "")
            if normalized.startswith("XK."):
                normalized = "XKeen" + normalized[len("XK") :]
            if normalized not in seen:
                seen.add(normalized)
                ordered.append(normalized)
        return ordered

    def _extract_lazy_features(self, text: str) -> list[str]:
        ordered: list[str] = []
        seen: set[str] = set()
        for match in LAZY_FEATURE_RE.finditer(text):
            name = match.group(1)
            if name not in seen:
                seen.add(name)
                ordered.append(name)
        return ordered

    def _parse_template_script_tags(self, template_path: Path) -> list[str]:
        text = template_path.read_text(encoding="utf-8")
        return [match.group(1) for match in SCRIPT_TAG_SRC_RE.finditer(text)]

    def _parse_lazy_runtime_inventory(self, lazy_runtime_path: Path) -> dict[str, object]:
        text = lazy_runtime_path.read_text(encoding="utf-8")
        return {
            "feature_scripts": self._parse_lazy_runtime_feature_loaders(text),
            "build_managed_features": self._parse_build_managed_features(text),
        }

    def _parse_lazy_runtime_feature_loaders(self, text: str) -> dict[str, list[str]]:
        body = self._extract_braced_block(text, "const featureLoaders =")
        if body is None:
            return {}

        entry_re = re.compile(
            r"""([A-Za-z0-9_]+)\s*:\s*\(\)\s*=>\s*(.*?)(?=,\n\s*[A-Za-z0-9_]+\s*:|\n\s*$)""",
            re.DOTALL,
        )
        feature_scripts: dict[str, list[str]] = {}
        for item in entry_re.finditer(body):
            name = item.group(1)
            expr = item.group(2)
            imports: list[str] = []
            for import_match in DYNAMIC_IMPORT_RE.finditer(expr):
                resolved = self._resolve_runtime_import(import_match.group(1))
                if resolved is not None and resolved not in imports:
                    imports.append(resolved)
            feature_scripts[name] = imports
        return feature_scripts

    def _parse_build_managed_features(self, text: str) -> list[str]:
        body = self._extract_braced_block(text, "function getBuildManagedFeatureLoader(name)")
        if body is None:
            return []

        ordered: list[str] = []
        seen: set[str] = set()
        for match in re.finditer(r"""case\s+'([^']+)'\s*:""", body):
            name = match.group(1)
            if name not in seen:
                seen.add(name)
                ordered.append(name)
        return ordered

    def _extract_braced_block(self, text: str, marker: str) -> str | None:
        start = text.find(marker)
        if start < 0:
            return None
        brace_start = text.find("{", start)
        if brace_start < 0:
            return None

        depth = 0
        for index in range(brace_start, len(text)):
            char = text[index]
            if char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    return text[brace_start + 1 : index]
        return None

    def _resolve_runtime_import(self, import_spec: str) -> str | None:
        cleaned = self._strip_query(import_spec)
        if not cleaned.startswith("../"):
            return None

        candidate = (self.project_root / "static/js/runtime" / cleaned).resolve()
        if not candidate.is_file():
            return None

        return candidate.relative_to(self.project_root / "static").as_posix()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a reproducible frontend page inventory.")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--json-out", type=Path, default=None)
    parser.add_argument("--stdout", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    generator = InventoryGenerator(args.root)
    payload = generator.build_inventory()
    rendered = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"

    if args.stdout:
        print(rendered, end="")

    json_out = args.json_out or (generator.docs_root / "frontend-page-inventory.json")
    json_out.parent.mkdir(parents=True, exist_ok=True)
    json_out.write_text(rendered, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
