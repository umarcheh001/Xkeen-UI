# tests/test_xray_observatory_acceptance.py
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

CORE = Path(os.environ.get("XKEEN_TEST_XRAY_CORE", r"C:\Users\Alex\Documents\Xray-Configs\tools\cores\26.9.9\xray.exe"))
SUB_TAGS = ["VPS_NL_SUB", "VPS_CH_SUB"]
ETALON = (
    "// выбор объяснён в эталоне\n"
    '{ "burstObservatory": { "subjectSelector": ["VPS_"],\n'
    '    "pingConfig": { "destination": "https://cp.cloudflare.com/generate_204",\n'
    '                    "interval": "10m", "sampling": 6, "timeout": "5s" } } }\n'
)
PING = {"destination": "https://cp.cloudflare.com/generate_204", "interval": "10m", "sampling": 6, "timeout": "5s"}
PLAIN = {"observatory": {"subjectSelector": ["manual"], "probeUrl": "https://cp.cloudflare.com/generate_204",
                         "probeInterval": "5m", "enableConcurrency": True}}

pytestmark = pytest.mark.skipif(not CORE.exists(), reason="ядро Xray 26.9.9 недоступно")


def _catalog(tmp_path: Path, strategies: list[str], observatory: str | None) -> Path:
    configs = tmp_path / "configs"
    configs.mkdir()
    outbounds = [{"tag": "direct", "protocol": "freedom"}] + [
        {"tag": f"{tag}--node", "protocol": "freedom"} for tag in SUB_TAGS
    ]
    (configs / "04_outbounds.json").write_text(json.dumps({"outbounds": outbounds}), encoding="utf-8")
    balancers = [
        {"tag": f"b{idx}", "selector": ["VPS_"], "strategy": {"type": kind}}
        for idx, kind in enumerate(strategies)
    ]
    rules = [{"inboundTag": [f"none{idx}"], "balancerTag": f"b{idx}"} for idx in range(len(strategies))]
    (configs / "05_routing.json").write_text(
        json.dumps({"routing": {"balancers": balancers, "rules": rules}}), encoding="utf-8"
    )
    if observatory is not None:
        (configs / "07_observatory.json").write_text(observatory, encoding="utf-8")
    return configs


def _core_accepts(configs: Path) -> None:
    run = subprocess.run([str(CORE), "run", "-confdir", str(configs), "-test"], capture_output=True, text=True)
    assert run.returncode == 0, run.stdout + run.stderr


def _kinds(configs: Path) -> list[str]:
    from services.xray_observatory import collect_catalog

    return [item["kind"] for item in collect_catalog(str(configs))["sections"]]


@pytest.fixture
def subs(tmp_path: Path, monkeypatch):
    from services import xray_subscriptions as module

    jsonc_dir = tmp_path / "jsonc"
    jsonc_dir.mkdir()
    monkeypatch.setattr(module, "jsonc_path_for", lambda path: str(jsonc_dir / (Path(path).name + "c")))
    monkeypatch.setattr(module, "ensure_xray_jsonc_dir", lambda: None)
    return module


@pytest.mark.parametrize(
    "strategies, observatory, expected_kind",
    [
        (["leastPing", "leastLoad"], ETALON, "burstObservatory"),              # критерий 1
        (["leastLoad"], json.dumps({"burstObservatory": {"subjectSelector": ["OTHER_"], "pingConfig": PING}}), "burstObservatory"),  # 2
        (["leastPing", "leastLoad"], json.dumps(PLAIN), "burstObservatory"),  # критерий 3
        (["leastPing"], None, "observatory"),                                  # критерий 4
    ],
)
def test_enable_then_disable_leaves_one_section_the_core_accepts(tmp_path, subs, strategies, observatory, expected_kind):
    configs = _catalog(tmp_path, strategies, observatory)
    if observatory is None:
        # leastPing без обсерватории ядро не собирает («not all dependencies are resolved»),
        # поэтому контрольный прогон идёт на копии с обычной обсерваторией; сам каталог не трогаем.
        control = tmp_path / "control"
        shutil.copytree(configs, control)
        (control / "07_observatory.json").write_text(json.dumps(PLAIN), encoding="utf-8")
        _core_accepts(control)
    else:
        _core_accepts(configs)  # контрольный прогон: исходный каталог ядро принимает

    subs.sync_observatory_subjects(xray_configs_dir=str(configs), add_tags=SUB_TAGS)
    assert _kinds(configs) == [expected_kind]
    _core_accepts(configs)

    subs.sync_observatory_subjects(
        xray_configs_dir=str(configs), add_tags=[], remove_tags=SUB_TAGS, managed_active=False
    )
    assert _kinds(configs) == [expected_kind]  # критерий 5: одна секция, удаление тегов вид не меняет
    _core_accepts(configs)                      # критерий 6


def test_etalon_survives_enable_and_disable_byte_for_byte(tmp_path, subs):
    configs = _catalog(tmp_path, ["leastPing", "leastLoad"], ETALON)

    subs.sync_observatory_subjects(xray_configs_dir=str(configs), add_tags=SUB_TAGS)
    subs.sync_observatory_subjects(
        xray_configs_dir=str(configs), add_tags=[], remove_tags=SUB_TAGS, managed_active=False
    )

    assert (configs / "07_observatory.json").read_text(encoding="utf-8") == ETALON
