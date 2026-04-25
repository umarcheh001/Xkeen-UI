"""Outbound link parsing/building helpers for XKeen Xray (04_outbounds.json).

Extracted from app.py as part of PR14 refactor.
"""

from __future__ import annotations

import base64
import json
import re
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse, parse_qs, unquote, quote


# ---------- OUTBOUNDS helper (04_outbounds.json) ----------
#
# Панель исторически показывала поле «VLESS ссылка», но на практике
# пользователи часто вставляют разные типы ссылок (как в Outbound Generator):
#   - vless:// (Reality/TLS)
#   - trojan:// (TLS/ws/grpc/...)
#   - vmess:// (base64 JSON)
#   - ss:// (Shadowsocks)
#
# Поэтому ниже реализован единый парсер и восстановление ссылки из конфига.

# Основной tag, который ожидают большинство примеров правил маршрутизации.
PROXY_OUTBOUND_TAG = "proxy"

# Исторический tag из ранних версий панели (использовался в подсветке логов).
# Мы добавляем его как алиас для совместимости.
LEGACY_VLESS_TAG = "vless-reality"


def _b64_decode_relaxed(s: str) -> bytes:
    """Base64 decode с поддержкой URL-safe и отсутствия padding."""
    s = (s or "").strip()
    if not s:
        return b""
    s = s.replace("-", "+").replace("_", "/")
    pad = "=" * (-len(s) % 4)
    try:
        return base64.b64decode((s + pad).encode("utf-8"))
    except Exception:
        return b""


def _b64_encode_nopad(b: bytes) -> str:
    """Base64 encode без '=' в конце (как часто в vmess://)."""
    if b is None:
        b = b""
    return base64.b64encode(b).decode("utf-8").rstrip("=")


def _first(qs, key, default=None):
    vals = qs.get(key)
    return vals[0] if vals else default


def _to_int(v, default=None):
    if v is None or v == "":
        return default
    try:
        return int(str(v).strip())
    except Exception:
        return default


def _to_bool(v) -> bool:
    if v is None:
        return False
    s = str(v).strip().lower()
    return s in ("1", "true", "yes", "on", "y")


def _normalize_xhttp_mode(value: Any) -> str | None:
    text = unquote(str(value or "")).strip()
    if not text or text.lower() == "auto":
        return None
    lowered = text.lower()
    if lowered in {"stream-one", "stream-up", "packet-up"}:
        return lowered
    return text

def build_vless_url_from_config(cfg):
    """Пытается восстановить VLESS ссылку из 04_outbounds.json.

    Поддерживает Reality/TLS и популярные транспорты (tcp/ws/grpc/httpupgrade/kcp/raw/xhttp).
    Если конфиг не похож на VLESS — вернёт None.
    """
    try:
        outbounds = (cfg or {}).get("outbounds", [])
        if not outbounds:
            return None

        # Ищем первый VLESS outbound (не обязательно первый в списке)
        main = None
        for ob in outbounds:
            try:
                if ob.get("protocol") == "vless":
                    vnext = (((ob.get("settings") or {}).get("vnext") or [None])[0])
                    if vnext and (vnext.get("users") or []):
                        main = ob
                        break
            except Exception:
                continue

        if not main:
            return None

        vnext = main["settings"]["vnext"][0]
        addr = vnext.get("address")
        port = vnext.get("port")
        user = (vnext.get("users") or [{}])[0]
        uid = user.get("id")
        if not (addr and uid and port):
            return None

        enc = user.get("encryption") or "none"
        flow = user.get("flow")

        stream = main.get("streamSettings") or {}
        network = stream.get("network") or "tcp"
        security = stream.get("security") or "none"

        params = []
        params.append(f"encryption={enc}")
        if flow:
            params.append(f"flow={flow}")

        # transport type in URL is usually "type=..."
        if network and network != "tcp":
            params.append(f"type={network}")

        if security and security != "none":
            params.append(f"security={security}")

        if security == "tls":
            tls = stream.get("tlsSettings") or {}
            fp = tls.get("fingerprint") or "chrome"
            sni = tls.get("serverName") or addr
            alpn = tls.get("alpn")
            allow_insecure = bool(tls.get("allowInsecure"))

            if fp:
                params.append(f"fp={fp}")
            if sni:
                params.append(f"sni={sni}")
            if isinstance(alpn, list) and alpn:
                params.append("alpn=" + ",".join(str(x) for x in alpn if x))
            if allow_insecure:
                params.append("allowInsecure=1")

        elif security == "reality":
            reality = stream.get("realitySettings") or {}
            pbk = reality.get("publicKey") or ""
            fp = reality.get("fingerprint") or "chrome"
            sni = reality.get("serverName") or addr
            sid = reality.get("shortId") or ""
            spx = reality.get("spiderX") or "/"
            pqv = reality.get("mldsa65Verify") or ""

            if pbk:
                params.append(f"pbk={pbk}")
            if fp:
                params.append(f"fp={fp}")
            if sni:
                params.append(f"sni={sni}")
            if sid:
                params.append(f"sid={sid}")
            if spx:
                params.append(f"spx={quote(str(spx))}")
            if pqv:
                params.append(f"pqv={pqv}")

        # network-specific settings -> URL params
        if network == "ws":
            ws = stream.get("wsSettings") or {}
            path = ws.get("path") or "/"
            host_hdr = None
            hdrs = ws.get("headers") or {}
            if isinstance(hdrs, dict):
                host_hdr = hdrs.get("Host") or hdrs.get("host")
            if path:
                params.append("path=" + quote(str(path)))
            if host_hdr:
                params.append("host=" + quote(str(host_hdr)))

        elif network == "grpc":
            grpc = stream.get("grpcSettings") or {}
            service = grpc.get("serviceName") or ""
            authority = grpc.get("authority") or ""
            multi = bool(grpc.get("multiMode"))
            if service:
                params.append("serviceName=" + quote(str(service)))
            if authority:
                params.append("authority=" + quote(str(authority)))
            if multi:
                params.append("mode=multi")

        elif network == "httpupgrade":
            hu = stream.get("httpupgradeSettings") or {}
            path = hu.get("path") or "/"
            host_hdr = hu.get("host") or ""
            if path:
                params.append("path=" + quote(str(path)))
            if host_hdr:
                params.append("host=" + quote(str(host_hdr)))

        elif network == "kcp":
            kcp = stream.get("kcpSettings") or {}
            if kcp.get("seed"):
                params.append("seed=" + quote(str(kcp.get("seed"))))
            hdr = (kcp.get("header") or {}) if isinstance(kcp.get("header"), dict) else {}
            if hdr.get("type"):
                params.append("headerType=" + quote(str(hdr.get("type"))))

        elif network == "raw":
            raw = stream.get("rawSettings") or {}
            hdr = (raw.get("header") or {}) if isinstance(raw.get("header"), dict) else {}
            if hdr.get("type"):
                params.append("headerType=" + quote(str(hdr.get("type"))))

        elif network == "tcp":
            tcp = stream.get("tcpSettings") or {}
            hdr = (tcp.get("header") or {}) if isinstance(tcp.get("header"), dict) else {}
            if hdr.get("type"):
                params.append("headerType=" + quote(str(hdr.get("type"))))

        elif network == "xhttp":
            xhttp = stream.get("xhttpSettings") or {}
            if xhttp.get("host"):
                params.append("host=" + quote(str(xhttp.get("host"))))
            if xhttp.get("path"):
                params.append("path=" + quote(str(xhttp.get("path"))))
            if xhttp.get("mode"):
                params.append("mode=" + quote(str(xhttp.get("mode"))))
            if xhttp.get("extra") is not None:
                try:
                    extra_json = json.dumps(xhttp.get("extra"), ensure_ascii=False)
                    params.append("extra=" + quote(extra_json))
                except Exception:
                    pass

        query = "&".join(params)
        return f"vless://{uid}@{addr}:{port}?{query}"
    except Exception:
        return None


