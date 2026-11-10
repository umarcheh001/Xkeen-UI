import { toastXkeen } from './xkeen_runtime.js';

const MAX_POLL_MS = 10 * 60 * 1000;
const INSTALL_STEPS = [
  ['download', 'Загрузка релиза'],
  ['verify', 'Проверка SHA-256'],
  ['backup', 'Резервная копия'],
  ['replace', 'Замена бинарного файла'],
  ['preflight', 'Проверка конфигурации'],
  ['restart', 'Перезапуск сервиса'],
  ['healthcheck', 'Проверка работоспособности'],
];

function text(node, value) {
  if (node) node.textContent = String(value == null ? '' : value);
}

function buttonLabelNode(button) {
  return button?.querySelector('[data-core-source-button-label]') || button;
}

async function withButtonFeedback(button, task, {
  busyLabel = 'Сохранение…',
  successLabel = 'Сохранено ✓',
} = {}) {
  if (!button) return task();
  const labelNode = buttonLabelNode(button);
  const originalLabel = labelNode?.textContent || '';
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.classList.add('is-working');
  if (labelNode) labelNode.textContent = busyLabel;
  try {
    const result = await task();
    button.classList.remove('is-working');
    button.classList.add('is-success');
    if (labelNode) labelNode.textContent = successLabel;
    window.setTimeout(() => {
      button.classList.remove('is-success');
      button.removeAttribute('aria-busy');
      button.disabled = false;
      if (labelNode) labelNode.textContent = originalLabel;
    }, 1300);
    return result;
  } catch (error) {
    button.classList.remove('is-working');
    button.removeAttribute('aria-busy');
    button.disabled = false;
    if (labelNode) labelNode.textContent = originalLabel;
    throw error;
  }
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
  try { return new Date(value).toLocaleDateString('ru-RU'); } catch (e) { return ''; }
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

// The operator icon sprite, read from an icon the dialog already has.
function iconSprite(scope) {
  return String(scope?.querySelector('use')?.getAttribute('href') || '').split('#')[0];
}

function icon(sprite, name, className = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `xk-action-icon${className ? ` ${className}` : ''}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `${sprite}#xk-${name}`);
  svg.append(use);
  return svg;
}

function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value != null) node.textContent = String(value);
  return node;
}

function shortTag(tag) {
  return String(tag || '').trim().replace(/^v(?=\d)/i, '');
}

// The numeric part of a version or a release tag: "Xray 26.9.9 (…)",
// "v1.19.14" and "v26.9.9-uwu.1" all compare by their first x.y[.z].
function versionNumbers(value) {
  const match = String(value || '').match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] || 0)] : null;
}

