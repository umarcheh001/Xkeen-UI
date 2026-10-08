"""A small installed panel and a signed release of its modules for transaction tests.

The panel is a temporary tree shaped like ``/opt/etc/xkeen-ui``: managed files
of the installed modules, the ownership map and the state files the installer
writes. The release is what GitHub would serve for the same version.
"""

from __future__ import annotations

import base64
import gzip
import hashlib
import io
import json
import os
import tarfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from services.module_catalog_client import (
    CatalogTransportError,
    FetchPolicy,
    ModuleCatalogClient,
    official_release_asset_url,
)
from services.module_registry import MODULE_DEFINITIONS


VERSION = "2.10.0"
ARCHITECTURE = "aarch64"
MODULE_ORDER = tuple(definition.id for definition in MODULE_DEFINITIONS)
STATE_PATHS = frozenset(
    {
        "modules.json",
        "module-installed.json",
        "install-profile.json",
        "install-managed.json",
        "static/frontend-build/.vite/manifest.json",
        "static/frontend-build/.vite/manifest.build.json",
    }
)

OWNERSHIP: dict[str, tuple[str, ...]] = {
    "core": (
        "app.py",
        "module-ownership.json",
        "services/module_registry.py",
        "static/frontend-build/.vite/manifest.build.json",
        "static/frontend-build/.vite/manifest.json",
        "static/frontend-build/assets/panel-bridge.js",
        "static/js/core.js",
        "static/js/core.js.gz",
    ),
    "tool.editor": ("static/js/pages/codemirror6.shared.js",),
    "engine.xray": ("routes/routing/__init__.py", "services/xray_subscriptions.py"),
    "engine.mihomo": ("routes/mihomo.py", "services/mihomo_subscriptions.py"),
    "tool.terminal": (
        "services/ws_pty.py",
        "static/js/pages/terminal.lazy.entry.js",
        "static/js/pages/terminal.lazy.entry.js.gz",
        "static/js/terminal/_core.js",
    ),
    "tool.files": ("static/js/pages/file_manager.lazy.entry.js",),
    "tool.backups": (
        "static/frontend-build/assets/backups-bridge.js",
        "static/js/pages/backups.entry.js",
        "templates/backups.html",
    ),
    "integration.happ": ("routes/happ_decryptor.py", "services/happ_decryptor/__init__.py"),
    "tool.advanced-diagnostics": ("routes/devtools.py", "templates/devtools.html"),
}

FRONTEND = {
    "bridge": {
        "static/js/pages/panel.entry.js": {
            "file": "assets/panel-bridge.js",
            "src": "static/js/pages/panel.entry.js",
            "isEntry": True,
        },
        "static/js/pages/backups.entry.js": {
            "file": "assets/backups-bridge.js",
            "src": "static/js/pages/backups.entry.js",
            "isEntry": True,
        },
    },
    "build": {
        "static/js/pages/panel.entry.js": {
            "file": "assets/panel-bridge.js",
            "src": "static/js/pages/panel.entry.js",
            "imports": [],
            "dynamicImports": ["static/js/pages/backups.entry.js"],
        },
        "static/js/pages/backups.entry.js": {
            "file": "assets/backups-bridge.js",
            "src": "static/js/pages/backups.entry.js",
            "imports": ["static/js/pages/panel.entry.js"],
        },
    },
}


def file_bytes(relative: str, version: str = VERSION) -> bytes:
    """Deterministic content of a managed file of a given release."""

    return f"{relative} @ {version}\n".encode("utf-8")


def _json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def _definition(module_id: str):
    return next(definition for definition in MODULE_DEFINITIONS if definition.id == module_id)


@dataclass
class Panel:
    root: Path
    state: Path
    version: str
    installed: tuple[str, ...]
    ownership: dict[str, tuple[str, ...]] = field(default_factory=lambda: dict(OWNERSHIP))

    @property
    def kwargs(self) -> dict[str, Any]:
        """Keyword arguments every ``build_plan`` call in the tests shares."""

        return {
            "panel_root": self.root,
            "state_dir": self.state,
            "catalog": catalog_document(self.version, self.ownership),
            "architecture": ARCHITECTURE,
            "free_bytes": 1 << 40,
        }

    def path(self, relative: str) -> Path:
        return self.root / Path(*relative.split("/"))

    def read_json(self, relative: str) -> Any:
        return json.loads(self.path(relative).read_text(encoding="utf-8"))


