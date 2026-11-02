#!/usr/bin/env python3
"""Build the files of one module release for the GitHub Release of its panel.

A module release adds to the release of panel `V`: the module archive and its
`.sha256`, and the next `module-updates.json` (signed afterwards by
`sign_modular_panel_catalog.py --catalog`). The document keeps the entries of
the other modules from the previous publication and raises `serial`.

    python scripts/build_module_update.py panel-tag
    python scripts/build_module_update.py build --tag module-tool.files-1.0.1 --panel-tag v3.1.0 \\
        --output-dir dist/module-release --source-date-epoch 1700000000 \\
        [--previous module-updates.json --previous-signature module-updates.json.sig]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Mapping, Sequence

ROOT = Path(__file__).resolve().parents[1]
for _path in (ROOT, ROOT / "xkeen-ui"):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from scripts import build_modular_panel_release as builder  # noqa: E402
from scripts.check_module_release import PANEL_TAG_RE, _ancestor_tags, find_panel_tag, parse_module_tag  # noqa: E402
from services.module_package_contract import (  # noqa: E402
    MODULE_UPDATES_KIND,
    ModulePackageContractError,
    compare_semver,
    validate_module_archive,
    validate_module_updates_document,
    validate_semver,
)

UPDATES_FILENAME = "module-updates.json"
METADATA_FILENAME = "release-metadata.json"
SIGNING_KEY_ID = "release-2026"


class ModuleUpdateBuildError(ValueError):
    """The module release cannot be built; the message is safe to show."""


def load_previous(
    document_path: Path | None,
    signature_path: Path | None,
    *,
    panel_version: str,
    keyring: Mapping[str, bytes] | None = None,
) -> dict[str, Any] | None:
    """The published document of this panel, verified by its signature; `None` before the first release."""

    if document_path is None and signature_path is None:
        return None
    if document_path is None or signature_path is None:
        raise ModuleUpdateBuildError("прежний module-updates.json нужен вместе с подписью")
    # Imported here: only this path needs cryptography.
    from services.module_catalog_trust import CatalogTrustError, verify_catalog_signature

    try:
        document_bytes = Path(document_path).read_bytes()
        options = {} if keyring is None else {"keyring": keyring}
        signature = verify_catalog_signature(document_bytes, Path(signature_path).read_bytes(), **options)
        document = json.loads(document_bytes.decode("utf-8"))
        validate_module_updates_document(
            document,
            panel_version=panel_version,
            signing_key_id=signature.key_id,
            trusted_signing_key_ids=None if keyring is None else frozenset(keyring),
        )
    except (OSError, UnicodeDecodeError, ValueError, CatalogTrustError, ModulePackageContractError) as error:
        raise ModuleUpdateBuildError(f"прежний module-updates.json не прошёл проверку: {error}") from error
    return document


def build_module_update(
    root: Path,
    output_dir: Path,
    *,
    module_id: str,
    version: str,
    panel_version: str,
    channel: str,
    previous: Mapping[str, Any] | None,
    epoch: int,
) -> Path:
    """Build the archive, its `.sha256`, `module-updates.json` and `release-metadata.json`."""

    try:
        panel_version = validate_semver(panel_version, "panel_version")
        version = validate_semver(version, "module_version")
    except ModulePackageContractError as error:
        raise ModuleUpdateBuildError(str(error)) from error
    if "-" in version:
        raise ModuleUpdateBuildError(f"у модуля нет бет: {version}")
    if channel != ("prerelease" if "-" in panel_version else "stable"):
        raise ModuleUpdateBuildError(f"канал {channel} не подходит панели {panel_version}")
    if version == panel_version:
        # Same name as the panel's own archive of this module: --clobber would replace it.
        raise ModuleUpdateBuildError(f"версия модуля {version} совпадает с версией панели")

    serial = 1
    entries: dict[str, dict[str, Any]] = {}
    if previous is not None:
        if previous.get("kind") != MODULE_UPDATES_KIND or previous.get("panel_version") != panel_version:
            raise ModuleUpdateBuildError(f"прежний module-updates.json не от панели {panel_version}")
        serial = int(previous["serial"]) + 1
        for entry in previous["modules"]:
            entries[entry["id"]] = dict(entry)
        published = entries.get(module_id)
        if published is not None and compare_semver(published["version"], version) >= 0:
            raise ModuleUpdateBuildError(f"версия {version} не выше опубликованной {published['version']}")

    root = Path(root).resolve()
    output_dir = Path(output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    ownership = builder.build_module_ownership(root)
    options = dict(
        version=version,
        architectures=builder.DEFAULT_ARCHITECTURES,
        min_core=panel_version,
        ownership=ownership,
        channel=channel,
    )
    asset = builder.build_module_archive(root, output_dir, module_id, epoch=int(epoch), **options)
    manifest = builder.build_module_manifest(root, module_id, **options)
    entry = builder._catalog_entry(manifest, asset)
    entries[module_id] = entry
    sidecar = builder._write_checksum(asset)

    document = {
        "kind": MODULE_UPDATES_KIND,
        "schema_version": 1,
        "panel_version": panel_version,
        "serial": serial,
        "modules": [entries[key] for key in sorted(entries)],
    }
    try:
        # The same checks a router makes before it trusts the document and the archive.
        validate_module_updates_document(
            document, panel_version=panel_version, signing_key_id=SIGNING_KEY_ID, core_version=panel_version
        )
        for architecture in entry["architectures"]:
            validate_module_archive(asset.path, entry, platform_architecture=architecture, core_version=panel_version)
    except ModulePackageContractError as error:
        raise ModuleUpdateBuildError(f"выпуск не прошёл проверку контракта: {error}") from error

    updates_path = output_dir / UPDATES_FILENAME
    builder._write_json(updates_path, document)
    # Only what is uploaded to the panel release: its own release-metadata.json stays.
    builder._write_json(
        output_dir / METADATA_FILENAME,
        {
            "schema_version": 1,
            "release_version": panel_version,
            "module_id": module_id,
            "module_version": version,
            "serial": serial,
            "source_date_epoch": int(epoch),
            "assets": sorted([asset.path.name, sidecar.name, updates_path.name]),
        },
    )
    return updates_path


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    panel = commands.add_parser("panel-tag", help="print the panel tag V the module release is cut from")
    panel.add_argument("--root", type=Path, default=ROOT)
    build = commands.add_parser("build", help="build the module release files")
    build.add_argument("--root", type=Path, default=ROOT)
    build.add_argument("--tag", required=True, help="module-<id>-X.Y.Z")
    build.add_argument("--panel-tag", required=True, help="vX.Y.Z or vX.Y.Z-beta.N")
    build.add_argument("--output-dir", type=Path, required=True)
    build.add_argument("--source-date-epoch", type=int, required=True)
    build.add_argument("--previous", type=Path)
    build.add_argument("--previous-signature", type=Path)
    args = parser.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")

    try:
        if args.command == "panel-tag":
            print(find_panel_tag(_ancestor_tags(args.root.resolve())))
            return 0
        module_id, version = parse_module_tag(args.tag)
        if not PANEL_TAG_RE.match(args.panel_tag):
            raise ModuleUpdateBuildError(f"не тег панели: {args.panel_tag}")
        panel_version = args.panel_tag[1:]
        previous = load_previous(args.previous, args.previous_signature, panel_version=panel_version)
        path = build_module_update(
            args.root,
            args.output_dir,
            module_id=module_id,
            version=version,
            panel_version=panel_version,
            channel="prerelease" if "-" in panel_version else "stable",
            previous=previous,
            epoch=args.source_date_epoch,
        )
    except (ValueError, builder.ReleaseBuildError) as error:
        print(f"ОШИБКА: {error}", file=sys.stderr)
        return 1
    document = json.loads(path.read_text(encoding="utf-8"))
    print(f"{args.tag}: module-updates.json панели {panel_version}, serial {document['serial']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
