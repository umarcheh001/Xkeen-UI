"""Собрать автономные схемы редакторов Xray из общего источника."""

from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path

SOURCE_PATH = "scripts/schema_sources/xray-schemas.json"
OUTPUT_DIR = "xkeen-ui/static/schemas"


def _apply_overrides(value: dict, patch: dict) -> dict:
    result = copy.deepcopy(value)
    for key in patch.get("remove", []):
        result.pop(key, None)
    result.update(copy.deepcopy(patch.get("set", {})))
    for key, child in patch.get("edit", {}).items():
        result[key] = _apply_overrides(result[key], child)
    return result


def build_schemas(source: dict) -> dict[str, dict]:
    common = source["definitions"]
    result = {}
    for filename, entry in source["schemas"].items():
        schema = copy.deepcopy(entry["root"])
        definitions = {}
        for name in entry["definitions"]:
            value = common[name]
            patch = entry.get("overrides", {}).get(name)
            definitions[name] = _apply_overrides(value, patch) if patch else copy.deepcopy(value)
        schema["definitions"] = definitions
        result[filename] = schema
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    source = json.loads((args.root / SOURCE_PATH).read_text(encoding="utf-8"))
    stale = []
    for name, schema in build_schemas(source).items():
        path = args.root / OUTPUT_DIR / name
        expected = json.dumps(schema, ensure_ascii=False, indent=2) + "\n"
        try:
            current = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            current = None
        if current != schema:
            stale.append(name)
            if not args.check:
                path.write_bytes(expected.encode("utf-8"))
    if args.check and stale:
        print("Устарели схемы Xray: " + ", ".join(stale))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
