#!/opt/bin/python3
from flask import Flask, request, jsonify, render_template, redirect, url_for
import json
import os
import time
import shutil
import subprocess
from urllib.parse import urlparse, parse_qs, unquote, quote

ROUTING_FILE = "/opt/etc/xray/configs/05_routing.json"
INBOUNDS_FILE = "/opt/etc/xray/configs/03_inbounds.json"
OUTBOUNDS_FILE = "/opt/etc/xray/configs/04_outbounds.json"
BACKUP_DIR = "/opt/etc/xray/configs/backups"
XKEEN_RESTART_CMD = ["xkeen", "-restart"]
RESTART_LOG_FILE = "/opt/etc/xkeen-ui/restart.log"
PORT_PROXYING_FILE = "/opt/etc/xkeen/port_proxying.lst"
PORT_EXCLUDE_FILE = "/opt/etc/xkeen/port_exclude.lst"
IP_EXCLUDE_FILE = "/opt/etc/xkeen/ip_exclude.lst"

MIHOMO_CONFIG_FILE = "/opt/etc/mihomo/config.yaml"
MIHOMO_TEMPLATES_DIR = "/opt/etc/mihomo/templates"
MIHOMO_DEFAULT_TEMPLATE = "/opt/etc/mihomo/templates/umarcheh001.yaml"


COMMAND_GROUPS = [
    {
        "title": "Установка",
        "items": [
            {"flag": "-i",  "desc": "Основной режим установки XKeen + Xray + GeoFile + Mihomo"},
            {"flag": "-io", "desc": "OffLine установка XKeen"},
        ],
    },
    {
        "title": "Обновление",
        "items": [
            {"flag": "-uk", "desc": "Обновление XKeen"},
            {"flag": "-ug", "desc": "Обновление GeoFile"},
            {"flag": "-ux", "desc": "Обновление Xray (повышение/понижение версии)"},
            {"flag": "-um", "desc": "Обновление Mihomo (повышение/понижение версии)"},
        ],
    },
    {
        "title": "Автообновление",
        "items": [
            {"flag": "-ugc", "desc": "Включение или изменение задачи автообновления GeoFile"},
        ],
    },
    {
        "title": "Регистрация в системе",
        "items": [
            {"flag": "-rrk", "desc": "Регистрация XKeen в системе"},
            {"flag": "-rrx", "desc": "Регистрация Xray в системе"},
            {"flag": "-rrm", "desc": "Регистрация Mihomo в системе"},
            {"flag": "-ri",  "desc": "Автозапуск XKeen средствами init.d"},
        ],
    },
    {
        "title": "Удаление | Утилиты и компоненты",
        "items": [
            {"flag": "-remove", "desc": "Полная деинсталляция XKeen"},
            {"flag": "-dgs",    "desc": "Удаление GeoSite"},
            {"flag": "-dgi",    "desc": "Удаление GeoIP"},
            {"flag": "-dx",     "desc": "Удаление Xray"},
            {"flag": "-dm",     "desc": "Удаление Mihomo"},
            {"flag": "-dk",     "desc": "Удаление XKeen"},
        ],
    },
    {
        "title": "Удаление | Задачи автообновления",
        "items": [
            {"flag": "-dgc", "desc": "Удаление задачи автообновления GeoFile"},
        ],
    },
    {
        "title": "Удаление | Регистрация в системе",
        "items": [
            {"flag": "-drk", "desc": "Удаление регистрации XKeen"},
            {"flag": "-drx", "desc": "Удаление регистрации Xray"},
            {"flag": "-drm", "desc": "Удаление регистрации Mihomo"},
        ],
    },
    {
        "title": "Порты | Рабочие порты прокси-клиента",
        "items": [
            {"flag": "-ap", "desc": "Добавить порт"},
            {"flag": "-dp", "desc": "Удалить порт"},
            {"flag": "-cp", "desc": "Посмотреть список портов"},
        ],
    },
    {
        "title": "Порты | Исключённые из прокси",
        "items": [
            {"flag": "-ape", "desc": "Добавить исключённый порт"},
            {"flag": "-dpe", "desc": "Удалить исключённый порт"},
            {"flag": "-cpe", "desc": "Посмотреть исключённые порты"},
        ],
    },
    {
        "title": "Переустановка",
        "items": [
            {"flag": "-k", "desc": "Переустановка XKeen"},
            {"flag": "-g", "desc": "Переустановка GeoFile"},
        ],
    },
    {
        "title": "Резервные копии | XKeen",
        "items": [
            {"flag": "-kb",  "desc": "Создание резервной копии XKeen"},
            {"flag": "-kbr", "desc": "Восстановление XKeen из резервной копии"},
        ],
    },
    {
        "title": "Резервные копии | Конфигурация Xray",
        "items": [
            {"flag": "-cb",  "desc": "Создание резервной копии конфигурации Xray"},
            {"flag": "-cbr", "desc": "Восстановление конфигурации Xray из резервной копии"},
        ],
    },
    {
        "title": "Резервные копии | Конфигурация Mihomo",
        "items": [
            {"flag": "-mb",  "desc": "Создание резервной копии конфигурации Mihomo"},
            {"flag": "-mbr", "desc": "Восстановление конфигурации Mihomo из резервной копии"},
        ],
    },
    {
        "title": "Управление прокси-клиентом",
        "items": [
            {"flag": "-start",   "desc": "Запуск прокси-клиента"},
            {"flag": "-stop",    "desc": "Остановка прокси-клиента"},
            {"flag": "-restart", "desc": "Перезапуск прокси-клиента"},
            {"flag": "-status",  "desc": "Статус работы прокси-клиента"},
            {"flag": "-tpx",     "desc": "Порты, шлюз и протокол прокси-клиента"},
            {"flag": "-auto",    "desc": "Включить / отключить автозапуск прокси-клиента"},
            {"flag": "-d",       "desc": "Установить задержку автозапуска прокси-клиента"},
            {"flag": "-fd",      "desc": "Вкл/выкл контроль файловых дескрипторов прокси-клиента"},
            {"flag": "-diag",    "desc": "Выполнить диагностику"},
            {"flag": "-channel", "desc": "Переключить канал обновлений XKeen (Stable / Dev)"},
            {"flag": "-xray",    "desc": "Переключить XKeen на ядро Xray"},
            {"flag": "-mihomo",  "desc": "Переключить XKeen на ядро Mihomo"},
        ],
    },
    {
        "title": "Управление модулями",
        "items": [
            {"flag": "-modules",    "desc": "Перенос модулей XKeen в пользовательскую директорию"},
            {"flag": "-delmodules", "desc": "Удаление модулей из пользовательской директории"},
        ],
    },
    {
        "title": "Информация",
        "items": [
            {"flag": "-about", "desc": "О программе"},
            {"flag": "-ad",    "desc": "Поддержать разработчиков"},
            {"flag": "-af",    "desc": "Обратная связь"},
            {"flag": "-v",     "desc": "Версия XKeen"},
        ],
    },
]

