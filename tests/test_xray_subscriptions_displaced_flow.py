"""«Только подписка» возвращает вытесненное по журналу и не трогает правки владельца."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tests.test_xray_subscriptions_pause import Bench


@pytest.fixture
def bench(tmp_path: Path, monkeypatch) -> Bench:
    return Bench(tmp_path, monkeypatch)


def _read(bench: Bench, name: str) -> dict:
    return json.loads((bench.xray / name).read_text(encoding="utf-8"))


def _write(bench: Bench, name: str, obj: dict) -> None:
    (bench.xray / name).write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _state(bench: Bench) -> dict:
    return bench.subs.load_subscription_state(str(bench.state))


def _refresh(bench: Bench, sub_id: str) -> dict:
    result = bench.subs.refresh_subscription(
        str(bench.state),
        sub_id,
        xray_configs_dir=str(bench.xray),
        snapshot=lambda _path: None,
        restart_xkeen=None,
        restart=False,
    )
    assert result["ok"], result
    return result


def _delete(bench: Bench, sub_id: str) -> dict:
    return bench.subs.delete_subscription(
        str(bench.state),
        sub_id,
        xray_configs_dir=str(bench.xray),
        snapshot=lambda _path: None,
        restart_xkeen=None,
    )


def _outbound_tags(bench: Bench) -> list:
    return [item.get("tag") for item in _read(bench, "04_outbounds.json")["outbounds"]]


def test_the_mode_keeps_no_file_copies_only_a_journal(bench: Bench):
    bench.add("alpha", routing_mode="subscription-only")

    state = _state(bench)
    assert bench.subs.MANAGED_BASELINES_KEY not in state
    assert not (bench.xray / "04_outbounds.json.disable").exists()
    displaced = state[bench.subs.DISPLACED_KEY]
    assert [entry["outbound"]["tag"] for entry in displaced["outbounds"]] == ["vless-reality"]
    assert displaced["taken_rules"][0]["rule"]["outboundTag"] == "vless-reality"


def test_what_the_owner_edited_during_the_mode_is_still_there_after_it(bench: Bench):
    own = bench.config_files()
    bench.add("alpha", routing_mode="subscription-only")

    # Владелец правит свои файлы, пока режим работает.
    routing = _read(bench, "05_routing.json")
    routing["routing"]["domainStrategy"] = "IPIfNonMatch"
    routing["routing"]["rules"].insert(
        0, {"type": "field", "ruleTag": "mine", "domain": ["geosite:private"], "outboundTag": "direct"}
    )
    _write(bench, "05_routing.json", routing)
    outbounds = _read(bench, "04_outbounds.json")
    outbounds["outbounds"].append({"tag": "warp", "protocol": "wireguard", "settings": {}})
    _write(bench, "04_outbounds.json", outbounds)

    result = _delete(bench, "alpha")

    assert result["skipped"] == []
    routing = _read(bench, "05_routing.json")["routing"]
    assert routing["domainStrategy"] == "IPIfNonMatch"
    assert routing["rules"][0]["ruleTag"] == "mine"
    # Своё правило «всё через свой сервер» вернулось, служебного больше нет.
    own_rules = json.loads(own["05_routing.json"])["routing"]["rules"]
    assert routing["rules"][1:] == own_rules
    assert "balancers" not in routing
    assert "vless-reality" in _outbound_tags(bench)
    assert "warp" in _outbound_tags(bench)
    assert bench.subs.DISPLACED_KEY not in _state(bench)


def test_an_owner_rule_added_during_the_mode_goes_to_the_pool_and_comes_back(bench: Bench):
    bench.add("alpha", routing_mode="subscription-only")
    routing = _read(bench, "05_routing.json")
    routing["routing"]["rules"].insert(
        0, {"type": "field", "domain": ["geosite:youtube"], "outboundTag": "vless-reality"}
    )
    _write(bench, "05_routing.json", routing)

    _refresh(bench, "alpha")

    rule = _read(bench, "05_routing.json")["routing"]["rules"][0]
    assert rule["balancerTag"] == "proxy" and "outboundTag" not in rule
    # Правило на свой сервер подхватывает прежний механизм со своей меткой;
    # главное -- метка служебная и при выходе снимается.
    assert rule["ruleTag"].startswith("xk_auto_")

    _delete(bench, "alpha")

    rule = _read(bench, "05_routing.json")["routing"]["rules"][0]
    assert rule == {"type": "field", "domain": ["geosite:youtube"], "outboundTag": "vless-reality"}


def test_a_server_the_owner_put_back_himself_is_not_overwritten(bench: Bench):
    bench.add("alpha", routing_mode="subscription-only")
    outbounds = _read(bench, "04_outbounds.json")
    outbounds["outbounds"].insert(0, {"tag": "vless-reality", "protocol": "vless", "settings": {"mine": True}})
    _write(bench, "04_outbounds.json", outbounds)

    result = _delete(bench, "alpha")

    assert {"kind": "outbound", "name": "vless-reality", "reason": "exists"} in result["skipped"]
    assert "сервер «vless-reality»" in result["warning"]
    servers = [item for item in _read(bench, "04_outbounds.json")["outbounds"] if item.get("tag") == "vless-reality"]
    assert servers == [{"tag": "vless-reality", "protocol": "vless", "settings": {"mine": True}}]


def test_leaving_the_mode_with_subscriptions_still_active_gives_the_owner_his_setup_back(bench: Bench):
    own = bench.config_files()
    bench.add("alpha", routing_mode="subscription-only")

    bench.subs.upsert_subscription(str(bench.state), {"id": "alpha", "url": "https://example.com/alpha", "routing_mode": "safe-fallback"})
    _refresh(bench, "alpha")

    assert "vless-reality" in _outbound_tags(bench)
    routing = _read(bench, "05_routing.json")["routing"]
    own_rules = json.loads(own["05_routing.json"])["routing"]["rules"]
    assert all(rule in routing["rules"] for rule in own_rules)
    pool = next(item for item in routing["balancers"] if item["tag"] == "proxy")
    assert "vless-reality" in pool["selector"] and "alpha" in pool["selector"]
    service = next(rule for rule in routing["rules"] if rule.get("ruleTag") == "xk_auto_leastPing")
    assert service["inboundTag"] == ["redirect", "tproxy"]
    assert bench.subs.DISPLACED_KEY not in _state(bench)


def test_pause_and_resume_go_through_the_journal(bench: Bench):
    own = bench.config_files()
    bench.add("alpha", routing_mode="subscription-only")
    active = bench.config_files()

    bench.pause()

    assert {name: text for name, text in bench.config_files().items() if name.endswith(".json")} == own
    assert bench.subs.DISPLACED_KEY not in _state(bench)

    bench.resume()

    assert {k: json.loads(v) for k, v in bench.config_files().items() if k.endswith(".json")} == {
        k: json.loads(v) for k, v in active.items() if k.endswith(".json")
    }
    assert _state(bench)[bench.subs.DISPLACED_KEY]["outbounds"]


def _make_legacy(bench: Bench, own: dict) -> None:
    """Состояние роутера, вошедшего в режим на версии с копиями файлов."""
    path = Path(bench.subs.subscription_state_path(str(bench.state)))
    raw = json.loads(path.read_text(encoding="utf-8"))
    raw.pop(bench.subs.DISPLACED_KEY, None)
    raw[bench.subs.MANAGED_BASELINES_KEY] = {
        "routing": {"path": "05_routing.json", "exists": True, "text": own["05_routing.json"], "jsonc_exists": False},
        "observatory": {"path": "07_observatory.json", "exists": True, "text": own["07_observatory.json"], "jsonc_exists": False},
        "outbounds": {"path": "04_outbounds.json", "exists": True, "text": own["04_outbounds.json"], "jsonc_exists": False},
    }
    path.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
    (bench.xray / "04_outbounds.json.disable").write_text(own["04_outbounds.json"], encoding="utf-8")


def test_a_router_that_entered_the_mode_on_an_old_version_leaves_it_the_old_way(bench: Bench):
    own = bench.config_files()
    bench.add("alpha", routing_mode="subscription-only")
    _make_legacy(bench, own)

    result = _delete(bench, "alpha")

    assert result["baseline_restored"] is True
    after = bench.config_files()
    assert {name: after[name] for name in ("04_outbounds.json", "05_routing.json", "07_observatory.json")} == {
        name: own[name] for name in ("04_outbounds.json", "05_routing.json", "07_observatory.json")
    }
    assert not (bench.xray / "04_outbounds.json.disable").exists()
    state = _state(bench)
    assert bench.subs.MANAGED_BASELINES_KEY not in state
    assert bench.subs.DISPLACED_KEY not in state


def test_old_copies_are_dropped_on_a_router_that_is_not_in_the_mode(bench: Bench):
    own = bench.config_files()
    bench.add("alpha")
    _make_legacy(bench, own)

    _refresh(bench, "alpha")

    assert bench.subs.MANAGED_BASELINES_KEY not in _state(bench)
    assert not (bench.xray / "04_outbounds.json.disable").exists()
    assert "vless-reality" in _outbound_tags(bench)


# --- комментарии владельца в JSONC ---------------------------------------------


def _comment_above(text: str, needle: str, comment: str) -> str:
    """Вписать комментарий над объектом, в котором встречается ``needle``."""
    lines = text.splitlines()
    index = next(i for i, line in enumerate(lines) if needle in line)
    while lines[index].strip() != "{":
        index -= 1
    indent = lines[index][: len(lines[index]) - len(lines[index].lstrip())]
    lines.insert(index, indent + comment)
    return "\n".join(lines) + "\n"


def _line_above_object(text: str, needle: str) -> str:
    lines = text.splitlines()
    index = next(i for i, line in enumerate(lines) if needle in line)
    while lines[index].strip() != "{":
        index -= 1
    return lines[index - 1].strip()


def _sidecar(bench: Bench, name: str) -> str:
    return (bench.jsonc / (name + "c")).read_text(encoding="utf-8")


def test_a_comment_above_an_own_server_leaves_and_returns_with_it(bench: Bench):
    outbounds = _read(bench, "04_outbounds.json")
    outbounds["outbounds"] = [outbounds["outbounds"][0], {"tag": "direct", "protocol": "freedom"}]
    _write(bench, "04_outbounds.json", outbounds)
    text = json.dumps(outbounds, ensure_ascii=False, indent=2) + "\n"
    text = _comment_above(text, '"tag": "vless-reality"', "// основной сервер, оплачен до марта")
    text = _comment_above(text, '"tag": "direct"', "// прямой выход")
    (bench.jsonc / "04_outbounds.jsonc").write_text(text, encoding="utf-8")

    bench.add("alpha", routing_mode="subscription-only")

    during = _sidecar(bench, "04_outbounds.json")
    assert "vless-reality" not in during
    # Подпись убранного сервера не переезжает ни на соседа, ни в начало файла.
    assert "основной сервер" not in during
    assert "Preserved comments" not in during
    assert _line_above_object(during, '"tag": "direct"') == "// прямой выход"

    _delete(bench, "alpha")

    after = _sidecar(bench, "04_outbounds.json")
    assert _line_above_object(after, '"tag": "vless-reality"') == "// основной сервер, оплачен до марта"
    assert _line_above_object(after, '"tag": "direct"') == "// прямой выход"
    assert "Preserved comments" not in after
    assert bench.subs.DISPLACED_KEY not in _state(bench)


def test_comments_in_routing_stay_with_their_rules_and_balancers(bench: Bench):
    routing = {
        "routing": {
            "domainStrategy": "AsIs",
            "rules": [
                {"type": "field", "domain": ["geosite:youtube"], "outboundTag": "vless-reality"},
                {"type": "field", "inboundTag": ["redirect", "tproxy"], "outboundTag": "vless-reality"},
            ],
            "balancers": [
                {"tag": "spare", "selector": ["vless-"], "strategy": {"type": "leastPing"}, "fallbackTag": "direct"}
            ],
        }
    }
    _write(bench, "05_routing.json", routing)
    text = json.dumps(routing, ensure_ascii=False, indent=2) + "\n"
    text = _comment_above(text, '"geosite:youtube"', "// ютуб через свой сервер")
    text = _comment_above(text, '"tag": "spare"', "// запасной пул")
    lines = text.splitlines()
    catch_all = max(i for i, line in enumerate(lines) if line.strip() == '"type": "field",') - 1
    lines.insert(catch_all, lines[catch_all][: len(lines[catch_all]) - 1] + "// всё остальное")
    (bench.jsonc / "05_routing.jsonc").write_text("\n".join(lines) + "\n", encoding="utf-8")

    bench.add("alpha", routing_mode="subscription-only")

    during = _sidecar(bench, "05_routing.json")
    assert '"tag": "spare"' not in during
    assert "Preserved comments" not in during
    assert "запасной пул" not in during
    # Правило осталось в файле -- подпись осталась при нём.
    assert _line_above_object(during, '"geosite:youtube"') == "// ютуб через свой сервер"

    _delete(bench, "alpha")

    after = _sidecar(bench, "05_routing.json")
    assert json.loads(bench.subs._strip_jsonc_comments(after)) == routing
    assert _line_above_object(after, '"geosite:youtube"') == "// ютуб через свой сервер"
    assert _line_above_object(after, '"tag": "spare"') == "// запасной пул"
    assert _line_above_object(after, '"redirect"') != ""
    assert "// всё остальное" in after
    assert "Preserved comments" not in after
