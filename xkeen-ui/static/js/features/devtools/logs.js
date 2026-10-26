import { getDevtoolsNamespace, getDevtoolsSharedApi, setDevtoolsNamespaceApi } from '../devtools_namespace.js';
import { iconHtml } from '../../ui/operator_icons.js';
import { createPanelLogView } from '../panel_log_view.js';
import { panelLogKind } from '../panel_log_parser.js';

// DevTools -> Logs: the panel's own log files (core, update, restart, ...).
//
// One header row in the style of the Xray logs screen: the file as a segment,
// level, online / pause / stop, search, the "⋯" menu and fullscreen. The table
// itself is panel_log_view.js; this module fetches the tail of the chosen file
// (WebSocket stream, polling as a fallback) and keeps the controls in step.

(() => {
  'use strict';

  const DT = getDevtoolsNamespace();
  void DT;
  const SH = getDevtoolsSharedApi() || {};
  const toast = SH.toast || function (m) { try { console.log(m); } catch (e) {} };
  const getJSON = SH.getJSON || (async (u) => {
    const r = await fetch(u, { cache: 'no-store' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d && d.error) ? String(d.error) : ('HTTP ' + r.status));
    return d;
  });
  const postJSON = SH.postJSON || (async (u, b) => {
    const r = await fetch(u, { cache: 'no-store', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d && d.error) ? String(d.error) : ('HTTP ' + r.status));
    return d;
  });
  const byId = SH.byId || ((id) => { try { return document.getElementById(id); } catch (e) { return null; } });
  const escapeHtml = SH.escapeHtml || ((s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
  const fallbackCopyText = SH.fallbackCopyText || ((t) => {
    const ta = document.createElement('textarea');
    ta.value = String(t || '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    try { document.execCommand('copy'); toast('Скопировано'); } catch (e) { toast('Не удалось скопировать', true); }
    try { ta.remove(); } catch (e) {}
  });
  const confirmAction = SH.confirmAction || (async (opts) => {
    if (window.XKeen && window.XKeen.ui && typeof window.XKeen.ui.confirm === 'function') return !!(await window.XKeen.ui.confirm(opts || {}));
    return false;
  });

  const LS = {
    live: 'xkeen.devtools.logs.live',
    liveTouched: 'xkeen.devtools.logs.live.touched',
    file: 'xkeen.devtools.logs.file',
    follow: 'xkeen.devtools.logs.follow',
    fold: 'xkeen.devtools.logs.fold',
    lines: 'xkeen.devtools.logs.lines',
    interval: 'xkeen.devtools.logs.interval',
  };
  const LIST_POLL_MS = 5000;
  const LINES_DEFAULT = 400;
  const LINES_MAX = 5000;

  const S = {
    inited: false,
    activeTab: 'tools',
    list: [],
    meta: {},
    file: '',
    kind: 'core',
    lines: [],
    cursor: null,
    path: '',
    updatedAt: 0,
    loading: false,
    live: false,
    paused: false,
    pending: null,
    pendingCount: 0,
    follow: true,
    fold: true,
    level: 'all',
    windowLines: LINES_DEFAULT,
    intervalMs: 5000,
    pollTimer: null,
    listTimer: null,
    capWebsocket: null,
    ws: null,
    wsName: '',
    wsOpened: false,
    wsAttempt: 0,
    wsRetryTimer: null,
    wsDisabled: false,
    fullscreen: false,
    view: null,
    lastStats: null,
  };

  function lsGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function lsSet(key, value) { try { localStorage.setItem(key, String(value)); } catch (e) {} }
  function truthy(v) { return ['1', 'true', 'yes', 'on'].includes(String(v || '').trim().toLowerCase()); }
  function icon(name) { return iconHtml(name); }

  function formatBytes(n) {
    const v = Math.max(0, Number(n || 0));
    if (v < 1024) return `${v.toFixed(0)} Б`;
    if (v < 1024 * 1024) return `${(v / 1024).toFixed(1).replace('.', ',')} КБ`;
    return `${(v / (1024 * 1024)).toFixed(1).replace('.', ',')} МБ`;
  }

  function formatAge(mtime) {
    const t = Number(mtime || 0);
    if (!t) return '—';
    let d = Math.max(0, Date.now() / 1000 - t);
    if (d < 60) return `${Math.floor(d)} с назад`;
    d /= 60;
    if (d < 60) return `${Math.floor(d)} мин назад`;
    d /= 60;
    if (d < 48) return `${Math.floor(d)} ч назад`;
    return `${Math.floor(d / 24)} д назад`;
  }

  function isActive() { return S.activeTab === 'logs'; }

  // ---------- Header ----------

  // The names of the files on the buttons; the file itself is in the tooltip.
  const FILE_LABELS = {
    core: 'Панель', updates: 'Обновления', restart: 'Xkeen', install: 'Установка',
    access: 'Запросы', ws: 'WebSocket', stdout: 'Вывод', stderr: 'Ошибки процесса',
  };

  // Parts that rotation moved aside, and the install before the last one:
  // earlier records, kept in the menu.
  function isOlder(name) { return /\.\d+$/.test(name) || name === 'install-previous'; }

  function shortDay(mtime) {
    const t = Number(mtime);
    if (!Number.isFinite(t) || t <= 0) return '';
    return new Date(t * 1000).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  }

  function fileLabel(f) {
    const name = String(f.name || '');
    if (name === 'install-previous') {
      const day = shortDay(f.mtime);
      return day ? `Предыдущая установка, ${day}` : 'Предыдущая установка';
    }
    const part = /^(.*)\.\d+$/.exec(name);
    if (part) {
      const base = FILE_LABELS[part[1]] || part[1];
      const day = shortDay(f.mtime);
      return day ? `${base}, до ${day}` : `${base}, раньше`;
    }
    return FILE_LABELS[name] || name;
  }

  function fileName(f) {
    const path = String(f.path || '');
    return path ? path.split('/').pop() : `${f.name}.log`;
  }

  function hasContent(it) { return it.exists && Number(it.size || 0) > 0; }
  function liveFiles() { return S.list.filter((it) => hasContent(it) && !isOlder(it.name)); }
  function olderFiles() { return S.list.filter((it) => hasContent(it) && isOlder(it.name)); }
  function emptyFiles() { return S.list.filter((it) => !hasContent(it) && !isOlder(it.name)); }

  function renderFiles() {
    const seg = byId('dt-log-files');
    if (seg) {
      const files = liveFiles();
      if (S.file && !files.some((f) => f.name === S.file)) {
        const cur = S.list.find((f) => f.name === S.file);
        if (cur) files.push(cur);
      }
      const html = files.map((f) => {
        const on = f.name === S.file;
        const title = `${fileName(f)} · ${formatBytes(f.size)} · обновлён ${formatAge(f.mtime)}`;
        return `<button type="button" role="radio" class="xk-xlog-seg-btn${on ? ' is-on' : ''}" aria-checked="${on}" data-log-name="${escapeHtml(f.name)}" title="${escapeHtml(title)}">${escapeHtml(fileLabel(f))}<span class="n">${escapeHtml(formatBytes(f.size))}</span></button>`;
      }).join('');
      if (seg._html !== html) {
        seg._html = html;
        seg.innerHTML = html || '<span class="xk-xlog-seg-empty">Файлов нет</span>';
      }
    }
    const emptyBox = byId('dt-log-empty-list');
    if (emptyBox) {
      const empties = emptyFiles().filter((f) => f.name !== S.file);
      const html = empties.map((f) => `<button type="button" class="xk-xlog-menu-item" role="menuitem" data-log-name="${escapeHtml(f.name)}" title="${escapeHtml(fileName(f))}">${icon('list-details')}<span>${escapeHtml(fileLabel(f))}</span><em>${f.exists ? '0 Б' : 'нет файла'}</em></button>`).join('');
      if (emptyBox._html !== html) {
        emptyBox._html = html;
        emptyBox.innerHTML = html;
      }
      const block = byId('dt-log-empty-block');
      if (block) block.hidden = !empties.length;
    }
    const olderBox = byId('dt-log-older-list');
    if (olderBox) {
      const older = olderFiles().filter((f) => f.name !== S.file);
      const html = older.map((f) => `<button type="button" class="xk-xlog-menu-item" role="menuitem" data-log-name="${escapeHtml(f.name)}" title="${escapeHtml(fileName(f))}">${icon('list-details')}<span>${escapeHtml(fileLabel(f))}</span><em>${escapeHtml(formatBytes(f.size))}</em></button>`).join('');
      if (olderBox._html !== html) {
        olderBox._html = html;
        olderBox.innerHTML = html;
      }
      const block = byId('dt-log-older-block');
      if (block) block.hidden = !older.length;
    }
    const dlName = byId('dt-log-download-name');
    const current = S.meta[S.file];
    if (dlName) dlName.textContent = S.file ? fileName(current || { name: S.file, path: S.path }) : 'лог';
  }

  function renderLevel(stats) {
    const st = stats || S.lastStats || { total: 0, warnings: 0, errors: 0 };
    const seg = byId('dt-log-level-seg');
    if (!seg) return;
    seg.querySelectorAll('[data-level]').forEach((btn) => {
      const on = btn.dataset.level === S.level;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
      const n = btn.querySelector('.n');
      if (n) {
        const v = btn.dataset.level === 'error' ? st.errors : (btn.dataset.level === 'warning' ? st.warnings : st.total);
        n.textContent = String(v || 0);
      }
    });
  }

  function renderRun() {
    const play = byId('dt-log-play');
    const pause = byId('dt-log-pause');
    const stop = byId('dt-log-stop');
    const lamp = byId('dt-log-lamp');
    if (play) {
      const resume = S.live && S.paused;
      play.hidden = S.live && !S.paused;
      const label = play.querySelector('[data-plog-play-label]');
      if (label) label.textContent = resume ? 'Продолжить' : 'Онлайн';
      play.title = resume ? 'Показать накопившиеся строки и продолжить' : 'Онлайн: новые строки подтягиваются сами';
      const badge = play.querySelector('.xk-xlog-badge');
      if (badge) {
        badge.hidden = !(resume && S.pendingCount > 0);
        badge.textContent = `+${S.pendingCount}`;
      }
    }
    if (pause) pause.hidden = !(S.live && !S.paused);
    if (stop) stop.disabled = !S.live;
    if (lamp) {
      const stateName = !S.live ? 'off' : (S.paused ? 'armed' : 'on');
      lamp.dataset.state = stateName;
      const label = lamp.querySelector('[data-plog-lamp-label]');
      if (label) label.textContent = !S.live ? 'Снимок' : (S.paused ? 'Пауза' : 'Онлайн');
      lamp.title = !S.live ? 'Показан снимок файла; онлайн выключен' : (S.paused ? 'Онлайн на паузе: строки копятся' : 'Новые строки появляются сами');
    }
  }

  function renderFoot(stats) {
    const st = stats || S.lastStats;
    const statsEl = byId('dt-log-stats');
    if (statsEl && st) {
      const parts = [`Строк: <b>${st.lines}</b>`];
      parts.push(`Показано: <b>${st.visible}</b>${st.folded ? ' · повторы свёрнуты' : ''}`);
      statsEl.innerHTML = parts.map((p) => `<span>${p}</span>`).join('');
    }
    const pathEl = byId('dt-log-path');
    if (pathEl) pathEl.innerHTML = S.path ? `Файл: <b>${escapeHtml(S.path)}</b>` : '';
    const upd = byId('dt-log-list-status');
    if (upd) upd.textContent = S.updatedAt ? `Обновлено ${new Date(S.updatedAt).toLocaleTimeString('ru-RU')}` : '';
    const copyCount = byId('dt-log-copy-count');
    if (copyCount && st) copyCount.textContent = String(st.visible);
  }

  function onViewChange(stats) {
    S.lastStats = stats;
    renderLevel(stats);
    renderFoot(stats);
  }

  // ---------- Data ----------

  function setLines(lines) {
    S.lines = lines;
    S.updatedAt = Date.now();
    if (S.view) S.view.setData(S.kind, S.lines);
  }

  function applyUpdate(name, update, isAuto) {
    if (name !== S.file) return;
    S.cursor = update.exists ? (update.cursor || null) : null;
    if (update.path) S.path = update.path;
    if (update.size != null && S.meta[name]) {
      S.meta[name] = Object.assign({}, S.meta[name], { size: update.size, mtime: update.mtime, exists: update.exists });
      const it = S.list.find((f) => f.name === name);
      if (it) Object.assign(it, { size: update.size, mtime: update.mtime, exists: update.exists });
      renderFiles();
    }
    if (!update.exists) {
      S.lines = [];
      if (S.view) S.view.setEmpty('<b>Файла нет</b><span>Панель ещё ничего в него не писала.</span>');
      renderFoot();
      return;
    }
    const incoming = Array.isArray(update.lines) ? update.lines : [];
    const append = update.mode === 'append';
    if (S.paused && isAuto) {
      if (append) {
        S.pending = (S.pending || S.lines.slice()).concat(incoming);
        S.pendingCount += incoming.length;
      } else {
        S.pending = incoming.slice();
        S.pendingCount = Math.max(S.pendingCount, 1);
      }
      if (S.pending.length > S.windowLines) S.pending = S.pending.slice(S.pending.length - S.windowLines);
      renderRun();
      return;
    }
    let next = append ? S.lines.concat(incoming) : incoming.slice();
    if (next.length > S.windowLines) next = next.slice(next.length - S.windowLines);
    setLines(next);
    renderFoot();
  }

  function normalizeUpdate(data) {
    const mode = String((data && data.mode) || '').toLowerCase();
    return {
      mode: (mode === 'append' || (data && (data.type === 'append' || data.type === 'line'))) ? 'append' : 'full',
      lines: Array.isArray(data && data.lines) ? data.lines : (typeof (data && data.line) === 'string' ? [data.line] : []),
      cursor: data && data.cursor ? String(data.cursor) : null,
      path: data && data.path ? String(data.path) : '',
      exists: data && typeof data.exists !== 'undefined' ? !!data.exists : true,
      size: data && typeof data.size !== 'undefined' ? Number(data.size || 0) : null,
      mtime: data && typeof data.mtime !== 'undefined' ? Number(data.mtime || 0) : null,
    };
  }

  function tailUrl(name, cursor) {
    let url = `/api/devtools/logs/${encodeURIComponent(name)}?lines=${encodeURIComponent(String(S.windowLines))}`;
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
    return url;
  }

  async function loadLogTail(isAuto) {
    const name = S.file;
    if (!name) {
      if (S.view) S.view.setEmpty('<b>Логов нет</b><span>Список файлов пуст.</span>');
      return;
    }
    if (S.loading) return;
    if (!isAuto) {
      S.cursor = null;
      S.paused = false;
      S.pending = null;
      S.pendingCount = 0;
      renderRun();
    }
    S.loading = true;
    try {
      const usedCursor = isAuto ? S.cursor : null;
      const data = await getJSON(tailUrl(name, usedCursor));
      applyUpdate(name, normalizeUpdate(data), !!isAuto);
    } catch (e) {
      if (!isAuto) toast(`Не удалось загрузить лог: ${e && e.message ? e.message : e}`, true);
    } finally {
      S.loading = false;
    }
  }

  async function loadLogList(silent) {
    try {
      const data = await getJSON('/api/devtools/logs');
      const list = (data && Array.isArray(data.logs) ? data.logs : [])
        // access.log of the panel duplicates what the Xray logs screen shows.
        .filter((it) => it && it.name && !/^access(\.|$)/i.test(String(it.name)));
      S.list = list;
      S.meta = {};
      list.forEach((it) => { S.meta[it.name] = it; });
      if (!S.file || !S.meta[S.file]) {
        const stored = lsGet(LS.file);
        const pick = (stored && S.meta[stored]) ? stored : ((liveFiles()[0] || list[0] || {}).name || '');
        if (pick !== S.file) selectFile(pick, { load: false });
      }
      renderFiles();
    } catch (e) {
      if (!silent) toast(`Не удалось получить список логов: ${e && e.message ? e.message : e}`, true);
    }
  }

  function selectFile(name, opts) {
    const next = String(name || '');
    const changed = next !== S.file;
    S.file = next;
    S.kind = panelLogKind(next);
    S.cursor = null;
    S.path = S.meta[next] && S.meta[next].path ? String(S.meta[next].path) : '';
    if (next) lsSet(LS.file, next);
    const card = byId('dt-logs-card');
    if (card) card.dataset.plogKind = S.kind;
    const levelSeg = byId('dt-log-level-seg');
    // Runs and operations have a result, not levels.
    const levelless = S.kind === 'update' || S.kind === 'operations';
    if (levelSeg) levelSeg.hidden = levelless;
    if (levelless && S.level !== 'all') setLevel('all');
    renderFiles();
    if (changed && (!opts || opts.load !== false)) restartStream();
  }

  // ---------- Online ----------

  function wsWanted() {
    return S.live && isActive() && !S.wsDisabled && S.capWebsocket !== false && typeof WebSocket !== 'undefined';
  }

  function stopPolling() {
    if (S.pollTimer) clearInterval(S.pollTimer);
    S.pollTimer = null;
  }

  function startPolling() {
    if (!S.live || !isActive() || S.pollTimer) return;
    if (S.ws && S.ws.readyState === 1) return;
    S.pollTimer = setInterval(() => {
      if (isActive() && S.live) loadLogTail(true);
    }, Math.max(1000, S.intervalMs));
  }

  function wsStop() {
    if (S.wsRetryTimer) clearTimeout(S.wsRetryTimer);
    S.wsRetryTimer = null;
    S.wsAttempt = 0;
    if (S.ws) {
      S.ws.__xkManualClose = true;
      try { S.ws.close(); } catch (e) {}
    }
    S.ws = null;
    S.wsName = '';
    S.wsOpened = false;
  }

  function wsRetry() {
    if (S.wsRetryTimer) clearTimeout(S.wsRetryTimer);
    if (!wsWanted()) return;
    S.wsAttempt = Math.min(12, S.wsAttempt + 1);
    const delay = Math.min(30000, 600 * Math.pow(2, Math.min(8, S.wsAttempt - 1)));
    S.wsRetryTimer = setTimeout(() => {
      S.wsRetryTimer = null;
      wsConnect();
    }, delay + Math.floor(delay * 0.2 * Math.random()));
  }

  function wsConnect() {
    if (!wsWanted() || !S.file) return;
    const name = S.file;
    if (S.ws && S.wsName === name && S.ws.readyState <= 1) return;
    if (S.ws) {
      S.ws.__xkManualClose = true;
      try { S.ws.close(); } catch (e) {}
    }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let url = `${proto}//${location.host}/ws/devtools-logs?name=${encodeURIComponent(name)}&lines=${encodeURIComponent(String(S.windowLines))}`;
    if (S.cursor) url += `&cursor=${encodeURIComponent(S.cursor)}`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      S.wsDisabled = true;
      startPolling();
      return;
    }
    S.ws = ws;
    S.wsName = name;
    S.wsOpened = false;
    ws.onopen = () => {
      if (S.ws !== ws) return;
      S.wsOpened = true;
      S.wsAttempt = 0;
      stopPolling();
    };
    ws.onmessage = (ev) => {
      if (S.ws !== ws) return;
      let data;
      try { data = JSON.parse(ev && ev.data ? ev.data : '{}'); } catch (e) { return; }
      if (!data) return;
      if (data.name && String(data.name) !== S.wsName) return;
      if (data.type === 'error') {
        S.wsDisabled = true;
        wsStop();
        startPolling();
        return;
      }
      applyUpdate(name, normalizeUpdate(data), true);
    };
    ws.onclose = () => {
      if (S.ws !== ws) return;
      const manual = !!ws.__xkManualClose;
      S.ws = null;
      S.wsOpened = false;
      if (manual || !wsWanted()) return;
      startPolling();
      wsRetry();
    };
  }

  function stopStreaming() {
    stopPolling();
    wsStop();
  }

  function restartStream() {
    stopStreaming();
    if (!isActive()) return;
    if (!S.live) {
      loadLogTail(false);
      return;
    }
    if (wsWanted()) {
      // Polling keeps the screen alive until the socket says it is open: on
      // some routers the handshake hangs without an event.
      startPolling();
      wsConnect();
      setTimeout(() => {
        if (isActive() && S.live && !(S.ws && S.ws.readyState === 1)) loadLogTail(true);
      }, 900);
      return;
    }
    loadLogTail(false).then(() => startPolling());
  }

  function setLive(on) {
    S.live = !!on;
    lsSet(LS.live, S.live ? '1' : '0');
    lsSet(LS.liveTouched, '1');
    if (!S.live) {
      S.paused = false;
      resumePending();
      stopStreaming();
    } else {
      restartStream();
    }
    renderRun();
  }

  function resumePending() {
    const pending = S.pending;
    S.pending = null;
    S.pendingCount = 0;
    if (pending) setLines(pending);
  }

  function setPaused(on) {
    if (!S.live) return;
    S.paused = !!on;
    if (!S.paused) resumePending();
    renderRun();
  }

  // ---------- Controls ----------

  function setLevel(level) {
    S.level = ['warning', 'error'].includes(level) ? level : 'all';
    if (S.view) S.view.setLevel(S.level);
    renderLevel();
  }

  function copyText(text, okMessage) {
    const value = String(text || '');
    if (!value) {
      toast('Нечего копировать');
      return;
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(() => toast(okMessage || 'Скопировано'), () => fallbackCopyText(value));
        return;
      }
    } catch (e) {}
    fallbackCopyText(value);
  }

  function downloadCurrent() {
    if (!S.file) return;
    const a = document.createElement('a');
    a.href = `/api/devtools/logs/${encodeURIComponent(S.file)}/download`;
    a.download = fileName(S.meta[S.file] || { name: S.file, path: S.path });
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function clearCurrent() {
    const name = S.file;
    if (!name) return;
    const ok = await confirmAction({
      title: 'Очистить лог?',
      message: `Файл ${name}.log будет обнулён на роутере. Это действие необратимо.`,
      okText: 'Очистить',
      cancelText: 'Отменить',
      danger: true,
    });
    if (!ok) return;
    stopStreaming();
    try {
      await postJSON(`/api/devtools/logs/${encodeURIComponent(name)}/truncate`, {});
      toast(`Лог очищен: ${name}`);
      S.lines = [];
      S.cursor = null;
      if (S.view) S.view.clear();
      await loadLogList(true);
    } catch (e) {
      toast(`Не удалось очистить лог: ${e && e.message ? e.message : e}`, true);
    }
    restartStream();
  }

  function setFullscreen(on) {
    const card = byId('dt-logs-card');
    if (!card) return;
    S.fullscreen = !!on;
    card.classList.toggle('is-fullscreen', S.fullscreen);
    try { document.body.classList.toggle('dt-logs-fullscreen', S.fullscreen); } catch (e) {}
    const btn = byId('dt-log-fullscreen');
    if (btn) {
      btn.innerHTML = icon(S.fullscreen ? 'fullscreen-exit' : 'fullscreen');
      btn.title = S.fullscreen ? 'Выйти из полного экрана' : 'Полный экран';
      btn.setAttribute('aria-label', btn.title);
    }
  }

  function closeMenu() {
    const menu = byId('dt-log-more');
    if (menu) menu.removeAttribute('open');
  }

  function readPrefs() {
    S.live = truthy(lsGet(LS.liveTouched)) ? truthy(lsGet(LS.live)) : false;
    const follow = lsGet(LS.follow);
    S.follow = follow == null ? true : truthy(follow);
    const fold = lsGet(LS.fold);
    S.fold = fold == null ? true : truthy(fold);
    const lines = parseInt(String(lsGet(LS.lines) || ''), 10);
    S.windowLines = Number.isFinite(lines) ? Math.min(LINES_MAX, Math.max(50, lines)) : LINES_DEFAULT;
    const interval = parseInt(String(lsGet(LS.interval) || ''), 10);
    S.intervalMs = Number.isFinite(interval) && interval >= 1000 ? interval : 5000;
  }

  function wire() {
    const on = (id, ev, fn) => { const el = byId(id); if (el) el.addEventListener(ev, fn); };

    const files = byId('dt-log-files');
    if (files) {
      files.addEventListener('click', (ev) => {
        const btn = ev.target.closest('[data-log-name]');
        if (btn) selectFile(btn.dataset.logName);
      });
    }
    for (const id of ['dt-log-empty-list', 'dt-log-older-list']) {
      const list = byId(id);
      if (!list) continue;
      list.addEventListener('click', (ev) => {
        const btn = ev.target.closest('[data-log-name]');
        if (!btn) return;
        closeMenu();
        selectFile(btn.dataset.logName);
      });
    }
    const levelSeg = byId('dt-log-level-seg');
    if (levelSeg) {
      levelSeg.addEventListener('click', (ev) => {
        const btn = ev.target.closest('[data-level]');
        if (btn) setLevel(btn.dataset.level);
      });
    }

    on('dt-log-play', 'click', () => { if (S.live && S.paused) setPaused(false); else setLive(true); });
    on('dt-log-pause', 'click', () => setPaused(true));
    on('dt-log-stop', 'click', () => setLive(false));

    const search = byId('dt-log-search');
    const clear = byId('dt-log-filter-clear');
    let searchTimer = null;
    if (search) {
      search.addEventListener('input', () => {
        if (clear) clear.hidden = !search.value;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => { if (S.view) S.view.setSearch(search.value); }, 120);
      });
      search.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Escape') return;
        search.value = '';
        if (clear) clear.hidden = true;
        if (S.view) S.view.setSearch('');
      });
    }
    if (clear) {
      clear.addEventListener('click', () => {
        if (search) search.value = '';
        clear.hidden = true;
        if (S.view) S.view.setSearch('');
        if (search) search.focus();
      });
    }
    document.addEventListener('keydown', (ev) => {
      if (!isActive()) return;
      if (ev.key === 'Escape' && S.fullscreen) {
        setFullscreen(false);
        return;
      }
      if (ev.key !== '/' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      const t = ev.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (!search) return;
      ev.preventDefault();
      search.focus();
    });

    const follow = byId('dt-log-follow');
    if (follow) {
      follow.checked = S.follow;
      follow.addEventListener('change', () => {
        S.follow = !!follow.checked;
        lsSet(LS.follow, S.follow ? '1' : '0');
        if (S.view) S.view.setFollow(S.follow);
      });
    }
    const fold = byId('dt-log-fold');
    if (fold) {
      fold.checked = S.fold;
      fold.addEventListener('change', () => {
        S.fold = !!fold.checked;
        lsSet(LS.fold, S.fold ? '1' : '0');
        if (S.view) S.view.setFold(S.fold);
      });
    }
    const linesEl = byId('dt-log-lines');
    if (linesEl) {
      linesEl.value = String(S.windowLines);
      linesEl.addEventListener('change', () => {
        const v = parseInt(String(linesEl.value || ''), 10);
        S.windowLines = Number.isFinite(v) ? Math.min(LINES_MAX, Math.max(50, v)) : LINES_DEFAULT;
        linesEl.value = String(S.windowLines);
        lsSet(LS.lines, S.windowLines);
        restartStream();
      });
    }
    const intervalEl = byId('dt-log-interval');
    if (intervalEl) {
      intervalEl.value = String(S.intervalMs);
      intervalEl.addEventListener('change', () => {
        const v = parseInt(String(intervalEl.value || ''), 10);
        S.intervalMs = Number.isFinite(v) && v >= 1000 ? v : 5000;
        lsSet(LS.interval, S.intervalMs);
        if (S.pollTimer) {
          stopPolling();
          startPolling();
        }
      });
    }

    on('dt-log-copy', 'click', () => {
      closeMenu();
      copyText(S.view ? S.view.visibleText() : '', 'Скопированы видимые записи');
    });
    on('dt-log-download', 'click', () => { closeMenu(); downloadCurrent(); });
    on('dt-log-load-more', 'click', () => {
      closeMenu();
      S.windowLines = Math.min(LINES_MAX, S.windowLines + LINES_DEFAULT);
      if (linesEl) linesEl.value = String(S.windowLines);
      restartStream();
    });
    on('dt-log-refresh', 'click', () => {
      closeMenu();
      loadLogList(true).then(() => restartStream());
    });
    on('dt-log-clear', 'click', () => { closeMenu(); clearCurrent(); });
    on('dt-log-fullscreen', 'click', () => setFullscreen(!S.fullscreen));
  }

  // ---------- Tabs ----------

  function startListPolling() {
    stopListPolling();
    S.listTimer = setInterval(() => { if (isActive()) loadLogList(true); }, LIST_POLL_MS);
  }

  function stopListPolling() {
    if (S.listTimer) clearInterval(S.listTimer);
    S.listTimer = null;
  }

  function setActiveTab(tabName) {
    const btnTools = byId('dt-tab-btn-tools');
    const btnLogs = byId('dt-tab-btn-logs');
    const tabTools = byId('dt-tab-tools');
    const tabLogs = byId('dt-tab-logs');
    const forced = (el) => !!(el && el.dataset && el.dataset.xkForceHidden === '1');
    const toolsForced = forced(btnTools) || forced(tabTools) || (btnTools && btnTools.style.display === 'none');
    const logsForced = forced(btnLogs) || forced(tabLogs) || (btnLogs && btnLogs.style.display === 'none');

    let next = tabName === 'logs' ? 'logs' : 'tools';
    if (next === 'tools' && toolsForced && !logsForced) next = 'logs';
    if (next === 'logs' && logsForced && !toolsForced) next = 'tools';
    if ((next === 'tools' && toolsForced) || (next === 'logs' && logsForced)) {
      if (tabTools) tabTools.style.display = 'none';
      if (tabLogs) tabLogs.style.display = 'none';
      stopStreaming();
      stopListPolling();
      return;
    }
    S.activeTab = next;
    if (btnTools) {
      const active = next === 'tools';
      btnTools.classList.toggle('active', active);
      btnTools.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    if (btnLogs) {
      const active = next === 'logs';
      btnLogs.classList.toggle('active', active);
      btnLogs.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    if (tabTools) tabTools.style.display = next === 'tools' ? '' : 'none';
    if (tabLogs) tabLogs.style.display = next === 'logs' ? '' : 'none';

    if (next === 'logs') {
      startListPolling();
      loadLogList(true).then(() => restartStream());
    } else {
      stopStreaming();
      stopListPolling();
      if (S.fullscreen) setFullscreen(false);
    }
  }

  function getActiveTab() {
    return S.activeTab === 'logs' ? 'logs' : 'tools';
  }

  async function openLog(name) {
    const desired = String(name || '').trim();
    S.activeTab = 'logs';
    await loadLogList(true);
    if (desired) selectFile(desired, { load: false });
    setActiveTab('logs');
    return true;
  }

  function activate(options) {
    const requested = String((options && options.activeTab) || '').trim();
    const next = requested === 'logs' ? 'logs' : (requested === 'tools' ? 'tools' : getActiveTab());
    setActiveTab(next);
    return next;
  }

  function deactivate() {
    stopStreaming();
    stopListPolling();
    return true;
  }

  function init() {
    if (S.inited) return;
    S.inited = true;
    readPrefs();
    try {
      getJSON('/api/capabilities').then((cap) => {
        S.capWebsocket = cap && typeof cap.websocket !== 'undefined' ? !!cap.websocket : null;
      }).catch(() => {});
    } catch (e) {}

    const tabTools = byId('dt-tab-btn-tools');
    const tabLogs = byId('dt-tab-btn-logs');
    if (tabTools) tabTools.addEventListener('click', () => setActiveTab('tools'));
    if (tabLogs) tabLogs.addEventListener('click', () => setActiveTab('logs'));

    const host = byId('dt-log-view');
    if (host) {
      S.view = createPanelLogView({
        root: host,
        chips: byId('dt-log-chips'),
        icon,
        onCopy: copyText,
        onChange: onViewChange,
      });
      S.view.setFold(S.fold);
      S.view.setFollow(S.follow);
    }
    wire();
    renderRun();
    renderLevel();
  }

  setDevtoolsNamespaceApi('devtoolsLogs', {
    init,
    setActiveTab,
    getActiveTab,
    openLog,
    activate,
    deactivate,
    loadLogList,
    loadLogTail,
  });
})();
