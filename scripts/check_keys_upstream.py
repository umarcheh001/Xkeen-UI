"""Compare the pinned key manifest with the author's main branch; ``--update`` re-pins it.

Run from the repository root at the start of a working session:

    python scripts/check_keys_upstream.py            # 0 unchanged, 1 changed, 2 error
    python scripts/check_keys_upstream.py --update   # pin keys_manifest.json to the author's latest commit

After ``--update`` commit ``keys_manifest.json`` and push it to main: panels take the
published manifest on "update keys", no panel release is needed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
import urllib.request
from pathlib import Path
from typing import Callable, TextIO

ROOT = Path(__file__).resolve().parents[1]
APP_DIR = ROOT / "xkeen-ui"
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

from services.happ_decryptor import keys  # noqa: E402
from services.happ_decryptor.errors import HappDecryptorError  # noqa: E402

DEFAULT_MANIFEST = keys.BUNDLED_MANIFEST_PATH
MAX_API_BYTES = 256 * 1024
_COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")

Get = Callable[[str, int], bytes]


def http_get(url: str, max_bytes: int) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "xkeen-ui-keys-check"})
    with urllib.request.urlopen(request, timeout=30) as response:
        data = response.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise OSError(f"ответ больше {max_bytes} байт: {url}")
    return data


def _raw_url(repo: str, ref: str, path: str) -> str:
    return f"https://raw.githubusercontent.com/{repo}/{ref}/{path}"


def changed_files(manifest: keys.Manifest, get: Get, ref: str) -> list[keys.ManifestFile]:
    changed = []
    for item in manifest.files:
        data = get(_raw_url(manifest.repo, ref, item.path), keys.MAX_KEY_FILE_BYTES)
        if len(data) != item.size or hashlib.sha256(data).hexdigest() != item.sha256:
            changed.append(item)
    return changed


def latest_commit(repo: str, get: Get, ref: str) -> str:
    info = json.loads(get(f"https://api.github.com/repos/{repo}/commits/{ref}", MAX_API_BYTES))
    sha = str(info.get("sha") or "") if isinstance(info, dict) else ""
    if not _COMMIT_RE.match(sha):
        raise ValueError(f"GitHub не вернул хэш коммита для {repo}@{ref}")
    return sha


def manifest_text(manifest: keys.Manifest) -> str:
    files = []
    for item in manifest.files:
        entry = {"name": item.name, "path": item.path, "sha256": item.sha256, "size": item.size}
        if item.extract:
            entry["extract"] = item.extract
        files.append(entry)
    raw = {"schema": 1, "source": {"repo": manifest.repo, "commit": manifest.commit}, "files": files}
    return json.dumps(raw, indent=2) + "\n"


def repin(manifest: keys.Manifest, get: Get, ref: str) -> keys.Manifest:
    """Manifest for the author's latest commit, accepted only if the panel could install its keys."""
    commit = latest_commit(manifest.repo, get, ref)
    fetched: dict[str, bytes] = {}
    files = []
    for item in manifest.files:
        url = _raw_url(manifest.repo, commit, item.path)
        data = get(url, keys.MAX_KEY_FILE_BYTES)
        fetched[url] = data
        files.append(keys.ManifestFile(item.name, item.path, hashlib.sha256(data).hexdigest(), len(data), item.extract))
    candidate = keys.parse_manifest(json.loads(manifest_text(keys.Manifest(manifest.repo, commit, tuple(files)))))

    def serve(url: str, dest: str, max_bytes: int) -> int:
        Path(dest).write_bytes(fetched[url])
        return len(fetched[url])

    with tempfile.TemporaryDirectory(prefix="keys-check-") as work_dir:
        keys.download_keys(candidate, serve, work_dir)
    return candidate


def _write_atomically(path: Path, text: str) -> None:
    fd, tmp = tempfile.mkstemp(prefix="." + path.name + ".", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _reason(exc: BaseException) -> str:
    return str(getattr(exc, "message", "") or exc)


def main(argv: list[str] | None = None, *, get: Get | None = None, out: TextIO | None = None) -> int:
    out = out or sys.stdout
    get = get or http_get
    parser = argparse.ArgumentParser(description="Сравнить закреплённые ключи с веткой автора.")
    parser.add_argument("--manifest", default=str(DEFAULT_MANIFEST))
    parser.add_argument("--ref", default="main")
    parser.add_argument("--update", action="store_true", help="закрепить последний коммит автора")
    args = parser.parse_args(argv)
    path = Path(args.manifest)

    try:
        manifest = keys.parse_manifest(path.read_bytes())
        changed = changed_files(manifest, get, args.ref)
    except (OSError, ValueError, HappDecryptorError) as exc:
        print(f"Ошибка: не удалось сравнить ключи с веткой автора: {_reason(exc)}", file=out)
        return 2

    if not changed:
        print(f"Ключи у автора не менялись: {manifest.repo}@{args.ref} совпадает с коммитом {manifest.commit[:12]}.", file=out)
        return 0

    names = ", ".join(item.name for item in changed)
    if not args.update:
        print(f"Ключи у автора изменились: {names}.", file=out)
        print("Обновить манифест: python scripts/check_keys_upstream.py --update", file=out)
        return 1

    try:
        updated = repin(manifest, get, args.ref)
        _write_atomically(path, manifest_text(updated))
    except (OSError, ValueError, KeyError, HappDecryptorError) as exc:
        print(f"Ошибка: манифест не обновлён ({names}): {_reason(exc)}", file=out)
        return 2

    print(f"Манифест обновлён: {manifest.commit[:12]} -> {updated.commit[:12]}, изменились: {names}.", file=out)
    print(f"Закоммитьте {path.name} и отправьте в main: панели получат ключи по кнопке обновления ключей.", file=out)
    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
