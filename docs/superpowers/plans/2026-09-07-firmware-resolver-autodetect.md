# Автоопределение резолвера прошивки — план работ

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Панель сама находит резолверы прошивки (`127.0.0.1:41100` и соседние), подставляет их в локальные зоны DNS-over-VLESS при включении и чинит запись, когда порт уезжает.

**Architecture:** Новый маленький сервис `firmware_resolvers` читает `/var/ndnproxy_*.conf` и отдаёт список адресов. `get_status` показывает найденное, `apply_action` подставляет его при включении, если пользователь ничего не задал, а `reconcile` сторожевого цикла сверяет записанное с найденным и переприменяет конфигурацию не чаще раза в час. Карточка показывает найденное и расхождение.

**Tech Stack:** Python 3.12, Flask-блюпринты панели, pytest; ванильный JS (`XKeen.ui.settings`), Jinja-шаблон `panel.html`, Playwright для e2e.

**Spec:** `docs/superpowers/specs/2026-09-07-firmware-resolver-autodetect.md`

## Global Constraints

- Панель работает на роутере, но тесты — нет: **ни одна новая функция не должна ходить в `/var` без параметра, который тест подменит на `tmp_path`**. Значение по умолчанию — `NDNPROXY_CONF_DIR`.
- Ни одна из новых функций не бросает исключений наружу при недоступных файлах: не Keenetic — просто пустой список.
- Адрес `127.0.0.1:53` не может попасть в результат никогда: там слушает сам Xray, и `_parse_local_resolver` отвергает такой адрес кодом `local_resolver_loop`.
- Лимит адресов — `MAX_LOCAL_RESOLVERS = 16` (`services/dns_over_vless.py`).
- Комментарии и докстринги в `services/*.py` — по-английски, как в соседних модулях; тексты ошибок и всё, что видит пользователь, — по-русски. Комментарии в JS — по-русски.
- Запуск python-тестов: `python -m pytest tests -q`. Перед e2e обязателен `npm run frontend:build`.
- Коммиты: `git -c user.name="olmer2002" -c user.email="olmer2002@gmail.com" commit`. Сообщения на русском, простым языком, без трейлеров `Co-Authored-By`. **В remote не пушить.**
- После правок фронтенда: `npm run frontend:build`, затем `npm run archive:user:skip-build`.

---

### Task 1: Сервис, который находит резолверы прошивки

**Files:**
- Create: `xkeen-ui/services/firmware_resolvers.py`
- Test: `tests/test_firmware_resolvers.py`

**Interfaces:**
- Consumes: ничего.
- Produces: `firmware_resolvers.discover(conf_dir: str = NDNPROXY_CONF_DIR) -> list[str]` — адреса вида `"127.0.0.1:41100"`, по возрастанию порта; `firmware_resolvers.parse_listen_port(text: str) -> int` — порт из текста одного конфига или `0`; константы `NDNPROXY_CONF_DIR`, `NDNPROXY_CONF_PATTERN`, `MAX_RESOLVERS`. Задачи 2, 3, 4 зовут только `discover`.

- [ ] **Step 1: Написать падающий тест**

