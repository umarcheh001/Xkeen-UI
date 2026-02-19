"""Remote file manager backend (SFTP/FTP/FTPS) via lftp.

This module is the new home for the /api/remotefs/* blueprint.

Handlers are split into small modules under routes/remotefs/* and registered
from create_remotefs_blueprint().
"""

from __future__ import annotations

import os
import time
import uuid
import subprocess
import base64
import hashlib
import shlex
import threading
from dataclasses import dataclass
from urllib.parse import quote as _url_quote
from typing import Any, Dict, List, Optional, Tuple

from flask import Blueprint, request

from routes.common.errors import error_response
from services.fs_common.lftp_quote import _lftp_quote
from services.fs_common.http import _content_disposition_attachment
from services.fs_common.remote_parse import _parse_ls_line

# --- core.log helpers (never fail) ---
try:
    from services.logging_setup import core_logger as _get_core_logger

    _CORE_LOGGER = _get_core_logger()
except Exception:
    _CORE_LOGGER = None


def _core_log(level: str, msg: str, **extra) -> None:
    if _CORE_LOGGER is None:
        return
    try:
        if extra:
            try:
                tail = ", ".join(f"{k}={v}" for k, v in extra.items())
            except Exception:
                tail = repr(extra)
            full = f"{msg} | {tail}"
        else:
            full = msg
        fn = getattr(_CORE_LOGGER, str(level or "info").lower(), None)
        if callable(fn):
            fn(full)
        else:
            _CORE_LOGGER.info(full)
    except Exception:
        pass


# Optional gevent sleep (for WS streaming without blocking the server)
try:  # pragma: no cover
    from gevent import sleep as _ws_sleep  # type: ignore
except Exception:  # pragma: no cover

    def _ws_sleep(seconds: float) -> None:
        time.sleep(seconds)


def _now() -> float:
    return time.time()


def _gen_id(prefix: str = "rf") -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


# --------------------------- Security helpers (SFTP host keys / FTPS TLS) ---------------------------

_HOSTKEY_POLICIES = ("accept_new", "reject_new", "accept_any")
_TLS_VERIFY_MODES = ("strict", "ca", "none")


def _ensure_writable_dir(path: str) -> str:
    """Ensure directory exists and is writable; raise on failure."""
    os.makedirs(path, exist_ok=True)
    test = os.path.join(path, ".writetest")
    with open(test, "w", encoding="utf-8") as f:
        f.write("")
    os.remove(test)
    return path


def _choose_state_dir(tmp_dir: str) -> str:
    """Pick a persistent state dir for remotefs (known_hosts, etc.)."""
    env = (os.getenv("XKEEN_REMOTEFM_STATE_DIR", "") or "").strip()
    candidates = []
    if env:
        candidates.append(env)
    candidates.append("/opt/var/lib/xkeen-ui/remotefs")
    candidates.append(os.path.join(tmp_dir or "/tmp", "xkeen-ui-remotefs"))
    last_err = None
    for c in candidates:
        try:
            return _ensure_writable_dir(c)
        except Exception as e:
            last_err = e
            continue
    fallback = os.path.abspath("./xkeen-ui-remotefs")
    try:
        return _ensure_writable_dir(fallback)
    except Exception as e:
        raise RuntimeError("state_dir_unwritable") from (last_err or e)


def _ensure_known_hosts_file(path: str) -> str:
    """Ensure known_hosts exists and is private (0600)."""
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    if not os.path.exists(path):
        with open(path, "w", encoding="utf-8") as f:
            f.write("")
    try:
        os.chmod(path, 0o600)
    except Exception:
        pass
    return path


def _detect_default_ca_bundle() -> str | None:
    """Best-effort CA bundle discovery for FTPS verification."""
    env = (os.getenv("XKEEN_REMOTEFM_CA_FILE", "") or "").strip()
    if env and os.path.isfile(env):
        return env
    candidates = [
        "/etc/ssl/certs/ca-certificates.crt",
        "/etc/ssl/cert.pem",
        "/opt/etc/ssl/certs/ca-certificates.crt",
        "/opt/etc/ssl/cert.pem",
    ]
    for c in candidates:
        try:
            if os.path.isfile(c):
                return c
        except Exception:
            pass
    return None


