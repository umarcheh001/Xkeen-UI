from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path

from panel_template_source import compose_panel_template


STAGE = {
    "id": "3R.1.6",
    "name": "Baseline initial HTML до выделения экранов",
    "status": "closed",
    "closed_on": "2026-09-30",
}


def build_baseline(root: Path) -> dict:
    root = root.resolve()
    raw_path = root / "xkeen-ui/templates/panel.html"
    raw = raw_path.read_text(encoding="utf-8")
    composed = compose_panel_template(root)
    contract = json.loads(
        (root / "docs/modular-panel-stage4.1-contract.json").read_text(encoding="utf-8")
    )
    ids = re.findall(r'\bid=["\']([^"\']+)["\']', composed)
    profiles = []
    for profile in contract["profiles"]:
        profiles.append(
            {
                "id": profile["id"],
                "active_module_ids": profile["active_module_ids"],
                "expected_views": profile["expected_views"],
                "expected_navigation_sections": profile["expected_navigation_sections"],
                "expected_modal_count": len(profile["expected_modal_ids"]),
                "forbidden_modal_count": len(profile["forbidden_modal_ids"]),
            }
        )
    return {
        "schema_version": 1,
        "stage": STAGE,
        "source": {
            "entrypoint": "xkeen-ui/templates/panel.html",
            "composed_source": "scripts/panel_template_source.py",
            "raw_sha256": hashlib.sha256(raw.encode("utf-8")).hexdigest(),
            "composed_sha256": hashlib.sha256(composed.encode("utf-8")).hexdigest(),
            "raw_utf8_bytes": len(raw.encode("utf-8")),
            "composed_utf8_bytes": len(composed.encode("utf-8")),
            "composed_line_count": len(composed.splitlines()),
            "dom_id_count": len(ids),
            "duplicate_dom_ids": sorted(
                identifier for identifier in set(ids) if ids.count(identifier) > 1
            ),
        },
        "profiles": profiles,
        "reproduce": {
            "command": "python .\\scripts\\generate_modular_panel_stage3r1_baseline.py --root .",
            "note": "This is a structural initial-HTML baseline. Runtime browser Network/RSS measurements remain in Stage 10.",
        },
    }


def render_markdown(payload: dict) -> str:
    source = payload["source"]
    lines = [
        "# Этап 3R.1.6. Baseline initial HTML",
        "",
        "Статус: **закрыт 30 сентября 2026 года**.",
        "",
        "Baseline зафиксирован до подэтапа 4.3, который начнёт переносить screen",
        "markup из composition root в отдельные partials.",
        "",
        "## Источник",
        "",
        f"- entrypoint: `{source['entrypoint']}`;",
        f"- composed source: `{source['composed_source']}`;",
        f"- raw SHA-256: `{source['raw_sha256']}`;",
        f"- composed SHA-256: `{source['composed_sha256']}`;",
        f"- composed UTF-8: `{source['composed_utf8_bytes']}` байт;",
        f"- строк: `{source['composed_line_count']}`;",
        f"- DOM id: `{source['dom_id_count']}`, дубликатов: `{len(source['duplicate_dom_ids'])}`.",
        "",
        "## Профили",
        "",
        "| Профиль | Ожидаемые screens | Navigation sections | Modal allow | Modal deny |",
        "|---|---|---|---:|---:|",
    ]
    for profile in payload["profiles"]:
        lines.append(
            f"| `{profile['id']}` | {', '.join(profile['expected_views']) or '—'} | "
            f"{', '.join(profile['expected_navigation_sections']) or '—'} | "
            f"{profile['expected_modal_count']} | {profile['forbidden_modal_count']} |"
        )
    lines.extend(
        [
            "",
            "## Воспроизведение",
            "",
            "```powershell",
            payload["reproduce"]["command"],
            "```",
            "",
            "Это структурный HTML baseline. Замеры Network/RSS/startup остаются",
            "в Этапе 10 и требуют запуска панели на целевом роутере.",
            "",
        ]
    )
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--json-out", type=Path, default=None)
    parser.add_argument("--markdown-out", type=Path, default=None)
    args = parser.parse_args()
    root = args.root.resolve()
    payload = build_baseline(root)
    json_out = args.json_out or root / "docs/modular-panel-stage3r1-initial-html-baseline.json"
    markdown_out = args.markdown_out or root / "docs/modular-panel-stage3r1-initial-html-baseline.md"
    json_out.parent.mkdir(parents=True, exist_ok=True)
    markdown_out.parent.mkdir(parents=True, exist_ok=True)
    json_out.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    markdown_out.write_text(
        render_markdown(payload),
        encoding="utf-8",
        newline="\n",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
