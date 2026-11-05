"""Disposable module state used by the macOS/local panel preview.

The router gets BUILD.json and the install manifests from the installer.  A
checkout launched directly from a developer machine has neither, so the
module screens otherwise cannot render even though all source files are
present.  This helper creates only missing, local state files; it never
downloads anything and never replaces an existing file.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import time
import atexit
from pathlib import Path
from typing import Iterable, MutableMapping

from services.module_registry import MODULE_IDS


_LOCAL_MIHOMO_PROCESS: subprocess.Popen[bytes] | None = None


def enabled() -> bool:
    value = str(os.environ.get("XKEEN_UI_LOCAL_DEMO") or "").strip().lower()
    return value in {"1", "true", "yes", "on"}


def configure_local_core_binaries(
    project_root: str | os.PathLike[str], *, environ: MutableMapping[str, str] | None = None
) -> dict[str, str]:
    """Expose locally downloaded diagnostic cores to a checkout's panel process."""
    env = environ if environ is not None else os.environ
    binaries = Path(project_root) / ".tmp" / "diagnostics-cores"
    configured = {}
    for variable, name in (("XKEEN_XRAY_BINARY", "xray"), ("MIHOMO_BIN", "mihomo")):
        candidate = binaries / name
        if variable not in env and candidate.is_file() and os.access(candidate, os.X_OK):
            env[variable] = str(candidate)
            configured[name] = str(candidate)
    return configured


def configure_local_runtime(project_root: str | os.PathLike[str]) -> dict[str, str]:
    """Point the local preview at the checkout-owned Mihomo runtime tree."""

    root = Path(project_root).resolve()
    mihomo_root = root / "xkeen-ui" / "opt" / "etc" / "mihomo"
    os.environ["MIHOMO_ROOT"] = str(mihomo_root)
    return {"mihomo_root": str(mihomo_root)}