```python
# tests/test_firmware_resolvers.py
"""Порты резолверов прошивки берутся из её же конфигов.

KeeneticOS держит по одному ndnproxy на политику доступа, и порт каждого
записан в его конфиге. Главный ndnproxy порта не называет — он на 53,
а 53 после включения DNS-over-VLESS занимает Xray.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "xkeen-ui"))

from services import firmware_resolvers as fr  # noqa: E402

POLICY_CONF = """timeout = 7000
proceed = 500
stat_file = /var/ndnproxy_Policy0.stat
dns_server = 127.0.0.1:40516 . # 77.88.8.8:853@common.dot.dns.yandex.net
static_a = whatsapp.com 213.176.74.63 0
set-profile-ip 127.0.0.1 0
dns_tcp_port = {port}
dns_udp_port = {port}
"""

MAIN_CONF = """rpc_port = 54321
timeout = 7000
rr_port = 40901
set-profile-ip 127.0.0.1 0
"""


def _policy(dir_path: Path, index: int, port: int) -> None:
    (dir_path / f"ndnproxy_Policy{index}.conf").write_text(
        POLICY_CONF.format(port=port), encoding="utf-8"
    )


def test_finds_every_policy_resolver_sorted_by_port(tmp_path: Path):
    _policy(tmp_path, 1, 41101)
    _policy(tmp_path, 0, 41100)
    _policy(tmp_path, 2, 41102)

    assert fr.discover(str(tmp_path)) == [
        "127.0.0.1:41100",
        "127.0.0.1:41101",
        "127.0.0.1:41102",
    ]


def test_main_resolver_is_not_offered(tmp_path: Path):
    # У главного ndnproxy нет dns_udp_port: он слушает 53, а там Xray.
    (tmp_path / "ndnproxymain.conf").write_text(MAIN_CONF, encoding="utf-8")
    _policy(tmp_path, 0, 41100)

    assert fr.discover(str(tmp_path)) == ["127.0.0.1:41100"]


def test_port_53_is_never_offered(tmp_path: Path):
    # Такой адрес — это сам DNS-over-VLESS, запрос вернулся бы к нему же.
    _policy(tmp_path, 0, 53)

    assert fr.discover(str(tmp_path)) == []


def test_missing_directory_is_not_an_error(tmp_path: Path):
    assert fr.discover(str(tmp_path / "нет-такого")) == []


def test_parse_listen_port_reads_the_udp_port():
    assert fr.parse_listen_port(POLICY_CONF.format(port=41100)) == 41100
    assert fr.parse_listen_port(MAIN_CONF) == 0
    assert fr.parse_listen_port("dns_udp_port = не число") == 0
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `python -m pytest tests/test_firmware_resolvers.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'services.firmware_resolvers'`

- [ ] **Step 3: Написать модуль**

```python
# xkeen-ui/services/firmware_resolvers.py
"""Where the firmware still answers DNS after Xray has taken port 53.

KeeneticOS runs one ``ndnproxy`` per access policy plus a main one.  The main
process names no port in its config, which means it listens on 53 -- and 53 is
ours the moment DNS-over-VLESS is on, so the only resolvers left that can
answer for home names are the per-policy ones on their own ports.

Read the config files rather than the firewall.  ``dns_clients`` learns a
device's resolver port from ``_NDM_HOTSPOT_DNSREDIR``, but the firmware writes
those rules only for policies that already hold a host, while a config file
exists for every policy.  Files are also fast enough for the status call, which
``ndmc`` is not.

Which policy the resolver belongs to does not matter here: measured on a
router, the per-policy configs carry identical ``static_a`` substitutions and
share one ``/var/ndnproxyhostmap.conf``, and all three answered a KeenDNS name
with the same address.  They differ only in the path they take outwards, and
this resolver is never asked about anything but local zones.
"""

from __future__ import annotations

import glob
import os
import re
from typing import List

# The firmware writes its generated configs here.
NDNPROXY_CONF_DIR = "/var"
# ``ndnproxymain.conf`` deliberately does not match: see the module docstring.
NDNPROXY_CONF_PATTERN = "ndnproxy_*.conf"
LOOPBACK = "127.0.0.1"
# The port DNS-over-VLESS itself listens on; a resolver there would loop.
LISTENER_PORT = 53
# Same ceiling as MAX_LOCAL_RESOLVERS in dns_over_vless: the whole list is
# offered as local resolvers, so it must fit there.
MAX_RESOLVERS = 16

_PORT_RE = re.compile(r"^\s*dns_udp_port\s*=\s*(\d+)\s*$", re.MULTILINE)


def parse_listen_port(text: str) -> int:
    """The UDP port one ndnproxy config listens on, or 0 when it names none."""
    match = _PORT_RE.search(str(text or ""))
    if not match:
        return 0
    try:
        port = int(match.group(1))
    except ValueError:
        return 0
    return port if 1 <= port <= 65535 else 0


def discover(conf_dir: str = NDNPROXY_CONF_DIR) -> List[str]:
    """Addresses of the firmware's own resolvers, lowest port first.

    Never raises: a machine that is not a Keenetic simply has no such files,
    and the caller shows an empty list instead of an error.
    """
    try:
        paths = sorted(glob.glob(os.path.join(str(conf_dir), NDNPROXY_CONF_PATTERN)))
    except Exception:
        return []
    ports: List[int] = []
    for path in paths:
        try:
            text = _read_text(path)
        except Exception:
            continue
        port = parse_listen_port(text)
        if not port or port == LISTENER_PORT or port in ports:
            continue
        ports.append(port)
    ports.sort()
    return [f"{LOOPBACK}:{port}" for port in ports[:MAX_RESOLVERS]]


def _read_text(path: str) -> str:
    with open(path, encoding="utf-8", errors="replace") as handle:
        return handle.read()
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `python -m pytest tests/test_firmware_resolvers.py -q`
Expected: PASS, 5 tests

- [ ] **Step 5: Коммит**

```bash
git add xkeen-ui/services/firmware_resolvers.py tests/test_firmware_resolvers.py
git -c user.name="olmer2002" -c user.email="olmer2002@gmail.com" commit -m "Панель находит резолверы прошивки сама

Читаем конфиги ndnproxy и узнаём, на каких портах прошивка отвечает
на домашние имена. Раньше этот порт нужно было знать наизусть."
```

---

### Task 2: Статус показывает найденное

**Files:**
- Modify: `xkeen-ui/services/dns_over_vless.py` — импорт рядом с `from services import dns_client_capture`; словарь ответа `get_status`, сразу после ключа `"max_local_resolvers"`
- Test: `tests/test_dns_over_vless.py`

