from pathlib import Path


def test_events_service_exposes_locked_subscriber_helpers_and_run_server_uses_them():
    events_text = Path('xkeen-ui/services/events.py').read_text(encoding='utf-8')
    app_text = Path('xkeen-ui/app.py').read_text(encoding='utf-8')
    server_text = Path('xkeen-ui/run_server.py').read_text(encoding='utf-8')
    wsgi_text = Path('xkeen-ui/services/ws_wsgi.py').read_text(encoding='utf-8')

    assert 'import threading' in events_text
    assert '_EVENT_SUBSCRIBERS_LOCK: threading.Lock = threading.Lock()' in events_text
    assert 'def subscribe(ws: Any) -> None:' in events_text
    assert 'def unsubscribe(ws: Any) -> None:' in events_text
    assert 'with _EVENT_SUBSCRIBERS_LOCK:' in events_text
    assert 'snapshot = list(EVENT_SUBSCRIBERS)' in events_text
    assert 'subscribers=len(snapshot),' in events_text

    assert 'from services.events import EVENT_SUBSCRIBERS, subscribe as _subscribe_ws, unsubscribe as _unsubscribe_ws' in app_text
    assert '"_subscribe_ws",' in app_text
    assert '"_unsubscribe_ws",' in app_text

    assert '_subscribe_ws,' in server_text
    assert '_unsubscribe_ws,' in server_text
    assert 'subscribe_ws=_subscribe_ws' in server_text
    assert 'unsubscribe_ws=_unsubscribe_ws' in server_text
    assert 'subscribe_ws(ws)' in wsgi_text
    assert 'unsubscribe_ws(ws)' in wsgi_text
    assert 'EVENT_SUBSCRIBERS.append(ws)' not in server_text
    assert 'EVENT_SUBSCRIBERS.remove(ws)' not in server_text


def test_geodat_and_xray_log_caches_are_guarded_by_locks():
    geodat_text = Path('xkeen-ui/services/geodat/cache.py').read_text(encoding='utf-8')
    xray_log_api_text = Path('xkeen-ui/services/xray_log_api.py').read_text(encoding='utf-8')

    assert '_GEODAT_CACHE_LOCK = threading.Lock()' in geodat_text
    assert geodat_text.count('with _GEODAT_CACHE_LOCK:') >= 2
    assert '_LOG_CACHE_LOCK: threading.Lock = threading.Lock()' in xray_log_api_text
    assert 'with _LOG_CACHE_LOCK:' in xray_log_api_text
    assert 'return xray_logs.tail_lines(path, max_lines=max_lines, cache=LOG_CACHE)' in xray_log_api_text
    assert 'LOG_CACHE.pop(actual, None)' in xray_log_api_text


def test_github_index_cache_reads_and_writes_are_locked_around_future_snapshot():
    text = Path('xkeen-ui/services/config_exchange_github.py').read_text(encoding='utf-8')

    assert 'with _GH_INDEX_LOCK:' in text
    assert 'future = _GH_INDEX_FUTURE' in text
    assert 'items = future.result(timeout=max(0.1, float(wait_seconds)))' in text
    assert text.count('cached = _GH_INDEX_CACHE["items"]') >= 3
    assert 'return cached, True' in text


def test_mihomo_generator_escapes_rule_group_labels_before_innerhtml_injection():
    text = Path('xkeen-ui/static/js/features/mihomo_generator.js').read_text(encoding='utf-8')

    assert 'function escapeHtml(str) {' in text
    assert 'span.innerHTML = "<strong>" + escapeHtml(preset.label) + "</strong>";' in text


def test_pty_runtime_is_extracted_from_run_server_into_dedicated_service_module():
    server_text = Path('xkeen-ui/run_server.py').read_text(encoding='utf-8')
    pty_text = Path('xkeen-ui/services/ws_pty.py').read_text(encoding='utf-8')

    assert 'class PtySession:' in pty_text
    assert 'def cleanup_sessions(now: float | None = None) -> None:' in pty_text
    assert 'def start_cleanup_loop() -> bool:' in pty_text
    assert 'def handle_pty_request(' in pty_text
    assert 'class PtySession:' not in server_text
    assert 'def _pty_cleanup_loop()' not in server_text


