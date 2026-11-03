import { setDevtoolsNamespaceApi } from '../devtools_namespace.js';
import { wireTopLevelNavigation } from '../../pages/top_level_nav.shared.js';
import { createModuleLifecycleClient } from '../module_manager/api.js';
import { reconcileModulesUpdateCheck } from '../module_manager/badge.js';
import { describeLifecycleFailure } from '../module_manager/render.js';
import {
  lifecycleAvailable,
  moduleUpdatesText,
  modulesWord,
  summaryChannel,
  summaryHeading,
  summaryIssueList,
  summaryIssues,
  summaryLifecycleNote,
  summaryStats,
} from '../panel_summary.js';

// Справочная карточка «Сборка панели» на вкладке Tools — та же сводка, что
// в шапке «Модулей и обновлений»: версия и канал, три счётчика и только те
// модули, что требуют внимания. Сама карточка ничего не обновляет — кнопка
// ведёт в «Модули и обновления».
(() => {
  'use strict';

  const api = createModuleLifecycleClient();
  let _inited = false;
  let _loadSeq = 0;

  function byId(id) {
    return document.getElementById(id);
  }

  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = String(text);
    return el;
  }

  function setError(message) {
    const el = byId('dt-panel-status');
    if (!el) return;
    el.textContent = String(message || '');
    el.hidden = !message;
  }

  function modulesUrl() {
    const card = byId('dt-update-card');
    return (card && card.dataset.modulesUrl) || '/modules';
  }

  async function selectChannel(channel) {
    const result = await api.setUpdateChannel(channel);
    // У другого канала свой каталог и своя проверка обновлений.
    await load();
    return result;
  }

  function render(installed, update) {
    const host = byId('dt-panel-summary');
    if (!host) return;
    const issues = summaryIssues(installed);
    host.replaceChildren(...summaryHeading(installed, { level: 'h3' }));
    // Updates of single modules count only while the panel itself is current:
    // an update of the panel brings every module with it.
    const checked = update && update.checked && !update.update_available && !update.requires_installer;
    const offers = checked && Array.isArray(update.module_updates) ? update.module_updates : [];
    host.append(summaryStats(installed, update, issues, {
      moduleUpdates: offers.length,
      moduleUpdatesLabel: `${modulesWord(offers.length)} можно обновить`,
    }));
    if (offers.length) {
      // Three by name, the rest as a count: the whole list is on the screen of modules.
      const names = installed && installed.module_names && typeof installed.module_names === 'object' ? installed.module_names : null;
      host.append(node('p', 'xk-summary-hint xk-summary-modules-note', `Панель актуальна. ${moduleUpdatesText(offers, names, { limit: 3 })}`));
    }
    if (issues.length) host.append(summaryIssueList(issues));
    host.append(...summaryChannel(installed, {
      onSelect: selectChannel,
      onError: (error) => {
        setError('Не удалось выбрать канал: ' + ((error && error.message) || 'нет ответа сервера'));
      },
    }));
    const note = summaryLifecycleNote(installed, describeLifecycleFailure);
    if (note) host.append(note);
    const ready = (update && update.checked && update.update_available && !update.requires_installer) || offers.length > 0;
    const link = node('a', ready ? 'xk-summary-link is-primary' : 'xk-summary-link',
      ready ? 'Обновить в «Модулях и обновлениях»' : 'Открыть «Модули и обновления»');
    link.href = modulesUrl();
    link.setAttribute('data-xk-top-nav', '1');
    const actions = node('div', 'xk-summary-link-row');
    actions.append(link);
    host.append(actions);
    // The card is drawn after the page wired its links: this one is wired here.
    wireTopLevelNavigation(actions);
  }

  // Ответ берётся из каталога, который сервер хранит сутки: открытие вкладки
  // не ходит на GitHub каждый раз.
  async function loadUpdate(installed) {
    if (!lifecycleAvailable(installed)) return null;
    try {
      const check = await api.checkPanelUpdate(false);
      reconcileModulesUpdateCheck(check);
      return { ...check, checked: true };
    } catch (error) {
      return { checked: false, error };
    }
  }

  async function load() {
    const seq = ++_loadSeq;
    let installed;
    try {
      installed = await api.loadInstalled();
    } catch (error) {
      if (seq !== _loadSeq) return null;
      const host = byId('dt-panel-summary');
      if (host) host.replaceChildren(node('p', 'xk-summary-hint', '—'));
      setError('Не удалось загрузить сведения о панели: ' + ((error && error.message) || 'нет ответа сервера'));
      return null;
    }
    if (seq !== _loadSeq) return installed;
    setError('');
    const pending = lifecycleAvailable(installed) ? { loading: true } : null;
    render(installed, pending);
    const update = await loadUpdate(installed);
    if (seq === _loadSeq) render(installed, update);
    return installed;
  }

  function init() {
    if (_inited) return;
    _inited = true;
    load().catch(() => {});
  }

  function activate() {
    if (!_inited) return false;
    load().catch(() => {});
    return true;
  }

  function deactivate() {
    return true;
  }

  setDevtoolsNamespaceApi('devtoolsUpdate', { init, activate, deactivate });
})();
