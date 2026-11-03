from __future__ import annotations

import argparse
import json
from pathlib import Path

PACKAGE_PREFIX = "xkeen-ui/"

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Sync runtime module size metadata from the generated Stage 0 inventory."
    )
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--inventory", type=Path, default=None)
    parser.add_argument("--output", type=Path, default=None)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = args.root.resolve()
    inventory_path = args.inventory or root / "docs/modular-panel-stage0-inventory.json"
    output_path = args.output or root / "xkeen-ui/module-sizes.json"
    inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
    # The size of a module is what lands on the router: only the files of the
    # package. Tests, e2e and build configuration stay in the repository, and a
    # new test in a module release must not move the entry of core.
    modules = {
        str(item["id"]): 0
        for item in inventory.get("modules", [])
        if isinstance(item, dict) and item.get("id")
    }
    for unit in inventory.get("units", []):
        if not isinstance(unit, dict) or str(unit.get("module_id")) not in modules:
            continue
        if str(unit.get("path", "")).replace("\\", "/").startswith(PACKAGE_PREFIX):
            modules[str(unit["module_id"])] += int(unit.get("size_bytes", 0))
    payload = {
        "schema_version": 1,
        "generated_from": "docs/modular-panel-stage0-inventory.json",
        "modules": modules,
    }
    output_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
