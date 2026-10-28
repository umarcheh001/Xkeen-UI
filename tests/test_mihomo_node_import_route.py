from unittest.mock import patch
from types import SimpleNamespace

import pytest
from flask import Flask

from routes.mihomo import create_mihomo_blueprint
from services.mihomo_proxy_parsers import ProxyParseResult


@pytest.fixture()
def client(tmp_path):
    config = tmp_path / "config.yaml"
    config.write_text("proxies: []\n", encoding="utf-8")
    app = Flask(__name__)
    app.register_blueprint(
        create_mihomo_blueprint(
            MIHOMO_CONFIG_FILE=str(config),
            MIHOMO_TEMPLATES_DIR=str(tmp_path),
            MIHOMO_DEFAULT_TEMPLATE=str(tmp_path / "default.yaml"),
            restart_xkeen=lambda: None,
        )
    )
    return app.test_client(), config


def test_import_draft_route_returns_patched_content_without_writing_file(client):
    http, config_path = client
    source = (
        "vless://11111111-1111-1111-1111-111111111111@example.com:443"
        "?encryption=none&security=tls&type=tcp#Mobile"
    )
    content = """\
proxies: []
proxy-groups:
  - name: Main
    type: select
    proxies: [DIRECT]
"""
    response = http.post(
        "/api/mihomo/node/import-draft",
        json={"content": content, "source": source, "mode": "proxy", "groups": ["Main"]},
    )

    assert response.status_code == 200
    result = response.get_json()
    assert result["inserted_names"] == ["Mobile"]
    assert "  - name: Mobile\n" in result["content"]
    assert '    proxies: [DIRECT, Mobile]' in result["content"]
    assert result["highlight"]["end"] > result["highlight"]["start"]
    assert config_path.read_text(encoding="utf-8") == "proxies: []\n"


def test_attach_provider_route_uses_use_and_reports_unknown_groups(client):
    http, _config_path = client
    content = """\
proxy-providers:
  source:
    type: http
    url: http://127.0.0.1/provider.yaml
proxy-groups:
  - name: Main
    type: select
    use: [old] # keep
    filter: "^(old|source)$"
  - name: Static
    type: select
    proxies: [DIRECT]
"""
    response = http.post(
        "/api/mihomo/patch/attach_providers",
        json={
            "content": content,
            "providers": ["source"],
            "groups": ["Main", "Missing"],
        },
    )

    assert response.status_code == 200
    result = response.get_json()
    assert result["attached_groups"] == ["Main"]
    assert result["missing_groups"] == ["Missing"]
    assert "use: [old, source] # keep" in result["content"]
    assert 'filter: "^(old|source)$"' in result["content"]
    assert "proxies: [DIRECT]" in result["content"]


def test_attach_provider_never_returns_a_corrupted_group_alias(client):
    import yaml
    http, _ = client
    source = 'refs: &refs [old]\nproxy-groups:\n  - name: Main\n    type: select\n    use: *refs\nrules: []\n'
    response = http.post('/api/mihomo/patch/attach_providers', json={
        'content': source, 'providers': ['new'], 'groups': ['Main'],
    })
    if response.status_code != 200:
        assert response.status_code == 400
        return
    result = yaml.safe_load(response.get_json()['content'])
    assert result['proxy-groups'][0]['use'] == ['old', 'new']
    assert result['refs'] == ['old']


def test_attach_provider_does_not_duplicate_quoted_use_key(client):
    import yaml
    http, _ = client
    source = 'proxy-groups:\n  - name: Main\n    type: select\n    "use": [new]\nrules: []\n'
    response = http.post('/api/mihomo/patch/attach_providers', json={
        'content': source, 'providers': ['new'], 'groups': ['Main'],
    })
    if response.status_code != 200:
        assert response.status_code == 400
        return
    tree = yaml.compose(response.get_json()['content'])
    groups = next(value for key, value in tree.value if key.value == 'proxy-groups')
    assert sum(key.value == 'use' for key, _ in groups.value[0].value) == 1


def test_attach_provider_does_not_log_secret_from_invalid_yaml(client, caplog):
    http, _ = client
    secret = 'diagnostic-sensitive-value'
    source = f'proxy-groups:\n  - name: Main\n    use: ["{secret}", broken\n'
    response = http.post('/api/mihomo/patch/attach_providers', json={
        'content': source, 'providers': ['new'], 'groups': ['Main'],
    })
    assert response.status_code == 400
    assert secret not in response.get_data(as_text=True)
    assert secret not in caplog.text


