from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Set


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
EXCLUDED_PROJECT_RELATIVE_DIRS = {
    Path("opt/etc/mihomo/backup"),
}
EXCLUDED_PROJECT_RELATIVE_FILES = {
    # Runtime-owned user configuration must never be shipped by a UI update.
    Path("opt/etc/mihomo/config.yaml"),
}
EXCLUDED_PROJECT_RELATIVE_FILE_PARENTS = {
    Path("opt/etc/mihomo/profiles"),
}
EXECUTABLE_BIN_NAMES = {
    "happ-decryptor",
    "happ_decryptor",
    "happ-decrypt-universal",
    "happ_decrypt_universal",
    "happwner",
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
        help=(
            "Optional BUILD.json version override. By default the short SHA of HEAD, "
            "suffixed with -dirty when the packed tree is ahead of that commit."
        ),
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


@dataclass(frozen=True)
class BuildStamp:
    """Identity of the code that goes into the archive.

    ``base_commit`` is only where the packaging started from.  The release
    workflow packs before committing, so the working tree is normally ahead of
    it — then ``dirty`` is true, ``commit`` is withheld and ``version`` carries
    the ``-dirty`` suffix.  Claiming the bare hash used to make BUILD.json name
    a commit that did not contain the shipped code.
    """

    version: str
    base_commit: str
    commit: Optional[str]
    dirty: bool


def _git_output(repo_root: Path, args: list[str]) -> Optional[str]:
    try:
        output = subprocess.check_output(
            ["git", *args],
            cwd=str(repo_root),
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        return None
    return str(output or "").strip()


def git_build_stamp(repo_root: Path, pathspec: Optional[str] = None) -> BuildStamp:
    """Describe the code being packed.

    ``pathspec`` narrows the dirty check to what actually goes into the archive.
    The repository also holds files that never ship — the built archive itself,
    personal notes kept out of git — and letting those mark the build dirty
    would be its own kind of lie.
    """

    short = _git_output(repo_root, ["rev-parse", "--short", "HEAD"])
    full = _git_output(repo_root, ["rev-parse", "HEAD"])
    if not short or not full:
        # No git, no commit to name: the tree hash stays the only identity.
        return BuildStamp(version="local", base_commit="local", commit=None, dirty=True)

    # --porcelain lists staged, unstaged and untracked entries alike; any line
    # at all means the packed tree is not the commit.
    args = ["status", "--porcelain", "--untracked-files=normal"]
    if pathspec:
        args += ["--", pathspec]
    status = _git_output(repo_root, args)
    if status is None:
        dirty = True
    else:
        dirty = bool(status.strip())

    if dirty:
        return BuildStamp(version=f"{short}-dirty", base_commit=short, commit=None, dirty=True)
    return BuildStamp(version=short, base_commit=short, commit=full, dirty=False)


def compute_tree_sha256(root: Path, exclude: Optional[Set[str]] = None) -> str:
    """Hash every packed file by path and content.

    Deterministic across machines and independent of timestamps, so two builds
    of the same code produce the same value — which is what lets a router be
    matched to its source when no commit describes it.
    """

    skip = set(exclude or ())
    digest = hashlib.sha256()
    for path in sorted(p for p in root.rglob("*") if p.is_file()):
        rel = path.relative_to(root).as_posix()
        if rel in skip:
            continue
        digest.update(rel.encode("utf-8"))
        digest.update(b"\0")
        digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


def ignore_project_entries(_src_dir: str, names: list[str]) -> set[str]:
    ignored: set[str] = set()
    try:
        rel_dir = Path(_src_dir).resolve().relative_to(PROJECT_ROOT)
    except ValueError:
        rel_dir = Path()
    for name in names:
        rel_path = rel_dir / name
        try:
            mode = os.lstat(Path(_src_dir) / name).st_mode
            if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode) or stat.S_ISLNK(mode)):
                ignored.add(name)
                continue
        except OSError:
            ignored.add(name)
            continue
        if rel_path in EXCLUDED_PROJECT_RELATIVE_DIRS:
            ignored.add(name)
            continue
        if (
            rel_path in EXCLUDED_PROJECT_RELATIVE_FILES
            or any(parent == rel_path or parent in rel_path.parents for parent in EXCLUDED_PROJECT_RELATIVE_FILE_PARENTS)
        ):
            ignored.add(name)
            continue
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


def write_build_json(dst_root: Path, *, stamp: BuildStamp, update_url: str) -> None:
    payload = {
        "version": str(stamp.version or "").strip(),
        "base_commit": str(stamp.base_commit or "").strip(),
        "commit": stamp.commit,
        "dirty": bool(stamp.dirty),
        # BUILD.json is written into the tree it describes, so it cannot hash itself.
        "tree_sha256": compute_tree_sha256(dst_root, exclude={"BUILD.json"}),
        "release_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "update_url": str(update_url or "").strip(),
    }
    path = dst_root / "BUILD.json"
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def build_archive(src_root: Path, archive_path: Path) -> None:
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    # Keep the release archive максимально portable for BusyBox tar on Keenetic.
    # The tree fits into classic tar limits, so we avoid PAX headers entirely.
    with tarfile.open(archive_path, "w:gz", format=tarfile.USTAR_FORMAT) as tar:
        tar.add(src_root, arcname=PROJECT_DIRNAME, filter=normalize_archive_tarinfo)


def normalize_archive_tarinfo(info: tarfile.TarInfo) -> tarfile.TarInfo:
    try:
        rel = Path(info.name).as_posix()
        if info.isfile() and rel.startswith(f"{PROJECT_DIRNAME}/bin/"):
            stem = Path(rel).name
            if stem in EXECUTABLE_BIN_NAMES:
                info.mode = 0o755
    except Exception:
        pass
    return info


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

    stamp = git_build_stamp(REPO_ROOT, pathspec=PROJECT_DIRNAME)
    override = str(args.version or "").strip()
    if override:
        stamp = BuildStamp(
            version=override,
            base_commit=stamp.base_commit,
            commit=stamp.commit,
            dirty=stamp.dirty,
        )
    update_url = str(args.update_url or "").strip()

    with tempfile.TemporaryDirectory(prefix="xkeen-package-", dir=str(REPO_ROOT)) as tmp_dir:
        temp_root = Path(tmp_dir)
        package_root = temp_root / PROJECT_DIRNAME
        copy_project_tree(PROJECT_ROOT, package_root)
        write_build_json(package_root, stamp=stamp, update_url=update_url)

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
    print(f"[*] version: {stamp.version} (base {stamp.base_commit}, dirty={str(stamp.dirty).lower()})")
    if stamp.dirty:
        print("[*] рабочее дерево впереди коммита — BUILD.json не называет коммит,")
        print("    сборку опознаёт tree_sha256 внутри архива.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
