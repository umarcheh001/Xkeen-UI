import { getDevtoolsSharedApi, setDevtoolsNamespaceApi } from '../devtools_namespace.js';

// DevTools → «Декриптор Happ»: engine and key status, install, key update,
// manual upload (engine or key files) and a link check.
(() => {
  'use strict';

  const SH = getDevtoolsSharedApi() || {};
  const byId = SH.byId || ((id) => document.getElementById(id));
  const toast = SH.toast || ((msg) => { try { console.log(msg); } catch (e) {} });
  const confirmAction = SH.confirmAction || (async (opts) => window.confirm(String((opts && opts.message) || 'Продолжить?')));

  const ROUTES = {
    status: '/api/happ-decryptor/status',
    install: '/api/happ-decryptor/install',
    keys: '/api/happ-decryptor/keys',
    upload: '/api/happ-decryptor/keys/upload',
    check: '/api/happ-decryptor/check',
  };
  const ASSET_PREFIX = 'happ-decrypt-universal-linux-';
  const ALL_FORMATS = ['crypt', 'crypt2', 'crypt3', 'crypt4', 'crypt5'];
  const LAYOUTS = { salted: 'солёная раскладка', plain: 'обычная раскладка' };
  const BUTTON_IDS = ['dt-happ-install', 'dt-happ-update-keys', 'dt-happ-upload', 'dt-happ-refresh', 'dt-happ-check-run'];

  // missingKeyFormat: set by a link check that found no key; shown until keys change.
  const state = { inited: false, busy: false, status: null, missingKeyFormat: '' };

  function csrfToken() {
    try {
      const el = document.querySelector('meta[name="csrf-token"]');
      return el ? String(el.getAttribute('content') || '') : '';
    } catch (e) {
      return '';
    }
  }

  // Expected failures come back as 200 with ok:false and a hint, so the body is
  // returned whenever it is JSON; only a non-JSON answer is an exception.
  async function request(url, init) {
    const options = init || {};
    const headers = new Headers(options.headers || {});
    const token = csrfToken();
    if (token && options.method === 'POST' && !headers.has('X-CSRF-Token')) headers.set('X-CSRF-Token', token);
    const res = await fetch(url, { cache: 'no-store', ...options, headers });
    let data = null;
    try { data = await res.json(); } catch (e) {}
    if (data && typeof data === 'object') {
      return res.status === 413 ? { ...data, ok: false, hint: 'Файл слишком большой.' } : data;
    }
    throw new Error('HTTP ' + res.status);
  }

  function postJSON(url, body) {
    return request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
  }

  function postFiles(url, files) {
    const form = new FormData();
    for (const file of files) form.append('file', file, file.name);
    return request(url, { method: 'POST', body: form });
  }

  function show(id, visible) {
    const el = byId(id);
    if (el) el.style.display = visible ? '' : 'none';
  }

  function setText(id, text) {
    const el = byId(id);
    if (el) el.textContent = String(text == null ? '' : text);
  }

  function setTone(id, base, tone, text) {
    const el = byId(id);
    if (!el) return;
    el.className = `${base} ${base}-${tone}`;
    el.textContent = String(text == null ? '' : text);
  }

  function setStatusLine(text, tone) {
    const el = byId('dt-happ-status');
    if (!el) return;
    const value = String(text || '');
    el.textContent = value;
    el.className = tone ? `status ${tone}` : 'status';
    el.style.display = value ? '' : 'none';
  }

  // "happ-decrypt-universal v1.4.0 (8af0af5, …)" → label "v1.4.0", commit "8af0af5".
  // Local builds already carry the commit in the version ("d1dbdfa4-local"), so it is not repeated.
  function parseVersion(line) {
    const match = String(line || '').match(/^happ-decrypt-universal\s+(\S+)(?:\s+\(([^,)]+))?/);
    if (!match) return { label: String(line || ''), commit: '' };
    const version = match[1];
    const commit = match[2] || '';
    return { label: version, commit: commit && version.startsWith(commit) ? '' : commit };
  }

  function archOf(platform) {
    const asset = String((platform && platform.asset) || '');
    return asset.startsWith(ASSET_PREFIX) ? asset.slice(ASSET_PREFIX.length) : '';
  }

  function formatDate(iso) {
    const date = new Date(String(iso || ''));
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('ru-RU');
  }

  function usableKeys(section) {
    if (!section || !section.present) return 0;
    return Math.max(0, Number(section.keys || 0) - Number(section.invalid || 0));
  }

  function renderFormats(formats) {
    const box = byId('dt-happ-formats');
    if (!box) return;
    box.textContent = '';
    for (const name of ALL_FORMATS) {
      let tone = formats.includes(name) ? 'ok' : 'muted';
      if (name === state.missingKeyFormat) tone = 'warn';
      const badge = document.createElement('code');
      badge.className = `dt-badge dt-badge-${tone}`;
      badge.textContent = name;
      box.appendChild(badge);
    }
  }

  function renderStatus(st) {
    if (!st || typeof st !== 'object') return;
    state.status = st;
    const installed = !!st.installed;
    const report = st.keys && typeof st.keys === 'object' ? st.keys : null;
    const formats = report && Array.isArray(report.formats) ? report.formats : [];
    const files = st.keys_meta && st.keys_meta.files && typeof st.keys_meta.files === 'object' ? st.keys_meta.files : {};
    const arch = archOf(st.platform);

    let verdict = ['bad', 'Не установлен'];
    let note = 'ссылки happ://crypt… сейчас не импортируются';
    if (installed) {
      if (state.missingKeyFormat) {
        verdict = ['warn', 'Нужны новые ключи'];
        note = '';
      } else if (formats.length === ALL_FORMATS.length) {
        verdict = ['ok', 'Готов к расшифровке'];
        note = '';
      } else if (formats.length) {
        verdict = ['warn', 'Не все ключи'];
        note = 'часть ссылок не расшифруется — обновите ключи';
      } else {
        verdict = ['warn', 'Нет ключей'];
        note = 'нажмите «Обновить ключи» или загрузите файл ключей';
      }
    }
    if (st.cmd_override) {
      note = [note, 'задана XKEEN_HAPP_DECRYPTOR_CMD — импорт использует её'].filter(Boolean).join(' · ');
    }
    setTone('dt-happ-verdict', 'dt-pill', verdict[0], verdict[1]);
    setText('dt-happ-verdict-note', note);

    if (installed) {
      const version = parseVersion(st.version);
      setTone('dt-happ-engine', 'dt-value', 'ok', version.label);
      setText('dt-happ-engine-sub', [arch, version.commit].filter(Boolean).join(' · '));
    } else if (st.kind === 'node') {
      setTone('dt-happ-engine', 'dt-value', 'warn', 'старый Node‑декриптор');
      setText('dt-happ-engine-sub', 'нужен node — установите движок');
    } else if (st.kind === 'native') {
      setTone('dt-happ-engine', 'dt-value', 'bad', 'движок не запускается');
      setText('dt-happ-engine-sub', 'переустановите движок');
    } else if (st.kind === 'other') {
      setTone('dt-happ-engine', 'dt-value', 'warn', 'сторонний декриптор');
      setText('dt-happ-engine-sub', '');
    } else {
      setTone('dt-happ-engine', 'dt-value', 'neutral', 'не найден');
      setText('dt-happ-engine-sub', '');
    }

    show('dt-happ-arch-row', !installed);
    if (!installed) {
      const supported = !!(st.platform && st.platform.supported);
      setTone('dt-happ-arch', 'dt-value', supported ? 'neutral' : 'bad', supported ? arch : 'не поддерживается');
      setText('dt-happ-arch-sub', supported ? String(st.platform.asset || '') : String((st.platform && st.platform.arch) || ''));
    }

    show('dt-happ-formats-row', installed);
    if (installed) renderFormats(formats);

    setText(
      'dt-happ-keys',
      installed && report
        ? `${usableKeys(report.crypt5_keys)} для crypt5 · ${usableKeys(report.legacy_keys)} для crypt…crypt4`
        : '—',
    );

    const entry = files['crypt5-keys.json'] || files['legacy_keys.json'] || null;
    show('dt-happ-keyset-row', !!entry);
    if (entry) {
      const manual = entry.source === 'upload';
      setText('dt-happ-keyset', manual ? 'вручную' : (String(entry.commit || '').slice(0, 7) || '—'));
      setText(
        'dt-happ-keyset-sub',
        [manual ? '' : entry.repo, formatDate(entry.installed_at), manual ? 'загружен файлом' : 'по манифесту']
          .filter(Boolean)
          .join(' · '),
      );
    }

    show('dt-happ-alert', !installed);

    const install = byId('dt-happ-install');
    if (install) {
      install.textContent = installed ? 'Переустановить движок' : 'Установить декриптор';
      install.className = installed ? 'btn-secondary' : 'xkeen-ctrl-btn';
    }
    const updateKeys = byId('dt-happ-update-keys');
    if (updateKeys) {
      updateKeys.style.display = installed ? '' : 'none';
      const wanted = installed && (state.missingKeyFormat || formats.length < ALL_FORMATS.length);
      updateKeys.className = wanted ? 'xkeen-ctrl-btn' : 'btn-secondary';
    }
  }

  function setBusy(busy) {
    state.busy = !!busy;
    for (const id of BUTTON_IDS) {
      const el = byId(id);
      if (el) el.disabled = !!busy;
    }
  }

  // busyText goes to the card status line; onError lets the link check report in its own block.
  async function runAction(busyText, action, onError) {
    if (state.busy) return null;
    setBusy(true);
    if (busyText) setStatusLine(busyText, 'warn');
    try {
      return await action();
    } catch (error) {
      const text = 'Не удалось выполнить действие: ' + String((error && error.message) || error);
      if (onError) onError(text);
      else setStatusLine(text, 'bad');
      return null;
    } finally {
      setBusy(false);
    }
  }

  function applyResult(data, successText) {
    if (!data) return;
    if (data.status) renderStatus(data.status);
    if (data.ok) {
      const text = successText(data);
      setStatusLine(text, 'ok');
      toast(text);
    } else {
      setStatusLine(String(data.hint || data.error || 'Не удалось выполнить действие.'), 'bad');
    }
  }

  function describeKeys(keys) {
    const installed = keys && Array.isArray(keys.installed) ? keys.installed : [];
    if (!installed.length) return '';
    const commit = keys.manifest && keys.manifest.commit ? ` (коммит ${String(keys.manifest.commit).slice(0, 7)})` : '';
    return `ключи: ${installed.join(', ')}${commit}`;
  }

  async function loadStatus(quiet) {
    try {
      const data = await request(ROUTES.status, { method: 'GET' });
      if (data && data.ok && data.status) {
        renderStatus(data.status);
        if (!quiet) setStatusLine('Статус обновлён.', 'ok');
      } else if (!quiet) {
        setStatusLine(String((data && data.hint) || 'Не удалось получить статус декриптора.'), 'bad');
      }
      return data;
    } catch (error) {
      if (!quiet) setStatusLine('Не удалось получить статус декриптора: ' + String((error && error.message) || error), 'bad');
      return null;
    }
  }

  async function install() {
    const installed = !!(state.status && state.status.installed);
    const confirmed = await confirmAction({
      title: installed ? 'Переустановить движок' : 'Установить декриптор Happ',
      message: installed
        ? 'Скачать движок заново из релиза Xkeen-UI? Текущий файл сохранится как .bak, ключи останутся на месте.'
        : 'Скачать движок из релиза Xkeen-UI и ключи Happ из репозитория LeeeeT/happ-decryptor на GitHub?',
      okText: installed ? 'Переустановить' : 'Установить',
      cancelText: 'Отмена',
    });
    if (!confirmed) return;
    const data = await runAction(
      installed ? 'Переустанавливаю движок…' : 'Устанавливаю движок и ключи Happ…',
      () => postJSON(ROUTES.install, installed ? { keys: false } : {}),
    );
    if (data && data.ok && data.keys) state.missingKeyFormat = '';
    applyResult(data, (d) => {
      const version = (d.engine && d.engine.version) || 'движок';
      return ['Установлено: ' + version, describeKeys(d.keys)].filter(Boolean).join('; ') + '.';
    });
  }

  async function updateKeys() {
    const confirmed = await confirmAction({
      title: 'Обновить ключи Happ',
      message: 'Скачать ключи Happ из репозитория LeeeeT/happ-decryptor по коммиту из манифеста? Перед заменой их проверит движок.',
      okText: 'Обновить',
      cancelText: 'Отмена',
    });
    if (!confirmed) return;
    const data = await runAction('Скачиваю ключи Happ…', () => postJSON(ROUTES.keys, {}));
    if (data && data.ok) state.missingKeyFormat = '';
    applyResult(data, (d) => 'Ключи обновлены: ' + (describeKeys(d.keys).replace(/^ключи: /, '') || 'готово') + '.');
  }

  async function isElf(file) {
    try {
      const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
      return head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46;
    } catch (e) {
      return false;
    }
  }

  async function uploadFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const engines = [];
    for (const file of files) {
      if (await isElf(file)) engines.push(file);
    }
    if (engines.length && files.length > 1) {
      setStatusLine('Движок загружайте отдельно от файлов ключей.', 'bad');
      return;
    }
    if (engines.length) {
      const data = await runAction('Устанавливаю движок из файла…', () => postFiles(ROUTES.install, engines));
      applyResult(data, (d) => 'Движок установлен из файла: ' + ((d.engine && d.engine.version) || files[0].name) + '.');
      return;
    }
    const data = await runAction('Устанавливаю ключи из файла…', () => postFiles(ROUTES.upload, files));
    if (data && data.ok) state.missingKeyFormat = '';
    applyResult(data, (d) => 'Ключи загружены: ' + (((d.keys && d.keys.installed) || []).join(', ') || 'готово') + '.');
  }

  function formatOfLink(link) {
    const match = String(link || '').trim().match(/^happ:\/\/(crypt\d*)\//i);
    return match ? match[1].toLowerCase() : '';
  }

  function showCheckResult(text, tone) {
    const el = byId('dt-happ-check-result');
    if (!el) return;
    el.style.display = text ? '' : 'none';
    el.className = tone === 'bad' ? 'dt-alert' : `status ${tone}`;
    el.textContent = String(text || '');
  }

  async function checkLink() {
    const input = byId('dt-happ-check-link');
    const link = String((input && input.value) || '').trim();
    if (!link) {
      showCheckResult('Вставьте ссылку вида happ://crypt….', 'bad');
      return;
    }
    showCheckResult('Проверяю ссылку…', 'warn');
    const data = await runAction('', () => postJSON(ROUTES.check, { link }), (text) => showCheckResult(text, 'bad'));
    if (!data) return;
    if (data.ok && data.check) {
      state.missingKeyFormat = '';
      const layout = LAYOUTS[data.check.layout] ? `, ${LAYOUTS[data.check.layout]}` : '';
      showCheckResult(`Расшифровано (${data.check.format}${layout}): ${data.check.url}`, 'ok');
    } else {
      state.missingKeyFormat = data.error === 'unknown_key' ? (formatOfLink(link) || 'crypt5') : '';
      showCheckResult(String(data.hint || 'Не удалось проверить ссылку.'), 'bad');
    }
    renderStatus(data.status || state.status);
  }

  function init() {
    if (state.inited) return;
    state.inited = true;

    const onClick = (id, handler) => {
      const el = byId(id);
      if (el) el.addEventListener('click', () => { Promise.resolve(handler()).catch(() => {}); });
    };
    onClick('dt-happ-install', install);
    onClick('dt-happ-update-keys', updateKeys);
    onClick('dt-happ-refresh', () => loadStatus(false));
    onClick('dt-happ-check-run', checkLink);

    const fileInput = byId('dt-happ-upload-input');
    onClick('dt-happ-upload', () => { if (fileInput && !state.busy) fileInput.click(); });
    if (fileInput) {
      fileInput.addEventListener('change', () => {
        uploadFiles(fileInput.files).catch(() => {}).finally(() => { fileInput.value = ''; });
      });
    }

    const linkInput = byId('dt-happ-check-link');
    if (linkInput) {
      linkInput.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        checkLink().catch(() => {});
      });
    }

    loadStatus(true).catch(() => {});
  }

  setDevtoolsNamespaceApi('devtoolsHappDecryptor', {
    init,
    loadStatus,
    checkLink,
    renderStatus,
  });
})();
