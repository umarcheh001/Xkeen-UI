"""Helpers for Mihomo config backups API (list, get, restore, clean)."""

from typing import Any, Dict, List, Optional

from mihomo_server_core import (
    list_backups as _mh_list_backups,
    read_backup as _mh_read_backup,
    restore_backup as _mh_restore_backup,
    clean_backups as _mh_clean_backups,
    delete_backup as _mh_delete_backup,
)


def list_backups_for_profile(profile: Optional[str] = None) -> List[Dict[str, Any]]:
    """Return JSON-serializable backup info list for given profile (or all)."""
    infos = _mh_list_backups(profile)
    result: List[Dict[str, Any]] = []
    for b in infos:
        result.append(
            {
                "filename": b.filename,
                "profile": b.profile,
                "created_at": b.created_at.isoformat(),
            }
        )
    return result


def get_backup_content(filename: str) -> str:
    """Return raw text content of a Mihomo backup by filename.

    May raise FileNotFoundError propagated to caller.
    """
    return _mh_read_backup(filename)


def restore_backup_file(filename: str) -> None:
    """Restore a Mihomo config backup by filename.

    May raise FileNotFoundError or RuntimeError propagated to caller.
    """
    _mh_restore_backup(filename)


def delete_backup_file(filename: str) -> None:
    """Delete a Mihomo config backup by filename.

    Deletion is idempotent: missing files are ignored.
    """
    _mh_delete_backup(filename)


def clean_backups_for_api(limit: int, profile: Optional[str]) -> Dict[str, Any]:
    """Perform backup cleanup and return JSON-serializable result structure.

    Mirrors previous api_mihomo_backups_clean response shape.
    """
    infos = _mh_clean_backups(limit, profile)
    return {
        "ok": True,
        "limit": limit,
        "profile": profile,
        "remaining": [
            {
                "filename": b.filename,
                "profile": b.profile,
                "created_at": b.created_at.isoformat(),
            }
            for b in infos
        ],
    }