def test_batch_never_claims_attachment_if_group_alias_is_unmodified(client):
    import yaml
    http, _ = client
    source = 'refs: &refs [DIRECT]\nproxies: []\nproxy-groups:\n  - name: Main\n    type: select\n    proxies: *refs\nrules: []\n'
    response = http.post('/api/mihomo/patch/apply_batch', json={
        'content': source, 'groups': ['Main'], 'proxies': [{'proxy_name': 'new', 'proxy_yaml': '- name: new\n  type: direct\n'}],
    })
    if response.status_code != 200:
        assert response.status_code == 400
        return
    result = yaml.safe_load(response.get_json()['content'])
    assert result['proxy-groups'][0]['proxies'] == ['DIRECT', 'new']
    assert result['refs'] == ['DIRECT']


def test_batch_does_not_duplicate_quoted_group_proxies_key(client):
    import yaml
    http, _ = client
    source = 'proxies: []\nproxy-groups:\n  - name: Main\n    type: select\n    "proxies": [new]\nrules: []\n'
    response = http.post('/api/mihomo/patch/apply_batch', json={
        'content': source, 'groups': ['Main'], 'proxies': [{'proxy_name': 'new', 'proxy_yaml': '- name: new\n  type: direct\n'}],
    })
    if response.status_code != 200:
        assert response.status_code == 400
        return
    tree = yaml.compose(response.get_json()['content'])
    groups = next(value for key, value in tree.value if key.value == 'proxy-groups')
    assert sum(key.value == 'proxies' for key, _ in groups.value[0].value) == 1


def test_apply_insert_reports_unknown_groups_without_registering_proxy(client):
    http, _config_path = client
    content = """\
proxies: []
proxy-groups:
  - name: Main
    type: select
    proxies: [DIRECT]
"""
    response = http.post(
        "/api/mihomo/patch/apply_insert",
        json={
            "content": content,
            "proxy_yaml": "- name: Fresh\n  type: direct\n",
            "proxy_name": "Fresh",
            "groups": ["Main", "Missing"],
        },
    )

    assert response.status_code == 200
    result = response.get_json()
    assert result["attached_groups"] == ["Main"]
    assert result["missing_groups"] == ["Missing"]
    assert "proxies: [DIRECT, Fresh]" in result["content"]


def test_import_commit_requires_validation_and_can_queue_explicit_apply(client):
    http, config_path = client
    content = "proxies: []\n"
    with patch("routes.mihomo.validate_config", return_value="$ mihomo -t\n[exit code: 0]\n"), \
        patch("routes.mihomo.ensure_mihomo_layout"), \
        patch("routes.mihomo.save_config", return_value=SimpleNamespace(filename="backup.yaml")), \
        patch("routes.mihomo.create_command_job", return_value=SimpleNamespace(id="job-1")):
        response = http.post(
            "/api/mihomo/import/commit",
            json={"content": content, "restart": True, "base_revision": http.get("/api/mihomo-config").get_json()["revision"]},
        )

    assert response.status_code == 202
    result = response.get_json()
    assert result["saved"] is True
    assert result["restart_job_id"] == "job-1"
    assert result["backup"] == "backup.yaml"
    assert config_path.read_text(encoding="utf-8") == "proxies: []\n"


def test_import_commit_rejects_stale_file_revision_without_saving(client):
    http, config_path = client
    with patch("routes.mihomo.validate_config") as validate, \
        patch("routes.mihomo.save_config") as save:
        response = http.post(
            "/api/mihomo/import/commit",
            json={"content": "proxies: []\n", "base_revision": "stale"},
        )

    assert response.status_code == 409
    assert response.get_json()["code"] == "stale_config"
    validate.assert_not_called()
    save.assert_not_called()


def test_import_commit_requires_file_revision(client):
    http, _ = client
    with patch("routes.mihomo.save_config") as save:
        response = http.post("/api/mihomo/import/commit", json={"content": "proxies: []\n"})
    assert response.status_code == 409
    assert response.get_json()["code"] == "revision_required"
    save.assert_not_called()


