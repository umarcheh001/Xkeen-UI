from __future__ import annotations

import importlib
import os
from pathlib import Path


def test_routing_auto_pick_uses_prefixed_variant_when_default_missing(tmp_path: Path):
    configs_dir = tmp_path / "configs"
    jsonc_dir = tmp_path / "jsonc"
    configs_dir.mkdir()
    jsonc_dir.mkdir()

    custom = configs_dir / "05_routing-2.json"
    custom.write_text('{"routing":{"rules":[]}}\n', encoding="utf-8")

    old_configs = os.environ.get("XKEEN_XRAY_CONFIGS_DIR")
    old_jsonc = os.environ.get("XKEEN_XRAY_JSONC_DIR")
    old_routing = os.environ.get("XKEEN_XRAY_ROUTING_FILE")
    old_routing_raw = os.environ.get("XKEEN_XRAY_ROUTING_FILE_RAW")

    os.environ["XKEEN_XRAY_CONFIGS_DIR"] = str(configs_dir)
    os.environ["XKEEN_XRAY_JSONC_DIR"] = str(jsonc_dir)
    os.environ.pop("XKEEN_XRAY_ROUTING_FILE", None)
    os.environ.pop("XKEEN_XRAY_ROUTING_FILE_RAW", None)

    import services.xray_config_files as xcf

    try:
        xcf = importlib.reload(xcf)
        assert Path(xcf.ROUTING_FILE).name == "05_routing-2.json"
        assert Path(xcf.ROUTING_FILE_RAW).name == "05_routing-2.jsonc"
    finally:
        if old_configs is None:
            os.environ.pop("XKEEN_XRAY_CONFIGS_DIR", None)
        else:
            os.environ["XKEEN_XRAY_CONFIGS_DIR"] = old_configs
        if old_jsonc is None:
            os.environ.pop("XKEEN_XRAY_JSONC_DIR", None)
        else:
            os.environ["XKEEN_XRAY_JSONC_DIR"] = old_jsonc
        if old_routing is None:
            os.environ.pop("XKEEN_XRAY_ROUTING_FILE", None)
        else:
            os.environ["XKEEN_XRAY_ROUTING_FILE"] = old_routing
        if old_routing_raw is None:
            os.environ.pop("XKEEN_XRAY_ROUTING_FILE_RAW", None)
        else:
            os.environ["XKEEN_XRAY_ROUTING_FILE_RAW"] = old_routing_raw
        importlib.reload(xcf)
