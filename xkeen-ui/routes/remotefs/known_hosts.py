"""/api/remotefs/known_hosts* endpoints.

Extracted from routes_remotefs.py.
"""

from __future__ import annotations

import base64
import hashlib
import os
import subprocess
from typing import Any, Callable, Dict, List, Tuple

from flask import Blueprint, jsonify, request

from routes.common.errors import error_response as _error_response


def _ssh_key_fingerprint_sha256(key_b64: str) -> str:
    """Compute OpenSSH-like SHA256 fingerprint from base64 key blob."""
    try:
        blob = base64.b64decode((key_b64 or "").encode("ascii"), validate=False)
        h = hashlib.sha256(blob).digest()
        return "SHA256:" + base64.b64encode(h).decode("ascii").rstrip("=")
    except Exception:
        return ""


def _read_known_hosts_entries(ensure_known_hosts_file: Callable[[str], str], path: str) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    try:
        ensure_known_hosts_file(path)
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.read().splitlines()
    except Exception:
        return out

    for idx, raw in enumerate(lines):
        line = (raw or "").strip()
        if not line or line.startswith("#"):
            continue
        # known_hosts format: hosts keytype key [comment]
        parts = line.split()
        if len(parts) < 3:
            out.append(
                {
                    "idx": idx,
                    "hosts": parts[0] if parts else "",
                    "key_type": parts[1] if len(parts) > 1 else "",
                    "fingerprint": "",
                    "comment": " ".join(parts[3:]) if len(parts) > 3 else "",
                    "raw": raw,
                    "bad": True,
                }
            )
            continue
        hosts, key_type, key_b64 = parts[0], parts[1], parts[2]
        fp = _ssh_key_fingerprint_sha256(key_b64)
        out.append(
            {
                "idx": idx,
                "hosts": hosts,
                "key_type": key_type,
                "fingerprint": fp,
                "comment": " ".join(parts[3:]) if len(parts) > 3 else "",
                "raw": raw,
                "hashed": hosts.startswith("|1|"),
                "bad": False if fp else True,
            }
        )
    return out


def _read_all_lines(ensure_known_hosts_file: Callable[[str], str], path: str) -> List[str]:
    try:
        ensure_known_hosts_file(path)
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read().splitlines()
    except Exception:
        return []


def _write_all_lines(ensure_known_hosts_file: Callable[[str], str], path: str, lines: List[str]) -> None:
    ensure_known_hosts_file(path)
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + ("\n" if lines else ""))
    try:
        os.chmod(path, 0o600)
    except Exception:
        pass