function compareVersions(left, right) {
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

// The commit of a Mihomo Alpha build: "alpha-94b13ae" in its version output
// and in its file name.
function alphaBuild(value) {
  const match = String(value || '').match(/alpha-([0-9a-f]{6,})/i);
  return match ? match[1].toLowerCase() : '';
}

// The name a release goes by: its tag, or, for a rolling pre-release such as
// Mihomo "Prerelease-Alpha", the build its file carries.
function releaseLabel(release) {
  const tag = String(release?.stable?.tag || '').trim();
  if (/\d/.test(tag)) return tag;
  const build = alphaBuild(release?.asset?.name);
  return build ? `alpha-${build}` : tag;
}

// A release channel belongs to the source it is a channel of.
function sourceGroup(profiles, profileId) {
  const profile = (profiles || []).find((item) => item.profile_id === profileId);
  return profile?.channel_of || profileId;
}

// What the core card says about the selected source's release, and what its
// install button does about it.
function releaseState(data, selectedProfile, coreInstalled) {
  const state = data.state || {};
  const release = selectedProfile?.release || {};
  const tag = releaseLabel(release);
  const stale = (data.profiles || []).some((profile) => profile.release?.stale)
    ? 'GitHub временно недоступен, показан последний проверенный релиз'
    : '';
  if (!release.installable) {
    return {
      kind: 'warn', icon: 'alert', title: 'Установка недоступна',
      note: unavailableReason(release.reason).replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase()),
      button: { label: 'Проверить и установить', primary: true, icon: 'download', disabled: true },
    };
  }
  if (!coreInstalled) {
    return {
      kind: 'update', icon: 'download', title: 'Ядро не установлено', note: `доступен ${tag}`, stale,
      button: { label: `Установить ${shortTag(tag)}`, primary: true, icon: 'download' },
    };
  }
  const profiles = data.profiles || [];
  const group = sourceGroup(profiles, selectedProfile.profile_id);
  // A channel of the installed source is not another source: its release is
  // compared with the running core like any other.
  if (group !== sourceGroup(profiles, state.installed_profile_id || 'official')) {
    const name = profiles.find((item) => item.profile_id === group)?.display_name || selectedProfile.display_name;
    return {
      kind: 'update', icon: 'download', title: 'Выбран другой источник', note: `${selectedProfile.display_name} ${tag}`, stale,
      button: { label: `Установить ${name}`, primary: true, icon: 'download' },
    };
  }
  const offeredBuild = alphaBuild(release.asset?.name);
  if (offeredBuild) {
    const runningBuild = alphaBuild(state.detected_version) || alphaBuild(state.installed_asset_name);
    if (!runningBuild) {
      return {
        kind: 'update', icon: 'download', title: 'Выбраны предварительные сборки', note: tag, stale,
        button: { label: `Установить ${tag}`, primary: true, icon: 'download' },
      };
    }
    if (runningBuild.startsWith(offeredBuild) || offeredBuild.startsWith(runningBuild)) {
      return {
        kind: 'ok', icon: 'check', title: 'Установлена последняя сборка', note: tag, stale,
        button: { label: 'Переустановить', primary: false, icon: 'reload' },
      };
    }
    return {
      kind: 'update', icon: 'download', title: 'Доступна новая сборка', note: `alpha-${runningBuild} → ${tag}`, stale,
      button: { label: `Обновить до ${tag}`, primary: true, icon: 'download' },
    };
  }
  const installedVersion = versionNumbers(state.detected_version) || versionNumbers(state.installed_release_tag);
  const latestVersion = versionNumbers(tag);
  if (!installedVersion || !latestVersion) {
    return {
      kind: 'info', icon: 'info', title: 'Доступен релиз', note: tag, stale,
      button: { label: `Установить ${shortTag(tag)}`, primary: true, icon: 'download' },
    };
  }
  const order = compareVersions(installedVersion, latestVersion);
  const recordedVersion = versionNumbers(state.installed_release_tag);
  // The recorded tag may lag behind a binary updated outside the panel.
  // Compare tags only when they describe the running version; forks can
  // publish distinct builds of the same upstream version.
  const newerBuild = order === 0 && recordedVersion
    && compareVersions(recordedVersion, installedVersion) === 0
    && shortTag(state.installed_release_tag) !== shortTag(tag);
  const pre = release.stable?.prerelease ? ' · предварительный' : '';
  if (order < 0 || newerBuild) {
    const from = newerBuild ? shortTag(state.installed_release_tag)
      : state.detected_version ? installedVersion.join('.') : shortTag(state.installed_release_tag);
    return {
      kind: 'update', icon: 'download', title: 'Доступно обновление', note: `${from} → ${shortTag(tag)}${pre}`, stale,
      button: { label: `Обновить до ${shortTag(tag)}`, primary: true, icon: 'download' },
    };
  }
  // The router runs a build newer than the source offers (put there by
  // XKeen or by hand): installing the offer would be a downgrade.
  if (order > 0) {
    return {
      kind: 'info', icon: 'info', title: 'Установлена версия новее источника', note: `в источнике ${tag}${pre}`, stale,
      button: { label: `Установить ${shortTag(tag)}`, primary: false, icon: 'download' },
    };
  }
  return {
    kind: 'ok', icon: 'check', title: 'Установлена последняя версия', note: `${tag}${pre}`, stale,
    button: { label: 'Переустановить', primary: false, icon: 'reload' },
  };
}

function renderReleaseState(node, sprite, view) {
  if (!node) return;
  const badge = element('span', `xk-core-release is-${view.kind}`);
  badge.append(icon(sprite, view.icon), element('span', 'xk-core-release-title', view.title));
  if (view.note) badge.append(element('span', 'xk-core-release-note', view.note));
  node.replaceChildren(badge);
  if (view.stale) node.append(element('small', 'xk-core-release-stale', view.stale));
}

// The channel switch of a source with release channels: stable first.
function channelSwitch(group, shown) {
  const host = element('span', 'xk-core-source-channels');
  host.setAttribute('role', 'group');
  host.setAttribute('aria-label', 'Канал выпусков');
  group.forEach((item, index) => {
    const button = element('button', 'xk-core-source-channel');
    button.type = 'button';
    button.dataset.coreSourceChannel = item.profile_id;
    button.setAttribute('aria-pressed', String(item.profile_id === shown.profile_id));
    button.disabled = !item.release?.installable;
    button.append(
      element('span', '', index === 0 ? 'Стабильные' : 'Предварительные'),
      element('small', '', item.release?.installable ? releaseLabel(item.release) : 'нет сборки'),
    );
    host.append(button);
  });
  return host;
}

