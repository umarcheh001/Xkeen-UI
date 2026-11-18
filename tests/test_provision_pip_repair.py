"""Repair the pip used by the active Python, even when opkg targets a newer ABI."""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LIB = ROOT / "xkeen-ui/scripts/provision_env.sh"
CERT = ROOT / "tests/fixtures/xray_handler/decoy-test.pem"


def _run(tmp_path, *, ca=b"", existing=None):
    site = tmp_path / "python3.13"
    certifi = site / "pip/_vendor/certifi"
    certifi.mkdir(parents=True)
    for path in [site / "pip/__init__.py", site / "pip/_vendor/__init__.py"]:
        path.write_bytes(b"")
    (site / "pip/__main__.py").write_bytes(b"print('pip active-python')\n")
    target = certifi / "cacert.pem"
    (certifi / "__init__.py").write_bytes(b"from pathlib import Path\ndef where(): return str(Path(__file__).with_name('cacert.pem'))\n")
    if existing is not None:
        target.write_bytes(existing)
    system_ca = tmp_path / "system-ca.pem"
    system_ca.write_bytes(ca)
    # Reinstalling opkg's pip into Python 3.14 does not repair the active 3.13.
    opkg = tmp_path / "opkg"
    opkg.write_bytes(b"#!/bin/sh\nexit 0\n")
    env = {**os.environ, "PYTHONPATH": str(site), "SSL_CERT_FILE": str(system_ca)}
    script = tmp_path / "repair.sh"
    script.write_bytes((
        f'. "{LIB.as_posix()}"\n'
        f'PYTHON_BIN="{Path(sys.executable).as_posix()}"\n'
        f'OPKG_BIN="{opkg.as_posix()}"\n'
        'ensure_opkg_bin() { return 0; }\n'
        'provision_opkg_update() { return 0; }\n'
        'provision_opkg() { echo opkg-reinstall; return 0; }\n'
        'repair_python3_pip_package "missing pip certificate"\n'
    ).encode())
    proc = subprocess.run(["sh", script.as_posix()], capture_output=True, env=env)
    return proc, target, system_ca


def test_missing_ca_is_restored_for_the_active_python(tmp_path):
    proc, target, source = _run(tmp_path, ca=CERT.read_bytes())
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert target.read_bytes() == source.read_bytes()


def test_pip_version_alone_is_not_a_successful_repair(tmp_path):
    proc, target, _ = _run(tmp_path, ca=b"invalid CA")
    assert proc.returncode != 0, proc.stdout
    assert not target.exists()


def test_existing_certificate_is_not_overwritten(tmp_path):
    proc, target, _ = _run(tmp_path, ca=CERT.read_bytes(), existing=CERT.read_bytes())
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert target.read_bytes() == CERT.read_bytes()


def test_invalid_existing_certificate_is_not_reported_as_repaired(tmp_path):
    proc, target, _ = _run(tmp_path, ca=CERT.read_bytes(), existing=b"invalid")
    assert proc.returncode != 0, proc.stdout
    assert target.read_bytes() == b"invalid"


def test_healthy_ca_does_not_bypass_reinstall_of_a_structurally_broken_pip(tmp_path):
    proc, target, _ = _run(tmp_path, ca=CERT.read_bytes(), existing=CERT.read_bytes())
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert b"opkg-reinstall" in proc.stdout
    assert target.read_bytes() == CERT.read_bytes()
