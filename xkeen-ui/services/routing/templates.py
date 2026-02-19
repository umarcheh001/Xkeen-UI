"""Routing templates + routing fragment path helpers.

This module is intentionally Flask-agnostic and contains only helper
functions (no Flask request/response handling).

Moved from routes_routing.py as part of refactor checklist (B3 step 4).
"""

from __future__ import annotations

import json
import os
import re
from typing import Dict, Optional, Tuple

from services.xray_config_files import legacy_jsonc_path_for, resolve_jsonc_path


_TEMPLATE_HEADER_RE = re.compile(r"^\s*//\s*xkeen-template:\s*(\{.*\})\s*$")
_SAFE_TEMPLATE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def _parse_template_header(text: str) -> Dict[str, str]:
    """Parse xkeen-template header from JSONC template text."""
    if not text:
        return {}
    try:
        # Only look at the first few lines
        lines = text.splitlines()[:8]
    except Exception:
        return {}
    for ln in lines:
        m = _TEMPLATE_HEADER_RE.match(ln)
        if not m:
            # Skip empty lines and plain comments
            continue
        raw = m.group(1)
        try:
            obj = json.loads(raw)
            if not isinstance(obj, dict):
                return {}
            title = str(obj.get("title") or "").strip()
            desc = str(obj.get("description") or "").strip()
            out: Dict[str, str] = {}
            if title:
                out["title"] = title
            if desc:
                out["description"] = desc
            return out
        except Exception:
            return {}
    return {}


def _read_template_file_meta(path: str) -> Dict[str, str]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            head = f.read(4096)
    except Exception:
        return {}
    return _parse_template_header(head)


def _strip_existing_template_header(content: str) -> str:
    """Remove existing xkeen-template header at the very top to avoid duplicates."""
    if not isinstance(content, str):
        return ""
    lines = content.splitlines()
    if not lines:
        return content
    # remove BOM if present
    if lines and lines[0].startswith("\ufeff"):
        lines[0] = lines[0].lstrip("\ufeff")
    # Drop first matching header line (only if it appears before any JSON content)
    if _TEMPLATE_HEADER_RE.match(lines[0] or ""):
        return "\n".join(lines[1:]).lstrip("\n")
    return content


def _seed_routing_templates_once(routing_templates_dir: str) -> None:
    """Seed built-in templates into routing_templates_dir only once.

    We intentionally avoid re-seeding on every service restart so that user
    deletions/changes persist.
    """
    try:
        os.makedirs(routing_templates_dir, exist_ok=True)
    except Exception:
        return

    marker = os.path.join(routing_templates_dir, ".xkeen_seeded")
    try:
        if os.path.exists(marker):
            return
    except Exception:
        return

    # bundled templates directory inside the UI repo
    try:
        # This file lives in xkeen-ui/services/routing/templates.py
        # so repo root is 3 levels up.
        repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        bundled = os.path.join(repo_root, "opt", "etc", "xray", "templates", "routing")
    except Exception:
        bundled = ""

    if not bundled or not os.path.isdir(bundled):
        return

    try:
        for fname in os.listdir(bundled):
            if not (fname.endswith(".json") or fname.endswith(".jsonc")):
                continue
            src = os.path.join(bundled, fname)
            dst = os.path.join(routing_templates_dir, fname)
            if os.path.exists(dst):
                continue
            try:
                with open(src, "rb") as rf:
                    data = rf.read()
                with open(dst, "wb") as wf:
                    wf.write(data)
            except Exception:
                continue
    except Exception:
        return

    # Create marker so we don't seed again.
    try:
        with open(marker, "w", encoding="utf-8") as f:
            f.write("seeded\n")
    except Exception:
        pass


