"""Install flows shared by the panel buttons and install.sh."""

from __future__ import annotations

import os
from typing import Any, Callable

from . import engine, keys
from .errors import HappDecryptorError


def _unsupported() -> HappDecryptorError:
    return HappDecryptorError("unsupported_platform", "Для архитектуры этого роутера движок Happ не собирается.")


def _asset(platform: Callable[[], dict[str, Any]] | None) -> str:
    asset = str(((platform or engine.platform_info)() or {}).get("asset") or "")
    if not asset:
        raise _unsupported()
    return asset


def _key_verifier(bin_path: str, run) -> Callable[[str], None] | None:
    """Keys are checked by the engine when one is installed; otherwise only their structure is checked."""
    if engine.detect_kind(bin_path) != "native" or engine.version_of(bin_path, run) is None:
        return None
    return lambda staging: engine.verify_keys_with_engine(bin_path, staging, run)


def install_all(
    bin_path: str | None = None,
    *,
    with_keys: bool = True,
    fetch=None,
    run=None,
    platform: Callable[[], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Engine from the Xkeen-UI release, then (optionally) the Happ keys."""
    bin_path = bin_path or engine.default_bin_path()
    fetch = fetch or engine.fetch_url
    run = run or engine.run_command
    result: dict[str, Any] = {
        "engine": engine.install_engine(bin_path, asset=_asset(platform), fetch=fetch, run=run),
    }
    if with_keys:
        result["keys"] = update_keys(bin_path, fetch=fetch, run=run)
    return result


def install_uploaded_engine(bin_path: str | None, local_file: str, *, run=None, platform=None) -> dict[str, Any]:
    bin_path = bin_path or engine.default_bin_path()
    return {
        "engine": engine.install_engine(
            bin_path, asset=_asset(platform), run=run or engine.run_command, local_file=local_file
        ),
    }


def update_keys(bin_path: str | None = None, *, fetch=None, run=None) -> dict[str, Any]:
    """Happ keys at the commit pinned by the manifest."""
    bin_path = bin_path or engine.default_bin_path()
    fetch = fetch or engine.fetch_url
    run = run or engine.run_command
    work_dir = os.path.dirname(bin_path) or "."
    os.makedirs(work_dir, exist_ok=True)

    manifest, source = keys.resolve_manifest(fetch, work_dir)
    files = keys.download_keys(manifest, fetch, work_dir)
    installed = keys.install_key_files(
        engine.assets_dir_for(bin_path),
        files,
        meta={"source": "manifest", "repo": manifest.repo, "commit": manifest.commit},
        verify=_key_verifier(bin_path, run),
    )
    return {**installed, "manifest": {"repo": manifest.repo, "commit": manifest.commit, "source": source}}


def install_uploaded_keys(bin_path: str | None, uploads: list[tuple[str, bytes]], *, run=None) -> dict[str, Any]:
    """Key files uploaded by hand: crypt5-keys.json, legacy_keys.json or decrypt.js."""
    if not uploads:
        raise HappDecryptorError("no_files", "Выберите файл ключей Happ.")
    files: dict[str, bytes] = {}
    for filename, data in uploads:
        name, content = keys.classify_key_upload(filename, data)
        if name in files:
            raise HappDecryptorError("duplicate_key_file", f"Выбрано два файла {name} — оставьте один.")
        files[name] = content

    bin_path = bin_path or engine.default_bin_path()
    return keys.install_key_files(
        engine.assets_dir_for(bin_path),
        files,
        meta={"source": "upload"},
        verify=_key_verifier(bin_path, run or engine.run_command),
    )
