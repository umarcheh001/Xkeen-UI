from __future__ import annotations

"""Runner/validator helpers for xk-geodat."""

import json
import os
import re
import subprocess
from typing import Any, Dict, Tuple

from services.fs_common.local import _local_allowed_roots, _local_resolve
from services.geodat.install import _geodat_stat_meta


def _json_extract(text: str) -> Any:
    """Parse JSON even if stdout has extra lines."""
    s = (text or '').strip()
    if not s:
        raise ValueError('empty')
    try:
        return json.loads(s)
    except Exception:
        pass
    # best-effort: find first JSON object/array.
    for ch in ('{', '['):
        i = s.find(ch)
        if i >= 0:
            try:
                return json.loads(s[i:])
            except Exception:
                continue
    raise ValueError('bad_json')


def _geodat_bin_path() -> str:
    return (os.getenv('XKEEN_GEODAT_BIN', '') or '').strip() or '/opt/etc/xkeen-ui/bin/xk-geodat'


def _geodat_timeout_s() -> int:
    raw = (os.getenv('XKEEN_GEODAT_TIMEOUT', '') or '').strip()
    try:
        v = int(float(raw))
    except Exception:
        v = 25
    return max(3, min(v, 120))


_CRASH_RE = re.compile(
    r"(SIGSEGV|segmentation\s+violation|SIGILL|illegal\s+instruction|SIGBUS|bus\s+error|futexwakeup)",
    re.IGNORECASE,
)


def _is_mips_platform() -> bool:
    """Best-effort: detect MIPS-like routers.

    We keep this heuristic intentionally broad; it's used only to apply safe
    runtime env tweaks for xk-geodat.
    """
    try:
        m = (os.uname().machine or '').lower()
    except Exception:
        m = ''
    return 'mips' in m


def _merge_env(base: dict[str, str], extra: dict[str, str]) -> dict[str, str]:
    env = dict(base or {})
    for k, v in (extra or {}).items():
        if v is None:
            continue
        env[str(k)] = str(v)
    return env


def _append_godebug(env: dict[str, str], token: str) -> None:
    """Append a token to GODEBUG if it's not already present."""
    if not token:
        return
    gd = (env.get('GODEBUG', '') or '').strip()
    if token in gd:
        return
    env['GODEBUG'] = (gd + (',' if gd else '') + token)


def _apply_mips_safe_env(env: dict[str, str]) -> dict[str, str]:
    """Apply safe defaults for Go runtime on some MIPS firmwares.

    Some older/quirky kernels have issues with Go's async preemption/runtime
    scheduling. Disabling async preemption + limiting procs makes xk-geodat
    dramatically more stable on affected devices.
    """
    if not _is_mips_platform():
        return env
    env2 = dict(env)
    _append_godebug(env2, 'asyncpreemptoff=1')
    env2.setdefault('GOMAXPROCS', '1')
    return env2


def _geodat_cache_ttl_s() -> int:
    raw = (os.getenv('XKEEN_GEODAT_CACHE_TTL', '') or '').strip()
    try:
        v = int(float(raw))
    except Exception:
        v = 60
    return max(0, min(v, 600))


def _geodat_validate(kind: str, path: str) -> Tuple[str, str, Dict[str, Any]]:
    k = (kind or '').strip().lower()
    if k not in ('geosite', 'geoip'):
        raise ValueError('bad_kind')
    p = (path or '').strip()
    if not p:
        raise ValueError('path_required')
    if not p.lower().endswith('.dat'):
        raise ValueError('path_must_end_with_dat')

    roots = _local_allowed_roots()
    rp = _local_resolve(p, roots)
    if not os.path.isfile(rp):
        raise FileNotFoundError('missing_dat_file')
    meta = _geodat_stat_meta(rp)
    return k, rp, meta


def _run_xk_geodat_json(argv: list[str], *, timeout_s: int) -> Any:
    """Run xk-geodat and return parsed JSON."""

    def _run(env: dict[str, str]):
        return subprocess.run(
            argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
            timeout=max(1, int(timeout_s or 20)),
        )

    env0 = _apply_mips_safe_env(os.environ.copy())
    p = _run(env0)
    out = (p.stdout or '').strip()
    err = (p.stderr or '').strip()

    # Workaround for binaries that vendor go4.org/unsafe/assume-no-moving-gc.
    # When built with newer Go, they may panic at init unless
    # ASSUME_NO_MOVING_GC_UNSAFE_RISK_IT_WITH is set.
    if p.returncode != 0:
        comb = (err + "\n" + out).strip()

        # Workaround for binaries that vendor go4.org/unsafe/assume-no-moving-gc.
        m = re.search(r"ASSUME_NO_MOVING_GC_UNSAFE_RISK_IT_WITH=(go\d+\.\d+)", comb)
        if m and "ASSUME_NO_MOVING_GC_UNSAFE_RISK_IT_WITH" not in env0:
            env1 = env0.copy()
            env1["ASSUME_NO_MOVING_GC_UNSAFE_RISK_IT_WITH"] = m.group(1)
            p2 = _run(env1)
            out2 = (p2.stdout or '').strip()
            err2 = (p2.stderr or '').strip()
            if p2.returncode == 0:
                p, out, err = p2, out2, err2
                comb = (err + "\n" + out).strip()
            else:
                comb2 = (err2 + "\n" + out2).strip()
                # If the retry crashes in Go runtime, try a safer env.
                if _CRASH_RE.search(comb2):
                    env3 = _apply_mips_safe_env(env1)
                    p3 = _run(env3)
                    out3 = (p3.stdout or '').strip()
                    err3 = (p3.stderr or '').strip()
                    if p3.returncode == 0:
                        p, out, err = p3, out3, err3
                    else:
                        raise RuntimeError(f"exit_{p3.returncode}: {err3 or out3}")
                else:
                    raise RuntimeError(f"exit_{p2.returncode}: {err2 or out2}")

        # If it looks like a Go runtime crash (SIGSEGV/SIGILL/futexwakeup), retry with safer env.
        if p.returncode != 0 and _CRASH_RE.search(comb):
            env4 = _apply_mips_safe_env(env0)
            p4 = _run(env4)
            out4 = (p4.stdout or '').strip()
            err4 = (p4.stderr or '').strip()
            if p4.returncode == 0:
                p, out, err = p4, out4, err4
            else:
                raise RuntimeError(f"exit_{p4.returncode}: {err4 or out4}")

        # Still failing.
        if p.returncode != 0:
            raise RuntimeError(f"exit_{p.returncode}: {err or out}")

    try:
        return _json_extract(out)
    except Exception as e:
        raise RuntimeError(f"bad_json: {e}; stderr={err}")