def build_trojan_url_from_config(cfg):
    """Пытается восстановить trojan:// ссылку из 04_outbounds.json."""
    try:
        outbounds = (cfg or {}).get("outbounds", [])
        if not outbounds:
            return None

        main = None
        for ob in outbounds:
            try:
                if ob.get("protocol") == "trojan":
                    servers = ((ob.get("settings") or {}).get("servers") or [])
                    if servers and servers[0].get("password"):
                        main = ob
                        break
            except Exception:
                continue

        if not main:
            return None

        srv = ((main.get("settings") or {}).get("servers") or [{}])[0]
        addr = srv.get("address")
        port = srv.get("port")
        password = srv.get("password")
        if not (addr and port and password is not None):
            return None

        stream = main.get("streamSettings") or {}
        network = stream.get("network") or "tcp"
        security = stream.get("security") or "tls"

        params = []
        if network and network != "tcp":
            params.append(f"type={network}")
        if security and security != "none":
            params.append(f"security={security}")

        if security == "tls":
            tls = stream.get("tlsSettings") or {}
            fp = tls.get("fingerprint") or "chrome"
            sni = tls.get("serverName") or addr
            alpn = tls.get("alpn")
            allow_insecure = bool(tls.get("allowInsecure"))
            if fp:
                params.append(f"fp={fp}")
            if sni:
                params.append(f"sni={sni}")
            if isinstance(alpn, list) and alpn:
                params.append("alpn=" + ",".join(str(x) for x in alpn if x))
            if allow_insecure:
                params.append("allowInsecure=1")

        if network == "ws":
            ws = stream.get("wsSettings") or {}
            path = ws.get("path") or "/"
            hdrs = ws.get("headers") or {}
            host_hdr = None
            if isinstance(hdrs, dict):
                host_hdr = hdrs.get("Host") or hdrs.get("host")
            if path:
                params.append("path=" + quote(str(path)))
            if host_hdr:
                params.append("host=" + quote(str(host_hdr)))

        elif network == "grpc":
            grpc = stream.get("grpcSettings") or {}
            service = grpc.get("serviceName") or ""
            authority = grpc.get("authority") or ""
            multi = bool(grpc.get("multiMode"))
            if service:
                params.append("serviceName=" + quote(str(service)))
            if authority:
                params.append("authority=" + quote(str(authority)))
            if multi:
                params.append("mode=multi")

        elif network == "httpupgrade":
            hu = stream.get("httpupgradeSettings") or {}
            path = hu.get("path") or "/"
            host_hdr = hu.get("host") or ""
            if path:
                params.append("path=" + quote(str(path)))
            if host_hdr:
                params.append("host=" + quote(str(host_hdr)))

        query = "&".join(params)
        pwd = quote(str(password), safe="")
        return f"trojan://{pwd}@{addr}:{port}?{query}" if query else f"trojan://{pwd}@{addr}:{port}"
    except Exception:
        return None


