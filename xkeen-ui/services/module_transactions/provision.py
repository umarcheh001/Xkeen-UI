"""Run the panel's shared script that brings the router in line with a release.

The script is the one the installer uses; here it is run as a command by
whoever lays or puts back the files of the panel: the runner of an operation,
the boot recovery, and the panel itself when it finds a dead runner.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from .state import ModuleTransactionError


PROVISION_TIMEOUTS_S = {"prepare": 1500.0, "apply": 300.0, "packages": 600.0}


def build_provision(panel_root: Path, *, target_version: str | None = None, module_id: str | None = None):
    """How the runner asks the panel's shared script to bring the router in line.

    The script is the one the installer uses; here it is run as a command.
    A panel installed before the script existed has none: nothing is called.
    The script is told which release the panel is updated to and which module
    the operation is about: add-ons are compared with that release, packages
    are brought for that module.
    """

    def provision(phase: str, script: Path) -> list[dict[str, str]]:
        script = Path(script)
        if not script.is_file():
            return []
        environment = dict(os.environ, UI_DIR=str(panel_root), PYTHON_BIN=sys.executable)
        for name, value in (("XKEEN_UI_TARGET_VERSION", target_version), ("XKEEN_UI_OPERATION_MODULE", module_id)):
            # Never inherited: a value left in the environment of the panel
            # would describe some other operation.
            environment.pop(name, None)
            if value:
                environment[name] = str(value)
        try:
            process = subprocess.run(
                ["sh", script.as_posix() if os.name == "nt" else str(script), phase],
                env=environment,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                timeout=PROVISION_TIMEOUTS_S.get(phase, 300.0),
            )
        except subprocess.TimeoutExpired as error:
            raise ModuleTransactionError(
                "operation_environment_failed",
                "preparing the router for the release took too long",
                phase=phase,
            ) from error
        except OSError as error:
            raise ModuleTransactionError(
                "operation_environment_failed", "the router could not be prepared for the release", phase=phase
            ) from error
        output = process.stdout.decode("utf-8", "replace") if process.stdout else ""
        if process.returncode == 0:
            # What the script could not bring but did not stop for: lines of
            # the form "[note] <code> <subject>".
            notes: list[dict[str, str]] = []
            for line in output.splitlines():
                parts = line.split()
                if len(parts) == 3 and parts[0] == "[note]" and parts[1] == "package_missing":
                    notes.append({"code": "package_missing", "package": parts[2]})
            return notes
        # The script names the reason on its last line that starts with "[!]".
        reasons = [line[3:].strip() for line in output.splitlines() if line.startswith("[!]")]
        raise ModuleTransactionError(
            "operation_environment_failed",
            reasons[-1] if reasons else "the router could not be prepared for the release",
            phase=phase,
        )

    return provision
