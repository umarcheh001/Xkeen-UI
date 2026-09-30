import { toastXkeen } from './xkeen_runtime.js';

const MAX_POLL_MS = 10 * 60 * 1000;

function text(node, value) {
  if (node) node.textContent = String(value == null ? '' : value);
}

function modalOpen(node, open) {
  if (!node) return;
  try {
    const api = window.XKeen?.ui?.modal;
    if (api && typeof api[open ? 'open' : 'close'] === 'function') {
      api[open ? 'open' : 'close'](node, { source: 'core_source' });
      return;
    }
  } catch (e) {}
  node.classList.toggle('hidden', !open);
  try { window.XKeen?.ui?.modal?.syncBodyScrollLock?.(); } catch (e) {}
}

function unavailableReason(reason) {
  return {
    asset_missing: 'Нет сборки для архитектуры этого роутера.',
    checksum_missing: 'Контрольная сумма релиза не опубликована.',
    unsupported_arch: 'Архитектура этого роутера не поддерживается.',
    github_unavailable: 'GitHub временно недоступен.',
    invalid_release: 'Стабильный проверенный релиз не найден.',
  }[reason] || 'Релиз недоступен для установки.';
}

function releaseText(profile) {
  const release = profile?.release || {};
  if (!release.installable) return unavailableReason(release.reason);
  return `${release.stable?.tag || '—'} · ${release.asset?.name || '—'}`;
}

function profileLabel(profiles, profileId) {
  return profiles.find((item) => item.profile_id === profileId)?.display_name || 'неизвестен';
}

function riskLabel(value) {
  return { official: 'Официальный', alternative: 'Альтернативный', experimental: 'Экспериментальный' }[value] || 'Проверенный';
}

function releaseDate(value) {
  if (!value) return '';
  try { return new Date(value).toLocaleDateString(); } catch (e) { return ''; }
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || 'Запрос не выполнен.');
  return data;
}

function renderProfiles(root, data, selectedProfileId) {
  const host = root.querySelector('[data-core-source-profiles]');
  if (!host) return;
  host.replaceChildren();
  for (const profile of data.profiles || []) {
    const release = profile.release || {};
    const row = document.createElement('label');
    row.className = 'xk-core-source-profile';
    row.classList.toggle('is-unavailable', !release.installable);
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = `${data.engine_id}-core-profile`;
    input.value = profile.profile_id;
    input.checked = profile.profile_id === selectedProfileId;
    input.disabled = !release.installable;
    const body = document.createElement('span');
    body.className = 'xk-core-source-profile-body';
    const title = document.createElement('strong');
    title.textContent = profile.display_name;
    const repo = document.createElement('a');
    repo.href = `https://github.com/${profile.repo}`;
    repo.target = '_blank';
    repo.rel = 'noopener';
    repo.textContent = profile.repo;
    repo.addEventListener('click', (event) => event.stopPropagation());
    const meta = document.createElement('small');
    const releaseMeta = [
      riskLabel(profile.risk_level),
      release.stable?.tag,
      releaseDate(release.stable?.published_at),
      release.asset?.name,
      release.checksum?.sha256 ? `SHA-256 ${release.checksum.sha256}` : '',
    ].filter(Boolean).join(' · ');
    meta.textContent = `${profile.description} ${release.installable ? releaseMeta : releaseText(profile)}`;
    body.append(title, repo, meta);
    row.append(input, body);
    host.append(row);
  }
}

