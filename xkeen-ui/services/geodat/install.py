from __future__ import annotations

"""Helpers for installing/checking xk-geodat binary."""

import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from typing import Any, Dict, Tuple


_CRASH_RE = re.compile(
    r"(SIGSEGV|segmentation\s+violation|SIGILL|illegal\s+instruction|SIGBUS|bus\s+error|futexwakeup)",
    re.IGNORECASE,
)


def _is_mips_platform() -> bool:
    try:
        m = (os.uname().machine or '').lower()
    except Exception:
        m = ''
    return 'mips' in m

def _opkg_primary_arch() -> str:
    """Return best-effort opkg primary arch (if opkg exists)."""
    try:
        p = subprocess.run(
            ["opkg", "print-architecture"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=3,
        )
    except Exception:
        return ""
    if p.returncode != 0:
        return ""
    # Lines look like: "arch all 1" or "arch mipsel_24kc 10"
    candidates: list[str] = []
    for ln in (p.stdout or "").splitlines():
        ln = (ln or "").strip()
        if not ln.startswith("arch "):
            continue
        parts = ln.split()
        if len(parts) >= 3:
            candidates.append(parts[1])
    # Prefer a specific arch over "all"/"noarch".
    for a in candidates:
        al = (a or "").lower()
        if al and al not in ("all", "noarch"):
            return a
    return candidates[0] if candidates else ""


def _cpu_endianness() -> str:
    """Return 'le' / 'be' or '' if unknown."""
    try:
        if os.path.exists("/proc/cpuinfo"):
            data = open("/proc/cpuinfo", "r", encoding="utf-8", errors="ignore").read().lower()
            if "little endian" in data:
                return "le"
            if "big endian" in data:
                return "be"
            # Some kernels use "byte order	: little endian"
            if "byte order" in data and "little" in data:
                return "le"
            if "byte order" in data and "big" in data:
                return "be"
    except Exception:
        pass

    # Fallback: use Python runtime native byteorder.
    try:
        bo = str(getattr(sys, "byteorder", "") or "").lower()
        if bo.startswith("little"):
            return "le"
        if bo.startswith("big"):
            return "be"
    except Exception:
        pass

    return ""




def geodat_platform_info() -> Dict[str, Any]:
    """Detect platform info relevant for xk-geodat binary selection.

    Returns a dict with:
      - arch / opkg_arch / endian
      - asset: suggested GitHub release asset name
      - supported: whether the project publishes this asset
      - note: UI-friendly explanation when unsupported/ambiguous
    """
    arch = ""
    try:
        arch = str(os.uname().machine or "")
    except Exception:
        arch = ""
    arch_l = arch.lower()

    opkg_arch = _opkg_primary_arch()
    opkg_l = (opkg_arch or "").lower()
    endian = _cpu_endianness()

    supported_assets = {
        "xk-geodat-linux-arm64",
        "xk-geodat-linux-mipsle",
    }

    asset = ""
    note = ""

    # ARM64 / AArch64
    if "aarch64" in arch_l or "arm64" in arch_l or "aarch64" in opkg_l or "arm64" in opkg_l:
        asset = "xk-geodat-linux-arm64"
    # MIPS family
    elif "mips" in arch_l or "mips" in opkg_l:
        # If we can detect little-endian, use mipsle.
        if ("mipsel" in arch_l) or ("mipsle" in arch_l) or ("mipsel" in opkg_l) or ("mipsle" in opkg_l) or endian == "le":
            asset = "xk-geodat-linux-mipsle"
        # Explicit big-endian hints -> asset would be "mips" (unsupported in this project).
        elif endian == "be":
            asset = "xk-geodat-linux-mips"
        else:
            # Ambiguous "mips" without endianness. Most consumer routers are little-endian,
            # but we avoid hard assumptions in the UI; installer may still try mipsle.
            asset = "xk-geodat-linux-mipsle"
            note = "MIPS без явной эндийности (предполагаем mipsle); если установка не удаётся — проверьте byte order в /proc/cpuinfo."
    else:
        note = f"Неизвестная архитектура: {arch or 'unknown'}"

    supported = bool(asset and asset in supported_assets)
    if asset == "xk-geodat-linux-mips":
        note = "Обнаружен MIPS big-endian (mips). Для этой архитектуры xk-geodat не публикуется (поддерживаются arm64/aarch64 и mipsle/mipsel)."

    return {
        "arch": arch,
        "opkg_arch": opkg_arch,
        "endian": endian,
        "asset": asset,
        "supported": supported,
        "supported_assets": sorted(supported_assets),
        "note": note,
    }


def _append_godebug(env: Dict[str, str], token: str) -> None:
    if not token:
        return
    gd = (env.get('GODEBUG', '') or '').strip()
    if token in gd:
        return
    env['GODEBUG'] = (gd + (',' if gd else '') + token)


def _apply_mips_safe_env(env: Dict[str, str]) -> Dict[str, str]:
    if not _is_mips_platform():
        return env
    env2 = dict(env)
    _append_godebug(env2, 'asyncpreemptoff=1')
    env2.setdefault('GOMAXPROCS', '1')
    return env2


def _geodat_stat_meta(path: str) -> Dict[str, Any]:
    st = os.stat(path)
    return {
        'size': int(getattr(st, 'st_size', 0) or 0),
        'mtime': int(getattr(st, 'st_mtime', 0) or 0),
    }


def _is_elf_binary(path: str) -> bool:
    try:
        with open(path, "rb") as f:
            magic = f.read(4)
        return magic == b"\x7fELF"
    except Exception:
        return False


def _looks_like_shell_syntax_error(text: str) -> bool:
    s = (text or "").lower()
    return ("syntax error" in s) or ("unexpected" in s and "expecting" in s)

def _download_to_file(url: str, tmp_path: str, max_bytes: int | None) -> int:
    """Download URL to tmp_path with an optional size cap (bytes)."""
    req = urllib.request.Request(url, headers={"User-Agent": "Xkeen-UI"})
    with urllib.request.urlopen(req, timeout=45) as resp:
        status = getattr(resp, "status", None)
        if isinstance(status, int) and status >= 400:
            raise RuntimeError(f"http_{status}")
        try:
            length = resp.headers.get("Content-Length")
            if length is not None and max_bytes is not None and int(length) > max_bytes:
                raise RuntimeError("size_limit")
        except ValueError:
            pass

        total = 0
        with open(tmp_path, "wb") as f:
            while True:
                chunk = resp.read(256 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if max_bytes is not None and total > max_bytes:
                    raise RuntimeError("size_limit")
                f.write(chunk)
    return total


def _geodat_install_script_path() -> str:
    return (os.getenv('XKEEN_GEODAT_INSTALL_SCRIPT', '') or '').strip() or '/opt/etc/xkeen-ui/scripts/install_xk_geodat.sh'


def _geodat_run_help(bin_path: str) -> Tuple[bool, str]:
    """Return (ok_installed, help_text_tail).

    Best-effort sanity check. Some builds exit non-zero on --help, so we treat
    them as installed unless it's an execution/format error.
    """

    if not _is_elf_binary(bin_path):
        return False, "not_elf"

    def _run(env: dict[str, str]):
        return subprocess.run(
            [bin_path, "--help"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
            timeout=3,
        )

    env0 = _apply_mips_safe_env(os.environ.copy())
    p = _run(env0)
    out = (p.stdout or "").strip()
    err = (p.stderr or "").strip()
    comb = (out + "\n" + err).strip()

    if p.returncode != 0:
        if _looks_like_shell_syntax_error(comb):
            return False, comb[:800]

        m = re.search(r"ASSUME_NO_MOVING_GC_UNSAFE_RISK_IT_WITH=(go\d+\.\d+)", comb)
        if m and "ASSUME_NO_MOVING_GC_UNSAFE_RISK_IT_WITH" not in env0:
            env1 = env0.copy()
            env1["ASSUME_NO_MOVING_GC_UNSAFE_RISK_IT_WITH"] = m.group(1)
            p2 = _run(env1)
            out2 = (p2.stdout or "").strip()
            err2 = (p2.stderr or "").strip()
            comb2 = (out2 + "\n" + err2).strip()

            if _looks_like_shell_syntax_error(comb2):
                return False, comb2[:800]
            if _CRASH_RE.search(comb2):
                return False, comb2[:800]
            if p2.returncode in (126, 127) or "Exec format error" in comb2 or "not found" in comb2:
                return False, comb2[:800]
            return True, (comb2 or comb)[:800]

        # Non-fatal: some builds exit non-zero on --help.
        if _CRASH_RE.search(comb):
            return False, comb[:800]
        if p.returncode in (126, 127) or "Exec format error" in comb or "not found" in comb:
            return False, comb[:800]
        return True, comb[:800]

    return True, (comb or out or err)[:800]