**Interfaces:**
- Consumes: `firmware_resolvers.discover` (Task 1).
- Produces: ключ `firmware_resolvers` (список строк) в ответе `GET /api/routing/dns-over-vless`. Задача 6 читает его как `data.firmware_resolvers`.

- [ ] **Step 1: Написать падающий тест**

Дописать в конец `tests/test_dns_over_vless.py`:

```python
def test_status_names_the_firmware_resolvers(tmp_path: Path, monkeypatch):
    configs, routing_path, state = _scenario_config(tmp_path)
    monkeypatch.setattr(dns, "detect_running_core", lambda: "xray")
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (False, "test"))
    # Прошивки под тестами нет: подменяем поиск, а не файловую систему.
    monkeypatch.setattr(
        dns.firmware_resolvers, "discover", lambda *a, **kw: ["127.0.0.1:41100", "127.0.0.1:41101"]
    )

    result = dns.get_status(
        configs_dir=str(configs), routing_file=str(routing_path), ui_state_dir=str(state)
    )

    assert result["firmware_resolvers"] == ["127.0.0.1:41100", "127.0.0.1:41101"]


def test_status_survives_a_router_without_the_firmware_configs(tmp_path: Path, monkeypatch):
    configs, routing_path, state = _scenario_config(tmp_path)
    monkeypatch.setattr(dns, "detect_running_core", lambda: "xray")
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (False, "test"))

    result = dns.get_status(
        configs_dir=str(configs), routing_file=str(routing_path), ui_state_dir=str(state)
    )

    # На машине разработчика /var/ndnproxy_*.conf нет — это не ошибка.
    assert result["firmware_resolvers"] == []
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `python -m pytest tests/test_dns_over_vless.py -k firmware_resolvers -q`
Expected: FAIL — `AttributeError: module 'services.dns_over_vless' has no attribute 'firmware_resolvers'`

- [ ] **Step 3: Реализовать**

В импортах `xkeen-ui/services/dns_over_vless.py`, следом за `from services import dns_client_capture`:

```python
from services import firmware_resolvers
```

В словаре, который возвращает `get_status`, сразу после `"max_local_resolvers": MAX_LOCAL_RESOLVERS,`:

```python
        # What the firmware itself still answers on: the card offers these
        # instead of asking the user to know the port by heart.
        "firmware_resolvers": firmware_resolvers.discover(),
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `python -m pytest tests/test_dns_over_vless.py -q`
Expected: PASS (127 tests)

- [ ] **Step 5: Коммит**

```bash
git add xkeen-ui/services/dns_over_vless.py tests/test_dns_over_vless.py
git -c user.name="olmer2002" -c user.email="olmer2002@gmail.com" commit -m "Окно DNS-over-VLESS знает адреса резолверов прошивки

Панель отдаёт их вместе с остальным состоянием функции."
```

---

### Task 3: Включение подставляет найденное

**Files:**
- Modify: `xkeen-ui/services/dns_over_vless.py` — блок `wanted_local = (...)` внутри `apply_action`
- Test: `tests/test_dns_over_vless.py`

**Interfaces:**
- Consumes: `firmware_resolvers.discover` (Task 1).
- Produces: поведение `apply_action("enable", ..., local_resolver=None)` — в состояние пишутся найденные адреса, в routing появляется правило `xk_dns_over_vless_local`.

- [ ] **Step 1: Написать падающий тест**

```python
def test_enable_without_a_resolver_takes_the_firmware_one(tmp_path: Path, monkeypatch):
    configs, routing_path, state = _scenario_config(tmp_path)
    monkeypatch.setattr(dns, "detect_running_core", lambda: "xray")
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (False, "test"))
    monkeypatch.setattr(dns, "_dns_probe", lambda *a, **kw: {"ok": True})
    monkeypatch.setattr(dns.firmware_resolvers, "discover", lambda *a, **kw: ["127.0.0.1:41100"])

    dns.apply_action(
        "enable",
        configs_dir=str(configs),
        routing_file=str(routing_path),
        ui_state_dir=str(state),
        restart_xkeen=lambda *a, **kw: {"ok": True},
        target_tag="proxy",
    )

    saved = dns._load_state(str(state))
    assert saved["local_resolvers"] == ["127.0.0.1:41100"]


def test_enable_with_an_empty_field_keeps_no_resolver(tmp_path: Path, monkeypatch):
    configs, routing_path, state = _scenario_config(tmp_path)
    monkeypatch.setattr(dns, "detect_running_core", lambda: "xray")
    monkeypatch.setattr(dns, "_dns_override_status", lambda: (False, "test"))
    monkeypatch.setattr(dns, "_dns_probe", lambda *a, **kw: {"ok": True})
    monkeypatch.setattr(dns.firmware_resolvers, "discover", lambda *a, **kw: ["127.0.0.1:41100"])

    dns.apply_action(
        "enable",
        configs_dir=str(configs),
        routing_file=str(routing_path),
        ui_state_dir=str(state),
        restart_xkeen=lambda *a, **kw: {"ok": True},
        target_tag="proxy",
        # Пустая строка — это осознанный выбор пользователя, а не «не задано».
        local_resolver="",
    )

    saved = dns._load_state(str(state))
    assert saved["local_resolvers"] == []
```