def build_vmess_url_from_config(cfg):
    """Пытается восстановить vmess:// ссылку из 04_outbounds.json (base64 JSON)."""
    try:
        outbounds = (cfg or {}).get("outbounds", [])
        if not outbounds:
            return None

        main = None
        for ob in outbounds:
            try:
                if ob.get("protocol") == "vmess":
                    vnext = (((ob.get("settings") or {}).get("vnext") or [None])[0])
                    if vnext and (vnext.get("users") or []):
                        main = ob
                        break
            except Exception:
                continue

        if not main:
            return None

        vnext = main["settings"]["vnext"][0]
        addr = vnext.get("address")
        port = vnext.get("port")
        user = (vnext.get("users") or [{}])[0]
        uid = user.get("id")
        aid = user.get("alterId") if user.get("alterId") is not None else 0
        scy = user.get("security") or "auto"
        if not (addr and port and uid):
            return None

        stream = main.get("streamSettings") or {}
        network = stream.get("network") or "tcp"
        security = stream.get("security") or "none"

        tls = stream.get("tlsSettings") or {}
        sni = tls.get("serverName") or addr
        fp = tls.get("fingerprint") or "chrome"
        alpn = tls.get("alpn")
        allow_insecure = 1 if bool(tls.get("allowInsecure")) else 0

        host_hdr = ""
        path = ""
        if network == "ws":
            ws = stream.get("wsSettings") or {}
            path = ws.get("path") or "/"
            hdrs = ws.get("headers") or {}
            if isinstance(hdrs, dict):
                host_hdr = hdrs.get("Host") or hdrs.get("host") or ""
        elif network == "grpc":
            grpc = stream.get("grpcSettings") or {}
            path = grpc.get("serviceName") or ""

        payload = {
            "v": "2",
            "ps": main.get("tag") or "vmess",
            "add": addr,
            "port": str(port),
            "id": uid,
            "aid": str(aid),
            "scy": scy,
            "net": network,
            "type": "none",
            "host": host_hdr or "",
            "path": path or "",
            "tls": "tls" if security == "tls" else "",
        }
        if sni:
            payload["sni"] = sni
        if fp:
            payload["fp"] = fp
        if isinstance(alpn, list) and alpn:
            payload["alpn"] = ",".join(str(x) for x in alpn if x)
        if allow_insecure:
            payload["allowInsecure"] = allow_insecure

        raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        return "vmess://" + _b64_encode_nopad(raw)
    except Exception:
        return None


def build_ss_url_from_config(cfg):
    """Пытается восстановить ss:// ссылку из 04_outbounds.json."""
    try:
        outbounds = (cfg or {}).get("outbounds", [])
        if not outbounds:
            return None

        main = None
        for ob in outbounds:
            try:
                if ob.get("protocol") in ("shadowsocks", "ss"):
                    servers = ((ob.get("settings") or {}).get("servers") or [])
                    if servers and servers[0].get("method") and servers[0].get("password") is not None:
                        main = ob
                        break
            except Exception:
                continue

        if not main:
            return None

        srv = ((main.get("settings") or {}).get("servers") or [{}])[0]
        addr = srv.get("address")
        port = srv.get("port")
        method = srv.get("method")
        password = srv.get("password")
        if not (addr and port and method and password is not None):
            return None

        cred = f"{method}:{password}".encode("utf-8")
        b64 = _b64_encode_nopad(cred).replace("+", "-").replace("/", "_")
        return f"ss://{b64}@{addr}:{port}"
    except Exception:
        return None


def build_hy2_url_from_config(cfg):
    """Пытается восстановить HY2 (hysteria2) ссылку из 04_outbounds.json.

    Мы ориентируемся на Xray outbound `protocol: hysteria` + `version: 2`.
    Поддерживаем базовые параметры:
      - auth (username[:password])
      - sni / insecure
      - obfs salamander (udpmasks)

    Если конфиг не похож на Hysteria2 — вернёт None.
    """
    try:
        outbounds = (cfg or {}).get("outbounds", [])
        if not outbounds:
            return None

        main = None
        for ob in outbounds:
            try:
                if ob.get("protocol") != "hysteria":
                    continue
                ss = ob.get("streamSettings") or {}
                hs = ss.get("hysteriaSettings") or {}
                if int((hs.get("version") or 0)) != 2:
                    continue
                if not (hs.get("auth") or "").strip():
                    continue
                # settings.address/port (как в примере) — предпочтительно
                st = ob.get("settings") or {}
                if not (st.get("address") and st.get("port")):
                    continue
                main = ob
                break
            except Exception:
                continue

        if not main:
            return None

        st = main.get("settings") or {}
        host = st.get("address")
        port = st.get("port")
        ss = main.get("streamSettings") or {}
        tls = ss.get("tlsSettings") or {}
        hs = ss.get("hysteriaSettings") or {}

        if not (host and port):
            return None

        auth = str(hs.get("auth") or "").strip()
        if not auth:
            return None

        # username/password (если есть ':')
        username = auth
        password = ""
        if ":" in auth:
            username, password = auth.split(":", 1)

        def _q(s: str) -> str:
            try:
                return quote(str(s), safe="")
            except Exception:
                return quote(str(s))

        userinfo = _q(username)
        if password != "":
            userinfo = userinfo + ":" + _q(password)

        params = []
        sni = tls.get("serverName")
        if sni:
            params.append("sni=" + _q(str(sni)))
        if bool(tls.get("allowInsecure")):
            params.append("insecure=1")

        # obfs salamander
        try:
            masks = ss.get("udpmasks") or []
            if isinstance(masks, list) and masks:
                m0 = masks[0] if isinstance(masks[0], dict) else None
                if m0 and str(m0.get("type") or "").lower() == "salamander":
                    params.append("obfs=salamander")
                    pwd = ((m0.get("settings") or {}) if isinstance(m0.get("settings"), dict) else {}).get("password")
                    if pwd:
                        params.append("obfs-password=" + _q(str(pwd)))
        except Exception:
            pass

        # pinSHA256 (Xray: tlsSettings.pinnedPeerCertificateChainSha256)
        try:
            pins = tls.get("pinnedPeerCertificateChainSha256")
            if isinstance(pins, list) and pins:
                # если несколько — передаём через запятую
                pvals = [str(x).strip() for x in pins if str(x).strip()]
                if pvals:
                    params.append("pinSHA256=" + _q(",".join(pvals)))
        except Exception:
            pass

        query = "&".join(params)
        if query:
            return f"hy2://{userinfo}@{host}:{int(port)}?{query}"
        return f"hy2://{userinfo}@{host}:{int(port)}"
    except Exception:
        return None