def test_import_commit_rechecks_revision_after_validation(client):
    http, config = client
    revision = http.get("/api/mihomo-config").get_json()["revision"]

    def validate(**_kwargs):
        config.write_text("proxies: []\n# external writer\n", encoding="utf-8")
        return "[exit code: 0]"

    with patch("routes.mihomo.validate_config", side_effect=validate), patch("routes.mihomo.save_config", return_value=None) as save:
        response = http.post("/api/mihomo/import/commit", json={"content": "proxies: []\n# candidate\n", "base_revision": revision})
    assert response.status_code == 409
    assert response.get_json()["code"] == "stale_config"
    save.assert_not_called()


def test_import_commit_rejects_profile_change_with_identical_content(client):
    http, _ = client
    identity = {'path': 'profile-one.yaml'}
    with patch('routes.mihomo._active_config_identity', side_effect=lambda _path: identity['path']):
        revision = http.get('/api/mihomo-config').get_json()['revision']
        identity['path'] = 'profile-two.yaml'
        with patch('routes.mihomo.save_config') as save:
            response = http.post('/api/mihomo/import/commit', json={
                'content': 'proxies: []\n', 'base_revision': revision,
            })
    assert response.status_code == 409
    assert response.get_json()['code'] == 'stale_config'
    save.assert_not_called()


def test_batch_patch_is_atomic_and_preserves_group_comments(client):
    http, config = client
    content = "proxies: []\nproxy-groups:\n  - name: Main\n    type: select\n    proxies: [DIRECT] # keep\nrules: []\n"
    response = http.post("/api/mihomo/patch/apply_batch", json={
        "content": content, "groups": ["Main", "Missing"], "proxies": [
            {"proxy_name": "One", "proxy_yaml": "- name: One\n  type: direct\n"},
            {"proxy_name": "Two", "proxy_yaml": "- name: Two\n  type: direct\n"},
        ],
    })
    assert response.status_code == 200
    data = response.get_json()
    assert "proxies: [DIRECT, One, Two] # keep" in data["content"]
    assert data["missing_groups"] == ["Missing"]
    assert config.read_text(encoding="utf-8") == "proxies: []\n"
    rejected = http.post("/api/mihomo/patch/apply_batch", json={
        "content": content, "proxies": [{"proxy_name": "One", "proxy_yaml": "- name: One\n  type: direct\n"}, {"proxy_name": "Bad", "proxy_yaml": "[invalid"}],
    })
    assert rejected.status_code == 400
    assert "content" not in rejected.get_json()


def test_batch_patch_without_pyyaml_handles_router_subscription(client):
    http, config = client
    source = "proxies:\n  - name: Existing\n    type: direct\nproxy-groups:\n  - name: Main\n    type: select\n    proxies: [DIRECT] # keep\nrules: []\n"
    items = [
        {"proxy_name": f"Node {index}", "proxy_yaml": f"- name: 'Node {index}'\n  type: vless\n  server: example.com\n  port: 443\n  xhttp-opts:\n    path: /api/v2/\n"}
        for index in range(18)
    ]
    with patch.dict("sys.modules", {"yaml": None}):
        response = http.post("/api/mihomo/patch/apply_batch", json={
            "content": source, "groups": ["Main"], "proxies": items,
        })
    assert response.status_code == 200
    result = response.get_json()
    assert result["attached_groups"] == ["Main"]
    assert result["content"].count("  - name:") == 20  # 19 proxies and one group
    assert "  - name: Existing\n    type: direct" in result["content"]
    assert "proxies: [DIRECT, \"Node 0\"" in result["content"]
    assert "# keep" in result["content"]
    assert config.read_text(encoding="utf-8") == "proxies: []\n"


def test_batch_patch_without_pyyaml_rejects_duplicate_or_unsupported_input(client):
    http, _ = client
    source = "proxies:\n  - name: Existing\n    type: direct\n"
    with patch.dict("sys.modules", {"yaml": None}):
        duplicate = http.post("/api/mihomo/patch/apply_batch", json={
            "content": source, "proxies": [{"proxy_name": "Existing", "proxy_yaml": "- name: Existing\n  type: direct\n"}],
        })
        malformed = http.post("/api/mihomo/patch/apply_batch", json={
            "content": source, "proxies": [{"proxy_name": "New", "proxy_yaml": "- name: New\n  type: direct\n- name: Other\n  type: direct\n"}],
        })
        alias = http.post("/api/mihomo/patch/apply_batch", json={
            "content": "refs: &refs [DIRECT]\nproxies: []\nproxy-groups:\n  - name: Main\n    type: select\n    proxies: *refs\n",
            "groups": ["Main"], "proxies": [{"proxy_name": "New", "proxy_yaml": "- name: New\n  type: direct\n"}],
        })
    for response in (duplicate, malformed, alias):
        assert response.status_code == 400
        assert "content" not in response.get_json()


