from __future__ import annotations

import copy
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml

from services import mihomo_subscriptions as svc
from services import mihomo_subscription_providers as providers
from services.mihomo_clash_client import MihomoClashClientError


def body(name):
    return json.dumps([{"remarks": name, "outbounds": [{"protocol": "vless", "tag": "proxy",
        "settings": {"vnext": [{"address": "edge.example", "port": 443,
            "users": [{"id": "11111111-1111-1111-1111-111111111111", "encryption": "none"}]}]},
        "streamSettings": {"network": "tcp", "security": "tls", "tlsSettings": {"serverName": "edge.example"}}}]}])


@pytest.fixture
def stand(tmp_path, monkeypatch):
    from services import mihomo_clash_client, mihomo_clash_target

    feeds = {"/one": [body("One"), '"one-v1"'], "/two": [body("Two"), '"two-v1"']}
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            text, etag = feeds[self.path]
            requests.append((self.path, dict(self.headers)))
            unchanged = self.headers.get("If-None-Match") == etag if etag else self.headers.get("If-Modified-Since") == "Wed, 25 Nov 2026 10:00:00 GMT"
            self.send_response(304 if unchanged else 200)
            if etag:
                self.send_header("ETag", etag)
            self.send_header("Last-Modified", "Wed, 25 Nov 2026 10:00:00 GMT")
            self.send_header("Content-Length", "0" if unchanged else str(len(text.encode())))
            self.end_headers()
            if not unchanged:
                self.wfile.write(text.encode())

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv("XKEEN_SUBSCRIPTION_ALLOW_PRIVATE_HOSTS", "1")
    monkeypatch.setenv("XKEEN_SUBSCRIPTION_ALLOW_HTTP", "1")
    monkeypatch.setenv("XKEEN_SUBSCRIPTION_HAPP_FALLBACK", "0")
    config = tmp_path / "config.yaml"
    original = "# keep header\nproxies:\n  - name: Old One\n    type: direct\n  - name: Old Two\n    type: direct\nproxy-groups:\n  - name: Main\n    type: select\n    proxies: [DIRECT, Old One, Old Two]\nrules: [MATCH,Main]\n"
    config.write_text(original, encoding="utf-8")
    ids = []
    for suffix in ("One", "Two"):
        entry = svc.sync_imported_xray_subscription(str(tmp_path),
            url=f"http://127.0.0.1:{server.server_port}/{suffix.lower()}", config_text=original,
            proxy_yamls=[f"- name: Old {suffix}\n  type: direct"], groups=["Main"])
        ids.append(entry["id"])
    saved, snapshots = [], []

    def save(text):
        snapshots.append(providers.freeze_for_backup(config.read_text(encoding="utf-8"), tmp_path))
        saved.append(text)
        config.write_text(text, encoding="utf-8")

    class Client:
        def __init__(self):
            self.reloads = []
            self.updates = []
            self.runtime = {}
            self.reject = False

        def request_json(self, operation):
            return SimpleNamespace(payload={"providers": self.runtime})

        def reload_config(self, text):
            self.reloads.append(text)
            parsed = yaml.safe_load(text)
            for name, spec in (parsed.get("proxy-providers") or {}).items():
                self.runtime[name] = yaml.safe_load((tmp_path / spec["path"]).read_text())

        def reload_config_file(self, path):
            return self.reload_config(Path(path).read_text(encoding="utf-8"))

        def update_provider(self, kind, name):
            self.updates.append(name)
            spec = yaml.safe_load(config.read_text())["proxy-providers"][name]
            value = yaml.safe_load((tmp_path / spec["path"]).read_text())
            if self.reject and any(p["name"] == "Invalid" for p in value["proxies"]):
                raise MihomoClashClientError("upstream_http_error", "rejected", upstream_status=503)
            self.runtime[name] = value

    client = Client()
    monkeypatch.setattr(mihomo_clash_client, "MihomoClashClient", lambda target: client)
    monkeypatch.setattr(mihomo_clash_target, "discover_mihomo_clash_target", lambda *args: SimpleNamespace(target=object()))
    args = dict(mihomo_config_file=str(config), save_callback=save,
                restart_xkeen=lambda **kwargs: pytest.fail("must not restart"))
    value = SimpleNamespace(root=tmp_path, config=config, ids=ids, feeds=feeds, requests=requests,
                            client=client, saved=saved, snapshots=snapshots, args=args)
    yield value
    server.shutdown()
    server.server_close()
    thread.join()


def due(stand):
    state = svc.load_subscription_state(str(stand.root))
    for sub in state["subscriptions"]:
        sub["next_update_ts"] = 1
    svc._write_state(str(stand.root), state)


