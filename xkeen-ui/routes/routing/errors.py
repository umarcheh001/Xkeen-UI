"""Shared payload/helpers for routing-related endpoints.

Optional module from refactor checklist (B3): keep small helper functions
outside of the blueprint wiring.
"""

from __future__ import annotations

import base64
import re
from typing import Any, Dict, Tuple



def _short_reason(text: str, *, limit: int = 200) -> str:
    s = (text or '').replace('\r', '').strip()
    if not s:
        return ''
    lines = [ln.strip() for ln in s.split('\n') if ln.strip()]
    if not lines:
        return ''
    out = ' | '.join(lines[:3])
    if len(out) > limit:
        out = out[: max(0, limit - 3)] + '...'
    return out

def _geodat_missing_bin_payload() -> Tuple[Dict[str, Any], int]:
    # Keep it 200 so the UI can show a hint instead of a generic network error.
    return {"ok": False, "error": "missing_xk_geodat"}, 200


def _geodat_error_payload(
    code: str,
    *,
    kind: str | None = None,
    path: str | None = None,
    details: str | None = None,
) -> Dict[str, Any]:
    payload: Dict[str, Any] = {"ok": False, "error": str(code or "error")}
    if kind is not None:
        payload["kind"] = str(kind)
    if path is not None:
        payload["path"] = str(path)
    if details:
        payload["details"] = str(details)

    # Friendly hints for UI
    if payload["error"] == "missing_xk_geodat":
        payload["hint"] = (
            "Не установлен xk-geodat. Нажмите «Установить xk-geodat» в карточке DAT "
            "или запустите scripts/install_xk_geodat.sh и обновите страницу."
        )
    elif payload["error"] == "missing_dat_file":
        payload["hint"] = "DAT-файл не найден. Проверьте путь и установку DAT (GeoSite/GeoIP)."
    elif payload["error"] == "xk_geodat_timeout":
        payload["hint"] = "xk-geodat не ответил вовремя. Попробуйте ещё раз или увеличьте XKEEN_GEODAT_TIMEOUT."
    elif payload["error"] == "xk_geodat_failed":
        payload["hint"] = "Ошибка выполнения xk-geodat. Проверьте логи панели и целостность DAT."
        if details:
            r = _short_reason(details)
            if r:
                payload["hint"] += " Причина: " + r

            # Extra hint for typical runtime crashes on some MIPS firmwares.
            if re.search(r"(SIGSEGV|segmentation\s+violation|SIGILL|illegal\s+instruction|futexwakeup)", details, re.IGNORECASE):
                payload["hint"] += (
                    " Похоже, установленная сборка xk-geodat несовместима с CPU/прошивкой роутера "
                    "(часто встречается на MIPS). Попробуйте переустановить xk-geodat. "
                    "Если не поможет — установите другой бинарник (mips/mipsle) или сборку с GOMIPS=softfloat через «Установить из файла»."
                )

    return payload


def _no_cache(resp: Any, notice: str | None = None, kind: str = "info") -> Any:
    """Disable HTTP caching for a Flask response.

    Also supports optional UI notice via ASCII-safe base64 header.
    """
    try:
        resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
        if notice:
            try:
                b64 = base64.b64encode(str(notice).encode("utf-8")).decode("ascii")
                resp.headers["X-XKeen-Notice-B64"] = b64
                resp.headers["X-XKeen-Notice-Kind"] = str(kind or "info")
            except Exception:
                pass
    except Exception:
        pass
    return resp
