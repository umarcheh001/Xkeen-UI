from __future__ import annotations

import argparse
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TABLER_ROOT = ROOT / "node_modules" / "@tabler" / "icons"
DEFAULT_OUTPUT = ROOT / "xkeen-ui" / "static" / "icons" / "operator.svg"
DEFAULT_LICENSE_OUTPUT = ROOT / "xkeen-ui" / "static" / "icons" / "tabler-icons.LICENSE"
DEFAULT_MANIFEST_OUTPUT = ROOT / "xkeen-ui" / "static" / "js" / "ui" / "operator_icons_manifest.js"

# Public XKeen name -> pinned Tabler outline asset. Application code depends on
# the semantic XKeen name, not on the upstream package naming scheme.
ICONS = {
    "add-balancer": "scale",
    "add-rule": "list-details",
    "archive": "archive",
    "back": "arrow-left",
    "broom": "custom:broom",
    "bookmark": "bookmark",
    "catalog": "folder-open",
    "chevron-down": "chevron-down",
    "download": "download",
    "drag": "grip-vertical",
    "duplicate": "copy",
    "edit": "file-pencil",
    "export": "file-export",
    "format": "sparkles",
    "forward": "arrow-right",
    "github": "brand-github",
    "help": "help-circle",
    "import": "file-import",
    "lock": "lock",
    "list-details": "list-details",
    "move-down": "arrow-down",
    "comment": "message",
    "compare": "git-compare",
    "info": "info-circle",
    "replace": "replace",
    "moon": "moon",
    "open": "folder-open",
    "owner": "user",
    "permissions": "lock",
    "move-up": "arrow-up",
    "more": "dots",
    "normalize": "wand",
    "ping": "stopwatch",
    "pool": "stack-2",
    "processes": "cpu",
    "quick-start": "bolt",
    "refresh": "refresh",
    "reload": "reload",
    "retry": "refresh-alert",
    "restart": "refresh",
    "restore": "restore",
    "save": "device-floppy",
    "comment": "message",
    "compare": "git-compare",
    "info": "info-circle",
    "replace": "replace",
    "subscriptions": "refresh",
    "minimize": "minimize",
    "template": "template",
    "trash": "trash",
    "tools": "tools",
    "transfer": "arrows-exchange",
    "upload": "upload",
    "x": "x",
    "add-node": "plus",
    "apply": "rocket",
    "close": "x",
    "bolt": "bolt",
    "dashboard": "world",
    "detach": "unlink",
    "fullscreen": "maximize",
    "hwid": "fingerprint",
    "pause": "player-pause",
    "play": "player-play",
    "preview": "eye",
    "validate": "stethoscope",
    # I3 top-level panel views: names stay semantic even when the same Tabler
    # asset is shared by multiple controls.
    "alert": "alert-circle",
    "check": "check",
    "clear": "trash",
    "devices": "users",
    "dns": "network",
    "file-add": "file-plus",
    "folder-add": "folder-plus",
    "fullscreen-exit": "minimize",
    "home": "home",
    "loading": "loader-2",
    "search": "search",
    "server-off": "server-off",
    "settings": "settings",
    "stop": "player-stop",
    "storage": "device-usb",
    "sun": "sun",
    "terminal": "terminal-2",
}

# Tabler does not ship a household broom in the pinned icon set.  A paintbrush
# is too easily confused with the adjacent destructive-file action at 16px, so
# keep this one small, explicit operator glyph in the generated sprite.
CUSTOM_ICON_BODIES = {
    "custom:broom": """
<path d="M17 3l-8 11" />
<path d="M5 14h6l3 6h-11z" />
<path d="M5 17h7" />
<path d="M4 20h8" />
""",
}

SVG_BODY_RE = re.compile(r"<svg\b[^>]*>(?P<body>.*)</svg>\s*", re.DOTALL)
EMPTY_CANVAS_RE = re.compile(
    r'\s*<path\s+stroke="none"\s+d="M0 0h24v24H0z"\s+fill="none"\s*/>\s*'
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate the minimal XKeen Operator SVG sprite.")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--license-output", default=str(DEFAULT_LICENSE_OUTPUT))
    parser.add_argument("--manifest-output", default=str(DEFAULT_MANIFEST_OUTPUT))
    return parser.parse_args()


def read_icon_body(tabler_name: str) -> str:
    if tabler_name in CUSTOM_ICON_BODIES:
        body = CUSTOM_ICON_BODIES[tabler_name].strip()
        return "\n".join(f"      {line.strip()}" for line in body.splitlines() if line.strip())

    source = TABLER_ROOT / "icons" / "outline" / f"{tabler_name}.svg"
    if not source.is_file():
        raise SystemExit(f"missing Tabler icon: {source}")
    match = SVG_BODY_RE.search(source.read_text(encoding="utf-8"))
    if not match:
        raise SystemExit(f"invalid Tabler SVG: {source}")
    body = EMPTY_CANVAS_RE.sub("", match.group("body")).strip()
    return "\n".join(f"      {line.strip()}" for line in body.splitlines() if line.strip())


def build_sprite() -> str:
    symbols = []
    for public_name, tabler_name in sorted(ICONS.items()):
        body = read_icon_body(tabler_name)
        symbols.append(
            f'    <symbol id="xk-{public_name}" viewBox="0 0 24 24">\n{body}\n    </symbol>'
        )
    joined = "\n".join(symbols)
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true">\n'
        '  <!-- Generated by scripts/generate_operator_icon_sprite.py from Tabler Icons. -->\n'
        '  <defs>\n'
        f"{joined}\n"
        '  </defs>\n'
        '</svg>\n'
    )




def build_manifest() -> str:
    """Expose the generated public icon names to the browser helper."""
    names = ",\n  ".join(f'"{name}"' for name in sorted(ICONS))
    return (
        "// Generated by scripts/generate_operator_icon_sprite.py; do not edit.\n"
        "const OPERATOR_ICON_NAMES = Object.freeze([\n"
        f"  {names}\n"
        "]);\n\n"
        "export { OPERATOR_ICON_NAMES };\n"
    )

def write_text_lf(path: Path, content: str) -> None:
    """Write generated assets deterministically on every platform."""
    with path.open("w", encoding="utf-8", newline="\n") as stream:
        stream.write(content)


def main() -> int:
    args = parse_args()
    output = Path(args.output).resolve()
    license_output = Path(args.license_output).resolve()
    manifest_output = Path(args.manifest_output).resolve()
    license_source = TABLER_ROOT / "LICENSE"
    if not license_source.is_file():
        raise SystemExit(f"missing Tabler license: {license_source}")

    output.parent.mkdir(parents=True, exist_ok=True)
    write_text_lf(output, build_sprite())
    license_output.parent.mkdir(parents=True, exist_ok=True)
    write_text_lf(license_output, license_source.read_text(encoding="utf-8"))
    manifest_output.parent.mkdir(parents=True, exist_ok=True)
    write_text_lf(manifest_output, build_manifest())
    print(f"Generated {len(ICONS)} Operator icons: {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
