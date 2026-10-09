function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text ?? '');
  return element;
}

function moduleTitle(item) {
  return [item.name || item.id || 'Модуль', item.version].filter(Boolean).join(' ');
}

function dependencies(card, label, items) {
  if (!Array.isArray(items) || !items.length) return;
  card.append(node('p', 'modules-meta', `${label}: ${items.join(', ')}`));
}

const ACTION_LABELS = {
  install: 'Установить', repair: 'Восстановить', remove: 'Удалить',
  'panel-update': 'Обновить панель', 'panel-rollback': 'Откатить панель',
  'profile-transition': 'Применить профиль',
};

const FAILURE_MESSAGES = {
  catalog_unavailable: 'Каталог модулей временно недоступен.',
  catalog_stale: 'Каталог устарел. Загрузите его снова.',
  module_plan_stale: 'План устарел. Проверьте новый план.',
  operation_plan_stale: 'План устарел. Проверьте новый план.',
  operation_in_progress: 'Другая операция уже выполняется.',
  profile_transition_required: 'Сначала примените переход профиля.',
  operation_rollback_failed: 'Восстановление файлов не завершилось. Требуется ручная проверка установки и состояния панели.',
  module_free_space: 'Недостаточно свободного места.',
  operation_free_space: 'Недостаточно свободного места.',
  module_engine_active: 'Модуль используется активным движком.',
  module_dependency_missing: 'Не хватает зависимости.',
  panel_version_current: 'Обновлений нет.',
  module_conflict: 'Обнаружен конфликт модулей.',
  module_required_by: 'Модуль требуется другим модулям.',
  panel_archive_invalid: 'Архив панели не прошёл проверку.',
  panel_version_unsupported: 'Для локальной сборки подписанные операции доступны только после установки release-пакета.',
  profile_payload_unavailable: 'Архив для перехода профиля недоступен.',
};

export function describeLifecycleFailure({ code } = {}) {
  const safeCode = typeof code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(code) ? code : 'module_request_failed';
  let guidance = FAILURE_MESSAGES[safeCode];
  if (!guidance && safeCode.startsWith('catalog_')) guidance = safeCode.includes('stale') || safeCode.includes('expired') ? 'Каталог устарел. Загрузите его снова.' : 'Не удалось проверить каталог модулей.';
  if (!guidance && safeCode.includes('trust')) guidance = 'Не удалось подтвердить доверие к каталогу.';
  if (!guidance && safeCode.includes('archive')) guidance = 'Не удалось проверить архив модуля.';
  if (!guidance && safeCode.includes('rollback')) guidance = 'Восстановление файлов не завершилось. Требуется ручная проверка установки и состояния панели.';
  return `${guidance || 'Не удалось выполнить операцию с модулями.'} (${safeCode})`;
}

function actionButton(operation, moduleId, label, onPlan, disabled) {
  const button = node('button', 'btn-secondary', label);
  button.type = 'button';
  button.dataset.operation = operation;
  if (moduleId) button.dataset.moduleId = moduleId;
  button.disabled = disabled;
  button.addEventListener('click', () => onPlan(operation, moduleId, button));
  return button;
}

function formatBytes(bytes) {
  const amount = Number(bytes) || 0;
  if (amount >= 1024 * 1024) return `${Math.ceil(amount / (1024 * 1024))} МБ`;
  if (amount >= 1024) return `${Math.ceil(amount / 1024)} КБ`;
  return `${amount} Б`;
}

function textList(parent, label, values) {
  if (!Array.isArray(values) || !values.length) return;
  parent.append(node('p', 'modules-meta', `${label}: ${values.map(String).join(', ')}`));
}

function appendPanelIdentity(summary, snapshot) {
  const build = snapshot.build && typeof snapshot.build === 'object' ? snapshot.build : {};
  const releaseVersion = String(snapshot.panel_version || '').trim();
  const buildVersion = String(build.version || '').trim();
  summary.append(node(
    'p',
    'modules-build-version',
    releaseVersion ? `Xkeen UI ${releaseVersion}` : (buildVersion ? `Локальная сборка ${buildVersion}` : 'Сборка панели не определена'),
  ));
  if (build.repo || build.channel) {
    summary.append(node('p', 'modules-build-meta', `Источник: ${build.repo || 'не указан'} · канал: ${build.channel || 'не указан'}`));
  }
  if (build.commit) summary.append(node('p', 'modules-build-meta', `Коммит: ${build.commit}`));
  if (build.built_utc) summary.append(node('p', 'modules-build-meta', `Собрано: ${build.built_utc}`));
}