export function initCoreSource(root) {
  if (!root || root.dataset.coreSourceWired === '1') return;
  root.dataset.coreSourceWired = '1';
  const engine = root.dataset.coreEngine;
  const endpoint = `/api/${engine}`;
  const sourceModal = document.querySelector(`[data-core-source-modal]#${engine}-core-source-modal`);
  const installModal = document.querySelector(`[data-core-install-modal]#${engine}-core-install-modal`);
  let data = null;
  let selected = 'official';
  let confirmation = null;
  let pollTimer = null;
  let pollStartedAt = 0;

  const refresh = async () => {
    const response = await request(`${endpoint}/core-profiles`);
    data = response.data;
    selected = data.state?.selected_profile_id || 'official';
    const selectedProfile = data.profiles?.find((profile) => profile.profile_id === selected);
    const updateButton = root.querySelector('[data-core-source-action="prepare"]');
    if (updateButton) updateButton.disabled = !selectedProfile?.release?.installable || data.state?.last_status === 'running';
    const installed = data.state?.installed_profile_id;
    const installedVersion = data.state?.detected_version || data.state?.installed_release_tag || 'версия не определена';
    text(root.querySelector('[data-core-source-installed]'), `Установлено: ${installed ? profileLabel(data.profiles, installed) : 'профиль не отмечен'} · ${installedVersion}`);
    text(root.querySelector('[data-core-source-selected]'), `Источник: ${profileLabel(data.profiles, selected)}`);
    const state = data.state || {};
    const status = state.last_status === 'running'
      ? `Установка: ${state.last_phase}`
      : state.last_status === 'rolled_back'
        ? `Откат: ${state.last_error || 'предыдущая версия восстановлена'}`
        : state.last_status === 'failed'
          ? `Ошибка установки: ${state.last_error || 'проверьте источник'}`
          : 'Проверенные стабильные релизы';
    text(root.querySelector('[data-core-source-status]'), status);
    text(sourceModal?.querySelector('[data-core-source-platform]'), `Архитектура: ${data.platform?.opkg_arch || data.platform?.machine || 'не определена'}`);
    renderProfiles(sourceModal, data, selected);
  };

  const setMessage = (scope, message) => text(scope?.querySelector('[data-core-source-message], [data-core-install-message]'), message || '');

  const poll = async (operationId) => {
    if (pollTimer) clearTimeout(pollTimer);
    if (Date.now() - pollStartedAt >= MAX_POLL_MS) {
      text(root.querySelector('[data-core-source-status]'), 'Установка всё ещё выполняется. Проверьте состояние ядра позднее.');
      toastXkeen('Не удалось дождаться завершения установки за 10 минут.', 'error');
      pollTimer = null;
      return;
    }
    try {
      const response = await request(`${endpoint}/core-install/status?operation_id=${encodeURIComponent(operationId)}`);
      const operation = response.operation || {};
      text(root.querySelector('[data-core-source-status]'), `Установка: ${operation.phase || operation.status}`);
      if (['succeeded', 'failed', 'rolled_back'].includes(operation.status)) {
        const message = operation.status === 'succeeded' ? 'Ядро успешно обновлено.' : (operation.error || 'Установка не завершена; предыдущая версия восстановлена.');
        toastXkeen(message, operation.status === 'succeeded' ? 'success' : 'error');
        pollStartedAt = 0;
        await refresh();
        return;
      }
      pollTimer = setTimeout(() => poll(operationId), 700);
    } catch (error) {
      text(root.querySelector('[data-core-source-status]'), 'Не удалось получить состояние установки; повторяем проверку.');
      toastXkeen(error.message || 'Не удалось получить статус установки.', 'error');
      pollTimer = setTimeout(() => poll(operationId), 700);
    }
  };

  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-core-source-action]');
    if (!button) return;
    const action = button.dataset.coreSourceAction;
    try {
      if (action === 'open') { await refresh(); modalOpen(sourceModal, true); return; }
      if (action === 'prepare') {
        const response = await request(`${endpoint}/core-install/prepare`, { method: 'POST', body: '{}' });
        confirmation = response.confirmation;
        const details = installModal?.querySelector('[data-core-install-details]');
        if (details) {
          details.replaceChildren();
          for (const [label, value] of [['Профиль', confirmation.profile?.display_name], ['Версия', confirmation.release?.stable?.tag], ['Файл', confirmation.release?.asset?.name], ['SHA-256', confirmation.release?.checksum?.sha256]]) {
            const dt = document.createElement('dt'); dt.textContent = label;
            const dd = document.createElement('dd'); dd.textContent = value || '—';
            details.append(dt, dd);
          }
        }
        setMessage(installModal, '');
        modalOpen(installModal, true);
      }
    } catch (error) { toastXkeen(error.message || 'Операция недоступна.', 'error'); }
  });

  sourceModal?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-core-source-action]');
    if (!button) return;
    const action = button.dataset.coreSourceAction;
    if (action === 'close') { modalOpen(sourceModal, false); return; }
    if (action === 'restore') selected = 'official';
    if (action === 'save' || action === 'restore') {
      const checked = sourceModal.querySelector('input[type="radio"]:checked');
      const profileId = action === 'restore' ? 'official' : (checked?.value || selected);
      try {
        await request(`${endpoint}/core-source`, { method: 'POST', body: JSON.stringify({ profile_id: profileId }) });
        await refresh();
        setMessage(sourceModal, 'Источник сохранён. Установка выполняется отдельным действием.');
      } catch (error) { setMessage(sourceModal, error.message || 'Не удалось сохранить источник.'); }
    }
  });

  installModal?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-core-source-action]');
    if (!button) return;
    if (button.dataset.coreSourceAction === 'close-confirm') { modalOpen(installModal, false); return; }
    if (button.dataset.coreSourceAction !== 'apply' || !confirmation) return;
    button.disabled = true;
    try {
      const response = await request(`${endpoint}/core-install/apply`, { method: 'POST', body: JSON.stringify({ confirmation_id: confirmation.confirmation_id }) });
      modalOpen(installModal, false);
      pollStartedAt = Date.now();
      poll(response.operation.operation_id);
    } catch (error) { setMessage(installModal, error.message || 'Не удалось начать установку.'); }
    finally { button.disabled = false; }
  });

  refresh().catch((error) => text(root.querySelector('[data-core-source-status]'), error.message || 'Источник недоступен'));
}

export function initCoreSources(scope = document, engineId = '') {
  scope.querySelectorAll?.('[data-core-source]').forEach((root) => {
    if (!engineId || root.dataset.coreEngine === engineId) initCoreSource(root);
  });
}
