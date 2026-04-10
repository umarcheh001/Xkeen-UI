"""Runtime and persistence helpers for Mihomo profiles/configs.

Extracted from ``mihomo_server_core.py`` to keep parser/config-manipulation
logic separate from filesystem layout, backups and process lifecycle helpers.
"""

from __future__ import annotations

import os
import re
import shlex
import shutil
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from services.xkeen_commands_catalog import build_xkeen_cmd


def _mh_is_writable_dir(p: Path) -> bool:
    try:
        p.mkdir(parents=True, exist_ok=True)
        t = p / ".writetest"
        t.write_text("", encoding="utf-8")
        t.unlink()
        return True
    except Exception:
        return False


def _mh_default_root() -> Path:
    router = Path("/opt/etc/mihomo")
    if _mh_is_writable_dir(router):
        return router

    home = os.path.expanduser("~")
    xdg = os.environ.get("XDG_CONFIG_HOME")
    if xdg:
        base = Path(xdg) / "xkeen-ui"
    elif sys.platform == "darwin":
        base = Path(home) / "Library" / "Application Support" / "xkeen-ui"
    else:
        base = Path(home) / ".config" / "xkeen-ui"
    return base / "etc" / "mihomo"


_env_root = (os.environ.get("MIHOMO_ROOT") or "").strip()
if _env_root:
    MIHOMO_ROOT = Path(_env_root).expanduser().resolve()
else:
    MIHOMO_ROOT = _mh_default_root().resolve()

os.environ.setdefault("MIHOMO_ROOT", str(MIHOMO_ROOT))

CONFIG_PATH = MIHOMO_ROOT / "config.yaml"
PROFILES_DIR = MIHOMO_ROOT / "profiles"
BACKUP_DIR = MIHOMO_ROOT / "backup"

try:
    PROFILES_DIR.mkdir(parents=True, exist_ok=True)
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
except Exception as e:  # noqa: BLE001
    try:
        from core.logging import core_log_once

        core_log_once(
            "warning",
            "mihomo_layout_create_failed",
            "mihomo layout create failed (non-fatal)",
            error=str(e),
            mihomo_root=str(MIHOMO_ROOT),
        )
    except Exception:
        pass

MAX_BACKUPS_PER_PROFILE = int(os.environ.get("MIHOMO_MAX_BACKUPS", "20"))
RESTART_CMD = os.environ.get("MIHOMO_RESTART_CMD", shlex.join(build_xkeen_cmd("-restart")))
RESTART_TIMEOUT = int(os.environ.get("MIHOMO_RESTART_TIMEOUT", "60"))


@dataclass
class ProfileInfo:
    name: str
    path: Path
    is_active: bool


@dataclass
class BackupInfo:
    filename: str
    path: Path
    profile: str
    created_at: datetime


def ensure_mihomo_layout() -> None:
    """Ensure standard layouts and config.yaml -> active profile symlink."""
    MIHOMO_ROOT.mkdir(parents=True, exist_ok=True)
    PROFILES_DIR.mkdir(parents=True, exist_ok=True)
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)

    if CONFIG_PATH.is_symlink():
        target = CONFIG_PATH.resolve()
        if not target.exists():
            default_path = PROFILES_DIR / "default.yaml"
            if not default_path.exists():
                default_path.write_text("proxies: []\n", encoding="utf-8")
            if CONFIG_PATH.exists() or CONFIG_PATH.is_symlink():
                CONFIG_PATH.unlink()
            CONFIG_PATH.symlink_to(default_path)
        return

    default_profile = PROFILES_DIR / "default.yaml"
    if CONFIG_PATH.exists() and CONFIG_PATH.is_file():
        if not default_profile.exists():
            shutil.move(str(CONFIG_PATH), str(default_profile))
        else:
            backup_orig = PROFILES_DIR / "imported_from_config.yaml"
            shutil.move(str(CONFIG_PATH), str(backup_orig))

    if not default_profile.exists():
        default_profile.write_text("proxies: []\n", encoding="utf-8")

    if CONFIG_PATH.exists() or CONFIG_PATH.is_symlink():
        try:
            CONFIG_PATH.unlink()
        except FileNotFoundError:
            pass
    CONFIG_PATH.symlink_to(default_profile)


def _active_profile_path() -> Path:
    if CONFIG_PATH.is_symlink():
        return CONFIG_PATH.resolve()
    ensure_mihomo_layout()
    return CONFIG_PATH.resolve()


