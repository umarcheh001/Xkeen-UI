"""Слепок и проверка для операций, которые переписывают конфиги Xray.

Один порядок для всех, кто правит каталог конфигов: снять слепок, внести
правки, спросить у ядра ``xray -test``, при отказе вернуть слепок.  Слепок
живёт ровно одну операцию -- это откат при сбое, а не копия «на потом».

Два хранилища под один и тот же смысл:

* на диске (``snapshot`` / ``restore_snapshot``) -- для редких операций, после
  которых полезно найти следы и после перезапуска панели;
* в памяти (``MemoryGuard``) -- для частых, вроде обновления подписок по
  расписанию: лишняя запись на флеш роутера там ничего не даёт.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
import time
import uuid
from typing import Any, Dict, Iterable, Optional

from services.io.atomic import _atomic_write_json


TRANSACTIONS_KEEP = 10
_TXID_RE = re.compile(r"^\d{8}-\d{6}-[0-9a-f]{8}$")


def xray_binary() -> str:
    if os.path.exists("/opt/sbin/xray"):
        return "/opt/sbin/xray"
    return str(shutil.which("xray") or "")


def check_timeout() -> int:
    try:
        return max(10, int(os.environ.get("XKEEN_XRAY_TEST_TIMEOUT", "30")))
    except (TypeError, ValueError):
        return 30


def check_confdir(confdir: str, *, xray: Optional[str] = None, timeout: Optional[int] = None) -> Dict[str, Any]:
    """Спросить у ядра, примет ли оно каталог конфигов.

    ``ok`` -- ``True`` (принял), ``False`` (отклонил, причина в ``details``)
    или ``None``: спросить не удалось (ядра нет, оно не ответило вовремя, не
    запустилось).  Отличать «отклонил» от «не спросили» -- дело вызывающего:
    откатывать работу из-за медленного роутера незачем.
    """
    binary = xray_binary() if xray is None else str(xray or "")
    if not binary:
        return {"ok": None, "reason": "xray_missing", "details": ""}
    env = os.environ.copy()
    asset_dir = str(os.environ.get("XRAY_LOCATION_ASSET") or "/opt/etc/xray/dat")
    if os.path.isdir(asset_dir):
        env["XRAY_LOCATION_ASSET"] = asset_dir
        env["xray.location.asset"] = asset_dir
    try:
        proc = subprocess.run(
            [binary, "-test", "-confdir", confdir],
            capture_output=True,
            text=True,
            timeout=check_timeout() if timeout is None else timeout,
            check=False,
            env=env,
        )
    except subprocess.TimeoutExpired:
        return {"ok": None, "reason": "timeout", "details": ""}
    except Exception as exc:
        return {"ok": None, "reason": "failed_to_run", "details": str(exc)}
    if proc.returncode != 0:
        return {
            "ok": False,
            "reason": "rejected",
            "details": (proc.stderr or proc.stdout or "").strip()[-4000:],
        }
    return {"ok": True, "reason": "", "details": "", "stdout": (proc.stdout or "").strip()[-1000:]}


def stage_confdir(configs_dir: str, replacements: Dict[str, Optional[Dict[str, Any]]], tmpdir: str) -> None:
    """Собрать во временном каталоге то, что получится после записи."""
    for name in os.listdir(configs_dir):
        src = os.path.join(configs_dir, name)
        dst = os.path.join(tmpdir, name)
        if os.path.isdir(src) and not os.path.islink(src):
            # Backups are not part of the Xray confdir model.
            if name == "backups":
                continue
            shutil.copytree(src, dst, symlinks=True)
        else:
            shutil.copy2(src, dst, follow_symlinks=False)
    for name, obj in replacements.items():
        path = os.path.join(tmpdir, os.path.basename(name))
        if obj is None:
            try:
                os.remove(path)
            except FileNotFoundError:
                pass
        else:
            _atomic_write_json(path, obj)


def check_staged(
    configs_dir: str,
    replacements: Dict[str, Optional[Dict[str, Any]]],
    *,
    xray: Optional[str] = None,
    prefix: str = "xkeen-xray-check-",
) -> Dict[str, Any]:
    """``check_confdir`` для каталога, каким он станет после записи."""
    with tempfile.TemporaryDirectory(prefix=prefix) as tmpdir:
        stage_confdir(configs_dir, replacements, tmpdir)
        return check_confdir(tmpdir, xray=xray)


def prune_transactions(root: str, keep: int = TRANSACTIONS_KEEP) -> None:
    try:
        names = sorted(name for name in os.listdir(root) if _TXID_RE.match(name))
    except OSError:
        return
    for name in names[:-keep] if keep > 0 else names:
        shutil.rmtree(os.path.join(root, name), ignore_errors=True)


def snapshot(paths: Iterable[str], root: str, *, keep: int = TRANSACTIONS_KEEP) -> tuple[str, Dict[str, Any]]:
    txid = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8]
    directory = os.path.join(root, txid)
    os.makedirs(directory, exist_ok=True)
    manifest: Dict[str, Any] = {"id": txid, "created_at": int(time.time()), "files": []}
    for idx, path in enumerate(paths):
        exists = os.path.isfile(path)
        item: Dict[str, Any] = {"path": path, "exists": exists, "backup": ""}
        if exists:
            backup = os.path.join(directory, f"{idx:02d}-{os.path.basename(path)}")
            shutil.copy2(path, backup)
            item["backup"] = backup
        manifest["files"].append(item)
    _atomic_write_json(os.path.join(directory, "manifest.json"), manifest)
    prune_transactions(root, keep)
    return directory, manifest


def restore_snapshot(manifest: Dict[str, Any]) -> None:
    for item in manifest.get("files", []):
        path = str(item.get("path") or "")
        if not path:
            continue
        if item.get("exists"):
            os.makedirs(os.path.dirname(path), exist_ok=True)
            shutil.copy2(str(item.get("backup") or ""), path)
        else:
            try:
                os.remove(path)
            except FileNotFoundError:
                pass


class MemoryGuard:
    """Байтовая копия всего, что операция может переписать.

    Каталоги запоминаются целиком: файл, которого в них не было, при возврате
    удаляется -- иначе после отката в каталоге конфигов остался бы фрагмент,
    который ядро прочтёт.
    """

    def __init__(self, dirs: Iterable[str] = (), paths: Iterable[str] = ()):
        self._dirs = [path for path in dict.fromkeys(dirs) if path and os.path.isdir(path)]
        self._paths = [path for path in dict.fromkeys(paths) if path]
        self._snap: Dict[str, Optional[bytes]] = {}
        for directory in self._dirs:
            for name in os.listdir(directory):
                path = os.path.join(directory, name)
                if os.path.isfile(path):
                    self._snap[path] = self._read(path)
        for path in self._paths:
            self._snap[path] = self._read(path)

    def retake(self) -> "MemoryGuard":
        """Новый слепок тех же мест -- какими они стали к этому моменту."""
        return MemoryGuard(dirs=self._dirs, paths=self._paths)

    @staticmethod
    def _read(path: str) -> Optional[bytes]:
        try:
            with open(path, "rb") as handle:
                return handle.read()
        except FileNotFoundError:
            return None

    def restore(self) -> None:
        for directory in self._dirs:
            for name in os.listdir(directory):
                path = os.path.join(directory, name)
                if os.path.isfile(path) and path not in self._snap:
                    os.remove(path)
        for path, data in self._snap.items():
            if data is None:
                try:
                    os.remove(path)
                except FileNotFoundError:
                    pass
            elif self._read(path) != data:
                temp = f"{path}.{uuid.uuid4().hex}.tmp"
                with open(temp, "wb") as handle:
                    handle.write(data)
                os.replace(temp, path)