def test_migration_provider_update_and_304(stand):
    due(stand)
    first = svc.refresh_due_subscriptions(str(stand.root), **stand.args)
    assert all(r["ok"] and r["hot_applied"] for r in first)
    assert len(stand.saved) == 1 and len(stand.client.reloads) == 1
    # Tail-first migration keeps the original order of the subscription nodes.
    state = svc.load_subscription_state(str(stand.root))
    assert state["subscriptions"][1]["provider_name"] in stand.client.runtime
    due(stand)
    second = svc.refresh_due_subscriptions(str(stand.root), **stand.args)
    assert all(r["ok"] and r["not_modified"] for r in second)
    assert all(sub.get("provider_name") for sub in svc.list_subscriptions(str(stand.root)))
    assert "# keep header" in stand.config.read_text()
    assert all(any(key.lower() == "if-none-match" for key in headers) for _, headers in stand.requests[-2:])
    stand.saved.clear()
    stand.client.reloads.clear()
    stand.client.updates.clear()
    before = stand.config.read_bytes()
    stand.feeds["/one"] = [body("New One"), '"one-v2"']
    result = svc.refresh_subscription(str(stand.root), stand.ids[0], **stand.args)
    assert result["ok"] and result["apply_method"] == "mihomo-provider"
    assert stand.config.read_bytes() == before and len(stand.saved) == 1
    assert len(stand.client.updates) == 1 and not stand.client.reloads
    frozen = yaml.safe_load(stand.snapshots[-1])["proxy-providers"]
    assert all(spec["type"] == "inline" for spec in frozen.values())
    assert any(spec["payload"][0]["name"] == "One" for spec in frozen.values())
    stand.saved.clear()
    result = svc.refresh_subscription(str(stand.root), stand.ids[0], **stand.args)
    assert result["not_modified"] and not result["changed"]
    assert not stand.saved and len(stand.client.updates) == 1


def test_provider_rejection_restores_file_and_runtime(stand):
    due(stand)
    svc.refresh_due_subscriptions(str(stand.root), **stand.args)
    before = copy.deepcopy(stand.client.runtime)
    stand.client.reject = True
    stand.feeds["/two"] = [body("Invalid"), '"invalid"']
    result = svc.refresh_subscription(str(stand.root), stand.ids[1], **stand.args)
    assert not result["ok"] and not result.get("recovery_failed")
    assert stand.client.runtime == before
    assert svc.list_subscriptions(str(stand.root))[1]["last_error_retry_seconds"] == 300
    name, path = providers.provider_identity(str(stand.config), stand.ids[1])
    assert yaml.safe_load(path.read_text()) == before[name]


def test_saved_provider_update_is_applied_after_304(stand):
    due(stand)
    svc.refresh_due_subscriptions(str(stand.root), **stand.args)
    stand.feeds["/two"] = [body("Saved"), '"saved"']
    result = svc.refresh_subscription(str(stand.root), stand.ids[1], **{**stand.args, "restart": False})
    assert result["ok"] and not result["hot_applied"]
    assert svc.list_subscriptions(str(stand.root))[1]["pending_apply"]
    result = svc.refresh_subscription(str(stand.root), stand.ids[1], **stand.args)
    assert result["not_modified"] and result["hot_applied"]
    assert "pending_apply" not in svc.list_subscriptions(str(stand.root))[1]


def test_manual_edit_during_fetch_is_preserved(stand, monkeypatch):
    original_fetch = svc._fetch_xray_subscription_body

    def fetch(*args, **kwargs):
        result = original_fetch(*args, **kwargs)
        stand.config.write_text(stand.config.read_text() + "# concurrent edit\n")
        return result

    monkeypatch.setattr(svc, "_fetch_xray_subscription_body", fetch)
    result = svc.refresh_subscription(str(stand.root), stand.ids[1], **stand.args)
    assert not result["ok"] and result["error"] == "active_config_changed"
    assert "# concurrent edit" in stand.config.read_text()
    assert not stand.client.reloads and not stand.saved


def test_retry_delay_increases_and_success_resets_it(stand, monkeypatch):
    original_fetch = svc._fetch_xray_subscription_body
    monkeypatch.setattr(svc, "_fetch_xray_subscription_body", lambda *a, **kw: (_ for _ in ()).throw(TimeoutError("timeout")))
    for delay in (300, 900, 3600, 3600):
        result = svc.refresh_subscription(str(stand.root), stand.ids[0], **stand.args)
        assert not result["ok"]
        assert svc.list_subscriptions(str(stand.root))[0]["last_error_retry_seconds"] == delay
    monkeypatch.setattr(svc, "_fetch_xray_subscription_body", original_fetch)
    assert svc.refresh_subscription(str(stand.root), stand.ids[0], **stand.args)["ok"]
    assert svc.list_subscriptions(str(stand.root))[0]["failure_count"] == 0