def test_batch_patch_without_pyyaml_accepts_empty_proxy_section(client):
    http, _ = client
    with patch.dict("sys.modules", {"yaml": None}):
        response = http.post("/api/mihomo/patch/apply_batch", json={
            "content": "proxies: []\nproxy-groups: []\n",
            "proxies": [{"proxy_name": "New", "proxy_yaml": "- name: New\n  type: direct\n"}],
        })
    assert response.status_code == 200
    assert "proxies:\n  - name: New" in response.get_json()["content"]


def test_batch_patch_rejects_flow_style_instead_of_duplicating_section(client):
    http, _ = client
    response = http.post("/api/mihomo/patch/apply_batch", json={
        "content": "proxies: [{name: Old, type: direct}]\n",
        "proxies": [{"proxy_name": "New", "proxy_yaml": "- name: New\n  type: direct\n"}],
    })
    assert response.status_code == 400


def test_retry_apply_does_not_save_the_config_again(client):
    http, _ = client
    revision = http.get("/api/mihomo-config").get_json()["revision"]
    with patch("routes.mihomo.save_config") as save, patch("routes.mihomo.create_command_job", return_value=SimpleNamespace(id="retry-job")):
        response = http.post("/api/mihomo/import/apply", json={"base_revision": revision})
    assert response.status_code == 202
    assert response.get_json()["restart_job_id"] == "retry-job"
    save.assert_not_called()


def test_import_baseline_supports_new_config_without_creating_a_file(client):
    http, config = client
    config.unlink()
    response = http.get("/api/mihomo-config?baseline=1")
    assert response.status_code == 200
    assert response.get_json()["exists"] is False
    assert response.get_json()["revision"]
    assert not config.exists()


def test_batch_patch_preserves_nodes_under_a_commented_section_header(client):
    http, _ = client
    content = "proxies: # existing nodes\n  - name: old\n    type: direct\nproxy-groups: []\n"
    response = http.post("/api/mihomo/patch/apply_batch", json={"content": content, "proxies": [
        {"proxy_name": "new", "proxy_yaml": "- name: new\n  type: direct\n"},
    ]})
    assert response.status_code == 200
    import yaml
    result = response.get_json()["content"]
    assert [node["name"] for node in yaml.safe_load(result)["proxies"]] == ["old", "new"]
    assert result.count("proxies:") == 1
    assert "# existing nodes" in result


def test_batch_patch_preserves_or_rejects_anchored_proxy_section(client):
    http, _ = client
    source = "proxies: &nodes\n  - name: old\n    type: direct\nproxy-groups: []\n"
    response = http.post("/api/mihomo/patch/apply_batch", json={"content": source, "proxies": [
        {"proxy_name": "new", "proxy_yaml": "- name: new\n  type: direct\n"},
    ]})
    if response.status_code == 200:
        import yaml
        result = response.get_json()["content"]
        assert [node["name"] for node in yaml.safe_load(result)["proxies"]] == ["old", "new"]
        assert result.count("proxies:") == 1
    else:
        assert response.status_code == 400
        assert "content" not in response.get_json()


def test_batch_patch_accepts_empty_config(client):
    http, _ = client
    response = http.post("/api/mihomo/patch/apply_batch", json={"content": "", "proxies": [
        {"proxy_name": "new", "proxy_yaml": "- name: new\n  type: direct\n"},
    ]})
    assert response.status_code == 200
    assert "name: new" in response.get_json()["content"]


def test_batch_rejects_new_node_with_existing_name(client):
    http, _ = client
    response = http.post('/api/mihomo/patch/apply_batch', json={
        'content': 'proxies:\n  - name: duplicate\n    type: direct\n',
        'proxies': [{'proxy_name': 'duplicate', 'proxy_yaml': '- name: duplicate\n  type: reject\n'}],
    })
    assert response.status_code == 400
    assert 'content' not in response.get_json()