Замечание исполнителю: если `_scenario_config` в этом файле возвращает другой набор значений или `apply_action` в существующих тестах вызывается с другими обязательными аргументами — повтори тот вызов, что уже используется в соседних тестах включения (`grep -n "apply_action(" tests/test_dns_over_vless.py`), поменяв только `local_resolver`.

- [ ] **Step 2: Убедиться, что первый тест падает**

Run: `python -m pytest tests/test_dns_over_vless.py -k "firmware_one or empty_field" -q`
Expected: первый FAIL (`assert [] == ["127.0.0.1:41100"]`), второй PASS

- [ ] **Step 3: Реализовать**

В `apply_action` заменить блок

```python
        wanted_local = (
            _parse_local_resolvers(local_resolver)
            if local_resolver is not None
            else _parse_local_resolvers(stored_state.get("local_resolvers"))
        )
```

на

```python
        # A resolver the user typed wins; then whatever this install already
        # chose; and only if neither exists do we look at what the firmware
        # offers.  An explicitly emptied field is a decision, not a blank: it
        # arrives as "" rather than None and stops right here.
        if local_resolver is not None:
            wanted_local = _parse_local_resolvers(local_resolver)
        elif stored_state.get("local_resolvers"):
            wanted_local = _parse_local_resolvers(stored_state.get("local_resolvers"))
        elif normalized == "enable":
            wanted_local = _parse_local_resolvers(firmware_resolvers.discover())
        else:
            wanted_local = []
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `python -m pytest tests/test_dns_over_vless.py -q`
Expected: PASS

- [ ] **Step 5: Коммит**

```bash
git add xkeen-ui/services/dns_over_vless.py tests/test_dns_over_vless.py
git -c user.name="olmer2002" -c user.email="olmer2002@gmail.com" commit -m "Домашние имена настраиваются сами при включении

