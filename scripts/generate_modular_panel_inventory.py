from __future__ import annotations

import argparse
import ast
import json
import re
import subprocess
from collections import Counter, defaultdict
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Iterable


PROJECT_DIRNAME = "xkeen-ui"
SCHEMA_VERSION = 1
STAGE_CLOSED_ON = "2026-09-29"

MODULE_SPECS: dict[str, dict[str, Any]] = {
    "core": {
        "name": "Xkeen UI Core",
        "description": "Запуск панели, авторизация, shell, настройки, сервис, capabilities и общий runtime.",
        "depends_on": [],
        "system_requirements": ["python3", "flask"],
        "removable": False,
    },
    "engine.xray": {
        "name": "Xray",
        "description": "Routing, inbounds, outbounds, подписки, логи, DNS-over-VLESS и geodat.",
        "depends_on": ["core", "tool.editor"],
        "system_requirements": ["xkeen", "xray"],
        "removable": True,
    },
    "engine.mihomo": {
        "name": "Mihomo",
        "description": "Mihomo config, Clash API, DNS, генератор, импорт, telemetry и Zashboard.",
        "depends_on": ["core", "tool.editor"],
        "system_requirements": ["xkeen", "mihomo"],
        "removable": True,
    },
    "tool.editor": {
        "name": "Редакторы",
        "description": "CodeMirror, Monaco, JSON/YAML schema, форматирование, diff и quick-fix.",
        "depends_on": ["core"],
        "system_requirements": ["browser-esm"],
        "removable": True,
    },
    "tool.terminal": {
        "name": "Терминал и команды",
        "description": "PTY, WebSocket, xterm, command jobs и shell policy.",
        "depends_on": ["core"],
        "system_requirements": ["shell", "gevent (optional)", "gevent-websocket (optional)"],
        "removable": True,
    },
    "tool.files": {
        "name": "Файловый менеджер",
        "description": "Локальные/удалённые операции, архивы, передачи и USB storage.",
        "depends_on": ["core"],
        "system_requirements": ["lftp (remote optional)", "ndmc (USB optional)"],
        "removable": True,
    },
    "tool.backups": {
        "name": "Резервные копии",
        "description": "Страница и API резервных копий конфигураций Xray/Mihomo.",
        "depends_on": ["core"],
        "system_requirements": [],
        "removable": True,
    },
    "integration.happ": {
        "name": "Happ",
        "description": "Декриптор Happ, payload/link helpers и Mihomo HWID/Happ subscriptions.",
        "depends_on": ["core", "engine.mihomo"],
        "system_requirements": ["happ-decrypt-universal (optional)"],
        "removable": True,
    },
    "tool.advanced-diagnostics": {
        "name": "Расширенная диагностика",
        "description": "DevTools, ресурсы, router diagnostics, update UI и служебные журналы.",
        "depends_on": ["core"],
        "system_requirements": ["ndmc (router diagnostics optional)"],
        "removable": True,
    },
}

MODULE_ORDER = tuple(MODULE_SPECS)

FRONTEND_ROOTS: dict[str, str] = {
    "panel-core": "static/js/pages/panel.entry.js",
    "panel-routing": "static/js/pages/panel.routing.bundle.js",
    "panel-mihomo": "static/js/pages/panel.mihomo.bundle.js",
    "terminal-lazy": "static/js/pages/terminal.lazy.entry.js",
    "file-manager-lazy": "static/js/pages/file_manager.lazy.entry.js",
    "backups-page": "static/js/pages/backups.entry.js",
    "devtools-page": "static/js/pages/devtools.entry.js",
    "xkeen-page": "static/js/pages/xkeen.entry.js",
    "mihomo-generator-page": "static/js/pages/mihomo_generator.entry.js",
}

CONFIG_PATHS = (
    "package.json",
    "pyproject.toml",
    "requirements-dev.txt",
    "vite.config.mjs",
    "playwright.config.mjs",
    "xkeen-ui/install.sh",
    "xkeen-ui/uninstall.sh",
)

CONFIG_GLOBS = (
    "packaging/**/*",
    ".github/workflows/*.yml",
    "xkeen-ui/opt/**/*",
)

PY_ROUTE_DECORATOR_RE = re.compile(r"^(get|post|put|patch|delete|route|websocket)$")
ENV_RE = re.compile(r"\bXKEEN_[A-Z0-9_]+\b")
STATIC_IMPORT_RE = re.compile(
    r"""(?m)^\s*import\s+(?:[\w*${}\n\r\t ,]+\s+from\s+)?['"]([^'"]+)['"]\s*;?"""
)
DYNAMIC_IMPORT_RE = re.compile(r"""import\(\s*['"]([^'"]+)['"]\s*\)""")
TOP_VIEW_RE = re.compile(
    r"""<button\b[^>]*\bdata-view=["']([^"']+)["'][^>]*>""",
    re.IGNORECASE | re.DOTALL,
)
MANUAL_WS_ROUTE_RE = re.compile(r"""path\s*==\s*["']([^"']+)["']""")