def get_active_profile_name() -> str:
    path = _active_profile_path()
    if path.parent != PROFILES_DIR:
        return path.name
    return path.name


def list_profiles() -> List[ProfileInfo]:
    ensure_mihomo_layout()
    active = _active_profile_path().name
    profiles: List[ProfileInfo] = []
    for p in sorted(PROFILES_DIR.glob("*.yaml")):
        profiles.append(ProfileInfo(name=p.name, path=p, is_active=(p.name == active)))
    return profiles


def get_profile_content(name: str) -> str:
    p = PROFILES_DIR / name
    if not p.exists():
        raise FileNotFoundError(name)
    return p.read_text(encoding="utf-8")


def create_profile(name: str, content: str) -> None:
    ensure_mihomo_layout()
    if not name.endswith(".yaml"):
        name += ".yaml"
    p = PROFILES_DIR / name
    if p.exists():
        raise FileExistsError(name)
    p.write_text(content, encoding="utf-8")


def delete_profile(name: str) -> None:
    ensure_mihomo_layout()
    p = PROFILES_DIR / name
    if not p.exists():
        return
    if p.resolve() == _active_profile_path():
        raise RuntimeError("Cannot delete active profile")
    p.unlink()


def switch_active_profile(name: str) -> None:
    ensure_mihomo_layout()
    p = PROFILES_DIR / name
    if not p.exists():
        raise FileNotFoundError(name)
    if CONFIG_PATH.exists() or CONFIG_PATH.is_symlink():
        try:
            CONFIG_PATH.unlink()
        except FileNotFoundError:
            pass
    CONFIG_PATH.symlink_to(p)


def _parse_backup_filename(path: Path) -> Optional[BackupInfo]:
    m = re.match(r"(.+?)_(\d{8})_(\d{6})\.yaml$", path.name)
    if not m:
        return None

    base = m.group(1)
    if base.endswith(".yaml"):
        profile = base
    else:
        profile = base + ".yaml"

    dt = datetime.strptime(m.group(2) + m.group(3), "%Y%m%d%H%M%S")
    return BackupInfo(filename=path.name, path=path, profile=profile, created_at=dt)


def list_backups(profile: Optional[str] = None) -> List[BackupInfo]:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    infos: List[BackupInfo] = []
    for p in BACKUP_DIR.glob("*.yaml"):
        info = _parse_backup_filename(p)
        if not info:
            continue
        if profile and info.profile != profile:
            continue
        infos.append(info)
    infos.sort(key=lambda x: x.created_at, reverse=True)
    return infos


def create_backup_for_active_profile() -> BackupInfo:
    ensure_mihomo_layout()
    active_path = _active_profile_path()
    profile_name = active_path.name
    profile_base = active_path.stem

    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_name = f"{profile_base}_{ts}.yaml"
    backup_path = BACKUP_DIR / backup_name
    shutil.copy2(active_path, backup_path)

    infos = [b for b in list_backups(profile_name) if b.filename != backup_name]
    if len(infos) >= MAX_BACKUPS_PER_PROFILE:
        for old in infos[MAX_BACKUPS_PER_PROFILE - 1 :]:
            try:
                old.path.unlink()
            except FileNotFoundError:
                pass

    return _parse_backup_filename(backup_path)  # type: ignore[return-value]


def delete_backup(filename: str) -> None:
    p = BACKUP_DIR / filename
    if p.exists():
        p.unlink()


def read_backup(filename: str) -> str:
    p = BACKUP_DIR / filename
    if not p.exists():
        raise FileNotFoundError(filename)
    return p.read_text(encoding="utf-8")


def restore_backup(filename: str) -> None:
    ensure_mihomo_layout()

    src = BACKUP_DIR / filename
    if not src.exists():
        raise FileNotFoundError(filename)

    info = _parse_backup_filename(src)
    if not info:
        raise ValueError(f"Invalid backup filename: {filename!r}")

    active_path = _active_profile_path()
    active_name = active_path.name

    if info.profile != active_name:
        raise RuntimeError(
            f"Backup {filename} belongs to profile {info.profile}, "
            f"but active profile is {active_name}. "
            "Switch active profile to the matching one and try again."
        )

    shutil.copy2(src, active_path)