Если поле локального DNS пустое, панель подставляет резолверы прошивки,
и домашние имена перестают уезжать в тоннель. Очищенное вручную поле
остаётся пустым."
```

---

### Task 4: Сторож замечает уехавший порт

**Files:**
- Modify: `xkeen-ui/services/dns_over_vless.py` — новая функция `recheck_local_resolvers` рядом с `reapply_client_capture`; константа `LOCAL_RESOLVER_RESYNC_INTERVAL` рядом с `PASS_SWITCH_INTERVAL`
- Modify: `xkeen-ui/services/dns_guard.py` — `_watch_xray_dns` внутри `build_protections`
- Test: `tests/test_dns_over_vless_resolver_resync.py`

**Interfaces:**
- Consumes: `firmware_resolvers.discover` (Task 1), `apply_action` (Task 3).
- Produces: `dns_over_vless.recheck_local_resolvers(*, configs_dir: str, routing_file: str, ui_state_dir: str, restart_xkeen) -> str` — возвращает пустую строку, когда ничего делать не нужно, и короткое описание сделанного, когда адреса переписаны. Вызывается только из `dns_guard._watch_xray_dns`.

- [ ] **Step 1: Написать падающий тест**

```python
# tests/test_dns_over_vless_resolver_resync.py
"""Порт резолвера прошивки может уехать, и сторож это чинит.

Номер порта равен 41100 плюс индекс политики доступа. Пользователь удаляет
политику в веб-интерфейсе прошивки — и адрес, записанный в конфигурации Xray,
указывает в никуда. Тишина при этом полная: зона просто уходит в тоннель.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "xkeen-ui"))

from services import dns_over_vless as dns  # noqa: E402


def test_no_resync_when_the_addresses_still_match(tmp_path: Path, monkeypatch):
    state = tmp_path / "state"
    state.mkdir()
    dns._save_state(str(state), {"enabled": True, "local_resolvers": ["127.0.0.1:41100"]})
    monkeypatch.setattr(dns.firmware_resolvers, "discover", lambda *a, **kw: ["127.0.0.1:41100"])
    called = []
    monkeypatch.setattr(dns, "apply_action", lambda *a, **kw: called.append(kw))

    note = dns.recheck_local_resolvers(
        configs_dir=str(tmp_path), routing_file=str(tmp_path / "05_routing.json"),
        ui_state_dir=str(state), restart_xkeen=lambda *a, **kw: {"ok": True},
    )

    assert note == ""
    assert called == []


def test_resync_when_the_port_is_gone(tmp_path: Path, monkeypatch):
    state = tmp_path / "state"
    state.mkdir()
    dns._save_state(str(state), {"enabled": True, "local_resolvers": ["127.0.0.1:41100"]})
    monkeypatch.setattr(dns.firmware_resolvers, "discover", lambda *a, **kw: ["127.0.0.1:41101"])
    called = []
    monkeypatch.setattr(dns, "apply_action", lambda *a, **kw: called.append(kw) or {"ok": True})

    note = dns.recheck_local_resolvers(
        configs_dir=str(tmp_path), routing_file=str(tmp_path / "05_routing.json"),
        ui_state_dir=str(state), restart_xkeen=lambda *a, **kw: {"ok": True},
    )

    assert "127.0.0.1:41101" in note
    assert called and called[0]["local_resolver"] == ["127.0.0.1:41101"]


def test_resync_happens_at_most_once_an_hour(tmp_path: Path, monkeypatch):
    state = tmp_path / "state"
    state.mkdir()
    dns._save_state(
        str(state),
        {
            "enabled": True,
            "local_resolvers": ["127.0.0.1:41100"],
            "local_resolvers_synced_at": time.time(),
        },
    )
    monkeypatch.setattr(dns.firmware_resolvers, "discover", lambda *a, **kw: ["127.0.0.1:41101"])
    called = []
    monkeypatch.setattr(dns, "apply_action", lambda *a, **kw: called.append(kw))

    note = dns.recheck_local_resolvers(
        configs_dir=str(tmp_path), routing_file=str(tmp_path / "05_routing.json"),
        ui_state_dir=str(state), restart_xkeen=lambda *a, **kw: {"ok": True},
    )

    assert note == ""
    assert called == []


def test_untouched_setting_is_left_alone(tmp_path: Path, monkeypatch):
    # Пользователь локальные зоны не настраивал — навязывать их сторож не должен.
    state = tmp_path / "state"
    state.mkdir()
    dns._save_state(str(state), {"enabled": True, "local_resolvers": []})
    monkeypatch.setattr(dns.firmware_resolvers, "discover", lambda *a, **kw: ["127.0.0.1:41100"])
    called = []
    monkeypatch.setattr(dns, "apply_action", lambda *a, **kw: called.append(kw))

    assert dns.recheck_local_resolvers(
        configs_dir=str(tmp_path), routing_file=str(tmp_path / "05_routing.json"),
        ui_state_dir=str(state), restart_xkeen=lambda *a, **kw: {"ok": True},
    ) == ""
    assert called == []


def test_disabled_feature_is_not_touched(tmp_path: Path, monkeypatch):
    state = tmp_path / "state"
    state.mkdir()
    dns._save_state(str(state), {"enabled": False, "local_resolvers": ["127.0.0.1:41100"]})
    monkeypatch.setattr(dns.firmware_resolvers, "discover", lambda *a, **kw: ["127.0.0.1:41101"])
    called = []
    monkeypatch.setattr(dns, "apply_action", lambda *a, **kw: called.append(kw))

    assert dns.recheck_local_resolvers(
        configs_dir=str(tmp_path), routing_file=str(tmp_path / "05_routing.json"),
        ui_state_dir=str(state), restart_xkeen=lambda *a, **kw: {"ok": True},
    ) == ""
    assert called == []
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `python -m pytest tests/test_dns_over_vless_resolver_resync.py -q`
Expected: FAIL — `AttributeError: module 'services.dns_over_vless' has no attribute 'recheck_local_resolvers'`

- [ ] **Step 3: Реализовать**

Рядом с `PASS_SWITCH_INTERVAL` в `xkeen-ui/services/dns_over_vless.py`:

```python
# The firmware numbers its resolver ports by policy index, so deleting a policy
# can take our address away.  Repairing that means rewriting the fragment and
# restarting the core, which is far too heavy to do on every healthy tick.
LOCAL_RESOLVER_RESYNC_INTERVAL = 3600.0
```

Рядом с `reapply_client_capture`:

```python
def recheck_local_resolvers(
    *,
    configs_dir: str,
    routing_file: str,
    ui_state_dir: str,
    restart_xkeen: Callable[..., Any],
) -> str:
    """Put the local resolver back when the firmware has moved its port.

    Only for a feature that is on and whose local zones the user actually set
    up: an install that never wanted local resolution is left alone.  A set
    that still overlaps what the firmware offers is good enough -- the zones
    ride every resolver, so one live address answers them all.
    """
    state = _load_state(ui_state_dir)
    if not state.get("enabled"):
        return ""
    saved = [str(item) for item in (state.get("local_resolvers") or []) if str(item).strip()]
    if not saved:
        return ""
    found = firmware_resolvers.discover()
    if not found:
        # The firmware's configs are unreadable right now.  Rewriting the
        # setting on that basis would throw away a working address.
        return ""
    if set(saved) & set(found):
        return ""
    last = state.get("local_resolvers_synced_at")
    now = time.time()
    try:
        if last is not None and (now - float(last)) < LOCAL_RESOLVER_RESYNC_INTERVAL:
            return ""
    except (TypeError, ValueError):
        pass
    apply_action(
        "enable",
        configs_dir=configs_dir,
        routing_file=routing_file,
        ui_state_dir=ui_state_dir,
        restart_xkeen=restart_xkeen,
        local_resolver=found,
    )
    fresh = _load_state(ui_state_dir)
    fresh["local_resolvers_synced_at"] = now
    _save_state(ui_state_dir, fresh)
    return "локальный DNS переключён на " + ", ".join(found)
```

В `xkeen-ui/services/dns_guard.py`, в `_watch_xray_dns`, после `dns_over_vless.check_pass_non_ip(...)`:

```python
        # Порт резолвера прошивки привязан к индексу политики доступа и уезжает
        # вместе с ней. Молча: зона просто уходит в тоннель.
        dns_over_vless.recheck_local_resolvers(
            configs_dir=configs_dir,
            routing_file=routing_file,
            ui_state_dir=ui_state_dir,
            restart_xkeen=restart_xkeen,
        )
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `python -m pytest tests/test_dns_over_vless_resolver_resync.py tests/test_dns_over_vless.py -q`
Expected: PASS

- [ ] **Step 5: Коммит**

```bash
git add xkeen-ui/services/dns_over_vless.py xkeen-ui/services/dns_guard.py tests/test_dns_over_vless_resolver_resync.py
git -c user.name="olmer2002" -c user.email="olmer2002@gmail.com" commit -m "Панель сама чинит адрес локального DNS, если он уехал

Порт резолвера прошивки меняется вместе с политиками доступа. Теперь
сторожевая проверка это замечает и переписывает настройку, не чаще
раза в час."
```

---

### Task 5: Место в окне под подсказку

**Files:**
- Modify: `xkeen-ui/templates/panel.html` — блок поля `routing-dns-over-vless-local`
- Test: `tests/test_dns_over_vless_resolver_hint_markup.py`

**Interfaces:**
- Consumes: ничего.
- Produces: элементы `routing-dns-over-vless-local-hint` (строка с найденным) и `routing-dns-over-vless-local-apply` (кнопка «подставить»). Задача 6 адресует их через карту `DOM`.

- [ ] **Step 1: Написать падающий тест**

```python
# tests/test_dns_over_vless_resolver_hint_markup.py
"""Под полем локального DNS есть место для найденного адреса.

