"""happ-decrypt-universal binary: which release asset fits, checks, install with backup, status."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Callable

from . import keys as happ_keys
from .errors import HappDecryptorError

BIN_NAME = "happ-decrypt-universal"
ASSET_PREFIX = BIN_NAME + "-linux-"
BIN_PATH_ENV = "XKEEN_HAPP_DECRYPTOR_BIN"
RELEASE_URL_ENV = "XKEEN_HAPP_DECRYPTOR_RELEASE_URL"
DEFAULT_RELEASE_URL = "https://github.com/umarcheh001/Xkeen-UI/releases/latest/download/"
MAX_BINARY_BYTES = 32 * 1024 * 1024
MAX_CHECKSUM_BYTES = 256 * 1024
RUN_TIMEOUT_SECONDS = 15.0
LEGACY_FORMATS = ("crypt", "crypt2", "crypt3", "crypt4")

Fetch = Callable[[str, str, int], int]
Run = Callable[[list, float], "tuple[int, str, str]"]

_ELF_MACHINE_AARCH64 = 183
_ELF_MACHINE_MIPS = 8


def default_bin_path() -> str:
    override = str(os.environ.get(BIN_PATH_ENV) or "").strip()
    if override:
        return override
    # Same place services/happ_links.py looks for a decryptor: <panel>/bin/.
    return str(Path(__file__).resolve().parents[2] / "bin" / BIN_NAME)


def assets_dir_for(bin_path: str) -> str:
    return bin_path + ".assets"


def fetch_url(url: str, dest: str, max_bytes: int) -> int:
    from services.url_policy import download_to_file_with_policy, get_policy_from_env

    return download_to_file_with_policy(
        url,
        dest,
        max_bytes,
        policy=get_policy_from_env("XKEEN_HAPP_DECRYPTOR"),
        user_agent="Xkeen-UI happ-decryptor",
        timeout=60,
    )


def run_command(argv: list, timeout: float) -> tuple[int, str, str]:
    from services.geodat.install import _apply_mips_safe_env

    proc = subprocess.run(
        [str(a) for a in argv],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
        env=_apply_mips_safe_env(os.environ.copy()),
    )
    return proc.returncode, proc.stdout or "", proc.stderr or ""


def _safe_run(run: Run, argv: list) -> tuple[int, str, str]:
    try:
        return run(argv, RUN_TIMEOUT_SECONDS)
    except Exception as exc:  # noqa: BLE001 - exec format errors, timeouts
        return 127, "", str(exc)


def release_asset(machine: str, opkg_arch: str, endian: str) -> str:
    hints = f"{machine} {opkg_arch}".lower()
    if "aarch64" in hints or "arm64" in hints:
        return ASSET_PREFIX + "arm64"
    if "mips" in hints:
        if "mipsel" in hints or "mipsle" in hints or endian == "le":
            return ASSET_PREFIX + "mipsle"
        if endian == "be":
            return ASSET_PREFIX + "mips"
        return ASSET_PREFIX + "mipsle"  # consumer MIPS routers are little-endian
    return ""


def platform_info() -> dict[str, Any]:
    from services.geodat.install import _cpu_endianness, _opkg_primary_arch

    try:
        machine = str(os.uname().machine or "")
    except (AttributeError, OSError):
        machine = ""
    opkg_arch = _opkg_primary_arch()
    endian = _cpu_endianness()
    asset = release_asset(machine, opkg_arch, endian)
    return {"arch": machine, "opkg_arch": opkg_arch, "endian": endian, "asset": asset, "supported": bool(asset)}


def elf_arch(path: str) -> str | None:
    """Architecture of an ELF file as named in release assets, or None if not ELF."""
    try:
        with open(path, "rb") as f:
            head = f.read(20)
    except OSError:
        return None
    if len(head) < 20 or head[:4] != b"\x7fELF" or head[5] not in (1, 2):
        return None
    order = "<" if head[5] == 1 else ">"
    machine = struct.unpack(order + "H", head[18:20])[0]
    if machine == _ELF_MACHINE_AARCH64 and head[4] == 2:
        return "arm64"
    if machine == _ELF_MACHINE_MIPS and head[4] == 1:
        return "mipsle" if order == "<" else "mips"
    return f"machine-{machine}"


def parse_sha256sums(text: str, asset: str) -> str | None:
    for line in text.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) != 2:
            continue
        digest, name = parts[0].lower(), parts[1].strip().lstrip("*")
        if re.fullmatch(r"[0-9a-f]{64}", digest) and name.rsplit("/", 1)[-1] == asset:
            return digest
    return None


def detect_kind(bin_path: str) -> str:
    if not os.path.isfile(bin_path):
        return "missing"
    try:
        with open(bin_path, "rb") as f:
            head = f.read(160)
    except OSError:
        return "other"
    if head[:4] == b"\x7fELF":
        return "native"
    first_line = head.split(b"\n", 1)[0]
    if first_line.startswith(b"#!") and b"node" in first_line:
        return "node"
    return "other"


def version_of(bin_path: str, run: Run) -> str | None:
    rc, out, _err = _safe_run(run, [bin_path, "-version"])
    lines = (out or "").strip().splitlines()
    first = lines[0].strip() if lines else ""
    return first if rc == 0 and first.startswith(BIN_NAME + " ") else None


def _sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(256 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _published_sha256(fetch: Fetch, base: str, asset: str, work_dir: str) -> str:
    """sha256 of the asset from the release: SHA256SUMS first, then <asset>.sha256."""
    for name in ("SHA256SUMS", asset + ".sha256"):
        fd, tmp = tempfile.mkstemp(prefix=".happ-checksum-", dir=work_dir)
        os.close(fd)
        try:
            fetch(base + name, tmp, MAX_CHECKSUM_BYTES)
            with open(tmp, "r", encoding="utf-8", errors="replace") as f:
                text = f.read()
        except Exception:  # noqa: BLE001 - a missing file just means "try the next one"
            continue
        finally:
            try:
                os.unlink(tmp)
            except OSError:
                pass
        if name == "SHA256SUMS":
            digest = parse_sha256sums(text, asset)
        else:
            first = (text.split() or [""])[0].lower()
            digest = first if re.fullmatch(r"[0-9a-f]{64}", first) else None
        if digest:
            return digest
    raise HappDecryptorError(
        "checksum_missing",
        "В релизе нет контрольной суммы движка Happ — без неё установка не выполняется.",
    )


def install_engine(
    bin_path: str,
    *,
    asset: str,
    release_base: str = "",
    fetch: Fetch | None = None,
    run: Run | None = None,
    local_file: str | None = None,
) -> dict[str, Any]:
    """Download (or take ``local_file``), check, run once, then replace ``bin_path`` keeping ``.bak``."""
    fetch = fetch or fetch_url
    run = run or run_command
    expected_arch = asset[len(ASSET_PREFIX):] if asset.startswith(ASSET_PREFIX) else ""
    if not expected_arch:
        raise HappDecryptorError("unsupported_platform", "Для архитектуры этого роутера движок Happ не собирается.")

    directory = os.path.dirname(bin_path) or "."
    os.makedirs(directory, exist_ok=True)
    fd, candidate = tempfile.mkstemp(prefix=f".{BIN_NAME}.", suffix=".part", dir=directory)
    os.close(fd)
    try:
        if local_file:
            shutil.copyfile(local_file, candidate)
        else:
            base = release_base or str(os.environ.get(RELEASE_URL_ENV) or "").strip() or DEFAULT_RELEASE_URL
            base = base if base.endswith("/") else base + "/"
            try:
                fetch(base + asset, candidate, MAX_BINARY_BYTES)
            except Exception as exc:
                raise HappDecryptorError(
                    "download_failed",
                    f"Не удалось скачать {asset} из релиза Xkeen-UI. Проверьте доступ роутера к GitHub.",
                ) from exc
            if _sha256_file(candidate) != _published_sha256(fetch, base, asset, directory):
                raise HappDecryptorError(
                    "checksum_mismatch",
                    "Скачанный движок Happ не совпал с контрольной суммой релиза — установка остановлена.",
                )

        arch = elf_arch(candidate)
        if arch is None:
            raise HappDecryptorError(
                "not_elf",
                "Получен не исполняемый файл — возможно, вместо движка пришла страница блокировки.",
            )
        if arch != expected_arch:
            raise HappDecryptorError("wrong_arch", f"Файл собран для {arch}, а роутеру нужен {expected_arch}.")

        os.chmod(candidate, 0o755)
        version = version_of(candidate, run)
        if version is None:
            raise HappDecryptorError("sanity_failed", "Движок Happ не запустился на этом роутере.")

        backup = None
        if os.path.exists(bin_path):
            backup = bin_path + ".bak"
            os.replace(bin_path, backup)
        try:
            os.replace(candidate, bin_path)
        except OSError as exc:
            if backup:
                os.replace(backup, bin_path)
            raise HappDecryptorError("install_failed", "Не удалось поставить движок Happ на место.") from exc
        return {"path": bin_path, "asset": asset, "version": version, "backup": backup}
    finally:
        if os.path.exists(candidate):
            try:
                os.unlink(candidate)
            except OSError:
                pass


def selftest(bin_path: str, assets_dir: str, run: Run) -> dict[str, Any] | None:
    _rc, out, _err = _safe_run(run, [bin_path, "-selftest", "-assets", assets_dir])
    try:
        report = json.loads(out)
    except ValueError:
        return None
    return report if isinstance(report, dict) else None


def verify_keys_with_engine(bin_path: str, staging_dir: str, run: Run) -> None:
    """Raise unless the engine reads every present key file without errors."""
    report = selftest(bin_path, staging_dir, run)
    if not report:
        raise HappDecryptorError("keys_check_failed", "Движок Happ не смог проверить ключи.")
    formats = set(report.get("formats") or [])
    required: list[str] = []
    any_present = False
    for section, needs in (("crypt5_keys", ("crypt5",)), ("legacy_keys", LEGACY_FORMATS)):
        rep = report.get(section) if isinstance(report.get(section), dict) else {}
        if not rep.get("present"):
            continue
        any_present = True
        if rep.get("error") or rep.get("invalid"):
            raise HappDecryptorError("keys_check_failed", "Движок Happ не принял часть ключей — файлы не установлены.")
        required.extend(needs)
    missing = [f for f in required if f not in formats]
    if not any_present or missing:
        raise HappDecryptorError("keys_check_failed", "Движок Happ не принял ключи — файлы не установлены.")


def status(bin_path: str, run: Run, platform: dict[str, Any] | None = None) -> dict[str, Any]:
    kind = detect_kind(bin_path)
    assets = assets_dir_for(bin_path)
    version = version_of(bin_path, run) if kind == "native" else None
    return {
        "path": bin_path,
        "kind": kind,
        "installed": version is not None,
        "version": version,
        "assets_dir": assets,
        "keys": selftest(bin_path, assets, run) if version else None,
        "keys_meta": happ_keys.read_keys_meta(assets),
        "platform": platform if platform is not None else platform_info(),
        "cmd_override": bool(str(os.environ.get("XKEEN_HAPP_DECRYPTOR_CMD") or "").strip()),
    }