function appendUpdateCheck(summary, update, { onCheckUpdate, busy, lifecycleAvailable }) {
  const check = node('section', 'modules-update-check');
  const appendMessage = (className, text) => {
    const message = node('p', className, text);
    message.setAttribute('role', 'status');
    message.setAttribute('aria-live', 'polite');
    check.append(message);
  };
  check.append(node('h3', '', 'Обновление панели'));
  const button = node('button', 'btn-secondary modules-update-check-button', 'Проверить обновления');
  button.type = 'button';
  button.disabled = busy || lifecycleAvailable !== true;
  if (typeof onCheckUpdate === 'function') button.addEventListener('click', onCheckUpdate);
  check.append(button);
  if (lifecycleAvailable !== true) {
    appendMessage('modules-build-note', 'Для локальной сборки проверка и установка подписанного обновления станут доступны после установки release-пакета.');
  } else if (update?.loading) {
    appendMessage('modules-build-meta', 'Проверяем подписанный каталог…');
  } else if (update?.error) {
    appendMessage('modules-alert', describeLifecycleFailure(update.error));
  } else if (update?.checked) {
    if (update.requires_installer) appendMessage('modules-alert', `Версия ${update.target_version || 'из каталога'} требует обновления через установщик.`);
    else if (update.update_available) appendMessage('modules-update-available', `Доступна версия ${update.target_version}.`);
    else appendMessage('modules-build-meta', 'Установлена актуальная версия.');
  } else {
    appendMessage('modules-build-meta', 'Проверка не скачивает архив и не изменяет панель.');
  }
  summary.append(check);
}

export function renderPlan(dialog, plan) {
  const title = dialog.querySelector('#modules-plan-title');
  const summary = dialog.querySelector('#modules-plan-summary');
  const apply = dialog.querySelector('#modules-plan-apply');
  const names = {
    install: 'установки', repair: 'восстановления', remove: 'удаления',
    'panel-update': 'обновления панели', 'panel-rollback': 'отката панели',
    'profile-transition': 'перехода профиля',
  };
  title.textContent = `План ${names[plan.operation] || 'операции'}`;
  summary.replaceChildren();
  summary.append(node('p', '', `Область: ${plan.scope || (plan.module_id ? 'модуль' : 'панель')}`));
  summary.append(node('p', '', `Действие: ${ACTION_LABELS[plan.operation] || plan.operation || 'Операция'}`));
  textList(summary, 'Модули', plan.affected_module_ids);
  if (plan.source_version) summary.append(node('p', '', `Исходная версия: ${plan.source_version}`));
  if (plan.target_version || plan.version) summary.append(node('p', '', `Целевая версия: ${plan.target_version || plan.version}`));
  summary.append(node('p', '', `Файлы: добавить ${plan.files_add?.length || 0}, удалить ${plan.files_remove?.length || 0}`));
  summary.append(node('p', '', `Нужно места: ${formatBytes(plan.required_free_bytes)}`));
  const diff = plan.dependency_diff && typeof plan.dependency_diff === 'object' ? plan.dependency_diff : {};
  for (const [key, value] of Object.entries(diff)) textList(summary, `Зависимости ${key}`, value);
  if (plan.restart_required) summary.append(node('p', 'modules-alert', 'Требуется перезапуск'));
  for (const blocker of Array.isArray(plan.blockers) ? plan.blockers : []) {
    summary.append(node('p', 'modules-alert', describeLifecycleFailure(blocker)));
  }
  apply.hidden = plan.applicable !== true || !plan.plan_id;
  apply.disabled = false;
  dialog.querySelector('#modules-plan-cancel').disabled = false;
}

export function renderOperationStatus(host, status, { onCancel, onRecovery, busy = false } = {}) {
  host.replaceChildren();
  if (!status || status.result === 'idle') return;
  const area = node('section', 'modules-operation card');
  area.append(node('h2', '', status.result === 'idle' ? 'Перезапуск панели' : 'Операция с модулями'));
  for (const [label, value] of [
    ['Шаг', status.step], ['Результат', status.result],
    ['Начало', status.started_at], ['Завершение', status.finished_at],
  ]) {
    if (value !== undefined && value !== null && value !== '') area.append(node('p', '', `${label}: ${value}`));
  }
  if (status.result === 'rollback_failed') area.append(node('p', 'modules-alert', describeLifecycleFailure({ code: 'operation_rollback_failed' })));
  else if (status.error_code) area.append(node('p', 'modules-alert', describeLifecycleFailure({ code: status.error_code })));
  if (Array.isArray(status.log) && status.log.length) {
    const log = node('pre', 'modules-operation-log-region');
    const code = node('code', 'modules-operation-log');
    for (const record of status.log) {
      if (record && typeof record === 'object') {
        code.append(document.createTextNode(`${[record.step, record.at].filter((part) => part !== undefined && part !== null).join(' · ')}\n`));
      }
    }
    log.append(code);
    area.append(log);
  }
  if (status.result === 'running' && status.operation_id) {
    const cancel = node('button', 'btn-secondary', 'Отменить операцию');
    cancel.type = 'button';
    cancel.disabled = busy;
    cancel.addEventListener('click', onCancel);
    area.append(cancel);
  }
  if (status.result === 'interrupted') {
    const recover = node('button', 'btn-secondary', 'Восстановить операцию');
    recover.type = 'button';
    recover.disabled = busy;
    recover.addEventListener('click', onRecovery);
    area.append(recover);
  }
  host.append(area);
}