Порт резолвера прошивки пользователю знать неоткуда, поэтому панель его
показывает и предлагает подставить одной кнопкой.
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "xkeen-ui/templates/panel.html").read_text(encoding="utf-8")


def test_hint_and_button_exist():
    assert 'id="routing-dns-over-vless-local-hint"' in HTML
    assert 'id="routing-dns-over-vless-local-apply"' in HTML


def test_hint_sits_next_to_the_local_field():
    field = HTML.index('id="routing-dns-over-vless-local"')
    hint = HTML.index('id="routing-dns-over-vless-local-hint"')
    # Подсказка идёт сразу за полем, а не в другой зоне окна.
    assert 0 < hint - field < 600


def test_button_is_a_button_not_a_link():
    marker = HTML.index('id="routing-dns-over-vless-local-apply"')
    tag = HTML.rindex("<", 0, marker)
    assert HTML[tag:marker].startswith("<button")
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `python -m pytest tests/test_dns_over_vless_resolver_hint_markup.py -q`
Expected: FAIL — `ValueError: substring not found`

- [ ] **Step 3: Реализовать**

В `xkeen-ui/templates/panel.html` сразу после строки с `<input ... id="routing-dns-over-vless-local" ...>`:

```html
                <div id="routing-dns-over-vless-local-hint" class="routing-rule-hint hidden">
                  <span id="routing-dns-over-vless-local-hint-text"></span>
                  <button type="button" id="routing-dns-over-vless-local-apply" class="xk-mini-btn">Подставить</button>
                </div>
```

Замечание исполнителю: классы `routing-rule-hint` и `xk-mini-btn` взять те же, что у соседних подсказок и мелких кнопок в этом же окне (`grep -n "routing-rule-hint\|xk-mini-btn" xkeen-ui/templates/panel.html | head`), чтобы не заводить новых стилей. Если такого класса подсказки в окне нет — использовать класс, которым оформлена подсказка под полем `routing-dns-over-vless-upstreams`.

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `python -m pytest tests/test_dns_over_vless_resolver_hint_markup.py -q`
Expected: PASS, 3 tests

- [ ] **Step 5: Коммит**