ALLOWED_FLAGS = {item["flag"] for group in COMMAND_GROUPS for item in group["items"]}
XKEEN_BIN = "xkeen"


app = Flask(__name__, static_folder="static", template_folder="templates")
app.secret_key = "xkeen-ui-key-change-me"


# ---------- helpers ----------

def load_json(path, default=None):
    try:
        with open(path, "r") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save_json(path, data):
    d = os.path.dirname(path)
    if d and not os.path.isdir(d):
        os.makedirs(d, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


def load_text(path, default=""):
    try:
        with open(path, "r") as f:
            return f.read()
    except FileNotFoundError:
        return default


def save_text(path, content):
    d = os.path.dirname(path)
    if d and not os.path.isdir(d):
        os.makedirs(d, exist_ok=True)
    with open(path, "w") as f:
        f.write(content)



def _detect_backup_target_file(filename: str):
    """Return which config file this backup filename should restore into.

    We rely on filename prefixes that we control when creating backups:
    - 05_routing-YYYY... -> ROUTING_FILE
    - 03_inbounds-YYYY... -> INBOUNDS_FILE
    - 04_outbounds-YYYY... -> OUTBOUNDS_FILE
    Anything else defaults to ROUTING_FILE for backwards compatibility.
    """
    if filename.startswith("03_inbounds-"):
        return INBOUNDS_FILE
    if filename.startswith("04_outbounds-"):
        return OUTBOUNDS_FILE
    return ROUTING_FILE


def _find_latest_auto_backup_for(config_path: str):
    """Find newest auto-backup file for given config, created by install.sh.

    install.sh uses the pattern:
        ${NAME}.auto-backup-YYYYMMDD-HHMMSS
    where NAME is basename of the config file (e.g. 05_routing.json).
    """
    base = os.path.basename(config_path)
    if not os.path.isdir(BACKUP_DIR):
        return None, None
    latest = None
    latest_mtime = None
    prefix = base + ".auto-backup-"
    for name in os.listdir(BACKUP_DIR):
        if not name.startswith(prefix):
            continue
        full = os.path.join(BACKUP_DIR, name)
        try:
            st = os.stat(full)
        except OSError:
            continue
        if latest is None or st.st_mtime > latest_mtime:
            latest = full
            latest_mtime = st.st_mtime
    return latest, latest_mtime


def list_backups():
    items = []
    if not os.path.isdir(BACKUP_DIR):
        return items
    for name in os.listdir(BACKUP_DIR):
        # Список показывает только ручные JSON-бэкапы:
        # 05_routing-*, 03_inbounds-*, 04_outbounds-*.
        if not name.endswith(".json"):
            continue
        full = os.path.join(BACKUP_DIR, name)
        try:
            st = os.stat(full)
        except OSError:
            continue
        items.append(
            {
                "name": name,
                "size": st.st_size,
                "mtime": time.strftime(
                    "%Y-%m-%d %H:%M:%S", time.localtime(st.st_mtime)
                ),
            }
        )
    items.sort(key=lambda x: x["mtime"], reverse=True)
    return items




def append_restart_log(ok, source="api"):
    line = "[{ts}] source={src} result={res}\n".format(
        ts=time.strftime("%Y-%m-%d %H:%M:%S"),
        src=source,
        res="OK" if ok else "FAIL",
    )
    log_dir = os.path.dirname(RESTART_LOG_FILE)
    if log_dir and not os.path.isdir(log_dir):
        os.makedirs(log_dir, exist_ok=True)
    try:
        with open(RESTART_LOG_FILE, "a") as f:
            f.write(line)
    except Exception:
        pass


def read_restart_log(limit=100):
    if not os.path.isfile(RESTART_LOG_FILE):
        return []
    try:
        with open(RESTART_LOG_FILE, "r") as f:
            lines = f.readlines()
        return lines[-limit:]
    except Exception:
        return []


def restart_xkeen(source="api"):
    try:
        subprocess.check_call(XKEEN_RESTART_CMD)
        append_restart_log(True, source=source)
        return True
    except Exception:
        append_restart_log(False, source=source)
        return False


# ---------- INBOUNDS presets (03_inbounds.json) ----------

MIXED_INBOUNDS = {
    "inbounds": [
        {
            "tag": "redirect",
            "port": 61219,
            "protocol": "dokodemo-door",
            "settings": {"network": "tcp", "followRedirect": True},
            "sniffing": {
                "enabled": True,
                "routeOnly": True,
                "destOverride": ["http", "tls"],
            },
        },
        {
            "tag": "tproxy",
            "port": 61219,
            "protocol": "dokodemo-door",
            "settings": {"network": "udp", "followRedirect": True},
            "streamSettings": {"sockopt": {"tproxy": "tproxy"}},
            "sniffing": {
                "enabled": True,
                "routeOnly": True,
                "destOverride": ["http", "tls"],
            },
        },
    ]
}

TPROXY_INBOUNDS = {
    "inbounds": [
        {
            "tag": "tproxy",
            "port": 61219,
            "protocol": "dokodemo-door",
            "settings": {"network": "tcp,udp", "followRedirect": True},
            "streamSettings": {"sockopt": {"tproxy": "tproxy"}},
            "sniffing": {
                "routeOnly": True,
                "enabled": True,
                "destOverride": ["http", "tls", "quic"],
            },
        }
    ]
}

REDIRECT_INBOUNDS = {
    "inbounds": [
        {
            "tag": "redirect",
            "port": 61219,
            "protocol": "dokodemo-door",
            "settings": {"network": "tcp", "followRedirect": True},
            "sniffing": {
                "enabled": True,
                "routeOnly": True,
                "destOverride": ["http", "tls"],
            },
        }
    ]
}


def load_inbounds():
    return load_json(INBOUNDS_FILE, default=None)


def save_inbounds(data):
    save_json(INBOUNDS_FILE, data)


def detect_inbounds_mode():
    data = load_inbounds()
    if not data:
        return None
    if data == MIXED_INBOUNDS:
        return "mixed"
    if data == TPROXY_INBOUNDS:
        return "tproxy"
    if data == REDIRECT_INBOUNDS:
        return "redirect"
    return "custom"


# ---------- OUTBOUNDS VLESS helper (04_outbounds.json) ----------

def build_vless_url_from_config(cfg):
    try:
        outbounds = cfg.get("outbounds", [])
        if not outbounds:
            return None
        main = outbounds[0]
        if main.get("protocol") != "vless":
            return None
        vnext = main["settings"]["vnext"][0]
        addr = vnext["address"]
        port = vnext["port"]
        user = vnext["users"][0]
        uid = user["id"]
        flow = user.get("flow", "xtls-rprx-vision")
        enc = user.get("encryption", "none")

        stream = main.get("streamSettings", {})
        security = stream.get("security", "reality")
        reality = stream.get("realitySettings", {})
        pbk = reality.get("publicKey", "")
        fp = reality.get("fingerprint", "chrome")
        sni = reality.get("serverName", addr)
        sid = reality.get("shortId", "")
        spx = reality.get("spiderX", "/")

        params = []
        params.append(f"encryption={enc}")
        params.append(f"flow={flow}")
        params.append(f"security={security}")
        if pbk:
            params.append(f"pbk={pbk}")
        if fp:
            params.append(f"fp={fp}")
        if sni:
            params.append(f"sni={sni}")
        if sid:
            params.append(f"sid={sid}")
        if spx:
            params.append(f"spx={quote(spx)}")

        query = "&".join(params)
        return f"vless://{uid}@{addr}:{port}?{query}"
    except Exception:
        return None


def build_outbounds_config_from_vless(url):
    parsed = urlparse(url.strip())
    if parsed.scheme != "vless":
        raise ValueError("Ожидается ссылка vless://")

    if "@" not in parsed.netloc:
        raise ValueError("Некорректный формат vless: нет '@'")
    user_part, host_part = parsed.netloc.split("@", 1)
    if ":" not in host_part:
        raise ValueError("Некорректный формат vless: нет порта")
    host, port_str = host_part.split(":", 1)
    try:
        port = int(port_str)
    except ValueError:
        raise ValueError("Некорректный порт в ссылке vless")

    uid = user_part
    qs = parse_qs(parsed.query)

    def qget(key, default=None):
        vals = qs.get(key)
        return vals[0] if vals else default

    enc = qget("encryption", "none")
    flow = qget("flow", "xtls-rprx-vision")
    security = qget("security", "reality")
    pbk = qget("pbk", "")
    fp = qget("fp", "chrome")
    sni = qget("sni", host)
    sid = qget("sid", "")
    spx = qget("spx", "/") or "/"
    spx = unquote(spx)

    cfg = {
        "outbounds": [
            {
                "tag": "vless-reality",
                "protocol": "vless",
                "settings": {
                    "vnext": [
                        {
                            "address": host,
                            "port": port,
                            "users": [
                                {
                                    "id": uid,
                                    "flow": flow,
                                    "encryption": enc,
                                    "level": 0,
                                }
                            ],
                        }
                    ]
                },
                "streamSettings": {
                    "network": "tcp",
                    "security": security,
                    "realitySettings": {
                        "publicKey": pbk,
                        "fingerprint": fp,
                        "serverName": sni,
                        "shortId": sid,
                        "spiderX": spx,
                    },
                },
            },
            {"tag": "direct", "protocol": "freedom"},
            {
                "tag": "block",
                "protocol": "blackhole",
                "settings": {"response": {"type": "http"}},
            },
        ]
    }
    return cfg


def load_outbounds():
    return load_json(OUTBOUNDS_FILE, default=None)


def save_outbounds(cfg):
    save_json(OUTBOUNDS_FILE, cfg)


# ---------- routes: UI ----------

@app.get("/")
def index():
    return render_template(
        "panel.html",
        routing_file=ROUTING_FILE,
        inbounds_file=INBOUNDS_FILE,
        outbounds_file=OUTBOUNDS_FILE,
        backup_dir=BACKUP_DIR,
        command_groups=COMMAND_GROUPS,
    )



@app.get("/xkeen")
def xkeen_page():
    return render_template("xkeen.html")


@app.get("/backups")
def backups_page():
    return render_template("backups.html", backups=list_backups(), backup_dir=BACKUP_DIR)


# ---------- API: routing (05_routing.json) ----------

@app.get("/api/routing")
def api_get_routing():
    data = load_json(ROUTING_FILE, default={})
    return jsonify(data), 200


@app.post("/api/routing")
def api_set_routing():
    payload = request.get_json(silent=True)
    if payload is None:
        return jsonify({"ok": False, "error": "invalid json"}), 400
    save_json(ROUTING_FILE, payload)
    restarted = restart_xkeen(source="routing")
    return jsonify({"ok": True, "restarted": restarted}), 200


# ---------- API: mihomo config.yaml ----------

@app.get("/api/mihomo-config")
def api_get_mihomo_config():
    content = load_text(MIHOMO_CONFIG_FILE, default=None)
    if content is None:
        return jsonify(
            {"ok": False, "error": f"Файл {MIHOMO_CONFIG_FILE} не найден"}
        ), 404
    return jsonify({"ok": True, "content": content}), 200


@app.post("/api/mihomo-config")
def api_set_mihomo_config():
    data = request.get_json(silent=True) or {}
    content = data.get("content", "")
    save_text(MIHOMO_CONFIG_FILE, content)
    restarted = restart_xkeen(source="mihomo-config")
    return jsonify({"ok": True, "restarted": restarted}), 200


@app.get("/api/mihomo-config/template")
def api_get_mihomo_default_template():
    content = load_text(MIHOMO_DEFAULT_TEMPLATE, default=None)
    if content is None:
        return jsonify(
            {"ok": False, "error": f"Файл шаблона {MIHOMO_DEFAULT_TEMPLATE} не найден"}
        ), 404
    return jsonify({"ok": True, "content": content}), 200


# ---------- API: mihomo templates directory ----------

def _safe_template_path(name: str):
    # не даём уходить вверх по дереву и использовать подкаталоги
    if not name or "/" in name or "\\" in name or ".." in name:
        return None
    if not name.endswith(".yaml") and not name.endswith(".yml"):
        name = name + ".yaml"
    return os.path.join(MIHOMO_TEMPLATES_DIR, name)


@app.get("/api/mihomo-templates")
def api_list_mihomo_templates():
    if not os.path.isdir(MIHOMO_TEMPLATES_DIR):
        os.makedirs(MIHOMO_TEMPLATES_DIR, exist_ok=True)

    items = []
    for fname in sorted(os.listdir(MIHOMO_TEMPLATES_DIR)):
        if not (fname.endswith(".yaml") or fname.endswith(".yml")):
            continue
        items.append({"name": fname})

    return jsonify({"ok": True, "templates": items}), 200


@app.get("/api/mihomo-template")
def api_get_mihomo_template():
    name = request.args.get("name", "").strip()
    path = _safe_template_path(name)
    if not path:
        return jsonify({"ok": False, "error": "invalid template name"}), 400

    content = load_text(path, default=None)
    if content is None:
        return jsonify({"ok": False, "error": "template not found"}), 404

    return jsonify({"ok": True, "content": content, "name": os.path.basename(path)}), 200


@app.post("/api/mihomo-template")
def api_save_mihomo_template():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    content = data.get("content", "")

    path = _safe_template_path(name)
    if not path:
        return jsonify({"ok": False, "error": "invalid template name"}), 400

    d = os.path.dirname(path)
    if not os.path.isdir(d):
        os.makedirs(d, exist_ok=True)

    save_text(path, content)
    return jsonify({"ok": True, "name": os.path.basename(path)}), 200



# ---------- API: restart xkeen ----------
@app.post("/api/restart-xkeen")
def api_restart_xkeen():
    restarted = restart_xkeen(source="manual-mihomo")
    return jsonify({"ok": True, "restarted": restarted}), 200


# ---------- API: backups ----------

@app.post("/api/backup")
def api_create_backup():
    data = load_json(ROUTING_FILE, default=None)
    if data is None:
        return jsonify({"ok": False, "error": "routing file missing or invalid"}), 400

    if not os.path.isdir(BACKUP_DIR):
        os.makedirs(BACKUP_DIR, exist_ok=True)

    ts = time.strftime("%Y%m%d-%H%M%S")
    fname = f"05_routing-{ts}.json"
    path = os.path.join(BACKUP_DIR, fname)
    save_json(path, data)
    return jsonify({"ok": True, "filename": fname}), 200


@app.post("/api/backup-inbounds")
def api_create_backup_inbounds():
    data = load_json(INBOUNDS_FILE, default=None)
    if data is None:
        return jsonify({"ok": False, "error": "inbounds file missing or invalid"}), 400

    if not os.path.isdir(BACKUP_DIR):
        os.makedirs(BACKUP_DIR, exist_ok=True)

    ts = time.strftime("%Y%m%d-%H%M%S")
    fname = f"03_inbounds-{ts}.json"
    path = os.path.join(BACKUP_DIR, fname)
    save_json(path, data)
    return jsonify({"ok": True, "filename": fname}), 200


@app.post("/api/backup-outbounds")
def api_create_backup_outbounds():
    data = load_json(OUTBOUNDS_FILE, default=None)
    if data is None:
        return jsonify({"ok": False, "error": "outbounds file missing or invalid"}), 400

    if not os.path.isdir(BACKUP_DIR):
        os.makedirs(BACKUP_DIR, exist_ok=True)

    ts = time.strftime("%Y%m%d-%H%M%S")
    fname = f"04_outbounds-{ts}.json"
    path = os.path.join(BACKUP_DIR, fname)
    save_json(path, data)
    return jsonify({"ok": True, "filename": fname}), 200


@app.get("/api/backups")
def api_list_backups():
    return jsonify(list_backups()), 200


@app.post("/api/restore")
def api_restore_backup():
    payload = request.get_json(silent=True) or {}
    filename = payload.get("filename")
    if not filename:
        return jsonify({"ok": False, "error": "filename is required"}), 400

    path = os.path.join(BACKUP_DIR, filename)
    if not os.path.isfile(path):
        return jsonify({"ok": False, "error": "backup not found"}), 404

    data = load_json(path, default=None)
    if data is None:
        return jsonify({"ok": False, "error": "backup file invalid"}), 400

    target_file = _detect_backup_target_file(filename)
    save_json(target_file, data)
    return jsonify({"ok": True}), 200


@app.post("/api/restore-auto")
def api_restore_auto_backup():
    payload = request.get_json(silent=True) or {}
    target = (payload.get("target") or "").strip()
    if target not in ("routing", "inbounds", "outbounds"):
        return jsonify({"ok": False, "error": "invalid target"}), 400

    if target == "routing":
        config_path = ROUTING_FILE
    elif target == "inbounds":
        config_path = INBOUNDS_FILE
    else:
        config_path = OUTBOUNDS_FILE

    backup_path, mtime = _find_latest_auto_backup_for(config_path)
    if not backup_path:
        return jsonify({"ok": False, "error": "auto-backup not found"}), 404

    data = load_json(backup_path, default=None)
    if data is None:
        return jsonify({"ok": False, "error": "auto-backup file invalid"}), 400

    save_json(config_path, data)
    filename = os.path.basename(backup_path)
    return jsonify(
        {
            "ok": True,
            "filename": filename,
            "target": target,
        }
    ), 200


@app.post("/restore")
def restore_from_backups_page():
    filename = request.form.get("filename")
    if not filename:
        return redirect(url_for("backups_page"))
    path = os.path.join(BACKUP_DIR, filename)
    if os.path.isfile(path):
        data = load_json(path, default=None)
        if data is not None:
            target_file = _detect_backup_target_file(filename)
            save_json(target_file, data)
            restart_xkeen(source="backups-page")
    return redirect(url_for("backups_page"))

# ---------- API: restart xkeen ----------

@app.post("/api/restart")
def api_restart():
    ok = restart_xkeen(source="api-button")
    if ok:
        return jsonify({"ok": True}), 200
    return jsonify({"ok": False}), 500



@app.post("/api/run-command")
def api_run_command():
    data = request.get_json(silent=True) or {}
    flag = str(data.get("flag", "")).strip()
    if not flag:
        return jsonify({"error": "empty flag"}), 400
    if flag not in ALLOWED_FLAGS:
        return jsonify({"error": "flag not allowed"}), 400

    stdin_data = data.get("stdin")
    cmd = [XKEEN_BIN, flag]
    try:
        proc = subprocess.run(
            cmd,
            input=stdin_data if stdin_data is not None else None,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=300,
        )
        output = proc.stdout or ""

        # strip ANSI escape codes
        import re as _re
        ansi = _re.compile(r"\x1B[@-_][0-?]*[ -/]*[@-~]")
        output = ansi.sub("", output)

        # remove Entware / opkg noise
        cleaned = []
        for line in output.splitlines():
            low = line.lower()
            if "collected errors" in low:
                continue
            if "opkg_conf" in low or "opkg" in low:
                continue
            cleaned.append(line)
        output = "\n".join(cleaned).strip()

        return jsonify({"exit_code": proc.returncode, "output": output}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ---------- API: restart log ----------

@app.get("/api/restart-log")
def api_restart_log():
    lines = read_restart_log(limit=100)
    return jsonify({"lines": lines}), 200


# ---------- API: xkeen text configs (/opt/etc/xkeen/*.lst) ----------

DEFAULT_PORT_PROXYING = """#80
#443
#596:599

# (Раскомментируйте/добавьте по образцу) единичные порты и диапазоны для проскирования
"""

DEFAULT_PORT_EXCLUDE = """#
# Одновременно использовать порты проксирования и исключать порты нельзя
# Приоритет у портов проксирования
"""

DEFAULT_IP_EXCLUDE = """#192.168.0.0/16
#2001:db8::/32

# Добавьте необходимые IP и подсети без комментария # для исключения их из проксирования
"""


@app.get("/api/xkeen/port-proxying")
def api_get_port_proxying():
    content = load_text(PORT_PROXYING_FILE, default=DEFAULT_PORT_PROXYING)
    return jsonify({"content": content}), 200


@app.post("/api/xkeen/port-proxying")
def api_set_port_proxying():
    payload = request.get_json(silent=True) or {}
    content = payload.get("content", "")
    save_text(PORT_PROXYING_FILE, content)
    restarted = restart_xkeen(source="port-proxying")
    return jsonify({"ok": True, "restarted": restarted}), 200


@app.get("/api/xkeen/port-exclude")
def api_get_port_exclude():
    content = load_text(PORT_EXCLUDE_FILE, default=DEFAULT_PORT_EXCLUDE)
    return jsonify({"content": content}), 200


@app.post("/api/xkeen/port-exclude")
def api_set_port_exclude():
    payload = request.get_json(silent=True) or {}
    content = payload.get("content", "")
    save_text(PORT_EXCLUDE_FILE, content)
    restarted = restart_xkeen(source="port-exclude")
    return jsonify({"ok": True, "restarted": restarted}), 200


@app.get("/api/xkeen/ip-exclude")
def api_get_ip_exclude():
    content = load_text(IP_EXCLUDE_FILE, default=DEFAULT_IP_EXCLUDE)
    return jsonify({"content": content}), 200


@app.post("/api/xkeen/ip-exclude")
def api_set_ip_exclude():
    payload = request.get_json(silent=True) or {}
    content = payload.get("content", "")
    save_text(IP_EXCLUDE_FILE, content)
    restarted = restart_xkeen(source="ip-exclude")
    return jsonify({"ok": True, "restarted": restarted}), 200


# ---------- API: inbounds (03_inbounds.json) ----------

@app.get("/api/inbounds")
def api_get_inbounds():
    mode = detect_inbounds_mode()
    data = load_inbounds()
    return jsonify({"mode": mode, "config": data}), 200


@app.post("/api/inbounds")
def api_set_inbounds():
    payload = request.get_json(silent=True) or {}
    mode = payload.get("mode")

    if mode not in ("mixed", "tproxy", "redirect"):
        return jsonify({"ok": False, "error": "invalid mode"}), 400

    if mode == "mixed":
        data = MIXED_INBOUNDS
    elif mode == "tproxy":
        data = TPROXY_INBOUNDS
    else:
        data = REDIRECT_INBOUNDS

    save_inbounds(data)
    restarted = restart_xkeen(source="inbounds")

    return jsonify({"ok": True, "mode": mode, "restarted": restarted}), 200


# ---------- API: outbounds (04_outbounds.json) ----------

@app.get("/api/outbounds")
def api_get_outbounds():
    cfg = load_outbounds()
    url = None
    if cfg:
        url = build_vless_url_from_config(cfg)
    return jsonify({"url": url, "config": cfg}), 200


@app.post("/api/outbounds")
def api_set_outbounds():
    payload = request.get_json(silent=True) or {}
    url = (payload.get("url") or "").strip()
    if not url:
        return jsonify({"ok": False, "error": "url is required"}), 400
    try:
        cfg = build_outbounds_config_from_vless(url)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400

    save_outbounds(cfg)
    restarted = restart_xkeen(source="outbounds")
    return jsonify({"ok": True, "restarted": restarted}), 200


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8088)
