"""Guard the historical inventory schema, not the old implementation layout."""
from pathlib import Path
import importlib.util
import json

ROOT = Path(__file__).resolve().parents[1]


def test_stage0_inventory_matches_current_source_when_collected():
    script = ROOT / 'scripts/capture_mihomo_import_inventory.py'
    spec = importlib.util.spec_from_file_location('mihomo_import_inventory', script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    data = module.collect()
    assert data['schema_version'] == 1
    assert len(data['sources']) >= 10
    assert all(len(source['sha256']) == 64 for source in data['sources'])
    assert {mode[0] for mode in data['modes']} == {
        'auto', 'proxy', 'subscription', 'amnezia-premium', 'wireguard', 'openvpn', 'tailscale',
    }
    assert 'mihomo-import-modal' in data['dom_ids']
    assert {'open', 'openWithInput', 'generateConfigForMihomo'} <= set(data['facade_methods'])


def test_stage0_capture_is_opt_in_and_cannot_target_external_router():
    config = (ROOT / 'e2e/mihomo_import_baseline.config.mjs').read_text(encoding='utf-8')
    capture = (ROOT / 'e2e/mihomo_import_stage0_baseline.capture.mjs').read_text(encoding='utf-8')
    assert "testMatch: 'mihomo_import_stage0_baseline.capture.mjs'" in config
    assert 'if (process.env.E2E_BASE_URL) throw new Error' in capture
    assert "pathname === '/api/mihomo-config'" in capture
    assert 'registration' in capture
    assert 'Stage 0 blocks persistent/runtime mutations' in capture
    fixtures = json.loads((ROOT / 'e2e/fixtures/mihomo-import/stage0.json').read_text(encoding='utf-8'))
    assert 'example.com' in fixtures['proxy']
    assert 'Stage 0 synthetic fixture' in fixtures['base_config']