def register_known_hosts_endpoints(
    bp: Blueprint,
    *,
    require_enabled: Callable[[], Any | None],
    mgr: Any,
    ensure_known_hosts_file: Callable[[str], str],
    core_log: Callable[..., None] | None = None,
    error_response=_error_response,
) -> None:
    def _log(level: str, msg: str, **extra) -> None:
        try:
            if callable(core_log):
                core_log(level, msg, **extra)
        except Exception:
            pass

    @bp.get("/api/remotefs/known_hosts")
    def api_remotefs_known_hosts_list() -> Any:
        if (resp := require_enabled()) is not None:
            return resp
        kh = (mgr.known_hosts_path or "").strip()
        if not kh:
            return error_response("known_hosts_unavailable", 404, ok=False)
        entries = _read_known_hosts_entries(ensure_known_hosts_file, kh)
        return jsonify({"ok": True, "path": kh, "entries": entries})

    @bp.get("/api/remotefs/known_hosts/fingerprint")
    def api_remotefs_known_hosts_fingerprint() -> Any:
        if (resp := require_enabled()) is not None:
            return resp
        kh = (mgr.known_hosts_path or "").strip()
        if not kh:
            return error_response("known_hosts_unavailable", 404, ok=False)
        host = str(request.args.get("host", "") or "").strip()
        if not host:
            return error_response("host_required", 400, ok=False)
        port_raw = str(request.args.get("port", "") or "").strip()
        try:
            port = int(port_raw) if port_raw else 22
        except Exception:
            port = 22

        want_tokens = set()
        if port and int(port) != 22:
            want_tokens.add(f"[{host}]:{int(port)}")
        want_tokens.add(host)

        matches: List[Dict[str, Any]] = []
        for e in _read_known_hosts_entries(ensure_known_hosts_file, kh):
            hosts_field = str(e.get("hosts") or "")
            tokens = set([t.strip() for t in hosts_field.split(",") if t.strip()])
            if tokens & want_tokens:
                matches.append(
                    {
                        "idx": e.get("idx"),
                        "hosts": hosts_field,
                        "key_type": e.get("key_type"),
                        "fingerprint": e.get("fingerprint"),
                        "comment": e.get("comment"),
                    }
                )

        return jsonify({"ok": True, "path": kh, "host": host, "port": port, "matches": matches})

    @bp.post("/api/remotefs/known_hosts/clear")
    def api_remotefs_known_hosts_clear() -> Any:
        if (resp := require_enabled()) is not None:
            return resp
        kh = (mgr.known_hosts_path or "").strip()
        if not kh:
            return error_response("known_hosts_unavailable", 404, ok=False)
        try:
            ensure_known_hosts_file(kh)
            with open(kh, "w", encoding="utf-8") as f:
                f.write("")
            try:
                os.chmod(kh, 0o600)
            except Exception:
                pass
            _log("info", "remotefs.known_hosts_clear", path=kh, remote_addr=str(request.remote_addr or ""))
            return jsonify({"ok": True, "path": kh})
        except Exception:
            return error_response("clear_failed", 500, ok=False)

    @bp.post("/api/remotefs/known_hosts/delete")
    def api_remotefs_known_hosts_delete() -> Any:
        if (resp := require_enabled()) is not None:
            return resp
        kh = (mgr.known_hosts_path or "").strip()
        if not kh:
            return error_response("known_hosts_unavailable", 404, ok=False)

        data = request.get_json(silent=True) or {}
        idx = data.get("idx", None)
        host = str(data.get("host", "") or "").strip()
        port = data.get("port", None)

        # Prefer robust deletion by host (handles hashed entries) if host provided.
        if host:
            target = host
            if port is not None:
                try:
                    p = int(port)
                    if p != 22:
                        target = f"[{host}]:{p}"
                except Exception:
                    target = host

            before = _read_all_lines(ensure_known_hosts_file, kh)
            before_n = len(before)

            # 1) Try ssh-keygen -R (best effort, supports hashed entries)
            try:
                subprocess.run(
                    ["ssh-keygen", "-R", target, "-f", kh],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                after = _read_all_lines(ensure_known_hosts_file, kh)
                deleted_count = max(0, before_n - len(after))
                try:
                    os.chmod(kh, 0o600)
                except Exception:
                    pass
                return jsonify(
                    {
                        "ok": True,
                        "path": kh,
                        "target": target,
                        "deleted_count": deleted_count,
                        "method": "ssh-keygen",
                    }
                )
            except Exception:
                pass

            # 2) Fallback: remove non-hashed entries by token match in the hosts field.
            deleted_count = 0
            new_lines: List[str] = []
            for raw in before:
                line = (raw or "").strip()
                if not line or line.startswith("#"):
                    new_lines.append(raw)
                    continue
                parts = line.split()
                if not parts:
                    new_lines.append(raw)
                    continue
                hosts_field = parts[0]
                tokens = [t.strip() for t in hosts_field.split(",") if t.strip()]
                if target in tokens:
                    deleted_count += 1
                    continue
                new_lines.append(raw)

            try:
                if deleted_count:
                    _write_all_lines(ensure_known_hosts_file, kh, new_lines)
                else:
                    ensure_known_hosts_file(kh)
            except Exception:
                return error_response("delete_failed", 500, ok=False)

            _log(
                "info",
                "remotefs.known_hosts_delete",
                method="manual",
                target=target,
                deleted_count=int(deleted_count),
                path=kh,
                remote_addr=str(request.remote_addr or ""),
            )
            return jsonify(
                {
                    "ok": True,
                    "path": kh,
                    "target": target,
                    "deleted_count": deleted_count,
                    "method": "manual",
                }
            )

        if idx is None:
            return error_response("idx_or_host_required", 400, ok=False)

        try:
            idx_i = int(idx)
        except Exception:
            return error_response("bad_idx", 400, ok=False)

        try:
            lines = _read_all_lines(ensure_known_hosts_file, kh)
            if idx_i < 0 or idx_i >= len(lines):
                return error_response("idx_out_of_range", 400, ok=False)
            lines.pop(idx_i)
            _write_all_lines(ensure_known_hosts_file, kh, lines)
            _log(
                "info",
                "remotefs.known_hosts_delete",
                method="idx",
                idx=idx_i,
                deleted_count=1,
                path=kh,
                remote_addr=str(request.remote_addr or ""),
            )
            return jsonify({"ok": True, "path": kh, "deleted_count": 1})
        except Exception:
            return error_response("delete_failed", 500, ok=False)
