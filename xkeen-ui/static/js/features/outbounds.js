(() => {
  window.XKeen = window.XKeen || {};
  XKeen.state = XKeen.state || {};
  XKeen.features = XKeen.features || {};

  // Outbounds editor for 04_outbounds.json (VLESS URL helper)
  // API:
  //  - GET  /api/outbounds  -> { url: "vless://..." } or {}
  //  - POST /api/outbounds  -> { ok:true, restarted?:bool }
  //
  // This module owns:
  //  - wiring of UI buttons + collapse state
  //  - load/save calls
  //  - backup button call (/api/backup-outbounds)

  XKeen.features.outbounds = (() => {
    let inited = false;

    function $(id) {
      return document.getElementById(id);
    }

    function wireButton(btnId, handler) {
      const btn = $(btnId);
      if (!btn) return;
      if (btn.dataset && btn.dataset.xkeenWired === '1') return;

      btn.addEventListener('click', (e) => {
        e.preventDefault();
        handler();
      });

      if (btn.dataset) btn.dataset.xkeenWired = '1';
    }

    function wireHeader(headerId, handler) {
      const header = $(headerId);
      if (!header) return;
      if (header.dataset && header.dataset.xkeenWiredHeader === '1') return;

      header.addEventListener('click', (e) => {
        const target = e.target;
        if (target && (target.closest && target.closest('button, a, input, label, select, textarea'))) return;
        e.preventDefault();
        handler();
      });

      if (header.dataset) header.dataset.xkeenWiredHeader = '1';
    }

    function shouldRestartAfterSave() {
      // Global toggle on panel.html; absent on dedicated pages => default true
      const cb = $('global-autorestart-xkeen');
      if (!cb) return true;
      return !!cb.checked;
    }

    /* Outbounds: URL hints (dropdown protocol/type/security)
     * These dropdowns do NOT replace the generator, they only help avoid mistakes when pasting links.
     * We auto-detect current scheme and update dropdowns; and if user changes type/security for vless/trojan,
     * we gently apply params back to the URL (only type/security).
     */

    function detectScheme(url) {
      const s = String(url || '').trim();
      const m = s.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//);
      return m ? m[1].toLowerCase() : '';
    }

    function safeB64Decode(str) {
      // Decode URL-safe base64 into a UTF-8 string.
      // Works better for vmess:// with non-ascii tags.
      try {
        let s = String(str || '').trim().replace(/-/g, '+').replace(/_/g, '/');
        s = s.padEnd(s.length + ((4 - (s.length % 4)) % 4), '=');
        const bin = atob(s);
        // If TextDecoder exists, treat as UTF-8 bytes.
        if (typeof TextDecoder !== 'undefined') {
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        }
        return bin;
      } catch (e) {
        return '';
      }
    }

    function safeB64Encode(str) {
      // Encode UTF-8 string into URL-safe base64 without padding.
      try {
        let bin = '';
        if (typeof TextEncoder !== 'undefined') {
          const bytes = new TextEncoder().encode(String(str || ''));
          // bytes length is small (vmess json), safe to concat
          for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        } else {
          bin = String(str || '');
        }
        return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
      } catch (e) {
        return '';
      }
    }

    function escapeHtml(s) {
      return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function isValidPort(p) {
      const n = Number(p);
      return Number.isFinite(n) && n > 0 && n <= 65535;
    }

    function looksLikeUuid(s) {
      const v = String(s || '').trim();
      if (!v) return false;
      const re1 = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
      const re2 = /^[0-9a-fA-F]{32}$/;
      return re1.test(v) || re2.test(v);
    }

    function maskSecret(s) {
      const v = String(s || '');
      if (!v) return '';
      if (v.length <= 6) return '***';
      return v.slice(0, 3) + '***' + v.slice(-3);
    }

    // ---------- Client-side parse/validation + preview ----------

    function parseSS(url) {
      const out = {
        ok: false,
        scheme: 'ss',
        fields: {},
        errors: [],
        warnings: [],
        type: 'tcp',
        security: 'none'
      };

      let s = String(url || '').trim();
      if (!s.toLowerCase().startsWith('ss://')) {
        out.errors.push('Ожидается ссылка ss://');
        return out;
      }

      // Split fragment/tag
      let tag = '';
      const hashIdx = s.indexOf('#');
      if (hashIdx >= 0) {
        tag = s.slice(hashIdx + 1);
        s = s.slice(0, hashIdx);
        try { tag = decodeURIComponent(tag); } catch (e) {}
      }

      // Split query
      let query = '';
      const qIdx = s.indexOf('?');
      if (qIdx >= 0) {
        query = s.slice(qIdx + 1);
        s = s.slice(0, qIdx);
      }

      const plugin = (() => {
        if (!query) return '';
        try {
          const qs = new URLSearchParams(query);
          return qs.get('plugin') || '';
        } catch (e) {
          return '';
        }
      })();

      let rest = s.slice(5); // after ss://
      if (!rest) {
        out.errors.push('Пустая ссылка ss://');
        return out;
      }

      // Try to obtain "userinfo@host:port"
      let userinfo = '';
      let hostport = '';

      if (rest.includes('@')) {
        const parts = rest.split('@');
        userinfo = parts[0] || '';
        hostport = parts.slice(1).join('@');
      } else {
        const decoded = safeB64Decode(rest);
        if (decoded && decoded.includes('@')) {
          const parts = decoded.split('@');
          userinfo = parts[0] || '';
          hostport = parts.slice(1).join('@');
        } else if (decoded && decoded.includes(':') && decoded.match(/:\d+$/)) {
          // Sometimes the whole payload decodes to method:pass@host:port or method:pass:host:port (rare)
          // Keep as-is and fall-through
          rest = decoded;
        }
      }

      // If still no hostport, maybe the decoded payload already contains both parts
      if (!hostport && rest.includes('@')) {
        const parts = rest.split('@');
        userinfo = parts[0] || '';
        hostport = parts.slice(1).join('@');
      }

      // Decode userinfo if needed
      let creds = String(userinfo || '');
      if (creds && !creds.includes(':')) {
        const dec = safeB64Decode(creds);
        if (dec && dec.includes(':')) creds = dec;
      }

      // If creds still contain host:port inside (full base64 form)
      if (creds && creds.includes('@') && !hostport) {
        const parts = creds.split('@');
        creds = parts[0] || '';
        hostport = parts.slice(1).join('@');
      }

      let method = '';
      let password = '';
      if (creds && creds.includes(':')) {
        const idx = creds.indexOf(':');
        method = creds.slice(0, idx);
        password = creds.slice(idx + 1);
      }

      // Parse host:port (IPv6-friendly)
      let host = '';
      let port = '';
      const hp = String(hostport || '').trim();
      if (hp.startsWith('[')) {
        const m = hp.match(/^\[([^\]]+)\]:(\d+)$/);
        if (m) {
          host = m[1];
          port = m[2];
        }
      } else {
        const idx = hp.lastIndexOf(':');
        if (idx > 0) {
          host = hp.slice(0, idx);
          port = hp.slice(idx + 1);
        }
      }

      if (!method) out.errors.push('Не удалось распознать метод (cipher) для ss://');
      if (!password) out.errors.push('Не удалось распознать пароль для ss://');
      if (!host) out.errors.push('Не удалось распознать host для ss://');
      if (!port || !isValidPort(port)) out.errors.push('Не удалось распознать корректный порт для ss://');

      out.fields['Protocol'] = 'ss';
      if (tag) out.fields['Tag'] = tag;
      if (host) out.fields['Server'] = host;
      if (port) out.fields['Port'] = port;
      if (method) out.fields['Cipher'] = method;
      if (plugin) out.fields['Plugin'] = plugin;

      out.ok = out.errors.length === 0;
      return out;
    }

    function parseHY2(url) {
      const out = {
        ok: false,
        scheme: 'hy2',
        fields: {},
        errors: [],
        warnings: [],
        type: 'hysteria',
        security: 'tls'
      };

      const s0 = String(url || '').trim();
      const scheme = detectScheme(s0);
      if (!(scheme === 'hy2' || scheme === 'hysteria2' || scheme === 'hysteria')) {
        out.errors.push('Ожидается ссылка hy2://');
        return out;
      }

      let u;
      try {
        u = new URL(s0);
      } catch (e) {
        out.errors.push('Некорректная ссылка HY2: не удалось распарсить URL');
        return out;
      }

      const host = (u.hostname || '').trim();
      const port = String(u.port || '').trim();
      const user = (u.username || '').trim();
      const pass = (u.password || '').trim();
      const auth = (user || pass) ? (user + (pass ? ':' + pass : '')) : '';

      if (!host) out.errors.push('Не указан host');
      if (port && !isValidPort(port)) out.errors.push('Некорректный port');
      if (!auth) out.errors.push('Не указан auth (username/password)');

      // basic params
      const qs = u.searchParams;
      const sni = (qs.get('sni') || '').trim();
      const insecure = (qs.get('insecure') || qs.get('allowInsecure') || '').trim();
      const obfs = (qs.get('obfs') || '').trim();
      const obfsPwd = (qs.get('obfs-password') || qs.get('obfs_password') || '').trim();
      const pin = (qs.get('pinSHA256') || '').trim();

      out.fields['Host'] = host;
      if (port) out.fields['Port'] = port;
      if (auth) out.fields['Auth'] = maskSecret(auth);
      if (sni) out.fields['SNI'] = sni;
      if (insecure) out.fields['Insecure'] = insecure;
      if (obfs) out.fields['Obfs'] = obfs;
      if (obfsPwd) out.fields['Obfs Password'] = maskSecret(obfsPwd);
      if (pin) out.fields['PinSHA256'] = pin;

      if (obfs && obfs.toLowerCase() !== 'salamander') {
        out.warnings.push('Obfs кроме salamander сейчас может не поддерживаться ядром Xray');
      }

      // pinSHA256 поддерживается: будет добавлен в Xray-конфиг как
      // tlsSettings.pinnedPeerCertificateChainSha256

      out.ok = out.errors.length === 0;
      return out;
    }

    function parseVMess(url) {
      const out = {
        ok: false,
        scheme: 'vmess',
        fields: {},
        errors: [],
        warnings: [],
        type: 'tcp',
        security: 'none'
      };

      const s = String(url || '').trim();
      if (!s.toLowerCase().startsWith('vmess://')) {
        out.errors.push('Ожидается ссылка vmess://');
        return out;
      }

      const payload = s.slice(8);
      if (!payload) {
        out.errors.push('Пустая ссылка vmess://');
        return out;
      }

      const decoded = safeB64Decode(payload);
      if (!decoded) {
        out.errors.push('Не удалось декодировать base64 для vmess://');
        return out;
      }

      let data = null;
      try {
        data = JSON.parse(decoded);
      } catch (e) {
        out.errors.push('vmess:// не похож на JSON (base64)');
        return out;
      }

      const host = (data.add || '').toString();
      const port = (data.port || '').toString();
      const uuid = (data.id || '').toString();
      const ps = (data.ps || '').toString();
      const net = (data.net || 'tcp').toString().toLowerCase();
      const tls = (data.tls || '').toString().toLowerCase();
      const sni = (data.sni || data.host || '').toString();

      out.type = net || 'tcp';
      out.security = (tls === 'tls') ? 'tls' : 'none';

      if (!host) out.errors.push('vmess://: отсутствует add (host)');
      if (!port || !isValidPort(port)) out.errors.push('vmess://: некорректный port');
      if (!uuid) out.errors.push('vmess://: отсутствует id (UUID)');
      if (uuid && !looksLikeUuid(uuid)) out.warnings.push('vmess://: id не похож на UUID');

      out.fields['Protocol'] = 'vmess';
      if (ps) out.fields['Tag'] = ps;
      if (host) out.fields['Server'] = host;
      if (port) out.fields['Port'] = port;
      if (uuid) out.fields['UUID'] = uuid;
      out.fields['Transport'] = out.type;
      out.fields['Security'] = out.security;
      if (sni) out.fields['SNI/Host'] = sni;
      if (data.path) out.fields['Path'] = data.path;
      if (data.host && net === 'ws') out.fields['WS Host'] = data.host;
      if (data.scy) out.fields['Cipher'] = data.scy;
      if (data.alpn) out.fields['ALPN'] = data.alpn;
      if (data.fp) out.fields['FP'] = data.fp;

      out.ok = out.errors.length === 0;
      return out;
    }

    function parseVlessOrTrojan(url, scheme) {
      const out = {
        ok: false,
        scheme,
        fields: {},
        errors: [],
        warnings: [],
        type: 'tcp',
        security: 'auto'
      };

      let u;
      try {
        u = new URL(url);
      } catch (e) {
        out.errors.push('Ссылка не похожа на корректный URL');
        return out;
      }

      const user = (u.username || '').toString();
      const host = (u.hostname || '').toString();
      const port = (u.port || '').toString();
      const tag = (u.hash || '').replace(/^#/, '');

      const type = (u.searchParams.get('type') || u.searchParams.get('net') || 'tcp').toLowerCase();
      const secRaw = (u.searchParams.get('security') || '').toLowerCase();
      // For UI we treat VLESS as reality by default, Trojan as TLS by default
      const security = secRaw || (scheme === 'trojan' ? 'tls' : 'reality');

      const sni = (u.searchParams.get('sni') || u.searchParams.get('serverName') || '').toString();
      const fp = (u.searchParams.get('fp') || '').toString();
      const alpn = (u.searchParams.get('alpn') || '').toString();
      const flow = (u.searchParams.get('flow') || '').toString();
      const pbk = (u.searchParams.get('pbk') || u.searchParams.get('publicKey') || '').toString();
      const sid = (u.searchParams.get('sid') || u.searchParams.get('shortId') || '').toString();

      const path = (u.searchParams.get('path') || '').toString();
      const wsHost = (u.searchParams.get('host') || '').toString();
      const serviceName = (u.searchParams.get('serviceName') || '').toString();
      const authority = (u.searchParams.get('authority') || '').toString();
      const mode = (u.searchParams.get('mode') || '').toString();

      out.type = type || 'tcp';
      out.security = security || 'auto';

      if (!host) out.errors.push('Отсутствует host');
      if (!port || !isValidPort(port)) out.errors.push('Некорректный порт');

      if (!user) out.errors.push(scheme === 'vless' ? 'Отсутствует UUID' : 'Отсутствует пароль');

      if (scheme === 'vless' && user && !looksLikeUuid(user)) {
        out.warnings.push('UUID не похож на UUID (проверь ссылку)');
      }

      if (out.security === 'reality') {
        if (!pbk) out.errors.push('Reality: отсутствует pbk (publicKey)');
        if (!sid) out.warnings.push('Reality: желательно указать sid (shortId)');
        if (!sni) out.warnings.push('Reality: желательно указать sni/serverName');
      }

      if (out.type === 'ws' || out.type === 'httpupgrade') {
        if (!path) out.warnings.push('Для WS/HTTP Upgrade обычно нужен параметр path');
      }

      if (out.type === 'grpc') {
        if (!serviceName) out.warnings.push('Для gRPC обычно нужен serviceName');
      }

      out.fields['Protocol'] = scheme;
      if (tag) out.fields['Tag'] = (() => { try { return decodeURIComponent(tag); } catch (e) { return tag; } })();
      if (host) out.fields['Server'] = host;
      if (port) out.fields['Port'] = port;
      if (scheme === 'vless' && user) out.fields['UUID'] = user;
      if (scheme === 'trojan' && user) out.fields['Password'] = maskSecret(user);
      out.fields['Transport'] = out.type;
      out.fields['Security'] = out.security;
      if (sni) out.fields['SNI'] = sni;
      if (flow) out.fields['Flow'] = flow;
      if (alpn) out.fields['ALPN'] = alpn;
      if (fp) out.fields['FP'] = fp;
      if (pbk) out.fields['PBK'] = pbk;
      if (sid) out.fields['SID'] = sid;
      if (path) out.fields['Path'] = path;
      if (wsHost) out.fields[(out.type === 'ws' ? 'WS Host' : 'Host')] = wsHost;
      if (serviceName) out.fields['ServiceName'] = serviceName;
      if (authority) out.fields['Authority'] = authority;
      if (mode) out.fields['Mode'] = mode;

      out.ok = out.errors.length === 0;
      return out;
    }

    function parseProxyUrl(url) {
      const s = String(url || '').trim();
      const scheme = detectScheme(s);
      if (!s) {
        return { ok: false, scheme: '', fields: {}, errors: [], warnings: [] };
      }
      if (scheme === 'vless') return parseVlessOrTrojan(s, 'vless');
      if (scheme === 'trojan') return parseVlessOrTrojan(s, 'trojan');
      if (scheme === 'vmess') return parseVMess(s);
      if (scheme === 'ss') return parseSS(s);
      if (scheme === 'hy2' || scheme === 'hysteria2' || scheme === 'hysteria') return parseHY2(s);
      return {
        ok: false,
        scheme: scheme || '',
        fields: {},
        errors: ['Поддерживаются только vless://, trojan://, vmess://, ss:// или hy2://'],
        warnings: []
      };
    }

    function renderParsePreview(parsed) {
      const box = $('outbounds-parse-box');
      const kv = $('outbounds-parse-kv');
      const err = $('outbounds-parse-error');
      const warn = $('outbounds-parse-warn');

      const badgeProto = $('outbounds-badge-proto');
      const badgeType = $('outbounds-badge-type');
      const badgeSec = $('outbounds-badge-sec');
      const badgeOk = $('outbounds-badge-state');
      const badgeBad = $('outbounds-badge-state-bad');

      if (!box || !kv || !err || !warn || !badgeProto || !badgeType || !badgeSec || !badgeOk || !badgeBad) return;

      const hasAny = parsed && (parsed.scheme || (parsed.fields && Object.keys(parsed.fields).length) || (parsed.errors && parsed.errors.length) || (parsed.warnings && parsed.warnings.length));
      box.style.display = hasAny ? 'block' : 'none';

      badgeProto.textContent = parsed.scheme ? parsed.scheme.toUpperCase() : '—';
      badgeType.textContent = parsed.type ? String(parsed.type).toUpperCase() : '—';
      badgeSec.textContent = parsed.security ? String(parsed.security).toUpperCase() : '—';

      badgeOk.style.display = parsed.ok ? 'inline-flex' : 'none';
      badgeBad.style.display = parsed.ok ? 'none' : 'inline-flex';

      // errors / warnings
      if (parsed.errors && parsed.errors.length) {
        err.style.display = 'block';
        err.innerHTML = '❌ ' + parsed.errors.map(escapeHtml).join('<br>');
      } else {
        err.style.display = 'none';
        err.textContent = '';
      }

      if (parsed.warnings && parsed.warnings.length) {
        warn.style.display = 'block';
        warn.innerHTML = '⚠️ ' + parsed.warnings.map(escapeHtml).join('<br>');
      } else {
        warn.style.display = 'none';
        warn.textContent = '';
      }

      // KV preview
      const rows = [];
      const fields = parsed.fields || {};
      for (const k of Object.keys(fields)) {
        const v = fields[k];
        if (v === undefined || v === null || String(v).trim() === '') continue;
        rows.push(
          `<div class="outbounds-kv-row"><div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(v)}</div></div>`
        );
      }
      kv.innerHTML = rows.join('');
    }

    function validateAndUpdateUI() {
      const input = $('outbounds-url');
      const saveBtn = $('outbounds-save-btn');
      if (!input) return;

      const url = String(input.value || '').trim();
      if (!url) {
        if (saveBtn) saveBtn.disabled = false;
        input.classList.remove('xk-invalid');
        renderParsePreview({ ok: false, scheme: '', fields: {}, errors: [], warnings: [] });
        return;
      }

      const parsed = parseProxyUrl(url);
      // persist for save()
      try { XKeen.state.outboundsParse = parsed; } catch (e) {}

      renderParsePreview(parsed);

      if (parsed.ok) {
        input.classList.remove('xk-invalid');
        if (saveBtn) saveBtn.disabled = false;
      } else {
        input.classList.add('xk-invalid');
        if (saveBtn) saveBtn.disabled = true;
      }
    }

    function setSelectValue(el, value) {
      if (!el) return;
      const opts = Array.from(el.options || []);
      const exists = opts.some(o => String(o.value) === String(value));
      if (exists) el.value = value;
    }

    function setHintsEnabled(scheme) {
      const typeSel = $('outbounds-type');
      const secSel = $('outbounds-security');
      // Для vmess/ss мы не переписываем URL, но подсказки оставляем как readonly.
      const readonly = (scheme === 'vmess' || scheme === 'ss' || scheme === 'hy2' || scheme === 'hysteria2' || scheme === 'hysteria' || scheme === '');
      if (typeSel) typeSel.disabled = readonly;
      if (secSel) secSel.disabled = readonly;
    }

    function updateHintsFromUrl(url) {
      const input = $('outbounds-url');
      const protoSel = $('outbounds-proto');
      const typeSel = $('outbounds-type');
      const secSel = $('outbounds-security');
      if (!input || !protoSel || !typeSel || !secSel) return;

      const s = String(url || '').trim();
      if (!s) {
        setSelectValue(protoSel, 'auto');
        setSelectValue(typeSel, 'auto');
        setSelectValue(secSel, 'auto');
        setHintsEnabled('');
        return;
      }

      const scheme = detectScheme(s);
      setHintsEnabled(scheme);

      if (protoSel && protoSel.value === 'auto') {
        if (['vless', 'trojan', 'vmess', 'ss', 'hy2', 'hysteria2', 'hysteria'].includes(scheme)) {
          // для удобства приводим hysteria2/hysteria к hy2
          const v = (scheme === 'hysteria2' || scheme === 'hysteria') ? 'hy2' : scheme;
          setSelectValue(protoSel, v);
        }
      }

      if (scheme === 'vless' || scheme === 'trojan') {
        try {
          const u = new URL(s);
          const type = (u.searchParams.get('type') || u.searchParams.get('net') || 'tcp').toLowerCase();
          const security = (u.searchParams.get('security') || (scheme === 'vless' ? 'reality' : 'tls')).toLowerCase();
          if (typeSel.value === 'auto') setSelectValue(typeSel, type);
          if (secSel.value === 'auto') setSelectValue(secSel, security);
          return;
        } catch (e) {}
      }

      if (scheme === 'vmess') {
        try {
          const raw = safeB64Decode(s.slice(8));
          const data = JSON.parse(raw || '{}');
          const type = (data.net || 'tcp').toLowerCase();
          const security = (data.tls === 'tls') ? 'tls' : ((data.security || 'none') + '').toLowerCase();
          if (typeSel.value === 'auto') setSelectValue(typeSel, type);
          if (secSel.value === 'auto') setSelectValue(secSel, security);
        } catch (e) {}
      }
    }

    function applyHintsToUrl() {
      const input = $('outbounds-url');
      const typeSel = $('outbounds-type');
      const secSel = $('outbounds-security');
      if (!input || !typeSel || !secSel) return;

      const url = String(input.value || '').trim();
      const scheme = detectScheme(url);
      if (!url || !(scheme === 'vless' || scheme === 'trojan')) return;

      try {
        const u = new URL(url);
        const typeVal = String(typeSel.value || 'auto').toLowerCase();
        const secVal = String(secSel.value || 'auto').toLowerCase();

        if (typeVal !== 'auto') {
          if (typeVal === 'tcp') u.searchParams.delete('type');
          else u.searchParams.set('type', typeVal);
        }

        if (secVal !== 'auto') {
          if (secVal === 'none') u.searchParams.delete('security');
          else u.searchParams.set('security', secVal);
        }

        const t = (u.searchParams.get('type') || 'tcp').toLowerCase();
        if (t === 'ws' && !u.searchParams.get('path')) u.searchParams.set('path', '/');
        if (t === 'httpupgrade' && !u.searchParams.get('path')) u.searchParams.set('path', '/');

        input.value = u.toString();
      } catch (e) {}
    }

    // ---------- Normalization helpers (make the pasted link neat + add safe defaults) ----------

    function reorderSearchParams(u, preferredKeys) {
      try {
        const cur = u.searchParams;
        const all = [];
        for (const [k, v] of cur.entries()) all.push([k, v]);

        const taken = new Set();
        const next = new URLSearchParams();

        // 1) preferred keys in order
        for (const k of (preferredKeys || [])) {
          for (const [kk, vv] of all) {
            if (kk === k && !taken.has(kk + '\u0000' + vv)) {
              next.append(kk, vv);
              taken.add(kk + '\u0000' + vv);
            }
          }
        }

        // 2) remaining keys alphabetically
        const rest = all.filter(([kk, vv]) => !taken.has(kk + '\u0000' + vv));
        rest.sort((a, b) => (a[0] === b[0] ? (a[1] > b[1] ? 1 : -1) : (a[0] > b[0] ? 1 : -1)));
        for (const [kk, vv] of rest) next.append(kk, vv);

        u.search = next.toString();
      } catch (e) {}
    }

    function normalizePath(p) {
      let v = String(p || '').trim();
      if (!v) return '/';
      if (!v.startsWith('/')) v = '/' + v;
      return v;
    }

    function normalizeVlessTrojan(url, scheme, typeHint, secHint) {
      let u;
      try {
        u = new URL(String(url || '').trim());
      } catch (e) {
        return '';
      }

      // Port default
      if (!u.port) u.port = '443';

      // Type/security
      const typeRaw = (u.searchParams.get('type') || u.searchParams.get('net') || typeHint || 'tcp').toLowerCase();
      const secRaw = (u.searchParams.get('security') || secHint || (scheme === 'trojan' ? 'tls' : 'reality')).toLowerCase();
      const type = (!typeRaw || typeRaw === 'auto') ? 'tcp' : typeRaw;
      const security = (!secRaw || secRaw === 'auto') ? (scheme === 'trojan' ? 'tls' : 'reality') : secRaw;

      // Prefer canonical keys
      if (!u.searchParams.get('pbk') && u.searchParams.get('publicKey')) u.searchParams.set('pbk', u.searchParams.get('publicKey') || '');
      if (!u.searchParams.get('sid') && u.searchParams.get('shortId')) u.searchParams.set('sid', u.searchParams.get('shortId') || '');
      if (!u.searchParams.get('sni') && u.searchParams.get('serverName')) u.searchParams.set('sni', u.searchParams.get('serverName') || '');

      u.searchParams.delete('publicKey');
      u.searchParams.delete('shortId');
      u.searchParams.delete('serverName');
      u.searchParams.delete('net');

      // Write type/security
      if (type === 'tcp') u.searchParams.delete('type');
      else u.searchParams.set('type', type);

      if (security === 'none') u.searchParams.delete('security');
      else u.searchParams.set('security', security);

      // Safe defaults for paths
      if (type === 'ws' || type === 'httpupgrade') {
        u.searchParams.set('path', normalizePath(u.searchParams.get('path')));
      }

      // Remove empty params
      for (const k of Array.from(u.searchParams.keys())) {
        const v = u.searchParams.get(k);
        if (v === null || v === undefined || String(v).trim() === '') u.searchParams.delete(k);
      }

      // Normalize fragment encoding
      if (u.hash) {
        let tag = u.hash.replace(/^#/, '');
        try { tag = decodeURIComponent(tag); } catch (e) {}
        u.hash = tag ? '#' + encodeURIComponent(tag) : '';
      }

      reorderSearchParams(u, [
        'type', 'security',
        'encryption', 'flow',
        'sni', 'fp', 'alpn',
        'pbk', 'sid', 'spx', 'pqv',
        'path', 'host',
        'serviceName', 'authority', 'mode',
        'allowInsecure', 'insecure'
      ]);

      return u.toString();
    }

    function normalizeVMess(url, typeHint, secHint) {
      const s = String(url || '').trim();
      if (!s.toLowerCase().startsWith('vmess://')) return '';
      const payload = s.slice(8);
      const decoded = safeB64Decode(payload);
      if (!decoded) return '';

      let data;
      try { data = JSON.parse(decoded); } catch (e) { return ''; }

      // Defaults
      if (!data.v) data.v = '2';
      if (data.aid === undefined || data.aid === null || data.aid === '') data.aid = '0';

      const net = String(data.net || typeHint || 'tcp').toLowerCase();
      data.net = net || 'tcp';

      // Security normalization: prefer tls key
      const sec = String((data.tls || data.security || secHint || '')).toLowerCase();
      if (sec === 'tls') {
        data.tls = 'tls';
        data.sni = data.sni || data.host || '';
      } else {
        // Keep tls empty if not used
        if (data.tls) data.tls = '';
      }

      // Port default (keep as string for compatibility)
      if (!data.port) data.port = '443';

      // WS default path
      if (data.net === 'ws') {
        data.path = normalizePath(data.path || '/');
      }
      if (data.net === 'httpupgrade') {
        data.path = normalizePath(data.path || '/');
      }

      // Remove empty keys (but keep required ones)
      const keep = new Set(['v', 'ps', 'add', 'port', 'id', 'aid', 'net', 'type', 'host', 'path', 'tls', 'sni', 'alpn', 'fp', 'scy']);
      for (const k of Object.keys(data)) {
        if (!keep.has(k)) continue;
        const v = data[k];
        if (v === null || v === undefined || String(v).trim() === '') {
          // Do not delete required keys
          if (['v', 'add', 'port', 'id', 'net'].includes(k)) continue;
          delete data[k];
        }
      }

      const json = JSON.stringify(data);
      const b64 = safeB64Encode(json);
      if (!b64) return '';
      return 'vmess://' + b64;
    }

    function normalizeSS(url) {
      let u;
      try { u = new URL(String(url || '').trim()); } catch (e) { return ''; }
      if (u.protocol.toLowerCase() !== 'ss:') return '';

      // Extract method/password
      let method = '';
      let password = '';
      if (u.username && u.password) {
        method = u.username;
        password = u.password;
      } else if (u.username && !u.password) {
        const decoded = safeB64Decode(u.username);
        if (decoded && decoded.includes(':')) {
          const idx = decoded.indexOf(':');
          method = decoded.slice(0, idx);
          password = decoded.slice(idx + 1);
        }
      }

      const host = u.hostname;
      const port = u.port || '';
      if (!host || !port) return '';

      const creds = safeB64Encode(String(method || '') + ':' + String(password || ''));
      if (!creds) return '';

      // Preserve plugin if present
      const plugin = (() => {
        try {
          const v = u.searchParams.get('plugin') || '';
          return v ? 'plugin=' + encodeURIComponent(v) : '';
        } catch (e) {
          return '';
        }
      })();

      let tag = '';
      if (u.hash) {
        tag = u.hash.replace(/^#/, '');
        try { tag = decodeURIComponent(tag); } catch (e) {}
      }

      const out = 'ss://' + creds + '@' + host + ':' + port + (plugin ? '?' + plugin : '') + (tag ? '#' + encodeURIComponent(tag) : '');
      return out;
    }

    function normalizeCurrentUrl() {
      const statusEl = $('outbounds-status');
      const input = $('outbounds-url');
      const typeSel = $('outbounds-type');
      const secSel = $('outbounds-security');
      if (!input) return;

      const raw = String(input.value || '').trim();
      if (!raw) {
        if (statusEl) statusEl.textContent = 'Вставь ссылку, чтобы нормализовать.';
        try { if (typeof showToast === 'function') showToast('Ссылка пустая.', true); } catch (e) {}
        return;
      }

      const scheme = detectScheme(raw);
      const typeHint = typeSel ? String(typeSel.value || 'auto').toLowerCase() : 'auto';
      const secHint = secSel ? String(secSel.value || 'auto').toLowerCase() : 'auto';

      let normalized = '';
      if (scheme === 'vless' || scheme === 'trojan') normalized = normalizeVlessTrojan(raw, scheme, typeHint, secHint);
      else if (scheme === 'vmess') normalized = normalizeVMess(raw, typeHint, secHint);
      else if (scheme === 'ss') normalized = normalizeSS(raw);
      else if (scheme === 'hy2' || scheme === 'hysteria2' || scheme === 'hysteria') normalized = raw;

      if (!normalized) {
        const msg = 'Не удалось нормализовать ссылку (проверь формат).';
        if (statusEl) statusEl.textContent = msg;
        try { if (typeof showToast === 'function') showToast(msg, true); } catch (e) {}
        return;
      }

      input.value = normalized;
      try { updateHintsFromUrl(normalized); } catch (e) {}
      try { validateAndUpdateUI(); } catch (e) {}
      const msg = 'Ссылка нормализована.';
      if (statusEl) statusEl.textContent = msg;
      try { if (typeof showToast === 'function') showToast(msg, false); } catch (e) {}
    }

    function wireHints() {
      const input = $('outbounds-url');
      const protoSel = $('outbounds-proto');
      const typeSel = $('outbounds-type');
      const secSel = $('outbounds-security');
      if (!input || !protoSel || !typeSel || !secSel) return;

      if (input.dataset && input.dataset.xkeenHintsWired === '1') return;

      input.addEventListener('input', () => {
        try { updateHintsFromUrl(input.value); } catch (e) {}
        try { validateAndUpdateUI(); } catch (e) {}
      });

      protoSel.addEventListener('change', () => {
        try {
          const cur = String(input.value || '').trim();
          const v = String(protoSel.value || 'auto');
          if (!cur && v !== 'auto') input.value = v + '://';
          updateHintsFromUrl(input.value);
          validateAndUpdateUI();
        } catch (e) {}
      });

      const onPick = () => {
        try { applyHintsToUrl(); } catch (e) {}
        try { validateAndUpdateUI(); } catch (e) {}
      };

      typeSel.addEventListener('change', onPick);
      secSel.addEventListener('change', onPick);

      if (input.dataset) input.dataset.xkeenHintsWired = '1';
    }


    // ---------- URL hint helpers (protocol/type/security) ----------

    function setCollapsedFromStorage() {
      const body = $('outbounds-body');
      const arrow = $('outbounds-arrow');
      if (!body || !arrow) return;

      let open = false;
      try {
        if (window.localStorage) {
          const stored = localStorage.getItem('xkeen_outbounds_open');
          if (stored === '1') open = true;
          else if (stored === '0') open = false;
        }
      } catch (e) {
        // ignore
      }

      body.style.display = open ? 'block' : 'none';
      arrow.textContent = open ? '▲' : '▼';
    }

    function toggleCard() {
      const body = $('outbounds-body');
      const arrow = $('outbounds-arrow');
      if (!body || !arrow) return;

      const willOpen = body.style.display === 'none';
      body.style.display = willOpen ? 'block' : 'none';
      arrow.textContent = willOpen ? '▲' : '▼';

      try {
        if (window.localStorage) {
          localStorage.setItem('xkeen_outbounds_open', willOpen ? '1' : '0');
        }
      } catch (e) {
        // ignore
      }
    }

    async function load() {
      const statusEl = $('outbounds-status');
      const input = $('outbounds-url');
      if (!input) return;

      try {
        const res = await fetch('/api/outbounds');
        if (!res.ok) {
          if (statusEl) statusEl.textContent = 'Не удалось загрузить outbounds.';
          return;
        }
        const data = await res.json().catch(() => ({}));
        if (data && data.url) {
          input.value = data.url;
          updateHintsFromUrl(data.url);
          validateAndUpdateUI();
          if (statusEl) statusEl.textContent = 'Текущая ссылка загружена.';
          try {
            if (typeof updateLastActivity === 'function') {
              const fp = window.XKEEN_FILES && window.XKEEN_FILES.outbounds ? window.XKEEN_FILES.outbounds : '';
              updateLastActivity('loaded', 'outbounds', fp);
            }
          } catch (e) {}
        } else {
          if (statusEl) statusEl.textContent = 'Файл outbounds отсутствует или не содержит прокси-конфиг.';
          updateHintsFromUrl('');
          validateAndUpdateUI();
          try {
            if (typeof updateLastActivity === 'function') {
              const fp = window.XKEEN_FILES && window.XKEEN_FILES.outbounds ? window.XKEEN_FILES.outbounds : '';
              updateLastActivity('loaded', 'outbounds', fp);
            }
          } catch (e) {}
        }
      } catch (e) {
        console.error(e);
        if (statusEl) statusEl.textContent = 'Ошибка загрузки outbounds.';
      }
    }

    async function save() {
      const statusEl = $('outbounds-status');
      const input = $('outbounds-url');
      if (!input) return;

      const url = String(input.value || '').trim();
      if (!url) {
        if (statusEl) statusEl.textContent = 'Введи ссылку прокси (vless / trojan / vmess / ss).';
        return;
      }

      // Client-side validation guard
      try {
        const parsed = parseProxyUrl(url);
        renderParsePreview(parsed);
        if (!parsed.ok) {
          if (statusEl) statusEl.textContent = 'Ссылка содержит ошибки — исправь и попробуй снова.';
          input.classList.add('xk-invalid');
          return;
        }
      } catch (e) {}

      try {
        const res = await fetch('/api/outbounds', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, restart: shouldRestartAfterSave() }),
        });
        const data = await res.json().catch(() => ({}));

        if (res.ok && data && data.ok) {
          let msg = 'Outbounds сохранены.';
          if (statusEl) statusEl.textContent = msg;
          try { if (!data || !data.restarted) { if (typeof showToast === 'function') showToast(msg, false); } } catch (e) {}
          try {
            if (typeof updateLastActivity === 'function') {
              const fp = window.XKEEN_FILES && window.XKEEN_FILES.outbounds ? window.XKEEN_FILES.outbounds : '';
              updateLastActivity('saved', 'outbounds', fp);
            }
          } catch (e) {}
        } else {
          const msg = 'Save error: ' + ((data && data.error) || res.status);
          if (statusEl) statusEl.textContent = msg;
          try { if (typeof showToast === 'function') showToast(msg, true); } catch (e) {}
        }
      } catch (e) {
        console.error(e);
        const msg = 'Failed to save outbounds.';
        if (statusEl) statusEl.textContent = msg;
        try { if (typeof showToast === 'function') showToast(msg, true); } catch (e2) {}
      } finally {
        try { if (typeof loadRestartLog === 'function') loadRestartLog(); } catch (e) {}
      }
    }

    async function backup() {
      const statusEl = $('outbounds-status');
      const backupsStatusEl = $('backups-status');

      function _baseName(p, fallback) {
        try {
          if (!p) return fallback;
          const parts = String(p).split(/\//);
          const b = parts[parts.length - 1];
          return b || fallback;
        } catch (e) {
          return fallback;
        }
      }

      const fileLabel = _baseName(window.XKEEN_FILES && window.XKEEN_FILES.outbounds, '04_outbounds.json');

      try {
        const res = await fetch('/api/backup-outbounds', { method: 'POST' });
        const data = await res.json().catch(() => ({}));

        if (res.ok && data && data.ok) {
          const msg = 'Бэкап ' + fileLabel + ' создан: ' + (data.filename || '');
          if (statusEl) statusEl.textContent = msg;
          if (backupsStatusEl) backupsStatusEl.textContent = '';
          try { if (typeof showToast === 'function') showToast(msg, false); } catch (e) {}
          try {
            if (window.XKeen && XKeen.backups) {
              if (typeof XKeen.backups.refresh === 'function') await XKeen.backups.refresh();
              else if (typeof XKeen.backups.load === 'function') await XKeen.backups.load();
            }
          } catch (e) {}
        } else {
          const msg = 'Ошибка создания бэкапа ' + fileLabel + ': ' + ((data && data.error) || 'неизвестная ошибка');
          if (statusEl) statusEl.textContent = msg;
          try { if (typeof showToast === 'function') showToast(msg, true); } catch (e) {}
        }
      } catch (e) {
        console.error(e);
        const msg = 'Ошибка создания бэкапа ' + fileLabel + '.';
        if (statusEl) statusEl.textContent = msg;
        try { if (typeof showToast === 'function') showToast(msg, true); } catch (e2) {}
      }
    }


    // ---------- Mini generator modal (build proxy link from hints) ----------

    function safeDecodeURIComponent(s) {
      try { return decodeURIComponent(String(s || '')); } catch (e) { return String(s || ''); }
    }

    function setElValue(id, value) {
      const el = $(id);
      if (!el) return;
      try { el.value = (value === undefined || value === null) ? '' : String(value); } catch (e) {}
    }

    function setSelectIfExists(id, value) {
      const el = $(id);
      if (!el) return;
      const v = String(value || '').trim().toLowerCase();
      if (!v) return;
      try {
        // Only set if option exists
        const ok = Array.from(el.options || []).some(o => String(o.value || '').toLowerCase() === v);
        if (ok) el.value = v;
      } catch (e) {}
    }

    function parseSSRaw(url) {
      // Returns sensitive fields too (method/password) for generator prefill.
      const out = { ok: false, host: '', port: '', method: '', password: '', plugin: '', tag: '' };
      let s = String(url || '').trim();
      if (!s.toLowerCase().startsWith('ss://')) return out;

      // Tag
      const hashIdx = s.indexOf('#');
      if (hashIdx >= 0) {
        out.tag = safeDecodeURIComponent(s.slice(hashIdx + 1));
        s = s.slice(0, hashIdx);
      }

      // Query/plugin
      const qIdx = s.indexOf('?');
      if (qIdx >= 0) {
        const query = s.slice(qIdx + 1);
        s = s.slice(0, qIdx);
        try {
          const qs = new URLSearchParams(query);
          out.plugin = qs.get('plugin') || '';
        } catch (e) {}
      }

      let rest = s.slice(5); // after ss://
      if (!rest) return out;

      // userinfo@host:port
      let userinfo = '';
      let hostport = '';

      if (rest.includes('@')) {
        const parts = rest.split('@');
        userinfo = parts[0] || '';
        hostport = parts.slice(1).join('@');
      } else {
        const decoded = safeB64Decode(rest);
        if (decoded && decoded.includes('@')) {
          const parts = decoded.split('@');
          userinfo = parts[0] || '';
          hostport = parts.slice(1).join('@');
        } else {
          // Some variants encode only creds in base64 without @ in outer form
          hostport = rest;
        }
      }

      // Decode userinfo to method:pass
      let creds = String(userinfo || '').trim();
      if (creds && !creds.includes(':')) {
        const dec = safeB64Decode(creds);
        if (dec && dec.includes(':')) creds = dec;
      }
      if (creds.includes(':')) {
        const idx = creds.indexOf(':');
        out.method = creds.slice(0, idx);
        out.password = creds.slice(idx + 1);
      }

      // Host/port
      const hp = String(hostport || '').trim();
      if (hp.startsWith('[')) {
        const m = hp.match(/^\[([^\]]+)\]:(\d+)$/);
        if (m) {
          out.host = m[1];
          out.port = m[2];
        }
      } else {
        const idx = hp.lastIndexOf(':');
        if (idx > 0) {
          out.host = hp.slice(0, idx);
          out.port = hp.slice(idx + 1);
        }
      }

      out.ok = !!(out.host && out.port && out.method && out.password && isValidPort(out.port));
      return out;
    }

    function prefillGeneratorFromUrl(url) {
      const s = String(url || '').trim();
      if (!s) return false;
      const schemeRaw = detectScheme(s);
      if (!['vless', 'trojan', 'vmess', 'ss', 'hy2', 'hysteria2', 'hysteria'].includes(schemeRaw)) return false;
      // normalize hysteria/hysteria2 to hy2
      const scheme = (schemeRaw === 'hysteria2' || schemeRaw === 'hysteria') ? 'hy2' : schemeRaw;

      // Reset basic fields (do not clear preview/status here)
      setElValue('outbounds-gen-host', '');
      setElValue('outbounds-gen-port', '443');
      setElValue('outbounds-gen-tag', '');

      // Reset creds
      setElValue('outbounds-gen-uuid', '');
      setElValue('outbounds-gen-pass', '');
      setElValue('outbounds-gen-vmess-uuid', '');
      // HY2
      setElValue('outbounds-gen-hy2-auth', '');
      // SS
      setElValue('outbounds-gen-ss-pass', '');
      setElValue('outbounds-gen-ss-plugin', '');

      // Reset advanced
      ['outbounds-gen-sni','outbounds-gen-fp','outbounds-gen-alpn','outbounds-gen-path','outbounds-gen-hosthdr',
       'outbounds-gen-service','outbounds-gen-authority','outbounds-gen-pbk','outbounds-gen-sid','outbounds-gen-spx',
       'outbounds-gen-hy2-obfspwd','outbounds-gen-hy2-pinsha256'].forEach((id) => setElValue(id, ''));
      setElValue('outbounds-gen-spx', '/');
      setSelectIfExists('outbounds-gen-flow', '');
      setSelectIfExists('outbounds-gen-grpc-mode', '');
      setSelectIfExists('outbounds-gen-allowinsecure', '0');
      setSelectIfExists('outbounds-gen-hy2-insecure', '0');
      setSelectIfExists('outbounds-gen-hy2-obfs', '');

      // defaults
      setSelectIfExists('outbounds-gen-proto', scheme);

      // Close advanced by default, open it only when we found advanced params
      try {
        const adv = $('outbounds-gen-advanced');
        if (adv) adv.open = false;
      } catch (e) {}

      let filledAnyAdvanced = false;

      if (scheme === 'vless' || scheme === 'trojan') {
        let u;
        try { u = new URL(s); } catch (e) { return false; }

        const host = (u.hostname || '').toString();
        const port = (u.port || '').toString() || '443';
        const user = (u.username || '').toString();
        const tag = safeDecodeURIComponent((u.hash || '').replace(/^#/, ''));

        const type = (u.searchParams.get('type') || u.searchParams.get('net') || 'tcp').toLowerCase();
        const secRaw = (u.searchParams.get('security') || '').toLowerCase();
        const security = secRaw || (scheme === 'trojan' ? 'tls' : 'reality');

        setElValue('outbounds-gen-host', host);
        setElValue('outbounds-gen-port', port);
        setElValue('outbounds-gen-tag', tag);
        setSelectIfExists('outbounds-gen-type', type);
        setSelectIfExists('outbounds-gen-security', security);

        if (scheme === 'vless') setElValue('outbounds-gen-uuid', user);
        else setElValue('outbounds-gen-pass', user);

        const sni = (u.searchParams.get('sni') || u.searchParams.get('serverName') || '').toString();
        const fp = (u.searchParams.get('fp') || '').toString();
        const alpn = (u.searchParams.get('alpn') || '').toString();
        const flow = (u.searchParams.get('flow') || '').toString();
        const allowInsecure = (u.searchParams.get('allowInsecure') || '').toString();

        const pbk = (u.searchParams.get('pbk') || u.searchParams.get('publicKey') || '').toString();
        const sid = (u.searchParams.get('sid') || u.searchParams.get('shortId') || '').toString();
        const spx = (u.searchParams.get('spx') || '').toString();

        const path = (u.searchParams.get('path') || '').toString();
        const hostHdr = (u.searchParams.get('host') || '').toString();
        const serviceName = (u.searchParams.get('serviceName') || '').toString();
        const authority = (u.searchParams.get('authority') || '').toString();
        const mode = (u.searchParams.get('mode') || '').toString();

        if (sni) { setElValue('outbounds-gen-sni', sni); filledAnyAdvanced = true; }
        if (fp) { setElValue('outbounds-gen-fp', fp); filledAnyAdvanced = true; }
        if (alpn) { setElValue('outbounds-gen-alpn', alpn); filledAnyAdvanced = true; }
        if (flow && scheme === 'vless') { setSelectIfExists('outbounds-gen-flow', flow); filledAnyAdvanced = true; }
        if (allowInsecure === '1' || allowInsecure.toLowerCase() === 'true') { setSelectIfExists('outbounds-gen-allowinsecure', '1'); filledAnyAdvanced = true; }

        if (path) { setElValue('outbounds-gen-path', path); filledAnyAdvanced = true; }
        if (hostHdr) { setElValue('outbounds-gen-hosthdr', hostHdr); filledAnyAdvanced = true; }
        if (serviceName) { setElValue('outbounds-gen-service', serviceName); filledAnyAdvanced = true; }
        if (authority) { setElValue('outbounds-gen-authority', authority); filledAnyAdvanced = true; }
        if (mode) { setSelectIfExists('outbounds-gen-grpc-mode', mode); filledAnyAdvanced = true; }

        if (pbk) { setElValue('outbounds-gen-pbk', pbk); filledAnyAdvanced = true; }
        if (sid) { setElValue('outbounds-gen-sid', sid); filledAnyAdvanced = true; }
        if (spx) { setElValue('outbounds-gen-spx', spx); filledAnyAdvanced = true; }

        try {
          const adv = $('outbounds-gen-advanced');
          if (adv) adv.open = !!filledAnyAdvanced;
        } catch (e) {}

        return true;
      }

      if (scheme === 'vmess') {
        const payload = s.slice(8);
        const decoded = safeB64Decode(payload);
        if (!decoded) return false;
        let data = null;
        try { data = JSON.parse(decoded); } catch (e) { return false; }

        const host = (data.add || '').toString();
        const port = (data.port || '').toString() || '443';
        const uuid = (data.id || '').toString();
        const tag = (data.ps || '').toString();
        const net = (data.net || 'tcp').toString().toLowerCase();
        const tls = (data.tls || '').toString().toLowerCase();

        setElValue('outbounds-gen-host', host);
        setElValue('outbounds-gen-port', port);
        setElValue('outbounds-gen-tag', tag);
        setElValue('outbounds-gen-vmess-uuid', uuid);

        setSelectIfExists('outbounds-gen-type', net);
        setSelectIfExists('outbounds-gen-security', (tls === 'tls') ? 'tls' : 'none');

        // Advanced
        if (data.sni) { setElValue('outbounds-gen-sni', data.sni); filledAnyAdvanced = true; }
        if (data.fp) { setElValue('outbounds-gen-fp', data.fp); filledAnyAdvanced = true; }
        if (data.alpn) { setElValue('outbounds-gen-alpn', data.alpn); filledAnyAdvanced = true; }
        if (data.allowInsecure) { setSelectIfExists('outbounds-gen-allowinsecure', '1'); filledAnyAdvanced = true; }

        if (net === 'ws' || net === 'httpupgrade') {
          if (data.path) { setElValue('outbounds-gen-path', data.path); filledAnyAdvanced = true; }
          if (data.host) { setElValue('outbounds-gen-hosthdr', data.host); filledAnyAdvanced = true; }
        }
        if (net === 'grpc') {
          if (data.path) { setElValue('outbounds-gen-service', data.path); filledAnyAdvanced = true; }
          if (data.host) { setElValue('outbounds-gen-authority', data.host); filledAnyAdvanced = true; }
        }

        try {
          const adv = $('outbounds-gen-advanced');
          if (adv) adv.open = !!filledAnyAdvanced;
        } catch (e) {}

        return true;
      }

      if (scheme === 'ss') {
        const ss = parseSSRaw(s);
        if (!ss.ok && !(ss.host && ss.port)) {
          return false;
        }
        setElValue('outbounds-gen-host', ss.host);
        setElValue('outbounds-gen-port', ss.port || '8388');
        setElValue('outbounds-gen-tag', ss.tag);

        if (ss.method) setSelectIfExists('outbounds-gen-ss-method', ss.method);
        setElValue('outbounds-gen-ss-pass', ss.password);
        setElValue('outbounds-gen-ss-plugin', ss.plugin);

        // Force selects
        setSelectIfExists('outbounds-gen-type', 'tcp');
        setSelectIfExists('outbounds-gen-security', 'none');

        try {
          const adv = $('outbounds-gen-advanced');
          if (adv) adv.open = !!(ss.plugin);
        } catch (e) {}
        try {
          if (filledAnyAdvanced) {
            const adv = $('outbounds-gen-advanced');
            if (adv) adv.open = true;
          }
        } catch (e) {}
        return true;
      }

      if (scheme === 'hy2') {
        let u;
        try { u = new URL(s); } catch (e) { return false; }

        const host = (u.hostname || '').toString();
        const port = (u.port || '').toString() || '443';
        const tag = safeDecodeURIComponent((u.hash || '').replace(/^#/, ''));

        const user = (u.username || '').toString();
        const pass = (u.password || '').toString();
        const auth = (user || pass) ? (user + (pass ? (':' + pass) : '')) : '';

        setElValue('outbounds-gen-host', host);
        setElValue('outbounds-gen-port', port);
        setElValue('outbounds-gen-tag', tag);
        setElValue('outbounds-gen-hy2-auth', auth);

        // HY2 does not use these in our generator, keep them neutral
        setSelectIfExists('outbounds-gen-type', 'auto');
        setSelectIfExists('outbounds-gen-security', 'auto');

        const sni = (u.searchParams.get('sni') || '').toString();
        const insecure = (u.searchParams.get('insecure') || u.searchParams.get('allowInsecure') || '').toString();
        const obfs = (u.searchParams.get('obfs') || '').toString();
        const obfsPwd = (u.searchParams.get('obfs-password') || u.searchParams.get('obfs_password') || '').toString();
        const pin = (u.searchParams.get('pinSHA256') || '').toString();

        if (sni) { setElValue('outbounds-gen-sni', sni); filledAnyAdvanced = true; }
        if (insecure === '1' || insecure.toLowerCase() === 'true') { setSelectIfExists('outbounds-gen-hy2-insecure', '1'); filledAnyAdvanced = true; }
        if (obfs) { setSelectIfExists('outbounds-gen-hy2-obfs', obfs); filledAnyAdvanced = true; }
        if (obfsPwd) { setElValue('outbounds-gen-hy2-obfspwd', obfsPwd); filledAnyAdvanced = true; }
        if (pin) { setElValue('outbounds-gen-hy2-pinsha256', pin); filledAnyAdvanced = true; }

        try {
          const adv = $('outbounds-gen-advanced');
          if (adv) adv.open = !!filledAnyAdvanced;
        } catch (e) {}

        return true;
      }

      return false;
    }

    function showGeneratorModal(show) {
      const modal = $('outbounds-generator-modal');
      if (!modal) return;
      try {
        if (show) modal.classList.remove('hidden');
        else modal.classList.add('hidden');
      } catch (e) {}
      try {
        if (window.XKeen && XKeen.ui && XKeen.ui.modal && typeof XKeen.ui.modal.syncBodyScrollLock === 'function') {
          XKeen.ui.modal.syncBodyScrollLock();
        }
      } catch (e) {}
    }

    function getResolvedGenProto() {
      const genProto = ($('outbounds-gen-proto') && $('outbounds-gen-proto').value) || 'auto';
      const p = String(genProto || 'auto').trim().toLowerCase();
      if (p && p !== 'auto') return p;

      // If proto is auto: try detect from current input, otherwise default to vless.
      const input = $('outbounds-url');
      const scheme = input ? detectScheme(String(input.value || '').trim()) : '';
      if (scheme === 'vless' || scheme === 'trojan' || scheme === 'vmess' || scheme === 'ss') return scheme;
      if (scheme === 'hy2' || scheme === 'hysteria2' || scheme === 'hysteria') return 'hy2';
      return 'vless';
    }

    function defaultSecurityForProto(proto) {
      if (proto === 'hy2') return 'tls';
      if (proto === 'trojan') return 'tls';
      if (proto === 'vmess') return 'tls';
      if (proto === 'ss') return 'none';
      // vless
      return 'reality';
    }

    function resolveGenType() {
      const typeEl = $('outbounds-gen-type');
      let t = typeEl ? String(typeEl.value || 'auto').trim().toLowerCase() : 'auto';
      if (!t || t === 'auto') t = 'tcp';
      return t;
    }

    function resolveGenSecurity(proto) {
      const secEl = $('outbounds-gen-security');
      let s = secEl ? String(secEl.value || 'auto').trim().toLowerCase() : 'auto';
      if (!s || s === 'auto') s = defaultSecurityForProto(proto);

      // HY2 always uses TLS, ignore other values
      if (proto === 'hy2') return 'tls';

      // VMess does not support Reality in our backend parser (tlsSettings only)
      if (proto === 'vmess' && s === 'reality') s = 'tls';
      // Shadowsocks does not use this
      if (proto === 'ss') s = 'none';
      return s;
    }

    function updateGeneratorVisibility() {
      const proto = getResolvedGenProto();
      // HY2 does not use classic transport/security selectors here
      const type = (proto === 'hy2') ? 'hysteria' : resolveGenType();
      const sec = (proto === 'hy2') ? 'tls' : resolveGenSecurity(proto);

      const vlessCred = $('outbounds-gen-cred-vless');
      const trojanCred = $('outbounds-gen-cred-trojan');
      const vmessCred = $('outbounds-gen-cred-vmess');
      const ssCred = $('outbounds-gen-cred-ss');
      const ssPass = $('outbounds-gen-cred-ss-pass');
      const hy2Cred = $('outbounds-gen-cred-hy2');

      function show(el, on) {
        if (!el) return;
        el.style.display = on ? '' : 'none';
      }

      show(vlessCred, proto === 'vless');
      show(trojanCred, proto === 'trojan');
      show(vmessCred, proto === 'vmess');
      show(ssCred, proto === 'ss');
      show(ssPass, proto === 'ss');
      show(hy2Cred, proto === 'hy2');

      // Transport dependent fields
      const isWS = type === 'ws' || type === 'httpupgrade';
      const isGRPC = type === 'grpc';

      show($('outbounds-gen-field-path'), isWS);
      show($('outbounds-gen-field-hosthdr'), isWS);
      show($('outbounds-gen-field-grpc-service'), isGRPC);
      show($('outbounds-gen-field-grpc-authority'), isGRPC);
      show($('outbounds-gen-field-grpc-mode'), isGRPC);

      // Security dependent fields
      show($('outbounds-gen-field-sni'), proto !== 'ss' && sec !== 'none');
      // HY2 does not use fp/alpn/allowInsecure params
      show($('outbounds-gen-field-fp'), proto !== 'ss' && proto !== 'hy2' && sec !== 'none');
      show($('outbounds-gen-field-alpn'), proto !== 'ss' && proto !== 'hy2' && sec === 'tls');
      show($('outbounds-gen-field-allowinsecure'), proto !== 'ss' && proto !== 'hy2' && sec === 'tls');
      show($('outbounds-gen-field-reality-pbk'), proto !== 'ss' && sec === 'reality');
      show($('outbounds-gen-field-reality-sid'), proto !== 'ss' && sec === 'reality');
      show($('outbounds-gen-field-reality-spx'), proto !== 'ss' && sec === 'reality');

      // HY2 extra fields
      show($('outbounds-gen-field-hy2-insecure'), proto === 'hy2');
      show($('outbounds-gen-field-hy2-obfs'), proto === 'hy2');
      show($('outbounds-gen-field-hy2-obfspwd'), proto === 'hy2');
      show($('outbounds-gen-field-hy2-pinsha256'), proto === 'hy2');

      // VLESS only
      show($('outbounds-gen-field-flow'), proto === 'vless');

      // SS only
      show($('outbounds-gen-field-ss-plugin'), proto === 'ss');

      // Disable irrelevant selects for SS (keep visible, but no confusion)
      try {
        const secEl = $('outbounds-gen-security');
        const typeEl = $('outbounds-gen-type');
        if (secEl) secEl.disabled = (proto === 'ss' || proto === 'hy2');
        if (typeEl) typeEl.disabled = (proto === 'ss' || proto === 'hy2');
      } catch (e) {}

      // Small hint if VMess+Reality auto-converted
      try {
        const statusEl = $('outbounds-gen-status');
        if (statusEl && proto === 'vmess') {
          const rawSec = ($('outbounds-gen-security') && $('outbounds-gen-security').value) || 'auto';
          if (String(rawSec).toLowerCase() == 'reality') {
            statusEl.textContent = 'VMess не поддерживает Reality — будет использован TLS.';
          } else if (statusEl.textContent && statusEl.textContent.indexOf('VMess не поддерживает') === 0) {
            statusEl.textContent = '';
          }
        }
      } catch (e) {}
    }

    function buildLinkFromGenerator() {
      const proto = getResolvedGenProto();
      // HY2 does not use classic transport/security selectors here
      const type = (proto === 'hy2') ? 'hysteria' : resolveGenType();
      const sec = (proto === 'hy2') ? 'tls' : resolveGenSecurity(proto);

      const host = String(($('outbounds-gen-host') && $('outbounds-gen-host').value) || '').trim();
      const portStr = String(($('outbounds-gen-port') && $('outbounds-gen-port').value) || '').trim();
      const port = portStr ? parseInt(portStr, 10) : 443;
      const tag = String(($('outbounds-gen-tag') && $('outbounds-gen-tag').value) || '').trim();

      const sni = String(($('outbounds-gen-sni') && $('outbounds-gen-sni').value) || '').trim();
      const fp = String(($('outbounds-gen-fp') && $('outbounds-gen-fp').value) || '').trim() || 'chrome';
      const alpn = String(($('outbounds-gen-alpn') && $('outbounds-gen-alpn').value) || '').trim();
      const flow = String(($('outbounds-gen-flow') && $('outbounds-gen-flow').value) || '').trim();

      const path = String(($('outbounds-gen-path') && $('outbounds-gen-path').value) || '').trim();
      const hostHdr = String(($('outbounds-gen-hosthdr') && $('outbounds-gen-hosthdr').value) || '').trim();
      const serviceName = String(($('outbounds-gen-service') && $('outbounds-gen-service').value) || '').trim();
      const authority = String(($('outbounds-gen-authority') && $('outbounds-gen-authority').value) || '').trim();
      const grpcMode = String(($('outbounds-gen-grpc-mode') && $('outbounds-gen-grpc-mode').value) || '').trim();

      const pbk = String(($('outbounds-gen-pbk') && $('outbounds-gen-pbk').value) || '').trim();
      const sid = String(($('outbounds-gen-sid') && $('outbounds-gen-sid').value) || '').trim();
      const spx = String(($('outbounds-gen-spx') && $('outbounds-gen-spx').value) || '').trim() || '/';

      const allowInsecure = String(($('outbounds-gen-allowinsecure') && $('outbounds-gen-allowinsecure').value) || '0') === '1';

      const errors = [];
      const warnings = [];

      if (!host) errors.push('Не указан host');
      if (!port || !isValidPort(String(port))) errors.push('Некорректный port');

      if (proto === 'hy2') {
        const authRaw = String(($('outbounds-gen-hy2-auth') && $('outbounds-gen-hy2-auth').value) || '').trim();
        if (!authRaw) errors.push('Для HY2 нужен auth');

        // Split auth into username/password (optional)
        let hyUser = authRaw;
        let hyPass = '';
        const idx = authRaw.indexOf(':');
        if (idx >= 0) {
          hyUser = authRaw.slice(0, idx);
          hyPass = authRaw.slice(idx + 1);
        }

        const insecureVal = String(($('outbounds-gen-hy2-insecure') && $('outbounds-gen-hy2-insecure').value) || '0').trim();
        const obfs = String(($('outbounds-gen-hy2-obfs') && $('outbounds-gen-hy2-obfs').value) || '').trim();
        const obfsPwd = String(($('outbounds-gen-hy2-obfspwd') && $('outbounds-gen-hy2-obfspwd').value) || '').trim();
        const pin = String(($('outbounds-gen-hy2-pinsha256') && $('outbounds-gen-hy2-pinsha256').value) || '').trim();

        const params = new URLSearchParams();
        if (sni) params.set('sni', sni);
        if (insecureVal === '1') params.set('insecure', '1');
        if (obfs) params.set('obfs', obfs);
        if (obfsPwd && obfs) params.set('obfs-password', obfsPwd);
        if (obfsPwd && !obfs) warnings.push('HY2: указан obfs-password без obfs');
        if (pin) params.set('pinSHA256', pin);

        if (insecureVal === '1' && !pin) {
          warnings.push('HY2: insecure=1 снижает безопасность (лучше использовать pinSHA256)');
        }

        const userInfo = encodeURIComponent(hyUser) + (hyPass ? (':' + encodeURIComponent(hyPass)) : '');
        const q = params.toString();
        const hash = tag ? ('#' + encodeURIComponent(tag)) : '';
        const url = `hy2://${userInfo}@${host}:${port}${q ? ('?' + q) : ''}${hash}`;
        return { ok: errors.length === 0, url, errors, warnings };
      }

      if (proto === 'vless') {
        const uuid = String(($('outbounds-gen-uuid') && $('outbounds-gen-uuid').value) || '').trim();
        if (!uuid) errors.push('Для VLESS нужен UUID');
        else if (!looksLikeUuid(uuid)) warnings.push('UUID не похож на UUID (проверь)');

        if (sec === 'reality' && !pbk) errors.push('Reality: нужен pbk (publicKey)');

        const params = new URLSearchParams();
        params.set('type', type);
        params.set('security', sec);
        params.set('encryption', 'none');
        if (flow) params.set('flow', flow);

        if (sec !== 'none') {
          if (fp) params.set('fp', fp);
          if (sni) params.set('sni', sni);
        }
        if (sec === 'tls') {
          if (alpn) params.set('alpn', alpn);
          if (allowInsecure) params.set('allowInsecure', '1');
        }
        if (sec === 'reality') {
          if (fp) params.set('fp', fp);
          if (sni) params.set('sni', sni);
          if (pbk) params.set('pbk', pbk);
          if (sid) params.set('sid', sid);
          if (spx) params.set('spx', spx);
        }

        if (type === 'ws' || type === 'httpupgrade') {
          params.set('path', path || '/');
          if (hostHdr) params.set('host', hostHdr);
        }
        if (type === 'grpc') {
          if (serviceName) params.set('serviceName', serviceName);
          else warnings.push('gRPC: желательно указать serviceName');
          if (authority) params.set('authority', authority);
          if (grpcMode) params.set('mode', grpcMode);
        }

        const userEnc = encodeURIComponent(uuid);
        const hostEnc = host;
        const q = params.toString();
        const hash = tag ? ('#' + encodeURIComponent(tag)) : '';
        const url = `vless://${userEnc}@${hostEnc}:${port}?${q}${hash}`;
        return { ok: errors.length === 0, url, errors, warnings };
      }

      if (proto === 'trojan') {
        const pass = String(($('outbounds-gen-pass') && $('outbounds-gen-pass').value) || '').trim();
        if (!pass) errors.push('Для Trojan нужен пароль');

        if (sec === 'reality' && !pbk) errors.push('Reality: нужен pbk (publicKey)');

        const params = new URLSearchParams();
        params.set('type', type);
        params.set('security', sec);

        if (sec !== 'none') {
          if (fp) params.set('fp', fp);
          if (sni) params.set('sni', sni);
        }
        if (sec === 'tls') {
          if (alpn) params.set('alpn', alpn);
          if (allowInsecure) params.set('allowInsecure', '1');
        }
        if (sec === 'reality') {
          if (fp) params.set('fp', fp);
          if (sni) params.set('sni', sni);
          if (pbk) params.set('pbk', pbk);
          if (sid) params.set('sid', sid);
          if (spx) params.set('spx', spx);
        }

        if (type === 'ws' || type === 'httpupgrade') {
          params.set('path', path || '/');
          if (hostHdr) params.set('host', hostHdr);
        }
        if (type === 'grpc') {
          if (serviceName) params.set('serviceName', serviceName);
          else warnings.push('gRPC: желательно указать serviceName');
          if (authority) params.set('authority', authority);
          if (grpcMode) params.set('mode', grpcMode);
        }

        const userEnc = encodeURIComponent(pass);
        const q = params.toString();
        const hash = tag ? ('#' + encodeURIComponent(tag)) : '';
        const url = `trojan://${userEnc}@${host}:${port}?${q}${hash}`;
        return { ok: errors.length === 0, url, errors, warnings };
      }


      if (proto === 'vmess') {
        const uuid = String(($('outbounds-gen-vmess-uuid') && $('outbounds-gen-vmess-uuid').value) || '').trim();
        if (!uuid) errors.push('Для VMess нужен UUID');
        else if (!looksLikeUuid(uuid)) warnings.push('UUID не похож на UUID (проверь)');

        // VMess supports TLS/None (Reality is auto-converted to TLS)
        const tlsOn = (sec === 'tls');

        const net = type; // tcp/ws/grpc/httpupgrade
        if (!['tcp', 'ws', 'grpc', 'httpupgrade'].includes(net)) {
          warnings.push('VMess: транспорт "' + net + '" может не поддерживаться, лучше TCP/WS/gRPC');
        }

        const data = {
          v: '2',
          ps: tag || 'vmess',
          add: host,
          port: String(port),
          id: uuid,
          aid: '0',
          scy: 'auto',
          net: net,
          type: 'none',
          tls: tlsOn ? 'tls' : '',
        };

        if (tlsOn) {
          data.fp = fp || 'chrome';
          data.sni = sni || host;
          if (alpn) data.alpn = alpn;
          if (allowInsecure) data.allowInsecure = true;
        }

        if (net === 'ws' || net === 'httpupgrade') {
          data.path = path || '/';
          if (hostHdr) data.host = hostHdr;
        } else if (net === 'grpc') {
          data.path = serviceName || '';
          if (!serviceName) warnings.push('gRPC: желательно указать serviceName');
          // In many generators "host" is used as authority for gRPC
          if (authority) data.host = authority;
        }

        let b64 = '';
        try {
          b64 = safeB64Encode(JSON.stringify(data));
        } catch (e) {
          errors.push('VMess: не удалось сериализовать JSON');
        }
        const url = 'vmess://' + b64;
        return { ok: errors.length === 0, url, errors, warnings };
      }

      if (proto === 'ss') {
        const method = String(($('outbounds-gen-ss-method') && $('outbounds-gen-ss-method').value) || '').trim();
        const pass = String(($('outbounds-gen-ss-pass') && $('outbounds-gen-ss-pass').value) || '').trim();
        const plugin = String(($('outbounds-gen-ss-plugin') && $('outbounds-gen-ss-plugin').value) || '').trim();

        if (!method) errors.push('Для SS нужен method');
        if (!pass) errors.push('Для SS нужен password');

        let b64 = '';
        try {
          b64 = safeB64Encode(method + ':' + pass);
        } catch (e) {
          errors.push('SS: не удалось закодировать данные');
        }

        let url = `ss://${b64}@${host}:${port}`;
        if (plugin) url += `?plugin=${encodeURIComponent(plugin)}`;
        if (tag) url += `#${encodeURIComponent(tag)}`;

        return { ok: errors.length === 0, url, errors, warnings };
      }

      return { ok: false, url: '', errors: ['Неизвестный протокол'], warnings: [] };
    }

    function openGeneratorModal() {
      // Sync selects from main hints for convenience
      try {
        const mainProto = $('outbounds-proto');
        const mainType = $('outbounds-type');
        const mainSec = $('outbounds-security');

        const gp = $('outbounds-gen-proto');
        const gt = $('outbounds-gen-type');
        const gs = $('outbounds-gen-security');

        if (gp && mainProto && mainProto.value) {
          const v = String(mainProto.value || '').toLowerCase();
          // Normalize hysteria/hysteria2 to hy2
          gp.value = (v === 'hysteria2' || v === 'hysteria') ? 'hy2' : v;
        }
        if (gt && mainType && mainType.value) gt.value = mainType.value;
        if (gs && mainSec && mainSec.value) gs.value = mainSec.value;

        // defaults
        const portEl = $('outbounds-gen-port');
        if (portEl && !String(portEl.value || '').trim()) portEl.value = '443';
      } catch (e) {}

      try {
        const preview = $('outbounds-gen-preview');
        if (preview) preview.value = '';
        const insertBtn = $('outbounds-gen-insert-btn');
        if (insertBtn) insertBtn.disabled = true;
        const statusEl = $('outbounds-gen-status');
        if (statusEl) statusEl.textContent = '';
      } catch (e) {}

      // Auto-prefill from current input (if it is a supported link)
      try {
        const input = $('outbounds-url');
        const current = input ? String(input.value || '').trim() : '';
        const prefillBtn = $('outbounds-gen-prefill-btn');
        if (prefillBtn) prefillBtn.disabled = !current;
        if (current) {
          const ok = prefillGeneratorFromUrl(current);
          if (ok) {
            // Immediately build a preview link (canonical form) so user can insert right away.
            try { generatorGenerate(); } catch (e) {}

            // If generator did not output anything (rare), show a small hint.
            const statusEl = $('outbounds-gen-status');
            const previewEl = $('outbounds-gen-preview');
            if (statusEl && previewEl && !String(previewEl.value || '').trim() && !String(statusEl.textContent || '').trim()) {
              statusEl.textContent = '↩️ Поля заполнены из текущей ссылки.';
            }
          }
        }
      } catch (e) {}

      updateGeneratorVisibility();
      showGeneratorModal(true);

      try {
        const hostEl = $('outbounds-gen-host');
        if (hostEl) hostEl.focus();
      } catch (e) {}
    }

    function closeGeneratorModal() {
      showGeneratorModal(false);
    }

    function renderGeneratorResult(result) {
      const statusEl = $('outbounds-gen-status');
      const previewEl = $('outbounds-gen-preview');
      const insertBtn = $('outbounds-gen-insert-btn');

      if (previewEl) previewEl.value = result && result.url ? result.url : '';

      if (insertBtn) insertBtn.disabled = !(result && result.ok && result.url);

      if (!statusEl) return;

      const errs = (result && result.errors) || [];
      const warns = (result && result.warnings) || [];

      if (errs.length) {
        statusEl.textContent = '❌ ' + errs.join(' · ');
        return;
      }
      if (warns.length) {
        statusEl.textContent = '⚠️ ' + warns.join(' · ');
        return;
      }
      statusEl.textContent = (result && result.ok) ? '✅ Ссылка собрана.' : '';
    }

    function generatorGenerate() {
      try {
        updateGeneratorVisibility();
      } catch (e) {}
      const res = buildLinkFromGenerator();
      renderGeneratorResult(res);
    }

    function generatorInsert() {
      const previewEl = $('outbounds-gen-preview');
      const input = $('outbounds-url');
      if (!previewEl || !input) return;

      const url = String(previewEl.value || '').trim();
      if (!url) return;

      input.value = url;
      try { updateHintsFromUrl(url); } catch (e) {}
      try { validateAndUpdateUI(); } catch (e) {}

      try {
        input.dispatchEvent(new Event('input', { bubbles: true }));
      } catch (e) {}

      try {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      } catch (e) {}

      closeGeneratorModal();
      try { if (typeof showToast === 'function') showToast('Ссылка вставлена в поле.', false); } catch (e) {}
    }

    function wireGeneratorModal() {
      const modal = $('outbounds-generator-modal');
      if (!modal) return;
      if (modal.dataset && modal.dataset.xkeenGenWired === '1') return;

      // Open button
      wireButton('outbounds-build-btn', openGeneratorModal);

      // Modal buttons
      wireButton('outbounds-generator-close-btn', closeGeneratorModal);
      wireButton('outbounds-gen-cancel-btn', closeGeneratorModal);
      wireButton('outbounds-gen-prefill-btn', () => {
        try {
          const input = $('outbounds-url');
          const current = input ? String(input.value || '').trim() : '';
          if (!current) {
            const statusEl = $('outbounds-gen-status');
            if (statusEl) statusEl.textContent = 'Поле ссылки на странице пустое.';
            return;
          }
          const ok = prefillGeneratorFromUrl(current);
          updateGeneratorVisibility();
          if (ok) {
            // Immediately rebuild preview so user can insert right away.
            try { generatorGenerate(); } catch (e) {}
            const statusEl = $('outbounds-gen-status');
            if (statusEl) {
              const prev = String(statusEl.textContent || '').trim();
              if (!prev) statusEl.textContent = '↩️ Заполнено из поля.';
              else if (!prev.includes('Заполнено из поля')) statusEl.textContent = prev + '  ↩️ Заполнено из поля.';
            }
          } else {
            const statusEl = $('outbounds-gen-status');
            if (statusEl) statusEl.textContent = '⚠️ Не удалось распознать ссылку из поля.';
          }
        } catch (e) {}
      });
      wireButton('outbounds-gen-generate-btn', generatorGenerate);
      wireButton('outbounds-gen-insert-btn', generatorInsert);

      const onChange = () => {
        try { updateGeneratorVisibility(); } catch (e) {}
      };

      ['outbounds-gen-proto','outbounds-gen-type','outbounds-gen-security'].forEach((id) => {
        const el = $(id);
        if (el) el.addEventListener('change', onChange);
      });

      // Esc closes modal
      document.addEventListener('keydown', (e) => {
        if (!e) return;
        if (e.key !== 'Escape') return;
        try {
          const m = $('outbounds-generator-modal');
          if (m && !m.classList.contains('hidden')) closeGeneratorModal();
        } catch (e2) {}
      });

      if (modal.dataset) modal.dataset.xkeenGenWired = '1';
    }


    function init() {
      const hasAny =
        $('outbounds-body') ||
        $('outbounds-save-btn') ||
        $('outbounds-url');

      if (!hasAny) return;
      if (inited) return;
      inited = true;

      setCollapsedFromStorage();
      wireHeader('outbounds-header', toggleCard);

      // Buttons
      wireButton('outbounds-save-btn', save);
      wireButton('outbounds-normalize-btn', normalizeCurrentUrl);
      wireButton('outbounds-backup-btn', backup);
      wireButton('outbounds-restore-auto-btn', () => {
        try {
          if (window.XKeen && XKeen.backups && typeof XKeen.backups.restoreAuto === 'function') {
            XKeen.backups.restoreAuto('outbounds');
          } else {
            if (typeof showToast === 'function') showToast('Модуль бэкапов не загружен.', true);
          }
        } catch (e) {}
      });
      wireButton('outbounds-open-editor-btn', () => {
        try {
          if (window.XKeen && XKeen.jsonEditor && typeof XKeen.jsonEditor.open === 'function') {
            XKeen.jsonEditor.open('outbounds');
          } else {
            if (typeof showToast === 'function') showToast('Модуль JSON-редактора не загружен.', true);
          }
        } catch (e) {}
      });

      // Initial load
      wireHints();
      wireGeneratorModal();
      load();
    }

    return {
      init,
      load,
      save,
      backup,
      toggleCard,
    };
  })();
})();
