"""Helpers for Xray GeoIP/GeoSite asset resolution.

Xray's `ext:<file>.dat:<list>` syntax loads DAT files via its *asset* lookup.
On many embedded builds, relative DAT names are resolved next to the binary
(e.g. `/opt/sbin/geosite_v2fly.dat`).

Our UI manages DAT files under `/opt/etc/xray/dat`. To keep configs portable
and avoid confusing runtime errors, we maintain symlinks from `/opt/sbin/*.dat`
to `/opt/etc/xray/dat/*.dat` (best-effort, never overwriting real files).
"""

from __future__ import annotations

import glob
import os
from dataclasses import dataclass, field
from typing import Callable, List, Optional


DiagWriter = Callable[[str], None]
LoggerFn = Callable[[str], None]


@dataclass
class XrayAssetLinkResult:
    created: List[str] = field(default_factory=list)
    updated: List[str] = field(default_factory=list)
    skipped: List[str] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)


def ensure_xray_dat_assets(
    *,
    dat_dir: str = "/opt/etc/xray/dat",
    asset_dir: str = "/opt/sbin",
    diag: Optional[DiagWriter] = None,
    log: Optional[LoggerFn] = None,
) -> XrayAssetLinkResult:
    """Ensure `/opt/sbin/*.dat` symlinks exist for all DAT files.

    This is safe to call frequently.
    - If `asset_dir/<name>.dat` exists and is NOT a symlink -> we do not touch it.
    - If it's a symlink -> we update it to point to the DAT in dat_dir.
    - If it doesn't exist -> we create a symlink.
    """

    res = XrayAssetLinkResult()

    if not os.path.isdir(dat_dir):
        res.skipped.append(f"dat_dir_missing:{dat_dir}")
        return res
    if not os.path.isdir(asset_dir):
        res.skipped.append(f"asset_dir_missing:{asset_dir}")
        return res

    def _diag(line: str) -> None:
        if diag is None:
            return
        try:
            diag(line)
        except Exception:
            return

    def _log(line: str) -> None:
        if log is None:
            return
        try:
            log(line)
        except Exception:
            return

    files = sorted(glob.glob(os.path.join(dat_dir, "*.dat")))
    if not files:
        res.skipped.append(f"no_dat_files:{dat_dir}")
        return res

    for src in files:
        try:
            base = os.path.basename(src)
            if not base:
                continue
            # Resolve symlinks in dat_dir so /opt/sbin points to the actual file.
            # This avoids "symlink to symlink" chains and surfaces broken links.
            src_real = os.path.realpath(src)
            if not os.path.exists(src_real):
                res.errors.append(f"missing:{base}")
                continue
            dst = os.path.join(asset_dir, base)

            # Never overwrite real files.
            if os.path.exists(dst) and not os.path.islink(dst):
                res.skipped.append(base)
                continue

            # Determine whether we need to (re)link.
            if os.path.islink(dst):
                try:
                    cur = os.readlink(dst)
                except Exception:
                    cur = ""
                if cur == src_real:
                    # already correct
                    continue
                try:
                    os.unlink(dst)
                except Exception:
                    # if cannot unlink, skip with error
                    res.errors.append(f"unlink_failed:{dst}")
                    continue
                os.symlink(src_real, dst)
                res.updated.append(base)
                _diag(f"[xkeen-ui] xray_assets: updated {dst} -> {src_real}")
                continue

            # Create new symlink
            os.symlink(src_real, dst)
            res.created.append(base)
            _diag(f"[xkeen-ui] xray_assets: created {dst} -> {src_real}")
        except Exception as e:
            res.errors.append(f"{os.path.basename(src)}:{e}")

    if (res.created or res.updated) and log is not None:
        _log(
            f"xray_assets: linked dat assets | created={len(res.created)}, updated={len(res.updated)}, skipped={len(res.skipped)}, errors={len(res.errors)}"
        )

    return res
