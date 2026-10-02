"""Пауза подписок Xray: вернуться на свои ключи, не удаляя подписки."""

from __future__ import annotations

import json
from pathlib import Path

import pytest


def _vless_ws(name: str, host: str = "ws.example.com") -> str:
    safe_name = str(name or "").replace(" ", "%20")
    return (
        f"vless://user@{host}:443"
        "?type=ws&security=tls&sni=edge.example.com&encryption=none&host=cdn.example.com&path=%2Fws"
        f"#{safe_name}"
    )


OWN_OUTBOUNDS = {
    "outbounds": [
        {
            "tag": "vless-reality",
            "protocol": "vless",
            "settings": {
                "vnext": [
                    {
                        "address": "edge.example.com",
                        "port": 443,
                        "users": [{"id": "user", "encryption": "none"}],
                    }
                ]
            },
        },
        {"tag": "direct", "protocol": "freedom"},
        {"tag": "block", "protocol": "blackhole"},
    ]
}
OWN_ROUTING = {
    "routing": {
        "domainStrategy": "AsIs",
        "rules": [{"type": "field", "inboundTag": ["redirect", "tproxy"], "outboundTag": "vless-reality"}],
    }
}
OWN_OBSERVATORY = {
    "observatory": {
        "subjectSelector": ["vless-reality"],
        "probeUrl": "https://probe.example.com",
        "probeInterval": "120s",
    }
}


def _dump(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2) + "\n"


def _meaning(files: dict[str, str]) -> dict:
    """Конфиги без различий, которых Xray не видит: порядок в selector."""

    def _walk(node):
        if isinstance(node, dict):
            return {
                key: sorted(value) if key in {"selector", "subjectSelector"} else _walk(value)
                for key, value in node.items()
            }
        if isinstance(node, list):
            return [_walk(item) for item in node]
        return node

    return {name: _walk(json.loads(text)) for name, text in files.items()}


class Bench:
    """Каталоги панели с одним своим ключом и подписками поверх него."""

    def __init__(self, tmp_path: Path, monkeypatch, own_outbounds: dict | None = None):
        from services import xray_subscriptions as subs

        self.subs = subs
        self.state = tmp_path / "state"
        self.xray = tmp_path / "xray" / "configs"
        self.jsonc = tmp_path / "jsonc"
        self.state.mkdir()
        self.xray.mkdir(parents=True)
        self.jsonc.mkdir()
        self.fetched: list[str] = []

        def _fetch(url):
            self.fetched.append(url)
            return _vless_ws("Germany") + "\n" + _vless_ws("Poland", host="pl.example.com"), {}

        monkeypatch.setattr(subs, "jsonc_path_for", lambda path: str(self.jsonc / (Path(path).name + "c")))
        monkeypatch.setattr(subs, "ensure_xray_jsonc_dir", lambda: None)
        monkeypatch.setattr(subs, "fetch_subscription_body", _fetch)

        (self.xray / "04_outbounds.json").write_text(_dump(own_outbounds or OWN_OUTBOUNDS), encoding="utf-8")
        (self.xray / "05_routing.json").write_text(_dump(OWN_ROUTING), encoding="utf-8")
        (self.xray / "07_observatory.json").write_text(_dump(OWN_OBSERVATORY), encoding="utf-8")

    def add(self, sub_id: str, **extra) -> None:
        payload = {
            "id": sub_id,
            "tag": sub_id,
            "url": f"https://example.com/{sub_id}",
            "enabled": True,
            "ping_enabled": True,
        }
        payload.update(extra)
        self.subs.upsert_subscription(str(self.state), payload)
        result = self.subs.refresh_subscription(
            str(self.state),
            sub_id,
            xray_configs_dir=str(self.xray),
            snapshot=lambda _path: None,
            restart_xkeen=None,
            restart=False,
        )
        assert result["ok"], result

    def pause(self):
        return self.subs.pause_subscriptions(
            str(self.state), xray_configs_dir=str(self.xray), snapshot=lambda _path: None
        )

    def resume(self):
        return self.subs.resume_subscriptions(
            str(self.state), xray_configs_dir=str(self.xray), snapshot=lambda _path: None
        )

    def config_files(self) -> dict[str, str]:
        return {
            item.name: item.read_text(encoding="utf-8")
            for item in sorted(self.xray.iterdir())
            if item.is_file()
        }

    def sub(self, sub_id: str) -> dict:
        state = self.subs.load_subscription_state(str(self.state))
        return next(item for item in state["subscriptions"] if item["id"] == sub_id)


