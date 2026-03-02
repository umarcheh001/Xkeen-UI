(() => {
  'use strict';

  // Mihomo HWID subscription wizard
  // - Probe subscription with HWID headers
  // - Build proxy-provider YAML snippet
  // - Insert into config.yaml editor (proxy-providers section)

  window.XKeen = window.XKeen || {};
  XKeen.features = XKeen.features || {};

  const HW = (XKeen.features.mihomoHwidSub = XKeen.features.mihomoHwidSub || {});

  const IDS = {
    btnOpen: 'mihomo-hwid-sub-btn',

    modal: 'mihomo-hwid-modal',
    btnClose: 'mihomo-hwid-close-btn',
    btnCancel: 'mihomo-hwid-cancel-btn',

    url: 'mihomo-hwid-url',
    insecure: 'mihomo-hwid-insecure',
    name: 'mihomo-hwid-name',
    preview: 'mihomo-hwid-preview',

    status: 'mihomo-hwid-status',
    meta: 'mihomo-hwid-meta',
    tip: 'mihomo-hwid-tip',

    btnProbe: 'mihomo-hwid-probe-btn',
    btnInsert: 'mihomo-hwid-insert-btn',

    // Injected in MH-04
    btnApplyRestart: 'mihomo-hwid-apply-restart-btn',
    mode: 'mihomo-hwid-mode',
    template: 'mihomo-hwid-template',
  };

  let _inited = false;
  let _device = null; // device info from /api/mihomo/hwid/device
  let _lastProbe = null; // probe response
  let _busy = false;

  function $(id) {
    return document.getElementById(id);
  }

  function toastMsg(msg, kind) {
    // kind: 'success' | 'error' | 'warning'
    try {
      if (window.toast) window.toast(String(msg || ''), kind || 'success');
      else if (window.showToast) window.showToast(String(msg || ''), kind === 'error');
    } catch (e) {}
  }

  function setStatus(msg, isErr) {
    const el = $(IDS.status);
    if (!el) return;
    el.textContent = String(msg || '');
    el.classList.toggle('error', !!isErr);
  }

  function setMeta(msg) {
    const el = $(IDS.meta);
    if (!el) return;
    el.textContent = String(msg || '');
  }

  function setTip(msg) {
    const el = $(IDS.tip);
    if (!el) return;
    const s = String(msg || '').trim();
    el.textContent = s;
    el.style.display = s ? '' : 'none';
  }

  function setPreview(text) {
    const ta = $(IDS.preview);
    if (!ta) return;
    try { ta.value = String(text || ''); } catch (e) {}
  }

  function setInsertEnabled(on) {
    const b = $(IDS.btnInsert);
    if (!b) return;
    b.disabled = !on;
  }

  function setApplyEnabled(on) {
    const b = $(IDS.btnApplyRestart);
    if (!b) return;
    b.disabled = !on;
  }

  function modalOpen() {
    const m = $(IDS.modal);
    return !!(m && !m.classList.contains('hidden'));
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
      _lastProbe = null;
      setStatus('', false);
      setMeta('');
      setTip('');
      setPreview('');
      setInsertEnabled(false);
      setApplyEnabled(false);

      // Lazy fetch device info (for headers + UX hint)
      try { fetchDeviceInfo(); } catch (e3) {}

      // Load templates list lazily (only used for replace_all)
      try { ensureTemplatesLoaded(); } catch (e4) {}

      try {
        const inp = $(IDS.url);
        if (inp) inp.focus();
      } catch (e4) {}
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

  function getHttp() {
    try {
      return (window.XKeen && XKeen.core && XKeen.core.http) ? XKeen.core.http : null;
    } catch (e) {
      return null;
    }
  }

  async function postJSONAllowError(url, body) {
    const http = getHttp();
    const init = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      cache: 'no-store',
    };

    let opts = init;
    try {
      if (http && typeof http.withCSRF === 'function') {
        opts = http.withCSRF(init, 'POST');
      }
    } catch (e) {}

    const res = await fetch(url, opts);
    let data = null;
    try { data = await res.json(); } catch (e) {}
    return { status: res.status, ok: res.ok, data };
  }

  async function fetchDeviceInfo() {
    if (_device) return _device;
    const http = getHttp();
    if (!http || typeof http.fetchJSON !== 'function') return null;
    try {
      const data = await http.fetchJSON('/api/mihomo/hwid/device');
      _device = data || null;
      // Non-intrusive hint
      try {
        const mac = data && data.mac ? String(data.mac) : '';
        const hwid = data && data.hwid ? String(data.hwid) : '';
        const ua = (data && data.user_agent) ? String(data.user_agent) : '';
        if (hwid || mac || ua) {
          setMeta([
            hwid ? ('HWID: ' + hwid) : '',
            (!hwid && mac) ? ('MAC: ' + mac) : (hwid && mac ? ('MAC: ' + mac) : ''),
            ua ? ('UA: ' + ua) : '',
          ].filter(Boolean).join(' • '));
        }
      } catch (e2) {}
      return _device;
    } catch (e) {
      // do not block the flow
      _device = null;
      return null;
    }
  }

  function yamlQuote(v) {
    const s = String(v == null ? '' : v);
    // Always quote to avoid YAML edge-cases.
    return '"' + s.replace(/\\/g, '\\\\').replace(/\"/g, '\\"').replace(/\n/g, '\\n') + '"';
  }

  function sanitizeProviderName(name) {
    let s = String(name || '').trim();
    if (!s) return '';
    s = s.replace(/\s+/g, '_');
    s = s.replace(/[^A-Za-z0-9._-]+/g, '_');
    s = s.replace(/_+/g, '_').replace(/^[._-]+|[._-]+$/g, '');
    return s.slice(0, 64);
  }

  function buildProviderSnippet(name, url, headers) {
    const nm = sanitizeProviderName(name);
    const h = headers || {};

    const lines = [];
    lines.push(`  ${nm}:`);
    lines.push(`    type: http`);
    lines.push(`    url: ${yamlQuote(url)}`);
    lines.push(`    interval: 3600`);
    lines.push(`    path: ${yamlQuote(`./proxy_providers/${nm}.yaml`)}`);
    lines.push(`    health-check:`);
    lines.push(`      enable: true`);
    lines.push(`      url: "https://www.gstatic.com/generate_204"`);
    lines.push(`      interval: 600`);

    const headerLines = [];
    const pushH = (k, v) => {
      const vv = String(v == null ? '' : v).trim();
      if (!vv) return;
      // Mihomo docs use list-of-strings for header values.
      headerLines.push(`      ${k}:`);
      headerLines.push(`      - ${yamlQuote(vv)}`);
    };

    pushH('x-hwid', h['x-hwid']);
    pushH('x-device-os', h['x-device-os']);
    pushH('x-ver-os', h['x-ver-os']);
    pushH('x-device-model', h['x-device-model']);
    pushH('User-Agent', h['User-Agent'] || h['user-agent']);

    if (headerLines.length) {
      lines.push(`    header:`);
      lines.push(...headerLines);
    }

    return lines.join('\n') + '\n';
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
    const ta = document.getElementById('mihomo-editor');
    return ta ? String(ta.value || '') : '';
  }

  function setEditorText(text) {
    try {
      if (typeof window.setMihomoEditorText === 'function') return window.setMihomoEditorText(text);
    } catch (e) {}
    const ta = document.getElementById('mihomo-editor');
    if (ta) ta.value = String(text || '');
  }

  function refreshEditor() {
    try {
      const cm = window.XKeen && XKeen.state ? XKeen.state.mihomoEditor : null;
      if (cm && cm.refresh) cm.refresh();
    } catch (e) {}
  }

  async function doProbe() {
    if (_busy) return;
    const urlEl = $(IDS.url);
    const insecureEl = $(IDS.insecure);
    const nameEl = $(IDS.name);

    const url = urlEl ? String(urlEl.value || '').trim() : '';
    const insecure = !!(insecureEl && insecureEl.checked);

    if (!url) {
      setStatus('Введите URL подписки.', true);
      return;
    }

    _busy = true;
    setInsertEnabled(false);
    setApplyEnabled(false);
    setTip('');
    setStatus('Проверяем подписку…', false);

    try {
      const dev = await fetchDeviceInfo();
      const r = await postJSONAllowError('/api/mihomo/hwid/probe', { url, insecure: insecure });
      const res = r && r.data ? r.data : null;
      _lastProbe = res || null;

      if (!r.ok || !res || !res.ok) {
        const errObj = (res && res.error) ? res.error : null;
        const msg = (errObj && errObj.message) ? String(errObj.message) : (res && res.error ? String(res.error) : 'Не удалось проверить подписку.');
        const hint = (errObj && errObj.hint) ? String(errObj.hint) : '';
        setStatus(msg, true);
        if (hint) setMeta(hint);
        return;
      }

      const p = res.profile || {};
      const probe = res.probe || {};
      const title = p.profile_title ? String(p.profile_title) : '';
      const suggested = p.suggested_name ? String(p.suggested_name) : '';

      // Autodetect: if subscription also works WITHOUT HWID headers, it's likely a normal subscription.
      // In that case we show a small non-blocking tip.
      try {
        if (res.no_headers_ok === true) {
          setTip('Похоже, это обычная подписка (работает без HWID). Headers можно оставить — сервер обычно игнорирует; при ошибках попробуйте убрать headers.');
        } else {
          setTip('');
        }
      } catch (e0) {
        setTip('');
      }

      // Auto-fill name when empty (or when previously autogen)
      try {
        const cur = nameEl ? String(nameEl.value || '').trim() : '';
        if (!cur || cur === suggested) {
          if (nameEl && suggested) nameEl.value = suggested;
        }
      } catch (e1) {}

      const nm = sanitizeProviderName(nameEl ? nameEl.value : suggested);
      if (!nm) {
        setStatus('Не удалось подобрать имя provider — укажи вручную.', true);
        return;
      }

      const headers = (res.headers_used) || (dev && dev.headers) || {};
      const snippet = buildProviderSnippet(nm, url, headers);
      setPreview(snippet);

      // Meta line
      const parts = [];
      if (title) parts.push('profile-title: ' + title);
      if (probe.http_status) parts.push('HTTP ' + probe.http_status);
      if (probe.method) parts.push(probe.method);
      if (typeof probe.timing_ms === 'number') parts.push(probe.timing_ms + 'ms');
      if (probe.resolved_url && String(probe.resolved_url) !== url) parts.push('→ ' + String(probe.resolved_url));
      if (parts.length) setMeta(parts.join(' • '));

      // Warnings
      try {
        const warns = Array.isArray(res.warnings) ? res.warnings : [];
        if (warns.length) {
          const w = warns[0];
          if (w && w.hint) toastMsg(String(w.hint), 'warning');
        }
      } catch (e2) {}

      setStatus('OK — можно вставлять в config.yaml', false);
      setInsertEnabled(true);
      setApplyEnabled(true);
    } catch (e) {
      setStatus(String(e && e.message ? e.message : e), true);
    } finally {
      _busy = false;
    }
  }

  function ensureModeUi() {
    const modal = $(IDS.modal);
    if (!modal) return;
    const body = modal.querySelector('.modal-body');
    const nameEl = $(IDS.name);
    const anchor = nameEl ? nameEl.closest('label') : null;
    if (!body || !anchor) return;

    if (!$(IDS.mode)) {
      const wrap = document.createElement('label');
      wrap.style.display = 'block';
      wrap.style.marginTop = '12px';
      wrap.innerHTML = `
        <span class="hint-label">Режим применения</span>
        <select id="${IDS.mode}" class="xkeen-input" style="width:100%;">
          <option value="add">Добавить provider (add)</option>
          <option value="replace_providers">Заменить proxy-providers (replace_providers)</option>
          <option value="replace_all">Заменить весь config.yaml (replace_all)</option>
        </select>
        <div class="xk-card-desc" style="margin-top:6px;">Рекомендуется <b>add</b>. Остальные режимы перезаписывают части конфига.</div>
      `;
      anchor.insertAdjacentElement('afterend', wrap);
    }

    if (!$(IDS.template)) {
      const wrapT = document.createElement('label');
      wrapT.style.display = 'none';
      wrapT.style.marginTop = '12px';
      wrapT.id = IDS.template + '-wrap';
      wrapT.innerHTML = `
        <span class="hint-label">Шаблон для replace_all</span>
        <select id="${IDS.template}" class="xkeen-input" style="width:100%;"></select>
        <div class="xk-card-desc" style="margin-top:6px;">Если не выбрать — будет использован шаблон по умолчанию.</div>
      `;
      const modeEl = $(IDS.mode);
      (modeEl ? modeEl.closest('label') : anchor).insertAdjacentElement('afterend', wrapT);
    }

    // Toggle template selector
    try {
      const modeEl = $(IDS.mode);
      const wrapT = document.getElementById(IDS.template + '-wrap');
      if (modeEl && wrapT && (!modeEl.dataset || modeEl.dataset.xkWired !== '1')) {
        const sync = () => {
          const v = String(modeEl.value || 'add');
          wrapT.style.display = (v === 'replace_all') ? 'block' : 'none';
        };
        modeEl.addEventListener('change', sync);
        sync();
        if (modeEl.dataset) modeEl.dataset.xkWired = '1';
      }
    } catch (e) {}
  }

  async function ensureTemplatesLoaded() {
    const sel = $(IDS.template);
    if (!sel || sel.dataset && sel.dataset.xkLoaded === '1') return;
    const http = getHttp();
    if (!http || typeof http.fetchJSON !== 'function') return;
    try {
      const data = await http.fetchJSON('/api/mihomo-templates');
      const list = (data && Array.isArray(data.templates)) ? data.templates : [];
      sel.innerHTML = '';
      const opt0 = document.createElement('option');
      opt0.value = '';
      opt0.textContent = '(шаблон по умолчанию)';
      sel.appendChild(opt0);
      list.forEach((it) => {
        const name = it && it.name ? String(it.name) : '';
        if (!name) return;
        const o = document.createElement('option');
        o.value = name;
        o.textContent = name;
        sel.appendChild(o);
      });
      if (sel.dataset) sel.dataset.xkLoaded = '1';
    } catch (e) {
      // ignore
    }
  }

  function ensureApplyRestartButton() {
    const modal = $(IDS.modal);
    if (!modal) return;
    const actionsLeft = modal.querySelector('.modal-actions > div');
    if (!actionsLeft) return;
    if ($(IDS.btnApplyRestart)) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = IDS.btnApplyRestart;
    btn.className = 'btn-primary';
    btn.textContent = '🚀 Применить + рестарт';
    btn.disabled = true;
    btn.setAttribute('data-tooltip', 'Сервер применит изменения, сохранит config.yaml и поставит рестарт в очередь.');
    actionsLeft.appendChild(btn);
  }

  async function doApplyRestart() {
    if (_busy) return;
    const urlEl = $(IDS.url);
    const insecureEl = $(IDS.insecure);
    const nameEl = $(IDS.name);

    const url = urlEl ? String(urlEl.value || '').trim() : '';
    const insecure = !!(insecureEl && insecureEl.checked);
    const name = nameEl ? String(nameEl.value || '').trim() : '';

    if (!url) {
      setStatus('Введите URL подписки.', true);
      return;
    }

    const modeEl = $(IDS.mode);
    const mode = modeEl ? String(modeEl.value || 'add') : 'add';
    const tmplEl = $(IDS.template);
    const template_name = (tmplEl && mode === 'replace_all') ? String(tmplEl.value || '').trim() : '';

    _busy = true;
    setStatus('Применяем и ставим рестарт в очередь…', false);
    setInsertEnabled(false);
    setApplyEnabled(false);

    try {
      await fetchDeviceInfo();
      const r = await postJSONAllowError('/api/mihomo/hwid/apply', {
        url,
        insecure,
        mode,
        name,
        template_name,
        restart: true,
      });
      const res = r && r.data ? r.data : null;

      if (!r.ok || !res || !res.ok) {
        // Two possible shapes: {error:...} or {stage:'probe', probe:{...}}
        let errObj = (res && res.error) ? res.error : null;
        if (!errObj && res && res.stage === 'probe' && res.probe && res.probe.error) errObj = res.probe.error;
        const msg = (errObj && errObj.message) ? String(errObj.message) : (res && res.error ? String(res.error) : 'Не удалось применить изменения.');
        const hint = (errObj && errObj.hint) ? String(errObj.hint) : '';
        setStatus(msg, true);
        if (hint) setMeta(hint);
        return;
      }

      const nm = res.provider_name ? String(res.provider_name) : '';
      const job = res.restart_job_id ? String(res.restart_job_id) : '';

      showModal(false);
      if (job) toastMsg(`Рестарт поставлен в очередь (job: ${job}) ✅`, 'success');
      else toastMsg(`Применено ✅ ${nm ? '(' + nm + ')' : ''}`, 'success');
    } catch (e) {
      setStatus(String(e && e.message ? e.message : e), true);
    } finally {
      _busy = false;
    }
  }

  function nameAlreadyExists(yamlText, name) {
    const nm = sanitizeProviderName(name);
    if (!nm) return false;
    const esc = (s) => String(s || '').replace(/[.*+?^${}()|[\[\]\\]/g, '\\$&');
    const re = new RegExp('^\\s{2}' + esc(nm) + '\\s*:', 'm');
    return re.test(String(yamlText || ''));
  }

  function doInsert() {
    const nameEl = $(IDS.name);
    const urlEl = $(IDS.url);

    const name = sanitizeProviderName(nameEl ? nameEl.value : '');
    const url = urlEl ? String(urlEl.value || '').trim() : '';

    if (!name) {
      setStatus('Укажи имя provider.', true);
      return;
    }
    if (!url) {
      setStatus('Укажи URL подписки.', true);
      return;
    }

    const existing = getEditorText();
    if (nameAlreadyExists(existing, name)) {
      setStatus(`Provider '${name}' уже есть в конфиге. Выбери другое имя.`, true);
      return;
    }

    const headers = (_lastProbe && _lastProbe.headers_used) || (_device && _device.headers) || {};
    const snippet = buildProviderSnippet(name, url, headers);

    const patch = (window.XKeen && XKeen.features && XKeen.features.mihomoYamlPatch) ? XKeen.features.mihomoYamlPatch : null;
    if (!patch || typeof patch.insertIntoSection !== 'function') {
      setStatus('mihomoYamlPatch недоступен — обнови страницу.', true);
      return;
    }

    const next = patch.insertIntoSection(existing, 'proxy-providers', snippet, { avoidDuplicates: true });
    setEditorText(next);
    refreshEditor();

    showModal(false);
    toastMsg('Добавлено в proxy-providers ✅', 'success');

    try {
      if (typeof window.updateLastActivity === 'function') {
        const fp = window.XKEEN_FILES && window.XKEEN_FILES.mihomo ? window.XKEEN_FILES.mihomo : '/opt/etc/mihomo/config.yaml';
        window.updateLastActivity('modified', 'mihomo', fp);
      }
    } catch (e) {}
  }

  HW.init = function init() {
    const openBtn = $(IDS.btnOpen);
    const modal = $(IDS.modal);
    if (!openBtn || !modal) return;

    if (_inited || (modal.dataset && modal.dataset.xkMihomoHwidInited === '1')) return;
    _inited = true;
    if (modal.dataset) modal.dataset.xkMihomoHwidInited = '1';

    wireButton(IDS.btnOpen, () => showModal(true));
    wireButton(IDS.btnClose, () => showModal(false));
    wireButton(IDS.btnCancel, () => showModal(false));

    wireButton(IDS.btnProbe, () => doProbe());
    wireButton(IDS.btnInsert, () => doInsert());

    // MH-04: injected UI
    try {
      ensureModeUi();
      ensureApplyRestartButton();
      wireButton(IDS.btnApplyRestart, () => doApplyRestart());
    } catch (e) {}

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

    // Ctrl+Enter = probe, Ctrl+Shift+Enter = insert
    const urlEl = $(IDS.url);
    if (urlEl && (!urlEl.dataset || urlEl.dataset.xkKeys !== '1')) {
      urlEl.addEventListener('keydown', (e) => {
        try {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            if (e.shiftKey) doInsert();
            else doProbe();
          }
        } catch (err) {}
      });
      if (urlEl.dataset) urlEl.dataset.xkKeys = '1';
    }
  };

  // Auto-init (safe, no API calls until user opens/probes)
  try { setTimeout(() => { try { HW.init(); } catch (e) {} }, 0); } catch (e) {}
})();
