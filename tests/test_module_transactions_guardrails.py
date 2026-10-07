"""The module runner has to work when the panel itself does not start."""

from __future__ import annotations

import ast
import importlib.util
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PANEL = ROOT / "xkeen-ui"
ENGINE_FILES = sorted((PANEL / "services" / "module_transactions").glob("*.py")) + [PANEL / "scripts" / "module_transaction.py"]
FORBIDDEN_ROOTS = {"flask", "werkzeug", "gevent", "routes", "app", "app_factory", "run_server"}


def test_engine_files_exist() -> None:
    names = {path.name for path in ENGINE_FILES}

    assert {"state.py", "plan.py", "extract.py", "journal.py", "install_state.py", "executor.py", "launcher.py",
            "module_transaction.py"} <= names


def test_engine_does_not_import_flask_or_routes() -> None:
    offenders = []
    for path in ENGINE_FILES:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            names = []
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom) and node.level == 0:
                names = [node.module or ""]
            offenders += [(path.name, name) for name in names if name.split(".")[0] in FORBIDDEN_ROOTS]

    assert offenders == []


def test_engine_loads_without_pulling_the_web_stack_in() -> None:
    probe = (
        "import sys; sys.path.insert(0, sys.argv[1]);"
        "import services.module_transactions.executor, services.module_transactions.launcher;"
        "import importlib.util as u;"
        "s = u.spec_from_file_location('module_transaction', sys.argv[2]); m = u.module_from_spec(s); s.loader.exec_module(m);"
        "bad = sorted(n for n in sys.modules if n.split('.')[0] in ('flask', 'werkzeug', 'gevent', 'routes', 'app_factory'));"
        "print(bad); raise SystemExit(1 if bad else 0)"
    )

    done = subprocess.run(
        [sys.executable, "-c", probe, str(PANEL), str(PANEL / "scripts" / "module_transaction.py")],
        capture_output=True, text=True, timeout=120,
    )

    assert done.returncode == 0, done.stdout + done.stderr


def test_shipped_cli_has_no_test_hooks() -> None:
    source = (PANEL / "scripts" / "module_transaction.py").read_text(encoding="utf-8").lower()

    for marker in ("keyring", "release-dir", "release_dir", "fail-at", "fail_at", "testing"):
        assert marker not in source, marker


def test_engine_files_belong_to_core_for_the_profile_installer() -> None:
    spec = importlib.util.spec_from_file_location("module_profile_install", PANEL / "scripts" / "module_profile_install.py")
    installer = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = installer
    spec.loader.exec_module(installer)

    for path in ENGINE_FILES:
        relative = path.relative_to(PANEL).as_posix()
        assert installer.owner(relative) == "core", relative
    assert installer.owner("module-ownership.json") == "core"


def test_engine_files_belong_to_the_core_package(panel_source_root: Path) -> None:
    spec = importlib.util.spec_from_file_location("build_modular_panel_release", ROOT / "scripts" / "build_modular_panel_release.py")
    builder = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = builder
    spec.loader.exec_module(builder)

    core = set(builder.build_module_ownership(panel_source_root)["core"])

    for path in ENGINE_FILES:
        assert path.relative_to(PANEL).as_posix() in core
    for dependency in ("services/module_catalog_client.py", "services/module_catalog_trust.py",
                       "services/module_package_contract.py", "services/self_update/state.py", "services/io/atomic.py",
                       "routes/devtools.py"):
        assert dependency in core, dependency