def clean_backups(limit: int = 5, profile: Optional[str] = None) -> List[BackupInfo]:
    ensure_mihomo_layout()

    if limit < 0:
        raise ValueError("limit must be non-negative")

    backups = list_backups(profile)

    if limit == 0:
        keep: List[BackupInfo] = []
        to_delete = backups
    else:
        keep = backups[:limit]
        to_delete = backups[limit:]

    for b in to_delete:
        try:
            b.path.unlink()
        except FileNotFoundError:
            pass

    return keep


def save_config(new_content: str) -> BackupInfo:
    ensure_mihomo_layout()
    backup_info = create_backup_for_active_profile()
    active_path = _active_profile_path()
    active_path.write_text(new_content, encoding="utf-8")
    return backup_info


def restart_mihomo_and_get_log(new_content: Optional[str] = None) -> str:
    if new_content is not None:
        save_config(new_content)

    env = os.environ.copy()
    env.setdefault("TERM", "xterm-256color")

    try:
        proc = subprocess.run(
            RESTART_CMD,
            shell=True,
            capture_output=True,
            text=True,
            env=env,
            timeout=RESTART_TIMEOUT,
        )
        out = proc.stdout or ""
        err = proc.stderr or ""
        rc = proc.returncode
    except subprocess.TimeoutExpired as e:  # pragma: no cover
        out = (e.stdout or "") if hasattr(e, "stdout") else ""
        base_err = (e.stderr or "") if hasattr(e, "stderr") else ""
        timeout_note = f"\n[ERROR] Restart command timed out after {getattr(e, 'timeout', RESTART_TIMEOUT)} seconds"
        err = (base_err + timeout_note).lstrip("\n")
        rc = -1
    except Exception as e:  # pragma: no cover
        return f"Failed to execute restart command: {e}"

    log: list[str] = []
    log.append(f"$ {RESTART_CMD}")
    if out:
        log.append(out)
    if err:
        log.append("--- STDERR ---")
        log.append(err)
    log.append(f"\n[exit code: {rc}]\n")
    return "\n".join(log)


def validate_config(new_content: Optional[str] = None) -> str:
    ensure_mihomo_layout()

    validate_cmd_tpl = os.environ.get("MIHOMO_VALIDATE_CMD")
    root = MIHOMO_ROOT
    tmp_path: Optional[Path] = None
    try:
        if new_content is not None:
            tmp_path = root / "config-validate.yaml"
            tmp_path.write_text(new_content, encoding="utf-8")
            cfg_path = tmp_path
        else:
            cfg_path = _active_profile_path()

        if not validate_cmd_tpl:
            return (
                "MIHOMO_VALIDATE_CMD is not set.\n"
                "Please set MIHOMO_VALIDATE_CMD in the environment, for example:\n"
                "  export MIHOMO_ROOT=/opt/etc/mihomo\n"
                "  export MIHOMO_VALIDATE_CMD='mihomo -t -f {config}'\n"
            )

        cmd = validate_cmd_tpl.format(config=str(cfg_path), root=str(root))

        env = os.environ.copy()
        env.setdefault("TERM", "xterm-256color")

        try:
            proc = subprocess.run(cmd, shell=True, capture_output=True, text=True, env=env)
        except Exception as e:  # pragma: no cover
            return f"Failed to execute validation command: {e}"

        out = proc.stdout or ""
        err = proc.stderr or ""
        rc = proc.returncode

        log_lines = [f"$ {cmd}"]
        if out:
            log_lines.append(out)
        if err:
            log_lines.append("--- STDERR ---")
            log_lines.append(err)
        log_lines.append(f"\n[exit code: {rc}]\n")

        return "\n".join(log_lines)
    finally:
        if tmp_path is not None:
            try:
                tmp_path.unlink()
            except OSError:
                pass


__all__ = [
    "MIHOMO_ROOT",
    "CONFIG_PATH",
    "PROFILES_DIR",
    "BACKUP_DIR",
    "ProfileInfo",
    "BackupInfo",
    "ensure_mihomo_layout",
    "get_active_profile_name",
    "list_profiles",
    "get_profile_content",
    "create_profile",
    "delete_profile",
    "switch_active_profile",
    "list_backups",
    "create_backup_for_active_profile",
    "delete_backup",
    "read_backup",
    "restore_backup",
    "clean_backups",
    "save_config",
    "restart_mihomo_and_get_log",
    "validate_config",
]