def build_proxy_url_from_config(cfg):
    """Восстанавливает ссылку для UI из 04_outbounds.json (vless/trojan/vmess/ss/hy2)."""
    for fn in (
        build_vless_url_from_config,
        build_trojan_url_from_config,
        build_vmess_url_from_config,
        build_ss_url_from_config,
        build_hy2_url_from_config,
    ):
        try:
            u = fn(cfg)
            if u:
                return u
        except Exception:
            continue
    return None


def build_outbounds_config_from_link(url: str) -> Dict[str, Any]:
    """Собирает 04_outbounds.json по ссылке (vless/trojan/vmess/ss/hy2)."""
    parsed = urlparse((url or "").strip())
    scheme = (parsed.scheme or "").strip().lower()

    if scheme == "vless":
        return build_outbounds_config_from_vless(url)
    if scheme == "trojan":
        return build_outbounds_config_from_trojan(url)
    if scheme == "vmess":
        return build_outbounds_config_from_vmess(url)
    if scheme in ("ss", "shadowsocks"):
        return build_outbounds_config_from_ss(url)

    # Hysteria2 (Xray: protocol=hysteria + version=2)
    if scheme in ("hy2", "hysteria2", "hysteria"):
        return build_outbounds_config_from_hysteria2(url)

    raise ValueError("Поддерживаются ссылки vless://, trojan://, vmess://, ss://, hy2://")


def build_proxy_outbound_from_link(url: str, tag: str) -> Dict[str, Any]:
    """Build a *single* proxy outbound object from share link.

    Used by balancer/pool workflows: we must NOT auto-add legacy alias or direct/block
    for each entry.

    Supported schemes: vless/trojan/vmess/ss/hy2.
    """
    t = str(tag or "").strip()
    if not t:
        raise ValueError("tag is required")

    cfg = build_outbounds_config_from_link(url)
    outbounds = (cfg or {}).get("outbounds")
    if not isinstance(outbounds, list) or not outbounds:
        raise ValueError("failed to build outbound")

    ob = outbounds[0]
    if not isinstance(ob, dict):
        raise ValueError("invalid outbound")

    # deepcopy (safe, without importing copy)
    try:
        ob2 = json.loads(json.dumps(ob))
    except Exception:
        ob2 = dict(ob)

    ob2["tag"] = t
    return ob2


def build_outbounds_config_from_hysteria2(url: str) -> Dict[str, Any]:
    """Build 04_outbounds.json from Hysteria2 share link.

    Поддерживаем схемы:
      - hy2://
      - hysteria2://

    Минимальные параметры, которые мы пытаемся распарсить:
      - username[:password] -> hysteriaSettings.auth
      - host/port -> settings.address/port
      - sni / insecure
      - obfs=salamander + obfs-password -> udpmasks

    Дополнительно поддерживаем pinSHA256 из ссылки и добавляем его в Xray-конфиг как
    tlsSettings.pinnedPeerCertificateChainSha256.
    """

    raw = (url or "").strip()
    parsed = urlparse(raw)
    scheme = (parsed.scheme or "").strip().lower()
    if scheme not in ("hy2", "hysteria2", "hysteria"):
        raise ValueError("Ожидается ссылка hy2://")

    host = parsed.hostname or ""
    try:
        port = parsed.port
    except Exception:
        port = None
    port = port or 443

    # hy2://user:pass@host:port
    username = unquote(parsed.username or "")
    password = unquote(parsed.password or "")

    # Если username пустой, но в netloc могли быть экзотические символы —
    # мы не пытаемся угадывать, просто валидируем.
    if not host:
        raise ValueError("Некорректный формат hy2: не указан host")
    if not username and not password:
        raise ValueError("Некорректный формат hy2: не указан auth (username/password)")

    auth = username
    if password != "":
        auth = f"{username}:{password}"

    qs = parse_qs(parsed.query, keep_blank_values=True)

    sni = _first(qs, "sni", None) or host
    insecure = _to_bool(_first(qs, "insecure", None)) or _to_bool(_first(qs, "allowInsecure", None))

    # pinSHA256 (certificate pinning)
    pin_values: List[str] = []
    try:
        for k, vals in (qs or {}).items():
            if str(k).strip().lower() != "pinsha256":
                continue
            for v in (vals or []):
                s = str(v or "").strip()
                if not s:
                    continue
                # некоторые клиенты передают несколько пинов через запятую или пробел
                for part in re.split(r"[\s,|]+", s):
                    part = part.strip()
                    if part:
                        pin_values.append(part)
    except Exception:
        pin_values = []

    # obfs salamander
    obfs = str(_first(qs, "obfs", "") or "").strip().lower()
    obfs_pwd = _first(qs, "obfs-password", None) or _first(qs, "obfs_password", None)

    # Optional: user-specified params (best-effort)
    congestion = _first(qs, "congestion", None)
    up = _first(qs, "up", None)
    down = _first(qs, "down", None)

    hyst = {
        "version": 2,
        "auth": auth,
    }
    if congestion:
        hyst["congestion"] = str(congestion)
    if up:
        hyst["up"] = str(up)
    if down:
        hyst["down"] = str(down)

    stream_settings: Dict[str, Any] = {
        "network": "hysteria",
        "hysteriaSettings": hyst,
        "security": "tls",
        "tlsSettings": {
            "serverName": str(sni),
            "alpn": ["h3"],
        },
    }

    if pin_values:
        stream_settings["tlsSettings"]["pinnedPeerCertificateChainSha256"] = pin_values
    if insecure:
        stream_settings["tlsSettings"]["allowInsecure"] = True

    if obfs == "salamander":
        pwd = str(obfs_pwd or "").strip()
        # Пароль для salamander в Xray задаётся в udpmasks
        m = {
            "type": "salamander",
            "settings": {},
        }
        if pwd:
            m["settings"]["password"] = pwd
        stream_settings["udpmasks"] = [m]

    outbound = {
        "tag": PROXY_OUTBOUND_TAG,
        "protocol": "hysteria",
        "settings": {
            "version": 2,
            "address": host,
            "port": int(port),
        },
        "streamSettings": stream_settings,
    }

    return _wrap_outbounds_with_common(outbound)