def _paths_for_routing(
    routing_file: str,
    routing_file_raw: str,
    xray_configs_dir: str,
    xray_configs_dir_real: str,
    file_arg: Optional[str] = None,
) -> Tuple[str, str, str]:
    """Resolve routing fragment paths (clean JSON + raw JSONC).

    - Default: routing_file + canonical JSONC sidecar in XRAY_JSONC_DIR.
    - If file_arg is provided (basename or absolute path under configs dir),
      use that file as clean JSON.
    - Raw JSONC sidecar always lives in XRAY_JSONC_DIR and is mapped by
      basename (<file>.json -> <XRAY_JSONC_DIR>/<file>.jsonc).
    - If file_arg ends with .jsonc, treat it as a selection hint and map clean
      to .json (legacy compatibility).

    Returns:
      (clean_path, raw_path, legacy_raw_path)
    """
    raw_override = os.environ.get("XKEEN_XRAY_ROUTING_FILE_RAW", "")

    if not file_arg:
        clean_path = routing_file
        raw_path = resolve_jsonc_path(raw_override, main_json_abs_path=clean_path)
        legacy_raw_path = legacy_jsonc_path_for(clean_path)
        return clean_path, raw_path, legacy_raw_path

    try:
        v = str(file_arg or "").strip()
    except Exception:
        v = ""
    if not v:
        clean_path = routing_file
        raw_path = resolve_jsonc_path(raw_override, main_json_abs_path=clean_path)
        legacy_raw_path = legacy_jsonc_path_for(clean_path)
        return clean_path, raw_path, legacy_raw_path

    # Allow absolute path, but only inside xray_configs_dir
    if os.path.isabs(v):
        cand = v
    else:
        # For safety disallow nested paths like a/b.json
        if "/" in v or "\\" in v:
            raise ValueError("invalid filename")
        cand = os.path.join(xray_configs_dir, v)

    cand_real = os.path.realpath(cand)

    base = xray_configs_dir_real
    if not base:
        # If caller did not pass base, still try to constrain to realpath of dir
        try:
            base = os.path.realpath(xray_configs_dir)
        except Exception:
            base = ""

    # Ensure it's inside configs dir
    if base:
        if not (cand_real == base or cand_real.startswith(base + os.sep)):
            raise ValueError("outside configs dir")

    if not (cand_real.endswith(".json") or cand_real.endswith(".jsonc")):
        raise ValueError("unsupported extension")

    # Select clean JSON (always inside XRAY_CONFIGS_DIR). Raw JSONC lives in UI
    # sidecar dir (XRAY_JSONC_DIR) and is mapped by basename.
    if cand_real.endswith(".jsonc"):
        clean_path = cand_real[:-1]  # .jsonc -> .json
    else:
        clean_path = cand_real

    raw_path = resolve_jsonc_path(raw_override, main_json_abs_path=clean_path)
    legacy_raw_path = legacy_jsonc_path_for(clean_path)

    return clean_path, raw_path, legacy_raw_path


def _normalize_template_filename(raw: str) -> str:
    name = str(raw or "").strip()
    name = re.sub(r"\s+", "_", name)
    # no path traversal
    if not name or "/" in name or "\\" in name or "\x00" in name:
        return ""
    # default extension
    if not (name.endswith(".json") or name.endswith(".jsonc")):
        name = name + ".jsonc"
    base = name
    if base.endswith(".jsonc"):
        base = base[:-6]
    elif base.endswith(".json"):
        base = base[:-5]
    if not _SAFE_TEMPLATE_NAME_RE.match(base):
        return ""
    return name


def _compose_template_text(title: str, desc: str, content: str) -> str:
    body = _strip_existing_template_header(content)
    t = str(title or "").strip()
    d = str(desc or "").strip()
    if not t and not d:
        return body
    meta_obj: Dict[str, str] = {}
    if t:
        meta_obj["title"] = t
    if d:
        meta_obj["description"] = d
    header = "// xkeen-template: " + json.dumps(meta_obj, ensure_ascii=False)
    return header + "\n" + body.lstrip("\n")