def _ordered_unique(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        normalized = str(value or "").strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(normalized)
    return result


class _PanelSurfaceParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.modal_ids: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr_map = {key: value or "" for key, value in attrs}
        classes = set(attr_map.get("class", "").split())
        identifier = attr_map.get("id", "").strip()
        if identifier and "modal" in classes:
            self.modal_ids.append(identifier)


class ModularPanelInventoryGenerator:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        self.project_root = self.root / PROJECT_DIRNAME
        self.docs_root = self.root / "docs"
        self._module_cache: dict[str, str] = {}
        self._tracked_paths = self._load_tracked_paths()
        self._frontend_bundle_map = self._build_frontend_bundle_map()

    def build_inventory(self) -> dict[str, Any]:
        units = [self._build_unit(path, kind) for path, kind in self._iter_inventory_files()]
        units.sort(key=lambda item: (item["module_id"], item["kind"], item["path"]))

        routes = self._build_route_inventory(units)
        background_tasks = self._build_background_task_inventory()
        ui_surfaces = self._build_ui_surface_inventory()
        coupling = self._build_coupling_inventory(units)
        modules = self._build_module_inventory(units, routes, background_tasks, ui_surfaces)

        return {
            "schema_version": SCHEMA_VERSION,
            "generated_from": "scripts/generate_modular_panel_inventory.py",
            "stage": {
                "id": 0,
                "name": "Инвентаризация текущей панели",
                "status": "closed",
                "closed_on": STAGE_CLOSED_ON,
            },
            "scope": {
                "official_repository_only": True,
                "repository": "umarcheh001/Xkeen-UI",
                "arbitrary_external_plugins": False,
                "inventory_roots": [
                    "xkeen-ui/routes",
                    "xkeen-ui/services",
                    "xkeen-ui/static/js",
                    "xkeen-ui/static/*.css",
                    "xkeen-ui/static/schemas",
                    "xkeen-ui/templates",
                    "tests",
                    "e2e",
                    "packaging",
                    ".github/workflows",
                    "xkeen-ui/opt",
                ],
            },
            "modules": modules,
            "units": units,
            "routes": routes,
            "background_tasks": background_tasks,
            "frontend_bundles": self._serialize_frontend_bundles(),
            "ui_surfaces": ui_surfaces,
            "coupling": coupling,
            "findings": self._build_findings(modules, routes, background_tasks, coupling, ui_surfaces),
        }

    def _iter_inventory_files(self) -> Iterable[tuple[Path, str]]:
        seen: set[Path] = set()

        def emit(paths: Iterable[Path], kind: str) -> Iterable[tuple[Path, str]]:
            for path in sorted(paths):
                resolved = path.resolve()
                if resolved in seen or not path.is_file():
                    continue
                if "__pycache__" in path.parts:
                    continue
                rel = path.relative_to(self.root).as_posix()
                if not self._is_tracked_path(rel):
                    continue
                seen.add(resolved)
                yield path, kind

        yield from emit(self.project_root.glob("routes/**/*.py"), "backend_route")
        yield from emit(self.project_root.glob("services/**/*.py"), "backend_service")

        for rel in (
            "app.py",
            "app_factory.py",
            "run_server.py",
            "bootstrap_mihomo_env.py",
            "mihomo_config_generator.py",
            "mihomo_server_core.py",
            "xkeen_mihomo_service.py",
        ):
            yield from emit((self.project_root / rel,), "app_runtime")

        yield from emit(self.project_root.glob("static/js/**/*.js"), "frontend_javascript")
        yield from emit(self.project_root.glob("templates/**/*.html"), "template")
        yield from emit(self.project_root.glob("static/*.css"), "stylesheet")
        yield from emit(self.project_root.glob("static/schemas/*.json"), "editor_schema")
        yield from emit(self.root.glob("tests/test_*.py"), "backend_test")
        yield from emit(self.root.glob("e2e/*.spec.mjs"), "frontend_test")

        for rel in CONFIG_PATHS:
            yield from emit((self.root / rel,), "configuration")
        for pattern in CONFIG_GLOBS:
            yield from emit(self.root.glob(pattern), "configuration")

    def _is_tracked_path(self, rel: str) -> bool:
        if self._tracked_paths is None:
            return True
        return rel in self._tracked_paths

    def _load_tracked_paths(self) -> set[str] | None:
        if not (self.root / ".git").exists():
            return None
        try:
            result = subprocess.run(
                ["git", "ls-files", "-z"],
                cwd=self.root,
                capture_output=True,
                check=False,
            )
            if result.returncode != 0:
                return None
            return {
                item.decode("utf-8", errors="surrogateescape").replace("\\", "/")
                for item in result.stdout.split(b"\0")
                if item
            }
        except OSError:
            # Release archives may not contain .git. In that environment all
            # files inside the archive are part of the canonical source tree.
            return None

    def _build_unit(self, path: Path, kind: str) -> dict[str, Any]:
        rel = path.relative_to(self.root).as_posix()
        text = self._read_text(path)
        module_id = self._module_for_path(rel)
        route_defs = self._extract_python_routes(path) if path.suffix == ".py" else []
        if rel == "xkeen-ui/run_server.py":
            route_defs.extend(
                {"method": "WEBSOCKET", "path": route, "decorator": "PATH_INFO"}
                for route in MANUAL_WS_ROUTE_RE.findall(text)
            )
        route_defs = self._dedupe_dicts(route_defs, keys=("method", "path", "decorator"))

        background_markers = self._background_markers(rel, text)
        direct_dependencies = self._detect_direct_module_dependencies(path, rel, text, module_id)
        module_dependencies = MODULE_SPECS[module_id]["depends_on"]
        dependencies = _ordered_unique([*module_dependencies, *direct_dependencies])

        return {
            "module_id": module_id,
            "kind": self._refine_kind(rel, kind),
            "path": rel,
            # Physical file sizes differ between Windows and Linux checkouts
            # when Git normalizes line endings. Inventory snapshots must be
            # reproducible on both, so measure canonical UTF-8 text after
            # universal-newline normalization instead of stat().st_size.
            "size_bytes": len(text.encode("utf-8")),
            "depends_on": dependencies,
            "starts_background_task": bool(background_markers),
            "background_markers": background_markers,
            "registers_routes": bool(route_defs),
            "routes": route_defs,
            "frontend_bundle": self._frontend_bundle_map.get(rel, []),
            "system_requirements": list(MODULE_SPECS[module_id]["system_requirements"]),
            "environment_variables": sorted(set(ENV_RE.findall(text))),
            "removable": bool(MODULE_SPECS[module_id]["removable"]),
        }

    def _refine_kind(self, rel: str, kind: str) -> str:
        if kind != "frontend_javascript":
            return kind
        if rel.endswith(".entry.js"):
            return "frontend_entrypoint"
        if "/static/js/pages/" in rel and (".bundle." in rel or rel.endswith(".bundle.js")):
            return "frontend_bundle"
        if "/static/js/features/" in rel:
            return "frontend_feature"
        if "/static/js/ui/" in rel:
            return "frontend_ui"
        if "/static/js/runtime/" in rel:
            return "frontend_runtime"
        if "/static/js/terminal/" in rel:
            return "frontend_terminal"
        return kind

    def _module_for_path(self, rel: str) -> str:
        cached = self._module_cache.get(rel)
        if cached:
            return cached

        p = rel.lower().replace("\\", "/")
        name = Path(p).name

        if any(token in p for token in ("/happ_", "/happ-", "/happ/", "happ_decryptor")) or "mihomo_hwid" in p:
            module_id = "integration.happ"
        elif (
            "/routes/fs/" in p
            or "/routes/remotefs/" in p
            or "/routes/fileops/" in p
            or "/services/filemanager/" in p
            or "/services/fileops/" in p
            or "/services/fs_common/" in p
            or "/features/file_manager" in p
            or "file_manager.lazy.entry.js" in p
            or "storage_usb" in p
        ):
            module_id = "tool.files"
        elif (
            "terminal.lazy.entry.js" in p
            or "/static/js/terminal/" in p
            or "terminal_debug" in p
            or "ws_pty" in p
            or name in {"commands.py", "command_jobs.py", "xkeen_commands_catalog.py"}
            or "commands_list" in p
        ):
            module_id = "tool.terminal"
        elif (
            name == "backups.py"
            or "/features/backups" in p
            or "/templates/backups.html" in p
            or "/pages/backups." in p
            or "xray_backups.py" in p
            or "mihomo_backups.py" in p
        ):
            module_id = "tool.backups"
        elif (
            "/routes/devtools.py" in p
            or "/services/devtools/" in p
            or "/features/devtools" in p
            or "/templates/devtools.html" in p
            or "/pages/devtools." in p
            or "resource_monitor" in p
            or "router_diagnostics" in p
            or "system_resources" in p
        ):
            module_id = "tool.advanced-diagnostics"
        elif self._is_editor_path(p):
            module_id = "tool.editor"
        elif self._is_mihomo_path(p):
            module_id = "engine.mihomo"
        elif self._is_xray_path(p):
            module_id = "engine.xray"
        else:
            module_id = "core"

        self._module_cache[rel] = module_id
        return module_id

    @staticmethod
    def _is_editor_path(p: str) -> bool:
        name = Path(p).name
        if "/static/schemas/" in p:
            return False
        editor_names = {
            "codemirror6_boot.js",
            "config_dirty_state.js",
            "config_shell.js",
            "confirm_modal.js",
            "dat_contents_modal.js",
            "diff_engine.js",
            "diff_modal.js",
            "editor_actions.js",
            "editor_engine.js",
            "editor_links.js",
            "editor_schema.js",
            "editor_toolbar.js",
            "formatters.js",
            "json_editor_modal.js",
            "monaco_loader.js",
            "monaco_shared.js",
            "prettier_loader.js",
            "schema_diagnostic_format.js",
            "schema_quickfixes.js",
            "schema_semantic_validation.js",
            "schema_snippets.js",
            "yaml_schema.js",
        }
        return (
            name in editor_names
            or "/pages/editor" in p
            or "/pages/codemirror" in p
            or "/static/vendor/npm/@codemirror/" in p
        )

    @staticmethod
    def _is_mihomo_path(p: str) -> bool:
        if "/static/schemas/mihomo-" in p:
            return True
        if "mihomo" not in p:
            return False
        exclusions = (
            "README-mihomo",
            "xray_subscriptions.py",
            "dns_guard.py",
            "dns_service_lifecycle.py",
            "app_factory.py",
            "capabilities.py",
            "pages.py",
            "context.py",
            "run_server.py",
        )
        return not any(exclusion.lower() in p for exclusion in exclusions)

    @staticmethod
    def _is_xray_path(p: str) -> bool:
        if "/static/schemas/xray-" in p:
            return True
        xray_tokens = (
            "/routes/routing/",
            "/services/routing/",
            "/services/geodat/",
            "/features/routing",
            "/features/inbounds",
            "/features/outbounds",
            "/features/xray_",
            "xray",
            "dns_over_vless",
            "/opt/etc/xray/",
        )
        return any(token in p for token in xray_tokens)

    def _build_frontend_bundle_map(self) -> dict[str, list[str]]:
        bundle_map: dict[str, list[str]] = defaultdict(list)
        for bundle_name, rel in FRONTEND_ROOTS.items():
            root_path = self.project_root / rel
            if not root_path.is_file():
                continue
            for path in self._collect_static_js_graph(root_path):
                repo_rel = path.relative_to(self.root).as_posix()
                bundle_map[repo_rel].append(bundle_name)
        return {key: sorted(value) for key, value in sorted(bundle_map.items())}

    def _collect_static_js_graph(self, root_path: Path) -> list[Path]:
        seen: set[Path] = set()
        ordered: list[Path] = []

        def visit(path: Path) -> None:
            resolved = path.resolve()
            if resolved in seen or not resolved.is_file():
                return
            seen.add(resolved)
            ordered.append(resolved)
            text = self._read_text(resolved)
            for spec in self._js_import_specs(text):
                dependency = self._resolve_js_import(resolved, spec)
                if dependency is not None:
                    visit(dependency)

        visit(root_path)
        return ordered

    @staticmethod
    def _resolve_js_import(source: Path, spec: str) -> Path | None:
        cleaned = spec.split("?", 1)[0].split("#", 1)[0]
        if not cleaned.startswith("."):
            return None
        candidate = (source.parent / cleaned).resolve()
        candidates = (candidate, candidate.with_suffix(".js"), candidate / "index.js")
        for item in candidates:
            if item.is_file():
                return item
        return None

    def _extract_python_routes(self, path: Path) -> list[dict[str, str]]:
        try:
            tree = ast.parse(self._read_text(path), filename=str(path))
        except SyntaxError:
            return []

        routes: list[dict[str, str]] = []
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for decorator in node.decorator_list:
                if not isinstance(decorator, ast.Call) or not isinstance(decorator.func, ast.Attribute):
                    continue
                method = decorator.func.attr.lower()
                if not PY_ROUTE_DECORATOR_RE.match(method):
                    continue
                route_path = self._literal_string(decorator.args[0]) if decorator.args else None
                if route_path is None:
                    continue
                if method == "route":
                    methods = self._keyword_string_list(decorator, "methods") or ["ANY"]
                else:
                    methods = [method.upper()]
                for item in methods:
                    routes.append(
                        {
                            "method": item.upper(),
                            "path": route_path,
                            "decorator": f"{self._expr_name(decorator.func.value)}.{method}",
                        }
                    )
        return routes

    @staticmethod
    def _literal_string(node: ast.AST) -> str | None:
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return node.value
        return None

    def _keyword_string_list(self, call: ast.Call, name: str) -> list[str]:
        for keyword in call.keywords:
            if keyword.arg != name:
                continue
            value = keyword.value
            if isinstance(value, (ast.List, ast.Tuple, ast.Set)):
                return [
                    item
                    for element in value.elts
                    if (item := self._literal_string(element)) is not None
                ]
        return []

    @staticmethod
    def _expr_name(node: ast.AST) -> str:
        if isinstance(node, ast.Name):
            return node.id
        if isinstance(node, ast.Attribute):
            return f"{ModularPanelInventoryGenerator._expr_name(node.value)}.{node.attr}".strip(".")
        return ""

    def _background_markers(self, rel: str, text: str) -> list[str]:
        markers: list[str] = []
        patterns = {
            "threading.Thread": r"\bthreading\.Thread\s*\(",
            "Thread": r"(?<![\w.])Thread\s*\(",
            "daemon_thread": r"\bdaemon\s*=\s*True\b",
            "start_subscription_scheduler": r"\bstart_(?:mihomo_)?subscription_scheduler\s*\(",
            "start_dns_guard": r"\bstart_dns_guard\s*\(",
            "start_memory_guard": r"\bstart_memory_guard\s*\(",
            "start_pty_cleanup_loop": r"\bstart_pty_cleanup_loop\s*\(",
            "gevent_spawn": r"\b(?:gevent\.spawn|_gspawn)\s*\(",
        }
        for label, pattern in patterns.items():
            if re.search(pattern, text):
                markers.append(label)
        if rel.endswith("services/mihomo_traffic_analytics.py") and "self._thread.start()" in text:
            markers.append("mihomo_traffic_sampler")
        if rel.endswith("services/mihomo_clash_telemetry.py") and "idle_thread.start()" in text:
            markers.append("mihomo_clash_telemetry_workers")
        return sorted(set(markers))

    def _detect_direct_module_dependencies(
        self,
        path: Path,
        rel: str,
        text: str,
        module_id: str,
    ) -> list[str]:
        dependencies: list[str] = []
        if path.suffix == ".py":
            dependencies.extend(self._python_import_modules(path, text))
        elif path.suffix == ".js":
            for spec in self._js_import_specs(text):
                imported = self._resolve_js_import(path, spec)
                if imported is None or not imported.is_relative_to(self.root):
                    continue
                dependencies.append(self._module_for_path(imported.relative_to(self.root).as_posix()))

        return [
            value
            for value in _ordered_unique(dependencies)
            if value != module_id and value in MODULE_SPECS
        ]

    @staticmethod
    def _js_import_specs(text: str) -> list[str]:
        return _ordered_unique(
            [
                *STATIC_IMPORT_RE.findall(text),
                *DYNAMIC_IMPORT_RE.findall(text),
                *re.findall(r"""(?m)^\s*['"]([^'"]+\.js(?:\?[^'"]*)?)['"]\s*,?\s*$""", text),
            ]
        )

    def _python_import_modules(self, path: Path, text: str) -> list[str]:
        try:
            tree = ast.parse(text, filename=str(path))
        except SyntaxError:
            return []
        result: list[str] = []
        for node in ast.walk(tree):
            names: list[str] = []
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                base = self._resolve_python_from_import(path, node)
                if base:
                    names = [base]
            for name in names:
                target = self._python_module_path(name)
                if target is None:
                    continue
                result.append(self._module_for_path(target.relative_to(self.root).as_posix()))
        return result

    def _resolve_python_from_import(self, source: Path, node: ast.ImportFrom) -> str:
        if node.level <= 0:
            return node.module or ""
        package_dir = source.parent
        for _ in range(max(0, node.level - 1)):
            package_dir = package_dir.parent
        try:
            prefix = package_dir.relative_to(self.project_root).as_posix().replace("/", ".")
        except ValueError:
            return node.module or ""
        return ".".join(filter(None, (prefix, node.module or "")))

    def _python_module_path(self, module_name: str) -> Path | None:
        top = module_name.split(".", 1)[0]
        if top not in {"routes", "services", "core", "middleware", "utils"}:
            if module_name not in {
                "app",
                "app_factory",
                "bootstrap_mihomo_env",
                "mihomo_config_generator",
                "mihomo_server_core",
                "xkeen_mihomo_service",
            }:
                return None
        base = self.project_root / module_name.replace(".", "/")
        candidates = (base.with_suffix(".py"), base / "__init__.py")
        for candidate in candidates:
            if candidate.is_file():
                return candidate
        return None

    def _build_route_inventory(self, units: list[dict[str, Any]]) -> dict[str, Any]:
        endpoint_units = [
            {
                "module_id": unit["module_id"],
                "path": unit["path"],
                "routes": unit["routes"],
            }
            for unit in units
            if unit["registers_routes"]
        ]
        endpoint_count = sum(len(item["routes"]) for item in endpoint_units)
        registration_points = self._build_registration_points()
        return {
            "endpoint_count": endpoint_count,
            "files_with_routes": len(endpoint_units),
            "endpoint_files": endpoint_units,
            "registration_points": registration_points,
        }

    def _build_registration_points(self) -> list[dict[str, Any]]:
        points: list[dict[str, Any]] = []
        route_init = self.project_root / "routes/__init__.py"
        text = self._read_text(route_init)
        imported_factories: dict[str, str] = {}
        try:
            tree = ast.parse(text, filename=str(route_init))
        except SyntaxError:
            tree = None
        if tree is not None:
            for node in ast.walk(tree):
                if isinstance(node, ast.ImportFrom) and node.module:
                    module_name = f"routes.{node.module.lstrip('.')}" if node.level else node.module
                    for alias in node.names:
                        if alias.name.startswith("create_") and alias.name.endswith("_blueprint"):
                            imported_factories[alias.asname or alias.name] = module_name
        for factory in sorted(set(re.findall(r"\b(create_[a-z0-9_]+_blueprint)\s*\(", text))):
            module_name = imported_factories.get(factory, "")
            module_path = self._python_module_path(module_name) if module_name else None
            module_id = (
                self._module_for_path(module_path.relative_to(self.root).as_posix())
                if module_path is not None
                else self._module_for_factory_name(factory)
            )
            points.append(
                {
                    "factory": factory,
                    "module_id": module_id,
                    "registered_from": "xkeen-ui/routes/__init__.py",
                    "current_gate": self._registration_gate(factory),
                }
            )

        points.extend(
            [
                {
                    "factory": "register_ui_assets_routes",
                    "module_id": "core",
                    "registered_from": "xkeen-ui/app_factory.py",
                    "current_gate": "always",
                },
                {
                    "factory": "register_auth_routes",
                    "module_id": "core",
                    "registered_from": "xkeen-ui/app_factory.py",
                    "current_gate": "always",
                },
                {
                    "factory": "register_mobile_routes",
                    "module_id": "engine.xray",
                    "registered_from": "xkeen-ui/app_factory.py",
                    "current_gate": "always",
                },
                {
                    "factory": "register_pages_routes",
                    "module_id": "core",
                    "registered_from": "xkeen-ui/app_factory.py",
                    "current_gate": "always",
                },
            ]
        )
        return sorted(points, key=lambda item: (item["module_id"], item["factory"]))

    def _module_for_factory_name(self, factory: str) -> str:
        return self._module_for_path(f"xkeen-ui/routes/{factory}.py")

    @staticmethod
    def _registration_gate(factory: str) -> str:
        if factory == "create_remotefs_blueprint":
            return "capability: remoteFs.enabled"
        if factory in {"create_fs_blueprint", "create_fileops_blueprint"}:
            return "try/except only"
        return "always"

    def _build_background_task_inventory(self) -> list[dict[str, Any]]:
        tasks = [
            {
                "id": "core.network_executor",
                "module_id": "core",
                "path": "xkeen-ui/services/net.py",
                "launcher": "ThreadPoolExecutor(NET_EXECUTOR)",
                "current_gate": "executor exists at import; workers start on submitted network work",
            },
            {
                "id": "core.github_index_fetch",
                "module_id": "core",
                "path": "xkeen-ui/services/config_exchange_github.py",
                "launcher": "NET_EXECUTOR.submit(_github_fetch_index_items)",
                "current_gate": "on config catalog request",
            },
            {
                "id": "core.memory_guard",
                "module_id": "core",
                "path": "xkeen-ui/run_server.py",
                "launcher": "start_memory_guard",
                "current_gate": "always after server start",
            },
            {
                "id": "terminal.pty_cleanup",
                "module_id": "tool.terminal",
                "path": "xkeen-ui/run_server.py",
                "launcher": "start_pty_cleanup_loop",
                "current_gate": "GEVENT_AVAILABLE",
            },
            {
                "id": "xray.subscription_scheduler",
                "module_id": "engine.xray",
                "path": "xkeen-ui/app_factory.py",
                "launcher": "services.xray_subscriptions.start_subscription_scheduler",
                "current_gate": "always; failure is non-fatal",
            },
            {
                "id": "xray.latency_jobs",
                "module_id": "engine.xray",
                "path": "xkeen-ui/services/latency_jobs.py",
                "launcher": "ThreadPoolExecutor(_EXECUTOR)",
                "current_gate": "on Xray latency/probe request",
            },
            {
                "id": "mihomo.subscription_scheduler",
                "module_id": "engine.mihomo",
                "path": "xkeen-ui/app_factory.py",
                "launcher": "services.mihomo_subscriptions.start_subscription_scheduler",
                "current_gate": "always; failure is non-fatal",
            },
            {
                "id": "dns.shared_guard",
                "module_id": "engine.xray",
                "path": "xkeen-ui/app_factory.py",
                "launcher": "services.dns_guard.start_guard",
                "current_gate": "always; coordinates Xray and Mihomo; failure is non-fatal",
            },
            {
                "id": "commands.background_jobs",
                "module_id": "tool.terminal",
                "path": "xkeen-ui/services/command_jobs.py",
                "launcher": "threading.Thread(_run_command_job)",
                "current_gate": "on command request",
            },
            {
                "id": "cores.background_refresh",
                "module_id": "core",
                "path": "xkeen-ui/routes/cores_status.py",
                "launcher": "threading.Thread(_refresh_cache_in_background)",
                "current_gate": "on stale cache request",
            },
            {
                "id": "mihomo.clash_telemetry_workers",
                "module_id": "engine.mihomo",
                "path": "xkeen-ui/services/mihomo_clash_telemetry.py",
                "launcher": "TelemetryManager worker threads",
                "current_gate": "on telemetry subscription",
            },
            {
                "id": "mihomo.clash_parallel_snapshot",
                "module_id": "engine.mihomo",
                "path": "xkeen-ui/routes/mihomo_clash.py",
                "launcher": "ThreadPoolExecutor for parallel controller requests",
                "current_gate": "inside selected Clash API requests",
            },
            {
                "id": "mihomo.traffic_sampler",
                "module_id": "engine.mihomo",
                "path": "xkeen-ui/services/mihomo_traffic_analytics.py",
                "launcher": "TrafficAnalyticsSampler thread",
                "current_gate": "when traffic analytics is started",
            },
            {
                "id": "files.worker_queue",
                "module_id": "tool.files",
                "path": "xkeen-ui/services/fileops/workers.py",
                "launcher": "file operation worker threads",
                "current_gate": "when file operations runtime is used",
            },
        ]
        return tasks

    def _build_ui_surface_inventory(self) -> dict[str, Any]:
        panel_path = self.project_root / "templates/panel.html"
        panel_text = self._read_text(panel_path)
        views = []
        for view in _ordered_unique(TOP_VIEW_RE.findall(panel_text)):
            views.append(
                {
                    "id": view,
                    "module_id": self._module_for_surface_id(view),
                    "template": "xkeen-ui/templates/panel.html",
                }
            )

        modals = []
        parser = _PanelSurfaceParser()
        parser.feed(panel_text)
        for modal_id in _ordered_unique(parser.modal_ids):
            modals.append(
                {
                    "id": modal_id,
                    "module_id": self._module_for_surface_id(modal_id),
                    "template": "xkeen-ui/templates/panel.html",
                }
            )

        pages = [
            {
                "id": "panel",
                "route": "/",
                "module_id": "core",
                "template": "xkeen-ui/templates/panel.html",
                "entry": "xkeen-ui/static/js/pages/panel.entry.js",
            },
            {
                "id": "backups",
                "route": "/backups",
                "module_id": "tool.backups",
                "template": "xkeen-ui/templates/backups.html",
                "entry": "xkeen-ui/static/js/pages/backups.entry.js",
            },
            {
                "id": "devtools",
                "route": "/devtools",
                "module_id": "tool.advanced-diagnostics",
                "template": "xkeen-ui/templates/devtools.html",
                "entry": "xkeen-ui/static/js/pages/devtools.entry.js",
            },
            {
                "id": "xkeen",
                "route": "/xkeen",
                "module_id": "core",
                "template": "xkeen-ui/templates/xkeen.html",
                "entry": "xkeen-ui/static/js/pages/xkeen.entry.js",
            },
            {
                "id": "mihomo_generator",
                "route": "/mihomo_generator",
                "module_id": "engine.mihomo",
                "template": "xkeen-ui/templates/mihomo_generator.html",
                "entry": "xkeen-ui/static/js/pages/mihomo_generator.entry.js",
            },
        ]
        return {"pages": pages, "panel_views": views, "panel_modals": modals}

    def _module_for_surface_id(self, surface_id: str) -> str:
        value = surface_id.lower()
        if "happ" in value or "hwid" in value:
            return "integration.happ"
        if "mihomo" in value or "clash" in value:
            return "engine.mihomo"
        if any(token in value for token in ("file", "storage", "remote-fs", "usb")):
            return "tool.files"
        if any(token in value for token in ("terminal", "command")):
            return "tool.terminal"
        if "backup" in value or "restore" in value:
            return "tool.backups"
        if any(token in value for token in ("editor", "diff", "schema", "prettier", "monaco")):
            return "tool.editor"
        if any(token in value for token in ("devtool", "diagnostic", "resource")):
            return "tool.advanced-diagnostics"
        if any(
            token in value
            for token in (
                "routing",
                "inbound",
                "outbound",
                "xray",
                "dat-contents",
                "geodat",
                "balancer",
                "dns-over-vless",
            )
        ):
            return "engine.xray"
        return "core"

    def _build_coupling_inventory(self, units: list[dict[str, Any]]) -> dict[str, Any]:
        edges: Counter[tuple[str, str]] = Counter()
        examples: dict[tuple[str, str], list[str]] = defaultdict(list)
        for unit in units:
            source = unit["module_id"]
            for target in unit["depends_on"]:
                if source == target:
                    continue
                edge = (source, target)
                edges[edge] += 1
                if len(examples[edge]) < 8:
                    examples[edge].append(unit["path"])

        serialized = [
            {
                "from": source,
                "to": target,
                "unit_count": count,
                "examples": examples[(source, target)],
            }
            for (source, target), count in sorted(edges.items())
        ]
        core_to_optional = [
            edge for edge in serialized if edge["from"] == "core" and edge["to"] != "core"
        ]
        runtime_units = [
            unit
            for unit in units
            if unit["kind"] not in {"backend_test", "frontend_test"}
        ]
        runtime_edges: Counter[tuple[str, str]] = Counter()
        runtime_examples: dict[tuple[str, str], list[str]] = defaultdict(list)
        for unit in runtime_units:
            source = unit["module_id"]
            for target in unit["depends_on"]:
                if source == target:
                    continue
                edge = (source, target)
                runtime_edges[edge] += 1
                if len(runtime_examples[edge]) < 8:
                    runtime_examples[edge].append(unit["path"])
        runtime_serialized = [
            {
                "from": source,
                "to": target,
                "unit_count": count,
                "examples": runtime_examples[(source, target)],
            }
            for (source, target), count in sorted(runtime_edges.items())
        ]
        return {
            "edges": serialized,
            "runtime_edges": runtime_serialized,
            "core_to_optional_edges": [
                edge
                for edge in runtime_serialized
                if edge["from"] == "core" and edge["to"] != "core"
            ],
            "all_core_to_optional_edges_including_tests": core_to_optional,
        }

    def _build_module_inventory(
        self,
        units: list[dict[str, Any]],
        routes: dict[str, Any],
        background_tasks: list[dict[str, Any]],
        ui_surfaces: dict[str, Any],
    ) -> list[dict[str, Any]]:
        units_by_module: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for unit in units:
            units_by_module[unit["module_id"]].append(unit)

        route_count_by_module: Counter[str] = Counter()
        for item in routes["endpoint_files"]:
            route_count_by_module[item["module_id"]] += len(item["routes"])

        task_count_by_module = Counter(item["module_id"] for item in background_tasks)
        surface_count_by_module: Counter[str] = Counter()
        for group in ui_surfaces.values():
            for item in group:
                surface_count_by_module[item["module_id"]] += 1

        result = []
        for module_id in MODULE_ORDER:
            spec = MODULE_SPECS[module_id]
            module_units = units_by_module[module_id]
            kind_counts = Counter(unit["kind"] for unit in module_units)
            result.append(
                {
                    "id": module_id,
                    **spec,
                    "unit_count": len(module_units),
                    "size_bytes": sum(unit["size_bytes"] for unit in module_units),
                    "kind_counts": dict(sorted(kind_counts.items())),
                    "route_count": route_count_by_module[module_id],
                    "background_task_count": task_count_by_module[module_id],
                    "ui_surface_count": surface_count_by_module[module_id],
                    "representative_paths": [unit["path"] for unit in module_units[:12]],
                }
            )
        return result

    def _serialize_frontend_bundles(self) -> list[dict[str, Any]]:
        result = []
        for name, root in FRONTEND_ROOTS.items():
            files = sorted(path for path, bundles in self._frontend_bundle_map.items() if name in bundles)
            modules = sorted({self._module_for_path(path) for path in files})
            result.append(
                {
                    "id": name,
                    "root": f"xkeen-ui/{root}",
                    "file_count": len(files),
                    "module_ids": modules,
                    "files": files,
                }
            )
        return result

    def _build_findings(
        self,
        modules: list[dict[str, Any]],
        routes: dict[str, Any],
        background_tasks: list[dict[str, Any]],
        coupling: dict[str, Any],
        ui_surfaces: dict[str, Any],
    ) -> list[dict[str, Any]]:
        module_by_id = {item["id"]: item for item in modules}
        return [
            {
                "id": "all-blueprints-mostly-eager",
                "severity": "high",
                "summary": "Большинство Blueprint регистрируется без пользовательских module gates.",
                "evidence": {
                    "registration_points": len(routes["registration_points"]),
                    "non_always_gates": [
                        item
                        for item in routes["registration_points"]
                        if item["current_gate"] != "always"
                    ],
                },
                "next_stage": "Этап 1/3: registry и backend gates.",
            },
            {
                "id": "mihomo-startup-is-eager",
                "severity": "high",
                "summary": "Mihomo scheduler запускается из app_factory независимо от выбранного пользовательского профиля.",
                "evidence": [
                    item for item in background_tasks if item["id"] == "mihomo.subscription_scheduler"
                ],
                "next_stage": "Этап 3: запускать только при enabled engine.mihomo.",
            },
            {
                "id": "panel-template-is-monolithic",
                "severity": "high",
                "summary": "Главный panel.html одновременно владеет surface всех будущих модулей.",
                "evidence": {
                    "template": "xkeen-ui/templates/panel.html",
                    "panel_views": len(ui_surfaces["panel_views"]),
                    "panel_modals": len(ui_surfaces["panel_modals"]),
                    "size_bytes": (self.project_root / "templates/panel.html").stat().st_size,
                },
                "next_stage": "Этап 4: template partials и module composition.",
            },
            {
                "id": "core-couples-to-optional-modules",
                "severity": "high",
                "summary": "Core сейчас импортирует код будущих отключаемых модулей.",
                "evidence": coupling["core_to_optional_edges"],
                "next_stage": "Этап 1/3: заменить прямые связи registry hooks.",
            },
            {
                "id": "frontend-split-is-useful-baseline",
                "severity": "positive",
                "summary": "Routing, Mihomo, terminal и file manager уже имеют отдельные ESM roots.",
                "evidence": list(FRONTEND_ROOTS),
                "next_stage": "Этап 5: привязать import() к enabled modules.",
            },
            {
                "id": "optional-tools-have-large-owned-scope",
                "severity": "medium",
                "summary": "Terminal, files, editor и diagnostics можно отделять независимо от engine-профиля.",
                "evidence": {
                    module_id: {
                        "unit_count": module_by_id[module_id]["unit_count"],
                        "size_bytes": module_by_id[module_id]["size_bytes"],
                    }
                    for module_id in (
                        "tool.editor",
                        "tool.terminal",
                        "tool.files",
                        "tool.advanced-diagnostics",
                    )
                },
                "next_stage": "Этапы 1, 4 и 6.",
            },
        ]

    def render_markdown(self, payload: dict[str, Any]) -> str:
        lines = [
            "# Этап 0. Инвентаризация модульной панели Xkeen UI",
            "",
            f"Статус: **Этап 0 закрыт {self._format_ru_date(STAGE_CLOSED_ON)}**.",
            "",
            "Машинно-читаемый источник истины:",
            "",
            "- `docs/modular-panel-stage0-inventory.json`",
            "",
            "Генератор:",
            "",
            "- `scripts/generate_modular_panel_inventory.py`",
            "",
            "Пересборка:",
            "",
            "```powershell",
            "python .\\scripts\\generate_modular_panel_inventory.py --root .",
            "```",
            "",
            "## Границы Stage 0",
            "",
            "Опись фиксирует текущее состояние, но пока не включает/выключает модули. "
            "Каталог будущих модулей ограничен официальным репозиторием `umarcheh001/Xkeen-UI`; "
            "произвольные внешние плагины в scope не входят.",
            "",
            "Для каждой учтённой единицы JSON хранит обязательные поля:",
            "",
            "- `module_id`;",
            "- `kind`;",
            "- `path`;",
            "- `depends_on`;",
            "- `starts_background_task`;",
            "- `registers_routes`;",
            "- `frontend_bundle`;",
            "- `system_requirements`;",
            "- `removable`.",
            "",
            "## Сводка модулей",
            "",
            "| Module ID | Единиц | Размер | Routes | Background | UI surfaces | Removable |",
            "|---|---:|---:|---:|---:|---:|---|",
        ]
        for module in payload["modules"]:
            lines.append(
                f"| `{module['id']}` | {module['unit_count']} | "
                f"{self._format_bytes(module['size_bytes'])} | {module['route_count']} | "
                f"{module['background_task_count']} | {module['ui_surface_count']} | "
                f"{'да' if module['removable'] else 'нет'} |"
            )

        routes = payload["routes"]
        lines.extend(
            [
                "",
                "## Backend routes и регистрация",
                "",
                f"- Endpoint declarations: **{routes['endpoint_count']}**.",
                f"- Файлов с route decorators/WS dispatch: **{routes['files_with_routes']}**.",
                f"- Точек регистрации: **{len(routes['registration_points'])}**.",
                "",
                "Текущее исключение — RemoteFS регистрируется по capability. "
                "FS/FileOps защищены `try/except`, но это ещё не пользовательские module gates. "
                "Xray, Mihomo, terminal-related и большая часть tool routes сейчас подключаются eagerly.",
                "",
                "## Фоновые задачи",
                "",
                "| ID | Module | Launcher | Текущий gate |",
                "|---|---|---|---|",
            ]
        )
        for task in payload["background_tasks"]:
            lines.append(
                f"| `{task['id']}` | `{task['module_id']}` | `{task['launcher']}` | {task['current_gate']} |"
            )

        surfaces = payload["ui_surfaces"]
        lines.extend(
            [
                "",
                "## Frontend и UI surfaces",
                "",
                f"- Canonical/top-level страниц: **{len(surfaces['pages'])}**.",
                f"- Вкладок `data-view` в `panel.html`: **{len(surfaces['panel_views'])}**.",
                f"- Статических modal containers в `panel.html`: **{len(surfaces['panel_modals'])}**.",
                f"- Нормализованный UTF-8 размер `panel.html`: "
                f"**{self._format_bytes(len(self._read_text(self.project_root / 'templates/panel.html').encode('utf-8')))}**.",
                "",
                "Уже существующие границы, пригодные для модульной загрузки:",
                "",
            ]
        )
        for bundle in payload["frontend_bundles"]:
            modules = ", ".join(f"`{item}`" for item in bundle["module_ids"])
            lines.append(
                f"- `{bundle['id']}` → `{bundle['root']}`; файлов: {bundle['file_count']}; modules: {modules}."
            )

        lines.extend(
            [
                "",
                "## Обнаруженные архитектурные связи",
                "",
                "| From | To | Units | Примеры |",
                "|---|---|---:|---|",
            ]
        )
        for edge in payload["coupling"]["edges"]:
            examples = "<br>".join(f"`{item}`" for item in edge["examples"][:3])
            lines.append(
                f"| `{edge['from']}` | `{edge['to']}` | {edge['unit_count']} | {examples} |"
            )

        lines.extend(["", "## Ключевые выводы", ""])
        for finding in payload["findings"]:
            lines.extend(
                [
                    f"### `{finding['id']}`",
                    "",
                    finding["summary"],
                    "",
                    f"Следующий шаг: {finding['next_stage']}",
                    "",
                ]
            )

        lines.extend(
            [
                "## Решения о границах модулей",
                "",
                "- `core` остаётся единственным неудаляемым модулем.",
                "- `engine.xray` и `engine.mihomo` независимы на уровне профиля, но текущий код ещё содержит прямые связи.",
                "- `tool.editor`, `tool.terminal`, `tool.files`, `tool.backups` и `tool.advanced-diagnostics` считаются отдельными отключаемыми областями.",
                "- Happ вынесен в `integration.happ`, хотя сейчас часть UI и API находится внутри Mihomo flows.",
                "- Общий DNS guard отмечен как Xray-owned mixed boundary; до Stage 3 его нужно разделить или превратить в registry hook без зависимости core от engine.",
                "",
                "## Критерий завершения",
                "",
                "Критерий завершения **выполнен**:",
                "",
                "- routes/Blueprint нанесены на карту;",
                "- services и background tasks нанесены на карту;",
                "- frontend entrypoints/bundles/features нанесены на карту;",
                "- templates, panel views и modals нанесены на карту;",
                "- CSS, editor schemas, tests и configuration assets включены в unit inventory;",
                "- для каждой учтённой единицы определён будущий `module_id`;",
                "- выявлены current gates и cross-module coupling;",
                "- snapshot защищён тестом на синхронность с генератором.",
                "",
                "Следующий этап: **Этап 1 — базовый Module Registry**.",
                "",
            ]
        )
        return "\n".join(lines)

    @staticmethod
    def _format_bytes(value: int) -> str:
        if value >= 1024 * 1024:
            return f"{value / (1024 * 1024):.2f} МБ"
        if value >= 1024:
            return f"{value / 1024:.1f} КБ"
        return f"{value} Б"

    @staticmethod
    def _format_ru_date(value: str) -> str:
        year, month, day = value.split("-")
        months = {
            "01": "января",
            "02": "февраля",
            "03": "марта",
            "04": "апреля",
            "05": "мая",
            "06": "июня",
            "07": "июля",
            "08": "августа",
            "09": "сентября",
            "10": "октября",
            "11": "ноября",
            "12": "декабря",
        }
        return f"{int(day)} {months[month]} {year} года"

    @staticmethod
    def _read_text(path: Path) -> str:
        try:
            return path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            return path.read_text(encoding="utf-8", errors="replace")

    @staticmethod
    def _dedupe_dicts(
        values: Iterable[dict[str, str]],
        *,
        keys: tuple[str, ...],
    ) -> list[dict[str, str]]:
        seen: set[tuple[str, ...]] = set()
        result: list[dict[str, str]] = []
        for value in values:
            marker = tuple(value.get(key, "") for key in keys)
            if marker in seen:
                continue
            seen.add(marker)
            result.append(value)
        return sorted(result, key=lambda item: tuple(item.get(key, "") for key in keys))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate Stage 0 modular-panel inventory and human-readable contract."
    )
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--json-out", type=Path, default=None)
    parser.add_argument("--markdown-out", type=Path, default=None)
    parser.add_argument("--stdout", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    generator = ModularPanelInventoryGenerator(args.root)
    payload = generator.build_inventory()
    rendered_json = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    rendered_markdown = generator.render_markdown(payload)

    json_out = args.json_out or (generator.docs_root / "modular-panel-stage0-inventory.json")
    markdown_out = args.markdown_out or (generator.docs_root / "modular-panel-stage0-inventory.md")
    json_out.parent.mkdir(parents=True, exist_ok=True)
    markdown_out.parent.mkdir(parents=True, exist_ok=True)
    json_out.write_text(rendered_json, encoding="utf-8", newline="\n")
    markdown_out.write_text(rendered_markdown, encoding="utf-8", newline="\n")

    if args.stdout:
        print(rendered_json, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
