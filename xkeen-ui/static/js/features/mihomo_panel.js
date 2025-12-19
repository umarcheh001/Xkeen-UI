(() => {
  'use strict';

  // Mihomo panel (editor + templates + validate + profiles/backups) extracted from main.js.
  // Public API:
  //   XKeen.features.mihomoPanel.init()
  //   XKeen.features.mihomoPanel.loadConfig/saveConfig
  //   XKeen.features.mihomoPanel.validateFromEditor/saveAndRestart
  //   XKeen.features.mihomoPanel.loadProfiles/loadBackups/cleanBackups

  window.XKeen = window.XKeen || {};
  XKeen.state = XKeen.state || {};
  XKeen.features = XKeen.features || {};

  const MP = (XKeen.features.mihomoPanel = XKeen.features.mihomoPanel || {});

  const IDS = {
    view: 'view-mihomo',
    textarea: 'mihomo-editor',
    status: 'mihomo-status',
    body: 'mihomo-body',
    arrow: 'mihomo-arrow',

    btnLoad: 'mihomo-load-btn',
    btnSave: 'mihomo-save-btn',
    btnValidate: 'mihomo-validate-btn',
    btnSaveRestart: 'mihomo-save-restart-btn',

    // Templates
    tplSelect: 'mihomo-template-select',
    tplRefresh: 'mihomo-templates-refresh-btn',
    tplLoad: 'mihomo-template-load-btn',
    tplSaveFromEditor: 'mihomo-template-savefromeditor-btn',

    // Profiles/backups panel
    profilesHeader: 'mihomo-profiles-link',
    profilesPanel: 'mihomo-profiles-panel',
    profilesArrow: 'mihomo-profiles-arrow',
    profilesRefresh: 'mihomo-refresh-profiles-btn',
    profilesList: 'mihomo-profiles-list',
    newProfileName: 'mihomo-new-profile-name',
    saveProfileBtn: 'mihomo-save-profile-btn',

    backupsRefresh: 'mihomo-refresh-backups-btn',
    backupsList: 'mihomo-backups-list',
    backupsActiveOnly: 'mihomo-backups-active-only',
    backupsActiveProfileLabel: 'mihomo-backups-active-profile-label',
    backupsCleanLimit: 'mihomo-backups-clean-limit',
    backupsCleanBtn: 'mihomo-backups-clean-btn',

    // Validation modal
    validationModal: 'mihomo-validation-modal',
    validationBody: 'mihomo-validation-modal-body',
  };

  let _inited = false;
  let _cm = null;
  let _templates = [];
  let _templatesLoaded = false;
  let _chosenTemplateName = null;
  let _activeProfileName = null;

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(s) {
    try {
      if (window.XKeen && XKeen.util && typeof XKeen.util.escapeHtml === 'function') {
        return XKeen.util.escapeHtml(s);
      }
    } catch (e) {}
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function setStatus(msg, isError, noToast) {
    const el = $(IDS.status);
    if (el) el.textContent = String(msg ?? '');
    if (noToast) return;
    try {
      if (msg) toast(String(msg), !!isError);
    } catch (e) {}
  }

  // Back-compat: old code calls setMihomoStatus/getMihomoEditorText/setMihomoEditorText.
  window.setMihomoStatus = window.setMihomoStatus || ((m, err) => setStatus(m, err));

  function cmThemeFromPage() {
    const t = document.documentElement.getAttribute('data-theme');
    return t === 'light' ? 'default' : 'material-darker';
  }

  function ensureEditor() {
    const ta = $(IDS.textarea);
    if (!ta || !window.CodeMirror) return null;
    if (_cm) return _cm;
    if (XKeen.state.mihomoEditor) {
      _cm = XKeen.state.mihomoEditor;
      return _cm;
    }

    const extra = (typeof window.buildCmExtraKeysCommon === 'function') ? window.buildCmExtraKeysCommon() : {};
    _cm = CodeMirror.fromTextArea(ta, {
      mode: 'yaml',
      theme: cmThemeFromPage(),
      lineNumbers: true,
      styleActiveLine: true,
      showIndentGuides: true,
      matchBrackets: true,
      autoCloseBrackets: true,
      showTrailingSpace: true,
      highlightSelectionMatches: true,
      rulers: [{ column: 120 }],
      lineWrapping: true,
      foldGutter: true,
      gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter'],
      tabSize: 2,
      indentUnit: 2,
      indentWithTabs: false,
      extraKeys: Object.assign({}, extra, {
        'Ctrl-S': () => { MP.saveConfig(); },
        'Cmd-S': () => { MP.saveConfig(); },
        'Ctrl-F': 'findPersistent',
        'Cmd-F': 'findPersistent',
        'Ctrl-G': 'findNext',
        'Cmd-G': 'findNext',
        'Shift-Ctrl-G': 'findPrev',
        'Shift-Cmd-G': 'findPrev',
        'Ctrl-H': 'replace',
        'Shift-Ctrl-H': 'replaceAll',
      }),
      viewportMargin: Infinity,
    });

    try {
      _cm.getWrapperElement().classList.add('xkeen-cm');
    } catch (e) {}

    XKeen.state.mihomoEditor = _cm;

    try {
      if (typeof window.xkeenAttachCmToolbar === 'function') {
        // IMPORTANT:
        // xkeenAttachCmToolbar(cm) expects an items list.
        // If called without it, it creates an empty toolbar (no buttons),
        // which выглядит как "тулбар пропал".
        const items = (window && window.XKEEN_CM_TOOLBAR_DEFAULT)
          ? window.XKEEN_CM_TOOLBAR_DEFAULT
          : ((window && window.XKEEN_CM_TOOLBAR_MINI) ? window.XKEEN_CM_TOOLBAR_MINI : null);
        window.xkeenAttachCmToolbar(_cm, items);
      }
    } catch (e) {}

    return _cm;
  }

  function getEditorText() {
    const cm = _cm || XKeen.state.mihomoEditor;
    if (cm && cm.getValue) return cm.getValue();
    const ta = $(IDS.textarea);
    return ta ? ta.value : '';
  }

  function setEditorText(text) {
    const cm = _cm || XKeen.state.mihomoEditor;
    if (cm && cm.setValue) {
      cm.setValue(String(text ?? ''));
      return;
    }
    const ta = $(IDS.textarea);
    if (ta) ta.value = String(text ?? '');
  }

  window.getMihomoEditorText = window.getMihomoEditorText || getEditorText;
  window.setMihomoEditorText = window.setMihomoEditorText || setEditorText;

  function refreshEditorIfAny() {
    const cm = _cm || XKeen.state.mihomoEditor;
    try {
      if (cm && cm.refresh) cm.refresh();
    } catch (e) {}
  }

  // Card collapse (header onclick="toggleMihomoCard()" in template)
  function toggleMihomoCard() {
    const body = $(IDS.body);
    const arrow = $(IDS.arrow);
    if (!body || !arrow) return;
    const willOpen = (body.style.display === '' || body.style.display === 'none');
    body.style.display = willOpen ? 'block' : 'none';
    arrow.textContent = willOpen ? '▲' : '▼';
    if (willOpen) refreshEditorIfAny();
  }
  window.toggleMihomoCard = window.toggleMihomoCard || toggleMihomoCard;

  // ---------- Core actions ----------

  // opts:
  //   - notify: boolean, show toast notifications (default: true)
  //
  // UX note:
  //   We intentionally DO NOT toast the "loading..." phase to avoid noisy double-toasts
  //   on page refresh / navigation. The status line is enough.
  MP.loadConfig = async function loadConfig(opts) {
    const notify = (opts && Object.prototype.hasOwnProperty.call(opts, 'notify')) ? !!opts.notify : true;
    try {
      setStatus('Загрузка config.yaml...', false, true);
      const res = await fetch('/api/mihomo-config');
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setStatus((data && data.error) || 'Не удалось загрузить config.yaml.', true, !notify);
        return false;
      }
      const content = data.content || '';
      setEditorText(content);
      setStatus('config.yaml загружен (' + content.length + ' байт).', false, !notify);
      try {
        if (typeof window.updateLastActivity === 'function') {
          const fp = window.XKEEN_FILES && window.XKEEN_FILES.mihomo ? window.XKEEN_FILES.mihomo : '/opt/etc/mihomo/config.yaml';
          window.updateLastActivity('loaded', 'mihomo', fp);
        }
      } catch (e) {}
      return true;
    } catch (e) {
      console.error(e);
      setStatus('Ошибка загрузки config.yaml.', true, !notify);
      return false;
    }
  };

  MP.saveConfig = async function saveConfig() {
    const content = String(getEditorText() || '');
    if (!content.trim()) {
      setStatus('config.yaml пустой, сохранять нечего.', true);
      return false;
    }

    try {
      setStatus('Сохранение config.yaml...', false);
      const restart = (typeof window.shouldAutoRestartAfterSave === 'function') ? !!window.shouldAutoRestartAfterSave() : true;
      const res = await fetch('/api/mihomo-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, restart }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setStatus((data && data.error) || 'Ошибка сохранения config.yaml.', true);
        return false;
      }
      let msg = 'config.yaml сохранён.';
      setStatus(msg, false, !!(data && data.restarted));
      try {
        if (typeof window.updateLastActivity === 'function') {
          const fp = window.XKEEN_FILES && window.XKEEN_FILES.mihomo ? window.XKEEN_FILES.mihomo : '/opt/etc/mihomo/config.yaml';
          window.updateLastActivity('saved', 'mihomo', fp);
        }
      } catch (e) {}
      try {
        if (data.restarted && window.XKeen && XKeen.features && XKeen.features.restartLog && typeof XKeen.features.restartLog.load === 'function') {
          XKeen.features.restartLog.load();
        }
      } catch (e) {}
      return true;
    } catch (e) {
      console.error(e);
      setStatus('Ошибка сохранения config.yaml.', true);
      return false;
    }
  };

  MP.saveAndRestart = async function saveAndRestart() {
    const content = String(getEditorText() || '');
    if (!content.trim()) {
      setStatus('config.yaml пустой, сохранять нечего.', true);
      return false;
    }
    try {
      setStatus('Сохранение config.yaml и перезапуск mihomo...', false);
      const res = await fetch('/api/mihomo-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, restart: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setStatus((data && data.error) || 'Ошибка сохранения config.yaml.', true);
        return false;
      }
      let msg = 'config.yaml сохранён.';
      setStatus(msg, false, true);
      try {
        if (window.XKeen && XKeen.features && XKeen.features.restartLog && typeof XKeen.features.restartLog.load === 'function') {
          XKeen.features.restartLog.load();
        }
      } catch (e) {}
      return true;
    } catch (e) {
      console.error(e);
      setStatus('Ошибка сохранения config.yaml.', true);
      return false;
    }
  };

  // ---------- Validate modal ----------

  function formatValidationLogHtml(text) {
    if (!text) return '';
    const lines = String(text).replace(/\r\n/g, '\n').split('\n');
    return lines
      .map((line) => {
        const safe = escapeHtml(line);
        let cls = 'log-line';
        if (/fatal|panic/i.test(line)) cls += ' log-fatal';
        else if (/error|\berr\b|err\[/i.test(line)) cls += ' log-error';
        else if (/warn/i.test(line)) cls += ' log-warn';
        else if (/info/i.test(line)) cls += ' log-info';
        else if (/debug/i.test(line)) cls += ' log-debug';
        return '<div class="' + cls + '">' + (safe || '&nbsp;') + '</div>';
      })
      .join('');
  }

  function showValidationModal(text) {
    const modal = $(IDS.validationModal);
    const body = $(IDS.validationBody);
    if (!modal || !body) return;
    body.innerHTML = formatValidationLogHtml(String(text ?? ''));
    modal.classList.remove('hidden');
    try { document.body.classList.add('modal-open'); } catch (e) {}
  }

  function hideValidationModal() {
    const modal = $(IDS.validationModal);
    if (!modal) return;
    modal.classList.add('hidden');
    try { document.body.classList.remove('modal-open'); } catch (e) {}
  }

  // Template uses onclick="hideMihomoValidationModal()".
  window.hideMihomoValidationModal = window.hideMihomoValidationModal || hideValidationModal;

  MP.validateFromEditor = async function validateFromEditor() {
    const content = String(getEditorText() || '');
    if (!content.trim()) {
      setStatus('config.yaml пустой, проверять нечего.', true);
      return false;
    }
    setStatus('Проверяю конфиг через mihomo...', false);

    try {
      const res = await fetch('/api/mihomo/validate_raw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: content }),
      });
      const data = await res.json().catch(() => ({}));
      const log = (data && typeof data.log === 'string') ? data.log : '';
      if (log.trim()) showValidationModal(log);

      if (!res.ok) {
        setStatus('Ошибка проверки конфига: ' + (data && (data.error || res.status)), true);
        return false;
      }

      const firstLine = (log.split('\n').find((l) => l.trim()) || '').trim();
      if (data.ok) {
        setStatus(firstLine || 'mihomo сообщает, что конфиг валиден (exit code 0).', false);
        return true;
      }
      setStatus('В таком виде конфиг не будет работать: ' + (firstLine || 'ошибка проверки.'), true);
      return false;
    } catch (e) {
      console.error(e);
      setStatus('Ошибка сети при проверке конфига: ' + e, true);
      return false;
    }
  };

  // Back-compat globals used by old main.js handlers.
  window.validateMihomoConfigFromEditor = window.validateMihomoConfigFromEditor || (() => MP.validateFromEditor());
  window.saveMihomoAndRestart = window.saveMihomoAndRestart || (() => MP.saveAndRestart());

  // ---------- Templates (config.yaml snippets) ----------

  function bumpLastActivity(kind) {
    try {
      if (typeof window.updateLastActivity === 'function') {
        const fp = window.XKEEN_FILES && window.XKEEN_FILES.mihomo ? window.XKEEN_FILES.mihomo : '/opt/etc/mihomo/config.yaml';
        window.updateLastActivity(kind || 'info', 'mihomo', fp);
      }
    } catch (e) {}
  }

  function getSelectedTemplateName() {
    const sel = $(IDS.tplSelect);
    if (!sel) return null;
    const v = String(sel.value || '').trim();
    return v || null;
  }

  MP.loadTemplatesList = async function loadTemplatesList(opts) {
    try {
      const o = opts || {};
      const silent = !!o.silent;
      if (!silent) setStatus('Загрузка списка шаблонов...', false);

      const res = await fetch('/api/mihomo-templates');
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        if (!silent) setStatus((data && data.error) || 'Не удалось загрузить список шаблонов.', true);
        return false;
      }
      _templates = Array.isArray(data.templates) ? data.templates : [];
      _templatesLoaded = true;

      const sel = $(IDS.tplSelect);
      if (sel) {
        const current = sel.value;
        sel.innerHTML = '<option value="">— выбери шаблон —</option>';
        _templates.forEach((t) => {
          const name = String(t && t.name ? t.name : '').trim();
          if (!name) return;
          const opt = document.createElement('option');
          opt.value = name;
          opt.textContent = name;
          sel.appendChild(opt);
        });
        if (current) sel.value = current;
      }

      if (!silent) setStatus('Шаблоны загружены: ' + _templates.length, false);
      bumpLastActivity('loaded');
      return true;
    } catch (e) {
      console.error(e);
      setStatus('Ошибка загрузки списка шаблонов.', true);
      return false;
    }
  };

  MP.saveEditorAsTemplate = async function saveEditorAsTemplate() {
    const content = String(getEditorText() || '');
    if (!content.trim()) {
      setStatus('config.yaml пустой — нечего сохранять в шаблон.', true);
      return false;
    }

    const name = window.prompt('Имя шаблона (например: myprofile.yaml):', _chosenTemplateName || '');
    if (!name) {
      setStatus('Сохранение шаблона отменено.', false);
      return false;
    }

    try {
      setStatus('Сохраняю шаблон...', false);
      const res = await fetch('/api/mihomo-template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, content }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setStatus((data && data.error) || 'Не удалось сохранить шаблон.', true);
        return false;
      }
      _chosenTemplateName = name;
      setStatus('Шаблон сохранён: ' + name, false);
      bumpLastActivity('saved');
      // Refresh list but silently.
      try { await MP.loadTemplatesList({ silent: true }); } catch (e) {}
      return true;
    } catch (e) {
      console.error(e);
      setStatus('Ошибка сохранения шаблона.', true);
      return false;
    }
  };

  MP.loadSelectedTemplateToEditor = async function loadSelectedTemplateToEditor() {
    try {
      if (!_templatesLoaded) {
        await MP.loadTemplatesList({ silent: true });
      }

      const chosen = getSelectedTemplateName();
      if (!chosen) {
        // Convenience: allow choosing by number if select is empty
        if (_templates && _templates.length) {
          const msg = _templates
            .map((t, i) => `${i + 1}. ${t.name}`)
            .join('\n');
          const num = window.prompt('Выбери номер шаблона:\n' + msg);
          if (!num) {
            setStatus('Шаблон не выбран.', true);
            return false;
          }
          const idx = parseInt(num, 10) - 1;
          if (!Number.isFinite(idx) || idx < 0 || idx >= _templates.length) {
            setStatus('Некорректный номер шаблона.', true);
            return false;
          }
          const tpl = _templates[idx];
          const ok = window.confirm('Заменить содержимое редактора шаблоном ' + (tpl.name || 'template') + '?');
          if (!ok) {
            setStatus('Загрузка шаблона отменена.', false);
            return false;
          }
          _chosenTemplateName = tpl.name;
        } else {
          setStatus('Шаблон не выбран.', true);
          return false;
        }
      } else {
        _chosenTemplateName = chosen;
      }

      setStatus('Загрузка шаблона...', false);
      const res = await fetch('/api/mihomo-template?name=' + encodeURIComponent(_chosenTemplateName));
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setStatus((data && data.error) || 'Не удалось загрузить шаблон.', true);
        return false;
      }
      const content = data.content || '';
      setEditorText(content);
      setStatus('Шаблон ' + _chosenTemplateName + ' загружен в редактор. Не забудьте сохранить config.yaml.', false);
      bumpLastActivity('loaded');
      return true;
    } catch (e) {
      console.error(e);
      setStatus('Ошибка загрузки шаблона.', true);
      return false;
    }
  };

  // ---------- Profiles / backups ----------

  function updateBackupsFilterUI() {
    const label = $(IDS.backupsActiveProfileLabel);
    const checkbox = $(IDS.backupsActiveOnly);
    if (!label || !checkbox) return;
    if (_activeProfileName) {
      label.textContent = 'Активный профиль: ' + _activeProfileName;
      checkbox.disabled = false;
    } else {
      label.textContent = 'Активный профиль не выбран';
      checkbox.disabled = true;
    }
  }

  function getBackupsFilterProfile() {
    const checkbox = $(IDS.backupsActiveOnly);
    if (!checkbox || !checkbox.checked) return null;
    return _activeProfileName || null;
  }

  function formatBackupDate(value) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    try { return d.toLocaleString(); } catch (e) { return String(value); }
  }

  function parseBackupFilename(filename) {
    const m = filename && filename.match(/^(.+?)_(\d{8})_(\d{6})\.yaml$/);
    if (!m) return { profile: null, created: null };
    const base = m[1];
    const profile = base.endsWith('.yaml') ? base : base + '.yaml';
    let created = null;
    try {
      const year = Number(m[2].slice(0, 4));
      const month = Number(m[2].slice(4, 6)) - 1;
      const day = Number(m[2].slice(6, 8));
      const hours = Number(m[3].slice(0, 2));
      const minutes = Number(m[3].slice(2, 4));
      const seconds = Number(m[3].slice(4, 6));
      const d = new Date(year, month, day, hours, minutes, seconds);
      if (!Number.isNaN(d.getTime())) created = d;
    } catch (e) {
      created = null;
    }
    return { profile, created };
  }

  MP.loadProfiles = async function loadProfiles() {
    const tbody = $(IDS.profilesList);
    if (!tbody) return false;
    tbody.innerHTML = '<tr><td colspan="3">Загрузка...</td></tr>';
    try {
      const res = await fetch('/api/mihomo/profiles');
      const data = await res.json().catch(() => null);
      if (!Array.isArray(data)) {
        tbody.innerHTML = '<tr><td colspan="3">Ошибка загрузки профилей</td></tr>';
        return false;
      }
      tbody.innerHTML = '';
      _activeProfileName = null;
      data.forEach((p) => {
        const name = String(p && p.name ? p.name : '');
        const isActive = !!(p && p.is_active);
        if (isActive) _activeProfileName = name;
        const tr = document.createElement('tr');
        tr.dataset.name = name;
        tr.innerHTML = [
          '<td>' + escapeHtml(name) + '</td>',
          '<td>' + (isActive ? 'да' : '') + '</td>',
          '<td>' +
            '<button data-action="load" title="В редактор">📥</button> ' +
            '<button data-action="activate">✅ Активировать</button> ' +
            '<button data-action="delete">🗑️ Удалить</button>' +
          '</td>',
        ].join('');
        tbody.appendChild(tr);
      });
      updateBackupsFilterUI();
      return true;
    } catch (e) {
      console.error(e);
      tbody.innerHTML = '<tr><td colspan="3">Ошибка загрузки профилей</td></tr>';
      return false;
    }
  };

  MP.loadBackups = async function loadBackups() {
    const tbody = $(IDS.backupsList);
    if (!tbody) return false;
    tbody.innerHTML = '<tr><td colspan="4">Загрузка...</td></tr>';
    try {
      let url = '/api/mihomo/backups';
      const profile = getBackupsFilterProfile();
      if (profile) url += '?profile=' + encodeURIComponent(profile);
      const res = await fetch(url);
      const data = await res.json().catch(() => null);
      if (!Array.isArray(data)) {
        tbody.innerHTML = '<tr><td colspan="4">Ошибка загрузки бэкапов</td></tr>';
        return false;
      }

      tbody.innerHTML = '';
      data.forEach((b) => {
        const tr = document.createElement('tr');
        tr.dataset.filename = b.filename;

        const created = formatBackupDate(b.created_at);
        const isOwnProfile = !_activeProfileName || !b.profile || _activeProfileName === b.profile;
        const restoreAttrs = isOwnProfile
          ? ' title="Восстановить"'
          : ' disabled title="Восстановить: активный профиль (' + escapeHtml(_activeProfileName) +
            ') не совпадает с профилем бэкапа (' + escapeHtml(b.profile) + ')"';

        tr.innerHTML = [
          '<td>' +
            '<div class="backup-filename-marquee" title="' + escapeHtml(b.filename) + '">' +
              '<span class="backup-filename-marquee-inner">' + escapeHtml(b.filename) + '</span>' +
            '</div>' +
          '</td>',
          '<td>' + escapeHtml(b.profile || '') + '</td>',
          '<td>' + escapeHtml(created) + '</td>',
          '<td>' +
            '<button data-action="preview" title="В редактор">👁️</button> ' +
            '<button data-action="restore"' + restoreAttrs + '>⏪</button> ' +
            '<button data-action="delete" title="Удалить бэкап">🗑️</button>' +
          '</td>',
        ].join('');
        tbody.appendChild(tr);
      });

      return true;
    } catch (e) {
      console.error(e);
      tbody.innerHTML = '<tr><td colspan="4">Ошибка загрузки бэкапов</td></tr>';
      return false;
    }
  };

  MP.createProfileFromEditor = async function createProfileFromEditor() {
    const nameInput = $(IDS.newProfileName);
    const name = String((nameInput && nameInput.value) || '').trim();
    const cfg = String(getEditorText() || '').trim();
    if (!name || !cfg) {
      setStatus('Имя профиля и config.yaml не должны быть пустыми.', true);
      return false;
    }

    try {
      const res = await fetch('/api/mihomo/profiles/' + encodeURIComponent(name), {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: cfg,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        setStatus(data.error || 'Ошибка создания профиля.', true);
        return false;
      }
      setStatus('Профиль ' + name + ' создан.', false);
      await MP.loadProfiles();
      return true;
    } catch (e) {
      console.error(e);
      setStatus('Ошибка создания профиля.', true);
      return false;
    }
  };

  MP.cleanBackups = async function cleanBackups() {
    const limitInput = $(IDS.backupsCleanLimit);
    const raw = String((limitInput && limitInput.value) || '5');
    const limit = parseInt(raw, 10);
    if (Number.isNaN(limit) || limit < 0) {
      setStatus('Лимит должен быть целым числом ≥ 0.', true);
      return false;
    }

    const profile = getBackupsFilterProfile();
    const confirmText =
      'Очистить бэкапы' +
      (profile ? ' для профиля ' + profile : ' для всех профилей') +
      ', оставив не более ' + limit + ' шт.?';

    let ok = true;
    if (window.XKeen && XKeen.ui && typeof XKeen.ui.confirm === 'function') {
      ok = await XKeen.ui.confirm({
        title: 'Очистить бэкапы',
        message: confirmText,
        okText: 'Очистить',
        cancelText: 'Отменить',
        danger: true,
      });
    } else {
      ok = window.confirm(confirmText);
    }

    if (!ok) return false;

    try {
      const res = await fetch('/api/mihomo/backups/clean', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit, profile }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        setStatus(data.error || 'Ошибка очистки бэкапов.', true);
        return false;
      }
      const remaining = (data.remaining && data.remaining.length) || 0;
      let msg = 'Очистка бэкапов выполнена. Осталось ' + remaining + ' файлов.';
      if (profile) msg += ' Профиль: ' + profile + '.';
      setStatus(msg, false);
      await MP.loadBackups();
      return true;
    } catch (e) {
      console.error(e);
      setStatus('Ошибка очистки бэкапов.', true);
      return false;
    }
  };

  function attachProfilesHandlers() {
    const tbody = $(IDS.profilesList);
    if (!tbody) return;
    if (tbody.dataset && tbody.dataset.xkeenBound === '1') return;
    tbody.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const tr = btn.closest('tr');
      const name = tr && tr.dataset.name;
      const action = btn.dataset.action;
      if (!name || !action) return;

      if (action === 'load') {
        try {
          const res = await fetch('/api/mihomo/profiles/' + encodeURIComponent(name));
          const text = await res.text();
          if (!res.ok) {
            setStatus('Ошибка загрузки профиля ' + name, true);
            return;
          }
          setEditorText(text);
          setStatus('Профиль ' + name + ' загружен в редактор.', false);
          refreshEditorIfAny();
        } catch (err) {
          console.error(err);
          setStatus('Ошибка загрузки профиля.', true);
        }
        return;
      }

      if (action === 'activate') {
        try {
          const res = await fetch('/api/mihomo/profiles/' + encodeURIComponent(name) + '/activate', { method: 'POST' });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.error) {
            setStatus(data.error || 'Ошибка активации профиля.', true);
            return;
          }
          let msg = 'Профиль ' + name + ' активирован.';
          setStatus(msg, false, !!(data && data.restarted));
          await MP.loadProfiles();
          if (data.restarted) {
            try { if (window.loadRestartLog) window.loadRestartLog(); } catch (e) {}
          }
        } catch (err) {
          console.error(err);
          setStatus('Ошибка активации профиля.', true);
        }
        return;
      }

      if (action === 'delete') {
        let ok = true;
        if (window.XKeen && XKeen.ui && typeof XKeen.ui.confirm === 'function') {
          ok = await XKeen.ui.confirm({
            title: 'Удалить профиль',
            message: 'Удалить профиль ' + name + '?',
            okText: 'Удалить',
            cancelText: 'Отменить',
            danger: true,
          });
        } else {
          ok = window.confirm('Удалить профиль ' + name + '?');
        }
        if (!ok) return;

        try {
          const res = await fetch('/api/mihomo/profiles/' + encodeURIComponent(name), { method: 'DELETE' });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.error) {
            setStatus(data.error || 'Ошибка удаления профиля.', true);
            return;
          }
          setStatus('Профиль ' + name + ' удалён.', false);
          await MP.loadProfiles();
        } catch (err) {
          console.error(err);
          setStatus('Ошибка удаления профиля.', true);
        }
      }
    });
    if (tbody.dataset) tbody.dataset.xkeenBound = '1';
  }

  function attachBackupsHandlers() {
    const tbody = $(IDS.backupsList);
    if (!tbody) return;
    if (tbody.dataset && tbody.dataset.xkeenBound === '1') return;
    tbody.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn || btn.disabled) return;
      const tr = btn.closest('tr');
      const filename = tr && tr.dataset.filename;
      const action = btn.dataset.action;
      if (!filename || !action) return;

      if (action === 'preview') {
        try {
          const res = await fetch('/api/mihomo/backups/' + encodeURIComponent(filename));
          const text = await res.text();
          if (!res.ok) {
            setStatus('Ошибка загрузки бэкапа ' + filename, true);
            return;
          }
          setEditorText(text);
          const info = parseBackupFilename(filename);
          let msg = 'Бэкап';
          if (info.profile) msg += ' профиля ' + info.profile;
          else msg += ' ' + filename;
          if (info.created instanceof Date && !Number.isNaN(info.created.getTime())) {
            try { msg += ' от ' + info.created.toLocaleString(); } catch (e) {}
          }
          msg += ' загружен в редактор (не применён).';
          setStatus(msg, false);
          refreshEditorIfAny();
        } catch (err) {
          console.error(err);
          setStatus('Ошибка загрузки бэкапа.', true);
        }
        return;
      }

      if (action === 'restore') {
        let ok = true;
        if (window.XKeen && XKeen.ui && typeof XKeen.ui.confirm === 'function') {
          ok = await XKeen.ui.confirm({
            title: 'Восстановить бэкап',
            message: 'Восстановить конфиг из бэкапа ' + filename + '?',
            okText: 'Восстановить',
            cancelText: 'Отменить',
            danger: true,
          });
        } else {
          ok = window.confirm('Восстановить конфиг из бэкапа ' + filename + '?');
        }
        if (!ok) return;
        try {
          const res = await fetch('/api/mihomo/backups/' + encodeURIComponent(filename) + '/restore', { method: 'POST' });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.error) {
            setStatus(data.error || 'Ошибка восстановления бэкапа.', true);
            return;
          }
          let msg = 'Бэкап ' + filename + ' восстановлен.';
          if (!data.restarted) msg += ' Загрузите config.yaml ещё раз.';
          setStatus(msg, false, !!(data && data.restarted));
          try { if (data.restarted && window.loadRestartLog) window.loadRestartLog(); } catch (e) {}
        } catch (err) {
          console.error(err);
          setStatus('Ошибка восстановления бэкапа.', true);
        }
        return;
      }

      if (action === 'delete') {
        let ok = true;
        if (window.XKeen && XKeen.ui && typeof XKeen.ui.confirm === 'function') {
          ok = await XKeen.ui.confirm({
            title: 'Удалить бэкап',
            message: 'Удалить бэкап ' + filename + '? Это действие необратимо.',
            okText: 'Удалить',
            cancelText: 'Отменить',
            danger: true,
          });
        } else {
          ok = window.confirm('Удалить бэкап ' + filename + '? Это действие необратимо.');
        }
        if (!ok) return;
        try {
          const res = await fetch('/api/mihomo/backups/' + encodeURIComponent(filename), { method: 'DELETE' });
          const data = await res.json().catch(() => null);
          if (!res.ok || (data && data.error)) {
            setStatus((data && data.error) || 'Ошибка удаления бэкапа.', true);
            return;
          }
          setStatus('Бэкап ' + filename + ' удалён.', false);
          await MP.loadBackups();
        } catch (err) {
          console.error(err);
          setStatus('Ошибка удаления бэкапа.', true);
        }
      }
    });
    if (tbody.dataset) tbody.dataset.xkeenBound = '1';
  }

  // ---------- Init / wiring ----------

  function wireButton(btnId, handler) {
    const btn = $(btnId);
    if (!btn) return;
    if (btn.dataset && btn.dataset.xkeenWired === '1') return;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      handler();
    });
    if (btn.dataset) btn.dataset.xkeenWired = '1';
  }

  MP.init = function init() {
    const root = $(IDS.view) || document.body;
    const ta = $(IDS.textarea);
    if (!ta) return; // not on this page

    if (_inited || (root.dataset && root.dataset.xkeenMihomoPanelInited === '1')) return;
    _inited = true;
    if (root.dataset) root.dataset.xkeenMihomoPanelInited = '1';

    ensureEditor();

    // Main actions
    wireButton(IDS.btnLoad, () => MP.loadConfig());
    wireButton(IDS.btnSave, () => MP.saveConfig());
    wireButton(IDS.btnValidate, () => MP.validateFromEditor());
    wireButton(IDS.btnSaveRestart, () => MP.saveAndRestart());

    // Templates
    wireButton(IDS.tplRefresh, () => MP.loadTemplatesList());
    wireButton(IDS.tplLoad, () => MP.loadSelectedTemplateToEditor());
    wireButton(IDS.tplSaveFromEditor, () => MP.saveEditorAsTemplate());

    // Profiles panel toggler
    const header = $(IDS.profilesHeader);
    const panel = $(IDS.profilesPanel);
    const arrow = $(IDS.profilesArrow);
    if (header && panel && (!header.dataset || header.dataset.xkeenWired !== '1')) {
      header.addEventListener('click', async (e) => {
        e.preventDefault();
        const visible = panel.style.display !== 'none';
        panel.style.display = visible ? 'none' : 'block';
        if (arrow) arrow.textContent = visible ? '▼' : '▲';
        if (!visible) {
          await MP.loadProfiles();
          await MP.loadBackups();
        }
      });
      if (header.dataset) header.dataset.xkeenWired = '1';
    }

    wireButton(IDS.profilesRefresh, async () => {
      setStatus('Обновляю список профилей…', false);
      const ok = await MP.loadProfiles();
      setStatus(ok ? 'Список профилей обновлён.' : 'Ошибка загрузки профилей.', !ok);
    });

    wireButton(IDS.backupsRefresh, async () => {
      setStatus('Обновляю список бэкапов…', false);
      const ok = await MP.loadBackups();
      setStatus(ok ? 'Список бэкапов обновлён.' : 'Ошибка загрузки бэкапов.', !ok);
    });

    wireButton(IDS.saveProfileBtn, () => MP.createProfileFromEditor());
    wireButton(IDS.backupsCleanBtn, () => MP.cleanBackups());

    const filter = $(IDS.backupsActiveOnly);
    if (filter && (!filter.dataset || filter.dataset.xkeenWired !== '1')) {
      filter.addEventListener('change', () => {
        MP.loadBackups();
      });
      if (filter.dataset) filter.dataset.xkeenWired = '1';
    }

    attachProfilesHandlers();
    attachBackupsHandlers();
    // Initial loads (silent to avoid noisy toasts on every page refresh)
    try { MP.loadConfig({ notify: false }); } catch (e) {}
    try { MP.loadTemplatesList({ silent: true }); } catch (e) {}
  };
})();
