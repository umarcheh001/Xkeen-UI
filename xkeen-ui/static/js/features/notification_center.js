import { iconHtml } from '../ui/operator_icons.js';
import { wireTopLevelNavigation } from '../pages/top_level_nav.shared.js';

const API_BASE = '/api/notifications';
const CHANNEL_NAME = 'xkeen-notification-center.v1';
const NARROW = '(max-width: 680px)';
// Release notes lead to the screen where the update is planned and applied:
// the panel update, and the update of one module inside the installed release.
const RECORD_LINKS = {
  'panel-update': 'К обновлению',
  'module-new': 'К обновлению',
  'module-update': 'К обновлению',
  module_update_available: 'К обновлению',
};

// The card drawn when the panel itself did not answer: no record behind it.
const LOCAL_ERROR_ID = 'local-error';

function text(value) {
  return String(value == null ? '' : value);
}

function formatTime(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    }).format(new Date(timestamp * 1000));
  } catch (error) {
    return '';
  }
}

function formatSize(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let amount = bytes;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount >= 10 || index === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[index]}`;
}

function apiError(payload, status) {
  const error = new Error(text(payload?.message || payload?.error || 'Не удалось получить уведомления.'));
  error.code = text(payload?.code || 'notification_request_failed');
  error.status = status;
  return error;
}

async function request(path = '', method = 'GET', body) {
  const headers = { 'Cache-Control': 'no-store' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const csrf = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content');
  if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method, headers, credentials: 'same-origin', cache: 'no-store',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    const network = new Error('Не удалось связаться с панелью.');
    network.code = 'network_error';
    throw network;
  }
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw apiError(null, response.status);
  }
  if (!response.ok || payload?.ok === false) throw apiError(payload, response.status);
  return payload;
}

function button(label, className, handler) {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className;
  node.textContent = label;
  node.addEventListener('click', handler);
  return node;
}

function createCenter() {
  const root = document.createElement('div');
  root.className = 'xk-notification-center';
  root.innerHTML = `
    <button type="button" class="xk-notification-trigger xk-header-btn" aria-haspopup="dialog" aria-expanded="false" aria-label="Уведомления">
      ${iconHtml('bell', 'xk-notification-trigger__icon')}
      <span class="xk-notification-trigger__count" hidden></span>
    </button>`;
  // The window lives in the page layer: a header or a menu that clips or
  // stacks its children can neither cut it nor draw over it.
  const popover = document.createElement('section');
  popover.className = 'xk-notification-popover';
  // The id keeps the window global when screens move the body into their roots.
  popover.id = 'xk-notification-popover';
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', 'Центр уведомлений');
  popover.hidden = true;
  popover.innerHTML = `
    <div class="xk-notification-popover__head">
      <div>
        <strong>Центр уведомлений</strong>
        <span class="xk-notification-status" aria-live="polite"></span>
      </div>
      <button type="button" class="xk-notification-close" aria-label="Закрыть">×</button>
    </div>
    <div class="xk-notification-list" aria-live="polite"></div>
    <div class="xk-notification-popover__foot">
      <button type="button" class="xk-notification-check">Проверить обновления</button>
    </div>`;
  document.body.append(popover);
  return { root, popover };
}

// Screens switched without a reload stay in the document, hidden: the bell
// belongs to the header on display. Before the first paint nothing is on
// display yet, and the first header found is the one being built.
function rendered(node) {
  return node.getClientRects().length > 0;
}

function headerTargets() {
  const gears = [...document.querySelectorAll('.xk-header-panel-trigger')];
  const rows = [...document.querySelectorAll('.header-actions')];
  const gear = gears.find(rendered);
  const actions = rows.find(rendered);
  if (gear || actions) return { gear: gear || null, actions: gear ? null : actions };
  return { gear: gears[0] || null, actions: gears[0] ? null : rows[0] || null };
}

function placeCenter(root) {
  const trigger = root.querySelector('.xk-notification-trigger');
  // The main panel keeps its actions in the gear menu; the bell stands
  // beside the gear so the count is never hidden behind a click.
  const targets = headerTargets();
  const gear = targets.gear?.parentElement;
  trigger.classList.toggle('btn-secondary', Boolean(gear));
  trigger.classList.toggle('xk-header-disclosure-trigger', Boolean(gear));
  trigger.classList.toggle('xk-header-btn', !gear);
  if (gear) {
    if (root.nextElementSibling !== gear) gear.before(root);
    return;
  }
  const actions = targets.actions;
  const scope = actions?.closest('[data-xk-top-level-screen-root]') || document;
  const title = actions ? scope.querySelector('h1') : null;
  if (title && window.matchMedia(NARROW).matches) {
    // A phone wraps the button row; the title line keeps the bell in sight.
    let row = title.parentElement;
    if (!row.classList.contains('xk-notification-title-row')) {
      row = document.createElement('div');
      row.className = 'xk-notification-title-row';
      title.before(row);
      row.append(title);
    }
    if (root.parentElement !== row) row.append(root);
    return;
  }
  if (actions) {
    if (actions.firstElementChild !== root) actions.prepend(root);
    return;
  }
  if (!root.isConnected) document.body.append(root);
}

function recordDetails(record) {
  const details = [];
  if (record.version) details.push(`Версия ${text(record.version)}`);
  if (record.size) details.push(formatSize(record.size));
  if (record.requires_restart) details.push('потребуется перезапуск');
  if (record.requires_installer) details.push('нужен установщик');
  const changes = record.dependency_changes || {};
  if (Array.isArray(changes.requires_added) && changes.requires_added.length) {
    details.push(`новые зависимости: ${changes.requires_added.join(', ')}`);
  }
  if (Array.isArray(changes.conflicts_added) && changes.conflicts_added.length) {
    details.push(`конфликты: ${changes.conflicts_added.join(', ')}`);
  }
  return details.join(' · ');
}

export function initNotificationCenter() {
  if (window.XKeen?.notificationCenter) return window.XKeen.notificationCenter;
  const { root, popover } = createCenter();
  placeCenter(root);
  const trigger = root.querySelector('.xk-notification-trigger');
  const count = root.querySelector('.xk-notification-trigger__count');
  const list = popover.querySelector('.xk-notification-list');
  const status = popover.querySelector('.xk-notification-status');
  const checkButton = popover.querySelector('.xk-notification-check');
  const closeButton = popover.querySelector('.xk-notification-close');
  let snapshot = { records: [], unread_count: 0, status: {} };
  let loading = false;
  let open = false;
  let broadcast = null;
  let snoozeTimer = null;

  function publish() {
    const at = Date.now();
    try { localStorage.setItem('xkeen.notification-center.changed', String(at)); } catch (error) {}
    try { broadcast?.postMessage({ type: 'changed', at }); } catch (error) {}
  }

  function positionPopover() {
    const rect = trigger.getBoundingClientRect();
    const top = Math.round(rect.bottom + 8);
    popover.style.top = `${top}px`;
    popover.style.maxHeight = `${Math.max(160, window.innerHeight - top - 12)}px`;
    if (window.matchMedia(NARROW).matches) {
      popover.style.left = '12px';
      popover.style.right = '12px';
      popover.style.width = 'auto';
    } else {
      const right = document.documentElement.clientWidth - rect.right;
      popover.style.left = 'auto';
      popover.style.right = `${Math.max(12, Math.round(right))}px`;
      popover.style.width = '';
    }
  }

  function setOpen(value, { returnFocus = true } = {}) {
    open = Boolean(value);
    if (open) positionPopover();
    popover.hidden = !open;
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    root.classList.toggle('is-open', open);
    if (open) {
      void markSeen();
      closeButton.focus();
    } else if (returnFocus) {
      trigger.focus();
    }
  }

  function scheduleSnoozeReturn() {
    if (snoozeTimer) clearTimeout(snoozeTimer);
    snoozeTimer = null;
    const seconds = Number(snapshot.status?.snooze_wake_in_s);
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    // setTimeout keeps 32 bits of milliseconds; a week fits, a day is typical.
    snoozeTimer = setTimeout(() => { void load(); }, Math.min(seconds * 1000 + 500, 2 ** 31 - 1));
  }

  function render() {
    scheduleSnoozeReturn();
    const unread = Number(snapshot.unread_count || 0);
    count.hidden = unread <= 0;
    count.textContent = unread > 99 ? '99+' : text(unread);
    trigger.classList.toggle('has-unread', unread > 0);
    const info = snapshot.status || {};
    if (info.error_code) {
      const last = formatTime(info.last_success_at);
      status.textContent = last ? `Проверка не выполнена · последняя удачная ${last}` : 'Проверка не выполнена';
      status.className = 'xk-notification-status is-error';
    } else if (info.freshness === 'stale') {
      status.textContent = `Старая копия${formatTime(info.fetched_at) ? ` · ${formatTime(info.fetched_at)}` : ''}`;
      status.className = 'xk-notification-status is-stale';
    } else if (info.last_success_at) {
      status.textContent = `Проверено ${formatTime(info.last_success_at)}`;
      status.className = 'xk-notification-status';
    } else {
      status.textContent = 'Проверка ещё не выполнялась';
      status.className = 'xk-notification-status';
    }
    list.replaceChildren();
    if (loading && !snapshot.records.length) {
      list.append(Object.assign(document.createElement('p'), { className: 'xk-notification-empty', textContent: 'Проверяем каталог…' }));
      return;
    }
    if (!snapshot.records.length) {
      list.append(Object.assign(document.createElement('p'), {
        className: 'xk-notification-empty',
        textContent: 'Новых уведомлений нет.',
      }));
      return;
    }
    snapshot.records.forEach((record) => {
      const card = document.createElement('article');
      card.className = `xk-notification-record${record.seen ? ' is-seen' : ''}`;
      const title = document.createElement('strong');
      title.textContent = text(record.title || 'Обновление');
      const message = document.createElement('p');
      message.textContent = text(record.message || '');
      const meta = document.createElement('small');
      meta.textContent = recordDetails(record);
      const actions = document.createElement('div');
      actions.className = 'xk-notification-record__actions';
      const linkLabel = RECORD_LINKS[record.kind];
      if (linkLabel) {
        const link = document.createElement('a');
        link.href = '/modules';
        link.className = 'xk-notification-action is-primary';
        link.dataset.xkTopNav = '1';
        link.textContent = linkLabel;
        link.addEventListener('click', () => setOpen(false, { returnFocus: false }));
        actions.append(link);
      }
      if (record.id === LOCAL_ERROR_ID) {
        actions.append(button('Повторить', 'xk-notification-action is-primary', () => void load()));
      } else {
        actions.append(
          button('Скрыть', 'xk-notification-action', () => void changeRecord(record.id, 'dismiss')),
          button('На день', 'xk-notification-action', () => void changeRecord(record.id, 'snooze', 24 * 60 * 60)),
        );
      }
      card.append(title, message);
      const changes = Array.isArray(record.module_changes) ? record.module_changes : [];
      if (changes.length) {
        const modules = document.createElement('ul');
        modules.className = 'xk-notification-modules';
        changes.forEach((change) => {
          const item = document.createElement('li');
          item.textContent = `${text(change?.name || change?.module_id)}: ${text(change?.from)} → ${text(change?.to)}`;
          modules.append(item);
        });
        card.append(modules);
      }
      if (meta.textContent) card.append(meta);
      card.append(actions);
      list.append(card);
    });
    wireTopLevelNavigation(list);
  }

  async function load() {
    try {
      snapshot = await request();
      render();
    } catch (error) {
      snapshot = {
        records: [{ id: LOCAL_ERROR_ID, title: 'Центр уведомлений недоступен', message: error.message, kind: 'catalog-error' }],
        unread_count: 0,
        status: { error_code: error.code },
      };
      render();
    }
  }

  async function markSeen() {
    const ids = snapshot.records.filter((record) => !record.seen && record.id).map((record) => record.id);
    if (!ids.length) return;
    try {
      snapshot = await request('/mark-seen', 'POST', { record_ids: ids });
      render();
      publish();
    } catch (error) {}
  }

  async function changeRecord(id, action, snoozeSeconds) {
    try {
      snapshot = await request(`/${encodeURIComponent(id)}`, 'PATCH', {
        action, ...(snoozeSeconds ? { snooze_seconds: snoozeSeconds } : {}),
      });
      render();
      publish();
    } catch (error) {
      status.textContent = error.message;
      status.className = 'xk-notification-status is-error';
    }
  }

  async function check() {
    if (loading) return;
    loading = true;
    checkButton.disabled = true;
    render();
    try {
      snapshot = await request('/check', 'POST', { force_refresh: true });
      publish();
    } catch (error) {
      status.textContent = error.message;
      status.className = 'xk-notification-status is-error';
    } finally {
      loading = false;
      checkButton.disabled = false;
      render();
    }
  }

  trigger.addEventListener('click', () => setOpen(!open));
  closeButton.addEventListener('click', () => setOpen(false));
  checkButton.addEventListener('click', () => void check());
  document.addEventListener('click', (event) => {
    // A click elsewhere already moved focus where the user wanted it.
    if (open && !root.contains(event.target) && !popover.contains(event.target)) setOpen(false, { returnFocus: false });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && open) setOpen(false);
  });
  window.addEventListener('storage', (event) => {
    if (event.key === 'xkeen.notification-center.changed') void load();
  });
  window.addEventListener('xkeen:notification-channel-changed', () => {
    void load();
    publish();
  });
  try {
    broadcast = new BroadcastChannel(CHANNEL_NAME);
    broadcast.addEventListener('message', (event) => {
      if (event.data?.type === 'changed') void load();
    });
  } catch (error) {}
  window.addEventListener('beforeunload', () => broadcast?.close());
  // A tab left open for hours learns what the background poll found meanwhile.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void load();
  });
  window.addEventListener('resize', () => { if (open) positionPopover(); });
  window.addEventListener('scroll', () => { if (open) positionPopover(); }, { passive: true, capture: true });
  // The main panel builds its gear after this module runs and moves its
  // controls between the header and the menus per view; the narrow layout
  // moves the bell between the button row and the title line.
  document.addEventListener('xkeen:header-shell-changed', () => placeCenter(root));
  window.addEventListener('xkeen:top-level-route-change', (event) => {
    // The router announces the screen it booted on as well: that is no
    // switch, and a window opened before the announcement stays open.
    if (open && event.detail?.initial !== true) setOpen(false, { returnFocus: false });
    placeCenter(root);
  });
  try { window.matchMedia(NARROW).addEventListener('change', () => placeCenter(root)); } catch (error) {}

  const api = {
    refresh: load,
    check,
    open: () => setOpen(true),
    close: () => setOpen(false),
    getSnapshot: () => snapshot,
  };
  window.XKeen = window.XKeen || {};
  window.XKeen.notificationCenter = api;
  void load();
  return api;
}

if (typeof window !== 'undefined') initNotificationCenter();
