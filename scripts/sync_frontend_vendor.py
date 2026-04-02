from __future__ import annotations

import json
import re
import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PROJECT_ROOT = ROOT / "xkeen-ui"
NODE_MODULES = ROOT / "node_modules"
VENDOR_ROOT = PROJECT_ROOT / "static" / "vendor"
IMPORTMAP_TEMPLATE = PROJECT_ROOT / "templates" / "_codemirror6_importmap.html"

IMPORTMAP_VENDOR_RE = re.compile(r"vendor/npm/([^\"']+)")

PRETTIER_FILES = (
    ("standalone.js", "standalone.js"),
    ("plugins/babel.js", "plugins/babel.js"),
    ("plugins/estree.js", "plugins/estree.js"),
    ("plugins/yaml.js", "plugins/yaml.js"),
)

KNOWN_MODULE_EXTENSIONS = (".js", ".mjs", ".cjs", ".json", ".node")
IMPORT_FROM_RE = re.compile(r'(?P<prefix>\bfrom\s*["\'])(?P<spec>\.{1,2}/[^"\']+)(?P<suffix>["\'])')
SIDE_EFFECT_IMPORT_RE = re.compile(r'(?m)^(?P<prefix>\s*import\s*["\'])(?P<spec>\.{1,2}/[^"\']+)(?P<suffix>["\'])')
DYNAMIC_IMPORT_RE = re.compile(r'(?P<prefix>\bimport\s*\(\s*["\'])(?P<spec>\.{1,2}/[^"\']+)(?P<suffix>["\']\s*\))')


def fail(message: str) -> None:
    raise SystemExit(message)


def read_importmap_package_roots() -> list[str]:
    if not IMPORTMAP_TEMPLATE.is_file():
        fail(f"missing importmap template: {IMPORTMAP_TEMPLATE}")

    text = IMPORTMAP_TEMPLATE.read_text(encoding="utf-8")
    package_roots: list[str] = []
    seen: set[str] = set()

    for match in IMPORTMAP_VENDOR_RE.finditer(text):
        relpath = match.group(1).strip().lstrip("/")
        if not relpath:
            continue
        parts = [part for part in relpath.split("/") if part]
        if not parts:
            continue
        if parts[0].startswith("@"):
            if len(parts) < 2:
                fail(f"cannot infer scoped package root from importmap path: {relpath}")
            package_root = "/".join(parts[:2])
        else:
            package_root = parts[0]
        if package_root not in seen:
            seen.add(package_root)
            package_roots.append(package_root)

    if not package_roots:
        fail("no vendor/npm package roots found in _codemirror6_importmap.html")

    return package_roots


def ensure_node_modules() -> None:
    if not NODE_MODULES.is_dir():
        fail("node_modules is missing; run 'npm ci' first")


def copy_package_tree(package_root: str, copied: list[dict[str, str]]) -> None:
    source_dir = NODE_MODULES / Path(package_root)
    target_dir = VENDOR_ROOT / "npm" / Path(package_root)
    package_json = source_dir / "package.json"

    if not source_dir.is_dir():
        fail(f"missing npm package directory required for vendor sync: {source_dir}")
    if not package_json.is_file():
        fail(f"missing package.json in npm package directory: {package_json}")

    shutil.copytree(source_dir, target_dir, dirs_exist_ok=True)

    meta = json.loads(package_json.read_text(encoding="utf-8"))
    copied.append(
        {
            "name": str(meta.get("name") or package_root),
            "version": str(meta.get("version") or ""),
        }
    )


def copy_prettier_files() -> dict[str, str]:
    prettier_root = NODE_MODULES / "prettier"
    package_json = prettier_root / "package.json"
    if not package_json.is_file():
        fail(f"missing prettier package required for vendor sync: {package_json}")

    for source_rel, target_rel in PRETTIER_FILES:
        source_path = prettier_root / source_rel
        target_path = VENDOR_ROOT / "prettier" / target_rel
        if not source_path.is_file():
            fail(f"missing prettier asset required for vendor sync: {source_path}")
        target_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_path, target_path)

    meta = json.loads(package_json.read_text(encoding="utf-8"))
    return {
        "name": str(meta.get("name") or "prettier"),
        "version": str(meta.get("version") or ""),
    }


def write_vendor_manifest(packages: list[dict[str, str]], prettier_meta: dict[str, str]) -> None:
    manifest_path = VENDOR_ROOT / "npm" / "manifest.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "generated_from": "scripts/sync_frontend_vendor.py",
        "packages": sorted(packages, key=lambda item: item["name"]),
        "prettier": prettier_meta,
    }
    manifest_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def split_specifier_suffix(specifier: str) -> tuple[str, str]:
    for marker in ("?", "#"):
        index = specifier.find(marker)
        if index != -1:
            return specifier[:index], specifier[index:]
    return specifier, ""


def resolve_browser_safe_specifier(source_file: Path, specifier: str) -> str | None:
    base_specifier, suffix = split_specifier_suffix(specifier)
    if base_specifier.endswith(KNOWN_MODULE_EXTENSIONS):
        return None

    source_dir = source_file.parent
    candidates = (
        base_specifier + ".js",
        base_specifier + ".mjs",
        base_specifier + ".cjs",
        base_specifier + "/index.js",
        base_specifier + "/index.mjs",
        base_specifier + "/index.cjs",
    )

    for candidate in candidates:
        candidate_path = source_dir.joinpath(*candidate.split("/"))
        if candidate_path.is_file():
            return candidate + suffix

    return None


def patch_browser_relative_imports_in_text(source_file: Path, text: str) -> tuple[str, int]:
    replacements = 0

    def replace(match: re.Match[str]) -> str:
        nonlocal replacements
        specifier = match.group("spec")
        replacement = resolve_browser_safe_specifier(source_file, specifier)
        if not replacement or replacement == specifier:
            return match.group(0)
        replacements += 1
        return f"{match.group('prefix')}{replacement}{match.group('suffix')}"

    updated = IMPORT_FROM_RE.sub(replace, text)
    updated = SIDE_EFFECT_IMPORT_RE.sub(replace, updated)
    updated = DYNAMIC_IMPORT_RE.sub(replace, updated)
    return updated, replacements


def patch_browser_relative_imports() -> tuple[int, int]:
    files_changed = 0
    replacements = 0
    for source_file in VENDOR_ROOT.rglob("*"):
        if not source_file.is_file():
            continue
        if source_file.suffix not in {".js", ".mjs"}:
            continue
        original = source_file.read_text(encoding="utf-8")
        updated, file_replacements = patch_browser_relative_imports_in_text(source_file, original)
        if file_replacements <= 0:
            continue
        source_file.write_text(updated, encoding="utf-8")
        files_changed += 1
        replacements += file_replacements
    return files_changed, replacements


def main() -> int:
    ensure_node_modules()

    package_roots = read_importmap_package_roots()
    if VENDOR_ROOT.exists():
        shutil.rmtree(VENDOR_ROOT)

    copied_packages: list[dict[str, str]] = []
    for package_root in package_roots:
        copy_package_tree(package_root, copied_packages)

    prettier_meta = copy_prettier_files()
    files_changed, replacements = patch_browser_relative_imports()
    write_vendor_manifest(copied_packages, prettier_meta)

    print(f"Synced {len(copied_packages)} vendor npm package(s).")
    print(f"Synced Prettier {prettier_meta.get('version') or 'unknown'} runtime assets.")
    print(f"Patched {replacements} browser ESM import(s) across {files_changed} vendor file(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
