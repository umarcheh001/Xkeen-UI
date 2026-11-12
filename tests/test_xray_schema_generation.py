"""Generated Xray schemas retain each editor's root and shared definitions."""

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/generate_xray_schemas.py"


def _generator():
    spec = importlib.util.spec_from_file_location("generate_xray_schemas", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_compiled_schemas_match_shared_source():
    generator = _generator()
    source = json.loads((ROOT / generator.SOURCE_PATH).read_text(encoding="utf-8"))
    for name, expected in generator.build_schemas(source).items():
        actual = json.loads((ROOT / "xkeen-ui/static/schemas" / name).read_text(encoding="utf-8"))
        assert actual == expected, name


def test_shared_definition_changes_propagate_to_all_four_schemas():
    generator = _generator()
    source = json.loads((ROOT / generator.SOURCE_PATH).read_text(encoding="utf-8"))
    source["definitions"]["streamSettings"]["properties"]["newSharedField"] = {"type": "boolean"}
    for schema in generator.build_schemas(source).values():
        assert schema["definitions"]["streamSettings"]["properties"]["newSharedField"] == {"type": "boolean"}


def test_editor_specific_schema_roots_are_preserved():
    generator = _generator()
    source = json.loads((ROOT / generator.SOURCE_PATH).read_text(encoding="utf-8"))
    schemas = generator.build_schemas(source)
    assert schemas["xray-config.schema.json"]["type"] == "object"
    for name in ("inbounds", "outbounds", "routing"):
        assert len(schemas[f"xray-{name}.schema.json"]["anyOf"]) == 2


def test_check_detects_stale_schemas_and_refresh_repairs_them(tmp_path):
    generator = _generator()
    source_path = tmp_path / generator.SOURCE_PATH
    source_path.parent.mkdir(parents=True)
    source = json.loads((ROOT / generator.SOURCE_PATH).read_text(encoding="utf-8"))
    source_path.write_text(json.dumps(source), encoding="utf-8")
    output_dir = tmp_path / generator.OUTPUT_DIR
    output_dir.mkdir(parents=True)
    for name, schema in generator.build_schemas(source).items():
        (output_dir / name).write_text(json.dumps(schema), encoding="utf-8")
    command = [sys.executable, str(SCRIPT), "--root", str(tmp_path)]
    assert subprocess.run(command + ["--check"], capture_output=True).returncode == 0
    source["definitions"]["streamSettings"]["properties"]["newSharedField"] = {"type": "boolean"}
    source_path.write_text(json.dumps(source), encoding="utf-8")
    assert subprocess.run(command + ["--check"], capture_output=True).returncode != 0
    assert subprocess.run(command, capture_output=True).returncode == 0
    assert subprocess.run(command + ["--check"], capture_output=True).returncode == 0
