"""Run the shipped module runner against a release that lies in a directory.

The runner the panel ships (``scripts/module_transaction.py``) talks only to
the official GitHub release and trusts only the built-in key. Tests, the
local stand and a router acceptance run need the same code path with a
release of their own, so this wrapper swaps the source, the key and - for
power-loss drills - kills the process at a chosen step. It is not part of
the panel archive.

    python module_transaction_runner.py run --panel-root P --state-dir S --operation ID \
        --release-dir DIR [--architecture aarch64] [--fail-at applying] [--engine-root /opt/etc/xkeen-ui]
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
from pathlib import Path


def _split(argv: list[str]) -> tuple[argparse.Namespace, list[str]]:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--release-dir", type=Path)
    parser.add_argument("--architecture")
    parser.add_argument("--fail-at")
    parser.add_argument("--engine-root", type=Path, default=Path(__file__).resolve().parents[2] / "xkeen-ui")
    return parser.parse_known_args(argv)


def main(argv: list[str] | None = None) -> int:
    options, shipped_args = _split(list(sys.argv[1:] if argv is None else argv))
    engine_root = options.engine_root.resolve()
    sys.path.insert(0, str(engine_root))
    spec = importlib.util.spec_from_file_location("module_transaction", engine_root / "scripts" / "module_transaction.py")
    shipped = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = shipped
    spec.loader.exec_module(shipped)

    from services.module_catalog_client import CatalogTransportError, ModuleCatalogClient

    class DirectoryTransport:
        """Release assets by file name instead of by GitHub URL."""

        def __init__(self, directory: Path) -> None:
            self._directory = directory

        def _read(self, url: str) -> bytes:
            try:
                return (self._directory / url.rsplit("/", 1)[1]).read_bytes()
            except OSError as error:
                raise CatalogTransportError("catalog_transport_failed", "asset is missing from the release directory") from error

        def fetch_bytes(self, url: str, *, max_bytes: int, policy) -> bytes:
            return self._read(url)

        def stream_to(self, url: str, output, *, max_bytes: int, policy) -> int:
            body = self._read(url)
            output.write(body)
            return len(body)

    client_factory = None
    if options.release_dir is not None:
        release_dir = options.release_dir.resolve()
        keyring = {
            key_id: pem.encode("ascii")
            for key_id, pem in json.loads((release_dir / "keyring.json").read_text(encoding="utf-8")).items()
        }

        def client_factory(state_dir: Path, architecture: str, version: str) -> ModuleCatalogClient:
            return ModuleCatalogClient(
                state_dir,
                transport=DirectoryTransport(release_dir),
                keyring=keyring,
                platform_architecture=architecture,
                core_version=version,
            )

    on_step = None
    if options.fail_at:
        def on_step(step: str) -> None:
            if step == options.fail_at:
                # What a power cut looks like to the files: no cleanup at all.
                os._exit(70)

    return shipped.main(
        shipped_args,
        client_factory=client_factory,
        architecture=options.architecture,
        on_step=on_step,
    )


if __name__ == "__main__":
    raise SystemExit(main())
