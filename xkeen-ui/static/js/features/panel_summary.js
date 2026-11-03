import { renderUpdateChannel, wireUpdateChannel } from './update_channel.js';

// Сводка о панели — одна на шапку «Модулей и обновлений» и на карточку
// «Сборка панели» в DevTools: версия и канал, три счётчика, что требует
// внимания. Страницы собирают её из этих кусков каждая в своём порядке.

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text ?? '');
  return element;
}

const CORE_REQUIREMENTS = { xray: 'Xray', mihomo: 'Mihomo' };

function moduleNames(modules) {
  return new Map(modules.map((item) => [item.id, item.name || item.id]));
}

function moduleList(ids, names) {
  return ids.map((id) => (names && names.get(String(id))) || String(id)).join(', ');
}

// Что модуль не делает, хотя переключатель говорит другое. null — работает как показано.
export function moduleProblem(item, names) {
  if (item.status === 'failed') return { tone: 'bad', text: 'Не запустился при последнем старте панели' };
  if (item.status === 'unavailable') {
    const missing = Array.isArray(item.missing_requirement_ids) ? item.missing_requirement_ids : [];
    const engine = missing.map((id) => CORE_REQUIREMENTS[id]).find(Boolean);
    if (engine) return { tone: 'warn', text: `Ядро ${engine} на роутере не найдено` };
    if (missing.length) return { tone: 'warn', text: `На роутере не хватает: ${missing.join(', ')}` };
    const deps = Array.isArray(item.unavailable_dependency_ids) ? item.unavailable_dependency_ids : [];
    if (deps.length) return { tone: 'warn', text: `Не работает без модуля: ${moduleList(deps, names)}` };
    return { tone: 'warn', text: 'Сейчас не работает' };
  }
  if (item.reason === 'deferred_disable_blocked') {
    return { tone: 'warn', text: 'Выключится, когда ядро остановят' };
  }
  return null;
}

// Чего ждёт перенос набора на диск: только файлов редакторов или набора модулей.
// Пока он не сделан, панель не перезапустится — сначала докачка.
export function pendingTransition(snapshot) {
  if (snapshot?.transition_required !== true) return null;
  const target = snapshot.transition_target && typeof snapshot.transition_target === 'object' ? snapshot.transition_target : {};
  const wanted = Array.isArray(target.module_ids) ? target.module_ids.map(String) : null;
  const installed = new Set(Array.isArray(snapshot.installed_module_ids) ? snapshot.installed_module_ids.map(String) : []);
  const from = snapshot.editor?.installed_variant;
  const to = target.editor_variant;
  const sameModules = wanted !== null && wanted.length === installed.size && wanted.every((id) => installed.has(id));
  if (sameModules && from && to && from !== to) return { kind: 'editor', from, to };
  return { kind: 'modules' };
}

// Всё, что требует внимания: модули с бедой и перезапуск, которого ждёт панель.
export function summaryIssues(snapshot, { restartRequired = false } = {}) {
  const modules = Array.isArray(snapshot?.modules) ? snapshot.modules : [];
  const names = moduleNames(modules);
  const issues = [];
  for (const item of modules) {
    const problem = moduleProblem(item, names);
    if (problem) issues.push({ ...problem, moduleId: item.id, name: item.name || item.id });
  }
  const transition = modulesChangeable(snapshot) ? pendingTransition(snapshot) : null;
  if (transition) {
    issues.push({
      tone: 'warn',
      moduleId: '',
      name: 'Панель',
      text: transition.kind === 'editor'
        ? 'Нужно докачать файлы редакторов — откройте «Модули и обновления»'
        : 'Нужно применить набор модулей — откройте «Модули и обновления»',
    });
  } else if (restartRequired || snapshot?.restart_required === true) {
    issues.push({ tone: 'warn', moduleId: '', name: 'Панель', text: 'Нужен перезапуск, чтобы изменения вступили в силу' });
  }
  return issues;
}

export function isLocalBuild(snapshot) {
  return !String(snapshot?.panel_version || '').trim() || snapshot?.lifecycle?.local === true;
}

export function lifecycleAvailable(snapshot) {
  return snapshot?.lifecycle?.available === true;
}

// Локальная сборка с версией выпуска обновляет панель, но модулей не меняет:
// пакеты выпуска собраны из другого кода.
export function modulesChangeable(snapshot) {
  return lifecycleAvailable(snapshot) && snapshot?.lifecycle?.local !== true;
}

function buildOf(snapshot) {
  return snapshot?.build && typeof snapshot.build === 'object' ? snapshot.build : {};
}

// Полный хэш (40 символов) рвёт строку. Короткого префикса хватает, чтобы сверить сборку.
function shortCommit(commit) {
  const raw = String(commit || '').trim();
  return /^[0-9a-f]{13,}$/i.test(raw) ? raw.slice(0, 12) : raw;
}

// No date is no date: new Date(null) would be 1 January 1970.
function validDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

// «сегодня в 14:05» или «15.10.2026 в 14:05».
export function formatCheckedAt(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return '';
  const date = new Date(value * 1000);
  const time = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const today = new Date().toDateString() === date.toDateString();
  return `${today ? 'сегодня' : date.toLocaleDateString('ru-RU')} в ${time}`;
}

