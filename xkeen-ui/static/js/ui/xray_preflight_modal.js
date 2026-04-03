(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XKeen = window.XKeen;
  XKeen.ui = XKeen.ui || {};

  const SUMMARY_LINE_RE = /\b(failed|error|invalid|unexpected|panic|unable|cannot|unknown|duplicate|missing|malformed|timeout|timed out|not found)\b/i;
  const NOISE_LINE_RE = /^(using confdir from arg:|xray \d+\.\d+\.\d+|a unified platform|reading config:|appended inbound|appended outbound|appended routing|configuration ok)$/i;

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

  function locationTextFromPayload(payload) {
    if (!payload || !payload.location) return '';
    const loc = payload.location || {};
    const line = Number(loc.line);
    const col = Number(loc.column || loc.col);
    if (Number.isFinite(line) && Number.isFinite(col)) {
      return 'Строка ' + line + ', столбец ' + col;
    }
    if (Number.isFinite(line)) {
      return 'Строка ' + line;
    }
    return '';
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

  function buildSummary(payload, stderr, stdout, errorText, hint, ui) {
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
      '          <div class="xk-preflight-block-title">Ошибка</div>' +
      '          <div data-xk-preflight-summary></div>' +
      '        </div>' +
      '        <div class="xk-preflight-block xk-preflight-block--hint" data-xk-preflight-hint-wrap style="display:none;">' +
      '          <div class="xk-preflight-block-title">Что проверить</div>' +
      '          <div data-xk-preflight-hint></div>' +
      '        </div>' +
      '        <div class="xk-preflight-meta-grid">' +
      '          <div class="xk-preflight-meta-card"><div class="xk-preflight-meta-label">Фаза</div><div class="xk-preflight-meta-value" data-xk-preflight-phase></div></div>' +
      '          <div class="xk-preflight-meta-card"><div class="xk-preflight-meta-label">Код</div><div class="xk-preflight-meta-value" data-xk-preflight-code>—</div></div>' +
      '          <div class="xk-preflight-meta-card" data-xk-preflight-timeout-card style="display:none;"><div class="xk-preflight-meta-label">Таймаут</div><div class="xk-preflight-meta-value" data-xk-preflight-timeout>—</div></div>' +
      '          <div class="xk-preflight-meta-card" data-xk-preflight-location-card style="display:none;"><div class="xk-preflight-meta-label">Позиция</div><div class="xk-preflight-meta-value" data-xk-preflight-location>—</div></div>' +
      '        </div>' +
      '        <div class="xk-preflight-block">' +
      '          <div class="xk-preflight-block-title">Команда</div>' +
      '          <pre data-xk-preflight-cmd class="xk-preflight-codebox"></pre>' +
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
      codeCard: codeEl ? codeEl.closest('.xk-preflight-meta-card') : null,
      timeout: timeoutEl,
      timeoutCard: modal.querySelector('[data-xk-preflight-timeout-card]'),
      locationCard: modal.querySelector('[data-xk-preflight-location-card]'),
      location: locationEl,
      cmd: modal.querySelector('[data-xk-preflight-cmd]'),
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
    const locationText = locationTextFromPayload(payload);
    const summary = buildSummary(payload, stderr, stdout, errorText, hint, ui);
    const showSummary = !!summary && !isSameMessage(summary, ui.description);
    const showHint = shouldShowHint(hint, summary, ui.description, ui.defaultSummary);
    const showTimeout = !!timeout;
    const showStdout = !!stdout && !isSameMessage(stdout, stderr);

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
    if (els.timeout) els.timeout.textContent = timeout || '—';
    setVisible(els.timeoutCard, showTimeout);
    if (els.location) els.location.textContent = locationText || '—';
    setVisible(els.locationCard, !!locationText);
    if (els.cmd) els.cmd.textContent = cmd;

    setProblemState(els.codeCard, code !== '—' && code !== '0');
    setProblemState(els.timeoutCard, !!payload.timed_out);

    if (els.stderr) {
      els.stderr.textContent = stderr || 'stderr пуст';
      setEmptyTerminalState(els.stderr, !stderr);
    }
    if (els.stdout) {
      els.stdout.textContent = stdout || 'stdout пуст';
      setEmptyTerminalState(els.stdout, !stdout);
    }
    setVisible(els.stdoutWrap, showStdout);

    const copyParts = [
      phase === 'json_parse' ? 'JSON parse error' : 'Xray preflight error',
      'phase: ' + phase,
      'returncode: ' + code,
      'timeout_s: ' + (payload.timeout_s == null || payload.timeout_s === '' ? '' : String(payload.timeout_s)),
      payload.timed_out ? 'timed_out: true' : '',
      locationText ? 'location: ' + locationText : '',
      'cmd: ' + cmd,
      hint ? 'hint: ' + hint : '',
      errorText ? 'error: ' + errorText : '',
      '',
      'stderr:',
      stderr || '(empty)',
      showStdout ? '' : '',
      showStdout ? 'stdout:' : '',
      showStdout ? stdout : '',
    ].filter(Boolean).join('\n');
    if (els.copyBtn) els.copyBtn.dataset.copyText = copyParts;

    els.open();
  };
})();