@pytest.mark.parametrize("source", [
    'proxies:\n  - name: "старый: один"\n    type: direct\nproxy-groups: []\n',
    'proxies:\n- name: old\n  type: direct\nproxy-groups: []\n',
    'proxies: &nodes\n  - name: old\n    type: direct\ncopy: *nodes\n',
    '"proxies":\n  - name: old\n    type: direct\nproxy-groups: []\n',
])
def test_batch_handles_complex_yaml_without_losing_original_nodes(client, source):
    import yaml
    http, _ = client
    old = yaml.safe_load(source)
    response = http.post("/api/mihomo/patch/apply_batch", json={"content": source, "proxies": [
        {"proxy_name": "Новый: 1", "proxy_yaml": '- name: "Новый: 1"\n  type: direct\n'},
    ]})
    if response.status_code != 200:
        assert response.status_code == 400
        assert "content" not in response.get_json()
        return
    result = response.get_json()["content"]
    new = yaml.safe_load(result)
    assert new["proxies"][:-1] == old["proxies"]
    assert new["proxies"][-1]["name"] == "Новый: 1"
    for key in old.keys() - {"proxies"}:
        assert new[key] == old[key]


def test_import_commit_replay_does_not_save_or_restart_twice(client):
    http, _ = client
    body = {"content": "proxies: []\n", "restart": True, "operation_id": "same-import",
            "base_revision": http.get("/api/mihomo-config").get_json()["revision"]}
    with patch("routes.mihomo.validate_config", return_value="[exit code: 0]"), \
        patch("routes.mihomo.ensure_mihomo_layout"), \
        patch("routes.mihomo.save_config", return_value=None) as save, \
        patch("routes.mihomo.create_command_job", return_value=SimpleNamespace(id="one-job")) as job:
        first = http.post("/api/mihomo/import/commit", json=body)
        second = http.post("/api/mihomo/import/commit", json=body)
    assert first.status_code == second.status_code == 202
    assert second.get_json()["restart_job_id"] == "one-job"
    assert save.call_count == job.call_count == 1


def test_retry_apply_replay_does_not_schedule_twice(client):
    http, _ = client
    body = {"base_revision": http.get("/api/mihomo-config").get_json()["revision"], "operation_id": "same-apply"}
    with patch("routes.mihomo.create_command_job", return_value=SimpleNamespace(id="one-job")) as job:
        http.post("/api/mihomo/import/apply", json=body)
        second = http.post("/api/mihomo/import/apply", json=body)
    assert second.status_code == 202
    assert job.call_count == 1


@pytest.mark.parametrize("log,status", [("[exit code: 1]", 400), ("runner unavailable", 503)])
def test_import_validation_failure_never_writes_or_restarts(client, log, status):
    http, _ = client
    revision = http.get("/api/mihomo-config").get_json()["revision"]
    with patch("routes.mihomo.validate_config", return_value=log), \
        patch("routes.mihomo.save_config") as save, patch("routes.mihomo.create_command_job") as job:
        response = http.post("/api/mihomo/import/commit", json={"content": "proxies: []\n", "base_revision": revision, "restart": True})
    assert response.status_code == status
    save.assert_not_called()
    job.assert_not_called()


def test_import_save_failure_does_not_schedule_restart(client):
    http, _ = client
    revision = http.get("/api/mihomo-config").get_json()["revision"]
    with patch("routes.mihomo.validate_config", return_value="[exit code: 0]"), \
        patch("routes.mihomo.ensure_mihomo_layout"), \
        patch("routes.mihomo.save_config", side_effect=OSError("backup failed")), \
        patch("routes.mihomo.create_command_job") as job:
        response = http.post("/api/mihomo/import/commit", json={"content": "proxies: []\n", "base_revision": revision, "restart": True})
    assert response.status_code == 400
    job.assert_not_called()