def test_prizrak_yaml_supports_conditional_fetch_and_backup_restore(stand, monkeypatch):
    from services import mihomo_hwid_sub

    monkeypatch.setenv("XKEEN_MIHOMO_HWID_ALLOW_HTTP", "1")
    monkeypatch.setenv("XKEEN_MIHOMO_HWID_ALLOW_PRIVATE_HOSTS", "1")
    monkeypatch.setattr(mihomo_hwid_sub, "get_device_info", lambda: {"headers": {"User-Agent": "Happ/test"}})
    state = svc.load_subscription_state(str(stand.root))
    state["subscriptions"][1]["refresh_parser"] = "mihomo-provider"
    svc._write_state(str(stand.root), state)
    stand.feeds["/two"] = ["proxies:\n  - name: YAML\n    type: vless\n    server: edge.example\n    port: 443\n    uuid: 11111111-1111-1111-1111-111111111111\n    udp-443: reject\n", '"yaml-v1"']
    result = svc.refresh_subscription(str(stand.root), stand.ids[1], **stand.args)
    assert result["ok"] and result["hot_applied"]
    result = svc.refresh_subscription(str(stand.root), stand.ids[1], **stand.args)
    assert result["ok"] and result["not_modified"] and not result["changed"]
    name, path = providers.provider_identity(str(stand.config), stand.ids[1])
    assert yaml.safe_load(path.read_text())["proxies"][0]["udp-443"] == "reject"
    frozen = providers.freeze_for_backup(stand.config.read_text(), stand.root)
    stand.config.write_text(frozen)
    result = svc.refresh_subscription(str(stand.root), stand.ids[1], **stand.args)
    assert result["ok"] and result["hot_applied"]
    assert yaml.safe_load(stand.config.read_text())["proxy-providers"][name]["type"] == "file"


def test_last_modified_and_request_header_changes(stand):
    from services.xray_subscriptions import _conditional_subscription_headers

    stand.feeds["/one"][1] = ""
    assert svc.refresh_subscription(str(stand.root), stand.ids[0], **stand.args)["ok"]
    validators = svc.list_subscriptions(str(stand.root))[0]["http_validators"]
    assert "If-Modified-Since" in _conditional_subscription_headers({}, validators)
    assert "If-Modified-Since" not in _conditional_subscription_headers({"User-Agent": "different"}, validators)
    result = svc.refresh_subscription(str(stand.root), stand.ids[0], **stand.args)
    assert result["ok"] and result["not_modified"]


def test_unrelated_config_edit_can_migrate_but_owned_node_edit_is_protected(stand):
    stand.config.write_text(stand.config.read_text() + "# unrelated edit\n")
    result = svc.refresh_subscription(str(stand.root), stand.ids[1], **stand.args)
    assert result["ok"] and result["hot_applied"]
    assert "# unrelated edit" in stand.config.read_text()
    stand.config.write_text(stand.config.read_text().replace("type: direct", "type: reject", 1))
    result = svc.refresh_subscription(str(stand.root), stand.ids[0], **stand.args)
    assert not result["ok"] and result["error"] == "active_config_changed"


def test_detaching_keeps_provider_and_deleting_removes_only_its_references(stand):
    due(stand)
    svc.refresh_due_subscriptions(str(stand.root), **stand.args)
    before = stand.config.read_text()
    first = svc.list_subscriptions(str(stand.root))[0]
    svc.delete_subscription(str(stand.root), first["id"])
    assert stand.config.read_text() == before
    second = svc.list_subscriptions(str(stand.root))[0]
    result = svc.delete_subscription(str(stand.root), second["id"], config_text=before, remove_config_blocks=True)
    parsed = yaml.safe_load(result["content"])
    assert second["provider_name"] not in (parsed["proxy-providers"] or {})
    assert first["provider_name"] in parsed["proxy-providers"]


@pytest.mark.parametrize("groups,rules", [
    ([{"name": "Main", "type": "select", "proxies": ["A"]}], []),
    ([{"name": "Main", "type": "fallback", "proxies": ["A", "B", "DIRECT"]}], []),
    ([{"name": "Main", "type": "select", "proxies": ["A", "B"]}], ["MATCH,A"]),
])
def test_migration_preserves_subset_priority_and_direct_targets(tmp_path, groups, rules):
    content = yaml.safe_dump({"proxies": [{"name": n, "type": "direct"} for n in ("A", "B")],
                              "proxy-groups": groups, "rules": rules}, sort_keys=False)
    assert providers.migrate_config(content, ["A", "B"], "xk-managed-test", tmp_path / "cache.yaml") is None