def _normalize_security_options(
    protocol: str,
    options: Dict[str, Any],
    *,
    known_hosts_path: str,
    default_ca_file: str | None,
) -> tuple[Dict[str, Any], Dict[str, Any], List[str]]:
    """Normalize security options and return (options, effective, warnings)."""
    opt = dict(options or {})
    warnings: List[str] = []
    effective: Dict[str, Any] = {}

    # --- SFTP host key policy ---
    hostkey_policy = str(opt.get("hostkey_policy", "accept_new") or "accept_new").strip().lower()
    if hostkey_policy not in _HOSTKEY_POLICIES:
        hostkey_policy = "accept_new"
    if protocol == "sftp":
        kh = str(opt.get("known_hosts_path") or known_hosts_path or "").strip()
        if kh:
            _ensure_known_hosts_file(kh)
        effective.update({"hostkey_policy": hostkey_policy, "known_hosts_path": kh})
        opt["hostkey_policy"] = hostkey_policy
        if kh:
            opt["known_hosts_path"] = kh

    # --- FTPS TLS verification ---
    if protocol == "ftps":
        mode = str(opt.get("tls_verify_mode") or "none").strip().lower()
        if mode not in _TLS_VERIFY_MODES:
            mode = "none"
        ca_file = opt.get("tls_ca_file") or default_ca_file
        effective.update({"tls_verify_mode": mode, "tls_ca_file": ca_file})
        opt["tls_verify_mode"] = mode
        if ca_file:
            opt["tls_ca_file"] = ca_file

    # Generic timeout
    try:
        t = int(opt.get("timeout_sec", 10) or 10)
        if t < 3:
            t = 3
        if t > 120:
            t = 120
        opt["timeout_sec"] = t
    except Exception:
        opt["timeout_sec"] = 10

    return opt, effective, warnings


def _classify_connect_error(stderr: str) -> Dict[str, Any]:
    """Try to classify common SSH host key / TLS issues for UI."""
    s = (stderr or "").strip()
    low = s.lower()
    out: Dict[str, Any] = {}

    if "remote host identification has changed" in low or "host key verification failed" in low:
        out["kind"] = "hostkey_changed"
        out["hint"] = "Ключ сервера изменился. Проверьте, что это ожидаемо, затем удалите старую запись из known_hosts."
        return out
    if "are you sure you want to continue connecting" in low or "authenticity of host" in low:
        out["kind"] = "hostkey_unknown"
        out["hint"] = "Ключ сервера неизвестен. Выберите hostkey_policy=accept_new (или accept_any) либо добавьте ключ в known_hosts."
        return out
    if "bad configuration option" in low and "accept-new" in low:
        out["kind"] = "hostkey_policy_unsupported"
        out["hint"] = "ssh на устройстве не поддерживает StrictHostKeyChecking=accept-new. Используйте accept_any или обновите ssh."
        return out

    if "certificate" in low and ("verify" in low or "verification" in low or "not trusted" in low):
        out["kind"] = "tls_verify_failed"
        out["hint"] = "Проверка TLS-сертификата не прошла. Проверьте CA bundle/цепочку сертификатов или отключите verify=none (не рекомендуется)."
        return out

    out["kind"] = "connect_failed"
    return out


@dataclass
class RemoteFsSession:
    session_id: str
    protocol: str
    host: str
    port: int
    username: str
    auth_type: str
    options: Dict[str, Any]
    created_ts: float
    last_used_ts: float
    # For password auth
    password: str = ""
    # For SFTP key auth
    key_path: str = ""           # path on device (or temp file)
    key_is_temp: bool = False    # whether key_path should be deleted on session close
    # Optional: passphrase via SSH_ASKPASS (stored only in RAM; helper file is temp)
    askpass_path: str = ""
    env: Dict[str, str] | None = None