def test_parse_amnezia_premium_key_returns_mihomo_proxy(client):
    http, _config_path = client
    wireguard_config = """\
[Interface]
Name = Amnezia Premium
PrivateKey = private-key
Address = 10.0.0.2/32
Jc = 5

[Peer]
PublicKey = server-key
Endpoint = fi-edge.example:51820
AllowedIPs = 0.0.0.0/0
"""
    with patch(
        "routes.mihomo._amnezia_import_connection_key",
        return_value=wireguard_config,
    ) as importer:
        response = http.post(
            "/api/mihomo/parse/amnezia-premium",
            json={"text": "vpn://test-key"},
        )

    assert response.status_code == 200
    result = response.get_json()
    assert result["proxy_name"] == "Amnezia Premium"
    assert "server: fi-edge.example" in result["proxy_yaml"]
    assert "jc: 5" in result["proxy_yaml"]
    importer.assert_called_once_with("vpn://test-key")


def test_amnezia_premium_locations_route_only_loads_available_locations(client):
    http, _config_path = client
    locations = [
        {"code": "FI", "name": "Finland"},
        {"code": "DE", "name": "Germany"},
    ]
    with patch(
        "routes.mihomo._amnezia_list_available_locations",
        return_value=locations,
    ) as list_locations:
        response = http.post(
            "/api/mihomo/amnezia-premium/locations",
            json={"text": "vpn://test-key"},
        )

    assert response.status_code == 200
    assert response.get_json()["locations"] == locations
    list_locations.assert_called_once_with("vpn://test-key")


def test_parse_amnezia_premium_key_returns_every_selected_location(client):
    http, _config_path = client
    calls = []

    def issue_config(text, *, server_country_code="", display_name=""):
        calls.append((text, server_country_code, display_name))
        return f"""\
[Interface]
PrivateKey = private-{server_country_code}
Address = 10.0.0.2/32

[Peer]
PublicKey = server-{server_country_code}
Endpoint = {server_country_code.lower()}.example:51820
AllowedIPs = 0.0.0.0/0
"""

    with patch(
        "routes.mihomo._amnezia_import_connection_key",
        side_effect=issue_config,
    ):
        response = http.post(
            "/api/mihomo/parse/amnezia-premium",
            json={
                "text": "vpn://test-key",
                "server_country_codes": ["FI", "DE"],
                "locations": [
                    {"code": "FI", "name": "Finland"},
                    {"code": "DE", "name": "Germany"},
                ],
                "existing_names": ["Germany"],
            },
        )

    assert response.status_code == 200
    result = response.get_json()
    assert [proxy["proxy_name"] for proxy in result["proxies"]] == ["FI Finland", "DE Germany_2"]
    assert "server: fi.example" in result["proxies"][0]["proxy_yaml"]
    assert "server: de.example" in result["proxies"][1]["proxy_yaml"]
    assert calls == [
        ("vpn://test-key", "FI", "Finland"),
        ("vpn://test-key", "DE", "Germany"),
    ]


def test_import_draft_route_auto_detects_amnezia_premium_key(client):
    http, _config_path = client
    wireguard_config = """\
[Interface]
Name = Amnezia Premium
PrivateKey = private-key
Address = 10.0.0.2/32

[Peer]
PublicKey = server-key
Endpoint = fi-edge.example:51820
AllowedIPs = 0.0.0.0/0
"""
    with patch(
        "routes.mihomo._amnezia_import_connection_key",
        return_value=wireguard_config,
    ) as importer:
        response = http.post(
            "/api/mihomo/node/import-draft",
            json={
                "content": "proxies: []\n",
                "source": "vpn://test-key",
                "mode": "auto",
                "groups": [],
            },
        )

    assert response.status_code == 200
    assert "server: fi-edge.example" in response.get_json()["content"]
    importer.assert_called_once_with("vpn://test-key")


def test_import_draft_route_falls_back_to_safe_provider_adapter(client):
    http, _config_path = client
    with patch(
        "routes.mihomo._xray_fetch_subscription_body",
        return_value=("proxies:\n  - name: Clash\n    type: direct\n", {}),
    ), patch(
        "routes.mihomo._mh_hwid_probe_subscription_safe",
        return_value={"ok": True, "hwid_response_headers": {}},
    ), patch("routes.mihomo._mihomo_provider_direct_headers", return_value={}):
        response = http.post(
            "/api/mihomo/node/import-draft",
            json={
                "content": "proxies: []\n",
                "source": "https://provider.example/subscription",
                "mode": "subscription",
                "groups": [],
            },
        )

    assert response.status_code == 200
    result = response.get_json()
    assert result["inserted_kind"] == "provider"
    assert "proxy-providers:" in result["content"]
    assert "http://127.0.0.1:" in result["content"]


