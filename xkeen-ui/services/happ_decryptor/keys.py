"""Happ key files for happ-decrypt-universal.

The keys are not ours to ship. ``keys_manifest.json`` pins the upstream commit
and the size and sha256 of every file; the installer downloads exactly those
bytes, turns ``src/decrypt.js`` into ``legacy_keys.json``, stages the result
together with the key files already in place, lets the caller check the
complete set and only then swaps the files in, keeping one ``.bak`` of each.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import re
import shutil
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from services.io.atomic import _atomic_write_json

from .errors import HappDecryptorError

CRYPT5_FILE = "crypt5-keys.json"
LEGACY_FILE = "legacy_keys.json"
META_FILE = "happ-keys.json"
KEY_FILES = (CRYPT5_FILE, LEGACY_FILE)
BUNDLED_MANIFEST_PATH = Path(__file__).resolve().with_name("keys_manifest.json")

MANIFEST_URL_ENV = "XKEEN_HAPP_KEYS_MANIFEST_URL"
# Published copy of the bundled manifest: when Happ rotates its keys, updating
# this file in the repository is enough, no panel release needed.
DEFAULT_MANIFEST_URL = (
    "https://raw.githubusercontent.com/umarcheh001/Xkeen-UI/main/xkeen-ui/services/happ_decryptor/keys_manifest.json"
)
MAX_MANIFEST_BYTES = 64 * 1024
MAX_KEY_FILE_BYTES = 4 * 1024 * 1024
LEGACY_KEY_COUNT = 4
EXTRACT_PKCS1_ARRAY = "pkcs1_keys_b64"

Fetch = Callable[[str, str, int], int]

_REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
_COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_PATH_SEGMENT_RE = re.compile(r"^[A-Za-z0-9_.-]+$")
_MARKER_RE = re.compile(r"^[A-Za-z0-9+/=_-]{8}$")
# Up to "];": the comments inside the upstream array contain "key[0]".
_PKCS1_ARRAY_RE = re.compile(r"PKCS1_KEYS_B64\s*=\s*\[(.*?)\];", re.S)
_QUOTED_BASE64_RE = re.compile(r"[\"']([A-Za-z0-9+/=\s]{100,})[\"']")


@dataclass(frozen=True)
class ManifestFile:
    name: str
    path: str
    sha256: str
    size: int
    extract: str = ""


@dataclass(frozen=True)
class Manifest:
    repo: str
    commit: str
    files: tuple[ManifestFile, ...]

    def url_for(self, item: ManifestFile) -> str:
        return f"https://raw.githubusercontent.com/{self.repo}/{self.commit}/{item.path}"


def _bad_manifest(detail: str) -> HappDecryptorError:
    return HappDecryptorError("bad_manifest", f"Манифест ключей Happ не подходит: {detail}.")


def _bad_key_file(detail: str) -> HappDecryptorError:
    return HappDecryptorError("bad_key_file", f"Файл ключей Happ не подходит: {detail}.")


def _unrecognized() -> HappDecryptorError:
    return HappDecryptorError(
        "unrecognized_key_file",
        "Это не файл ключей Happ: подходят crypt5-keys.json, legacy_keys.json или decrypt.js из happ-decryptor.",
    )


def _safe_relative_path(path: str) -> bool:
    parts = path.split("/")
    return bool(path) and all(_PATH_SEGMENT_RE.match(p) and p not in (".", "..") for p in parts)


def parse_manifest(data: Any) -> Manifest:
    if isinstance(data, (bytes, str)):
        try:
            data = json.loads(data)
        except ValueError:
            raise _bad_manifest("это не JSON") from None
    if not isinstance(data, dict) or data.get("schema") != 1:
        raise _bad_manifest("неизвестная версия схемы")

    source = data.get("source") if isinstance(data.get("source"), dict) else {}
    repo = str(source.get("repo") or "")
    commit = str(source.get("commit") or "")
    if not _REPO_RE.match(repo) or any(p in (".", "..") for p in repo.split("/")):
        raise _bad_manifest("неверный репозиторий")
    if not _COMMIT_RE.match(commit):
        raise _bad_manifest("нужен полный хэш коммита")

    raw_files = data.get("files")
    if not isinstance(raw_files, list):
        raise _bad_manifest("нет списка файлов")
    files = []
    for item in raw_files:
        if not isinstance(item, dict):
            raise _bad_manifest("неверная запись файла")
        name, path = item.get("name"), str(item.get("path") or "")
        sha256, size = str(item.get("sha256") or ""), item.get("size")
        extract = str(item.get("extract") or "")
        if name not in KEY_FILES:
            raise _bad_manifest(f"неизвестный файл {name!r}")
        if not _safe_relative_path(path):
            raise _bad_manifest(f"небезопасный путь {path!r}")
        if not _SHA256_RE.match(sha256):
            raise _bad_manifest(f"неверный sha256 у {name}")
        if not isinstance(size, int) or isinstance(size, bool) or not 0 < size <= MAX_KEY_FILE_BYTES:
            raise _bad_manifest(f"неверный размер у {name}")
        if extract not in ("", EXTRACT_PKCS1_ARRAY):
            raise _bad_manifest(f"неизвестный способ извлечения {extract!r}")
        files.append(ManifestFile(name, path, sha256, size, extract))
    if sorted(f.name for f in files) != sorted(KEY_FILES):
        raise _bad_manifest("нужно ровно по одному crypt5-keys.json и legacy_keys.json")
    return Manifest(repo, commit, tuple(files))


def load_bundled_manifest() -> Manifest:
    return parse_manifest(BUNDLED_MANIFEST_PATH.read_bytes())


def _fetch_bytes(fetch: Fetch, url: str, work_dir: str, max_bytes: int, what: str) -> bytes:
    fd, tmp = tempfile.mkstemp(prefix=".happ-download-", dir=work_dir)
    os.close(fd)
    try:
        try:
            fetch(url, tmp, max_bytes)
        except Exception as exc:
            raise HappDecryptorError(
                "download_failed",
                f"Не удалось скачать {what}. Проверьте доступ роутера к GitHub или загрузите файл вручную.",
            ) from exc
        with open(tmp, "rb") as f:
            return f.read(max_bytes + 1)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def resolve_manifest(fetch: Fetch, work_dir: str, url: str | None = None) -> tuple[Manifest, str]:
    """Return the published manifest, or the bundled one when it cannot be used."""
    url = url or str(os.environ.get(MANIFEST_URL_ENV) or "").strip() or DEFAULT_MANIFEST_URL
    try:
        return parse_manifest(_fetch_bytes(fetch, url, work_dir, MAX_MANIFEST_BYTES, "манифест ключей")), "remote"
    except HappDecryptorError:
        return load_bundled_manifest(), "bundled"


def _looks_like_der(text: Any) -> bool:
    if not isinstance(text, str):
        return False
    try:
        raw = base64.b64decode("".join(text.split()), validate=True)
    except (binascii.Error, ValueError):
        return False
    return len(raw) >= 64 and raw[0] == 0x30


def validate_crypt5_table(obj: Any) -> dict[str, str]:
    if not isinstance(obj, dict) or not obj:
        raise _bad_key_file("ожидается непустая таблица «маркер → ключ»")
    for marker, value in obj.items():
        if not _MARKER_RE.match(str(marker)):
            raise _bad_key_file(f"неверный маркер {marker!r}")
        if not _looks_like_der(value):
            raise _bad_key_file(f"неверный ключ у маркера {marker!r}")
    return obj


def validate_legacy_table(obj: Any) -> list[str]:
    if not isinstance(obj, list) or len(obj) != LEGACY_KEY_COUNT:
        raise _bad_key_file(f"ожидается список из {LEGACY_KEY_COUNT} ключей")
    for number, value in enumerate(obj, start=1):
        if not _looks_like_der(value):
            raise _bad_key_file(f"неверный ключ №{number}")
    return obj


def extract_legacy_keys(js_text: str) -> list[str]:
    match = _PKCS1_ARRAY_RE.search(js_text)
    if not match:
        raise _bad_key_file("в decrypt.js нет массива PKCS1_KEYS_B64")
    found = ["".join(k.split()) for k in _QUOTED_BASE64_RE.findall(match.group(1))]
    return validate_legacy_table(found)


def _json_bytes(obj: Any) -> bytes:
    return (json.dumps(obj, indent=2) + "\n").encode("utf-8")


def _checked_content(item: ManifestFile, data: bytes) -> bytes:
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise _bad_key_file(f"{item.path} не в UTF-8") from None
    if item.extract == EXTRACT_PKCS1_ARRAY:
        return _json_bytes(extract_legacy_keys(text))
    try:
        obj = json.loads(text)
    except ValueError:
        raise _bad_key_file(f"{item.path} не JSON") from None
    if item.name == CRYPT5_FILE:
        validate_crypt5_table(obj)
    else:
        validate_legacy_table(obj)
    return data


def download_keys(manifest: Manifest, fetch: Fetch, work_dir: str) -> dict[str, bytes]:
    """Download every manifest file, check size and sha256, return installable contents."""
    out: dict[str, bytes] = {}
    for item in manifest.files:
        data = _fetch_bytes(fetch, manifest.url_for(item), work_dir, item.size, item.path)
        if len(data) != item.size or hashlib.sha256(data).hexdigest() != item.sha256:
            raise HappDecryptorError(
                "checksum_mismatch",
                f"{item.path} из {manifest.repo} не совпал с контрольной суммой манифеста — ключи не установлены.",
            )
        out[item.name] = _checked_content(item, data)
    return out


def classify_key_upload(filename: str, data: bytes) -> tuple[str, bytes]:
    """Recognise a key file uploaded by hand; the file name is not trusted."""
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise _unrecognized() from None
    if "PKCS1_KEYS_B64" in text:
        return LEGACY_FILE, _json_bytes(extract_legacy_keys(text))
    try:
        obj = json.loads(text) if text.strip() else None
    except ValueError:
        obj = None
    if isinstance(obj, dict):
        validate_crypt5_table(obj)
        return CRYPT5_FILE, data
    if isinstance(obj, list):
        validate_legacy_table(obj)
        return LEGACY_FILE, data
    raise _unrecognized()


def read_keys_meta(assets_dir: str) -> dict[str, Any] | None:
    try:
        with open(os.path.join(assets_dir, META_FILE), "r", encoding="utf-8") as f:
            meta = json.load(f)
    except (OSError, ValueError):
        return None
    return meta if isinstance(meta, dict) else None


def install_key_files(
    assets_dir: str,
    files: dict[str, bytes],
    *,
    meta: dict[str, Any],
    verify: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """Put key files in place; ``verify`` sees the complete candidate set first."""
    unknown = set(files) - set(KEY_FILES)
    if unknown:
        raise ValueError(f"unexpected key files: {sorted(unknown)}")
    os.makedirs(assets_dir, exist_ok=True)

    staging = tempfile.mkdtemp(prefix=".staging-", dir=assets_dir)
    swapped: list[tuple[str, bool]] = []
    try:
        for name in KEY_FILES:
            candidate = os.path.join(staging, name)
            if name in files:
                with open(candidate, "wb") as f:
                    f.write(files[name])
            elif os.path.isfile(os.path.join(assets_dir, name)):
                shutil.copyfile(os.path.join(assets_dir, name), candidate)
        if verify is not None:
            verify(staging)

        for name in files:
            dest = os.path.join(assets_dir, name)
            had_old = os.path.exists(dest)
            swapped.append((name, had_old))
            if had_old:
                os.replace(dest, dest + ".bak")
            os.replace(os.path.join(staging, name), dest)
    except BaseException:
        for name, had_old in reversed(swapped):
            dest = os.path.join(assets_dir, name)
            try:
                if had_old:
                    os.replace(dest + ".bak", dest)
                elif os.path.exists(dest):
                    os.unlink(dest)
            except OSError:
                pass
        raise
    finally:
        shutil.rmtree(staging, ignore_errors=True)

    current = read_keys_meta(assets_dir) or {}
    entries = current.get("files") if isinstance(current.get("files"), dict) else {}
    installed_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    origin = {k: v for k, v in meta.items() if v not in (None, "")}
    for name, data in files.items():
        entries[name] = {
            **origin,
            "sha256": hashlib.sha256(data).hexdigest(),
            "size": len(data),
            "installed_at": installed_at,
        }
    record = {"schema": 1, "files": entries}
    _atomic_write_json(os.path.join(assets_dir, META_FILE), record)
    return {"installed": sorted(files), "meta": record}