def build_outbounds_config_from_vless(url):
    """Собирает 04_outbounds.json из VLESS ссылки.

    В панели поле подписано как VLESS, но на практике ссылки бывают разными:
    - Reality/TLS
    - tcp/ws/grpc/httpupgrade/kcp/raw/xhttp

    Эта функция старается быть максимально совместимой с генератором
    zxc-rv.github.io/XKeen-UI_Outbound_Generator.
    """

    def _first(qs, key, default=None):
        vals = qs.get(key)
        return vals[0] if vals else default

    def _to_int(v, default=None):
        if v is None or v == "":
            return default
        try:
            return int(str(v).strip())
        except Exception:
            return default

    def _to_bool(v):
        if v is None:
            return False
        s = str(v).strip().lower()
        return s in ("1", "true", "yes", "on", "y")

    parsed = urlparse((url or "").strip())
    if parsed.scheme != "vless":
        raise ValueError("Ожидается ссылка vless://")

    uid = parsed.username or ""
    host = parsed.hostname or ""

    # urllib может бросить ValueError при нечисловом порте
    try:
        port = parsed.port
    except Exception:
        port = None
    port = port or 443

    if not uid:
        raise ValueError("Некорректный формат vless: не указан uuid (username)")
    if not host:
        raise ValueError("Некорректный формат vless: не указан host")

    qs = parse_qs(parsed.query, keep_blank_values=True)

    enc = _first(qs, "encryption", "none") or "none"
    flow = _first(qs, "flow", None)

    # Transport type: type=ws/grpc/tcp/... (часто опционально)
    network = _first(qs, "type", None) or _first(qs, "net", None) or "tcp"
    network = str(network).strip().lower() if network else "tcp"

    security = _first(qs, "security", None)
    if security is None or security == "":
        # исторически в панели ожидали reality по умолчанию
        security = "reality"
    security = str(security).strip().lower()

    # Common TLS/Reality params
    fp = _first(qs, "fp", "chrome") or "chrome"
    sni = _first(qs, "sni", None) or host

    stream_settings = {
        "network": network,
        "security": security,
    }

    if security == "tls":
        alpn_raw = _first(qs, "alpn", "") or ""
        alpn = [x.strip() for x in alpn_raw.split(",") if x.strip()] if alpn_raw else None
        allow_insecure = _to_bool(_first(qs, "allowInsecure", None)) or _to_bool(_first(qs, "insecure", None))
        tls = {
            "fingerprint": fp,
            "serverName": sni,
        }
        if alpn:
            tls["alpn"] = alpn
        if allow_insecure:
            tls["allowInsecure"] = True
        stream_settings["tlsSettings"] = tls

    elif security == "reality":
        pbk = _first(qs, "pbk", "") or ""
        sid = _first(qs, "sid", "") or ""
        spx = _first(qs, "spx", "/") or "/"
        spx = unquote(spx)
        pqv = _first(qs, "pqv", "") or ""

        reality = {
            "publicKey": pbk,
            "fingerprint": fp,
            "serverName": sni,
            "shortId": sid,
            "spiderX": spx,
        }
        if pqv:
            reality["mldsa65Verify"] = pqv
        stream_settings["realitySettings"] = reality

    # Transport-specific settings
    header_type = _first(qs, "headerType", None)

    if network == "tcp" and header_type:
        stream_settings["tcpSettings"] = {"header": {"type": str(header_type)}}
    elif network == "raw" and header_type:
        stream_settings["rawSettings"] = {"header": {"type": str(header_type)}}

    if network == "ws":
        path = unquote(_first(qs, "path", "/") or "/")
        host_hdr = _first(qs, "host", None)
        ws = {"path": path}
        if host_hdr:
            ws["headers"] = {"Host": unquote(host_hdr)}
        stream_settings["wsSettings"] = ws

    elif network == "grpc":
        service = _first(qs, "serviceName", None) or _first(qs, "path", None) or ""
        authority = _first(qs, "authority", None) or ""
        mode = _first(qs, "mode", None) or ""
        grpc = {
            "serviceName": unquote(service) if service else "",
        }
        if authority:
            grpc["authority"] = unquote(authority)
        if str(mode).lower() == "multi":
            grpc["multiMode"] = True
        stream_settings["grpcSettings"] = grpc

    elif network == "httpupgrade":
        path = unquote(_first(qs, "path", "/") or "/")
        host_hdr = _first(qs, "host", None)
        hu = {"path": path}
        if host_hdr:
            hu["host"] = unquote(host_hdr)
        stream_settings["httpupgradeSettings"] = hu

    elif network == "kcp":
        kcp = {
            "mtu": _to_int(_first(qs, "mtu", None)),
            "tti": _to_int(_first(qs, "tti", None)),
            "uplinkCapacity": _to_int(_first(qs, "uplinkCapacity", None)),
            "downlinkCapacity": _to_int(_first(qs, "downlinkCapacity", None)),
            "congestion": _to_bool(_first(qs, "congestion", None)),
            "readBufferSize": _to_int(_first(qs, "readBufferSize", None)),
            "writeBufferSize": _to_int(_first(qs, "writeBufferSize", None)),
            "seed": _first(qs, "seed", None),
        }
        if header_type:
            kcp["header"] = {"type": str(header_type)}
        # вычищаем None
        kcp = {k: v for k, v in kcp.items() if v is not None and v != ""}
        stream_settings["kcpSettings"] = kcp

    elif network == "xhttp":
        xhttp_host = _first(qs, "host", None)
        xhttp_path = _first(qs, "path", "/")
        xhttp_mode = _first(qs, "mode", "auto")
        extra_raw = _first(qs, "extra", None)
        extra_obj = None
        if extra_raw:
            try:
                extra_obj = json.loads(unquote(extra_raw))
            except Exception:
                extra_obj = None
        xhttp = {
            "host": unquote(xhttp_host) if xhttp_host else None,
            "path": unquote(xhttp_path) if xhttp_path else "/",
        }
        normalized_mode = _normalize_xhttp_mode(xhttp_mode)
        if normalized_mode is not None:
            xhttp["mode"] = normalized_mode
        if extra_obj is not None:
            xhttp["extra"] = extra_obj
        xhttp = {k: v for k, v in xhttp.items() if v is not None}
        stream_settings["xhttpSettings"] = xhttp

    outbound = {
        "tag": PROXY_OUTBOUND_TAG,
        "protocol": "vless",
        "settings": {
            "vnext": [
                {
                    "address": host,
                    "port": port,
                    "users": [
                        {
                            "id": uid,
                            "encryption": enc,
                            "level": 0,
                        }
                    ],
                }
            ]
        },
        "streamSettings": stream_settings,
    }

    # flow опционален
    if flow:
        outbound["settings"]["vnext"][0]["users"][0]["flow"] = flow

    # Для совместимости с ранними версиями панели добавляем алиас-выход.
    # Это не влияет на работу, но позволяет старым правилам с outboundTag=vless-reality
    # продолжить работать после пересохранения.
    outbounds = [outbound]
    try:
        if outbound.get("tag") != LEGACY_VLESS_TAG:
            alias = json.loads(json.dumps(outbound))  # безопасное deepcopy без import copy
            alias["tag"] = LEGACY_VLESS_TAG
            outbounds.append(alias)
    except Exception:
        pass

    outbounds.extend([
        {"tag": "direct", "protocol": "freedom"},
        {
            "tag": "block",
            "protocol": "blackhole",
            "settings": {"response": {"type": "http"}},
        },
    ])

    cfg = {"outbounds": outbounds}
    return cfg



