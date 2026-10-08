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

export function renderInstalled(host, snapshot, onToggle) {
  host.replaceChildren();
  const summary = node('section', 'modules-summary');
  summary.append(node('h2', '', 'Панель и профиль'));
  summary.append(node('p', '', `Профиль: ${snapshot.profile || 'не указан'}`));
  if (snapshot.restart_required) summary.append(node('p', 'modules-alert', 'Требуется перезапуск'));
  host.append(summary);
  const list = node('section', 'modules-list');
  list.append(node('h2', '', 'Установленные модули'));
  const modules = Array.isArray(snapshot.modules) ? snapshot.modules : [];
  if (!modules.length) list.append(node('p', 'modules-empty', 'Установленных модулей нет.'));
  modules.forEach((item) => {
    const row = node('article', 'modules-row');
    const body = node('div', 'modules-row-body');
    body.append(node('h3', '', moduleTitle(item)));
    if (item.description) body.append(node('p', '', item.description));
    row.append(body);
    if (item.can_disable) {
      const label = node('label', 'modules-switch');
      const input = node('input');
      input.type = 'checkbox';
      input.setAttribute('role', 'switch');
      input.setAttribute('aria-label', `Включить ${item.name || item.id}`);
      input.checked = item.enabled === true;
      input.addEventListener('change', () => onToggle(item.id, input.checked, input));
      label.append(input, node('span', '', 'Включён'));
      row.append(label);
    }
    list.append(row);
  });
  host.append(list);
}

export function renderAvailable(host, catalog) {
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
        const button = node('button', 'btn-secondary', { install: 'Установить', repair: 'Восстановить', remove: 'Удалить' }[action] || action);
        button.type = 'button';
        button.dataset.operation = String(action);
        button.dataset.moduleId = String(item.id || '');
        button.disabled = true;
        actionRow.append(button);
      });
      card.append(actionRow);
    }
    host.append(card);
  });
}