def test_mihomo_runtime_helpers_are_extracted_from_core_module():
    core_text = Path('xkeen-ui/mihomo_server_core.py').read_text(encoding='utf-8')
    runtime_text = Path('xkeen-ui/services/mihomo_runtime.py').read_text(encoding='utf-8')

    assert 'from services.mihomo_runtime import (' in core_text
    assert 'def ensure_mihomo_layout() -> None:' in runtime_text
    assert 'def list_profiles() -> List[ProfileInfo]:' in runtime_text
    assert 'def list_backups(profile: Optional[str] = None) -> List[BackupInfo]:' in runtime_text
    assert 'def save_config(new_content: str) -> BackupInfo:' in runtime_text
    assert 'def restart_mihomo_and_get_log(new_content: Optional[str] = None) -> str:' in runtime_text
    assert 'def validate_config(new_content: Optional[str] = None) -> str:' in runtime_text


def test_mihomo_generator_metadata_is_extracted_from_main_generator_module():
    generator_text = Path('xkeen-ui/mihomo_config_generator.py').read_text(encoding='utf-8')
    meta_text = Path('xkeen-ui/services/mihomo_generator_meta.py').read_text(encoding='utf-8')

    assert 'from services.mihomo_generator_meta import (' in generator_text
    assert 'def provider_name_for_index(idx: int) -> str:' in meta_text
    assert 'def normalise_profile_name(profile: str | None) -> str:' in meta_text
    assert 'def select_template_filename(profile: str, explicit_template: Optional[str]) -> str:' in meta_text
    assert 'def load_template_text(filename: str) -> str:' in meta_text
    assert 'def get_profile_rule_presets(profile: str | None) -> Dict[str, Any]:' in meta_text
    assert generator_text.count('def get_profile_rule_presets(') == 0


def test_mihomo_generator_provider_and_proxy_injection_helpers_are_extracted():
    generator_text = Path('xkeen-ui/mihomo_config_generator.py').read_text(encoding='utf-8')
    provider_text = Path('xkeen-ui/services/mihomo_generator_providers.py').read_text(encoding='utf-8')
    proxy_text = Path('xkeen-ui/services/mihomo_generator_proxies.py').read_text(encoding='utf-8')

    assert 'from services.mihomo_generator_providers import (' in generator_text
    assert 'from services.mihomo_generator_proxies import (' in generator_text
    assert 'def replace_provider_urls(content: str, subscriptions: Sequence[str]) -> str:' in provider_text
    assert 'def filter_proxy_group_uses(content: str, subscriptions: Sequence[str]) -> str:' in provider_text
    assert 'def maybe_strip_example_vless(content: str, state: Dict[str, Any], subscriptions: Sequence[str]) -> str:' in provider_text
    assert 'def ensure_empty_proxy_providers_map(content: str) -> str:' in provider_text
    assert 'def ensure_leading_dash_for_yaml_block(yaml_block: str) -> str:' in proxy_text
    assert 'def append_proxy_meta_yaml(proxy_yaml: str, item: Dict[str, Any]) -> str:' in proxy_text
    assert 'def insert_proxies_from_state(content: str, state: Dict[str, Any]) -> str:' in proxy_text
    assert generator_text.count('def _replace_provider_urls(') == 0
    assert generator_text.count('def _filter_proxy_group_uses(') == 0
    assert generator_text.count('def _maybe_strip_example_vless(') == 0
    assert generator_text.count('def _ensure_empty_proxy_providers_map(') == 0
    assert generator_text.count('def _insert_proxies_from_state(') == 0


