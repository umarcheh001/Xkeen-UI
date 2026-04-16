import { getBackupsApi } from './backups.js';
import { getRestartLogApi } from './restart_log.js';
import {
  getXkeenFilePath,
  getXkeenUiConfigShellApi,
  openXkeenJsonEditor,
  syncXkeenBodyScrollLock,
  toastXkeen,
} from './xkeen_runtime.js';

let outboundsModuleApi = null;

(() => {
  // Outbounds editor for 04_outbounds.json (VLESS URL helper)
  // API:
  //  - GET  /api/outbounds  -> { url: "vless://..." } or {}
  //  - POST /api/outbounds  -> { ok:true, restarted?:bool }
  //
  // This module owns:
  //  - wiring of UI buttons + collapse state
  //  - load/save calls
  //  - backup button call (/api/backup-outbounds)

  outboundsModuleApi = (() => {
    let inited = false;
    let _savedUrl = '';

    // Active outbounds fragment file (basename or absolute). Controlled by dropdown.
    let _activeFragment = null;
    let _fragmentItems = [];
    let _fragmentDir = '';
    let _featureLifecycle = null;
    let _subscriptionOutputFiles = null;
    let _subscriptionOutputFilesTs = 0;

    const IDS = {
      fragmentSelect: 'outbounds-fragment-select',
      fragmentRefresh: 'outbounds-fragment-refresh-btn',
      fileCode: 'outbounds-file-code',
    };

    function $(id) {
      return document.getElementById(id);
    }

    function getConfigShellApi() {
      return getXkeenUiConfigShellApi();
    }

    function refreshRestartLog() {
      try {
        const api = getRestartLogApi();
        if (api && typeof api.load === 'function') return api.load();
      } catch (e) {}
      return null;
    }

    async function streamRestartJob(jobId, intro) {
      const api = getRestartLogApi();
      if (!api || !jobId || typeof api.streamJob !== 'function') return null;
      return api.streamJob(String(jobId), {
        clear: true,
        reveal: true,
        intro: String(intro || ''),
        maxWaitMs: 5 * 60 * 1000,
      });
    }

    function getFeatureLifecycle() {
      if (_featureLifecycle) return _featureLifecycle;
      const shell = getConfigShellApi();
      if (!shell) return null;
      const factory = (typeof shell.getFeatureLifecycle === 'function')
        ? shell.getFeatureLifecycle
        : shell.createFeatureLifecycle;
      if (typeof factory !== 'function') return null;
      try {
        _featureLifecycle = factory.call(shell, 'outbounds', {
          label: 'Outbounds',
          fileCodeId: IDS.fileCode,
          dirtySourceName: 'form',
        });
      } catch (e) {
        _featureLifecycle = null;
      }
      return _featureLifecycle;
    }

    function publishLifecycleState(patch, reason) {
      const lifecycle = getFeatureLifecycle();
      if (!lifecycle || typeof lifecycle.publish !== 'function') return null;
      try {
        return lifecycle.publish(patch || {}, reason || 'outbounds-state');
      } catch (e) {}
      return null;
    }

    function syncShellState(dir, items) {
      if (dir != null) _fragmentDir = String(dir || '');
      if (Array.isArray(items)) _fragmentItems = items.slice();

      const lifecycle = getFeatureLifecycle();
      if (!lifecycle || typeof lifecycle.syncTab !== 'function') return null;

      try {
        return lifecycle.syncTab({
          label: 'Outbounds',
          fileCodeId: IDS.fileCode,
          dir: _fragmentDir,
          items: _fragmentItems,
          activeFragment: getActiveFragment(),
        });
      } catch (e) {}
      return null;
    }

    function decorateFragmentName(name) {
      const value = String(name || '');
      if (!value) return '';
      if (/_hys2\.json$/i.test(value)) return value + ' (Hysteria2)';
      return value;
    }

    function applyActiveFragment(name, dir, items) {
      _activeFragment = name ? String(name) : null;
      if (_activeFragment) rememberActiveFragment(_activeFragment);
      const nextDir = (dir != null) ? String(dir || '') : _fragmentDir;
      const cleanDir = nextDir ? String(nextDir).replace(/\/+$/, '') : '';
      try {
        updateActiveFileLabel((cleanDir ? cleanDir + '/' : '') + (_activeFragment || ''), cleanDir);
      } catch (e) {}
      try { syncShellState(cleanDir, Array.isArray(items) ? items : null); } catch (e2) {}
      return _activeFragment;
    }

    function restoreFragmentSelection(sel, fragment, dir, items) {
      const selectEl = sel || $(IDS.fragmentSelect);
      const value = String(fragment || '').trim();
      if (!selectEl || !value) return;

      let opt = null;
      try {
        opt = Array.from(selectEl.options || []).find((item) => String(item.value || '') === value) || null;
      } catch (e) {}

      if (!opt) {
        try {
          opt = document.createElement('option');
          opt.value = value;
          opt.textContent = decorateFragmentName(value) + ' (текущий)';
          selectEl.appendChild(opt);
        } catch (e2) {}
      }

      try { selectEl.value = value; } catch (e3) {}
      applyActiveFragment(value, dir, items);
    }

    async function guardFragmentSwitch(next, prev, opts) {
      const config = (opts && typeof opts === 'object') ? opts : {};
      const lifecycle = getFeatureLifecycle();
      if (!lifecycle || typeof lifecycle.guardSwitch !== 'function') {
        if (typeof config.commit === 'function') {
          await Promise.resolve(config.commit());
        }
        return true;
      }
      return lifecycle.guardSwitch(Object.assign({
        currentValue: String(prev || ''),
        nextValue: String(next || ''),
        title: 'Несохранённые изменения',
        message: 'Во вкладке outbounds есть несохранённые изменения. Переключить файл и потерять их?',
        okText: 'Переключить',
        cancelText: 'Остаться',
      }, config));
    }

    function getCurrentUrl() {
      try {
        const input = $('outbounds-url');
        return input ? String(input.value || '').trim() : '';
      } catch (e) {}
      return '';
    }

    function syncDirtyUi(dirty) {
      try {
        const saveBtn = $('outbounds-save-btn');
        if (saveBtn) saveBtn.classList.toggle('dirty', !!dirty);
      } catch (e) {}
    }

    function syncDirtyState(forceDirty) {
      const currentValue = String(getCurrentUrl() || '');
      const savedValue = String(_savedUrl || '');
      const dirty = (typeof forceDirty === 'boolean')
        ? !!forceDirty
        : (currentValue !== savedValue);

      syncDirtyUi(dirty);

      const dirtyOpts = {
        sourceName: 'form',
        scopeLabel: 'Outbounds',
        confirmTitle: 'Несохранённые изменения',
        confirmMessage: 'Во вкладке outbounds есть несохранённые изменения. Переключить файл и потерять их?',
        okText: 'Переключить',
        cancelText: 'Остаться',
        label: 'Ссылка outbounds',
        summary: dirty ? 'Текущая ссылка отличается от последней сохранённой версии.' : '',
        currentValue,
        savedValue,
      };

      const lifecycle = getFeatureLifecycle();
      if (lifecycle && typeof lifecycle.setDirty === 'function') {
        try {
          lifecycle.setDirty(dirty, dirtyOpts);
        } catch (e) {}
      }

      return dirty;
    }

    function getSelectedFragmentFromUI() {
      try {
        const sel = $(IDS.fragmentSelect);
        if (sel && sel.value) return String(sel.value);
      } catch (e) {}
      return null;
    }

    function rememberActiveFragment(name) {
      try {
        if (name) localStorage.setItem('xkeen.outbounds.fragment', String(name));
      } catch (e) {}
    }

    function restoreRememberedFragment() {
      try {
        const v = localStorage.getItem('xkeen.outbounds.fragment');
        if (v) return String(v);
      } catch (e) {}
      return null;
    }

    function getActiveFragment() {
      return getSelectedFragmentFromUI() || _activeFragment || restoreRememberedFragment() || null;
    }

    function updateActiveFileLabel(fullPathOrName, configsDir) {
      const codeEl = $(IDS.fileCode);
      if (!codeEl) return;
      const v = String(fullPathOrName || '');
      if (v) {
        codeEl.textContent = v;
        return;
      }
      try {
        const f = getActiveFragment();
        if (f && configsDir) {
          codeEl.textContent = String(configsDir).replace(/\/+$/, '') + '/' + f;
        } else if (f) {
          codeEl.textContent = f;
        }
      } catch (e) {}
    }

    function baseName(value) {
      try {
        const parts = String(value || '').split(/[\\/]+/);
        return String(parts[parts.length - 1] || '').trim();
      } catch (e) {}
      return String(value || '').trim();
    }

    async function refreshSubscriptionOutputFiles(force) {
      const now = Date.now();
      if (!force && _subscriptionOutputFiles && (now - _subscriptionOutputFilesTs) < 15000) {
        return _subscriptionOutputFiles;
      }
      const files = new Set();
      try {
        const res = await fetch('/api/xray/subscriptions', { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        const items = Array.isArray(data && data.subscriptions) ? data.subscriptions : [];
        items.forEach((sub) => {
          const name = baseName(sub && sub.output_file);
          if (name) files.add(name);
        });
      } catch (e) {}
      _subscriptionOutputFiles = files;
      _subscriptionOutputFilesTs = now;
      return files;
    }

    function getConfigOutbounds(cfg) {
      if (Array.isArray(cfg)) return cfg;
      if (cfg && typeof cfg === 'object' && Array.isArray(cfg.outbounds)) return cfg.outbounds;
      return [];
    }

    function isProxyOutbound(ob) {
      if (!ob || typeof ob !== 'object') return false;
      const protocol = String(ob.protocol || '').trim().toLowerCase();
      if (!protocol) return false;
      return !['freedom', 'blackhole', 'dns', 'loopback'].includes(protocol);
    }

    function summarizeOutboundsConfig(cfg) {
      const outbounds = getConfigOutbounds(cfg);
      const proxies = outbounds.filter(isProxyOutbound);
      const protocolCounts = {};
      const tags = [];
      proxies.forEach((ob) => {
        const protocol = String(ob.protocol || '').trim() || 'proxy';
        protocolCounts[protocol] = (protocolCounts[protocol] || 0) + 1;
        const tag = String(ob.tag || '').trim();
        if (tag) tags.push(tag);
      });
      return { outbounds, proxies, protocolCounts, tags };
    }

    function renderOutboundsFragmentSummary(fileName, summary) {
      const el = $('outbounds-fragment-summary');
      if (!el) return;
      const s = summary || summarizeOutboundsConfig(null);
      const protocols = Object.keys(s.protocolCounts || {})
        .sort()
        .map((key) => `${escapeHtml(key)} × ${Number(s.protocolCounts[key] || 0)}`)
        .join(' · ');
      const tags = (s.tags || []).map((tag) => `<code>${escapeHtml(tag)}</code>`).join('')
        || '<span class="outbounds-fragment-empty">Теги не найдены</span>';
      el.innerHTML = `
        <div class="outbounds-fragment-summary-head">
          <div>
            <div class="outbounds-fragment-summary-title">Сгенерированный фрагмент подписки</div>
            <div class="outbounds-fragment-summary-file"><code>${escapeHtml(fileName || '04_outbounds.*.json')}</code></div>
          </div>
          <div class="outbounds-fragment-count">${Number((s.proxies || []).length)} прокси</div>
        </div>
        <div class="outbounds-fragment-summary-meta">${protocols || 'outbounds подписки'}</div>
        <div class="outbounds-fragment-tags">${tags}</div>
      `;
    }

    function setSubscriptionFragmentMode(enabled, fileName, summary) {
      const body = $('outbounds-body');
      const input = $('outbounds-url');
      const summaryEl = $('outbounds-fragment-summary');
      try { if (body) body.classList.toggle('xk-outbounds-subscription-fragment', !!enabled); } catch (e) {}

      if (enabled) {
        if (input) {
          input.value = '';
          input.classList.remove('xk-invalid');
        }
        try { renderParsePreview({ ok: false, scheme: '', fields: {}, errors: [], warnings: [] }); } catch (e) {}
        renderOutboundsFragmentSummary(fileName, summary);
        try { if (summaryEl) summaryEl.classList.remove('hidden'); } catch (e2) {}
      } else {
        try { if (summaryEl) summaryEl.classList.add('hidden'); } catch (e) {}
      }
    }

    function isSubscriptionFragmentMode() {
      const body = $('outbounds-body');
      try { return !!(body && body.classList.contains('xk-outbounds-subscription-fragment')); } catch (e) {}
      return false;
    }

    async function isSubscriptionOutputFragment(fileName) {
      const name = baseName(fileName);
      if (!name) return false;
      const files = await refreshSubscriptionOutputFiles(false);
      return !!(files && files.has(name));
    }

    async function refreshFragmentsList(opts) {
      const sel = $(IDS.fragmentSelect);
      if (!sel) return;

      const notify = !!(opts && opts.notify);

      let data = null;
      try {
        const res = await fetch('/api/outbounds/fragments', { cache: 'no-store' });
        data = await res.json().catch(() => null);
      } catch (e) {
        data = null;
      }
      if (!data || !data.ok || !Array.isArray(data.items)) {
        try { if (notify) toastXkeen('Не удалось обновить список outbounds', 'error'); } catch (e) {}
        return;
      }

      const currentDefault = (data.current || sel.dataset.current || '').toString();
      const remembered = restoreRememberedFragment();
      const preferred = (getActiveFragment() || remembered || currentDefault || (data.items[0] ? data.items[0].name : '')).toString();

      try { if (sel.dataset) sel.dataset.dir = String(data.dir || ''); } catch (e) {}
      sel.innerHTML = '';

      const names = data.items.map((it) => String(it.name || '')).filter(Boolean);
      if (currentDefault && names.indexOf(currentDefault) === -1) {
        const opt = document.createElement('option');
        opt.value = currentDefault;
        opt.textContent = decorateFragmentName(currentDefault) + ' (текущий)';
        sel.appendChild(opt);
      }

      data.items.forEach((it) => {
        const name = String(it.name || '');
        if (!name) return;
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = decorateFragmentName(name);
        sel.appendChild(opt);
      });

      try {
        const finalChoice = names.indexOf(preferred) !== -1 ? preferred : (currentDefault || (names[0] || ''));
        if (finalChoice) sel.value = finalChoice;
        const dir = data.dir ? String(data.dir).replace(/\/+$/, '') : '';
        applyActiveFragment(sel.value || finalChoice || null, dir, data.items);
      } catch (e) {}

      // Wire refresh button
      try {
        const btn = $(IDS.fragmentRefresh);
        if (btn && !btn.dataset.xkWired) {
          btn.addEventListener('click', async (e) => {
            e.preventDefault();
            const prev = getActiveFragment();
            const prevDir = _fragmentDir;
            await refreshFragmentsList({ notify: true });
            const next = getActiveFragment();
            if (!next || next === prev) return;
            await guardFragmentSwitch(next, prev, {
              onCancel: () => restoreFragmentSelection(sel, prev, prevDir, _fragmentItems),
              commit: async () => { await load(); },
            });
          });
          btn.dataset.xkWired = '1';
        }
      } catch (e) {}

      // Success toast (only when explicitly requested)
      try { if (notify) toastXkeen('Список outbounds обновлён', 'success'); } catch (e) {}

      // Wire select change
      try {
        if (!sel.dataset.xkWired) {
          sel.addEventListener('change', async () => {
            const next = String(sel.value || '');
            if (!next) return;
            const prev = _activeFragment || String(sel.dataset.current || '');
            const dir = sel.dataset && sel.dataset.dir ? String(sel.dataset.dir) : _fragmentDir;
            await guardFragmentSwitch(next, prev, {
              onCancel: () => restoreFragmentSelection(sel, prev, dir, _fragmentItems),
              commit: async () => {
                applyActiveFragment(next, dir);
                await load();
              },
            });
          });
          sel.dataset.xkWired = '1';
        }
      } catch (e) {}
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

    function bindConfigAction(btnId, handler, opts) {
      const lifecycle = getFeatureLifecycle();
      if (!lifecycle || typeof lifecycle.bindAction !== 'function') return false;
      try {
        return !!lifecycle.bindAction(btnId, handler, opts || {});
      } catch (e) {}
      return false;
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
        try { syncDirtyState(); } catch (e) {}
        return;
      }

      const parsed = parseProxyUrl(url);

      renderParsePreview(parsed);

      if (parsed.ok) {
        input.classList.remove('xk-invalid');
        if (saveBtn) saveBtn.disabled = false;
      } else {
        input.classList.add('xk-invalid');
        if (saveBtn) saveBtn.disabled = true;
      }
      try { syncDirtyState(); } catch (e) {}
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
      if (isSubscriptionFragmentMode()) {
        if (statusEl) statusEl.textContent = 'Подписочный фрагмент нельзя нормализовать как одну ссылку. Откройте JSON-редактор или модал подписок.';
        return;
      }

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

      publishLifecycleState({ loading: true, initialized: false }, 'outbounds-load-start');
      try {
        const file = getActiveFragment();
        const url = file ? ('/api/outbounds?file=' + encodeURIComponent(file)) : '/api/outbounds';
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) {
          if (statusEl) statusEl.textContent = 'Не удалось загрузить outbounds.';
          return;
        }
        const data = await res.json().catch(() => ({}));
        const fileName = baseName((data && data.file) || file || '');
        const summary = summarizeOutboundsConfig(data && data.config);
        const isSubscriptionFragment = await isSubscriptionOutputFragment(fileName);

        if (isSubscriptionFragment) {
          _savedUrl = '';
          setSubscriptionFragmentMode(true, fileName, summary);
          try { syncDirtyState(false); } catch (e) {}
          publishLifecycleState({
            savedValue: '',
            currentValue: '',
            initialized: true,
          }, 'outbounds-load-subscription-fragment');
          if (statusEl) {
            statusEl.textContent = `Подписочный фрагмент загружен: ${summary.proxies.length} прокси. Для правок используйте «Подписки» или JSON-редактор.`;
          }
          try {
            if (typeof updateLastActivity === 'function') {
              const fp = getXkeenFilePath('outbounds', '');
              updateLastActivity('loaded', 'outbounds', fp);
            }
          } catch (e) {}
          return;
        }

        setSubscriptionFragmentMode(false, fileName, summary);
        if (data && data.url) {
          _savedUrl = String(data.url || '');
          input.value = _savedUrl;
          updateHintsFromUrl(_savedUrl);
          validateAndUpdateUI();
          publishLifecycleState({
            savedValue: String(_savedUrl || ''),
            currentValue: String(getCurrentUrl() || _savedUrl || ''),
            initialized: true,
          }, 'outbounds-load-success');
          if (statusEl) statusEl.textContent = 'Текущая ссылка загружена.';
          try {
            if (typeof updateLastActivity === 'function') {
              const fp = getXkeenFilePath('outbounds', '');
              updateLastActivity('loaded', 'outbounds', fp);
            }
          } catch (e) {}
        } else {
          _savedUrl = '';
          input.value = '';
          if (statusEl) statusEl.textContent = 'Файл outbounds отсутствует или не содержит прокси-конфиг.';
          updateHintsFromUrl('');
          validateAndUpdateUI();
          publishLifecycleState({
            savedValue: '',
            currentValue: String(getCurrentUrl() || ''),
            initialized: true,
          }, 'outbounds-load-empty');
          try {
            if (typeof updateLastActivity === 'function') {
              const fp = getXkeenFilePath('outbounds', '');
              updateLastActivity('loaded', 'outbounds', fp);
            }
          } catch (e) {}
        }
      } catch (e) {
        console.error(e);
        if (statusEl) statusEl.textContent = 'Ошибка загрузки outbounds.';
      } finally {
        publishLifecycleState({ loading: false, initialized: true }, 'outbounds-load-finished');
      }
    }

    async function save() {
      const statusEl = $('outbounds-status');
      const input = $('outbounds-url');
      if (!input) return;
      if (isSubscriptionFragmentMode()) {
        if (statusEl) statusEl.textContent = 'Подписочный фрагмент не сохраняется через single-link форму. Используйте «Подписки» или JSON-редактор.';
        return;
      }

      publishLifecycleState({ saving: true, initialized: true }, 'outbounds-save-start');
      let streamedRestart = false;
      try {
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
          const file = getActiveFragment();
          const restart = shouldRestartAfterSave();
          const params = new URLSearchParams();
          if (file) params.set('file', file);
          if (restart) params.set('async', '1');
          const apiUrl = '/api/outbounds' + (params.toString() ? ('?' + params.toString()) : '');
          const res = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, restart }),
          });
          const data = await res.json().catch(() => ({}));

          if (res.ok && data && data.ok) {
            let msg = 'Outbounds сохранены.';
            if (statusEl) statusEl.textContent = msg;
            _savedUrl = url;
            try { syncDirtyState(false); } catch (e) {}
            publishLifecycleState({
              savedValue: String(_savedUrl || ''),
              currentValue: String(getCurrentUrl() || _savedUrl || ''),
            }, 'outbounds-save-success');
            try {
              if (typeof updateLastActivity === 'function') {
                const fp = getXkeenFilePath('outbounds', '');
                updateLastActivity('saved', 'outbounds', fp);
              }
            } catch (e) {}

            const jobId = (data && (data.restart_job_id || data.job_id || data.restartJobId))
              ? String(data.restart_job_id || data.job_id || data.restartJobId)
              : '';

            if (restart && jobId) {
              streamedRestart = true;
              if (statusEl) statusEl.textContent = 'Outbounds сохранены. Перезапуск xkeen...';
              const result = await streamRestartJob(jobId, 'xkeen -restart (job)...\n');
              const ok = !!(result && result.ok);
              if (ok) {
                msg = 'Outbounds сохранены и xkeen перезапущен.';
                if (statusEl) statusEl.textContent = msg;
                try { toastXkeen(msg, 'success'); } catch (e) {}
              } else {
                const err = (result && (result.error || result.message)) ? String(result.error || result.message) : '';
                const exitCode = (result && typeof result.exit_code === 'number') ? result.exit_code : null;
                const detail = err
                  ? ('Ошибка: ' + err)
                  : (exitCode !== null ? ('Ошибка (exit_code=' + exitCode + ')') : '');
                const restartLog = getRestartLogApi();
                if (detail && restartLog && typeof restartLog.append === 'function') {
                  try { restartLog.append('\n' + detail + '\n'); } catch (e) {}
                }
                msg = 'Outbounds сохранены, но перезапуск xkeen завершился с ошибкой.';
                if (statusEl) statusEl.textContent = msg;
                try { toastXkeen(msg, 'error'); } catch (e2) {}
              }
            } else {
              try { if (!data || !data.restarted) { if (typeof showToast === 'function') showToast(msg, false); } } catch (e) {}
            }
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
          if (!streamedRestart) {
            try { refreshRestartLog(); } catch (e) {}
          }
        }
      } finally {
        publishLifecycleState({ saving: false, initialized: true }, 'outbounds-save-finished');
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

      const fileLabel = _baseName(getXkeenFilePath('outbounds', ''), '04_outbounds.json');

      try {
        const file = getActiveFragment();
        const url = file ? ('/api/backup-outbounds?file=' + encodeURIComponent(file)) : '/api/backup-outbounds';
        const res = await fetch(url, { method: 'POST' });
        const data = await res.json().catch(() => ({}));

        if (res.ok && data && data.ok) {
          const msg = 'Бэкап ' + fileLabel + ' создан: ' + (data.filename || '');
          if (statusEl) statusEl.textContent = msg;
          if (backupsStatusEl) backupsStatusEl.textContent = '';
          try { if (typeof showToast === 'function') showToast(msg, false); } catch (e) {}
          try {
            const backupsApi = getBackupsApi();
            if (backupsApi) {
              if (typeof backupsApi.refresh === 'function') await backupsApi.refresh();
              else if (typeof backupsApi.load === 'function') await backupsApi.load();
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
      const raw = (value === undefined || value === null) ? '' : String(value).trim();
      const v = raw.toLowerCase();
      try {
        // Only set if option exists. Empty value is allowed when select has an explicit blank option.
        const ok = Array.from(el.options || []).some(o => String(o.value || '').trim().toLowerCase() === v);
        if (ok) el.value = raw;
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
      try { syncXkeenBodyScrollLock(!!show); } catch (e) {}
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

    function updateGeneratorSummary() {
      const el = $('outbounds-gen-summary');
      if (!el) return;
      const proto = getResolvedGenProto();
      const type = (proto === 'hy2') ? 'HY2' : resolveGenType().toUpperCase();
      const sec = (proto === 'hy2') ? 'TLS' : resolveGenSecurity(proto);
      const protoLabelMap = { vless: 'VLESS', trojan: 'Trojan', vmess: 'VMess', ss: 'SS', hy2: 'HY2' };
      const secLabelMap = { none: 'None', tls: 'TLS', reality: 'Reality' };
      const protoLabel = protoLabelMap[proto] || String(proto || 'auto').toUpperCase();
      const secLabel = secLabelMap[String(sec || '').toLowerCase()] || String(sec || '').toUpperCase() || 'Auto';
      el.textContent = proto === 'hy2' ? `${protoLabel} · QUIC · ${secLabel}` : `${protoLabel} · ${type} · ${secLabel}`;
    }

    function markGeneratorDirty() {
      const previewEl = $('outbounds-gen-preview');
      const insertBtn = $('outbounds-gen-insert-btn');
      const statusEl = $('outbounds-gen-status');
      const modal = $('outbounds-generator-modal');
      if (!modal || modal.classList.contains('hidden')) return;
      updateGeneratorSummary();
      if (previewEl && String(previewEl.value || '').trim()) {
        previewEl.value = '';
        if (insertBtn) insertBtn.disabled = true;
        if (statusEl) statusEl.textContent = 'Изменены поля — нажмите «Собрать», чтобы обновить ссылку.';
      }
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
      if (isSubscriptionFragmentMode()) {
        try { toastXkeen('Мини-генератор работает только с одиночной proxy-ссылкой, не со сгенерированным фрагментом подписки.', 'error'); } catch (e) {}
        return;
      }
      updateGeneratorSummary();
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
        const prefillHint = $('outbounds-gen-prefill-hint');
        if (prefillHint) prefillHint.textContent = current ? 'Можно взять данные из текущего поля' : 'Основное поле сейчас пустое';
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
      updateGeneratorSummary();
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
        updateGeneratorSummary();
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
        try {
          updateGeneratorVisibility();
          markGeneratorDirty();
        } catch (e) {}
      };

      ['outbounds-gen-proto','outbounds-gen-type','outbounds-gen-security'].forEach((id) => {
        const el = $(id);
        if (el) el.addEventListener('change', onChange);
      });

      Array.from(modal.querySelectorAll('input, select, textarea')).forEach((el) => {
        if (!el || el.id === 'outbounds-gen-preview') return;
        const evt = (el.tagName === 'SELECT') ? 'change' : 'input';
        el.addEventListener(evt, () => {
          try { markGeneratorDirty(); } catch (e) {}
        });
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


    // --- Proxy pool (multiple links) ---

    const POOL_IDS = {
      modal: 'outbounds-pool-modal',
      open: 'outbounds-pool-btn',
      close: 'outbounds-pool-close-btn',
      cancel: 'outbounds-pool-cancel-btn',
      input: 'outbounds-pool-input',
      add: 'outbounds-pool-add-btn',
      clear: 'outbounds-pool-clear-btn',
      tbody: 'outbounds-pool-tbody',
      save: 'outbounds-pool-save-btn',
      replace: 'outbounds-pool-replace',
      status: 'outbounds-pool-status',
      existing: 'outbounds-pool-existing',
      summary: 'outbounds-pool-summary',
      empty: 'outbounds-pool-empty',
    };

    let _poolEntries = [];

    const POOL_RESERVED = new Set([
      'direct','block','dns',
      'freedom','blackhole','reject','bypass',
      'api','xray-api','metrics',
    ]);

    function poolShow(show) {
      const modal = $(POOL_IDS.modal);
      if (!modal) return;
      try {
        if (show) modal.classList.remove('hidden');
        else modal.classList.add('hidden');
      } catch (e) {}
      try { syncXkeenBodyScrollLock(!!show); } catch (e) {}
    }

    function poolSetStatus(msg, isErr) {
      const el = $(POOL_IDS.status);
      if (!el) return;
      try {
        el.textContent = String(msg || '');
        el.style.color = isErr ? 'var(--danger, #ef4444)' : '';
      } catch (e) {}
    }


    function poolResetDraft() {
      _poolEntries = [];
      try {
        const input = $(POOL_IDS.input);
        if (input) input.value = '';
      } catch (e) {}
      try {
        const replace = $(POOL_IDS.replace);
        if (replace) replace.checked = false;
      } catch (e) {}
      poolSetStatus('', false);
      try { poolRenderTable(); } catch (e) {}
    }

    function poolSyncUiState() {
      const summary = $(POOL_IDS.summary);
      const empty = $(POOL_IDS.empty);
      const saveBtn = $(POOL_IDS.save);
      let ready = 0;
      let total = 0;
      try {
        total = Array.isArray(_poolEntries) ? _poolEntries.length : 0;
        ready = _poolEntries.filter((e) => String((e && e.url) || '').trim()).length;
      } catch (e) {}
      try {
        if (summary) {
          summary.textContent = `${total} строк · ${ready} tag`;
        }
      } catch (e) {}
      try {
        if (empty) empty.style.display = total ? 'none' : 'block';
      } catch (e) {}
      try {
        if (saveBtn) saveBtn.disabled = !ready;
      } catch (e) {}
    }

    function poolSanitizeTag(tag) {
      let t = String(tag || '').trim();
      // Remove whitespace and unsafe chars (keep a-zA-Z0-9._:-)
      t = t.replace(/\s+/g, '_').replace(/[^A-Za-z0-9._:-]+/g, '_');
      t = t.replace(/^_+/, '').replace(/_+$/, '');
      return t;
    }

    function poolSuggestTagFromUrl(url, fallbackIdx) {
      const raw = String(url || '').trim();
      if (!raw) return 'p' + String(fallbackIdx || 1);

      // 1) Prefer #fragment
      try {
        const hashIdx = raw.indexOf('#');
        if (hashIdx >= 0 && hashIdx < raw.length - 1) {
          const frag = safeDecodeURIComponent(raw.slice(hashIdx + 1));
          const t1 = poolSanitizeTag(frag);
          if (t1) return t1;
        }
      } catch (e) {}

      // 2) Try host
      try {
        const u = new URL(raw);
        const host = (u.hostname || '').toString();
        const port = (u.port || '').toString();
        const base = host + (port ? ('_' + port) : '');
        const t2 = poolSanitizeTag(base);
        if (t2) return t2;
      } catch (e) {}

      return 'p' + String(fallbackIdx || 1);
    }

    function poolEnsureUniqueTag(tag, existingSet) {
      let t = String(tag || '').trim();
      if (!t) t = 'p1';
      if (!existingSet) existingSet = new Set();
      const base = t;
      let k = 2;
      while (existingSet.has(t) || POOL_RESERVED.has(String(t).toLowerCase())) {
        t = base + '-' + String(k++);
      }
      return t;
    }

    function poolParseLines(text) {
      const lines = String(text || '').split(/\r?\n/).map((s) => String(s || '').trim()).filter(Boolean);
      const parsed = [];

      lines.forEach((line, idx) => {
        let tag = '';
        let url = '';

        // Formats:
        //  - tag | url
        //  - tag = url
        //  - url
        // Important: raw vmess/vless links may contain '=' inside the URL,
        // so treat '=' as a tag separator only when it appears before the scheme.
        const pipeIdx = line.indexOf('|');
        const eqIdx = line.indexOf('=');
        const schemeIdx = line.indexOf('://');

        if (pipeIdx > 0 && (schemeIdx === -1 || pipeIdx < schemeIdx)) {
          tag = line.slice(0, pipeIdx).trim();
          url = line.slice(pipeIdx + 1).trim();
        } else if (eqIdx > 0 && (schemeIdx === -1 || eqIdx < schemeIdx)) {
          const left = line.slice(0, eqIdx).trim();
          const right = line.slice(eqIdx + 1).trim();
          if (right.includes('://')) {
            tag = left;
            url = right;
          } else {
            url = line;
          }
        } else {
          url = line;
        }

        if (!url) return;

        const explicitTag = !!poolSanitizeTag(tag);
        tag = poolSanitizeTag(tag);
        if (!tag) tag = poolSuggestTagFromUrl(url, idx + 1);

        parsed.push({ tag, url, explicitTag });
      });

      return parsed;
    }

    function poolRenderTable() {
      const tbody = $(POOL_IDS.tbody);
      if (!tbody) return;
      tbody.innerHTML = '';

      _poolEntries.forEach((ent, idx) => {
        const tr = document.createElement('tr');
        tr.dataset.idx = String(idx);

        const tdTag = document.createElement('td');
        tdTag.style.padding = '8px';
        const inTag = document.createElement('input');
        inTag.type = 'text';
        inTag.value = String(ent.tag || '');
        inTag.className = 'xray-log-filter';
        inTag.style.width = '100%';
        inTag.addEventListener('change', () => {
          const v = poolSanitizeTag(inTag.value);
          _poolEntries[idx].tag = v;
          inTag.value = v;
          poolSyncUiState();
        });
        tdTag.appendChild(inTag);

        const tdUrl = document.createElement('td');
        tdUrl.style.padding = '8px';
        const inUrl = document.createElement('input');
        inUrl.type = 'text';
        inUrl.value = String(ent.url || '');
        inUrl.className = 'xray-log-filter';
        inUrl.style.width = '100%';
        inUrl.addEventListener('change', () => {
          _poolEntries[idx].url = String(inUrl.value || '').trim();
          poolSyncUiState();
        });
        tdUrl.appendChild(inUrl);

        const tdAct = document.createElement('td');
        tdAct.style.padding = '8px';
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'btn-secondary xk-pool-delete-btn';
        del.textContent = '✕';
        del.title = 'Удалить';
        del.setAttribute('aria-label', 'Удалить строку');
        del.addEventListener('click', () => {
          _poolEntries.splice(idx, 1);
          poolRenderTable();
        });
        tdAct.appendChild(del);

        tr.appendChild(tdTag);
        tr.appendChild(tdUrl);
        tr.appendChild(tdAct);
        tbody.appendChild(tr);
      });

      poolSyncUiState();
    }

    function poolCollectEntries() {
      // Ensure clean + unique tags
      const out = [];
      const used = new Set();
      for (let i = 0; i < _poolEntries.length; i++) {
        const e = _poolEntries[i] || {};
        const url = String(e.url || '').trim();
        if (!url) continue;
        let tag = poolSanitizeTag(e.tag || '');
        if (!tag) tag = poolSuggestTagFromUrl(url, i + 1);
        tag = poolEnsureUniqueTag(tag, used);
        used.add(tag);
        if (POOL_RESERVED.has(String(tag).toLowerCase())) continue;
        out.push({ tag, url });
      }
      return out;
    }

    async function poolRefreshExistingTagsHint() {
      const hint = $(POOL_IDS.existing);
      if (!hint) return;
      hint.textContent = '';
      let url = '/api/xray/outbound-tags';
      const f = getActiveFragment();
      if (f) url += '?file=' + encodeURIComponent(String(f));
      try {
        const res = await fetch(url, { cache: 'no-store' });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data || !data.ok || !Array.isArray(data.tags)) return;
        const tags = data.tags.map((t) => String(t || '').trim()).filter(Boolean);
        if (!tags.length) return;
        const show = tags.slice(0, 10).join(', ') + (tags.length > 10 ? ` … (+${tags.length - 10})` : '');
        hint.textContent = 'Существующие теги: ' + show;
      } catch (e) {}
    }

    async function poolSave() {
      poolSetStatus('', false);
      const entries = poolCollectEntries();
      if (!entries.length) {
        poolSetStatus('Список пустой.', true);
        return;
      }

      // Final validation (reserved + duplicates)
      const seen = new Set();
      for (const e of entries) {
        const t = String(e.tag || '').trim();
        if (!t) {
          poolSetStatus('У одной из строк пустой tag.', true);
          return;
        }
        if (POOL_RESERVED.has(t.toLowerCase())) {
          poolSetStatus('Tag зарезервирован: ' + t, true);
          return;
        }
        if (seen.has(t)) {
          poolSetStatus('Дубликат tag: ' + t, true);
          return;
        }
        seen.add(t);
      }

      const replaceCb = $(POOL_IDS.replace);
      const replacePool = !!(replaceCb && replaceCb.checked);

      let apiUrl = '/api/xray/outbounds/proxies';
      const f = getActiveFragment();
      if (f) apiUrl += '?file=' + encodeURIComponent(String(f));

      poolSetStatus('Сохраняю…', false);
      const restart = shouldRestartAfterSave();

      try {
        const requestUrl = apiUrl + (restart ? (apiUrl.indexOf('?') === -1 ? '?async=1' : '&async=1') : '');
        const res = await fetch(requestUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            entries,
            restart,
            replace_pool: replacePool,
            write_raw: true,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data || data.ok === false) {
          const err = (data && (data.error || data.message)) ? String(data.error || data.message) : 'Ошибка сохранения.';
          poolSetStatus(err, true);
          try { toastXkeen(err, 'error'); } catch (e) {}
          return;
        }

        const jobId = (data && (data.restart_job_id || data.job_id || data.restartJobId))
          ? String(data.restart_job_id || data.job_id || data.restartJobId)
          : '';

        let msg = 'Пул прокси сохранён' + (data.restarted ? ' и перезапущен.' : '.');

        if (restart && jobId) {
          poolSetStatus('Пул прокси сохранён. Перезапуск xkeen...', false);
          const result = await streamRestartJob(jobId, 'xkeen -restart (job)...\n');
          const ok = !!(result && result.ok);
          if (ok) {
            msg = 'Пул прокси сохранён и xkeen перезапущен.';
            poolSetStatus('✅ ' + msg, false);
            try { toastXkeen(msg, 'success'); } catch (e) {}
          } else {
            const err = (result && (result.error || result.message)) ? String(result.error || result.message) : '';
            const exitCode = (result && typeof result.exit_code === 'number') ? result.exit_code : null;
            const detail = err
              ? ('Ошибка: ' + err)
              : (exitCode !== null ? ('Ошибка (exit_code=' + exitCode + ')') : '');
            const restartLog = getRestartLogApi();
            if (detail && restartLog && typeof restartLog.append === 'function') {
              try { restartLog.append('\n' + detail + '\n'); } catch (e) {}
            }
            msg = 'Пул прокси сохранён, но перезапуск xkeen завершился с ошибкой.';
            poolSetStatus(msg, true);
            try { toastXkeen(msg, 'error'); } catch (e2) {}
          }
        } else {
          poolSetStatus('✅ ' + msg, false);
          try { toastXkeen(msg, 'success'); } catch (e) {}
        }

        // Refresh outbounds state on page
        try { await load(); } catch (e) {}
        poolShow(false);
      } catch (e) {
        poolSetStatus('Ошибка сети: ' + String(e || ''), true);
      }
    }

    function poolOpen() {
      poolResetDraft();
      poolShow(true);
      try { poolRefreshExistingTagsHint(); } catch (e) {}
      try { poolRenderTable(); } catch (e) {}
      try {
        const input = $(POOL_IDS.input);
        if (input) input.focus();
      } catch (e) {}
    }

    function poolClose() {
      poolShow(false);
    }

    function wirePoolModal() {
      const modal = $(POOL_IDS.modal);
      if (!modal) return;
      if (modal.dataset && modal.dataset.xkWired === '1') return;

      wireButton(POOL_IDS.open, poolOpen);
      wireButton(POOL_IDS.close, poolClose);
      wireButton(POOL_IDS.cancel, poolClose);

      wireButton(POOL_IDS.clear, () => {
        poolResetDraft();
      });

      wireButton(POOL_IDS.add, () => {
        const input = $(POOL_IDS.input);
        const text = input ? String(input.value || '') : '';
        const add = poolParseLines(text);
        if (!add.length) {
          poolSetStatus('Не нашёл строк со ссылками.', true);
          return;
        }
        // Merge into state (explicit tag -> update existing, auto tag -> keep unique)
        const byTag = new Map();
        _poolEntries.forEach((e) => {
          const t = String((e && e.tag) || '').trim();
          if (t) byTag.set(t, { tag: t, url: String((e && e.url) || '') });
        });

        const used = new Set(Array.from(byTag.keys()));
        add.forEach((e, idx) => {
          let t = poolSanitizeTag(e && e.tag);
          const url = String((e && e.url) || '').trim();
          const explicitTag = !!(e && e.explicitTag);
          if (!t) t = poolSuggestTagFromUrl(url, idx + 1);

          if (!explicitTag && used.has(t)) {
            t = poolEnsureUniqueTag(t, used);
          }

          used.add(t);
          byTag.set(t, { tag: t, url });
        });

        _poolEntries = Array.from(byTag.values());
        poolRenderTable();
        poolSetStatus(`Добавлено/обновлено: ${add.length}. Итог строк: ${_poolEntries.length}.`, false);

        try {
          if (input) {
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
          }
        } catch (e) {}
      });

      wireButton(POOL_IDS.save, poolSave);
      try { poolSyncUiState(); } catch (e) {}

      // Esc closes modal
      document.addEventListener('keydown', (e) => {
        if (!e) return;
        if (e.key !== 'Escape') return;
        try {
          const m = $(POOL_IDS.modal);
          if (m && !m.classList.contains('hidden')) poolClose();
        } catch (e2) {}
      });

      if (modal.dataset) modal.dataset.xkWired = '1';
    }

    // --- Xray subscriptions (auto-updated generated outbounds) ---

    const SUB_IDS = {
      open: 'outbounds-subscriptions-btn',
      modal: 'outbounds-subscriptions-modal',
      close: 'outbounds-subscriptions-close-btn',
      cancel: 'outbounds-subscriptions-cancel-btn',
      form: 'outbounds-subscriptions-form',
      id: 'outbounds-subscriptions-id',
      name: 'outbounds-subscriptions-name',
      tag: 'outbounds-subscriptions-tag',
      url: 'outbounds-subscriptions-url',
      interval: 'outbounds-subscriptions-interval',
      enabled: 'outbounds-subscriptions-enabled',
      ping: 'outbounds-subscriptions-ping',
      refreshNow: 'outbounds-subscriptions-refresh-now',
      save: 'outbounds-subscriptions-save-btn',
      reset: 'outbounds-subscriptions-reset-btn',
      refreshDue: 'outbounds-subscriptions-refresh-due-btn',
      tbody: 'outbounds-subscriptions-tbody',
      empty: 'outbounds-subscriptions-empty',
      status: 'outbounds-subscriptions-status',
      summary: 'outbounds-subscriptions-summary',
    };

    let _subscriptions = [];
    let _subscriptionEditId = '';

    function subsEnsureModal() {
      let modal = $(SUB_IDS.modal);
      if (modal) return modal;
      if (!document.body) return null;

      document.body.insertAdjacentHTML('beforeend', `
        <div id="outbounds-subscriptions-modal" class="modal hidden" data-modal-key="outbounds-subscriptions-v1" data-modal-remember="0" data-modal-nopos="1" data-modal-noresize="1" role="dialog" aria-modal="true" aria-label="Подписки Xray">
          <div class="modal-content xk-sub-modal" data-modal-key="outbounds-subscriptions-v1-content">
            <div class="modal-header xk-sub-header">
              <div class="xk-sub-titleblock">
                <span class="modal-title">Подписки Xray</span>
                <span class="xk-sub-subtitle">Автообновление generated outbounds и observatory.</span>
              </div>
              <button type="button" class="modal-close" id="outbounds-subscriptions-close-btn" title="Закрыть" data-tooltip="Закрыть окно подписок.">×</button>
            </div>
            <div class="modal-body">
              <div class="xk-sub-brief">
                <div>
                  <div class="xk-sub-brief-title">LeastPing за минуту</div>
                  <div class="xk-sub-brief-text">Подписка пишет отдельный <code>04_outbounds.&lt;tag&gt;.json</code>. В балансировщике LeastPing выбери теги с этим prefix; включенный «Пинг» добавит их в <code>07_observatory.json</code>.</div>
                </div>
                <div class="xk-sub-steps" aria-hidden="true">
                  <span>URL</span>
                  <span>Фрагмент</span>
                  <span>LeastPing</span>
                </div>
              </div>
              <div class="xk-sub-grid">
                <section class="xk-sub-panel xk-sub-form-panel">
                  <div class="xk-sub-panelhead">
                    <div>
                      <div class="xk-pool-kicker">Источник</div>
                      <div class="terminal-menu-title" style="margin:0;">HTTP(S) subscription</div>
                    </div>
                  </div>
                  <form id="outbounds-subscriptions-form" class="xk-sub-form">
                    <input id="outbounds-subscriptions-id" type="hidden">
                    <label data-tooltip="Короткое имя подписки в списке. Можно оставить пустым.">
                      <span class="xk-pool-fieldlabel">Название</span>
                      <input id="outbounds-subscriptions-name" class="xray-log-filter" type="text" placeholder="My subscription" title="Название подписки" data-tooltip="Короткое имя подписки в списке.">
                    </label>
                    <label data-tooltip="Префикс для generated outbound tags, например sub--node. Его удобно выбирать в LeastPing.">
                      <span class="xk-pool-fieldlabel">Tag prefix</span>
                      <input id="outbounds-subscriptions-tag" class="xray-log-filter" type="text" placeholder="sub" title="Tag prefix" data-tooltip="Префикс для generated outbound tags. Используй его в selector/balancer LeastPing.">
                    </label>
                    <label class="xk-sub-wide" data-tooltip="HTTP(S) URL подписки. Поддерживаются share-ссылки, base64 и Xray JSON outbounds.">
                      <span class="xk-pool-fieldlabel">URL</span>
                      <input id="outbounds-subscriptions-url" class="xray-log-filter" type="url" placeholder="https://..." title="URL подписки" data-tooltip="Вставь HTTP(S) URL подписки. Панель скачает nodes и создаст отдельный outbounds-фрагмент.">
                    </label>
                    <label data-tooltip="Как часто обновлять подписку. Заголовок provider profile-update-interval может уточнить значение.">
                      <span class="xk-pool-fieldlabel">Интервал, ч</span>
                      <input id="outbounds-subscriptions-interval" class="xray-log-filter" type="number" min="1" max="168" step="1" value="6" title="Интервал обновления" data-tooltip="Интервал автообновления в часах: от 1 до 168.">
                    </label>
                    <div class="xk-sub-options">
                      <label class="xk-sub-check" data-tooltip="Включить плановое автообновление этой подписки."><input id="outbounds-subscriptions-enabled" type="checkbox" checked title="Автообновление" data-tooltip="Включить плановое автообновление этой подписки."><span>Авто</span></label>
                      <label class="xk-sub-check" data-tooltip="Добавлять generated tags в observatory для leastPing-проверок."><input id="outbounds-subscriptions-ping" type="checkbox" checked title="Пинг observatory" data-tooltip="Добавлять generated outbound tags в 07_observatory.json для LeastPing."><span>Пинг</span></label>
                      <label class="xk-sub-check" data-tooltip="После сохранения сразу скачать подписку и создать фрагмент."><input id="outbounds-subscriptions-refresh-now" type="checkbox" checked title="Обновить сразу" data-tooltip="Сразу скачать подписку после сохранения."><span>Обновить сразу</span></label>
                    </div>
                    <div class="xk-sub-actions">
                      <button type="button" id="outbounds-subscriptions-reset-btn" class="btn-secondary btn-compact" title="Новая подписка" data-tooltip="Очистить форму и добавить новую подписку.">Новая</button>
                      <button type="submit" id="outbounds-subscriptions-save-btn" class="btn-primary btn-compact" title="Сохранить подписку" data-tooltip="Сохранить настройки подписки. Если включено «Обновить сразу», фрагмент будет создан немедленно.">Сохранить</button>
                    </div>
                  </form>
                </section>

                <section class="xk-sub-panel xk-sub-list-panel">
                  <div class="xk-sub-panelhead">
                    <div>
                      <div class="xk-pool-kicker">Список</div>
                      <div class="terminal-menu-title" style="margin:0;">Сгенерированные фрагменты</div>
                    </div>
                    <div id="outbounds-subscriptions-summary" class="xk-pool-summary">0</div>
                  </div>
                  <div class="xk-sub-toolbar">
                    <button type="button" id="outbounds-subscriptions-refresh-due-btn" class="btn-secondary btn-compact" title="Обновить due" data-tooltip="Обновить все подписки, у которых уже наступило время next update.">Обновить due</button>
                  </div>
                  <div class="xk-sub-tablewrap">
                    <table class="xk-pool-table xk-sub-table">
                      <thead>
                        <tr>
                          <th>Tag</th>
                          <th>Статус</th>
                          <th>Файл</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody id="outbounds-subscriptions-tbody"></tbody>
                    </table>
                    <div id="outbounds-subscriptions-empty" class="xk-pool-empty">Подписок пока нет.</div>
                  </div>
                  <div id="outbounds-subscriptions-status" class="modal-hint xk-sub-status"></div>
                </section>
              </div>
            </div>
            <div class="modal-actions xk-pool-footer">
              <div></div>
              <div class="xk-pool-footer-actions">
                <button type="button" id="outbounds-subscriptions-cancel-btn" class="btn-compact" title="Закрыть" data-tooltip="Закрыть окно подписок.">Закрыть</button>
              </div>
            </div>
          </div>
        </div>
      `);

      modal = $(SUB_IDS.modal);
      return modal;
    }

    function subsShow(show) {
      const modal = subsEnsureModal();
      if (!modal) return;
      try {
        if (show) modal.classList.remove('hidden');
        else modal.classList.add('hidden');
      } catch (e) {}
      try { syncXkeenBodyScrollLock(!!show); } catch (e2) {}
    }

    function subsSetStatus(msg, isErr, isOk) {
      const el = $(SUB_IDS.status);
      if (!el) return;
      try {
        el.textContent = String(msg || '');
        el.classList.toggle('is-error', !!isErr);
        el.classList.toggle('is-success', !isErr && !!isOk);
      } catch (e) {}
    }

    function subsFormatTime(ts) {
      const n = Number(ts || 0);
      if (!Number.isFinite(n) || n <= 0) return '—';
      try {
        return new Date(n * 1000).toLocaleString();
      } catch (e) {
        return String(Math.round(n));
      }
    }

    function subsShortUrl(url) {
      const raw = String(url || '');
      if (!raw) return '';
      try {
        const u = new URL(raw);
        const path = String(u.pathname || '').replace(/\/+$/g, '');
        return u.hostname + (path ? path.slice(0, 28) : '');
      } catch (e) {}
      return raw.length > 42 ? raw.slice(0, 39) + '…' : raw;
    }

    function subsGeneratedFilePath(file) {
      const name = String(file || '').trim();
      if (!name) return '';
      const dir = String(_fragmentDir || '/opt/etc/xray/configs').replace(/\/+$/g, '');
      return dir + '/' + name;
    }

    function subsResetForm() {
      _subscriptionEditId = '';
      try { $(SUB_IDS.id).value = ''; } catch (e) {}
      try { $(SUB_IDS.name).value = ''; } catch (e) {}
      try { $(SUB_IDS.tag).value = ''; } catch (e) {}
      try { $(SUB_IDS.url).value = ''; } catch (e) {}
      try { $(SUB_IDS.interval).value = '6'; } catch (e) {}
      try { $(SUB_IDS.enabled).checked = true; } catch (e) {}
      try { $(SUB_IDS.ping).checked = true; } catch (e) {}
      try { $(SUB_IDS.refreshNow).checked = true; } catch (e) {}
    }

    function subsFillForm(sub) {
      const s = sub && typeof sub === 'object' ? sub : {};
      _subscriptionEditId = String(s.id || '');
      try { $(SUB_IDS.id).value = _subscriptionEditId; } catch (e) {}
      try { $(SUB_IDS.name).value = String(s.name || ''); } catch (e) {}
      try { $(SUB_IDS.tag).value = String(s.tag || ''); } catch (e) {}
      try { $(SUB_IDS.url).value = String(s.url || ''); } catch (e) {}
      try { $(SUB_IDS.interval).value = String(s.interval_hours || 6); } catch (e) {}
      try { $(SUB_IDS.enabled).checked = s.enabled !== false; } catch (e) {}
      try { $(SUB_IDS.ping).checked = s.ping_enabled !== false; } catch (e) {}
      try { $(SUB_IDS.refreshNow).checked = false; } catch (e) {}
      try { $(SUB_IDS.url).focus(); } catch (e) {}
    }

    function subsRender() {
      const tbody = $(SUB_IDS.tbody);
      const empty = $(SUB_IDS.empty);
      const summary = $(SUB_IDS.summary);
      if (!tbody) return;
      const items = Array.isArray(_subscriptions) ? _subscriptions : [];
      tbody.innerHTML = '';

      items.forEach((sub) => {
        const tr = document.createElement('tr');
        const ok = sub && sub.last_ok === true;
        const bad = sub && sub.last_ok === false;
        const count = Number(sub && sub.last_count ? sub.last_count : 0);
        const statusText = ok
          ? (`OK · ${count}`)
          : (bad ? ('Ошибка · ' + escapeHtml(String(sub.last_error || ''))) : '—');
        const next = subsFormatTime(sub && sub.next_update_ts);
        const title = escapeHtml(String(sub && sub.name ? sub.name : sub && sub.id ? sub.id : ''));
        const tag = escapeHtml(String(sub && sub.tag ? sub.tag : ''));
        const url = escapeHtml(subsShortUrl(sub && sub.url));
        const fileRaw = String(sub && sub.output_file ? sub.output_file : '');
        const file = escapeHtml(fileRaw);
        const filePath = escapeHtml(subsGeneratedFilePath(fileRaw));
        const id = escapeHtml(String(sub && sub.id ? sub.id : ''));
        tr.innerHTML = `
          <td>
            <div class="xk-sub-main">${tag || id}</div>
            <div class="xk-sub-muted">${title}${url ? ' · ' + url : ''}</div>
          </td>
          <td>
            <div class="${bad ? 'xk-sub-bad' : (ok ? 'xk-sub-ok' : 'xk-sub-muted')}">${statusText}</div>
            <div class="xk-sub-muted">next: ${escapeHtml(next)}</div>
          </td>
          <td class="xk-sub-file-cell">
            <button type="button" class="xk-sub-file-link" data-file="${file}" title="${filePath || file}" data-tooltip="Открыть generated outbounds-фрагмент этой подписки.">
              <code>${file || '—'}</code>
            </button>
          </td>
          <td class="xk-sub-row-actions">
            <button type="button" class="btn-secondary btn-compact xk-sub-open" data-file="${file}" title="Открыть generated-фрагмент" data-tooltip="Переключить Прокси на этот фрагмент и открыть JSON-редактор.">↗</button>
            <button type="button" class="btn-secondary btn-compact xk-sub-refresh" data-id="${id}" title="Обновить" data-tooltip="Скачать подписку сейчас и перегенерировать outbounds-фрагмент.">↻</button>
            <button type="button" class="btn-secondary btn-compact xk-sub-edit" data-id="${id}" title="Редактировать" data-tooltip="Загрузить настройки подписки в форму слева.">✎</button>
            <button type="button" class="btn-secondary btn-compact xk-sub-delete" data-id="${id}" title="Удалить" data-tooltip="Удалить подписку и generated-фрагмент.">×</button>
          </td>
        `;
        tbody.appendChild(tr);
      });

      try { if (empty) empty.style.display = items.length ? 'none' : 'block'; } catch (e) {}
      try { if (summary) summary.textContent = String(items.length) + ' шт.'; } catch (e) {}

      Array.from(tbody.querySelectorAll('.xk-sub-open, .xk-sub-file-link')).forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          subsOpenGeneratedFragment(btn.getAttribute('data-file') || '');
        });
      });
      Array.from(tbody.querySelectorAll('.xk-sub-refresh')).forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          subsRefresh(btn.getAttribute('data-id') || '');
        });
      });
      Array.from(tbody.querySelectorAll('.xk-sub-edit')).forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          const id = btn.getAttribute('data-id') || '';
          const sub = _subscriptions.find((item) => String(item && item.id || '') === id);
          if (sub) subsFillForm(sub);
        });
      });
      Array.from(tbody.querySelectorAll('.xk-sub-delete')).forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          subsDelete(btn.getAttribute('data-id') || '');
        });
      });
    }

    async function subsOpenGeneratedFragment(file) {
      const name = String(file || '').trim();
      if (!name) return false;

      async function commitOpen() {
        applyActiveFragment(name, _fragmentDir, _fragmentItems);
        try { await load(); } catch (e) {}
        subsShow(false);
        const opened = openXkeenJsonEditor('outbounds');
        if (opened == null) {
          try { toastXkeen('JSON-редактор не загружен.', 'error'); } catch (e) {}
          return false;
        }
        return true;
      }

      subsSetStatus('Открываю фрагмент: ' + name, false);
      try { await refreshFragmentsList({ notify: false }); } catch (e) {}

      const prev = getActiveFragment();
      if (prev && prev !== name) {
        return guardFragmentSwitch(name, prev, {
          onCancel: () => restoreFragmentSelection($(IDS.fragmentSelect), prev, _fragmentDir, _fragmentItems),
          commit: commitOpen,
        });
      }
      return commitOpen();
    }

    async function subsLoad() {
      try {
        const res = await fetch('/api/xray/subscriptions', { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data || data.ok === false) {
          throw new Error(String((data && (data.error || data.message)) || ('HTTP ' + res.status)));
        }
        _subscriptions = Array.isArray(data.subscriptions) ? data.subscriptions : [];
        try {
          _subscriptionOutputFiles = new Set(_subscriptions.map((sub) => baseName(sub && sub.output_file)).filter(Boolean));
          _subscriptionOutputFilesTs = Date.now();
        } catch (e2) {}
        subsRender();
        return true;
      } catch (e) {
        subsSetStatus('Ошибка загрузки: ' + String(e && e.message ? e.message : e), true);
        return false;
      }
    }

    async function subsRefresh(id) {
      const subId = String(id || '').trim();
      if (!subId) return false;
      subsSetStatus('Обновляю подписку…', false);
      const restart = shouldRestartAfterSave();
      try {
        const res = await fetch('/api/xray/subscriptions/' + encodeURIComponent(subId) + '/refresh?restart=' + (restart ? '1' : '0'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data || data.ok === false) {
          const err = String((data && (data.error || data.message)) || ('HTTP ' + res.status));
          throw new Error(err);
        }
        const msg = `Готово: ${Number(data.count || 0)} outbound` + (data.changed ? ' · файл обновлён' : ' · без изменений');
        const fileNote = data.output_file ? (' · ' + String(data.output_file)) : '';
        subsSetStatus(msg + fileNote, false, true);
        try { toastXkeen(msg, 'success'); } catch (e) {}
        try { await refreshFragmentsList({ notify: false }); } catch (e2) {}
        try { await refreshRestartLog(); } catch (e3) {}
        await subsLoad();
        return true;
      } catch (e) {
        const msg = 'Ошибка обновления: ' + String(e && e.message ? e.message : e);
        subsSetStatus(msg, true);
        try { toastXkeen(msg, 'error'); } catch (e2) {}
        await subsLoad();
        return false;
      }
    }

    async function subsRefreshDue() {
      subsSetStatus('Проверяю due-подписки…', false);
      const restart = shouldRestartAfterSave();
      try {
        const res = await fetch('/api/xray/subscriptions/refresh-due?restart=' + (restart ? '1' : '0'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data || data.ok === false) {
          throw new Error(String((data && (data.error || data.message)) || ('HTTP ' + res.status)));
        }
        const msg = `Due обновлены: ${Number(data.ok_count || 0)} / ${Number(data.updated || 0)}`;
        subsSetStatus(msg, false, true);
        try { await refreshFragmentsList({ notify: false }); } catch (e) {}
        await subsLoad();
      } catch (e) {
        subsSetStatus('Ошибка: ' + String(e && e.message ? e.message : e), true);
      }
    }

    async function subsSave(e) {
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      const payload = {
        id: String(($(SUB_IDS.id) && $(SUB_IDS.id).value) || _subscriptionEditId || '').trim(),
        name: String(($(SUB_IDS.name) && $(SUB_IDS.name).value) || '').trim(),
        tag: String(($(SUB_IDS.tag) && $(SUB_IDS.tag).value) || '').trim(),
        url: String(($(SUB_IDS.url) && $(SUB_IDS.url).value) || '').trim(),
        interval_hours: Number(($(SUB_IDS.interval) && $(SUB_IDS.interval).value) || 6),
        enabled: !!($(SUB_IDS.enabled) && $(SUB_IDS.enabled).checked),
        ping_enabled: !!($(SUB_IDS.ping) && $(SUB_IDS.ping).checked),
      };
      if (!payload.url) {
        subsSetStatus('URL обязателен.', true);
        return false;
      }

      subsSetStatus('Сохраняю…', false);
      try {
        const res = await fetch('/api/xray/subscriptions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data || data.ok === false) {
          throw new Error(String((data && (data.error || data.message)) || ('HTTP ' + res.status)));
        }
        const sub = data.subscription || {};
        const id = String(sub.id || payload.id || '');
        subsSetStatus('Сохранено.', false, true);
        await subsLoad();
        if ($(SUB_IDS.refreshNow) && $(SUB_IDS.refreshNow).checked && id) {
          await subsRefresh(id);
        } else {
          try { toastXkeen('Подписка сохранена', 'success'); } catch (e2) {}
        }
        subsFillForm(sub);
        return true;
      } catch (err) {
        const msg = 'Ошибка сохранения: ' + String(err && err.message ? err.message : err);
        subsSetStatus(msg, true);
        try { toastXkeen(msg, 'error'); } catch (e2) {}
        return false;
      }
    }

    async function subsDelete(id) {
      const subId = String(id || '').trim();
      if (!subId) return false;
      try {
        if (!window.confirm('Удалить подписку и сгенерированный outbounds-файл?')) return false;
      } catch (e) {}
      const restart = shouldRestartAfterSave();
      subsSetStatus('Удаляю…', false);
      try {
        const res = await fetch('/api/xray/subscriptions/' + encodeURIComponent(subId) + '?restart=' + (restart ? '1' : '0'), {
          method: 'DELETE',
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data || data.ok === false) {
          throw new Error(String((data && (data.error || data.message)) || ('HTTP ' + res.status)));
        }
        subsSetStatus('Удалено.', false, true);
        if (_subscriptionEditId === subId) subsResetForm();
        try { await refreshFragmentsList({ notify: false }); } catch (e) {}
        await subsLoad();
        return true;
      } catch (err) {
        subsSetStatus('Ошибка удаления: ' + String(err && err.message ? err.message : err), true);
        return false;
      }
    }

    async function subsOpen() {
      subsEnsureModal();
      subsShow(true);
      subsSetStatus('', false);
      await subsLoad();
      try { $(SUB_IDS.url).focus(); } catch (e) {}
    }

    function subsClose() {
      subsShow(false);
    }

    function wireSubscriptionsModal() {
      const openBtn = $(SUB_IDS.open);
      if (!openBtn) return;
      if (openBtn.dataset && openBtn.dataset.xkSubWired === '1') return;

      openBtn.addEventListener('click', (e) => {
        e.preventDefault();
        subsOpen();
      });
      if (openBtn.dataset) openBtn.dataset.xkSubWired = '1';

      const modal = subsEnsureModal();
      if (!modal || (modal.dataset && modal.dataset.xkWired === '1')) return;

      wireButton(SUB_IDS.close, subsClose);
      wireButton(SUB_IDS.cancel, subsClose);
      wireButton(SUB_IDS.reset, () => {
        subsResetForm();
        subsSetStatus('', false);
      });
      wireButton(SUB_IDS.refreshDue, subsRefreshDue);

      const form = $(SUB_IDS.form);
      if (form) {
        form.addEventListener('submit', subsSave);
      }

      modal.addEventListener('click', (e) => {
        try { if (e && e.target === modal) subsClose(); } catch (e2) {}
      });

      document.addEventListener('keydown', (e) => {
        if (!e || e.key !== 'Escape') return;
        const m = $(SUB_IDS.modal);
        if (m && !m.classList.contains('hidden')) subsClose();
      });

      if (modal.dataset) modal.dataset.xkWired = '1';
    }


    function init() {
      const hasAny =
        $('outbounds-body') ||
        $('outbounds-save-btn') ||
        $('outbounds-url');

      if (!hasAny) return;
      if (inited) return;
      inited = true;

      try { syncShellState(_fragmentDir, _fragmentItems); } catch (e) {}
      try {
        publishLifecycleState({
          currentValue: String(getCurrentUrl() || ''),
          savedValue: String(_savedUrl || ''),
          initialized: false,
          loading: false,
          saving: false,
        }, 'outbounds-init');
      } catch (e) {}

      setCollapsedFromStorage();
      wireHeader('outbounds-header', toggleCard);

      // Fragment selector
      refreshFragmentsList();

      // Buttons
      bindConfigAction('outbounds-save-btn', save);
      bindConfigAction('outbounds-normalize-btn', normalizeCurrentUrl);
      bindConfigAction('outbounds-backup-btn', backup, { kind: 'backup' });
      bindConfigAction('outbounds-restore-auto-btn', () => {
        try {
          const backupsApi = getBackupsApi();
          if (backupsApi && typeof backupsApi.restoreAuto === 'function') {
            backupsApi.restoreAuto('outbounds', { confirmed: true });
          } else {
            if (typeof showToast === 'function') showToast('Модуль бэкапов не загружен.', true);
          }
        } catch (e) {}
      }, { kind: 'restoreAuto' });
      bindConfigAction('outbounds-open-editor-btn', () => {
        try {
          if (openXkeenJsonEditor('outbounds') != null) {
            return;
          } else {
            if (typeof showToast === 'function') showToast('Модуль JSON-редактора не загружен.', true);
          }
        } catch (e) {}
      }, { kind: 'openEditor' });

      // Initial load
      wireHints();
      wireGeneratorModal();
      wirePoolModal();
      wireSubscriptionsModal();
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
export function getOutboundsApi() {
  try {
    if (outboundsModuleApi && typeof outboundsModuleApi.init === 'function') return outboundsModuleApi;
  } catch (error) {
    return null;
  }
  return null;
}

function callOutboundsApi(method, ...args) {
  const api = getOutboundsApi();
  if (!api || typeof api[method] !== 'function') return null;
  return api[method](...args);
}

export function initOutbounds(...args) {
  return callOutboundsApi('init', ...args);
}

export function loadOutbounds(...args) {
  return callOutboundsApi('load', ...args);
}

export function saveOutbounds(...args) {
  return callOutboundsApi('save', ...args);
}

export function backupOutbounds(...args) {
  return callOutboundsApi('backup', ...args);
}

export function toggleOutboundsCard(...args) {
  return callOutboundsApi('toggleCard', ...args);
}

export const outboundsApi = Object.freeze({
  get: getOutboundsApi,
  init: initOutbounds,
  load: loadOutbounds,
  save: saveOutbounds,
  backup: backupOutbounds,
  toggleCard: toggleOutboundsCard,
});
