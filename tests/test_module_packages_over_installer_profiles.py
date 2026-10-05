"""Пакет модуля обязан работать поверх урезанной установки.

Установщик урезанного профиля ставит ядро и редактор не целиком (лёгкий
редактор без Monaco), а пакет модуля собирается в расчёте на полные пакеты
своих зависимостей. Если файл модуля статически тянет то, чего в урезанной
установке нет, страница доустановленного модуля не загрузится вовсе — и
заметят это только на роутере. Поэтому связь ловится здесь, при сборке.
"""

from __future__ import annotations

import importlib.util
import re
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
PANEL = ROOT / "xkeen-ui"
_TEMPLATE_LINK = re.compile(r"""{%-?\s*(?:include|extends|import|from)\s+['"]([^'"]+)['"]""")

pytestmark = pytest.mark.skipif(
    not (PANEL / "static" / "frontend-build" / ".vite" / "manifest.json").is_file(),
    reason="needs npm run frontend:build",
)


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def graph():
    builder = _load("build_modular_panel_release", ROOT / "scripts" / "build_modular_panel_release.py")
    installer = _load("module_profile_install", PANEL / "scripts" / "module_profile_install.py")
    ownership = builder.build_module_ownership(ROOT)
    owner_of = {path: module for module, paths in ownership.items() for path in paths}
    edges: dict[str, set[str]] = {}
    for source, targets in builder._python_import_edges(PANEL, owner_of).items():
        edges.setdefault(source, set()).update(targets)
    for source, targets in builder._javascript_import_edges(PANEL, owner_of, installer).items():
        edges.setdefault(source, set()).update(targets)
    for relative in owner_of:
        if relative.startswith("templates/") and relative.endswith(".html"):
            markup = (PANEL / relative).read_text(encoding="utf-8")
            targets = {"templates/" + name for name in _TEMPLATE_LINK.findall(markup)}
            edges.setdefault(relative, set()).update(target for target in targets if target in owner_of)
    return installer, ownership, owner_of, edges


@pytest.mark.parametrize("profile", ["xray-minimal", "mihomo-minimal"])
def test_module_package_over_installer_profile_has_no_dangling_static_imports(profile: str, tmp_path: Path, graph) -> None:
    installer, ownership, owner_of, edges = graph
    selected = set(installer.PRESETS[profile])
    target = tmp_path / "panel"
    target.mkdir()
    installer.apply_profile(PANEL, target, profile, transaction_root=tmp_path / "tx")
    installed = {path.relative_to(target).as_posix() for path in target.rglob("*") if path.is_file()}

    dangling: dict[str, list[str]] = {}
    for module, files in ownership.items():
        if module in selected or not files:
            continue
        after = installed | set(files)
        broken = sorted(
            f"{source} -> {link} [{owner_of[link]}]"
            for source in files
            for link in edges.get(source, ())
            if link not in after
        )
        if broken:
            dangling[module] = broken

    assert dangling == {}