@pytest.fixture
def bench(tmp_path: Path, monkeypatch) -> Bench:
    return Bench(tmp_path, monkeypatch)


def test_pause_returns_configs_to_own_keys_and_keeps_subscription_records(bench: Bench):
    own = bench.config_files()
    bench.add("alpha")
    bench.add("beta")
    assert (bench.xray / "04_outbounds.alpha.json").exists()

    result = bench.pause()

    assert sorted(result["paused"]) == ["alpha", "beta"]
    assert result["changed"] is True
    after = bench.config_files()
    # Xray читает только *.json: всё, что он видит, снова как до подписок.
    assert {name: text for name, text in after.items() if name.endswith(".json")} == own
    assert sorted(name for name in after if not name.endswith(".json")) == [
        "04_outbounds.alpha.json.paused",
        "04_outbounds.beta.json.paused",
    ]
    alpha = bench.sub("alpha")
    assert alpha["paused"] is True
    assert alpha["url"] == "https://example.com/alpha"
    assert alpha["last_count"] == 2
    assert bench.subs.subscriptions_paused(str(bench.state)) is True


def test_resume_brings_back_the_same_configs_without_downloading(bench: Bench):
    bench.add("alpha")
    bench.add("beta")
    active = bench.config_files()
    bench.pause()
    bench.fetched.clear()

    result = bench.resume()

    assert sorted(result["resumed"]) == ["alpha", "beta"]
    assert result["changed"] is True
    assert bench.fetched == []
    assert _meaning(bench.config_files()) == _meaning(active)
    assert bench.sub("alpha")["paused"] is False
    assert bench.subs.subscriptions_paused(str(bench.state)) is False


def test_pause_and_resume_are_no_ops_when_there_is_nothing_to_do(bench: Bench):
    bench.add("alpha")
    assert bench.resume() == {"resumed": [], "changed": False}
    bench.pause()
    paused_files = bench.config_files()

    again = bench.pause()

    assert again == {"paused": [], "changed": False}
    assert bench.config_files() == paused_files


def test_scheduler_does_not_refresh_paused_subscriptions(bench: Bench, monkeypatch):
    bench.add("alpha")
    bench.pause()
    bench.fetched.clear()
    monkeypatch.setattr(bench.subs, "_now", lambda: 10**12)

    results = bench.subs.refresh_due_subscriptions(
        str(bench.state), xray_configs_dir=str(bench.xray), snapshot=lambda _path: None, restart=False
    )

    assert results == []
    assert bench.fetched == []


def test_manual_refresh_of_paused_subscription_is_refused_and_leaves_no_fragment(bench: Bench):
    bench.add("alpha")
    bench.pause()
    bench.fetched.clear()

    result = bench.subs.refresh_subscription(
        str(bench.state),
        "alpha",
        xray_configs_dir=str(bench.xray),
        snapshot=lambda _path: None,
        restart_xkeen=None,
        restart=False,
    )

    assert result["ok"] is False
    assert result["code"] == "subscriptions_paused"
    assert "приостановлен" in result["error"]
    assert bench.fetched == []
    assert not (bench.xray / "04_outbounds.alpha.json").exists()
    # Отказ — не сбой скачивания: состояние подписки не портится.
    assert bench.sub("alpha")["last_ok"] is True


def test_delete_of_paused_subscription_removes_its_set_aside_fragment(bench: Bench):
    bench.add("alpha")
    bench.add("beta")
    bench.pause()

    bench.subs.delete_subscription(
        str(bench.state), "alpha", xray_configs_dir=str(bench.xray), snapshot=lambda _path: None
    )

    names = sorted(bench.config_files())
    assert "04_outbounds.alpha.json.paused" not in names
    assert "04_outbounds.beta.json.paused" in names
    assert bench.subs.subscriptions_paused(str(bench.state)) is True


def test_subscription_added_during_pause_joins_the_pause(bench: Bench):
    bench.add("alpha")
    bench.pause()

    bench.subs.upsert_subscription(
        str(bench.state), {"id": "gamma", "tag": "gamma", "url": "https://example.com/gamma"}
    )

    assert bench.sub("gamma")["paused"] is True


def test_pause_gives_back_own_servers_taken_away_by_subscription_only_mode(bench: Bench):
    own = bench.config_files()
    bench.add("alpha", routing_mode="subscription-only")
    active = bench.config_files()
    assert "vless-reality" not in active["04_outbounds.json"]

    bench.pause()

    after = bench.config_files()
    assert {name: text for name, text in after.items() if name.endswith(".json")} == own

    bench.resume()

    assert _meaning(bench.config_files()) == _meaning(active)