function profileCard(data, profile, { selectedProfileId, installedProfileId, sprite, group = null }) {
  const release = profile.release || {};
  const source = group ? group[0] : profile;
  const members = group || [profile];
  const selected = profile.profile_id === selectedProfileId;
  const available = members.some((item) => item.release?.installable);
  const card = element('label', 'xk-core-source-profile');
  card.classList.toggle('is-selected', selected);
  card.classList.toggle('is-unavailable', !available);
  const input = document.createElement('input');
  input.type = 'radio';
  input.name = `${data.engine_id}-core-profile`;
  input.value = profile.profile_id;
  input.checked = selected;
  input.disabled = !available;
  input.setAttribute('aria-label', source.display_name);

  const body = element('span', 'xk-core-source-profile-body');
  const head = element('span', 'xk-core-source-profile-head');
  head.append(
    element('strong', '', source.display_name),
    element('span', `xk-core-source-risk is-${source.risk_level || 'experimental'}`, riskLabel(source.risk_level)),
  );
  body.append(head);
  if (group) body.append(channelSwitch(group, profile));

  const repo = element('a', 'xk-core-source-repo');
  repo.href = `https://github.com/${profile.repo}`;
  repo.target = '_blank';
  repo.rel = 'noopener';
  repo.append(icon(sprite, 'github'), element('span', '', profile.repo));
  repo.addEventListener('click', (event) => event.stopPropagation());
  const meta = element('span', 'xk-core-source-profile-meta');
  if (release.installable) {
    meta.append(element('span', '', [releaseLabel(release), releaseDate(release.stable?.published_at)].filter(Boolean).join(' · ')));
    if (release.stable?.prerelease) meta.append(element('span', 'xk-core-source-prerelease', 'предварительный'));
    meta.append(repo);
  } else {
    meta.append(element('span', 'xk-core-source-profile-off', releaseText(profile)), repo);
  }
  body.append(meta, element('span', 'xk-core-source-profile-desc', source.description));
  if (release.stale) body.append(element('span', 'xk-core-source-profile-off', 'GitHub временно недоступен, показан последний проверенный релиз'));

  // Only the chosen build shows its file and checksum: they matter for the
  // one about to be installed, and repeated on every card they are noise.
  if (selected && release.installable) {
    const details = element('details', 'xk-core-source-profile-details');
    details.append(element('summary', '', 'Файл и контрольная сумма'));
    const list = document.createElement('dl');
    list.append(
      element('dt', '', 'Файл'), element('dd', '', release.asset?.name || '—'),
      element('dt', '', 'SHA-256'), element('dd', '', release.checksum?.sha256 || '—'),
    );
    details.append(list);
    details.addEventListener('click', (event) => event.stopPropagation());
    body.append(details);
  }

  const side = element('span', 'xk-core-source-profile-side');
  if (members.some((item) => item.profile_id === installedProfileId)) {
    const mark = element('span', 'xk-core-source-installed');
    mark.append(icon(sprite, 'check'), element('span', '', 'Установлен'));
    side.append(mark);
  }
  card.append(input, icon(sprite, `engine-${data.engine_id}`, 'xk-core-source-profile-icon'), body, side);
  return card;
}

function renderProfiles(root, data, selectedProfileId, coreInstalled) {
  const host = root.querySelector('[data-core-source-profiles]');
  if (!host) return;
  const sprite = iconSprite(root);
  const profiles = data.profiles || [];
  const options = { selectedProfileId, installedProfileId: data.state?.installed_profile_id, sprite };
  // One card per source; a release channel joins the card of its source and
  // the card shows the chosen channel, or the stable one.
  host.replaceChildren(...profiles.filter((profile) => !profile.channel_of).map((profile) => {
    const channels = profiles.filter((item) => item.channel_of === profile.profile_id);
    if (!channels.length) return profileCard(data, profile, options);
    const group = [profile, ...channels];
    const shown = group.find((item) => item.profile_id === selectedProfileId) || profile;
    return profileCard(data, shown, { ...options, group });
  }));
  // The primary button names what it installs.
  const chosen = profiles.find((profile) => profile.profile_id === selectedProfileId);
  const install = root.querySelector('[data-core-source-action="choose-install"]');
  const label = root.querySelector('[data-core-source-install-label]');
  if (install && !install.classList.contains('is-working') && !install.classList.contains('is-success')) {
    const release = chosen && releaseState(data, chosen, coreInstalled);
    install.disabled = !chosen?.release?.installable || Boolean(release?.button.disabled);
    text(label, release?.button.label || 'Установить');
  }
}

