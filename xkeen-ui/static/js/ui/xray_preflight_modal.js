(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XKeen = window.XKeen;
  XKeen.ui = XKeen.ui || {};

  const SUMMARY_LINE_RE = /\b(failed|error|invalid|unexpected|panic|unable|cannot|unknown|duplicate|missing|malformed|timeout|timed out|not found)\b/i;
  const WARNING_LINE_RE = /\b(warn(?:ing)?|deprecated|retry|fallback)\b/i;
  const NOISE_LINE_RE = /^(using confdir from arg:|xray \d+\.\d+\.\d+|a unified platform|reading config:|appended inbound|appended outbound|appended routing|configuration ok)$/i;
  const CONFIG_PATH_RE = /((?:\/|[a-zA-Z]:[\\/])[^\s"'<>]+?\.(?:jsonc?|ya?ml|conf))/g;
  const BRACKETED_CONFIG_PATH_RE = /\[([^\]]+?\.(?:jsonc?|ya?ml|conf))\]/g;
  const LOCATION_IN_TEXT_RE = /(?:\bat\b\s*)?(?:line|строк[аи])\s*[:=]?\s*(\d+)(?:[^\d]{0,18}(?:column|col|столб(?:ец|ца))\s*[:=]?\s*(\d+))?/i;

  let _els = null;
  let _escHandler = null;
  let _copyResetTimer = null;

  function normText(v) {
    return String(v == null ? '' : v).replace(/\r\n/g, '\n').trim();
  }

  function normalizeForCompare(v) {
    return normText(v).replace(/\s+/g, ' ').toLowerCase();
  }

  function isSameMessage(a, b) {
    const left = normalizeForCompare(a);
    const right = normalizeForCompare(b);
    return !!left && !!right && left === right;
  }

  function messageIncludes(haystack, needle) {
    const left = normalizeForCompare(haystack);
    const right = normalizeForCompare(needle);
    return !!left && !!right && left.indexOf(right) !== -1;
  }

  function stripLogPrefix(line) {
    return String(line || '')
      .trim()
      .replace(/^\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+/, '')
      .replace(/^\[(?:info|warning|error|debug)\]\s+/i, '')
      .trim();
  }

  function isNoiseLine(line) {
    const clean = stripLogPrefix(line);
    if (!clean) return true;
    if (NOISE_LINE_RE.test(clean)) return true;
    if (/^\/[^\s]+$/.test(clean)) return true;
    return false;
  }

  function basename(path) {
    const source = String(path || '').trim();
    if (!source) return '';
    const normalized = source.replace(/\\/g, '/');
    const parts = normalized.split('/');
    return parts[parts.length - 1] || normalized;
  }

  function lowerFirst(text) {
    const source = normText(text);
    if (!source) return '';
    return source.charAt(0).toLowerCase() + source.slice(1);
  }

  function collapseConfigPaths(text) {
    return String(text == null ? '' : text)
      .replace(BRACKETED_CONFIG_PATH_RE, (_match, path) => '[' + basename(path) + ']')
      .replace(CONFIG_PATH_RE, (match) => basename(match));
  }

  function prettifyDiagnosticText(text) {
    let value = collapseConfigPaths(normText(text));
    if (!value) return '';
    value = value
      .replace(/(^|>\s*)main:\s*/gi, '$1')
      .replace(/(^|>\s*)infra\/conf(?:\/serial)?:\s*/gi, '$1')
      .replace(/(^|>\s*)app\/(?:dispatcher|proxyman|router)[^:]*:\s*/gi, '$1')
      .replace(/\s*>\s*/g, ' > ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return value;
  }

  function extractLocationTextFromSources() {
    for (let i = 0; i < arguments.length; i += 1) {
      const source = normText(arguments[i]);
      if (!source) continue;
      const match = source.match(LOCATION_IN_TEXT_RE);
      if (!match) continue;
      const line = Number(match[1]);
      const col = Number(match[2]);
      if (Number.isFinite(line) && Number.isFinite(col)) {
        return 'Строка ' + line + ', столбец ' + col;
      }
      if (Number.isFinite(line)) {
        return 'Строка ' + line;
      }
    }
    return '';
  }

  function extractCoreSummary(text) {
    const source = normText(text);
    if (!source) return '';
    const lines = source
      .split('\n')
      .map((line) => stripLogPrefix(line))
      .filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (isNoiseLine(line)) continue;
      if (SUMMARY_LINE_RE.test(line)) return line;
    }
    return '';
  }

  function summarizeKnownError(errorText) {
    const normalized = normalizeForCompare(errorText);
    if (!normalized) return '';
    if (normalized === 'xray test timeout') return 'Проверка не завершилась за отведённое время.';
    if (normalized === 'xray binary not found') return 'Не найден бинарник Xray для проверки.';
    if (normalized === 'xray config dir not found') return 'Не найден каталог конфигурации Xray.';
    if (normalized === 'xray test failed') return '';
    if (normalized.indexOf('preflight exception:') === 0) return 'Не удалось выполнить предварительную проверку Xray.';
    return normText(errorText);
  }

  function extractBalancerReference(text) {
    const source = normText(text);
    if (!source) return '';

    const normalizedLines = source
      .split('\n')
      .map((line) => prettifyDiagnosticText(stripLogPrefix(line)))
      .filter(Boolean);

    const scopedPatterns = [
      /"balancerTag"\s*:\s*"([^"\s]+)"/i,
      /'balancerTag'\s*:\s*'([^'\s]+)'/i,
      /\bbalancerTag\s*[:=]\s*["'`]?([A-Za-z0-9_.:-]+)["'`]?/i,
      /\bbalancerTag\b[^\n"'`]{0,40}["'`]([^"'`\s]+)["'`]/i,
      /\bbalancer\s+([A-Za-z0-9_.:-]+)\s+(?:not found|missing|does not exist|unknown|undefined|no such|non[- ]existent)\b/i,
      /\bbalancerTag\s+([A-Za-z0-9_.:-]+)\s+(?:not found|missing|does not exist|unknown|undefined|no such|non[- ]existent)\b/i,
      /["'`]([^"'`\s]+)["'`][^\n]{0,48}\bbalancerTag\b/i,
    ];

    for (let lineIndex = 0; lineIndex < normalizedLines.length; lineIndex += 1) {
      const line = normalizedLines[lineIndex];
      if (!/\bbalancer(?:Tag)?\b/i.test(line)) continue;
      for (let i = 0; i < scopedPatterns.length; i += 1) {
        const match = line.match(scopedPatterns[i]);
        const value = normText(match && match[1]);
        if (value && !/^(?:balancer|balancerTag|tag|not|found|missing|unknown|undefined|server)$/i.test(value)) {
          return value;
        }
      }
    }
    return '';
  }

  function scoreDiagnosticText(text) {
    const source = prettifyDiagnosticText(stripLogPrefix(text));
    if (!source) return Number.NEGATIVE_INFINITY;

    let score = 0;
    if ((/\b(?:balancerTag|balancer)\b[^\n]{0,80}\b(?:not found|missing|does not exist|unknown|undefined|no such|non[- ]existent)\b/i.test(source)) ||
        (/\b(?:not found|missing|does not exist|unknown|undefined|no such|non[- ]existent)\b[^\n]{0,80}\b(?:balancerTag|balancer)\b/i.test(source))) {
      score += 220;
    }
    if (/(unexpected end|unexpected eof|unexpected token|invalid character|invalid json|syntax error|after object key:value pair|comma expected|colon expected|close brace expected|close bracket expected|end of file expected|unexpected end of string|unexpected end of number|malformed)/i.test(source)) {
      score += 200;
    }
    if (/\bduplicat(?:e|ed|ion)\b/i.test(source)) {
      score += 170;
    }
    if (/\bunknown\b.*\b(field|option|protocol|transport|network|security|tag|config|type|outbound|inbound|rule)\b/i.test(source)) {
      score += 160;
    }
    if (/\b(not found|no such file|cannot find|failed to open|open .+ no such file)\b/i.test(source)) {
      score += 150;
    }
    if (/\bport\b.*\b(invalid|out of range|must be|bad)\b/i.test(source)) {
      score += 140;
    }
    if (/\bfailed to (?:build|create|load|parse|start)\b/i.test(source)) {
      score += 60;
    }
    if (/^failed to start:\s*main\b/i.test(source)) {
      score -= 40;
    }
    if (/\[truncated\]/i.test(source)) {
      score -= 80;
    }
    return score;
  }

  function selectPrimaryDiagnostic(diagnostics, stderr, stdout, errorText) {
    const list = Array.isArray(diagnostics) ? diagnostics : [];
    let bestProblem = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < list.length; i += 1) {
      const item = list[i];
      if (!item || item.kind !== 'problem') continue;
      const score = scoreDiagnosticText(item.text) + (i / 1000);
      if (!bestProblem || score >= bestScore) {
        bestProblem = item;
        bestScore = score;
      }
    }
    if (bestProblem) return bestProblem;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i]) return list[i];
    }

    const fallback = extractCoreSummary(stderr) || extractCoreSummary(stdout) || summarizeKnownError(errorText);
    if (!fallback) return null;
    return {
      kind: classifyTerminalLine(fallback),
      text: fallback,
    };
  }

  function extractRootCauseText(text) {
    const clean = prettifyDiagnosticText(stripLogPrefix(text));
    if (!clean) return '';
    const chain = clean.split(/\s+>\s+/).map((part) => normText(part)).filter(Boolean);
    if (chain.length) {
      for (let i = chain.length - 1; i >= 0; i -= 1) {
        if (SUMMARY_LINE_RE.test(chain[i])) return chain[i];
      }
      return chain[chain.length - 1];
    }
    return clean;
  }

  function resolveFocusFile(primaryLine, files) {
    const explicit = extractConfigFileNames(primaryLine || '');
    if (explicit.length) {
      return { name: explicit[explicit.length - 1], source: 'explicit' };
    }
    const pool = Array.isArray(files) ? files.filter(Boolean) : [];
    if (pool.length) {
      return { name: pool[pool.length - 1], source: pool.length > 1 ? 'last_seen' : 'list' };
    }
    return { name: '', source: '' };
  }

  function isGenericRootCauseText(text) {
    const source = normalizeForCompare(text);
    if (!source) return true;
    return /^failed to (?:build|create|load|parse|start)/.test(source) ||
      source === 'xray preflight failed' ||
      source === 'xray test failed';
  }

  function detectIssuePattern(text, payload) {
    const source = String(text || '');

    if (payload && payload.timed_out) {
      return {
        id: 'timeout',
        summary: 'Проверка конфигурации Xray не успела завершиться.',
        action: 'Проверьте тяжёлый или проблемный фрагмент конфига и попробуйте сохранить ещё раз.',
      };
    }

    if (/(unexpected end|unexpected eof|unexpected token|invalid character|invalid json|syntax error|after object key:value pair|comma expected|colon expected|close brace expected|close bracket expected|end of file expected|unexpected end of string|unexpected end of number|malformed)/i.test(source)) {
      return {
        id: 'json_syntax',
        summary: 'Похоже, в конфиге сломан синтаксис JSON.',
        action: 'Проверьте рядом с ошибкой запятые, кавычки и закрывающие `}` или `]`.',
      };
    }

    if (/\bduplicat(?:e|ed|ion)\b/i.test(source)) {
      return {
        id: 'duplicate',
        summary: 'Похоже, в конфиге есть дублирующийся ключ, тег или блок.',
        action: 'Уберите дубликат или переименуйте повторяющийся элемент.',
      };
    }

    if (((/\b(?:balancerTag|balancer)\b[^\n]{0,80}\b(?:not found|missing|does not exist|unknown|undefined|no such|non[- ]existent)\b/i.test(source)) ||
        (/\b(?:not found|missing|does not exist|unknown|undefined|no such|non[- ]existent)\b[^\n]{0,80}\b(?:balancerTag|balancer)\b/i.test(source)))) {
      const balancerRef = extractBalancerReference(source);
      return {
        id: 'missing_balancer',
        summary: balancerRef
          ? 'Правило ссылается на balancerTag "' + balancerRef + '", но такого балансировщика нет.'
          : 'Правило ссылается на несуществующий balancerTag.',
        where: balancerRef
          ? 'Ищите правило, где указан balancerTag "' + balancerRef + '", и сверяйте его со списком routing.balancers.'
          : 'Ищите правило с balancerTag и список routing.balancers: теги должны совпадать один в один.',
        action: balancerRef
          ? 'Создайте балансировщик с tag "' + balancerRef + '" в routing.balancers или исправьте это значение в правиле.'
          : 'Проверьте, что balancerTag в правиле точно совпадает с tag существующего балансировщика в routing.balancers.',
        rootCause: balancerRef
          ? 'В правиле указан balancerTag "' + balancerRef + '", но балансировщик с таким tag не найден.'
          : 'В одном из правил указан balancerTag, для которого нет соответствующего балансировщика.',
      };
    }

    if (/\bunknown\b.*\b(field|option|protocol|transport|network|security|tag|config|type|outbound|inbound|rule)\b/i.test(source)) {
      return {
        id: 'unknown_value',
        summary: 'Xray встретил поле или значение, которое не понимает.',
        action: 'Проверьте название параметра и его значение: возможно, это опечатка или неподдерживаемая опция.',
      };
    }

    if (/\b(not found|no such file|cannot find|failed to open|open .+ no such file)\b/i.test(source)) {
      return {
        id: 'missing_resource',
        summary: 'Конфиг ссылается на файл или ресурс, которого сейчас нет.',
        action: 'Проверьте путь, имя файла и наличие нужного файла на роутере.',
      };
    }

    if (/\bport\b.*\b(invalid|out of range|must be|bad)\b/i.test(source)) {
      return {
        id: 'invalid_port',
        summary: 'В одном из фрагментов указан некорректный порт.',
        action: 'Используйте порт от 1 до 65535 и проверьте, что значение записано числом.',
      };
    }

    if (/\bfailed to (?:build|create|load|parse|start)\b/i.test(source)) {
      return {
        id: 'build_chain',
        summary: 'Xray не смог собрать итоговый конфиг из фрагментов.',
        action: 'Ориентируйтесь на последнюю красную строку: в ней обычно указан проблемный файл или параметр.',
      };
    }

    return {
      id: 'generic',
      summary: 'Xray нашёл ошибку в конфиге.',
      action: 'Посмотрите красные строки справа: они лучше всего показывают, что именно не понравилось Xray.',
    };
  }

  function buildReturnCodeHelp(payload, code) {
    const value = String(code == null ? '' : code).trim();
    if (!value || value === '0' || value === '—') return '';
    if (payload && payload.timed_out) {
      return 'Здесь важен не код возврата, а сам таймаут: проверка не уложилась в лимит и была прервана.';
    }
    if (value === '23') {
      return 'Код 23 здесь означает только то, что `xray -test` завершился с ошибкой и конфиг не прошёл проверку. Сам код не говорит, что именно сломано: причину ищите в разборе ошибки и в красных строках справа.';
    }
    return 'Код ' + value + ' означает только то, что `xray -test` завершился с ошибкой. Сам по себе он не объясняет причину; ориентируйтесь на разбор ошибки и красные строки справа.';
  }

  function buildHumanDiagnosis(payload, details) {
    const summary = normText(details && details.summary);
    const hint = normText(details && details.hint);
    const locationText = normText(details && details.locationText);
    const stderr = normText(details && details.stderr);
    const stdout = normText(details && details.stdout);
    const errorText = normText(details && details.errorText);
    const diagnostics = collectDiagnosticLines(summary, stderr, stdout, errorText);
    const primary = selectPrimaryDiagnostic(diagnostics, stderr, stdout, errorText);
    const primaryLine = prettifyDiagnosticText(primary && primary.text ? primary.text : '');
    const rootCause = extractRootCauseText(primaryLine || summary || errorText);
    const files = extractConfigFileNames(primaryLine, stderr, stdout);
    const focus = resolveFocusFile(primaryLine, files);
    const issue = detectIssuePattern([rootCause, primaryLine, summary, stderr, stdout, errorText].filter(Boolean).join('\n'), payload);
    const code = payload && payload.returncode != null && payload.returncode !== '' ? String(payload.returncode) : '';
    const codeHelp = buildReturnCodeHelp(payload, code);
    let rootCauseText = prettifyDiagnosticText(rootCause);

    if (issue.rootCause && (isGenericRootCauseText(rootCauseText) || (issue.id === 'missing_balancer' && !/\bbalancer(?:Tag)?\b/i.test(rootCauseText)))) {
      rootCauseText = issue.rootCause;
    }

    let humanSummary = issue.summary;
    if (focus.name && issue.id === 'json_syntax' && locationText) {
      humanSummary = 'Похоже, в ' + focus.name + ' есть синтаксическая ошибка рядом с ' + lowerFirst(locationText) + '.';
    } else if (focus.name && issue.id === 'json_syntax') {
      humanSummary = 'Похоже, в ' + focus.name + ' есть синтаксическая ошибка JSON.';
    } else if (focus.name && issue.id === 'unknown_value') {
      humanSummary = 'Похоже, в ' + focus.name + ' есть неподдерживаемое поле или значение.';
    } else if (focus.name && issue.id === 'duplicate') {
      humanSummary = 'Похоже, в ' + focus.name + ' есть дублирующийся ключ, тег или блок.';
    } else if (focus.name && issue.id === 'build_chain') {
      humanSummary = 'Xray не смог собрать конфиг; сначала проверьте ' + focus.name + '.';
    } else if (focus.name && issue.id === 'generic') {
      humanSummary = 'Xray нашёл проблему в конфиге; сначала проверьте ' + focus.name + '.';
    } else if (locationText && issue.id === 'json_syntax') {
      humanSummary = 'Похоже, в конфиге есть синтаксическая ошибка рядом с ' + lowerFirst(locationText) + '.';
    }

    let whereText = normText(issue.where);
    if (!whereText && focus.name && locationText) {
      whereText = 'Начните с ' + focus.name + ': ошибка указывает на ' + lowerFirst(locationText) + '.';
    } else if (!whereText && focus.name && focus.source === 'explicit') {
      whereText = 'Ошибка прямо указывает на файл ' + focus.name + '.';
    } else if (!whereText && focus.name && focus.source === 'last_seen') {
      whereText = 'Последним перед ошибкой Xray обрабатывал ' + focus.name + '. Начните с него.';
    } else if (!whereText && files.length) {
      whereText = 'Проверьте сначала эти фрагменты: ' + formatList(files, 3) + '.';
    }

    const genericHint = normalizeForCompare('Xray не принял конфиг. Исправьте ошибку и повторите сохранение.');
    const hasCustomHint = !!hint && normalizeForCompare(hint) !== genericHint;
    const actionText = hasCustomHint ? hint : issue.action;

    return {
      summaryText: humanSummary,
      whereText,
      actionText,
      primaryLine,
      rootCause: rootCauseText,
      files,
      focusFile: focus.name,
      codeHelp,
    };
  }

  function classifyTerminalLine(line) {
    const raw = String(line == null ? '' : line);
    const clean = stripLogPrefix(raw);
    if (!clean) return 'plain';
    if (/\[(?:error|panic)\]/i.test(raw)) return 'problem';
    if (SUMMARY_LINE_RE.test(clean)) return 'problem';
    if (/(?:^|[^\w])(line|column)\s*:\s*\d+/i.test(clean)) return 'problem';
    if (/\[(?:warn|warning)\]/i.test(raw)) return 'warning';
    if (WARNING_LINE_RE.test(clean)) return 'warning';
    return 'plain';
  }

  function collectDiagnosticLines() {
    const seen = new Set();
    const lines = [];

    for (let i = 0; i < arguments.length; i += 1) {
      const source = normText(arguments[i]);
      if (!source) continue;
      source.split('\n').forEach((line) => {
        const clean = stripLogPrefix(line);
        if (!clean || isNoiseLine(line)) return;
        const kind = classifyTerminalLine(line);
        if (kind === 'plain') return;
        const key = normalizeForCompare(clean);
        if (!key || seen.has(key)) return;
        seen.add(key);
        lines.push({ kind, text: clean });
      });
    }

    return lines;
  }

  function extractConfigFileNames() {
    const seen = new Set();
    const files = [];

    for (let i = 0; i < arguments.length; i += 1) {
      const source = normText(arguments[i]);
      if (!source) continue;
      const matches = source.match(CONFIG_PATH_RE) || [];
      matches.forEach((match) => {
        const name = basename(match);
        const key = normalizeForCompare(name);
        if (!key || seen.has(key)) return;
        seen.add(key);
        files.push(name);
      });
    }

    return files;
  }

  function formatList(items, limit) {
    const source = Array.isArray(items) ? items.filter(Boolean) : [];
    if (!source.length) return '';
    const max = Number.isFinite(limit) && limit > 0 ? limit : source.length;
    const visible = source.slice(0, max);
    const tail = source.length > visible.length ? ' и ещё ' + (source.length - visible.length) : '';
    return visible.join(', ') + tail;
  }

  function pushExplanationItem(items, seen, label, text, tone) {
    const nextLabel = normText(label);
    const nextText = normText(text);
    if (!nextLabel || !nextText) return;
    const key = normalizeForCompare(nextLabel + ' ' + nextText);
    if (!key || seen.has(key)) return;
    seen.add(key);
    items.push({
      label: nextLabel,
      text: nextText,
      tone: tone || 'info',
    });
  }

  function buildExplanationItems(payload, details) {
    const items = [];
    const seen = new Set();
    const hint = normText(details && details.hint);
    const locationText = normText(details && details.locationText);
    const stderr = normText(details && details.stderr);
    const stdout = normText(details && details.stdout);
    const diagnosis = buildHumanDiagnosis(payload, details);
    const diagnostics = collectDiagnosticLines(stderr, stdout);

    if (diagnosis.rootCause) {
      pushExplanationItem(items, seen, 'Почему Xray остановился', diagnosis.rootCause, 'problem');
    }

    if (diagnosis.whereText) {
      pushExplanationItem(items, seen, 'Где искать', diagnosis.whereText, locationText ? 'problem' : 'info');
    }

    if (diagnosis.actionText) {
      pushExplanationItem(items, seen, 'Что исправить', diagnosis.actionText, 'action');
    } else if (hint) {
      pushExplanationItem(items, seen, 'Что исправить', hint, 'action');
    }

    if (diagnosis.primaryLine && !isSameMessage(diagnosis.primaryLine, diagnosis.rootCause) && !isSameMessage(diagnosis.primaryLine, diagnosis.actionText)) {
      pushExplanationItem(items, seen, 'Красная строка из лога', diagnosis.primaryLine, 'problem');
    }

    if (!items.length && diagnostics.length) {
      const fallback = prettifyDiagnosticText(diagnostics[0].text);
      pushExplanationItem(items, seen, 'Красная строка из лога', fallback, diagnostics[0].kind === 'problem' ? 'problem' : 'warning');
    }

    return items.slice(0, 4);
  }

  function renderExplanationItems(container, items) {
    if (!container) return;
    container.textContent = '';
    const source = Array.isArray(items) ? items : [];
    if (!source.length) return;

    const fragment = document.createDocumentFragment();
    source.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'xk-preflight-explainer-item';
      if (item && item.tone) row.classList.add('is-' + item.tone);

      const label = document.createElement('div');
      label.className = 'xk-preflight-explainer-label';
      label.textContent = String(item && item.label ? item.label : '');

      const text = document.createElement('div');
      text.className = 'xk-preflight-explainer-text';
      text.textContent = String(item && item.text ? item.text : '');

      row.appendChild(label);
      row.appendChild(text);
      fragment.appendChild(row);
    });

    container.appendChild(fragment);
  }

  function renderTerminalOutput(el, text, emptyLabel) {
    if (!el) return;

    const source = normText(text);
    if (!source) {
      el.textContent = emptyLabel || '';
      return;
    }

    el.textContent = '';
    const fragment = document.createDocumentFragment();

    source.split('\n').forEach((line) => {
      const row = document.createElement('span');
      row.className = 'xk-preflight-terminal-line';

      const kind = classifyTerminalLine(line);
      if (kind === 'problem') {
        row.classList.add('is-problem');
      } else if (kind === 'warning') {
        row.classList.add('is-warning');
      } else if (isNoiseLine(line)) {
        row.classList.add('is-muted');
      }

      row.textContent = line || ' ';
      fragment.appendChild(row);
    });

    el.appendChild(fragment);
  }

  function findTerminalDiagnosticRow(el, preferredText) {
    if (!el) return null;
    const rows = Array.from(el.querySelectorAll('.xk-preflight-terminal-line.is-problem, .xk-preflight-terminal-line.is-warning'));
    if (!rows.length) return null;

    const preferred = normalizeForCompare(preferredText);
    if (preferred) {
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const rowText = prettifyDiagnosticText(stripLogPrefix(rows[i].textContent || ''));
        const normalizedRow = normalizeForCompare(rowText);
        if (normalizedRow && (normalizedRow.indexOf(preferred) !== -1 || preferred.indexOf(normalizedRow) !== -1)) {
          return rows[i];
        }
      }
    }

    const problemRows = rows.filter((row) => row.classList.contains('is-problem') && !/\[truncated\]/i.test(row.textContent || ''));
    if (problemRows.length) return problemRows[problemRows.length - 1];

    const warningRows = rows.filter((row) => row.classList.contains('is-warning'));
    return (problemRows.length ? problemRows[problemRows.length - 1] : null) || (warningRows.length ? warningRows[warningRows.length - 1] : null);
  }

  function scrollTerminalToDiagnostic(el, preferredText) {
    if (!el) return;
    const target = findTerminalDiagnosticRow(el, preferredText);
    try {
      el.scrollTop = 0;
    } catch (e) {}
    if (!target) return;
    try {
      const offset = Math.max(0, target.offsetTop - Math.max(24, Math.round(el.clientHeight * 0.32)));
      el.scrollTop = offset;
    } catch (e2) {}
  }

  function clearCopyState(copyBtn) {
    if (!copyBtn) return;
    try {
      if (_copyResetTimer) clearTimeout(_copyResetTimer);
    } catch (e) {}
    _copyResetTimer = null;
    try {
      copyBtn.textContent = copyBtn.dataset.defaultLabel || 'Скопировать детали';
      copyBtn.classList.remove('is-success');
      copyBtn.classList.remove('is-error');
    } catch (e2) {}
  }

  function locationTextFromPayload(payload, details) {
    if (!payload || !payload.location) {
      return extractLocationTextFromSources(
        details && details.summary,
        details && details.stderr,
        details && details.stdout,
        payload && payload.error
      );
    }
    const loc = payload.location || {};
    const line = Number(loc.line);
    const col = Number(loc.column || loc.col);
    if (Number.isFinite(line) && Number.isFinite(col)) {
      return 'Строка ' + line + ', столбец ' + col;
    }
    if (Number.isFinite(line)) {
      return 'Строка ' + line;
    }
    return extractLocationTextFromSources(
      details && details.summary,
      details && details.stderr,
      details && details.stdout,
      payload && payload.error
    );
  }

  function resolvePresentation(payload) {
    const phase = normText(payload && payload.phase ? payload.phase : 'xray_test') || 'xray_test';
    if (phase === 'json_parse') {
      return {
        title: 'Ошибка JSON',
        description: 'Конфиг не был сохранён. Исправьте синтаксис JSON и попробуйте снова.',
        defaultSummary: 'JSON содержит синтаксическую ошибку.',
        defaultCmd: 'JSON.parse(stripJsonComments(...))',
        modeLabel: 'JSON parse',
        iconText: '{}',
      };
    }
    return {
      title: 'Xray отклонил конфиг',
      description: 'Конфиг не был сохранён. Исправьте ошибку и попробуйте снова.',
      defaultSummary: 'Xray не принял конфиг.',
      defaultCmd: 'xray -test -confdir ...',
      modeLabel: 'Xray preflight',
      iconText: 'XR',
    };
  }

  function formatPhase(phase) {
    const normalized = normText(phase || 'xray_test') || 'xray_test';
    if (normalized === 'json_parse') return 'JSON parse';
    if (normalized === 'xray_test') return 'Xray test';
    return normalized.replace(/_/g, ' ');
  }

  function formatTimeout(payload) {
    if (!payload || payload.timeout_s == null || payload.timeout_s === '') return '';
    const base = String(payload.timeout_s) + ' с';
    return payload.timed_out ? (base + ' (превышен)') : base;
  }

  function setEmptyTerminalState(el, isEmpty) {
    if (!el || !el.classList) return;
    el.classList.toggle('is-empty', !!isEmpty);
  }

  function setProblemState(el, isProblem) {
    if (!el || !el.classList) return;
    el.classList.toggle('is-problem', !!isProblem);
  }

  function setVisible(el, isVisible) {
    if (!el || !el.style) return;
    el.style.display = isVisible ? '' : 'none';
  }

  function shouldShowHint(hint, summary, description, defaultSummary) {
    return !!hint &&
      !isSameMessage(hint, summary) &&
      !isSameMessage(hint, description) &&
      !isSameMessage(hint, defaultSummary) &&
      !messageIncludes(hint, defaultSummary);
  }

  function buildSummary(payload, stderr, stdout, errorText, hint, ui, diagnosis) {
    if (diagnosis && diagnosis.summaryText) return diagnosis.summaryText;
    const summary = extractCoreSummary(stderr) || extractCoreSummary(stdout) || summarizeKnownError(errorText);
    if (summary) return summary;
    if (payload && payload.timed_out) return 'Проверка не завершилась за отведённое время.';
    if (!stderr && !stdout && !hint) return ui.defaultSummary;
    return '';
  }

  function ensureModal() {
    if (_els && _els.modal && _els.modal.isConnected) return _els;

    const modal = document.createElement('div');
    modal.id = 'xray-preflight-modal';
    modal.className = 'modal hidden';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Ошибка проверки Xray');
    modal.dataset.modalKey = 'xray-preflight-premium-v2';

    modal.innerHTML = '' +
      '<div class="modal-content xk-preflight-modal">' +
      '  <div class="modal-header">' +
      '    <span class="modal-title" data-xk-preflight-title>Xray отклонил конфиг</span>' +
      '    <button type="button" class="modal-close" title="Закрыть">×</button>' +
      '  </div>' +
      '  <div class="modal-body xk-preflight-body">' +
      '    <section class="xk-preflight-lead">' +
      '      <div class="xk-preflight-lead-icon" data-xk-preflight-icon>XR</div>' +
      '      <div class="xk-preflight-lead-copy">' +
      '        <div class="xk-preflight-lead-title" data-xk-preflight-lead-title>Xray отклонил конфиг</div>' +
      '        <p class="modal-description"><span data-xk-preflight-description>Конфиг не был сохранён. Исправьте ошибку и попробуйте снова.</span></p>' +
      '      </div>' +
      '      <div class="xk-preflight-chip" data-xk-preflight-mode>Xray preflight</div>' +
      '    </section>' +
      '    <div class="xk-preflight-grid">' +
      '      <section class="xk-preflight-panel">' +
      '        <div class="xk-preflight-block xk-preflight-block--summary" data-xk-preflight-summary-wrap style="display:none;">' +
      '          <div class="xk-preflight-block-title">Что сломалось</div>' +
      '          <div data-xk-preflight-summary></div>' +
      '        </div>' +
      '        <div class="xk-preflight-block xk-preflight-block--hint" data-xk-preflight-hint-wrap style="display:none;">' +
      '          <div class="xk-preflight-block-title">Что проверить</div>' +
      '          <div data-xk-preflight-hint></div>' +
      '        </div>' +
      '        <div class="xk-preflight-meta-grid">' +
      '          <div class="xk-preflight-meta-card"><div class="xk-preflight-meta-label">Фаза</div><div class="xk-preflight-meta-value" data-xk-preflight-phase></div></div>' +
      '          <div class="xk-preflight-meta-card"><div class="xk-preflight-meta-label">Код</div><button type="button" class="xk-preflight-code-trigger xk-preflight-meta-value" data-xk-preflight-code-trigger data-xk-preflight-code title="Пояснить код возврата Xray" aria-expanded="false">—</button></div>' +
      '          <div class="xk-preflight-meta-card" data-xk-preflight-timeout-card style="display:none;"><div class="xk-preflight-meta-label">Таймаут</div><div class="xk-preflight-meta-value" data-xk-preflight-timeout>—</div></div>' +
      '          <div class="xk-preflight-meta-card" data-xk-preflight-location-card style="display:none;"><div class="xk-preflight-meta-label">Позиция</div><div class="xk-preflight-meta-value" data-xk-preflight-location>—</div></div>' +
      '        </div>' +
      '        <div class="xk-preflight-block xk-preflight-block--code-help" data-xk-preflight-code-help-wrap style="display:none;">' +
      '          <div class="xk-preflight-block-title">Что означает код</div>' +
      '          <div data-xk-preflight-code-help></div>' +
      '        </div>' +
      '        <div class="xk-preflight-block">' +
      '          <div class="xk-preflight-block-title">Команда</div>' +
      '          <pre data-xk-preflight-cmd class="xk-preflight-codebox"></pre>' +
      '        </div>' +
      '        <div class="xk-preflight-block xk-preflight-block--explainer" data-xk-preflight-explainer-wrap style="display:none;">' +
      '          <div class="xk-preflight-block-title">Разбор ошибки</div>' +
      '          <div class="xk-preflight-explainer" data-xk-preflight-explainer></div>' +
      '        </div>' +
      '      </section>' +
      '      <section class="xk-preflight-panel">' +
      '        <div class="xk-preflight-block xk-preflight-block--stderr">' +
      '          <div class="xk-preflight-block-title">stderr</div>' +
      '          <pre data-xk-preflight-stderr class="xk-preflight-terminal xk-preflight-terminal--stderr"></pre>' +
      '        </div>' +
      '        <div class="xk-preflight-block" data-xk-preflight-stdout-wrap style="display:none;">' +
      '          <div class="xk-preflight-block-title">stdout</div>' +
      '          <pre data-xk-preflight-stdout class="xk-preflight-terminal"></pre>' +
      '        </div>' +
      '      </section>' +
      '    </div>' +
      '  </div>' +
      '  <div class="modal-actions xk-preflight-footer">' +
      '    <button type="button" data-xk-preflight-copy>Скопировать детали</button>' +
      '    <button type="button" class="btn-primary" data-xk-preflight-close>Закрыть</button>' +
      '  </div>' +
      '</div>';

    document.body.appendChild(modal);

    const content = modal.querySelector('.modal-content');
    const closeBtn = modal.querySelector('.modal-close');
    const okBtn = modal.querySelector('[data-xk-preflight-close]');
    const copyBtn = modal.querySelector('[data-xk-preflight-copy]');
    const codeTrigger = modal.querySelector('[data-xk-preflight-code-trigger]');
    if (copyBtn) copyBtn.dataset.defaultLabel = 'Скопировать детали';

    const close = () => {
      try {
        modal.classList.add('hidden');
      } catch (e) {}
      clearCopyState(copyBtn);
      if (_escHandler) {
        try {
          document.removeEventListener('keydown', _escHandler, true);
        } catch (e2) {}
        _escHandler = null;
      }
      try {
        if (window.XKeen && XKeen.ui && XKeen.ui.modal && typeof XKeen.ui.modal.syncBodyScrollLock === 'function') {
          XKeen.ui.modal.syncBodyScrollLock();
        } else {
          document.body.classList.remove('modal-open');
        }
      } catch (e3) {}
    };

    const open = () => {
      clearCopyState(copyBtn);
      try {
        modal.classList.remove('hidden');
      } catch (e) {}
      try {
        if (window.XKeen && XKeen.ui && XKeen.ui.modal && typeof XKeen.ui.modal.syncBodyScrollLock === 'function') {
          XKeen.ui.modal.syncBodyScrollLock();
        } else {
          document.body.classList.add('modal-open');
        }
      } catch (e2) {}
      _escHandler = (ev) => {
        if (ev && (ev.key === 'Escape' || ev.key === 'Esc')) close();
      };
      try {
        document.addEventListener('keydown', _escHandler, true);
      } catch (e3) {}
      try {
        requestAnimationFrame(() => {
          try {
            const body = modal.querySelector('.xk-preflight-body');
            if (body) body.scrollTop = 0;
          } catch (e4) {}
          try {
            okBtn.focus();
          } catch (e5) {}
        });
      } catch (e6) {
        setTimeout(() => {
          try {
            okBtn.focus();
          } catch (e7) {}
        }, 0);
      }
    };

    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      close();
    });
    okBtn.addEventListener('click', (e) => {
      e.preventDefault();
      close();
    });
    if (codeTrigger) {
      codeTrigger.addEventListener('click', (e) => {
        e.preventDefault();
        const expanded = String(codeTrigger.getAttribute('aria-expanded') || 'false') === 'true';
        const helpText = normText((modal.querySelector('[data-xk-preflight-code-help]') || {}).textContent || '');
        if (!helpText) return;
        const next = !expanded;
        codeTrigger.setAttribute('aria-expanded', next ? 'true' : 'false');
        setVisible(modal.querySelector('[data-xk-preflight-code-help-wrap]'), next);
      });
    }
    modal.addEventListener('click', (e) => {
      if (e.target === modal) close();
    });
    copyBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      const text = copyBtn.dataset.copyText || '';
      let copied = false;
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(text);
          copied = true;
        }
      } catch (err) {}
      if (!copied) {
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          copied = document.execCommand('copy');
          ta.remove();
        } catch (e2) {
          copied = false;
        }
      }
      clearCopyState(copyBtn);
      if (copied) {
        copyBtn.textContent = 'Скопировано';
        copyBtn.classList.add('is-success');
        if (typeof window.toast === 'function') window.toast('Детали ошибки скопированы.', 'info');
      } else {
        copyBtn.textContent = 'Не удалось скопировать';
        copyBtn.classList.add('is-error');
        if (typeof window.toast === 'function') window.toast('Не удалось скопировать детали ошибки.', true);
      }
      try {
        _copyResetTimer = setTimeout(() => clearCopyState(copyBtn), 1600);
      } catch (e3) {}
    });

    const codeEl = modal.querySelector('[data-xk-preflight-code]');
    const timeoutEl = modal.querySelector('[data-xk-preflight-timeout]');
    const locationEl = modal.querySelector('[data-xk-preflight-location]');

    _els = {
      modal,
      content,
      open,
      close,
      title: modal.querySelector('[data-xk-preflight-title]'),
      leadTitle: modal.querySelector('[data-xk-preflight-lead-title]'),
      icon: modal.querySelector('[data-xk-preflight-icon]'),
      mode: modal.querySelector('[data-xk-preflight-mode]'),
      description: modal.querySelector('[data-xk-preflight-description]'),
      summaryWrap: modal.querySelector('[data-xk-preflight-summary-wrap]'),
      summary: modal.querySelector('[data-xk-preflight-summary]'),
      hintWrap: modal.querySelector('[data-xk-preflight-hint-wrap]'),
      hint: modal.querySelector('[data-xk-preflight-hint]'),
      phase: modal.querySelector('[data-xk-preflight-phase]'),
      code: codeEl,
      codeTrigger,
      codeCard: codeEl ? codeEl.closest('.xk-preflight-meta-card') : null,
      codeHelpWrap: modal.querySelector('[data-xk-preflight-code-help-wrap]'),
      codeHelp: modal.querySelector('[data-xk-preflight-code-help]'),
      timeout: timeoutEl,
      timeoutCard: modal.querySelector('[data-xk-preflight-timeout-card]'),
      locationCard: modal.querySelector('[data-xk-preflight-location-card]'),
      location: locationEl,
      cmd: modal.querySelector('[data-xk-preflight-cmd]'),
      explainerWrap: modal.querySelector('[data-xk-preflight-explainer-wrap]'),
      explainer: modal.querySelector('[data-xk-preflight-explainer]'),
      stderr: modal.querySelector('[data-xk-preflight-stderr]'),
      stdoutWrap: modal.querySelector('[data-xk-preflight-stdout-wrap]'),
      stdout: modal.querySelector('[data-xk-preflight-stdout]'),
      copyBtn,
    };

    return _els;
  }

  function applyModeClass(modalEl, phase) {
    if (!modalEl || !modalEl.classList) return;
    modalEl.classList.remove('is-json');
    modalEl.classList.remove('is-xray');
    modalEl.classList.add(phase === 'json_parse' ? 'is-json' : 'is-xray');
  }

  XKeen.ui.showXrayPreflightError = function showXrayPreflightError(payload = {}) {
    const els = ensureModal();
    const stderr = normText(payload.stderr);
    const stdout = normText(payload.stdout);
    const hint = normText(payload.hint);
    const phase = normText(payload.phase || 'xray_test') || 'xray_test';
    const ui = resolvePresentation(payload);
    const cmd = normText(payload.cmd || ui.defaultCmd);
    const code = payload.returncode == null || payload.returncode === '' ? '—' : String(payload.returncode);
    const timeout = formatTimeout(payload);
    const errorText = normText(payload.error);
    const locationText = locationTextFromPayload(payload, {
      stderr,
      stdout,
      errorText,
    });
    const diagnosis = buildHumanDiagnosis(payload, {
      hint,
      locationText,
      stderr,
      stdout,
      errorText,
    });
    const summary = buildSummary(payload, stderr, stdout, errorText, hint, ui, diagnosis);
    const showSummary = !!summary && !isSameMessage(summary, ui.description);
    const showTimeout = !!timeout;
    const showStdout = !!stdout && !isSameMessage(stdout, stderr);
    const explanationItems = buildExplanationItems(payload, {
      summary,
      hint,
      locationText,
      stderr,
      stdout,
      errorText,
    });
    const showHint = shouldShowHint(hint, summary, ui.description, ui.defaultSummary) && explanationItems.length === 0;
    const codeHelp = diagnosis.codeHelp;

    applyModeClass(els.modal, phase);

    if (els.title) els.title.textContent = ui.title;
    if (els.leadTitle) els.leadTitle.textContent = ui.title;
    if (els.description) els.description.textContent = ui.description;
    if (els.mode) els.mode.textContent = ui.modeLabel;
    if (els.icon) els.icon.textContent = ui.iconText;

    if (els.summary) els.summary.textContent = summary;
    setVisible(els.summaryWrap, showSummary);

    if (els.hint) els.hint.textContent = hint;
    setVisible(els.hintWrap, showHint);

    if (els.phase) els.phase.textContent = formatPhase(phase);
    if (els.code) els.code.textContent = code;
    if (els.codeTrigger) {
      els.codeTrigger.title = codeHelp || 'Код возврата Xray';
      els.codeTrigger.disabled = !codeHelp;
      els.codeTrigger.setAttribute('aria-expanded', 'false');
      els.codeTrigger.classList.toggle('is-helpful', !!codeHelp);
    }
    if (els.codeHelp) els.codeHelp.textContent = codeHelp || '';
    setVisible(els.codeHelpWrap, false);
    if (els.timeout) els.timeout.textContent = timeout || '—';
    setVisible(els.timeoutCard, showTimeout);
    if (els.location) els.location.textContent = locationText || '—';
    setVisible(els.locationCard, !!locationText);
    if (els.cmd) els.cmd.textContent = cmd;
    renderExplanationItems(els.explainer, explanationItems);
    setVisible(els.explainerWrap, explanationItems.length > 0);

    setProblemState(els.codeCard, code !== '—' && code !== '0');
    setProblemState(els.timeoutCard, !!payload.timed_out);

    if (els.stderr) {
      renderTerminalOutput(els.stderr, stderr, 'stderr пуст');
      setEmptyTerminalState(els.stderr, !stderr);
    }
    if (els.stdout) {
      renderTerminalOutput(els.stdout, stdout, 'stdout пуст');
      setEmptyTerminalState(els.stdout, !stdout);
    }
    setVisible(els.stdoutWrap, showStdout);

    const copyParts = [
      phase === 'json_parse' ? 'JSON parse error' : 'Xray preflight error',
      'phase: ' + phase,
      'returncode: ' + code,
      codeHelp ? 'returncode_help: ' + codeHelp : '',
      'timeout_s: ' + (payload.timeout_s == null || payload.timeout_s === '' ? '' : String(payload.timeout_s)),
      payload.timed_out ? 'timed_out: true' : '',
      locationText ? 'location: ' + locationText : '',
      'cmd: ' + cmd,
      hint ? 'hint: ' + hint : '',
      errorText ? 'error: ' + errorText : '',
      explanationItems.length ? '' : '',
      explanationItems.length ? 'explanation:' : '',
      explanationItems.length ? explanationItems.map((item) => '- ' + item.label + ': ' + item.text).join('\n') : '',
      '',
      'stderr:',
      stderr || '(empty)',
      showStdout ? '' : '',
      showStdout ? 'stdout:' : '',
      showStdout ? stdout : '',
    ].filter(Boolean).join('\n');
    if (els.copyBtn) els.copyBtn.dataset.copyText = copyParts;

    els.open();
    try {
      requestAnimationFrame(() => {
        const preferredDiagnosticText = diagnosis.primaryLine || diagnosis.rootCause || summary;
        scrollTerminalToDiagnostic(els.stderr, preferredDiagnosticText);
        scrollTerminalToDiagnostic(els.stdout, preferredDiagnosticText);
      });
    } catch (e) {}
  };
})();