def filtered_frontend(installed_files: set[str]) -> dict[str, dict[str, Any]]:
    """The manifests the way the profile installer leaves them: installed entries only."""

    result: dict[str, dict[str, Any]] = {}
    for key, entries in FRONTEND.items():
        kept = {
            name: dict(entry)
            for name, entry in entries.items()
            if "static/frontend-build/" + entry["file"] in installed_files
        }
        for entry in kept.values():
            for link in ("imports", "dynamicImports"):
                if link in entry:
                    entry[link] = [name for name in entry[link] if name in kept]
        result[key] = kept
    return result


def make_panel(
    tmp_path: Path,
    *,
    version: str = VERSION,
    installed: tuple[str, ...] = ("core", "tool.editor", "engine.xray"),
) -> Panel:
    root = tmp_path / "xkeen-ui"
    root.mkdir(parents=True)
    panel = Panel(root=root, state=root, version=version, installed=tuple(installed))
    files = {relative for module in installed for relative in OWNERSHIP[module]}
    for relative in sorted(files):
        target = panel.path(relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(file_bytes(relative, version))
    manifests = filtered_frontend(files)
    panel.path("static/frontend-build/.vite/manifest.json").write_bytes(_json_bytes(manifests["bridge"]))
    panel.path("static/frontend-build/.vite/manifest.build.json").write_bytes(_json_bytes(manifests["build"]))
    panel.path("module-ownership.json").write_bytes(
        _json_bytes(
            {
                "schema_version": 1,
                "modules": {module: list(paths) for module, paths in OWNERSHIP.items()},
                "frontend": FRONTEND,
            }
        )
    )
    panel.path("BUILD.json").write_bytes(_json_bytes({"version": version, "commit": "c" * 40}))
    panel.path("secret.key").write_bytes(b"user secret\n")
    panel.path("modules.json").write_bytes(
        _json_bytes(
            {
                "schema_version": 1,
                "profile": "xray-minimal",
                "restart_required": False,
                "editor": {"variant": "light"},
                "modules": {module: {"enabled": module in installed} for module in MODULE_ORDER},
            }
        )
    )
    panel.path("module-installed.json").write_bytes(
        _json_bytes({"schema_version": 1, "modules": {module: module in installed for module in MODULE_ORDER}})
    )
    panel.path("install-profile.json").write_bytes(
        _json_bytes(
            {
                "schema_version": 1,
                "profile": "xray-minimal",
                "module_ids": [module for module in MODULE_ORDER if module in installed],
                "editor_variant": "light",
            }
        )
    )
    panel.path("install-managed.json").write_bytes(_json_bytes({"schema_version": 1, "paths": sorted(files)}))
    return panel


def snapshot(root: Path) -> dict[str, bytes]:
    """Every file under the panel root with its bytes, for before/after comparison."""

    return {
        path.relative_to(root).as_posix(): path.read_bytes()
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def changed_paths(before: Mapping[str, bytes], after: Mapping[str, bytes]) -> set[str]:
    return {path for path in set(before) | set(after) if before.get(path) != after.get(path)}


def module_archive(module_id: str, version: str, ownership: Mapping[str, tuple[str, ...]], entry: Mapping[str, Any]) -> bytes:
    manifest = {
        "schema_version": 1,
        **{
            key: entry[key]
            for key in (
                "id", "version", "channel", "panel_api", "module_api", "min_core",
                "architectures", "requires", "conflicts", "requires_restart",
            )
        },
        "ownership": sorted(ownership[module_id]),
        "max_size": 1 << 20,
    }
    buffer = io.BytesIO()
    # The gzip header carries the time of packing. The same archive is built
    # once for the catalog and once to be served: without a fixed time the two
    # differ whenever a second ticks over in between, and the checksum fails.
    with gzip.GzipFile(fileobj=buffer, mode="wb", mtime=0) as packed, tarfile.open(fileobj=packed, mode="w") as archive:
        def add(name: str, payload: bytes) -> None:
            info = tarfile.TarInfo(name)
            info.size = len(payload)
            info.mtime = 1_700_000_000
            archive.addfile(info, io.BytesIO(payload))

        add("module-manifest.json", _json_bytes(manifest))
        for relative in sorted(ownership[module_id]):
            add("payload/" + relative, file_bytes(relative, version))
    return buffer.getvalue()


def panel_archive(version: str, ownership: Mapping[str, tuple[str, ...]] = OWNERSHIP) -> bytes:
    """A deterministic whole-panel archive with authoritative ownership metadata."""

    buffer = io.BytesIO()
    ownership_document = {
        "schema_version": 1,
        "modules": {module_id: list(paths) for module_id, paths in ownership.items()},
        "frontend": FRONTEND,
    }
    with gzip.GzipFile(fileobj=buffer, mode="wb", mtime=0) as packed, tarfile.open(fileobj=packed, mode="w") as archive:
        def add(name: str, payload: bytes) -> None:
            info = tarfile.TarInfo(name)
            info.size = len(payload)
            info.mtime = 1_700_000_000
            archive.addfile(info, io.BytesIO(payload))

        for relative in sorted({path for paths in ownership.values() for path in paths}):
            payload = _json_bytes(ownership_document) if relative == "module-ownership.json" else file_bytes(relative, version)
            add("xkeen-ui/" + relative, payload)
    return buffer.getvalue()


def _entry(
    module_id: str,
    version: str,
    size: int = 1,
    sha256: str = "0" * 64,
    *,
    definitions: Mapping[str, Mapping[str, Any]] | None = None,
    min_core: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    # ``definitions`` describes modules the way a later release would: a module
    # this panel build does not know, or a known one with other dependencies.
    described = (definitions or {}).get(module_id)
    if described is None:
        definition = _definition(module_id)
        described = {
            "requires": list(definition.dependencies),
            "conflicts": list(definition.conflicts),
            "requires_restart": bool(definition.requires_restart),
        }
    return {
        "id": module_id,
        "version": version,
        "channel": "stable",
        "panel_api": "1",
        "module_api": "1",
        "min_core": (min_core or {}).get(module_id, "1.0.0"),
        "architectures": ["aarch64", "mips", "mipsel"],
        "requires": list(described["requires"]),
        "conflicts": list(described["conflicts"]),
        "requires_restart": bool(described["requires_restart"]),
        "archive": f"xkeen-module-{module_id}-{version}.tar.gz",
        "size": size,
        "sha256": sha256,
        "signing_key_id": "release-2026",
    }


def catalog_document(
    version: str = VERSION,
    ownership: Mapping[str, tuple[str, ...]] = OWNERSHIP,
    *,
    definitions: Mapping[str, Mapping[str, Any]] | None = None,
    min_core: Mapping[str, str] | None = None,
    panel_fields: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """A catalog the way the trust boundary hands it over: validated and normalized."""

    modules = []
    for module_id in sorted(ownership):
        entry = _entry(module_id, version, definitions=definitions, min_core=min_core)
        archive = module_archive(module_id, version, ownership, entry)
        entry["size"] = len(archive)
        entry["sha256"] = hashlib.sha256(archive).hexdigest()
        modules.append(entry)
    panel = panel_archive(version, ownership)
    return {
        "schema_version": 1,
        "release_version": version,
        "channel": "stable",
        "source_commit": "c" * 40,
        "panel": {
            "archive": f"xkeen-ui-panel-{version}.tar.gz",
            "size": len(panel),
            "sha256": hashlib.sha256(panel).hexdigest(),
            "version": version,
            "signing_key_id": "release-2026",
            "architectures": ["aarch64", "mips", "mipsel"],
            **dict(panel_fields or {}),
        },
        "modules": modules,
    }


class ReleaseTransport:
    """Serves one signed release the way GitHub would, and can be made to fail."""

    def __init__(self, responses: dict[str, bytes]) -> None:
        self.responses = responses
        self.calls: list[str] = []
        self.fail: dict[str, Exception] = {}
        self.truncate: set[str] = set()

    def fetch_bytes(self, url: str, *, max_bytes: int, policy: FetchPolicy) -> bytes:
        self.calls.append(url)
        if url in self.fail:
            raise self.fail[url]
        if url not in self.responses:
            raise CatalogTransportError("catalog_transport_failed", "not found")
        return self.responses[url]

    def stream_to(self, url: str, output, *, max_bytes: int, policy: FetchPolicy) -> int:
        self.calls.append(url)
        if url in self.fail:
            raise self.fail[url]
        if url not in self.responses:
            raise CatalogTransportError("catalog_transport_failed", "not found")
        body = self.responses[url]
        if url in self.truncate:
            output.write(body[: len(body) // 2])
            raise CatalogTransportError("catalog_transport_failed", "connection reset")
        output.write(body)
        return len(body)


@dataclass
class Release:
    version: str
    key: Ed25519PrivateKey
    transport: ReleaseTransport
    catalog: dict[str, Any]
    archives: dict[str, bytes]
    panel: bytes

    @property
    def keyring(self) -> dict[str, bytes]:
        return {
            "release-2026": self.key.public_key().public_bytes(
                serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
            )
        }

    def archive_url(self, module_id: str) -> str:
        return official_release_asset_url(self.version, f"xkeen-module-{module_id}-{self.version}.tar.gz")

    @property
    def panel_url(self) -> str:
        return official_release_asset_url(self.version, f"xkeen-ui-panel-{self.version}.tar.gz")

    def client(self, state_dir: Path, *, core_version: str | None = None) -> ModuleCatalogClient:
        # ``core_version`` is the version of the panel that asks. By default it
        # is the release itself; a panel looking at a later release passes its own.
        return ModuleCatalogClient(
            state_dir,
            transport=self.transport,
            keyring=self.keyring,
            platform_architecture=ARCHITECTURE,
            core_version=self.version if core_version is None else core_version,
        )


def make_release(
    version: str = VERSION,
    ownership: Mapping[str, tuple[str, ...]] = OWNERSHIP,
    *,
    archives: Mapping[str, bytes] | None = None,
    definitions: Mapping[str, Mapping[str, Any]] | None = None,
    min_core: Mapping[str, str] | None = None,
    panel_fields: Mapping[str, Any] | None = None,
) -> Release:
    """A signed catalog with the archive of every module; ``archives`` overrides bodies."""

    key = Ed25519PrivateKey.generate()
    document = catalog_document(
        version, ownership, definitions=definitions, min_core=min_core, panel_fields=panel_fields
    )
    panel = panel_archive(version, ownership)
    bodies: dict[str, bytes] = {}
    for entry in document["modules"]:
        body = module_archive(entry["id"], version, ownership, entry)
        if archives and entry["id"] in archives:
            body = archives[entry["id"]]
            entry["size"] = len(body)
            entry["sha256"] = hashlib.sha256(body).hexdigest()
        bodies[entry["id"]] = body
    catalog_bytes = (json.dumps(document, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    signature = (
        json.dumps(
            {
                "schema_version": 1,
                "algorithm": "Ed25519",
                "key_id": "release-2026",
                "signature": base64.b64encode(key.sign(catalog_bytes)).decode("ascii"),
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n"
    ).encode("utf-8")
    responses = {
        official_release_asset_url(version, "catalog.json"): catalog_bytes,
        official_release_asset_url(version, "catalog.json.sig"): signature,
    }
    for module_id, body in bodies.items():
        responses[official_release_asset_url(version, f"xkeen-module-{module_id}-{version}.tar.gz")] = body
    responses[official_release_asset_url(version, f"xkeen-ui-panel-{version}.tar.gz")] = panel
    return Release(
        version=version,
        key=key,
        transport=ReleaseTransport(responses),
        catalog=document,
        archives=bodies,
        panel=panel,
    )


def write_release_directory(release: Release, directory: Path) -> Path:
    """Lay the release out as files: asset name → bytes, plus the public key."""

    directory.mkdir(parents=True, exist_ok=True)
    for url, body in release.transport.responses.items():
        (directory / url.rsplit("/", 1)[1]).write_bytes(body)
    (directory / "keyring.json").write_text(
        json.dumps({key_id: pem.decode("ascii") for key_id, pem in release.keyring.items()}), encoding="utf-8"
    )
    return directory


def set_mtime(path: Path, seconds: float) -> None:
    os.utime(path, (seconds, seconds))


class DirectoryTransport:
    """Release assets read from a directory by file name, as the test runner does."""

    def __init__(self, directory: Path) -> None:
        self.directory = Path(directory)

    def _read(self, url: str) -> bytes:
        try:
            return (self.directory / url.rsplit("/", 1)[1]).read_bytes()
        except OSError as error:
            raise CatalogTransportError("catalog_transport_failed", "asset is missing") from error

    def fetch_bytes(self, url: str, *, max_bytes: int, policy: FetchPolicy) -> bytes:
        return self._read(url)

    def stream_to(self, url: str, output, *, max_bytes: int, policy: FetchPolicy) -> int:
        body = self._read(url)
        output.write(body)
        return len(body)


def sign_release_directory(directory: Path) -> dict[str, bytes]:
    """Sign ``catalog.json`` of a built release with a fresh key; returns the keyring."""

    key = Ed25519PrivateKey.generate()
    catalog_bytes = (Path(directory) / "catalog.json").read_bytes()
    envelope = {
        "schema_version": 1,
        "algorithm": "Ed25519",
        "key_id": "release-2026",
        "signature": base64.b64encode(key.sign(catalog_bytes)).decode("ascii"),
    }
    (Path(directory) / "catalog.json.sig").write_text(
        json.dumps(envelope, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8"
    )
    pem = key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    (Path(directory) / "keyring.json").write_text(json.dumps({"release-2026": pem.decode("ascii")}), encoding="utf-8")
    return {"release-2026": pem}
