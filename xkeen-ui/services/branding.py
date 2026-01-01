"""Global UI branding (persisted in UI_STATE_DIR).

Branding is intentionally simple and safe to serve publicly (like /ui/custom.css)
so it can affect /login and /setup as well.

Stored as JSON: UI_STATE_DIR/branding.json

Schema (v1):
  {
    "title": "...",
    "logoSrc": "https://..." | "data:image/...",
    "faviconSrc": "https://..." | "data:image/...",
    "tabRename": { "view:mihomo": "Proxy", ... }
  }
"""

from __future__ import annotations

import base64
import json
import os
import re
import urllib.parse
from typing import Any, Dict, Tuple


DEFAULTS: Dict[str, Any] = {
    "title": "",
    "logoSrc": "",
    "faviconSrc": "",
    "tabRename": {},
}


_TITLE_MAX = 80
_LABEL_MAX = 48
_KEY_MAX = 80
_TAB_MAX = 64
_DATAURL_MAX_CHARS = 2_000_000  # 2MB (logo+favicon can be data: URIs)


_ALLOWED_DATA_MIMES: Tuple[str, ...] = (
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/gif",
    "image/webp",
    "image/x-icon",
    "image/vnd.microsoft.icon",
    "image/svg+xml",
)


def _branding_path(ui_state_dir: str) -> str:
    return os.path.join(ui_state_dir, "branding.json")


def _atomic_write_text(path: str, text: str, mode: int = 0o644) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", errors="ignore") as f:
        f.write(text)
    try:
        os.chmod(tmp, mode)
    except Exception:
        pass
    os.replace(tmp, path)


def _trim(s: Any) -> str:
    return str(s or "").strip()


def _sanitize_title(v: Any) -> str:
    s = _trim(v)
    if len(s) > _TITLE_MAX:
        s = s[:_TITLE_MAX]
    return s


def _looks_like_url(s: str) -> bool:
    if not s:
        return False
    if s.startswith("/"):
        return True
    if re.match(r"^https?://", s, re.IGNORECASE):
        return True
    if s.startswith("data:"):
        return True
    return False


def _data_url_is_safe(data_url: str) -> bool:
    """Best-effort safety check for data:image/* URLs."""
    if not data_url or not data_url.lower().startswith("data:"):
        return False
    if len(data_url) > _DATAURL_MAX_CHARS:
        return False

    # data:[<mime>][;base64],<payload>
    m = re.match(r"^data:([^,;]+)(;base64)?,(.*)$", data_url, re.IGNORECASE | re.DOTALL)
    if not m:
        return False
    mime = (m.group(1) or "").strip().lower()
    is_b64 = bool(m.group(2))
    payload = m.group(3) or ""

    if mime not in _ALLOWED_DATA_MIMES:
        return False

    # Quick string-level checks (works for non-base64 payloads)
    lowered = data_url.lower()
    if "javascript:" in lowered or "data:text/html" in lowered:
        return False

    # Inspect decoded prefix for obvious script-ish content (esp. SVG)
    try:
        sample = payload[:200_000]
        if is_b64:
            # Decode only a prefix (enough to catch <script> in most cases)
            decoded = base64.b64decode(sample + "==", validate=False)
            text = decoded[:200_000].decode("utf-8", errors="ignore").lower()
        else:
            text = urllib.parse.unquote(sample).lower()
        if "<script" in text or "</script" in text or "javascript:" in text or "onload=" in text:
            return False
    except Exception:
        # If we can't decode, keep it but only for non-SVG.
        if mime == "image/svg+xml":
            return False
    return True


def _sanitize_src(v: Any) -> str:
    s = _trim(v)
    if not s:
        return ""
    if not _looks_like_url(s):
        return ""
    if s.lower().startswith("data:"):
        return s if _data_url_is_safe(s) else ""
    # Reject obvious javascript: URLs
    if re.match(r"^javascript\s*:", s, re.IGNORECASE):
        return ""
    return s


def _sanitize_tab_rename(v: Any) -> Dict[str, str]:
    if not isinstance(v, dict):
        return {}
    out: Dict[str, str] = {}
    for k, val in list(v.items())[:_TAB_MAX]:
        kk = _trim(k)
        vv = _trim(val)
        if not kk or not vv:
            continue
        if len(kk) > _KEY_MAX:
            kk = kk[:_KEY_MAX]
        if len(vv) > _LABEL_MAX:
            vv = vv[:_LABEL_MAX]
        out[kk] = vv
    return out


def sanitize(cfg_in: Any) -> Dict[str, Any]:
    obj = cfg_in if isinstance(cfg_in, dict) else {}
    return {
        "title": _sanitize_title(obj.get("title")),
        "logoSrc": _sanitize_src(obj.get("logoSrc")),
        "faviconSrc": _sanitize_src(obj.get("faviconSrc")),
        "tabRename": _sanitize_tab_rename(obj.get("tabRename")),
    }


def branding_get(ui_state_dir: str) -> Dict[str, Any]:
    path = _branding_path(ui_state_dir)
    cfg = dict(DEFAULTS)
    exists = False

    try:
        if os.path.isfile(path):
            with open(path, "r", encoding="utf-8", errors="ignore") as f:
                raw = json.load(f)
            cfg = sanitize(raw)
            exists = True
    except Exception:
        cfg = dict(DEFAULTS)

    version = 0
    try:
        if os.path.isfile(path):
            version = int(os.path.getmtime(path) or 0)
    except Exception:
        version = 0

    return {
        "config": cfg,
        "exists": bool(exists),
        "version": version,
        "json_file": path,
    }


def branding_set(ui_state_dir: str, cfg_in: Any) -> Dict[str, Any]:
    cfg = sanitize(cfg_in)
    path = _branding_path(ui_state_dir)
    _atomic_write_text(path, json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", mode=0o644)
    return branding_get(ui_state_dir)


def branding_reset(ui_state_dir: str) -> Dict[str, Any]:
    path = _branding_path(ui_state_dir)
    try:
        if os.path.exists(path):
            os.remove(path)
    except Exception:
        pass
    return branding_get(ui_state_dir)