```bash
git add xkeen-ui/templates/panel.html tests/test_dns_over_vless_resolver_hint_markup.py
git -c user.name="olmer2002" -c user.email="olmer2002@gmail.com" commit -m "В окне DNS-over-VLESS появилось место под найденный адрес"
```

---

### Task 6: Карточка показывает найденное и расхождение

**Files:**
- Modify: `xkeen-ui/static/js/features/routing_cards/rules/dns_over_vless.js` — карта `DOM`, функция `renderDnsFields`, обработчики в месте, где навешиваются остальные (`grep -n "addEventListener" ...`)
- Test: `tests/test_dns_over_vless_resolver_hint_js.py`

**Interfaces:**
- Consumes: ключ `firmware_resolvers` из статуса (Task 2); элементы разметки (Task 5).
- Produces: поведение карточки. Наружу ничего не отдаёт.

- [ ] **Step 1: Написать падающий тест**

```python
# tests/test_dns_over_vless_resolver_hint_js.py
"""Карточка объясняет, что нашла панель, и предупреждает о расхождении."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JS = (ROOT / "xkeen-ui/static/js/features/routing_cards/rules/dns_over_vless.js").read_text(
    encoding="utf-8"
)


def test_dom_map_knows_the_new_elements():
    assert "routing-dns-over-vless-local-hint" in JS
    assert "routing-dns-over-vless-local-apply" in JS


def test_hint_is_rendered_from_the_status_field():
    assert "firmware_resolvers" in JS


def test_button_fills_the_field():
    assert "function renderLocalHint(" in JS
    body = JS[JS.index("function renderLocalHint("):]
    body = body[: body.index("\n  function ", 10)]
    # Кнопка вписывает найденное в поле и помечает его тронутым, иначе
    # следующий ответ статуса затрёт подставленное значение.
    assert "dataset.touched" in body
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `python -m pytest tests/test_dns_over_vless_resolver_hint_js.py -q`
Expected: FAIL — `assert 'routing-dns-over-vless-local-hint' in JS`

- [ ] **Step 3: Реализовать**

В карту `DOM`, рядом с `local: 'routing-dns-over-vless-local',`:

```javascript
    localHint: 'routing-dns-over-vless-local-hint',
    localHintText: 'routing-dns-over-vless-local-hint-text',
    localApply: 'routing-dns-over-vless-local-apply',
```

Новая функция рядом с `renderDnsFields`:

```javascript
  // Порт резолвера прошивки пользователю знать неоткуда: он равен 41100 плюс
  // индекс политики доступа и уезжает вместе с ней. Показываем найденное и
  // предупреждаем, когда записанный адрес среди найденного не значится.
  function renderLocalHint(data) {
    const row = $(DOM.localHint);
    const text = $(DOM.localHintText);
    const apply = $(DOM.localApply);
    const field = $(DOM.local);
    if (!row || !text || !field) return;
    const found = (data && data.firmware_resolvers) || [];
    if (!found.length) {
      row.classList.add('hidden');
      return;
    }
    row.classList.remove('hidden');
    const current = parseZones(field.value || '');
    const missing = current.length && !current.some((item) => found.indexOf(item) >= 0);
    text.textContent = missing
      ? `Записанный адрес прошивка больше не слушает. Она отвечает на ${found.join(', ')}.`
      : `Прошивка отвечает на ${found.join(', ')}.`;
    row.classList.toggle('routing-rule-hint--warn', !!missing);
    if (apply) {
      apply.disabled = busy || fieldsLocked;
      apply.dataset.value = found.join(', ');
    }
  }
```

Вызов — в конце `renderDnsFields(data)`:

```javascript
    renderLocalHint(data);
