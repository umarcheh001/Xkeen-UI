from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
CORES_STATUS_PATH = ROOT / "xkeen-ui" / "routes" / "cores_status.py"


def _load_cores_status_module():
    module_name = "test_cores_status_hardening_module"
    prev_module = sys.modules.get(module_name)
    prev_path = list(sys.path)
    try:
        sys.path.insert(0, str(ROOT / "xkeen-ui"))
        spec = importlib.util.spec_from_file_location(module_name, CORES_STATUS_PATH)
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        assert spec and spec.loader
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path[:] = prev_path
        if prev_module is not None:
            sys.modules[module_name] = prev_module
        else:
            sys.modules.pop(module_name, None)


cores_status = _load_cores_status_module()
_read_json = cores_status._read_json
_write_json_atomic = cores_status._write_json_atomic


def test_read_json_normal_path_succeeds(tmp_path):
    cache = tmp_path / "data.json"
    cache.write_text(json.dumps({"ok": True}))
    result = _read_json(str(cache), str(tmp_path))
    assert result == {"ok": True}


def test_write_json_atomic_normal_path_succeeds(tmp_path):
    cache = tmp_path / "data.json"
    _write_json_atomic(str(cache), {"written": True}, str(tmp_path))
    result = _read_json(str(cache), str(tmp_path))
    assert result == {"written": True}


def test_read_json_rejects_symlink_escaping_trusted_root(tmp_path):
    outside = tmp_path.parent / "outside_secret.json"
    outside.write_text(json.dumps({"secret": "data"}))
    try:
        link = tmp_path / "evil_link.json"
        link.symlink_to(outside)
        result = _read_json(str(link), str(tmp_path))
        assert result is None, "Should reject a symlink that resolves outside trusted_root"
    finally:
        outside.unlink(missing_ok=True)


def test_write_json_atomic_rejects_symlink_escaping_trusted_root(tmp_path):
    outside = tmp_path.parent / "outside_target.json"
    outside.write_text("{}")
    try:
        link = tmp_path / "evil_link.json"
        link.symlink_to(outside)
        with pytest.raises(ValueError, match="escapes trusted root"):
            _write_json_atomic(str(link), {"pwned": True}, str(tmp_path))
    finally:
        outside.unlink(missing_ok=True)


def test_read_json_rejects_dotdot_traversal(tmp_path):
    # A path constructed with .. that escapes the trusted root should be rejected
    # even without a symlink
    traversal_path = str(tmp_path / ".." / "traversal.json")
    result = _read_json(traversal_path, str(tmp_path))
    assert result is None


def test_write_json_atomic_rejects_dotdot_traversal(tmp_path):
    traversal_path = str(tmp_path / ".." / "traversal.json")
    with pytest.raises(ValueError, match="escapes trusted root"):
        _write_json_atomic(traversal_path, {"x": 1}, str(tmp_path))


def test_read_json_returns_none_for_missing_file(tmp_path):
    result = _read_json(str(tmp_path / "nonexistent.json"), str(tmp_path))
    assert result is None


def test_read_json_returns_none_for_non_dict_json(tmp_path):
    cache = tmp_path / "list.json"
    cache.write_text("[1, 2, 3]")
    result = _read_json(str(cache), str(tmp_path))
    assert result is None