# --- Additional protocol builders: trojan/vmess/ss ---

def _wrap_outbounds_with_common(outbound: dict) -> dict:
    """Wrap a single proxy outbound into full 04_outbounds.json.

    Adds a legacy tag alias, plus 'direct' and 'block' outbounds.
    """
    outbounds = [outbound]
    try:
        if outbound.get('tag') != LEGACY_VLESS_TAG:
            alias = json.loads(json.dumps(outbound))
            alias['tag'] = LEGACY_VLESS_TAG
            outbounds.append(alias)
    except Exception:
        pass

    outbounds.extend([
        {'tag': 'direct', 'protocol': 'freedom'},
        {
            'tag': 'block',
            'protocol': 'blackhole',
            'settings': {'response': {'type': 'http'}},
        },
    ])
    return {'outbounds': outbounds}


def _build_stream_settings_from_qs(qs: dict, host_fallback: str, default_security: str = 'tls') -> dict:
    """Build Xray streamSettings from URL query string dict (parse_qs output).

    Compatible with XKeen Outbound Generator (type/security + common params).
    """
    network = (_first(qs, 'type', None) or _first(qs, 'net', None) or 'tcp')
    network = str(network).strip().lower() if network else 'tcp'

    security = _first(qs, 'security', None)
    if security is None or security == '':
        security = default_security
    security = str(security).strip().lower()

    fp = _first(qs, 'fp', 'chrome') or 'chrome'
    sni = _first(qs, 'sni', None) or host_fallback

    stream_settings = {
        'network': network,
        'security': security,
    }

    if security == 'tls':
        alpn_raw = _first(qs, 'alpn', '') or ''
        alpn = [x.strip() for x in str(alpn_raw).split(',') if x.strip()] if alpn_raw else None
        allow_insecure = _to_bool(_first(qs, 'allowInsecure', None)) or _to_bool(_first(qs, 'insecure', None))
        tls = {
            'fingerprint': fp,
            'serverName': sni,
        }
        if alpn:
            tls['alpn'] = alpn
        if allow_insecure:
            tls['allowInsecure'] = True
        stream_settings['tlsSettings'] = tls

    elif security == 'reality':
        pbk = _first(qs, 'pbk', '') or ''
        sid = _first(qs, 'sid', '') or ''
        spx = _first(qs, 'spx', '/') or '/'
        spx = unquote(str(spx))
        pqv = _first(qs, 'pqv', '') or ''
        reality = {
            'publicKey': pbk,
            'fingerprint': fp,
            'serverName': sni,
            'shortId': sid,
            'spiderX': spx,
        }
        if pqv:
            reality['mldsa65Verify'] = pqv
        stream_settings['realitySettings'] = reality

    # Transport-specific settings
    header_type = _first(qs, 'headerType', None)

    if network == 'tcp' and header_type:
        stream_settings['tcpSettings'] = {'header': {'type': str(header_type)}}
    elif network == 'raw' and header_type:
        stream_settings['rawSettings'] = {'header': {'type': str(header_type)}}

    if network == 'ws':
        path = unquote(_first(qs, 'path', '/') or '/')
        host_hdr = _first(qs, 'host', None)
        ws = {'path': path}
        if host_hdr:
            ws['headers'] = {'Host': unquote(str(host_hdr))}
        stream_settings['wsSettings'] = ws

    elif network == 'grpc':
        service = _first(qs, 'serviceName', None) or _first(qs, 'path', None) or ''
        authority = _first(qs, 'authority', None) or ''
        mode = _first(qs, 'mode', None) or ''
        grpc = {'serviceName': unquote(str(service)) if service else ''}
        if authority:
            grpc['authority'] = unquote(str(authority))
        if str(mode).lower() == 'multi':
            grpc['multiMode'] = True

        # Optional advanced gRPC params from generator (safe to ignore if absent)
        if _first(qs, 'user_agent', None):
            grpc['user_agent'] = _first(qs, 'user_agent', None)
        for k in ('idle_timeout', 'health_check_timeout', 'initial_windows_size'):
            v = _to_int(_first(qs, k, None))
            if v is not None:
                grpc[k] = v
        if _to_bool(_first(qs, 'permit_without_stream', None)):
            grpc['permit_without_stream'] = True

        stream_settings['grpcSettings'] = grpc

    elif network == 'httpupgrade':
        path = unquote(_first(qs, 'path', '/') or '/')
        host_hdr = _first(qs, 'host', None)
        hu = {'path': path}
        if host_hdr:
            hu['host'] = unquote(str(host_hdr))
        stream_settings['httpupgradeSettings'] = hu

    elif network == 'kcp':
        kcp = {
            'mtu': _to_int(_first(qs, 'mtu', None)),
            'tti': _to_int(_first(qs, 'tti', None)),
            'uplinkCapacity': _to_int(_first(qs, 'uplinkCapacity', None)),
            'downlinkCapacity': _to_int(_first(qs, 'downlinkCapacity', None)),
            'congestion': _to_bool(_first(qs, 'congestion', None)),
            'readBufferSize': _to_int(_first(qs, 'readBufferSize', None)),
            'writeBufferSize': _to_int(_first(qs, 'writeBufferSize', None)),
            'seed': _first(qs, 'seed', None),
        }
        if header_type:
            kcp['header'] = {'type': str(header_type)}
        kcp = {k: v for k, v in kcp.items() if v is not None and v != ''}
        stream_settings['kcpSettings'] = kcp

    elif network == 'xhttp':
        xhttp_host = _first(qs, 'host', None)
        xhttp_path = _first(qs, 'path', '/')
        xhttp_mode = _first(qs, 'mode', 'auto')
        extra_raw = _first(qs, 'extra', None)
        extra_obj = None
        if extra_raw:
            try:
                extra_obj = json.loads(unquote(str(extra_raw)))
            except Exception:
                extra_obj = None
        xhttp = {
            'host': unquote(str(xhttp_host)) if xhttp_host else None,
            'path': unquote(str(xhttp_path)) if xhttp_path else '/',
        }
        normalized_mode = _normalize_xhttp_mode(xhttp_mode)
        if normalized_mode is not None:
            xhttp['mode'] = normalized_mode
        if extra_obj is not None:
            xhttp['extra'] = extra_obj
        xhttp = {k: v for k, v in xhttp.items() if v is not None}
        stream_settings['xhttpSettings'] = xhttp

    return stream_settings