def test_mihomo_generator_rule_filtering_helpers_are_extracted():
    generator_text = Path('xkeen-ui/mihomo_config_generator.py').read_text(encoding='utf-8')
    rules_text = Path('xkeen-ui/services/mihomo_generator_rules.py').read_text(encoding='utf-8')

    assert 'from services.mihomo_generator_rules import (' in generator_text
    assert 'def apply_rule_group_filtering(content: str, enabled_ids: Sequence[str], profile: str | None = None) -> str:' in rules_text
    assert generator_text.count('def _remove_proxy_groups_by_name(') == 0
    assert generator_text.count('def _apply_pkg_markers(') == 0
    assert generator_text.count('def _cleanup_rules_section(') == 0
    assert generator_text.count('def _apply_rule_group_filtering(') == 0


def test_mihomo_proxy_config_edit_helpers_are_extracted_from_core_module():
    core_text = Path('xkeen-ui/mihomo_server_core.py').read_text(encoding='utf-8')
    proxy_cfg_text = Path('xkeen-ui/services/mihomo_proxy_config.py').read_text(encoding='utf-8')
    routes_text = Path('xkeen-ui/routes/mihomo.py').read_text(encoding='utf-8')
    generator_proxy_text = Path('xkeen-ui/services/mihomo_generator_proxies.py').read_text(encoding='utf-8')

    assert 'from services.mihomo_proxy_config import (' in core_text
    assert 'def insert_proxy_into_groups(content: str, proxy_name: str, target_groups: Iterable[str]) -> str:' in proxy_cfg_text
    assert 'def replace_proxy_in_config(content: str, proxy_name: str, new_proxy_yaml: str) -> Tuple[str, bool]:' in proxy_cfg_text
    assert 'def rename_proxy_in_config(content: str, old_name: str, new_name: str) -> str:' in proxy_cfg_text
    assert 'def apply_proxy_insert(' in proxy_cfg_text
    assert 'from services.mihomo_proxy_config import (' in routes_text
    assert 'from services.mihomo_proxy_config import apply_proxy_insert' in generator_proxy_text
    assert core_text.count('def insert_proxy_into_groups(') == 0
    assert core_text.count('def replace_proxy_in_config(') == 0
    assert core_text.count('def rename_proxy_in_config(') == 0
    assert core_text.count('def apply_proxy_insert(') == 0


def test_mihomo_proxy_parsers_are_extracted_from_core_module():
    core_text = Path('xkeen-ui/mihomo_server_core.py').read_text(encoding='utf-8')
    parser_text = Path('xkeen-ui/services/mihomo_proxy_parsers.py').read_text(encoding='utf-8')
    routes_text = Path('xkeen-ui/routes/mihomo.py').read_text(encoding='utf-8')
    generator_proxy_text = Path('xkeen-ui/services/mihomo_generator_proxies.py').read_text(encoding='utf-8')

    assert 'from services.mihomo_proxy_parsers import (' in core_text
    assert 'class ProxyParseResult:' in parser_text
    assert 'def parse_vless(link: str, custom_name: Optional[str] = None) -> ProxyParseResult:' in parser_text
    assert 'def parse_wireguard(conf_text: str, custom_name: Optional[str] = None) -> ProxyParseResult:' in parser_text
    assert 'def parse_proxy_uri(link: str, custom_name: Optional[str] = None) -> ProxyParseResult:' in parser_text
    assert 'from services.mihomo_proxy_parsers import parse_wireguard' in routes_text
    assert 'from services.mihomo_proxy_parsers import (' in generator_proxy_text
    assert core_text.count('def parse_vless(') == 0
    assert core_text.count('def parse_wireguard(') == 0
    assert core_text.count('def parse_trojan(') == 0
    assert core_text.count('def parse_vmess(') == 0
    assert core_text.count('def parse_shadowsocks(') == 0
    assert core_text.count('def parse_hysteria2(') == 0
    assert core_text.count('def parse_proxy_uri(') == 0