```

Обработчик — там же, где навешиваются остальные:

```javascript
    const localApply = $(DOM.localApply);
    if (localApply) {
      localApply.addEventListener('click', () => {
        const field = $(DOM.local);
        if (!field) return;
        field.value = localApply.dataset.value || '';
        // Иначе следующий ответ статуса затрёт подставленное значение.
        field.dataset.touched = '1';
        field.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
```

Замечание исполнителю: имя функции разбора списка (`parseZones`) и флаги `busy` / `fieldsLocked` уже существуют в этом файле — проверь их по месту и не заводи вторых. Если у подсказок в окне нет модификатора `--warn`, оформи расхождение тем же способом, каким окно показывает другие предупреждения (`grep -n "tone: 'warn'" ...`).

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `python -m pytest tests/test_dns_over_vless_resolver_hint_js.py tests/test_dns_over_vless_fields_visible.py -q`
Expected: PASS

- [ ] **Step 5: Собрать фронтенд и закоммитить**

```bash
npm run frontend:build
git add xkeen-ui/static/js/features/routing_cards/rules/dns_over_vless.js xkeen-ui/static/frontend-build tests/test_dns_over_vless_resolver_hint_js.py
git -c user.name="olmer2002" -c user.email="olmer2002@gmail.com" commit -m "Окно подсказывает адрес резолвера прошивки

Под полем локального DNS видно, на каких портах прошивка отвечает
на домашние имена, и есть кнопка подставить. Если записанный адрес
прошивка больше не слушает, окно об этом предупреждает."
```

---

### Task 7: Проверка поведения в браузере

**Files:**
- Create: `e2e/dns_over_vless_local_hint.spec.mjs`
- Modify: `e2e/dns_over_vless_fixtures.mjs` — добавить `firmware_resolvers` в заготовку ответа статуса

**Interfaces:**
- Consumes: всё предыдущее.
- Produces: ничего для кода — только проверку.

- [ ] **Step 1: Написать падающий тест**

```javascript
// e2e/dns_over_vless_local_hint.spec.mjs
// Подсказка про резолвер прошивки: видно найденное, кнопка подставляет,
// расхождение видно глазами.
import { test, expect } from '@playwright/test';
import { openDnsOverVless } from './dns_over_vless_fixtures.mjs';

test('подсказка называет найденные резолверы прошивки', async ({ page }) => {
  await openDnsOverVless(page, { firmware_resolvers: ['127.0.0.1:41100', '127.0.0.1:41101'] });

  const hint = page.locator('#routing-dns-over-vless-local-hint');
  await expect(hint).toBeVisible();
  await expect(hint).toContainText('127.0.0.1:41100');
});

test('кнопка подставляет найденное в поле', async ({ page }) => {
  await openDnsOverVless(page, { firmware_resolvers: ['127.0.0.1:41100'] });

  await page.click('#routing-dns-over-vless-local-apply');

  await expect(page.locator('#routing-dns-over-vless-local')).toHaveValue('127.0.0.1:41100');
});

test('расхождение с записанным адресом видно', async ({ page }) => {
  await openDnsOverVless(page, {
    local_resolvers: ['127.0.0.1:41100'],
    firmware_resolvers: ['127.0.0.1:41101'],
  });

  await expect(page.locator('#routing-dns-over-vless-local-hint')).toContainText(
    'больше не слушает',
  );
});

test('без прошивки подсказки нет', async ({ page }) => {
  await openDnsOverVless(page, { firmware_resolvers: [] });

  await expect(page.locator('#routing-dns-over-vless-local-hint')).toBeHidden();
});
```

Замечание исполнителю: `openDnsOverVless` — имя условное. Открой `e2e/dns_over_vless_fixtures.mjs` и используй тот помощник, который там есть, передав ему переопределения статуса тем же способом, каким это делает `e2e/dns_over_vless_zones.spec.mjs`.

- [ ] **Step 2: Собрать фронтенд и убедиться, что тест падает**

```bash
npm run frontend:build
npx playwright test e2e/dns_over_vless_local_hint.spec.mjs
```

Expected: FAIL — элемент подсказки не найден либо пуст.

Замечание: если прогон висит или проверяет старую разметку — на порту 18188 остался сервер от прерванного запуска, его надо снять перед повтором.

- [ ] **Step 3: Починить то, что вскрылось**

Правки только в коде из задач 5 и 6 — новых сущностей здесь не появляется. Если фикстура статуса не содержит `firmware_resolvers`, добавить ключ в заготовку `e2e/dns_over_vless_fixtures.mjs` со значением `[]`, чтобы остальные спеки не начали видеть подсказку.

- [ ] **Step 4: Прогнать всё**

```bash
python -m pytest tests -q
npx playwright test e2e/dns_over_vless_local_hint.spec.mjs e2e/dns_over_vless_zones.spec.mjs
```

Expected: python зелёный; оба e2e-файла зелёные.

- [ ] **Step 5: Собрать архив и закоммитить**

```bash
npm run archive:user:skip-build
git add e2e/dns_over_vless_local_hint.spec.mjs e2e/dns_over_vless_fixtures.mjs xkeen-ui-routing.tar.gz xkeen-ui-routing.tar.gz.sha256
git -c user.name="olmer2002" -c user.email="olmer2002@gmail.com" commit -m "Проверка подсказки про резолвер прошивки в браузере"
```

---

## Проверка на живом роутере

После задач 1-4 (серверная часть готова, окно ещё старое) стоит убедиться на
`192.168.10.1`, что нашлось ровно то, что ожидается:

```bash
grep -H dns_udp_port /var/ndnproxy_*.conf
```

Ожидается три строки: 41100, 41101, 41102. После включения функции через панель —
в `/opt/etc/xray/configs/05_routing.json` должно появиться правило с
`"ruleTag": "xk_dns_over_vless_local"`, а в `02_dns_over_vless.json` — сервер
`127.0.0.1:41100` со списком локальных зон и `"skipFallback": true`.

Контрольная проба (с любой машины в сети): имя KeenDNS роутера должно вернуть
`198.51.100.11`, а не публичные адреса облака.
