import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMihomoImportPresentation,
  redactMihomoImportDiagnostic,
  safeMihomoSourceDomain,
} from '../../xkeen-ui/static/js/features/mihomo_import_result.js';

const PROXY_YAML = `- name: Fresh node
  type: vless
  server: edge.example.net
  port: 443
  uuid: top-secret-uuid
  network: ws
  tls: true
`;

const EXISTING_PROXY = `proxies:
  - name: Existing connection
    type: vless
    server: edge.example.net
    port: 443
    uuid: top-secret-uuid
`;

test('proxy result card exposes route metadata without YAML credentials', () => {
  const model = createMihomoImportPresentation({
    outputs: [{
      type: 'proxy', proxy_name: 'Fresh node', content: PROXY_YAML,
      name_conflict: { requested: 'Fresh node', suggested: 'Fresh_node_2' },
    }],
    existingConfig: EXISTING_PROXY,
  });

  assert.equal(model.known, true);
  assert.equal(model.received, 1);
  assert.equal(model.cards.length, 1);
  assert.equal(model.cards[0].title, 'Fresh node');
  assert.equal(model.cards[0].badge, 'VLESS');
  assert.equal(model.cards[0].source, 'edge.example.net:443');
  assert.deepEqual(model.cards[0].details, ['Транспорт: ws', 'Защита: TLS']);
  assert.match(model.cards[0].notices[0].text, /Имя «Fresh node» уже занято/);
  assert.match(model.cards[0].notices[1].text, /Похожее подключение уже есть/);
  assert.doesNotMatch(JSON.stringify(model), /top-secret-uuid/);
});

test('subscription results group static and provider sources by safe domain', () => {
  const staticModel = createMihomoImportPresentation({
    outputs: [
      { type: 'proxy', proxy_name: 'One', content: PROXY_YAML, xrayBulk: true, uri: 'https://alice:token@sub.example.org/list?token=hidden' },
      { type: 'proxy', proxy_name: 'Two', content: PROXY_YAML, xrayBulk: true, uri: 'https://alice:token@sub.example.org/list?token=hidden' },
    ],
    errors: [{ line: 3, message: 'https://alice:token@sub.example.org/list?token=hidden rejected' }],
  });
  assert.equal(staticModel.cards.length, 1);
  assert.equal(staticModel.cards[0].title, 'sub.example.org');
  assert.equal(staticModel.cards[0].destination, 'proxies');
  assert.match(staticModel.cards[0].details.join(' '), /Получено: 2 узла/);
  assert.equal(staticModel.skipped, 1);
  assert.doesNotMatch(JSON.stringify(staticModel), /alice|token=hidden/);

  const providerModel = createMihomoImportPresentation({
    outputs: [{
      type: 'proxy-provider', provider_name: 'provider_1',
      content: '  provider_1:\n    type: http\n', uri: 'happ://crypt1/opaque-secret',
    }],
  });
  assert.equal(providerModel.cards[0].title, 'Happ-адаптер');
  assert.equal(providerModel.cards[0].destination, 'proxy-providers');
  assert.doesNotMatch(JSON.stringify(providerModel), /opaque-secret/);
});

test('Amnezia discovery and blocked results never claim zero received nodes', () => {
  const discovery = createMihomoImportPresentation({
    mode: 'amnezia-premium',
    amneziaLocations: [{ code: 'FI', name: 'Finland' }, { code: 'DE', name: 'Germany' }],
    selectedAmneziaLocations: [{ code: 'FI', name: 'Finland' }],
    phase: 'locations',
  });
  assert.equal(discovery.known, false);
  assert.equal(discovery.cards[0].badge, 'Выбор локаций');
  assert.match(discovery.cards[0].details.join(' '), /Доступно локаций: 2/);
  assert.doesNotMatch(discovery.summary, /0 узлов/);

  const blocked = createMihomoImportPresentation({
    errors: ['https://user:secret@blocked.example/path?token=secret-token access blocked'],
  });
  assert.equal(blocked.known, false);
  assert.equal(blocked.outcome, 'blocked');
  assert.match(blocked.summary, /доступ к источнику заблокирован/);
  assert.doesNotMatch(JSON.stringify(blocked), /secret-token|user:secret/);

  const unsupported = createMihomoImportPresentation({ errors: ['format is not supported'] });
  assert.equal(unsupported.outcome, 'unsupported');
  assert.match(unsupported.summary, /формат источника не поддерживается/);
});

test('safe domain and diagnostics redact credentials and source paths', () => {
  assert.equal(safeMihomoSourceDomain('https://user:pass@sub.example.org:8443/a?token=x'), 'sub.example.org:8443');
  const message = redactMihomoImportDiagnostic('failed https://user:pass@sub.example.org/a?token=x; uuid=private-value');
  assert.match(message, /источник sub\.example\.org/);
  assert.doesNotMatch(message, /user:pass|token=x|private-value/);
});
