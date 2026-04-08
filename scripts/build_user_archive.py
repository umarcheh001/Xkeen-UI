from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
PROJECT_DIRNAME = "xkeen-ui"
PROJECT_ROOT = REPO_ROOT / PROJECT_DIRNAME
DEFAULT_ARCHIVE_PATH = REPO_ROOT / "xkeen-ui-routing.tar.gz"
EXCLUDED_DIR_NAMES = {
    "__pycache__",
}
EXCLUDED_FILE_NAMES = {
    ".DS_Store",
    "BUILD.json",
}
EXCLUDED_FILE_SUFFIXES = {
    ".pyc",
    ".pyo",
    ".tmp",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build local xkeen-ui-routing.tar.gz from the working tree."
    )
    parser.add_argument(
        "--skip-frontend-build",
        action="store_true",
        help="Do not run `npm run frontend:build` before packaging.",
    )
    parser.add_argument(
        "--output",
        default=str(DEFAULT_ARCHIVE_PATH),
        help="Path to the output .tar.gz archive.",
    )
    parser.add_argument(
        "--sha256",
        default="",
        help="Optional path to the output .sha256 sidecar.",
    )
    parser.add_argument(
        "--version",
        default="",
        help="Optional BUILD.json version override (defaults to git short SHA).",
    )
    parser.add_argument(
        "--update-url",
        default="",
        help="Optional BUILD.json update_url value.",
    )
    return parser.parse_args()


def run_checked(cmd: list[str], *, cwd: Path) -> None:
    printable = " ".join(cmd)
    print(f"[*] {printable}", flush=True)
    executable = shutil.which(cmd[0])
    if executable is None and os.name == "nt":
        executable = shutil.which(cmd[0] + ".cmd")
    argv = [executable or cmd[0], *cmd[1:]]
    subprocess.run(argv, cwd=str(cwd), check=True)


def git_short_head(repo_root: Path) -> str:
    try:
        output = subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=str(repo_root),
            text=True,
            stderr=subprocess.DEVNULL,
        )
        value = str(output or "").strip()
        return value or "local"
    except Exception:
        return "local"


def ignore_project_entries(_src_dir: str, names: list[str]) -> set[str]:
    ignored: set[str] = set()
    for name in names:
        if name in EXCLUDED_DIR_NAMES or name in EXCLUDED_FILE_NAMES:
            ignored.add(name)
            continue
        suffix = Path(name).suffix.lower()
        if suffix in EXCLUDED_FILE_SUFFIXES:
            ignored.add(name)
    return ignored


def copy_project_tree(src_root: Path, dst_root: Path) -> None:
    shutil.copytree(
        src_root,
        dst_root,
        ignore=ignore_project_entries,
    )


def write_build_json(dst_root: Path, *, version: str, update_url: str) -> None:
    payload = {
        "version": str(version or "").strip(),
        "release_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "update_url": str(update_url or "").strip(),
    }
    path = dst_root / "BUILD.json"
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def build_archive(src_root: Path, archive_path: Path) -> None:
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive_path, "w:gz", format=tarfile.PAX_FORMAT) as tar:
        tar.add(src_root, arcname=PROJECT_DIRNAME)


def write_sha256(archive_path: Path, sha_path: Path) -> str:
    digest = hashlib.sha256(archive_path.read_bytes()).hexdigest().lower()
    sha_path.parent.mkdir(parents=True, exist_ok=True)
    sha_path.write_text(f"{digest}  {archive_path.name}", encoding="utf-8")
    return digest


def replace_file_with_retries(src: Path, dst: Path, *, attempts: int = 12, delay_s: float = 0.25) -> None:
    last_error: Exception | None = None
    for _ in range(max(1, int(attempts))):
        try:
            if dst.exists():
                dst.unlink()
            os.replace(src, dst)
            return
        except PermissionError as exc:
            last_error = exc
            time.sleep(max(0.05, float(delay_s)))
    if last_error is not None:
        raise last_error
    os.replace(src, dst)


def derive_fallback_archive_path(path: Path) -> Path:
    name = path.name
    if name.endswith(".tar.gz"):
        return path.with_name(name[:-7] + ".new.tar.gz")
    return path.with_name(path.stem + ".new" + path.suffix)


def main() -> int:
    args = parse_args()

    if not PROJECT_ROOT.is_dir():
        print(f"[!] project root not found: {PROJECT_ROOT}", file=sys.stderr)
        return 1

    archive_path = Path(args.output).resolve()
    sha_override = bool(str(args.sha256 or "").strip())
    sha_path = Path(args.sha256).resolve() if sha_override else Path(str(archive_path) + ".sha256")

    if not args.skip_frontend_build:
        run_checked(["npm", "run", "frontend:build"], cwd=REPO_ROOT)

    version = str(args.version or "").strip() or git_short_head(REPO_ROOT)
    update_url = str(args.update_url or "").strip()

    with tempfile.TemporaryDirectory(prefix="xkeen-package-", dir=str(REPO_ROOT)) as tmp_dir:
        temp_root = Path(tmp_dir)
        package_root = temp_root / PROJECT_DIRNAME
        copy_project_tree(PROJECT_ROOT, package_root)
        write_build_json(package_root, version=version, update_url=update_url)

        fd, temp_archive_raw = tempfile.mkstemp(
            prefix="xkeen-ui-routing-",
            suffix=".tar.gz",
            dir=str(archive_path.parent),
        )
        os.close(fd)
        temp_archive = Path(temp_archive_raw)
        try:
            build_archive(package_root, temp_archive)
            try:
                replace_file_with_retries(temp_archive, archive_path)
            except PermissionError:
                fallback_archive_path = derive_fallback_archive_path(archive_path)
                replace_file_with_retries(temp_archive, fallback_archive_path)
                archive_path = fallback_archive_path
                if not sha_override:
                    sha_path = Path(str(archive_path) + ".sha256")
                print(f"[!] target archive is busy, wrote fallback archive instead: {archive_path}")
        finally:
            try:
                if temp_archive.exists():
                    temp_archive.unlink()
            except Exception:
                pass

    digest = write_sha256(archive_path, sha_path)
    print(f"[*] archive: {archive_path}")
    print(f"[*] sha256: {digest}")
    print(f"[*] sha file: {sha_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