export function renderInstalled(host, snapshot, onToggle, onPlan = () => {}, busy = false, {
  onRestart = null,
  canRestart = false,
  onCheckUpdate = null,
  update = null,
} = {}) {
  host.replaceChildren();
  const summary = node('section', 'modules-summary card');
  summary.append(node('h2', '', 'Панель и профиль'));
  appendPanelIdentity(summary, snapshot);
  summary.append(node('p', '', `Профиль: ${snapshot.profile || 'не указан'}`));
  if (snapshot.restart_required || canRestart) summary.append(node('p', 'modules-alert', 'Требуется перезапуск'));
  const panelActions = node('div', 'modules-card-actions');
  if (snapshot.lifecycle?.available === false) {
    summary.append(node('p', 'modules-alert', describeLifecycleFailure(snapshot.lifecycle)));
  } else {
    panelActions.append(actionButton('panel-update', null, ACTION_LABELS['panel-update'], onPlan, busy));
    if (snapshot.previous_version?.available) panelActions.append(actionButton('panel-rollback', null, ACTION_LABELS['panel-rollback'], onPlan, busy));
    if (snapshot.transition_required) panelActions.append(actionButton('profile-transition', null, ACTION_LABELS['profile-transition'], onPlan, busy));
  }
  if (canRestart && typeof onRestart === 'function') {
    const restart = node('button', 'btn-primary modules-restart-panel', 'Перезапустить панель');
    restart.type = 'button';
    restart.disabled = busy;
    restart.addEventListener('click', onRestart);
    panelActions.append(restart);
  }
  if (panelActions.childElementCount) summary.append(panelActions);
  appendUpdateCheck(summary, update, {
    onCheckUpdate,
    busy,
    lifecycleAvailable: snapshot.lifecycle?.available,
  });
  host.append(summary);
  const list = node('section', 'modules-list card');
  list.append(node('h2', '', 'Установленные модули'));
  const modules = Array.isArray(snapshot.modules) ? snapshot.modules : [];
  if (!modules.length) list.append(node('p', 'modules-empty', 'Установленных модулей нет.'));
  modules.forEach((item) => {
    const row = node('article', 'modules-row');
    const body = node('div', 'modules-row-body');
    body.append(node('h3', '', moduleTitle(item)));
    if (item.description) body.append(node('p', '', item.description));
    row.append(body);
    const controls = node('div', 'modules-row-actions');
    if (item.can_disable) {
      const label = node('label', 'dt-switch xk-switch-bare modules-switch');
      const stateLabel = node(
        'span',
        `dt-switch-label modules-switch-state ${item.enabled === true ? 'is-enabled' : 'is-disabled'}`,
        item.enabled === true ? 'Включён' : 'Выключен',
      );
      const switchControl = node('span', 'modules-switch-control');
      const input = node('input');
      input.type = 'checkbox';
      input.setAttribute('role', 'switch');
      input.setAttribute('aria-label', `Включить ${item.name || item.id}`);
      input.checked = item.enabled === true;
      input.disabled = busy;
      input.addEventListener('change', () => onToggle(item.id, input.checked, input));
      switchControl.append(input, node('span', 'dt-switch-slider'));
      label.append(stateLabel, switchControl);
      controls.append(label);
    }
    const actions = Array.isArray(item.lifecycle_actions) ? item.lifecycle_actions : [];
    for (const action of actions) {
      if (ACTION_LABELS[action]) controls.append(actionButton(action, item.id, `${ACTION_LABELS[action]} ${item.name || item.id}`, onPlan, busy));
    }
    if (controls.childElementCount) row.append(controls);
    list.append(row);
  });
  host.append(list);
}

export function renderAvailable(host, catalog, onPlan = () => {}, busy = false) {
  host.replaceChildren();
  const modules = Array.isArray(catalog.modules) ? catalog.modules : [];
  if (!modules.length) host.append(node('p', 'modules-empty', 'Доступных модулей нет.'));
  modules.forEach((item) => {
    const card = node('article', 'modules-card');
    card.append(node('h2', '', moduleTitle(item)));
    if (item.description) card.append(node('p', '', item.description));
    dependencies(card, 'Зависимости', item.requires || item.dependencies);
    dependencies(card, 'Конфликты', item.conflicts);
    const actions = Array.isArray(item.lifecycle_actions) ? item.lifecycle_actions : [];
    if (actions.length) {
      const actionRow = node('div', 'modules-card-actions');
      actions.forEach((action) => {
        if (ACTION_LABELS[action]) actionRow.append(actionButton(action, item.id, `${ACTION_LABELS[action]} ${item.name || item.id}`, onPlan, busy));
      });
      card.append(actionRow);
    }
    host.append(card);
  });
}
