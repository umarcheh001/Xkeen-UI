(() => {
  'use strict';

  // Mihomo Import (Parser) UI
  // - Paste vless/trojan/vmess/ss/hysteria2/hy2 or https-subscription
  // - Convert to Mihomo YAML and insert into config.yaml editor

  window.XKeen = window.XKeen || {};
  XKeen.features = XKeen.features || {};

  const MI = (XKeen.features.mihomoImport = XKeen.features.mihomoImport || {});

  const IDS = {
    btnOpen: 'mihomo-import-node-btn',

    modal: 'mihomo-import-modal',
    btnClose: 'mihomo-import-close-btn',
    btnCancel: 'mihomo-import-cancel-btn',

    input: 'mihomo-import-input',
    preview: 'mihomo-import-preview',
    status: 'mihomo-import-status',
    hint: 'mihomo-import-target-hint',

    btnParse: 'mihomo-import-parse-btn',
    btnInsert: 'mihomo-import-insert-btn',
  };

  let _inited = false;
  let _lastResult = null; // { outputs: [{type, content, uri}] }
  let _previewCm = null;

  function $(id) {
    return document.getElementById(id);
  }

  function toastMsg(msg, isErr) {
    try {
      if (window.toast) window.toast(String(msg || ''), isErr ? 'error' : 'success');
      else if (window.showToast) window.showToast(String(msg || ''), !!isErr);
    } catch (e) {}
  }

  function setStatus(msg, isErr) {
    const el = $(IDS.status);
    if (!el) return;
    el.textContent = String(msg || '');
    el.classList.toggle('error', !!isErr);
  }

  function setHint(msg) {
    const el = $(IDS.hint);
    if (!el) return;
    el.textContent = String(msg || '');
  }

  function cmThemeFromPage() {
    const t = document.documentElement.getAttribute('data-theme');
    return t === 'light' ? 'default' : 'material-darker';
  }

  function ensurePreviewCm() {
    const ta = $(IDS.preview);
    if (!ta || !window.CodeMirror) return null;
    if (_previewCm) return _previewCm;

    _previewCm = CodeMirror.fromTextArea(ta, {
      mode: 'yaml',
      theme: cmThemeFromPage(),
      lineNumbers: false,
      lineWrapping: true,
      readOnly: 'nocursor',
      tabSize: 2,
      indentUnit: 2,
      viewportMargin: Infinity,
    });

    try {
      const w = _previewCm.getWrapperElement();
      w.classList.add('xkeen-cm', 'xk-mihomo-import-preview');
      // compact height like the old textarea
      _previewCm.setSize(null, '260px');
    } catch (e) {}

    return _previewCm;
  }

  function setPreview(text) {
    const v = String(text || '');
    if (_previewCm && _previewCm.setValue) {
      _previewCm.setValue(v);
      try {
        _previewCm.scrollTo(0, 0);
      } catch (e) {}
      return;
    }
    const el = $(IDS.preview);
    if (el) el.value = v;
  }

  function getEditorText() {
    try {
      if (typeof window.getMihomoEditorText === 'function') return window.getMihomoEditorText();
    } catch (e) {}
    try {
      if (window.XKeen && XKeen.features && XKeen.features.mihomoPanel && typeof XKeen.features.mihomoPanel.getEditorText === 'function') {
        return XKeen.features.mihomoPanel.getEditorText();
      }
    } catch (e2) {}
    // fallback
    const ta = $('mihomo-editor');
    return ta ? String(ta.value || '') : '';
  }

  function setEditorText(text) {
    try {
      if (typeof window.setMihomoEditorText === 'function') return window.setMihomoEditorText(text);
    } catch (e) {}
    const ta = $('mihomo-editor');
    if (ta) ta.value = String(text || '');
  }

  function refreshEditor() {
    try {
      const cm = window.XKeen && XKeen.state ? XKeen.state.mihomoEditor : null;
      if (cm && cm.refresh) cm.refresh();
    } catch (e) {}
  }

  function showModal(show) {
    const modal = $(IDS.modal);
    if (!modal) return;
    try {
      if (show) modal.classList.remove('hidden');
      else modal.classList.add('hidden');
    } catch (e) {}
    try {
      if (window.XKeen && XKeen.ui && XKeen.ui.modal && typeof XKeen.ui.modal.syncBodyScrollLock === 'function') {
        XKeen.ui.modal.syncBodyScrollLock();
      }
    } catch (e2) {}

    if (show) {
      // init preview CodeMirror only when opened (faster first paint)
      try {
        const cm = ensurePreviewCm();
        if (cm && cm.setOption) cm.setOption('theme', cmThemeFromPage());
        if (cm && cm.refresh) setTimeout(() => cm.refresh(), 0);
      } catch (e0) {}

      // reset
      _lastResult = null;
      setStatus('', false);
      setHint('');
      setPreview('');
      const ins = $(IDS.btnInsert);
      if (ins) ins.disabled = true;

      try {
        const inp = $(IDS.input);
        if (inp) inp.focus();
      } catch (e3) {}
    }
  }

  function wireButton(id, fn) {
    const el = $(id);
    if (!el) return;
    if (el.dataset && el.dataset.xkWired === '1') return;
    el.addEventListener('click', (e) => {
      e.preventDefault();
      try { fn(e); } catch (err) { console.error(err); }
    });
    if (el.dataset) el.dataset.xkWired = '1';
  }

  // ---------------------------------------------------------------------------
  // Parser (adapted from outboundParser.js) - Mihomo only
  // ---------------------------------------------------------------------------

  const safeBase64 = (str) =>
    atob(
      str
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(str.length + ((4 - (str.length % 4)) % 4), '='),
    );

  const toYaml = (obj, indent = 0) => {
    const padding = ' '.repeat(indent);
    return Object.entries(obj).reduce((result, [key, value]) => {
      if (value == null || value === '') return result;
      if (Array.isArray(value))
        return value.length
          ? result + `${padding}${key}:\n` + value.map((item) => `${padding}  - ${item}`).join('\n') + '\n'
          : result;
      if (typeof value === 'object') return result + `${padding}${key}:\n${toYaml(value, indent + 2)}`;
      return result + `${padding}${key}: ${key === 'name' ? `'${String(value).replace(/'/g, "''")}'` : value}\n`;
    }, '');
  };

  const getStreamSettings = (type, params) => {
    const number = (val) => (val ? +val : undefined);
    const bool = (val) => val === 'true' || val === true || val === '1' || undefined;
    const string = (val) => val || undefined;
    const output = {
      network: type,
      security: string(params.security),
      tlsSettings:
        params.security === 'tls'
          ? {
              fingerprint: string(params.fp) || 'chrome',
              serverName: string(params.sni),
              alpn: params.alpn?.split(','),
              allowInsecure: bool(params.allowInsecure || params.insecure),
            }
          : undefined,
      realitySettings:
        params.security === 'reality'
          ? {
              fingerprint: string(params.fp) || 'chrome',
              serverName: string(params.sni),
              publicKey: string(params.pbk),
              shortId: string(params.sid),
              spiderX: string(params.spx),
              mldsa65Verify: string(params.pqv),
            }
          : undefined,
    };

    if (type === 'tcp' && params.headerType) output.tcpSettings = { header: { type: params.headerType } };
    if (type === 'raw' && params.headerType) output.rawSettings = { header: { type: params.headerType } };

    if (type === 'grpc')
      output.grpcSettings = {
        serviceName: string(params.serviceName || params.path),
        authority: string(params.authority),
        multiMode: params.mode === 'multi',
        user_agent: string(params.user_agent),
        idle_timeout: number(params.idle_timeout),
        health_check_timeout: number(params.health_check_timeout),
        permit_without_stream: bool(params.permit_without_stream),
        initial_windows_size: number(params.initial_windows_size),
      };

    if (type === 'ws')
      output.wsSettings = {
        path: params.path || '/',
        host: string(params.host),
        heartbeatPeriod: number(params.heartbeatPeriod),
      };

    if (type === 'httpupgrade') output.httpupgradeSettings = { path: params.path || '/', host: string(params.host) };

    return output;
  };

  const parseUrl = (uri, protocol, settingsMapper) => {
    const url = new URL(uri);
    const params = Object.fromEntries(url.searchParams);

    const baseConfig = {
      tag: decodeURIComponent(url.hash.slice(1)) || 'PROXY',
      protocol: protocol,
      settings: settingsMapper(url, params),
    };

    if (!['shadowsocks', 'hysteria2'].includes(protocol)) {
      baseConfig.streamSettings = getStreamSettings(params.type || 'tcp', { ...params, sni: params.sni });
    }

    return baseConfig;
  };

  const protocols = {
    vless: (uri) =>
      parseUrl(uri, 'vless', (url, params) => ({
        address: url.hostname,
        port: +url.port || 443,
        id: url.username,
        encryption: params.encryption || 'none',
        flow: params.flow || undefined,
      })),

    trojan: (uri) =>
      parseUrl(uri, 'trojan', (url) => ({
        address: url.hostname,
        port: +url.port || 443,
        password: url.username,
      })),

    hysteria2: (uri) =>
      parseUrl(uri, 'hysteria2', (url, params) => {
        // Hysteria2 URI auth formats:
        //  - hysteria2://<auth>@host:port
        //  - hy2://username:password@host:port
        const user = decodeURIComponent(url.username || '');
        const pass = decodeURIComponent(url.password || '');
        const auth = user && pass ? `${user}:${pass}` : user;

        const alpnRaw = params.alpn || '';
        const alpn = alpnRaw ? String(alpnRaw).split(',').map((s) => s.trim()).filter(Boolean) : ['h3'];
        const obfsPassword = params['obfs-password'] || params.obfsPassword || params['obfs_password'] || undefined;

        return {
          address: url.hostname,
          port: +url.port || 443,
          password: auth,
          sni: params.sni,
          insecure: params.insecure === '1' || params.allowInsecure === '1',
          alpn,
          obfs: params.obfs || undefined,
          obfsPassword,
        };
      }),

    // aliases
    hy2: (uri) => protocols.hysteria2(uri),
    hysteria: (uri) => protocols.hysteria2(uri),

    ss: (uri) => {
      const url = new URL(uri);
      let method, password;
      if (url.username && !url.password) {
        const decoded = safeBase64(url.username).split(':');
        method = decoded[0];
        password = decoded.slice(1).join(':');
      } else {
        method = url.username;
        password = url.password;
      }
      return {
        tag: decodeURIComponent(url.hash.slice(1)) || 'PROXY',
        protocol: 'shadowsocks',
        settings: { address: url.hostname, port: +url.port, method, password },
      };
    },

    vmess: (uri) => {
      const data = JSON.parse(safeBase64(uri.slice(8)));
      if (data.tls === 'tls') {
        data.security = 'tls';
        data.sni = data.sni || data.host;
      }
      return {
        tag: data.ps || 'PROXY',
        protocol: 'vmess',
        settings: {
          address: data.add,
          port: +data.port,
          id: data.id,
          alterId: +data.aid || 0,
          security: data.scy || 'auto',
        },
        streamSettings: getStreamSettings(data.net || 'tcp', data),
      };
    },
  };

  function parseProxyUri(uri) {
    const protocolRaw = String(uri.split(':')[0] || '').toLowerCase();
    const protocol = protocolRaw === 'hy2' || protocolRaw === 'hysteria' ? 'hysteria2' : protocolRaw;
    if (!protocols[protocol]) throw new Error('Неизвестная ссылка');
    return protocols[protocol](uri);
  }

  function convertToMihomoYaml(proxyConfig) {
    const settings = proxyConfig.settings;
    const streamSettings = proxyConfig.streamSettings || {};

    const common = {
      name: proxyConfig.tag,
      type: proxyConfig.protocol,
      server: settings.address,
      port: settings.port,
      udp: true,
    };

    if (proxyConfig.protocol === 'vless') {
      Object.assign(common, { uuid: settings.id, flow: settings.flow, 'packet-encoding': 'xudp' });
      if (settings.encryption) common.encryption = settings.encryption;
    } else if (proxyConfig.protocol === 'vmess') {
      Object.assign(common, { uuid: settings.id, alterId: settings.alterId, cipher: settings.security });
    } else if (proxyConfig.protocol === 'trojan') {
      common.password = settings.password;
    } else if (proxyConfig.protocol === 'hysteria2') {
      // Hysteria2 (hy2://, hysteria2://)
      common.password = settings.password;
      common['fast-open'] = true;
      if (settings.sni) common.sni = settings.sni;
      if (settings.insecure) common['skip-cert-verify'] = true;
      if (settings.alpn && settings.alpn.length) common.alpn = settings.alpn;
      if (settings.obfs) common.obfs = settings.obfs;
      if (settings.obfsPassword) common['obfs-password'] = settings.obfsPassword;
    } else if (proxyConfig.protocol === 'shadowsocks') {
      Object.assign(common, { cipher: settings.method, password: settings.password });
    }

    if (streamSettings.network) common.network = streamSettings.network;

    if (['tls', 'reality'].includes(streamSettings.security)) {
      const tls = streamSettings.tlsSettings || {};
      const reality = streamSettings.realitySettings || {};
      const serverName = tls.serverName || reality.serverName;

      Object.assign(common, {
        tls: true,
        tfo: true,
        'client-fingerprint': tls.fingerprint || reality.fingerprint,
        alpn: tls.alpn,
      });

      if (['trojan', 'hysteria2'].includes(proxyConfig.protocol)) {
        if (serverName) common.sni = serverName;
      } else {
        if (serverName) common.servername = serverName;
      }

      if (tls.allowInsecure) common['skip-cert-verify'] = true;

      if (streamSettings.security === 'reality') {
        common['reality-opts'] = {
          'public-key': reality.publicKey,
          'short-id': reality.shortId,
          'support-x25519mlkem768': true,
        };
      }
    }

    if (streamSettings.network === 'ws') {
      common['ws-opts'] = {
        path: streamSettings.wsSettings?.path,
        headers: streamSettings.wsSettings?.host ? { Host: streamSettings.wsSettings.host } : undefined,
      };
    } else if (streamSettings.network === 'grpc') {
      common['grpc-opts'] = { 'grpc-service-name': streamSettings.grpcSettings?.serviceName };
    } else if (streamSettings.network === 'httpupgrade') {
      common['http-upgrade-opts'] = {
        path: streamSettings.httpupgradeSettings?.path,
        headers: streamSettings.httpupgradeSettings?.host ? { Host: streamSettings.httpupgradeSettings.host } : undefined,
      };
    }

    return `  - ${toYaml(common).trim().replace(/\n/g, '\n    ')}`;
  }

  function generateConfigForMihomo(uri, existingConfig = '') {
    const generateName = (base) => {
      let index = 1;
      while (existingConfig.includes(`${base}_${index}`)) index++;
      return `${base}_${index}`;
    };

    if (uri.startsWith('http')) {
      const name = generateName('subscription');
      return {
        type: 'proxy-provider',
        content: toYaml(
          {
            [name]: {
              type: 'http',
              url: uri,
              interval: 43200,
              'health-check': {
                enable: true,
                url: 'https://www.gstatic.com/generate_204',
                interval: 300,
                'expected-status': 204,
              },
              override: { udp: true, tfo: true },
            },
          },
          2,
        ),
      };
    }

    if (uri.includes('type=xhttp')) throw new Error('XHTTP в Mihomo не поддерживается');

    const config = parseProxyUri(uri);
    if (config.tag === 'PROXY' || existingConfig.includes(config.tag)) config.tag = generateName(config.protocol);

    return { type: 'proxy', content: convertToMihomoYaml(config) + '\n' };
  }

  // ---------------------------------------------------------------------------
  // YAML insertion helpers
  // ---------------------------------------------------------------------------

  function ensureNewline(s) {
    const t = String(s || '');
    return t.endsWith('\n') ? t : t + '\n';
  }

  function findSectionBlock(text, key) {
    const src = String(text || '');

    // Match top-level key (column 0). If user indented the whole file, we still try.
    const re = new RegExp(`^(?:${escapeRegExp(key)})\\s*:\\s*(.*)$`, 'm');
    const m = re.exec(src);
    if (!m) return null;

    const lineStart = m.index;
    const lineEnd = src.indexOf('\n', lineStart);
    const afterLine = lineEnd === -1 ? src.length : lineEnd + 1;

    // Find next top-level key (starts in column 0, not comment)
    const rest = src.slice(afterLine);
    const next = /^(?!\s)(?!#)([A-Za-z0-9_.-]+)\s*:/m.exec(rest);
    const bodyEnd = next ? afterLine + next.index : src.length;

    // If section is inline like `proxies: []` or `proxy-providers: {}`
    const inlineTail = String(m[1] || '').trim();

    return {
      headerStart: lineStart,
      headerEnd: afterLine,
      bodyStart: afterLine,
      bodyEnd,
      inlineTail,
    };
  }

  function escapeRegExp(s) {
    return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function normalizeInlineSection(text, key) {
    const src = String(text || '');
    const re = new RegExp(`^(${escapeRegExp(key)}\\s*:)\\s*(\[\]|\{\}|null|~)?\\s*(#.*)?$`, 'm');
    const m = re.exec(src);
    if (!m) return src;

    // Convert to block style: keep comment
    const comment = m[3] ? ' ' + m[3].trim() : '';
    const repl = `${key}:${comment}`;
    return src.replace(re, repl);
  }

  function insertIntoSection(text, key, snippet) {
    let src = ensureNewline(String(text || ''));
    src = normalizeInlineSection(src, key);

    const sec = findSectionBlock(src, key);
    const sn = ensureNewline(String(snippet || '')).trimEnd() + '\n';

    if (!sec) {
      // Append new section at the end
      const sep = src.trimEnd().length ? '\n' : '';
      return src.trimEnd() + sep + `${key}:\n` + sn;
    }

    // Ensure header is block-style
    // (If inlineTail is not empty and not a comment, we keep it but insertion will still work)

    const before = src.slice(0, sec.bodyEnd);
    const after = src.slice(sec.bodyEnd);

    // Insert at end of section body, keep one blank line between blocks
    let mid = before;
    if (!mid.endsWith('\n')) mid += '\n';

    // Avoid duplicates (best-effort): if snippet already present, return original
    if (src.includes(sn.trim())) return src;

    // If section body ends with newline, just append.
    // Add a blank line if body is not empty and doesn't already end with one.
    const body = src.slice(sec.bodyStart, sec.bodyEnd);
    const hasBodyContent = body.trim().length > 0;
    if (hasBodyContent && !body.endsWith('\n\n')) {
      // ensure exactly one newline before snippet (so list/map stays compact)
      if (!mid.endsWith('\n')) mid += '\n';
    }

    mid += sn;

    return mid + after;
  }

  function insertOutputsIntoConfig(existingText, outputs) {
    let txt = String(existingText || '');

    // Insert providers first (so groups can reference them later if needed)
    const providers = outputs.filter((o) => o.type === 'proxy-provider');
    const proxies = outputs.filter((o) => o.type === 'proxy');

    providers.forEach((o) => {
      txt = insertIntoSection(txt, 'proxy-providers', o.content);
    });

    proxies.forEach((o) => {
      txt = insertIntoSection(txt, 'proxies', o.content);
    });

    return txt;
  }

  // ---------------------------------------------------------------------------
  // UI Actions
  // ---------------------------------------------------------------------------

  function parseInput() {
    const inp = $(IDS.input);
    const uriRaw = inp ? String(inp.value || '') : '';

    const lines = uriRaw
      .split(/\r?\n/)
      .map((s) => String(s || '').trim())
      .filter(Boolean);

    if (!lines.length) {
      setStatus('Вставь ссылку узла или https-подписку.', true);
      setHint('');
      setPreview('');
      const ins = $(IDS.btnInsert);
      if (ins) ins.disabled = true;
      return;
    }

    const existing = getEditorText() || '';
    let tmp = existing;

    const outputs = [];
    const errors = [];

    for (const line of lines) {
      try {
        const out = generateConfigForMihomo(line, tmp);
        outputs.push({ ...out, uri: line });
        // update tmp so name generation stays unique across multiple lines
        tmp += '\n' + out.content;
      } catch (e) {
        errors.push(`${line}: ${e && e.message ? e.message : 'ошибка'}`);
      }
    }

    if (!outputs.length) {
      setStatus(errors.join('\n') || 'Не удалось распознать ссылку.', true);
      setHint('');
      setPreview('');
      const ins = $(IDS.btnInsert);
      if (ins) ins.disabled = true;
      return;
    }

    _lastResult = { outputs };

    // Build preview
    const preview = outputs
      .map((o) => {
        if (o.type === 'proxy-provider') {
          return `# proxy-providers\n${o.content.trimEnd()}`;
        }
        return `# proxies\n${o.content.trimEnd()}`;
      })
      .join('\n\n');

    setPreview(preview + '\n');

    const targets = Array.from(new Set(outputs.map((o) => (o.type === 'proxy-provider' ? 'proxy-providers' : 'proxies'))));
    setHint('Будет добавлено в секцию: ' + targets.join(' + '));

    if (errors.length) {
      setStatus('Часть ссылок распознана, часть — нет. Проверь строки ниже в preview.', true);
      // Append errors into preview as comments
      setPreview(preview + '\n\n# Ошибки\n' + errors.map((x) => '# ' + x).join('\n') + '\n');
    } else {
      setStatus('Готово. Нажми «Вставить в конфиг».', false);
    }

    const ins = $(IDS.btnInsert);
    if (ins) ins.disabled = false;
  }

  function insertIntoEditor() {
    if (!_lastResult || !_lastResult.outputs || !_lastResult.outputs.length) {
      setStatus('Сначала нажми «Преобразовать».', true);
      return;
    }

    const existing = getEditorText() || '';
    const next = insertOutputsIntoConfig(existing, _lastResult.outputs);

    setEditorText(next);
    refreshEditor();

    showModal(false);
    toastMsg('Добавлено в config.yaml ✅', false);

    try {
      // mark last activity badge
      if (typeof window.updateLastActivity === 'function') {
        const fp = window.XKEEN_FILES && window.XKEEN_FILES.mihomo ? window.XKEEN_FILES.mihomo : '/opt/etc/mihomo/config.yaml';
        window.updateLastActivity('modified', 'mihomo', fp);
      }
    } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  MI.init = function init() {
    const openBtn = $(IDS.btnOpen);
    const modal = $(IDS.modal);
    if (!openBtn || !modal) return;

    if (_inited || (modal.dataset && modal.dataset.xkMihomoImportInited === '1')) return;
    _inited = true;
    if (modal.dataset) modal.dataset.xkMihomoImportInited = '1';

    wireButton(IDS.btnOpen, () => showModal(true));
    wireButton(IDS.btnClose, () => showModal(false));
    wireButton(IDS.btnCancel, () => showModal(false));

    wireButton(IDS.btnParse, () => parseInput());
    wireButton(IDS.btnInsert, () => insertIntoEditor());

    // Close on backdrop click (outside content)
    if (!modal.dataset || modal.dataset.xkBackdrop !== '1') {
      modal.addEventListener('click', (e) => {
        try {
          const content = modal.querySelector('.modal-content');
          if (!content) return;
          if (e.target === modal) showModal(false);
        } catch (err) {}
      });
      if (modal.dataset) modal.dataset.xkBackdrop = '1';
    }

    // Ctrl+Enter = parse, Ctrl+Shift+Enter = insert
    const inp = $(IDS.input);
    if (inp && (!inp.dataset || inp.dataset.xkKeys !== '1')) {
      inp.addEventListener('keydown', (e) => {
        try {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            if (e.shiftKey) insertIntoEditor();
            else parseInput();
          }
        } catch (err) {}
      });
      if (inp.dataset) inp.dataset.xkKeys = '1';
    }
  };
})();