def test_import_draft_route_selects_hwid_adapter_when_provider_requires_device(client):
    http, _config_path = client
    with patch(
        "routes.mihomo._xray_fetch_subscription_body",
        return_value=("proxies:\n  - name: Placeholder\n    type: direct\n", {}),
    ), patch(
        "routes.mihomo._mh_hwid_probe_subscription_safe",
        return_value={"ok": True, "hwid_response_headers": {"x-hwid-not-supported": "true"}},
    ), patch("routes.mihomo._mihomo_provider_direct_headers", return_value={}), patch(
        "routes.mihomo._mh_hwid_get_device_info",
        return_value={"headers": {"x-hwid": "device"}},
    ), patch(
        "routes.mihomo._mh_hwid_fetch_provider_payload",
        return_value=(b"proxies: []\n", {}),
    ), patch(
        "routes.mihomo._mihomo_provider_payload_summary",
        return_value={"has_nodes": True, "node_count": 2},
    ):
        response = http.post(
            "/api/mihomo/node/import-draft",
            json={
                "content": "proxies: []\n",
                "source": "https://provider.example/hwid",
                "mode": "subscription",
                "groups": [],
            },
        )

    assert response.status_code == 200
    assert "/mihomo/hwid/provider.yaml?" in response.get_json()["content"]


def test_import_draft_route_registers_xray_auto_update_when_requested(client):
    http, _config_path = client
    proxies = [ProxyParseResult("Node", "- name: Node\n  type: vless\n")]
    with patch(
        "routes.mihomo._xray_fetch_subscription_body",
        return_value=("xray-json", {}),
    ), patch(
        "routes.mihomo._xray_convert_subscription_source_text",
        return_value=(proxies, [], "xray-json"),
    ), patch("routes.mihomo._mh_sub_sync_imported_xray_subscription") as register:
        response = http.post(
            "/api/mihomo/node/import-draft",
            json={
                "content": "proxies: []\n",
                "source": "https://provider.example/xray",
                "mode": "subscription",
                "groups": [],
                "auto_update_subscriptions": True,
                "interval_hours": 48,
            },
        )

    assert response.status_code == 200
    assert response.get_json()["registered_subscriptions"] == 1
    register.assert_called_once()
    assert register.call_args.kwargs["interval_hours"] == 48
    assert register.call_args.kwargs["proxy_yamls"] == [proxies[0].yaml]


def test_import_draft_route_converts_base64_xray_links_from_happ_subscription(client):
    http, _config_path = client
    link = (
        "vless://11111111-1111-1111-1111-111111111111@example.com:443"
        "?encryption=none&security=tls&type=ws&path=%2Fws#Happ%20Node"
    )
    with patch(
        "routes.mihomo._xray_fetch_subscription_body",
        return_value=(link, {"content-type": "text/plain"}),
    ):
        response = http.post(
            "/api/mihomo/node/import-draft",
            json={
                "content": "proxies: []\n",
                "source": "happ://crypt5/demo-token",
                "mode": "subscription",
                "groups": [],
            },
        )

    assert response.status_code == 200
    result = response.get_json()
    assert result["inserted_kind"] == "proxy"
    assert result["inserted_names"] == ["Happ Node"]
    assert "server: example.com" in result["content"]


def test_import_draft_route_rejects_unsupported_client_placeholder(client):
    http, _config_path = client
    blocked = (
        "vless://00000000-0000-0000-0000-000000000000@subscription.blocked:443"
        "?security=tls&type=tcp#unsupported%20client"
    )
    with patch(
        "routes.mihomo._xray_fetch_subscription_body",
        return_value=(blocked, {"content-type": "text/plain"}),
    ):
        response = http.post(
            "/api/mihomo/node/import-draft",
            json={
                "content": "proxies: []\n",
                "source": "happ://crypt5/demo-token",
                "mode": "subscription",
                "groups": [],
            },
        )

    assert response.status_code == 400
    assert "служебную заглушку" in response.get_json()["error"]


def test_import_draft_route_rejects_invalid_mode(client):
    http, _config_path = client
    response = http.post(
        "/api/mihomo/node/import-draft",
        json={"content": "proxies: []\n", "source": "anything", "mode": "unknown"},
    )

    assert response.status_code == 400
    assert response.get_json()["code"] == "mihomo_node_import_invalid"