def _ensure_local_go_tool(
    project_root: Path,
    *,
    name: str,
    tool_dir: str,
    build_script: str,
    target: Path,
) -> dict[str, object]:
    """Build one developer-only helper when its checkout binary is missing."""

    source_dir = project_root / tool_dir
    script = source_dir / build_script
    if not script.is_file():
        return {"name": name, "ready": False, "error": "build_script_missing"}

    try:
        needs_build = not target.is_file() or not os.access(target, os.X_OK)
        if not needs_build:
            source_mtime = max(
                (path.stat().st_mtime for path in source_dir.rglob("*.go")),
                default=0,
            )
            needs_build = source_mtime > target.stat().st_mtime
    except OSError:
        needs_build = True

    if not needs_build:
        return {"name": name, "ready": True, "path": str(target), "built": False}

    go = shutil.which("go")
    if not go:
        return {"name": name, "ready": False, "error": "go_not_found"}

    target.parent.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env["OUT"] = str(target)
    try:
        result = subprocess.run(
            ["bash", str(script)],
            cwd=str(source_dir),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=180,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return {
            "name": name,
            "ready": False,
            "error": type(error).__name__,
        }
    if result.returncode != 0 or not target.is_file() or not os.access(target, os.X_OK):
        return {
            "name": name,
            "ready": False,
            "error": "build_failed",
            "output": (result.stdout or "")[-800:],
        }
    return {"name": name, "ready": True, "path": str(target), "built": True}


def configure_local_tools(project_root: str | os.PathLike[str]) -> dict[str, dict[str, object]]:
    """Prepare local DAT and Happ helpers and point the panel at them.

    These are macOS checkout conveniences only. Router packages continue to
    use their installed binaries and the regular install/update routes.
    """

    root = Path(project_root).resolve()
    tools = {
        "xk-geodat": _ensure_local_go_tool(
            root,
            name="xk-geodat",
            tool_dir="tools/xk-geodat",
            build_script="build.sh",
            target=root / ".tmp" / "local-tools" / "xk-geodat",
        ),
        "happ-decrypt-universal": _ensure_local_go_tool(
            root,
            name="happ-decrypt-universal",
            tool_dir="tools/happ-decryptor",
            build_script="build.sh",
            target=root / "xkeen-ui" / "bin" / "happ-decrypt-universal",
        ),
    }
    geodat = tools["xk-geodat"]
    if geodat.get("ready") and not os.environ.get("XKEEN_GEODAT_BIN"):
        os.environ["XKEEN_GEODAT_BIN"] = str(geodat["path"])
    decryptor = tools["happ-decrypt-universal"]
    if decryptor.get("ready") and not os.environ.get("XKEEN_HAPP_DECRYPTOR_CMD"):
        os.environ["XKEEN_HAPP_DECRYPTOR_CMD"] = str(decryptor["path"])
    return tools


def ensure_local_mihomo_api(project_root: str | os.PathLike[str]) -> dict[str, object]:
    """Start the stateful local Clash API fixture when the socket is absent."""

    if str(os.environ.get("XKEEN_UI_LOCAL_MIHOMO_MOCK", "1")).strip().lower() in {
        "0", "false", "no", "off",
    }:
        return {"ready": False, "started": False, "disabled": True}

    root = Path(project_root).resolve()
    socket_path = root / "xkeen-ui" / "opt" / "etc" / "mihomo" / "mihomo-api.sock"
    script = root / "scripts" / "run_local_mihomo_mock.py"

    def _ready() -> bool:
        if not socket_path.is_socket():
            return False
        probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            probe.settimeout(0.2)
            probe.connect(str(socket_path))
            return True
        except OSError:
            return False
        finally:
            probe.close()

    if _ready():
        return {"ready": True, "started": False, "socket": str(socket_path)}
    if not script.is_file():
        return {"ready": False, "started": False, "error": "mock_script_missing"}

    global _LOCAL_MIHOMO_PROCESS
    log_path = root / ".tmp" / "local-mihomo" / "mock.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        log_handle = log_path.open("ab")
        _LOCAL_MIHOMO_PROCESS = subprocess.Popen(
            [sys.executable, str(script), "--socket", str(socket_path)],
            cwd=str(root),
            stdin=subprocess.DEVNULL,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            close_fds=True,
            start_new_session=True,
        )
        log_handle.close()
    except OSError as error:
        try:
            log_handle.close()  # type: ignore[possibly-undefined]
        except Exception:
            pass
        return {"ready": False, "started": False, "error": type(error).__name__}

    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline:
        if _ready():
            atexit.register(_stop_local_mihomo_api)
            return {"ready": True, "started": True, "socket": str(socket_path)}
        if _LOCAL_MIHOMO_PROCESS.poll() is not None:
            break
        time.sleep(0.05)
    return {"ready": False, "started": True, "socket": str(socket_path)}


def _stop_local_mihomo_api() -> None:
    process = _LOCAL_MIHOMO_PROCESS
    if process is None or process.poll() is not None:
        return
    try:
        process.terminate()
        process.wait(timeout=1.0)
    except Exception:
        try:
            process.kill()
        except Exception:
            pass


def _write_if_missing(path: Path, payload: object) -> None:
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def ensure_state(state_dir: str | os.PathLike[str], module_ids: Iterable[str] = MODULE_IDS) -> None:
    """Make a complete read-only lifecycle baseline for local visual testing."""

    root = Path(state_dir)
    ids = [str(module_id) for module_id in module_ids]
    _write_if_missing(
        root / "BUILD.json",
        {
            "version": "1.0.0",
            "commit": "local-dev",
            "dirty": True,
            "repo": "local checkout",
            "channel": "local",
            "built_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        },
    )
    _write_if_missing(
        root / "module-installed.json",
        {"schema_version": 1, "modules": {module_id: True for module_id in ids}},
    )
    _write_if_missing(
        root / "install-profile.json",
        {
            "schema_version": 1,
            "profile": "full",
            "module_ids": ids,
            "editor_variant": "full",
        },
    )
