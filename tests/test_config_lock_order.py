"""Порядок блокировок конфигурации: без взаимного ожидания.

Сохранение routing и outbounds через API и обновление подписок пишут одни и
те же файлы, поэтому берут обе блокировки: действия над подписками
(`_CONFIG_LOCK`) и DNS-over-VLESS (`_LOCK`).  Порядок обязан быть один —
сначала действия, затем DNS.  Сервер работает на gevent с monkey-patch,
поэтому встречное ожидание не разрешается таймаутом: панель зависает
навсегда до перезапуска.
"""

from __future__ import annotations

import json
import sys
import types
from pathlib import Path

from flask import Blueprint, Flask


for _mod_name in ("termios", "tty", "pty"):
    if _mod_name not in sys.modules:
        sys.modules[_mod_name] = types.ModuleType(_mod_name)


class _SpyLock:
    """Блокировка, которая записывает порядок входа и выхода."""

    def __init__(self, name: str, log: list) -> None:
        self._name = name
        self._log = log

    def __enter__(self):
        self._log.append(("enter", self._name))
        return self

    def __exit__(self, *_exc):
        self._log.append(("exit", self._name))
        return False


def test_config_update_lock_takes_the_config_lock_first(monkeypatch):
    from services import dns_over_vless as dov
    from services import xray_subscriptions as subs

    log: list = []
    monkeypatch.setattr(subs, "_CONFIG_LOCK", _SpyLock("config", log))
    monkeypatch.setattr(dov, "_LOCK", _SpyLock("dns", log))

    with dov.config_update_lock():
        pass

    assert log == [
        ("enter", "config"),
        ("enter", "dns"),
        ("exit", "dns"),
        ("exit", "config"),
    ]


def _make_app(configs_dir: Path) -> Flask:
    from routes.routing.config import register_config_routes

    app = Flask(__name__)
    app.config["TESTING"] = True
    bp = Blueprint("routing_lock_test", __name__)
    register_config_routes(
        bp,
        routing_file=str(configs_dir / "05_routing.json"),
        routing_file_raw=str(configs_dir / "05_routing.jsonc"),
        xray_configs_dir=str(configs_dir),
        xray_configs_dir_real=str(configs_dir),
        backup_dir="",
        backup_dir_real="",
        load_json=lambda path, default=None: json.loads(Path(path).read_text(encoding="utf-8")),
        strip_json_comments_text=lambda text: __import__("utils.jsonc", fromlist=["x"]).strip_json_comments_text(text),
        restart_xkeen=lambda **_kwargs: False,
    )
    app.register_blueprint(bp)
    return app


def test_saving_routing_takes_the_config_lock_first(tmp_path, monkeypatch):
    """Маршрут сохранения не должен брать блокировку DNS раньше общей."""
    from services import dns_over_vless as dov
    from services import xray_subscriptions as subs

    log: list = []
    monkeypatch.setattr(subs, "_CONFIG_LOCK", _SpyLock("config", log))
    monkeypatch.setattr(dov, "_LOCK", _SpyLock("dns", log))

    app = _make_app(tmp_path)
    payload = json.dumps({"routing": {"rules": [{"type": "field", "outboundTag": "direct"}]}})

    with app.test_client() as client:
        response = client.post(
            "/api/routing?skip_preflight=1",
            data=payload,
            content_type="application/json",
        )

    assert response.status_code == 200
    entered = [entry for entry in log if entry[0] == "enter"]
    assert entered[0] == ("enter", "config"), log
    assert entered[1] == ("enter", "dns"), log