def build_outbounds_config_from_trojan(url: str) -> dict:
    """Build 04_outbounds.json from trojan:// link (Generator-compatible)."""
    parsed = urlparse((url or '').strip())
    if parsed.scheme.lower() != 'trojan':
        raise ValueError('Ожидается ссылка trojan://')

    password = unquote(parsed.username or '')
    host = parsed.hostname or ''
    try:
        port = parsed.port
    except Exception:
        port = None
    port = port or 443

    if not password:
        raise ValueError('Некорректный формат trojan: не указан пароль (username)')
    if not host:
        raise ValueError('Некорректный формат trojan: не указан host')

    qs = parse_qs(parsed.query, keep_blank_values=True)

    # Trojan typically uses TLS by default
    stream_settings = _build_stream_settings_from_qs(qs, host_fallback=host, default_security='tls')

    outbound = {
        'tag': PROXY_OUTBOUND_TAG,
        'protocol': 'trojan',
        'settings': {
            'servers': [
                {
                    'address': host,
                    'port': port,
                    'password': password,
                    'level': 0,
                }
            ]
        },
        'streamSettings': stream_settings,
    }

    return _wrap_outbounds_with_common(outbound)


def build_outbounds_config_from_ss(url: str) -> dict:
    """Build 04_outbounds.json from ss:// (Shadowsocks) link."""
    parsed = urlparse((url or '').strip())
    if parsed.scheme.lower() not in ('ss', 'shadowsocks'):
        raise ValueError('Ожидается ссылка ss://')

    host = parsed.hostname or ''
    try:
        port = parsed.port
    except Exception:
        port = None

    if not host or not port:
        raise ValueError('Некорректный формат ss: не указан host/port')

    method = None
    password = None

    if parsed.username and not parsed.password:
        # ss://BASE64(method:password)@host:port
        dec = _b64_decode_relaxed(parsed.username).decode('utf-8', errors='ignore')
        if ':' in dec:
            method, password = dec.split(':', 1)
        else:
            # some clients use base64 of full "method:pass" without splitting – keep as-is
            method, password = dec, ''
    else:
        method = unquote(parsed.username or '')
        password = unquote(parsed.password or '')

    if not method:
        raise ValueError('Некорректный формат ss: не указан method')

    outbound = {
        'tag': PROXY_OUTBOUND_TAG,
        'protocol': 'shadowsocks',
        'settings': {
            'servers': [
                {
                    'address': host,
                    'port': int(port),
                    'method': method,
                    'password': password or '',
                    'level': 0,
                }
            ]
        },
    }

    return _wrap_outbounds_with_common(outbound)


