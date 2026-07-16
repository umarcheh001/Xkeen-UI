"""Server-side saved drafts and optimistic concurrency for mobile Xray routing.

The web routing endpoint writes directly to the live fragment.  The native client needs a safer
two-step workflow: ``save`` persists a private server draft, while ``apply`` validates that exact
saved revision, writes the live fragment and restarts xkeen.  Content hashes are opaque revision
tokens and prevent a stale phone or an external editor from silently overwriting newer work.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
import threading
from typing import Any, Callable

from services.io.atomic import _atomic_write_json, _atomic_write_text
from utils.jsonc import strip_json_comments_text


_WRITE_LOCK = threading.RLock()


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _revision(content: str) -> str:
    return "sha256:" + hashlib.sha256(content.encode("utf-8")).hexdigest()


def _read_text(path: str) -> str:
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()


def _json_objects_equal(main_text: str, raw_text: str) -> bool:
    try:
        return json.loads(main_text or "{}") == json.loads(strip_json_comments_text(raw_text) or "{}")
    except Exception:
        return False


@dataclass(frozen=True)
class MobileRoutingSnapshot:
    document: str
    published_content: str
    published_revision: str
    published_at: str
    uses_jsonc: bool
    saved_content: str
    saved_revision: str
    draft_base_revision: str
    saved_at: str
    has_saved_draft: bool
    conflict_code: str | None = None
    conflict_message: str | None = None

    def to_payload(self) -> dict[str, Any]:
        conflict = None
        if self.conflict_code:
            conflict = {
                "code": self.conflict_code,
                "message": self.conflict_message or "Routing-документ изменён на сервере.",
            }
        return {
            "document": self.document,
            "published": {
                "content": self.published_content,
                "revision": self.published_revision,
                "modified_at": self.published_at,
                "uses_jsonc": self.uses_jsonc,
            },
            "saved": {
                "content": self.saved_content,
                "revision": self.saved_revision,
                "base_revision": self.draft_base_revision,
                "saved_at": self.saved_at,
                "present": self.has_saved_draft,
            },
            "conflict": conflict,
        }


class MobileRoutingConflict(Exception):
    def __init__(self, code: str, message: str, snapshot: MobileRoutingSnapshot):
        super().__init__(message)
        self.code = code
        self.snapshot = snapshot


class MobileRoutingValidationFailure(Exception):
    def __init__(self, message: str, *, code: str, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.details = details or {}


class MobileRoutingOperationFailure(Exception):
    def __init__(self, message: str, *, code: str, snapshot: MobileRoutingSnapshot | None = None):
        super().__init__(message)
        self.code = code
        self.snapshot = snapshot


class MobileRoutingService:
    def __init__(
        self,
        *,
        ui_state_dir: str,
        routing_file: str,
        routing_file_raw: str,
        xray_configs_dir: str,
        xray_configs_dir_real: str,
        paths_for_routing: Callable[..., tuple[str, str, str]],
        run_preflight: Callable[..., dict[str, Any]],
        snapshot_before_overwrite: Callable[[str], None],
        restart_xkeen: Callable[..., bool],
    ):
        self.ui_state_dir = ui_state_dir
        self.routing_file = routing_file
        self.routing_file_raw = routing_file_raw
        self.xray_configs_dir = xray_configs_dir
        self.xray_configs_dir_real = xray_configs_dir_real
        self.paths_for_routing = paths_for_routing
        self.run_preflight = run_preflight
        self.snapshot_before_overwrite = snapshot_before_overwrite
        self.restart_xkeen = restart_xkeen

    def get(self, document: str) -> MobileRoutingSnapshot:
        with _WRITE_LOCK:
            return self._snapshot(document)

    def save(
        self,
        *,
        document: str,
        content: str,
        expected_published_revision: str,
        expected_saved_revision: str,
    ) -> MobileRoutingSnapshot:
        with _WRITE_LOCK:
            current = self._snapshot(document)
            self._require_expected_revisions(
                current,
                expected_published_revision=expected_published_revision,
                expected_saved_revision=expected_saved_revision,
            )
            self._validate(document, content)

            draft_path = self._draft_path(document)
            if content == current.published_content:
                self._remove_file(draft_path)
            else:
                _atomic_write_json(
                    draft_path,
                    {
                        "version": 1,
                        "document": document,
                        "content": content,
                        "revision": _revision(content),
                        "base_revision": current.published_revision,
                        "saved_at": _utc_now(),
                    },
                    mode=0o600,
                )
            return self._snapshot(document)

    def apply(
        self,
        *,
        document: str,
        expected_published_revision: str,
        expected_saved_revision: str,
    ) -> MobileRoutingSnapshot:
        with _WRITE_LOCK:
            current = self._snapshot(document)
            self._require_expected_revisions(
                current,
                expected_published_revision=expected_published_revision,
                expected_saved_revision=expected_saved_revision,
            )
            if not current.has_saved_draft:
                raise MobileRoutingOperationFailure(
                    "На сервере нет сохранённого routing-черновика для применения.",
                    code="nothing_to_apply",
                    snapshot=current,
                )
            if current.draft_base_revision != current.published_revision:
                raise MobileRoutingConflict(
                    "saved_published_conflict",
                    "Опубликованный routing изменился после сохранения черновика.",
                    current,
                )

            content = current.saved_content
            parsed = self._validate(document, content)
            sel_main, sel_raw, sel_raw_legacy = self._paths(document)
            originals = self._capture_paths(sel_main, sel_raw)
            for path in (sel_main, sel_raw):
                if os.path.exists(path):
                    self.snapshot_before_overwrite(path)

            try:
                _atomic_write_json(sel_main, parsed)
                _atomic_write_text(sel_raw, content)
            except Exception as exc:
                self._restore_paths(originals)
                raise MobileRoutingOperationFailure(
                    "Не удалось записать routing-конфигурацию на сервере.",
                    code="routing_write_failed",
                    snapshot=current,
                ) from exc

            restarted = False
            try:
                restarted = bool(self.restart_xkeen(source="mobile-routing-apply"))
            except Exception:
                restarted = False
            if not restarted:
                self._restore_paths(originals)
                try:
                    self.restart_xkeen(source="mobile-routing-rollback")
                except Exception:
                    pass
                raise MobileRoutingOperationFailure(
                    "Xkeen не подтвердил перезапуск; прежний routing восстановлен.",
                    code="routing_restart_failed",
                    snapshot=self._snapshot(document),
                )

            if sel_raw_legacy and sel_raw_legacy != sel_raw:
                self._remove_file(sel_raw_legacy)
            self._remove_file(self._draft_path(document))
            return self._snapshot(document)

    def _snapshot(self, document: str) -> MobileRoutingSnapshot:
        sel_main, sel_raw, sel_raw_legacy = self._paths(document)
        published_content, uses_jsonc, published_at = self._load_published(
            sel_main,
            sel_raw,
            sel_raw_legacy,
        )
        published_revision = _revision(published_content)
        record = self._load_draft(document)
        saved_content = published_content
        saved_revision = published_revision
        base_revision = published_revision
        saved_at = published_at
        has_saved_draft = False
        conflict_code = None
        conflict_message = None
        if record is not None:
            saved_content = str(record.get("content") or "")
            saved_revision = str(record.get("revision") or _revision(saved_content))
            base_revision = str(record.get("base_revision") or "")
            saved_at = str(record.get("saved_at") or "")
            has_saved_draft = True
            if base_revision != published_revision:
                conflict_code = "saved_published_conflict"
                conflict_message = "Опубликованный routing изменился после сохранения черновика."
        return MobileRoutingSnapshot(
            document=document,
            published_content=published_content,
            published_revision=published_revision,
            published_at=published_at,
            uses_jsonc=uses_jsonc,
            saved_content=saved_content,
            saved_revision=saved_revision,
            draft_base_revision=base_revision,
            saved_at=saved_at,
            has_saved_draft=has_saved_draft,
            conflict_code=conflict_code,
            conflict_message=conflict_message,
        )

    def _require_expected_revisions(
        self,
        snapshot: MobileRoutingSnapshot,
        *,
        expected_published_revision: str,
        expected_saved_revision: str,
    ) -> None:
        if snapshot.published_revision != expected_published_revision:
            raise MobileRoutingConflict(
                "published_revision_conflict",
                "Routing-файл был изменён вне этого черновика. Загружено актуальное состояние сервера.",
                snapshot,
            )
        if snapshot.saved_revision != expected_saved_revision:
            raise MobileRoutingConflict(
                "saved_revision_conflict",
                "Сохранённый routing-черновик уже изменён другим клиентом.",
                snapshot,
            )

    def _validate(self, document: str, content: str) -> Any:
        try:
            parsed = json.loads(strip_json_comments_text(content))
        except json.JSONDecodeError as exc:
            raise MobileRoutingValidationFailure(
                "Сервер не смог разобрать JSON/JSONC.",
                code="invalid_json",
                details={"line": exc.lineno, "column": exc.colno},
            ) from exc
        except Exception as exc:
            raise MobileRoutingValidationFailure(
                "Сервер не смог разобрать JSON/JSONC.",
                code="invalid_json",
            ) from exc

        sel_main, _sel_raw, _legacy = self._paths(document)
        preflight = self.run_preflight(
            xray_configs_dir_real=self.xray_configs_dir_real,
            sel_main=sel_main,
            obj=parsed,
            sync_dat_assets=False,
        )
        if not isinstance(preflight, dict) or not preflight.get("ok"):
            details = preflight if isinstance(preflight, dict) else {}
            message = str(details.get("summary") or details.get("hint") or "Xray preflight не пройден.")
            raise MobileRoutingValidationFailure(
                message,
                code="xray_preflight_failed",
                details=details,
            )
        return parsed

    def _paths(self, document: str) -> tuple[str, str, str]:
        try:
            return self.paths_for_routing(
                self.routing_file,
                self.routing_file_raw,
                self.xray_configs_dir,
                self.xray_configs_dir_real,
                document,
            )
        except Exception as exc:
            raise MobileRoutingOperationFailure(
                "Выбранный routing-документ недоступен.",
                code="invalid_document",
            ) from exc

    def _load_published(
        self,
        sel_main: str,
        sel_raw: str,
        sel_raw_legacy: str,
    ) -> tuple[str, bool, str]:
        raw_path = sel_raw if os.path.isfile(sel_raw) else (
            sel_raw_legacy if sel_raw_legacy and os.path.isfile(sel_raw_legacy) else ""
        )
        main_exists = os.path.isfile(sel_main)
        if not main_exists and not raw_path:
            raise MobileRoutingOperationFailure(
                "Routing-документ не найден на сервере.",
                code="document_not_found",
            )

        chosen = sel_main
        uses_jsonc = False
        if raw_path:
            chosen = raw_path
            uses_jsonc = True
            if main_exists:
                try:
                    if os.stat(sel_main).st_mtime_ns > os.stat(raw_path).st_mtime_ns:
                        main_text = _read_text(sel_main)
                        raw_text = _read_text(raw_path)
                        if not _json_objects_equal(main_text, raw_text):
                            chosen = sel_main
                            uses_jsonc = False
                except Exception:
                    pass

        content = _read_text(chosen)
        modified = datetime.fromtimestamp(os.path.getmtime(chosen), timezone.utc)
        modified_at = modified.isoformat(timespec="seconds").replace("+00:00", "Z")
        return content, uses_jsonc, modified_at

    def _draft_path(self, document: str) -> str:
        key = hashlib.sha256(document.encode("utf-8")).hexdigest()[:32]
        return os.path.join(self.ui_state_dir, "mobile-routing-drafts", key + ".json")

    def _load_draft(self, document: str) -> dict[str, Any] | None:
        path = self._draft_path(document)
        try:
            with open(path, "r", encoding="utf-8") as handle:
                value = json.load(handle)
            if isinstance(value, dict) and value.get("document") == document:
                return value
        except Exception:
            pass
        return None

    @staticmethod
    def _capture_paths(*paths: str) -> dict[str, str | None]:
        captured: dict[str, str | None] = {}
        for path in paths:
            captured[path] = _read_text(path) if os.path.isfile(path) else None
        return captured

    @staticmethod
    def _restore_paths(captured: dict[str, str | None]) -> None:
        for path, content in captured.items():
            if content is None:
                MobileRoutingService._remove_file(path)
            else:
                _atomic_write_text(path, content)

    @staticmethod
    def _remove_file(path: str) -> None:
        try:
            if path and os.path.exists(path):
                os.remove(path)
        except Exception:
            pass