function panelTitle(snapshot) {
  const release = String(snapshot?.panel_version || '').trim();
  // Пометка локальной сборки (+local.<коммит>) видна в подробностях о сборке.
  if (release && snapshot?.lifecycle?.local === true) return `Локальная сборка ${release.split('+')[0]}`;
  if (release) return `Xkeen UI ${release}`;
  const build = buildOf(snapshot);
  const version = String(build.version || '').trim() || shortCommit(build.commit);
  return version ? `Локальная сборка ${version}` : 'Сборка панели не определена';
}

const CHANNEL_CHIPS = { stable: 'Стабильный канал', prerelease: 'Предрелизный канал' };

function channelOf(snapshot) {
  return snapshot?.update_channel === 'prerelease' ? 'prerelease' : 'stable';
}

// Заголовок, строка «Источник · собрано · подробнее о сборке» и раскрываемые подробности.
export function summaryHeading(snapshot, { level = 'h2' } = {}) {
  const build = buildOf(snapshot);
  const channel = channelOf(snapshot);
  const title = node(level, 'xk-summary-title');
  title.append(node('span', 'xk-summary-version', panelTitle(snapshot)));
  title.append(node('span', `xk-summary-chip is-${channel}`, CHANNEL_CHIPS[channel]));

  const meta = node('div', 'xk-summary-meta');
  const parts = [];
  if (build.repo) parts.push(`Источник: ${build.repo}`);
  const built = validDate(build.built_utc);
  if (built) parts.push(`собрано ${built.toLocaleDateString('ru-RU')}`);
  else if (build.built_utc) parts.push(`собрано ${build.built_utc}`);
  const more = node('details', 'xk-summary-more');
  more.append(node('summary', '', 'подробнее о сборке'));
  const facts = node('dl', 'xk-summary-facts');
  const fact = (label, value, hint) => {
    if (!value) return;
    const dd = node('dd', '', value);
    if (hint && hint !== value) dd.title = hint;
    facts.append(node('dt', '', label), dd);
  };
  fact('Версия сборки', String(build.version || '').trim());
  fact('Коммит', shortCommit(build.commit), String(build.commit || ''));
  fact('Ветка сборки', String(build.channel || '').trim());
  fact('Собрано', built ? built.toLocaleString('ru-RU') : String(build.built_utc || ''));
  fact('Источник', String(build.repo || '').trim());
  const line = node('p', 'xk-summary-meta-line');
  if (parts.length) line.append(document.createTextNode(`${parts.join(' · ')} · `));
  if (facts.childElementCount) {
    line.append(more);
    meta.append(line);
    more.append(facts);
  } else if (parts.length) {
    line.textContent = parts.join(' · ');
    meta.append(line);
  }
  return [title, meta];
}

const LOCAL_CHANNEL_HINT = 'Канал запомнится и сработает, когда панель будет поставлена из выпуска.';

// Строка «Канал обновлений» с переключателем и подсказка под ней.
export function summaryChannel(snapshot, { onSelect = null, onError = null, busy = false } = {}) {
  const row = node('div', 'xk-summary-channel');
  const label = node('span', 'xk-summary-label', 'Канал обновлений');
  const root = node('span', 'xk-summary-switch');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Канал обновлений');
  for (const [channel, text] of [['stable', 'Стабильный'], ['prerelease', 'Предрелизный']]) {
    const button = node('button', '');
    button.type = 'button';
    button.dataset.channel = channel;
    button.disabled = !!busy || typeof onSelect !== 'function';
    const dot = node('span', 'xk-summary-switch-dot');
    dot.setAttribute('aria-hidden', 'true');
    button.append(dot, document.createTextNode(text));
    root.append(button);
  }
  row.append(label, root);
  const hint = node('p', 'xk-summary-hint xk-summary-channel-hint');
  const local = !lifecycleAvailable(snapshot);
  const paint = (value) => {
    renderUpdateChannel(root, hint, value);
    if (local) hint.textContent = LOCAL_CHANNEL_HINT;
  };
  paint(snapshot?.update_channel);
  if (typeof onSelect === 'function') {
    wireUpdateChannel({
      root,
      hint,
      onSelect: async (channel) => {
        const result = await onSelect(channel);
        if (result && result.channel) paint(result.channel);
        return result;
      },
      onError: (error) => {
        if (typeof onError === 'function') onError(error, hint);
      },
    });
  }
  return [row, hint];
}

function enabledStat(snapshot) {
  const modules = Array.isArray(snapshot?.modules) ? snapshot.modules : [];
  const enabled = modules.filter((item) => item.enabled === true).length;
  return { tone: '', value: `${enabled} из ${modules.length}`, label: 'модулей включено' };
}

function attentionStat(count) {
  const one = count % 10 === 1 && count % 100 !== 11;
  return { tone: count ? 'warn' : 'ok', value: String(count), label: one ? 'требует внимания' : 'требуют внимания' };
}