def build_outbounds_config_from_vmess(url: str) -> dict:
    """Build 04_outbounds.json from vmess:// (base64 JSON) link."""
    raw = (url or '').strip()
    if not raw.lower().startswith('vmess://'):
        raise ValueError('Ожидается ссылка vmess://')

    b64 = raw[8:]
    decoded = _b64_decode_relaxed(b64).decode('utf-8', errors='ignore')
    if not decoded:
        raise ValueError('Некорректный формат vmess: base64 decode failed')

    try:
        data = json.loads(decoded)
    except Exception as e:
        raise ValueError(f'Некорректный формат vmess: invalid json: {e}')

    host = str(data.get('add') or data.get('address') or '').strip()
    port = _to_int(data.get('port'), None) or 443
    uid = str(data.get('id') or '').strip()
    aid = _to_int(data.get('aid'), 0) or 0
    scy = str(data.get('scy') or data.get('cipher') or data.get('security') or 'auto').strip()

    if not host:
        raise ValueError('Некорректный формат vmess: не указан add')
    if not uid:
        raise ValueError('Некорректный формат vmess: не указан id')

    network = str(data.get('net') or data.get('type') or 'tcp').strip().lower()

    # vmess usually uses TLS field "tls":"tls"; some generators also set security
    security = 'tls' if str(data.get('tls') or '').lower() == 'tls' else str(data.get('security') or '').strip().lower()
    if not security:
        security = 'none'

    stream_settings = {
        'network': network,
        'security': security,
    }

    # TLS settings
    if security == 'tls':
        fp = str(data.get('fp') or 'chrome')
        sni = str(data.get('sni') or data.get('host') or host)
        alpn_raw = str(data.get('alpn') or '')
        alpn = [x.strip() for x in alpn_raw.split(',') if x.strip()] if alpn_raw else None
        allow_insecure = _to_bool(data.get('allowInsecure')) or _to_bool(data.get('insecure'))
        tls = {
            'fingerprint': fp,
            'serverName': sni,
        }
        if alpn:
            tls['alpn'] = alpn
        if allow_insecure:
            tls['allowInsecure'] = True
        stream_settings['tlsSettings'] = tls

    # Network-specific settings
    if network == 'ws':
        path = str(data.get('path') or '/').strip() or '/'
        host_hdr = str(data.get('host') or '').strip()
        ws = {'path': path}
        if host_hdr:
            ws['headers'] = {'Host': host_hdr}
        stream_settings['wsSettings'] = ws

    elif network == 'grpc':
        service = str(data.get('path') or data.get('serviceName') or '').strip()
        grpc = {'serviceName': service}
        stream_settings['grpcSettings'] = grpc

    elif network == 'httpupgrade':
        path = str(data.get('path') or '/').strip() or '/'
        host_hdr = str(data.get('host') or '').strip()
        hu = {'path': path}
        if host_hdr:
            hu['host'] = host_hdr
        stream_settings['httpupgradeSettings'] = hu

    outbound = {
        'tag': PROXY_OUTBOUND_TAG,
        'protocol': 'vmess',
        'settings': {
            'vnext': [
                {
                    'address': host,
                    'port': int(port),
                    'users': [
                        {
                            'id': uid,
                            'alterId': int(aid),
                            'security': scy,
                            'level': 0,
                        }
                    ],
                }
            ]
        },
        'streamSettings': stream_settings,
    }

    return _wrap_outbounds_with_common(outbound)


