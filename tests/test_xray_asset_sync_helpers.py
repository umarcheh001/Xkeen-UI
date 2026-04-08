from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TRANSFER_PATH = ROOT / "xkeen-ui" / "routes" / "fs" / "endpoints_transfer.py"


def _load_transfer_module():
    module_name = "test_endpoints_transfer_module"
    prev_module = sys.modules.get(module_name)
    prev_path = list(sys.path)
    try:
        sys.path.insert(0, str(ROOT / "xkeen-ui"))
        spec = importlib.util.spec_from_file_location(module_name, TRANSFER_PATH)
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


transfer = _load_transfer_module()


def test_sync_uploaded_xray_dat_if_needed_refreshes_asset_links_inside_dat_dir(tmp_path, monkeypatch):
    dat_dir = tmp_path / "dat"
    asset_dir = tmp_path / "asset"
    dat_dir.mkdir()
    asset_dir.mkdir()
    dat_file = dat_dir / "geosite_v2fly.dat"
    dat_file.write_bytes(b"dat")

    monkeypatch.setenv("XRAY_DAT_DIR", str(dat_dir))
    monkeypatch.setenv("XRAY_ASSET_DIR", str(asset_dir))

    calls = []

    def fake_ensure_xray_dat_assets(*, dat_dir, asset_dir, log=None, diag=None):
        calls.append((dat_dir, asset_dir, callable(log), callable(diag)))

    monkeypatch.setattr(transfer, "ensure_xray_dat_assets", fake_ensure_xray_dat_assets)

    transfer._sync_uploaded_xray_dat_if_needed(str(dat_file), core_log=lambda *args, **kwargs: None)

    assert calls == [(str(dat_dir), str(asset_dir), True, False)]


def test_sync_uploaded_xray_dat_if_needed_ignores_files_outside_dat_dir(tmp_path, monkeypatch):
    dat_dir = tmp_path / "dat"
    other_dir = tmp_path / "other"
    dat_dir.mkdir()
    other_dir.mkdir()
    other_file = other_dir / "geosite_v2fly.dat"
    other_file.write_bytes(b"dat")

    monkeypatch.setenv("XRAY_DAT_DIR", str(dat_dir))
    monkeypatch.setenv("XRAY_ASSET_DIR", str(tmp_path / "asset"))

    calls = []

    def fake_ensure_xray_dat_assets(*, dat_dir, asset_dir, log=None, diag=None):
        calls.append((dat_dir, asset_dir))

    monkeypatch.setattr(transfer, "ensure_xray_dat_assets", fake_ensure_xray_dat_assets)

    transfer._sync_uploaded_xray_dat_if_needed(str(other_file))

    assert calls == []