class RemoteFsManager:
    def __init__(
        self,
        *,
        enabled: bool,
        lftp_bin: str,
        ttl_seconds: int = 1800,
        max_sessions: int = 6,
        tmp_dir: str = "/tmp",
        max_upload_mb: int = 200,
        state_dir: str | None = None,
        known_hosts_path: str | None = None,
        default_ca_file: str | None = None,
    ) -> None:
        self.enabled = enabled
        self.lftp_bin = lftp_bin
        self.ttl_seconds = ttl_seconds
        self.max_sessions = max_sessions
        self.tmp_dir = tmp_dir
        self.max_upload_mb = max_upload_mb
        self.state_dir = state_dir or tmp_dir
        self.known_hosts_path = known_hosts_path
        self.default_ca_file = default_ca_file
        self._lock = threading.Lock()
        self._sessions: Dict[str, RemoteFsSession] = {}

    def cleanup(self) -> None:
        if not self.enabled:
            return
        now = _now()
        with self._lock:
            dead = [sid for sid, s in self._sessions.items() if (now - s.last_used_ts) > self.ttl_seconds]
            for sid in dead:
                s = self._sessions.pop(sid, None)
                if s:
                    self._cleanup_session_secrets(s)

    def _cleanup_session_secrets(self, s: RemoteFsSession) -> None:
        try:
            if s.key_is_temp and s.key_path and os.path.isfile(s.key_path):
                os.remove(s.key_path)
        except Exception:
            pass
        try:
            if s.askpass_path and os.path.isfile(s.askpass_path):
                os.remove(s.askpass_path)
        except Exception:
            pass

    def _touch(self, sid: str) -> None:
        with self._lock:
            s = self._sessions.get(sid)
            if s:
                s.last_used_ts = _now()

    def get(self, sid: str) -> Optional[RemoteFsSession]:
        self.cleanup()
        with self._lock:
            return self._sessions.get(sid)

    def create(
        self, protocol: str, host: str, port: int, username: str, auth_type: str, auth: Dict[str, Any], options: Dict[str, Any]
    ) -> RemoteFsSession:
        if not self.enabled:
            raise RuntimeError("feature_disabled")
        self.cleanup()
        with self._lock:
            if len(self._sessions) >= self.max_sessions:
                raise RuntimeError("too_many_sessions")
            sid = _gen_id("rfs")
            s = RemoteFsSession(
                session_id=sid,
                protocol=protocol,
                host=host,
                port=port,
                username=username,
                auth_type=auth_type,
                options=options,
                created_ts=_now(),
                last_used_ts=_now(),
            )

            if auth_type == "password":
                s.password = str(auth.get("password", "") or "")
            elif auth_type == "key":
                key_path = str(auth.get("key_path", "") or "").strip()
                key_data = auth.get("key_data") or auth.get("key")
                if key_data and isinstance(key_data, (bytes, bytearray)):
                    key_data = key_data.decode("utf-8", errors="replace")
                key_data = str(key_data or "")

                if key_data:
                    tmp_key = os.path.join(self.tmp_dir or "/tmp", f"rfs_key_{sid}.key")
                    os.makedirs(os.path.dirname(tmp_key) or ".", exist_ok=True)
                    with open(tmp_key, "w", encoding="utf-8") as f:
                        f.write(key_data)
                        if not key_data.endswith("\n"):
                            f.write("\n")
                    try:
                        os.chmod(tmp_key, 0o600)
                    except Exception:
                        pass
                    s.key_path = tmp_key
                    s.key_is_temp = True
                else:
                    s.key_path = key_path
                    s.key_is_temp = False

                passphrase = str(auth.get("passphrase", "") or "")
                if passphrase:
                    askpass = os.path.join(self.tmp_dir or "/tmp", f"rfs_askpass_{sid}.py")
                    os.makedirs(os.path.dirname(askpass) or ".", exist_ok=True)
                    with open(askpass, "w", encoding="utf-8") as f:
                        f.write(
                            "#!/usr/bin/env python3\n"
                            "import os, base64, sys\n"
                            "b = os.environ.get('RFS_PASSPHRASE_B64','')\n"
                            "try:\n"
                            "    sys.stdout.write(base64.b64decode(b.encode()).decode('utf-8', errors='ignore'))\n"
                            "except Exception:\n"
                            "    pass\n"
                        )
                    try:
                        os.chmod(askpass, 0o700)
                    except Exception:
                        pass
                    s.askpass_path = askpass
                    s.env = {
                        "DISPLAY": "1",
                        "SSH_ASKPASS": askpass,
                        "SSH_ASKPASS_REQUIRE": "force",
                        "RFS_PASSPHRASE_B64": base64.b64encode(passphrase.encode("utf-8")).decode("ascii"),
                    }

            self._sessions[sid] = s
            return s

    def close(self, sid: str) -> bool:
        with self._lock:
            s = self._sessions.pop(sid, None)
            if s:
                self._cleanup_session_secrets(s)
            return s is not None

    def _build_lftp_script(self, s: RemoteFsSession, commands: List[str]) -> str:
        timeout = int(s.options.get("timeout_sec", 10) or 10)
        url = f"{s.protocol}://{s.host}:{int(s.port)}"

        parts: List[str] = [
            "set cmd:fail-exit yes",
            f"set net:timeout {timeout}",
            "set net:max-retries 1",
            "set net:persist-retries 0",
            "set cmd:interactive false",
        ]

        if s.protocol == "sftp":
            hostkey_policy = str(s.options.get("hostkey_policy", "accept_new") or "accept_new").lower()
            if hostkey_policy not in _HOSTKEY_POLICIES:
                hostkey_policy = "accept_new"
            kh = str(s.options.get("known_hosts_path") or self.known_hosts_path or "").strip()
            if kh:
                _ensure_known_hosts_file(kh)

            parts.append(f"set sftp:auto-confirm {'yes' if hostkey_policy in ('accept_new','accept_any') else 'no'}")

            strict = "accept-new" if hostkey_policy == "accept_new" else ("yes" if hostkey_policy == "reject_new" else "no")
            if kh:
                connect_prog = (
                    "ssh -a -x -oLogLevel=ERROR "
                    f"-oUserKnownHostsFile={shlex.quote(kh)} -oGlobalKnownHostsFile=/dev/null -oStrictHostKeyChecking={strict}"
                )

                if s.auth_type == "key" and s.key_path:
                    connect_prog += f" -oIdentitiesOnly=yes -i {shlex.quote(s.key_path)}"

                parts.append(f"set sftp:connect-program {_lftp_quote(connect_prog)}")

        if s.protocol in ("ftps",):
            mode = str(s.options.get("tls_verify_mode") or "none").strip().lower()
            if mode not in _TLS_VERIFY_MODES:
                mode = "none"
            ca_file = s.options.get("tls_ca_file") or self.default_ca_file
            parts.append("set ftp:ssl-force yes")
            parts.append("set ftp:ssl-protect-data yes")
            parts.append(f"set ssl:verify-certificate {'yes' if mode != 'none' else 'no'}")
            parts.append(f"set ssl:check-hostname {'yes' if mode == 'strict' else 'no'}")
            if ca_file:
                parts.append(f"set ssl:ca-file {_lftp_quote(str(ca_file))}")

        if s.auth_type == "password":
            parts.append(f"open -u {_lftp_quote(s.username)},{_lftp_quote(s.password)} {url}")
        elif s.auth_type == "key" and s.protocol == "sftp":
            user_enc = _url_quote(s.username, safe="")
            parts.append(f"open sftp://{user_enc}@{s.host}:{int(s.port)}")
        else:
            raise RuntimeError("unsupported_auth")

        parts.extend(commands)
        parts.append("bye")
        return "; ".join(parts)

    def _run_lftp(self, s: RemoteFsSession, commands: List[str], *, capture: bool = True) -> Tuple[int, bytes, bytes]:
        script = self._build_lftp_script(s, commands)
        env = os.environ.copy()
        env.setdefault("LC_ALL", "C")
        env.setdefault("LANG", "C")
        try:
            if s.env:
                env.update({k: str(v) for k, v in s.env.items() if v is not None})
        except Exception:
            pass

        p = subprocess.Popen([self.lftp_bin, "-c", script], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        out, err = p.communicate()
        return int(p.returncode or 0), out or b"", err or b""

    def _popen_lftp(self, s: RemoteFsSession, commands: List[str]) -> subprocess.Popen:
        script = self._build_lftp_script(s, commands)
        env = os.environ.copy()
        env.setdefault("LC_ALL", "C")
        env.setdefault("LANG", "C")
        try:
            if s.env:
                env.update({k: str(v) for k, v in s.env.items() if v is not None})
        except Exception:
            pass
        p = subprocess.Popen([self.lftp_bin, "-c", script], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, bufsize=0)
        return p


def create_remotefs_blueprint(
    *,
    enabled: bool,
    lftp_bin: str,
    ttl_seconds: int = 1800,
    max_sessions: int = 6,
    tmp_dir: str = "/tmp",
    max_upload_mb: int = 200,
    return_mgr: bool = False,
) -> Blueprint | Tuple[Blueprint, RemoteFsManager]:
    bp = Blueprint("remotefs", __name__)

    # Persistent state for security material (known_hosts, CA bundle reference)
    state_dir = _choose_state_dir(tmp_dir)
    known_hosts_path = _ensure_known_hosts_file(
        (os.getenv("XKEEN_REMOTEFM_KNOWN_HOSTS", "") or "").strip() or os.path.join(state_dir, "known_hosts")
    )
    default_ca_file = _detect_default_ca_bundle()

    mgr = RemoteFsManager(
        enabled=enabled,
        lftp_bin=lftp_bin,
        ttl_seconds=ttl_seconds,
        max_sessions=max_sessions,
        tmp_dir=tmp_dir,
        max_upload_mb=max_upload_mb,
        state_dir=state_dir,
        known_hosts_path=known_hosts_path,
        default_ca_file=default_ca_file,
    )

    def _require_enabled() -> Optional[Any]:
        if not mgr.enabled:
            return error_response("feature_disabled", 404, ok=False)
        return None

    def _get_session_or_404(sid: str) -> Tuple[Optional[RemoteFsSession], Optional[Any]]:
        if (resp := _require_enabled()) is not None:
            return None, resp
        s = mgr.get(sid)
        if not s:
            return None, error_response("session_not_found", 404, ok=False)
        mgr._touch(sid)
        return s, None

    # Register endpoints
    from .capabilities import register_capabilities_endpoints
    from .known_hosts import register_known_hosts_endpoints
    from .sessions import register_sessions_endpoints
    from .ops import register_ops_endpoints
    from .transfer import register_transfer_endpoints

    register_capabilities_endpoints(
        bp,
        require_enabled=_require_enabled,
        mgr=mgr,
        hostkey_policies=_HOSTKEY_POLICIES,
        tls_verify_modes=_TLS_VERIFY_MODES,
    )
    register_known_hosts_endpoints(
        bp,
        require_enabled=_require_enabled,
        mgr=mgr,
        ensure_known_hosts_file=_ensure_known_hosts_file,
        core_log=_core_log,
    )
    register_sessions_endpoints(
        bp,
        require_enabled=_require_enabled,
        mgr=mgr,
        normalize_security_options=_normalize_security_options,
        classify_connect_error=_classify_connect_error,
        core_log=_core_log,
    )
    register_ops_endpoints(
        bp,
        get_session_or_404=_get_session_or_404,
        mgr=mgr,
        core_log=_core_log,
    )
    register_transfer_endpoints(
        bp,
        get_session_or_404=_get_session_or_404,
        mgr=mgr,
        core_log=_core_log,
    )

    if return_mgr:
        return bp, mgr
    return bp
