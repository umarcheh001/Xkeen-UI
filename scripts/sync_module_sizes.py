from __future__ import annotations

import argparse
import json
from pathlib import Path


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
    modules = {
        str(item["id"]): int(item["size_bytes"])
        for item in inventory.get("modules", [])
        if isinstance(item, dict) and item.get("id")
    }
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