// Russian counts: 1 модуль, 2 модуля, 5 модулей.
export function modulesWord(count) {
  const ones = count % 10;
  const tens = count % 100;
  if (ones === 1 && tens !== 11) return 'модуль';
  if (ones >= 2 && ones <= 4 && (tens < 12 || tens > 14)) return 'модуля';
  return 'модулей';
}

// «Есть обновления модулей: …». names maps an id to its name (a Map or an
// object); limit names only so many, the rest as a count.
export function moduleUpdatesText(offers, names = null, { limit = 0 } = {}) {
  const list = Array.isArray(offers) ? offers : [];
  if (!list.length) return '';
  const nameOf = (id) => {
    const key = String(id ?? '');
    const known = names && (typeof names.get === 'function' ? names.get(key) : names[key]);
    return known || key;
  };
  const shown = limit > 0 && list.length > limit ? list.slice(0, limit) : list;
  const words = shown.map((offer) => `${nameOf(offer.module_id)} ${offer.version}`).join(', ');
  const more = list.length - shown.length;
  return `Есть обновления модулей: ${words}${more > 0 ? ` и ещё ${more}` : ''}.`;
}

// moduleUpdates counts modules with an update of their own; while the panel
// itself is current, the counter tells of them instead.
export function updateStat(snapshot, update, { moduleUpdates = 0, moduleUpdatesLabel = '' } = {}) {
  if (!lifecycleAvailable(snapshot)) return { tone: 'muted', value: '—', label: 'обновление из окна недоступно' };
  if (update?.loading) return { tone: 'muted', value: '…', label: 'проверяем обновления' };
  if (update?.error) return { tone: 'muted', value: '—', label: 'не удалось проверить' };
  if (!update?.checked) return { tone: 'muted', value: '—', label: 'обновления не проверены' };
  if (update.requires_installer) return { tone: 'warn', value: update.target_version || '—', label: 'только через установщик' };
  if (update.update_available) return { tone: 'accent', value: update.target_version || '—', label: 'доступно обновление' };
  if (moduleUpdates > 0 && moduleUpdatesLabel) return { tone: 'accent', value: String(moduleUpdates), label: moduleUpdatesLabel };
  if (update.stable_unreleased) return { tone: 'ok', value: update.source_version || snapshot?.panel_version || '—', label: 'стабильных выпусков пока нет' };
  const current = update.source_version || snapshot?.panel_version || '—';
  return { tone: 'ok', value: current, label: update.freshness === 'stale' ? 'актуальна по сохранённым данным' : 'версия актуальна' };
}

// Номер беты крупными цифрами в плашку не влезает: выпуск остаётся крупным,
// метка беты встаёт рядом мелко. Метаданные сборки (+…) видны в заголовке.
function statValue(value) {
  const match = /^(\d+\.\d+\.\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match || match[0] === match[1]) return node('b', '', value);
  const number = node('b', '', match[1]);
  if (match[2]) number.append(' ', node('small', '', match[2]));
  return number;
}

// Три плашки: сколько включено, сколько требует внимания, что с обновлением.
// modules — { moduleUpdates, moduleUpdatesLabel }: обновления отдельных модулей.
export function summaryStats(snapshot, update, issues, modules = {}) {
  const stats = node('div', 'xk-summary-stats');
  for (const [key, stat] of [
    ['enabled', enabledStat(snapshot)],
    ['attention', attentionStat(issues.length)],
    ['update', updateStat(snapshot, update, modules)],
  ]) {
    const cell = node('div', `xk-summary-stat${stat.tone ? ` is-${stat.tone}` : ''}`);
    cell.dataset.stat = key;
    cell.append(statValue(stat.value), node('span', '', stat.label));
    stats.append(cell);
  }
  return stats;
}

export function summaryIssueList(issues) {
  const list = node('ul', 'xk-summary-issues');
  for (const issue of issues) {
    const item = node('li', `is-${issue.tone}`);
    if (issue.moduleId) item.dataset.moduleId = issue.moduleId;
    item.append(node('span', 'xk-summary-issue-name', issue.name), node('small', '', issue.text));
    list.append(item);
  }
  return list;
}

// Плашка вместо команд обновления, когда подписанные операции недоступны.
export function summaryLifecycleNote(snapshot, describeFailure) {
  const note = node('p', 'xk-summary-note');
  if (lifecycleAvailable(snapshot)) {
    if (modulesChangeable(snapshot)) return null;
    note.append(
      node('b', '', 'Локальная сборка. '),
      document.createTextNode('Обновить панель до выпуска можно отсюда, а ставить и удалять модули — только на выпуске. Включать и выключать модули можно.'),
    );
    return note;
  }
  if (isLocalBuild(snapshot) || snapshot?.lifecycle?.code === 'panel_version_unsupported') {
    note.append(
      node('b', '', 'Локальная сборка. '),
      document.createTextNode('Обновление панели и установка модулей из окна недоступны — для них нужен подписанный выпуск. Включать и выключать модули можно.'),
    );
  } else {
    note.textContent = typeof describeFailure === 'function'
      ? describeFailure(snapshot?.lifecycle || {})
      : 'Обновление панели из окна сейчас недоступно.';
  }
  return note;
}