// The core window has one main action. While its footer offers to switch
// or to start an engine, the update of the card is an ordinary button.
const MAIN_ACTION_EVENT = 'xkeen:core-modal-main-action';

function applyUpdateEmphasis(button) {
  const footerAction = document.getElementById('core-modal')?.dataset.mainAction === '1';
  const primary = button.dataset.releasePrimary === '1' && !footerAction;
  button.classList.toggle('btn-primary', primary);
  button.classList.toggle('btn-secondary', !primary);
}

export function initCoreSource(root) {
  if (!root || root.dataset.coreSourceWired === '1') return;
  root.dataset.coreSourceWired = '1';
  const engine = root.dataset.coreEngine;
  const endpoint = `/api/${engine}`;
  document.addEventListener(MAIN_ACTION_EVENT, () => {
    const button = root.querySelector('[data-core-source-action="prepare"]');
    if (button?.dataset.releasePrimary) applyUpdateEmphasis(button);
  });
  const sourceModal = document.querySelector(`[data-core-source-modal]#${engine}-core-source-modal`);
  const installModal = document.querySelector(`[data-core-install-modal]#${engine}-core-install-modal`);
  let data = null;
  let selected = 'official';
  let confirmation = null;
  let pollTimer = null;
  let pollStartedAt = 0;
  let activeOperationId = null;
  let terminalOperationId = null;
  let operationStatus = 'idle';
  let refreshGeneration = 0;
  let restartPending = false;
  let downloadSample = null;
  const coreIsInstalled = () => root.dataset.coreInstalled !== 'false' || Boolean(data?.state?.detected_version);

  const progressPanel = installModal?.querySelector('[data-core-install-progress]');
  const progressBar = installModal?.querySelector('[data-core-install-progress-bar]');
  const progressPercent = installModal?.querySelector('[data-core-install-percent]');
  const progressPhase = installModal?.querySelector('[data-core-install-phase]');
  const progressNote = installModal?.querySelector('[data-core-install-progress-note]');
  const progressSteps = installModal?.querySelector('[data-core-install-steps]');
  const installDetails = installModal?.querySelector('[data-core-install-details]');
  const applyButton = installModal?.querySelector('[data-core-source-action="apply"]');

  const operationSteps = (firstInstall) => firstInstall
    ? [['download', 'Загрузка релиза'], ['verify', 'Проверка SHA-256'], ['backup', 'Сохранение состояния'], ['preflight', 'Проверка ядра'], ['replace', 'Установка файла']]
    : INSTALL_STEPS;

  const renderOperation = (operation) => {
    if (!operation || !progressPanel) return;
    const status = String(operation.status || 'running');
    const phase = String(operation.phase || 'download');
    const firstInstall = Boolean(operation.first_install || confirmation?.first_install);
    const inactiveInstall = Boolean(operation.inactive_install || confirmation?.inactive_install);
    const steps = operationSteps(firstInstall || inactiveInstall);
    const label = String(((firstInstall || inactiveInstall) && steps.find(([id]) => id === phase)?.[1]) || operation.phase_label || steps.find(([id]) => id === phase)?.[1] || 'Установка ядра');
    const progress = Number.isFinite(Number(operation.progress)) ? Math.max(0, Math.min(100, Number(operation.progress))) : 0;
    const currentIndex = steps.findIndex(([id]) => id === phase);
    let downloadNote = '';
    const done = Number(operation.downloaded_bytes);
    const total = Number(operation.total_bytes);
    if (status === 'running' && phase === 'download' && operation.downloaded_bytes != null && Number.isFinite(done) && done >= 0) {
      const now = Date.now();
      const id = String(operation.operation_id || activeOperationId || '');
      const previous = downloadSample?.id === id ? downloadSample : null;
      const speed = previous && now > previous.at && done > previous.bytes ? (done - previous.bytes) * 1000 / (now - previous.at) : 0;
      downloadSample = { id, at: now, bytes: done };
      const mb = value => (value / 1048576).toFixed(1).replace('.', ',');
      const parts = [Number.isFinite(total) && total > 0 ? `${mb(done)} из ${mb(total)} МБ` : `${mb(done)} МБ`];
      if (speed > 0) {
        parts.push(`${(speed * 8 / 1000000).toFixed(1).replace('.', ',')} Мбит/с`);
        if (Number.isFinite(total) && total > done) parts.push(`осталось около ${Math.max(1, Math.round((total - done) / speed))} с`);
      }
      downloadNote = parts.join(' · ');
    } else {
      downloadSample = null;
    }
    operationStatus = status;
    progressPanel.hidden = false;
    progressPanel.setAttribute('aria-busy', status === 'running' ? 'true' : 'false');
    if (progressBar) progressBar.value = progress;
    text(progressPercent, `${Math.round(progress)}%`);
    text(progressPhase, label);
    text(progressNote, status === 'running' ? (downloadNote || 'Окно можно закрыть, операция продолжится на роутере.') : (status === 'succeeded' ? (firstInstall || inactiveInstall ? 'Ядро установлено; текущая служба не перезапускалась.' : 'Новая версия прошла проверку и запущена.') : (firstInstall ? 'Установка не завершена.' : 'Предыдущая версия сохранена или восстановлена.')));
    if (progressSteps) {
      progressSteps.style.setProperty('--xk-core-step-count', String(steps.length));
      progressSteps.replaceChildren();
      steps.forEach(([id, stepLabel], index) => {
        const item = document.createElement('li');
        item.dataset.state = status === 'succeeded' || (currentIndex >= 0 && index < currentIndex) ? 'done' : (id === phase ? 'active' : 'pending');
        item.textContent = stepLabel;
        progressSteps.appendChild(item);
      });
    }
    text(root.querySelector('[data-core-source-status]'), status === 'running' ? `Установка: ${Math.round(progress)}% · ${label}` : label);
  };

  const showConfirmation = () => {
    operationStatus = 'idle';
    downloadSample = null;
    if (progressPanel) {
      progressPanel.hidden = true;
      progressPanel.setAttribute('aria-busy', 'false');
    }
    installModal?.querySelector('[data-core-source-action="restart-panel"]')?.setAttribute('hidden', '');
    if (installDetails) installDetails.hidden = false;
    if (applyButton) {
      applyButton.disabled = false;
      applyButton.removeAttribute('aria-busy');
      applyButton.classList.remove('is-working');
      applyButton.dataset.tooltip = 'Начать загрузку, проверку и установку ядра';
      text(buttonLabelNode(applyButton), 'Установить');
    }
  };

  const fillConfirmation = (nextConfirmation) => {
    confirmation = nextConfirmation;
    if (!confirmation) return;
    text(installModal?.querySelector('[data-core-install-description]'), confirmation.first_install || confirmation.inactive_install
      ? 'Ядро будет установлено без переключения и перезапуска текущей службы.'
      : 'Текущий бинарник и состояние профиля будут сохранены. При ошибке проверки или запуска панель вернёт предыдущую версию.');
    if (installDetails) {
      installDetails.replaceChildren();
      for (const [label, value] of [
        ['Профиль', confirmation.profile?.display_name],
        ['Версия', confirmation.release?.stable?.tag],
        ['Файл', confirmation.release?.asset?.name],
        ['SHA-256', confirmation.release?.checksum?.sha256],
      ]) {
        const dt = document.createElement('dt'); dt.textContent = label;
        const dd = document.createElement('dd'); dd.textContent = value || '—';
        installDetails.append(dt, dd);
      }
    }
  };

  const prepareInstallation = async ({ closeSource = false } = {}) => {
    const response = await request(`${endpoint}/core-install/prepare`, {
      method: 'POST',
      body: '{}',
    });
    fillConfirmation(response.confirmation);
    setMessage(installModal, '');
    showConfirmation();
    if (closeSource) modalOpen(sourceModal, false);
    modalOpen(installModal, true);
  };

  const startPolling = (operationId) => {
    if (!operationId) return;
    if (root.dataset.firstInstall === 'true' || confirmation?.first_install) {
      document.dispatchEvent(new CustomEvent('xkeen:first-core-install-start', { detail: { engine } }));
    }
    activeOperationId = String(operationId);
    if (!pollStartedAt) pollStartedAt = Date.now();
    poll(activeOperationId);
  };

  const refresh = async () => {
    const generation = ++refreshGeneration;
    const prepareButton = root.querySelector('[data-core-source-action="prepare"]');
    if (prepareButton) prepareButton.disabled = true;
    let response;
    try {
      response = await request(`${endpoint}/core-profiles`);
    } catch (error) {
      if (generation !== refreshGeneration) return;
      throw error;
    }
    if (generation !== refreshGeneration) return;
    data = response.data;
    if (root.dataset.coreInstalled === 'false' && data.state?.detected_version) {
      document.dispatchEvent(new CustomEvent('xkeen:core-detection-changed', {
        detail: { engine: root.dataset.coreEngine, version: data.state.detected_version },
      }));
    }
    selected = data.state?.selected_profile_id || 'official';
    const selectedProfile = data.profiles?.find((profile) => profile.profile_id === selected);
    const coreInstalled = coreIsInstalled();
    const missing = !coreInstalled;
    const restartNeeded = root.dataset.firstInstall === 'true' && !missing;
    root.querySelector('[data-core-restart-needed]')?.toggleAttribute('hidden', !restartNeeded);
    const sourceButton = root.querySelector('[data-core-source-action="open"]');
    if (sourceButton) sourceButton.disabled = restartNeeded;
    root.querySelector('[data-core-source-summary]')?.toggleAttribute('hidden', missing);
    for (const selector of ['[data-core-first-install-note]', '[data-core-first-install-source]', '[data-core-first-install-hint]']) {
      root.querySelector(selector)?.toggleAttribute('hidden', !missing);
    }
    text(root.querySelector('[data-core-first-source]'), profileLabel(data.profiles, selected));
    const release = releaseState(data, selectedProfile, !missing);
    const firstStatus = root.querySelector('[data-core-first-status]');
    const retry = root.querySelector('[data-core-source-action="retry"]');
    if (firstStatus) {
      firstStatus.hidden = !missing || !release.button.disabled;
      text(firstStatus, release.button.disabled ? [release.title || 'Источник недоступен', release.note].filter(Boolean).join(': ') : '');
    }
    if (retry) retry.hidden = !missing || !release.button.disabled;
    const updateButton = root.querySelector('[data-core-source-action="prepare"]');
    if (updateButton) {
      updateButton.disabled = restartNeeded || Boolean(release.button.disabled) || data.state?.last_status === 'running';
      updateButton.dataset.releasePrimary = release.button.primary ? '1' : '0';
      applyUpdateEmphasis(updateButton);
      const use = updateButton.querySelector('use');
      if (use) use.setAttribute('href', `${iconSprite(root)}#xk-${release.button.icon}`);
    }
    text(root.querySelector('[data-core-source-prepare-label]'), release.button.label);
    const installed = data.state?.installed_profile_id;
    // The core dialog marks a card whose engine is absent from the router.
    const installedVersion = data.state?.detected_version || data.state?.installed_release_tag || root.dataset.coreVersion
      || (root.dataset.coreInstalled === 'false' ? 'не установлено' : 'не определена');
    text(root.querySelector('[data-core-source-version]'), installedVersion);
    // Without a recorded profile the core came from outside the panel (the
    // XKeen installer or by hand), so its source is not known.
    text(root.querySelector('[data-core-source-installed]'), installed ? profileLabel(data.profiles, installed) : 'неизвестно — ядро ставили не через панель');
    text(root.querySelector('[data-core-source-selected]'), profileLabel(data.profiles, selected));
    const state = data.state || {};
    const statusNode = root.querySelector('[data-core-source-status]');
    // An operation in progress or its outcome outranks the release state.
    const operation = state.last_status === 'running'
      ? `Установка: ${Number.isFinite(Number(state.last_progress)) ? `${Math.round(Number(state.last_progress))}% · ` : ''}${state.last_phase_label || state.last_phase}`
      : state.last_status === 'rolled_back'
        ? `Откат: ${state.last_error || 'предыдущая версия восстановлена'}`
        : state.last_status === 'failed'
          ? `Ошибка установки: ${state.last_error || 'проверьте источник'}`
          : '';
    if (operation) text(statusNode, operation);
    else renderReleaseState(statusNode, iconSprite(root), release);
    if (state.last_status === 'running' && state.last_operation_id && activeOperationId !== state.last_operation_id) startPolling(state.last_operation_id);
    text(sourceModal?.querySelector('[data-core-source-platform]'), data.platform?.opkg_arch || data.platform?.machine || 'архитектура не определена');
    renderProfiles(sourceModal, data, selected, coreInstalled);
  };

  const showRefreshError = (error) => {
    const message = error.message || 'Источник недоступен';
    const updateButton = root.querySelector('[data-core-source-action="prepare"]');
    if (updateButton) updateButton.disabled = true;
    text(root.querySelector('[data-core-source-status]'), message);
    const firstStatus = root.querySelector('[data-core-first-status]');
    if (root.dataset.coreInstalled === 'false' && firstStatus) {
      firstStatus.hidden = false;
      text(firstStatus, message);
      root.querySelector('[data-core-source-action="retry"]')?.removeAttribute('hidden');
    }
  };
  root.addEventListener('xkeen:core-installation-state', () => {
    refresh().catch(showRefreshError);
  });

  const setMessage = (scope, message) => text(scope?.querySelector('[data-core-source-message], [data-core-install-message]'), message || '');

  const restartPanel = async (button, messageNode) => {
    if (restartPending) return;
    restartPending = true;
    const originalLabel = button.textContent;
    const restartButtons = [root, installModal].flatMap(scope => Array.from(scope?.querySelectorAll('[data-core-source-action="restart-panel"]') || []));
    const disabledStates = restartButtons.map(item => item.disabled);
    restartButtons.forEach(item => { item.disabled = true; });
    button.setAttribute('aria-busy', 'true');
    button.classList.add('xk-core-restart-working');
    text(button, 'Перезапускаем…');
    text(messageNode, 'Перезапускаем панель. Пожалуйста, подождите.');
    const elapsed = document.createElement('span');
    elapsed.className = 'xk-core-restart-elapsed';
    elapsed.dataset.coreRestartElapsed = '';
    elapsed.setAttribute('aria-hidden', 'true');
    button.after(elapsed);
    const startedAt = Date.now();
    const updateElapsed = () => text(elapsed, `Прошло ${Math.floor((Date.now() - startedAt) / 1000)} с`);
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1000);
    try {
      const before = await request('/api/modules/instance', { cache: 'no-store' });
      if (!before.instance) throw new Error('Не удалось определить состояние панели.');
      const restartController = new AbortController();
      const restartTimeout = window.setTimeout(() => restartController.abort(), 10000);
      try {
        await request('/api/modules/restart', { method: 'POST', body: '{}', signal: restartController.signal });
      } catch (error) {
        // The old process may have stopped before its response reached us.
        if (!(error instanceof TypeError) && error.name !== 'AbortError') throw error;
      } finally {
        window.clearTimeout(restartTimeout);
      }
      text(messageNode, 'Панель перезапускается. Если страница не обновится, обновите её вручную.');
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        await new Promise(resolve => window.setTimeout(resolve, 1500));
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 5000);
        try {
          const current = await request('/api/modules/instance', { cache: 'no-store', signal: controller.signal });
          if (current.instance && current.instance !== before.instance) {
            window.location.reload();
            return;
          }
        } catch (_) {
          // The panel may be unavailable while its process is restarting.
        } finally {
          window.clearTimeout(timeout);
        }
      }
      throw new Error('Не удалось дождаться перезапуска панели. Проверьте её состояние и обновите страницу вручную.');
    } catch (error) {
      window.clearInterval(timer);
      elapsed.remove();
      restartButtons.forEach((item, index) => { item.disabled = disabledStates[index]; });
      button.removeAttribute('aria-busy');
      button.classList.remove('xk-core-restart-working');
      text(button, originalLabel);
      text(messageNode, error.message || 'Не удалось перезапустить панель.');
      restartPending = false;
    }
  };

  root.addEventListener('xkeen:auto-restart-after-core-install', () => {
    const button = installModal?.querySelector('[data-core-source-action="restart-panel"]');
    if (button) void restartPanel(button, installModal.querySelector('[data-core-install-message]'));
  });

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
      renderOperation(operation);
      if (['succeeded', 'failed', 'rolled_back'].includes(operation.status)) {
        activeOperationId = null;
        const firstInstall = Boolean(operation.first_install || confirmation?.first_install);
        const message = operation.status === 'succeeded' ? (firstInstall ? 'Ядро установлено. Для подключения модуля перезапустите панель.' : 'Ядро успешно обновлено.') : (operation.error || 'Установка не завершена.');
        if (terminalOperationId !== operation.operation_id) {
          toastXkeen(message, operation.status === 'succeeded' ? 'success' : 'error');
          terminalOperationId = operation.operation_id;
        }
        text(installModal?.querySelector('[data-core-install-message]'), message);
        if (operation.status === 'succeeded' && firstInstall) {
          installModal?.querySelector('[data-core-source-action="restart-panel"]')?.removeAttribute('hidden');
        }
        if (applyButton) {
          applyButton.disabled = false;
          applyButton.removeAttribute('aria-busy');
          applyButton.classList.remove('is-working');
          applyButton.dataset.tooltip = 'Закрыть окно установки';
          text(buttonLabelNode(applyButton), 'Закрыть');
        }
        pollStartedAt = 0;
        await refresh();
        if (firstInstall) document.dispatchEvent(new CustomEvent('xkeen:first-core-install-finish', { detail: { engine, succeeded: operation.status === 'succeeded' } }));
        return;
      }
      pollTimer = setTimeout(() => poll(operationId), 700);
    } catch (error) {
      text(root.querySelector('[data-core-source-status]'), 'Не удалось получить состояние установки; повторяем проверку.');
      pollTimer = setTimeout(() => poll(operationId), 700);
    }
  };

  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-core-source-action]');
    if (!button) return;
    const action = button.dataset.coreSourceAction;
    try {
      if (action === 'restart-panel') {
        await restartPanel(button, root.querySelector('[data-core-restart-needed] p'));
        return;
      }
      if (action === 'retry') { await refresh(); return; }
      if (action === 'open') { modalOpen(sourceModal, true); await refresh(); return; }
      if (action === 'prepare') {
        await prepareInstallation();
      }
    } catch (error) { if (action === 'retry') showRefreshError(error); else toastXkeen(error.message || 'Операция недоступна.', 'error'); }
  });

  sourceModal?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-core-source-action]');
    if (!button) return;
    const action = button.dataset.coreSourceAction;
    if (action === 'close') { modalOpen(sourceModal, false); return; }
    if (action === 'save' || action === 'choose-install') {
      const checked = sourceModal.querySelector('input[type="radio"]:checked');
      const profileId = checked?.value || selected;
      try {
        const feedbackButton = button;
        await withButtonFeedback(
          feedbackButton,
          async () => {
            await request(`${endpoint}/core-source`, { method: 'POST', body: JSON.stringify({ profile_id: profileId }) });
            await refresh();
            if (action === 'choose-install') {
              text(root.querySelector('[data-core-source-status]'), 'Источник выбран · релиз готовится');
              await prepareInstallation({ closeSource: true });
            } else {
              setMessage(sourceModal, 'Источник запомнен. Он будет использован при следующей установке из окна ядра.');
            }
          },
          action === 'choose-install'
            ? { busyLabel: 'Подготовка…', successLabel: 'Готово ✓' }
            : { busyLabel: 'Сохранение…', successLabel: 'Запомнено ✓' },
        );
      } catch (error) { setMessage(sourceModal, error.message || 'Не удалось сохранить источник.'); }
    }
  });

  // A channel button picks that channel of the source, and its card.
  sourceModal?.addEventListener('click', (event) => {
    const channel = event.target.closest?.('[data-core-source-channel]');
    if (!channel || !data) return;
    event.preventDefault();
    if (channel.disabled) return;
    setMessage(sourceModal, '');
    renderProfiles(sourceModal, data, channel.dataset.coreSourceChannel, coreIsInstalled());
    sourceModal.querySelector(`[data-core-source-channel="${CSS.escape(channel.dataset.coreSourceChannel)}"]`)?.focus();
  });

  // Picking a card only moves the choice: nothing is saved until a button says so.
  sourceModal?.addEventListener('change', (event) => {
    const input = event.target.closest?.('input[type="radio"]');
    if (!input || !data) return;
    setMessage(sourceModal, '');
    renderProfiles(sourceModal, data, input.value, coreIsInstalled());
    sourceModal.querySelector(`input[type="radio"][value="${CSS.escape(input.value)}"]`)?.focus();
  });

  installModal?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-core-source-action]');
    if (!button) return;
    if (button.dataset.coreSourceAction === 'close-confirm') { modalOpen(installModal, false); return; }
    if (button.dataset.coreSourceAction === 'restart-panel') {
      await restartPanel(button, installModal.querySelector('[data-core-install-message]'));
      return;
    }
    if (button.dataset.coreSourceAction !== 'apply' || !confirmation) return;
    if (['succeeded', 'failed', 'rolled_back'].includes(operationStatus)) { modalOpen(installModal, false); return; }
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.classList.add('is-working');
    text(buttonLabelNode(button), 'Установка…');
    if (confirmation.first_install) document.dispatchEvent(new CustomEvent('xkeen:first-core-install-start', { detail: { engine } }));
    try {
      const response = await request(`${endpoint}/core-install/apply`, { method: 'POST', body: JSON.stringify({ confirmation_id: confirmation.confirmation_id }) });
      pollStartedAt = Date.now();
      terminalOperationId = null;
      renderOperation(response.operation || { status: 'running', phase: 'download', progress: 8, phase_label: 'Загрузка релиза' });
      startPolling(response.operation?.operation_id);
    } catch (error) {
      if (confirmation.first_install) document.dispatchEvent(new CustomEvent('xkeen:first-core-install-finish', { detail: { engine, succeeded: false } }));
      setMessage(installModal, error.message || 'Не удалось начать установку.');
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.classList.remove('is-working');
      button.dataset.tooltip = 'Начать загрузку, проверку и установку ядра';
      text(buttonLabelNode(button), 'Установить');
    }
  });

  refresh().catch(showRefreshError);
}

export function initCoreSources(scope = document, engineId = '') {
  scope.querySelectorAll?.('[data-core-source]').forEach((root) => {
    if (!engineId || root.dataset.coreEngine === engineId) initCoreSource(root);
  });
}
