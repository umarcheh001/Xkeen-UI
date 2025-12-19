(() => {
  window.XKeen = window.XKeen || {};
  XKeen.features = XKeen.features || {};

  XKeen.features.mihomoGenerator = (() => {
    let inited = false;

    function init() {
      if (inited) return;
      inited = true;

      // The generator UI exists only on mihomo_generator.html
      if (!document.getElementById('profileSelect')) return;

        // ---- constants ----
        const RULE_GROUP_PRESETS = [
          // Контентные сервисы
          { id: "YouTube",      label: "YouTube / видео" },
          { id: "Discord",      label: "Discord" },
          { id: "Twitch",       label: "Twitch" },
          { id: "Reddit",       label: "Reddit" },
          { id: "Spotify",      label: "Spotify" },
          { id: "Steam",        label: "Steam / игры" },
          { id: "Telegram",     label: "Telegram" },
      
          // Крупные сети / CDN / облака
          { id: "Meta",         label: "Meta / Facebook" },
          { id: "Amazon",       label: "Amazon / AWS" },
          { id: "Cloudflare",   label: "Cloudflare" },
          { id: "Fastly",       label: "Fastly" },
          { id: "CDN77",        label: "CDN77" },
          { id: "Akamai",       label: "Akamai" },
      
          // Общие сервисы
          { id: "Google",       label: "Google" },
          { id: "GitHub",       label: "GitHub" },
          { id: "AI",           label: "AI сервисы" },
      
          // ZKeen: дополнительные GEOIP/GEOSITE пакеты
          { id: "DigitalOcean", label: "DigitalOcean" },
          { id: "Gcore",        label: "Gcore" },
          { id: "Hetzner",      label: "Hetzner" },
          { id: "Linode",       label: "Linode" },
          { id: "Oracle",       label: "Oracle Cloud" },
          { id: "Ovh",          label: "OVH" },
          { id: "Vultr",        label: "Vultr" },
          { id: "Colocrossing", label: "Colocrossing" },
          { id: "Contabo",      label: "Contabo" },
          { id: "Mega",         label: "Mega" },
          { id: "Scaleway",     label: "Scaleway" },
      
          // Специальная группа
          // QUIC и базовая группа блокировок всегда включены и не управляются из UI
        ];
      
      
        // Active list of rule IDs that should be shown for the current profile.
        // Filled from backend (/api/mihomo/profile_defaults).
        let availableRuleGroupIds = RULE_GROUP_PRESETS.map(p => p.id);
      
        // To avoid duplicating listeners on the "select all" checkbox when
        // re-rendering the list.
        let ruleGroupsSelectAllInited = false;
      
        const SKELETON = `#######################################################################################################
      # Описание:
      # Веб-интерфейс доступен по адресу http://192.168.1.1:9090/ui (вместо 192.168.1.1 может быть любой IP, где запущен данный конфиг). После добавления сервера и запуска mihomo необходимо зайти в веб-интерфейс и выбрать нужное подключение для прокси-групп
      # Группа "Заблок. сервисы" содержит список доменов большинства заблокированных ресурсов (как снаружи, так и внутри)
      # Остальные группы YouTube/Discord и тд имеют приоритет над группой "Заблок. сервисы". Eсли переопределение не нужно, можно выбрать "Заблок. сервисы" в качестве подключения и управлять всеми группами разом в группе "Заблок. сервисы"
      #######################################################################################################
      # Для работы Discord требуется проксировать порты XKeen: 80,443,2000:2300,8443,19200:19400,50000:50030
      # Для работы Whatsapp/Telegram требуется проксировать порты Xkeen: 80,443,596:599,1400,3478,5222
      #######################################################################################################
      
      log-level: silent
      allow-lan: true
      redir-port: 5000
      tproxy-port: 5001
      ipv6: true
      mode: rule
      external-controller: 0.0.0.0:9090
      external-ui: zashboard
      external-ui-url: https://github.com/Zephyruso/zashboard/releases/latest/download/dist.zip
      profile: { store-selected: true }
      
      sniffer:
        enable: true
        sniff:
          HTTP:
          TLS:
          QUIC:
      
      anchors:
        a1: &domain { type: http, format: mrs, behavior: domain, interval: 86400 }
        a2: &ipcidr { type: http, format: mrs, behavior: ipcidr, interval: 86400 }
        a3: &classical { type: http, format: text, behavior: classical, interval: 86400 }
        a4: &inline { type: inline, behavior: classical }
      
      #############################################################################################
      # Пример VLESS подключения БЕЗ использования подписки #
      #############################################################################################
      
      
      ######################################################################################
      # Подключение С использованием подписки #
      ######################################################################################
      
      
      proxy-groups:
        - name: Заблок. сервисы
          type: select
          icon: https://cdn.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Reject.png
          include-all: true
      
        - name: QUIC
          type: select
          icon: https://github.com/zxc-rv/assets/raw/refs/heads/main/group-icons/quic.png
          proxies: [REJECT, PASS]
      
        - MATCH,DIRECT
      `;
      
      
        // ---- DOM refs ----
        const profileSelect = document.getElementById("profileSelect");
        const defaultGroupsInput = document.getElementById("defaultGroupsInput");
        const subscriptionsList = document.getElementById("subscriptionsList");
        const addSubscriptionBtn = document.getElementById("addSubscriptionBtn");
        const ruleGroupsList = document.getElementById("ruleGroupsList");
        const ruleGroupsSelectAll = document.getElementById("ruleGroupsSelectAll");
        const proxiesList = document.getElementById("proxiesList");
        const addProxyBtn = document.getElementById("addProxyBtn");
        const generateBtn = document.getElementById("generateBtn");
        const saveBtn = document.getElementById("saveBtn");
        const validateBtn = document.getElementById("validateBtn");
        const applyBtn = document.getElementById("applyBtn");
        const editToggle = document.getElementById("editToggle");
        const copyBtn = document.getElementById("copyBtn");
        const statusMessage = document.getElementById("statusMessage");
        const previewTextarea = document.getElementById("previewTextarea");
        const validationLogEl = document.getElementById("validationLog");
        const clearValidationLogBtn = document.getElementById("clearValidationLogBtn");
      
       
        let validationLogRaw = "";
      
        function escapeHtml(str) {
          if (!str) return "";
          return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
        }
      
        function formatLogHtml(text) {
          if (!text) return "";
          const lines = String(text).replace(/\r\n/g, "\n").split("\n");
          return lines.map((line) => {
            const safe = escapeHtml(line);
            let cls = "log-line";
            if (/fatal|panic/i.test(line)) cls += " log-fatal";
            else if (/error|\berr\b|err\[/i.test(line)) cls += " log-error";
            else if (/warn/i.test(line)) cls += " log-warn";
            else if (/info/i.test(line)) cls += " log-info";
            else if (/debug/i.test(line)) cls += " log-debug";
            return '<div class="' + cls + '">' + (safe || "&nbsp;") + "</div>";
          }).join("");
        }
      
        let editor = null;

        function moveToolbarToHeader() {
          try {
            const host = document.getElementById('previewToolbarHost');
            if (host && editor && editor._xkeenToolbarEl) {
              host.appendChild(editor._xkeenToolbarEl);
            }
          } catch (e) {
            // ignore
          }
        }

        function resetToolbar() {
          if (!editor) return;
          try {
            if (editor._xkeenToolbarEl && editor._xkeenToolbarEl.parentNode) {
              editor._xkeenToolbarEl.parentNode.removeChild(editor._xkeenToolbarEl);
            }
          } catch (e) {}
          try { delete editor._xkeenToolbarEl; } catch (e) { editor._xkeenToolbarEl = null; }
        }

        function syncToolbarForEditable(isEditable) {
          try {
            if (!editor || !window || typeof window.xkeenAttachCmToolbar !== 'function') return;
            resetToolbar();
            const items = (isEditable)
              ? (window.XKEEN_CM_TOOLBAR_DEFAULT || null)
              : (window.XKEEN_CM_TOOLBAR_MINI || window.XKEEN_CM_TOOLBAR_DEFAULT || null);
            window.xkeenAttachCmToolbar(editor, items);
            moveToolbarToHeader();
          } catch (e) {
            // ignore
          }
        }
      
        // ---- auto-preview helpers ----
        let previewTimeout = null;
      
        function schedulePreview(delay = 300) {
          if (!editor) return;
          clearTimeout(previewTimeout);
          previewTimeout = setTimeout(() => {
            generatePreviewDemo(false);
          }, delay);
        }
      
        /**
         * Вешает автопредпросмотр на элемент.
         * @param {HTMLElement|null} el - элемент
         * @param {string[]} events - список событий, по умолчанию ["change", "blur"]
         * @param {number} delay - задержка перед запросом в мс
         */
        function autoPreviewOnChange(el, events = ["change", "blur"], delay = 300) {
          if (!el) return;
          const handler = () => schedulePreview(delay);
          events.forEach(ev => el.addEventListener(ev, handler));
        }
      
        // Обновление сводки состояния над предпросмотром
        function updateStateSummary(state) {
          const el = document.getElementById("stateSummary");
          if (!el) return;
          const profile = state.profile || "router_custom";
          const subs = (state.subscriptions || []).length;
          const proxies = (state.proxies || []).length;
          const enabledRuleGroups = state.enabledRuleGroups || [];
          const rgCount = enabledRuleGroups.length || 0;
          el.textContent =
            "Профиль: " + profile +
            " · Rule-групп: " + rgCount +
            " · Подписок: " + subs +
            " · Прокси: " + proxies;
        }
      
        // Мини-валидация состояния перед предпросмотром / применением
        function validateState(state, mode) {
          const warnings = [];
          const errors = [];
          const subs = state.subscriptions || [];
          const proxies = state.proxies || [];
          const defaultGroups = state.defaultGroups || [];
      
          // Нет ни одного источника прокси
          if (!subs.length && !proxies.length) {
            if (mode === "apply") {
              errors.push("Нет ни одной подписки и ни одного узла-прокси – применять такой конфиг опасно.");
            } else {
              warnings.push("Нет ни одной подписки и ни одного узла-прокси – конфиг будет без прокси.");
            }
          }
      
          // Профиль app – просто предупреждение
          if (state.profile === "app") {
            warnings.push("Профиль «app»: прозрачная маршрутизация роутера отключена, конфиг работает как обычный клиент.");
          }
      
          // Неизвестные группы по умолчанию
          if (defaultGroups.length) {
            const knownIds = new Set(RULE_GROUP_PRESETS.map(p => p.id));
            const builtins = new Set(["Proxy-Selector", "Auto-VPN", "Global-Default"]);
            const unknown = defaultGroups.filter(g => !knownIds.has(g) && !builtins.has(g));
            if (unknown.length) {
              warnings.push(
                "Неизвестные группы по умолчанию: " +
                unknown.join(", ") +
                ". Убедитесь, что такие proxy-groups существуют в шаблоне."
              );
            }
          }
      
          return { valid: errors.length === 0, warnings, errors };
        }
      
        // Автопредпросмотр для профиля / шаблона / списков групп
        autoPreviewOnChange(profileSelect, ["change"]);
      
        // При смене профиля подгружаем пресет групп/правил с бэкенда
        if (profileSelect) {
          profileSelect.addEventListener("change", () => {
            loadProfileDefaults(profileSelect.value);
          });
        }
          autoPreviewOnChange(defaultGroupsInput, ["input", "change", "blur"]);
      
        // Делегированный автопредпросмотр для карточек прокси
        if (proxiesList) {
          // input/select внутри карточек
          proxiesList.addEventListener("change", (e) => {
            const target = e.target;
            if (!(target instanceof HTMLElement)) return;
            if (target.matches("input, select")) {
              schedulePreview();
            }
          });
      
          // textarea (WG/yaml конфиги) — по input
          proxiesList.addEventListener("input", (e) => {
            const target = e.target;
            if (!(target instanceof HTMLElement)) return;
            if (target.matches("textarea")) {
              schedulePreview(400);
            }
          });
      
          // страхуемся на blur
          proxiesList.addEventListener(
            "blur",
            (e) => {
              const target = e.target;
              if (!(target instanceof HTMLElement)) return;
              if (target.matches("input, textarea, select")) {
                schedulePreview();
              }
            },
            true
          );
        }
      
      
        function setStatus(text, type) {
          statusMessage.textContent = text;
          statusMessage.classList.remove("ok", "err");
          if (type === "ok") statusMessage.classList.add("ok");
          if (type === "err") statusMessage.classList.add("err");
        }
        function setValidationLog(text) {
          if (!validationLogEl) return;
          validationLogRaw = text || "";
          validationLogEl.innerHTML = formatLogHtml(validationLogRaw);
          validationLogEl.scrollTop = validationLogEl.scrollHeight;
        }
      
        function appendValidationLog(text) {
          if (!validationLogEl) return;
          const extra = text || "";
          validationLogRaw = validationLogRaw
            ? validationLogRaw + "\n" + extra
            : extra;
          validationLogEl.innerHTML = formatLogHtml(validationLogRaw);
          validationLogEl.scrollTop = validationLogEl.scrollHeight;
        }
      
        function jumpToErrorPositionFromLog(log) {
          if (!editor || !log) return;
          // Ищем паттерны вида "line 12 column 5" или "at line 23, column 1"
          const re = /(line|строка)[^0-9]*(\d+)[^0-9]+(column|col|столбец)?[^0-9]*(\d+)?/i;
          const m = log.match(re);
          if (!m) return;
          const lineNum = parseInt(m[2], 10);
          const colNum = m[4] ? parseInt(m[4], 10) : 1;
          if (!Number.isFinite(lineNum) || lineNum <= 0) return;
          const line = lineNum - 1;
          const ch = colNum > 0 ? colNum - 1 : 0;
          try {
            editor.setCursor({ line, ch });
            editor.scrollIntoView({ line, ch }, 100);
            // кратко подчеркнём строку статусом
            setStatus("Ошибка около строки " + lineNum + ", столбец " + colNum + ".", "err");
          } catch (e) {
            console.warn("Failed to move cursor to error position", e);
          }
        }
      
      
        // ----- CodeMirror init -----
        function getCurrentCmTheme() {
          try {
            return (document.documentElement.getAttribute('data-theme') === 'light') ? 'default' : 'material-darker';
          } catch (e) {
            return 'material-darker';
          }
        }
      
        function initEditor() {
          if (editor) return;
          previewTextarea.value = SKELETON;
          editor = CodeMirror.fromTextArea(previewTextarea, {
            mode: "text/x-yaml",
            theme: getCurrentCmTheme(),
            lineNumbers: true,
            styleActiveLine: true,
            showIndentGuides: true,
            matchBrackets: true,
            autoCloseBrackets: true,
            highlightSelectionMatches: true,
            lineWrapping: true,
            foldGutter: true,
            gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter'],
            tabSize: 2,
            indentUnit: 2,
            indentWithTabs: false,
            viewportMargin: Infinity,
            extraKeys: Object.assign({}, (typeof buildCmExtraKeysCommon === 'function' ? buildCmExtraKeysCommon() : {}), {
              'Ctrl-F': 'findPersistent',
              'Cmd-F': 'findPersistent',
              'Ctrl-G': 'findNext',
              'Cmd-G': 'findNext',
              'Shift-Ctrl-G': 'findPrev',
              'Shift-Cmd-G': 'findPrev',
              'Ctrl-H': 'replace',
              'Shift-Ctrl-H': 'replaceAll'
            }),
            // Preview is read-only, но с курсором и поиском
            readOnly: true
          });
      
          // Mark as XKeen editor so shared CSS fixes apply in light theme
          try {
            const w = editor.getWrapperElement && editor.getWrapperElement();
            if (w) w.classList.add('xkeen-cm');
          } catch (e) {}
      
          // Register in global list so main.js theme toggle can sync it
          try {
            window.__xkeenEditors = window.__xkeenEditors || [];
            window.__xkeenEditors.push(editor);
          } catch (e) {}
      
          // Toolbar is always full; write-only actions (replace/comment) are
          // automatically disabled when editor is readOnly.
          try {
            if (window && typeof window.xkeenAttachCmToolbar === 'function') {
              window.xkeenAttachCmToolbar(editor, window.XKEEN_CM_TOOLBAR_DEFAULT || null);
              moveToolbarToHeader();
            }
          } catch (e) {
            // ignore
          }
      
          editor.setValue(SKELETON);
        }
      
        // React on theme changes (main.js dispatches xkeen-theme-change)
        document.addEventListener('xkeen-theme-change', (e) => {
          if (!editor) return;
          const cmTheme = (e && e.detail && e.detail.cmTheme) ? e.detail.cmTheme : getCurrentCmTheme();
          try {
            editor.setOption('theme', cmTheme);
            editor.refresh();
          } catch (err) {}
        });
      
        // ----- subscriptions -----
        function createSubscriptionRow(value) {
          const row = document.createElement("div");
          row.className = "subscription-row";
      
          const input = document.createElement("input");
          input.type = "text";
          input.placeholder = "https://example.com/sub";
          input.value = value || "";
      
          // Автопредпросмотр при изменении URL подписки
          autoPreviewOnChange(input, ["change", "blur", "input"], 400);
      
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "btn btn-ghost btn-xs";
          btn.textContent = "✕";
          btn.onclick = () => {
            subscriptionsList.removeChild(row);
            if (!subscriptionsList.children.length) {
              subscriptionsList.appendChild(createSubscriptionRow(""));
            }
            schedulePreview();
          };
      
          row.appendChild(input);
          row.appendChild(btn);
          return row;
        }
      
        function addInitialSubscriptionRow() {
          if (!subscriptionsList.children.length) {
            subscriptionsList.appendChild(createSubscriptionRow(""));
          }
        }
      
        // ----- rule groups -----
        function getAllRuleGroupCheckboxes() {
          return Array.from(document.querySelectorAll(".rule-group-checkbox"));
        }
      
        function setEnabledRuleGroupsInUI(ids) {
          const set = new Set(ids || []);
          getAllRuleGroupCheckboxes().forEach(cb => {
            cb.checked = set.has(cb.value);
          });
        }
      
        function getEnabledRuleGroupsFromUI() {
          return getAllRuleGroupCheckboxes()
            .filter(cb => cb.checked)
            .map(cb => cb.value);
        }
      
        function updateSelectAllCheckbox() {
          if (!ruleGroupsSelectAll) return;
          const checkboxes = getAllRuleGroupCheckboxes();
          if (!checkboxes.length) {
            ruleGroupsSelectAll.checked = false;
            ruleGroupsSelectAll.indeterminate = false;
            return;
          }
          const allChecked = checkboxes.every(cb => cb.checked);
          const anyChecked = checkboxes.some(cb => cb.checked);
          ruleGroupsSelectAll.checked = allChecked;
          ruleGroupsSelectAll.indeterminate = !allChecked && anyChecked;
        }
      
        
        async function loadProfileDefaults(profile) {
          const p = profile || (profileSelect && profileSelect.value) || "router_custom";
          try {
            const res = await fetch("/api/mihomo/profile_defaults?profile=" + encodeURIComponent(p));
            if (!res.ok) return;
            const data = await res.json();
            if (!data || data.ok === false) return;
      
            const enabled = Array.isArray(data.enabledRuleGroups)
              ? data.enabledRuleGroups
              : [];
      
            const availableFromBackend = Array.isArray(data.availableRuleGroups)
              ? data.availableRuleGroups
              : null;
      
            if (availableFromBackend && availableFromBackend.length) {
              availableRuleGroupIds = availableFromBackend;
            } else {
              // Fallback: if backend does not yet expose availableRuleGroups,
              // show all known presets so that the UI still works.
              availableRuleGroupIds = RULE_GROUP_PRESETS.map(preset => preset.id);
            }
      
            // Re-render the checkbox list for the current profile.
            renderRuleGroups();
            setEnabledRuleGroupsInUI(enabled);
            updateSelectAllCheckbox();
            // Авто-обновление предпросмотра при смене профиля / пресета групп
            schedulePreview();
          } catch (err) {
            console.error("Failed to load profile defaults", err);
          }
        }
      
        function renderRuleGroups() {
          if (!ruleGroupsList) return;
      
          // Сначала очищаем список, затем рисуем только релевантные этому профилю группы.
          ruleGroupsList.innerHTML = "";
      
          const allowed = Array.isArray(availableRuleGroupIds) && availableRuleGroupIds.length
            ? new Set(availableRuleGroupIds)
            : null;
      
          const presetsToRender = RULE_GROUP_PRESETS.filter(preset =>
            !allowed || allowed.has(preset.id)
          );
      
          presetsToRender.forEach(preset => {
            const label = document.createElement("label");
            label.className = "rule-group-item";
      
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.value = preset.id;
            cb.className = "rule-group-checkbox";
      
            const span = document.createElement("span");
            span.innerHTML = "<strong>" + preset.label + "</strong>";
      
            label.appendChild(cb);
            label.appendChild(span);
            ruleGroupsList.appendChild(label);
      
            cb.addEventListener("change", () => {
              updateSelectAllCheckbox();
              // Авто-обновление предпросмотра при переключении пакетов правил
              schedulePreview();
            });
          });
      
          // Обработчик "Отметить всё" вешаем один раз, он работает с текущим набором чекбоксов.
          if (ruleGroupsSelectAll && !ruleGroupsSelectAllInited) {
            ruleGroupsSelectAll.addEventListener("change", () => {
              const checked = ruleGroupsSelectAll.checked;
              getAllRuleGroupCheckboxes().forEach(cb => {
                cb.checked = checked;
              });
              updateSelectAllCheckbox();
              schedulePreview();
            });
            ruleGroupsSelectAllInited = true;
          }
        }
      
      // ----- proxies -----
        const proxyControllers = [];
      
        function createProxyCard(initial) {
          const idx = proxyControllers.length + 1;
          const wrapper = document.createElement("div");
          wrapper.className = "proxy-card";
      
          const header = document.createElement("div");
          header.className = "proxy-header";
      
          const title = document.createElement("div");
          title.className = "proxy-header-title";
          title.textContent = "Узел #" + idx;
      
          const typeBadge = document.createElement("span");
          typeBadge.className = "proxy-header-type";
          typeBadge.textContent = "Тип: vless";
      
          const actions = document.createElement("div");
      
          const delBtn = document.createElement("button");
          delBtn.type = "button";
          delBtn.className = "btn btn-danger btn-xs";
          delBtn.textContent = "Удалить";
          delBtn.onclick = () => {
            const pos = proxyControllers.indexOf(ctrl);
            if (pos >= 0) proxyControllers.splice(pos, 1);
            proxiesList.removeChild(wrapper);
            Array.from(proxiesList.children).forEach((card, i) => {
              const t = card.querySelector(".proxy-header-title");
              if (t) t.textContent = "Узел #" + (i + 1);
            });
          };
      
          actions.appendChild(delBtn);
          header.appendChild(title);
          header.appendChild(typeBadge);
          header.appendChild(actions);
      
          const body = document.createElement("div");
          body.className = "proxy-body";
      
          const typeWrap = document.createElement("div");
          const typeLabel = document.createElement("label");
          typeLabel.textContent = "Тип узла";
          const typeSelect = document.createElement("select");
          typeSelect.innerHTML = `
            <option value="vless">VLESS ссылка</option>
            <option value="wireguard">WireGuard конфиг</option>
            <option value="yaml">YAML блок proxy</option>
          `;
          typeWrap.appendChild(typeLabel);
          typeWrap.appendChild(typeSelect);
      
          const nameWrap = document.createElement("div");
          const nameLabel = document.createElement("label");
          nameLabel.textContent = "Имя узла";
          const nameInput = document.createElement("input");
          nameInput.type = "text";
          nameInput.placeholder = "My Node";
          nameWrap.appendChild(nameLabel);
          nameWrap.appendChild(nameInput);
      
          const groupsWrap = document.createElement("div");
          groupsWrap.className = "full";
          const groupsLabel = document.createElement("label");
          groupsLabel.textContent = "Группы (через запятую)";
          const groupsInput = document.createElement("input");
          groupsInput.type = "text";
          groupsInput.placeholder = "Заблок. сервисы,YouTube";
          groupsWrap.appendChild(groupsLabel);
          groupsWrap.appendChild(groupsInput);
      
          const dataWrap = document.createElement("div");
          dataWrap.className = "full";
          const dataLabel = document.createElement("label");
          dataLabel.textContent = "VLESS ссылка";
          const dataArea = document.createElement("textarea");
          dataArea.rows = 4;
          dataArea.placeholder = "vless://...";
          dataWrap.appendChild(dataLabel);
          dataWrap.appendChild(dataArea);
      
          body.appendChild(typeWrap);
          body.appendChild(nameWrap);
          body.appendChild(groupsWrap);
          body.appendChild(dataWrap);
      
          function updateTypeUI() {
            const t = typeSelect.value;
            if (t === "vless") {
              typeBadge.textContent = "Тип: vless";
              dataLabel.textContent = "VLESS ссылка";
              dataArea.placeholder = "vless://...";
              dataArea.rows = 4;
            } else if (t === "wireguard") {
              typeBadge.textContent = "Тип: wireguard";
              dataLabel.textContent = "WireGuard конфиг";
              dataArea.placeholder = "[Interface]\nAddress = ...";
              dataArea.rows = 6;
            } else {
              typeBadge.textContent = "Тип: yaml";
              dataLabel.textContent = "YAML блок proxy";
              dataArea.placeholder = "- name: MyNode\n  type: trojan\n  server: ...";
              dataArea.rows = 6;
            }
          }
          typeSelect.addEventListener("change", updateTypeUI);
          updateTypeUI();
      
          if (initial) {
            if (initial.kind) typeSelect.value = initial.kind;
            if (initial.name) nameInput.value = initial.name;
            if (initial.groups) groupsInput.value = initial.groups;
            if (initial.data) dataArea.value = initial.data;
            updateTypeUI();
          }
      
          wrapper.appendChild(header);
          wrapper.appendChild(body);
      
          const ctrl = {
            el: wrapper,
            getState: () => {
              const kind = typeSelect.value;
              const name = nameInput.value.trim();
              const groups = (groupsInput.value || "")
                .split(",")
                .map(s => s.trim())
                .filter(Boolean);
              const data = dataArea.value;
              if (!data.trim()) return null;
              const out = { kind };
              if (name) out.name = name;
              if (groups.length) out.groups = groups;
              if (kind === "vless") out.link = data.trim();
              else if (kind === "wireguard") out.config = data;
              else out.yaml = data;
              return out;
            },
          };
      
          proxiesList.appendChild(wrapper);
          proxyControllers.push(ctrl);
        }
      
        // ----- collect state -----
        function collectState() {
          const profile = profileSelect.value || "router_custom";
      
          const subscriptions = Array.from(
            subscriptionsList.querySelectorAll("input[type='text']")
          )
            .map(i => i.value.trim())
            .filter(Boolean);
      
          const defaultGroups = (defaultGroupsInput.value || "")
            .split(",")
            .map(s => s.trim())
            .filter(Boolean);
      
          const enabledRuleGroups = Array.from(
            document.querySelectorAll(".rule-group-checkbox")
          )
            .filter(cb => cb.checked)
            .map(cb => cb.value);
      
          const proxies = proxyControllers
            .map(c => c.getState())
            .filter(Boolean);
      
          const state = { profile, subscriptions, proxies };
          if (defaultGroups.length) state.defaultGroups = defaultGroups;
          if (enabledRuleGroups.length) state.enabledRuleGroups = enabledRuleGroups;
          return state;
        }
      
        // ----- generate demo preview on client -----
        function generatePreviewDemo(manual = false) {
          const state = collectState();
          const payload = { state };
          if (!editor) {
            setStatus("Editor not initialised.", "err");
            if (manual) try { toast("Editor not initialised.", 'error'); } catch (e) {}
            return;
          }
      
          // Обновляем сводку и выполняем мини-валидацию
          updateStateSummary(state);
          const { valid, warnings, errors } = validateState(state, "preview");
          if (!valid && errors.length) {
            setStatus(errors.join(" "), "err");
            if (manual) try { toast(errors.join(" "), 'error'); } catch (e) {}
            return;
          }
          if (warnings.length) {
            // Показываем предупреждение, но предпросмотр всё равно генерируем
            setStatus(warnings.join(" "), null);
            if (manual) try { toast(warnings.join(" "), 'info'); } catch (e) {}
          } else {
            setStatus("Генерирую предпросмотр на сервере...", "ok");
          }
      
          fetch("/api/mihomo/preview", {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
          })
            .then(resp => resp.json().then(data => ({ ok: resp.ok, data })))
            .then(({ ok, data }) => {
              if (!ok || !data || data.ok === false) {
                const msg = (data && (data.error || data.message)) || "Не удалось сгенерировать предпросмотр.";
                setStatus(msg, "err");
                if (manual) try { toast(msg, 'error'); } catch (e) {}
                return;
              }
              const cfg = data.content || data.config || "";
              if (!cfg.trim()) {
                setStatus("Сервер вернул пустой конфиг для предпросмотра.", "err");
                if (manual) try { toast("Сервер вернул пустой конфиг для предпросмотра.", 'error'); } catch (e) {}
                return;
              }
              editor.setValue(cfg);
              setStatus("Предпросмотр сгенерирован на сервере без сохранения и перезапуска.", "ok");
              if (manual) try { toast("Предпросмотр обновлён.", 'success'); } catch (e) {}
            })
            .catch(err => {
              console.error("preview error", err);
              setStatus("Ошибка генерации предпросмотра: " + err, "err");
              if (manual) try { toast("Ошибка генерации предпросмотра: " + err, 'error'); } catch (e) {}
            });
        }
      
        // ----- download config -----
        function downloadConfig() {
          const text = editor ? editor.getValue() : "";
          if (!text.trim()) {
            setStatus("Нечего сохранять – редактор пуст.", "err");
            try { toast("Нечего сохранять – редактор пуст.", 'error'); } catch (e) {}
            return;
          }
          const blob = new Blob([text], { type: "text/yaml" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = "config.yaml";
          document.body.appendChild(a);
          a.click();
          setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          }, 0);
          setStatus("config.yaml скачан на компьютер.", "ok");
          try { toast("config.yaml скачан на компьютер.", 'success'); } catch (e) {}
        }
      
        
        // ----- validate via mihomo core -----
        
        function showValidationModal(text) {
          const modal = document.getElementById("validationModal");
          const body = document.getElementById("validationModalBody");
          if (!modal || !body) return;
      
          const raw = text == null ? "" : String(text);
          body.innerHTML = formatLogHtml(raw);
      
          // показать модалку
          modal.classList.remove("hidden");
          document.body.classList.add("modal-open");
        }
      
        function hideValidationModal() {
          const modal = document.getElementById("validationModal");
          if (!modal) return;
      
          // скрыть модалку
          modal.classList.add("hidden");
          document.body.classList.remove("modal-open");
        }
      
        // Expose modal controls globally so inline onclick handlers work
        window.showValidationModal = showValidationModal;
        window.hideValidationModal = hideValidationModal;
      
        // ----- validate via mihomo core -----
        async function validateConfigOnServer(showPopup = true, notify = false) {
          const cfg = editor ? editor.getValue() : "";
          if (!cfg.trim()) {
            setStatus("Нечего проверять – конфиг пуст.", "err");
            if (notify) try { toast("Нечего проверять – конфиг пуст.", 'error'); } catch (e) {}
            return { ok: false };
          }
          setStatus("Проверяю конфиг через mihomo...", "ok");
          try {
            const res = await fetch("/api/mihomo/validate_raw", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ config: cfg }),
            });
            const data = await res.json();
            const log = data && data.log ? data.log : "";
            if (typeof log === "string" && log.trim()) {
              setValidationLog(log);
              jumpToErrorPositionFromLog(log);
              if (showPopup) {
                showValidationModal(log);
              }
            }
            if (!res.ok) {
              setStatus("Ошибка проверки конфига: " + (data && (data.error || res.status)), "err");
              if (notify) try { toast("Ошибка проверки конфига: " + (data && (data.error || res.status)), 'error'); } catch (e) {}
              return { ok: false, log };
            }
            const firstLine = (log.split("\n").find(l => l.trim()) || "").trim();
            if (data.ok) {
              const msg = firstLine || "mihomo сообщает, что конфиг валиден (exit code 0).";
              setStatus(msg, "ok");
              if (notify) try { toast(msg, 'success'); } catch (e) {}
              return { ok: true, log };
            } else {
              const msg = firstLine || "mihomo сообщил об ошибке при проверке конфига.";
              setStatus("В таком виде конфиг не будет работать: " + msg, "err");
              if (notify) try { toast("В таком виде конфиг не будет работать: " + msg, 'error'); } catch (e) {}
              return { ok: false, log };
            }
          } catch (e) {
            setStatus("Ошибка сети при проверке конфига: " + e, "err");
            if (notify) try { toast("Ошибка сети при проверке конфига: " + e, 'error'); } catch (e2) {}
            return { ok: false };
          }
        }
      
      // ----- apply to router -----
        async function applyToRouter(notify = false) {
          const state = collectState();
          const cfg = editor ? editor.getValue() : "";
          if (!cfg.trim()) {
            setStatus("Нечего применять – конфиг пуст.", "err");
            if (notify) try { toast("Нечего применять – конфиг пуст.", 'error'); } catch (e) {}
            return;
          }
      
          // Обновляем сводку и выполняем мини-валидацию
          updateStateSummary(state);
          const { valid, warnings, errors } = validateState(state, "apply");
          if (!valid && errors.length) {
            setStatus(errors.join(" "), "err");
            if (notify) try { toast(errors.join(" "), 'error'); } catch (e) {}
            return;
          }
      
          // Перед применением дополнительно прогоняем конфиг через mihomo -t
          const validation = await validateConfigOnServer(false, false);
          if (!validation.ok) {
            // Подробный текст уже выведен в статусе, применение блокируем.
            if (notify) try { toast(statusMessage.textContent || 'Ошибка валидации конфига.', 'error'); } catch (e) {}
            return;
          }
      
          if (warnings.length) {
            // Для применения показываем предупреждения, но не блокируем операцию
            setStatus(warnings.join(" "), "err");
          } else {
            setStatus("Отправляю конфиг на роутер...", "ok");
            if (notify) try { toast("Отправляю конфиг на роутер...", 'info'); } catch (e) {}
          }
      
          const payload = { state, configOverride: cfg };
          try {
            const res = await fetch("/api/mihomo/generate_apply", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });
            const data = await res.json();
            if (!res.ok || !data.ok) {
              setStatus("Ошибка при применении: " + (data.error || res.status), "err");
              if (notify) try { toast("Ошибка при применении: " + (data.error || res.status), 'error'); } catch (e) {}
              return;
            }
            setStatus("Конфиг отправлен на роутер, xkeen перезапускается.", "ok");
            /* toast for restart is handled globally in spinner_fetch.js */
          } catch (e) {
            setStatus("Ошибка сети: " + e, "err");
            if (notify) try { toast("Ошибка сети: " + e, 'error'); } catch (e2) {}
          }
        }
      
        // ----- copy -----
        function copyConfig() {
          const text = editor ? editor.getValue() : "";
          if (!navigator.clipboard) {
            const t = document.createElement("textarea");
            t.value = text;
            document.body.appendChild(t);
            t.select();
            try {
              document.execCommand("copy");
              setStatus("Скопировано в буфер (через fallback).", "ok");
              try { toast("Скопировано в буфер.", 'success'); } catch (e) {}
            } catch (e) {
              setStatus("Не удалось скопировать.", "err");
              try { toast("Не удалось скопировать.", 'error'); } catch (e) {}
            } finally {
              document.body.removeChild(t);
            }
            return;
          }
          navigator.clipboard.writeText(text).then(
            () => { setStatus("Конфиг скопирован в буфер обмена.", "ok"); try { toast("Конфиг скопирован в буфер обмена.", 'success'); } catch (e) {} },
            () => { setStatus("Не удалось скопировать в буфер обмена.", "err"); try { toast("Не удалось скопировать в буфер обмена.", 'error'); } catch (e) {} }
          );
        }
      
        // ----- edit toggle -----
        function setEditable(flag, notify = false) {
          if (!editor) return;
          if (flag) {
            editor.setOption("readOnly", false);
            setStatus("Режим редактирования включён.", "ok");
            if (notify) try { toast("Режим редактирования включён.", 'info'); } catch (e) {}
          } else {
            editor.setOption("readOnly", true);
            setStatus("Редактирование выключено, конфиг защищён от случайных правок.", null);
            if (notify) try { toast("Редактирование выключено.", 'info'); } catch (e) {}
          }
        }
      
        // ----- init -----
        // NOTE: init() itself is called from pages/mihomo_generator.init.js on DOMContentLoaded.
        // Поэтому здесь нельзя вешать ещё один DOMContentLoaded, иначе колбэк уже не сработает.
        initEditor();
        try { setEditable(!!(editToggle && editToggle.checked), false); } catch (e) {}
        addInitialSubscriptionRow();
        loadProfileDefaults(profileSelect && profileSelect.value);
        setStatus("Скелет загружен. Заполните поля слева и нажмите «Применить».", null);
      
        addSubscriptionBtn.onclick = () => {
          subscriptionsList.appendChild(createSubscriptionRow(""));
        };
        addProxyBtn.onclick = () => createProxyCard();
        generateBtn.onclick = () => generatePreviewDemo(true);
        saveBtn.onclick = downloadConfig;
        validateBtn.onclick = () => { validateConfigOnServer(true, true); };
        applyBtn.onclick = () => applyToRouter(true);
        copyBtn.onclick = copyConfig;
        if (clearValidationLogBtn) {
          clearValidationLogBtn.onclick = () => { setValidationLog(""); try { toast("Лог проверки очищен.", 'info'); } catch (e) {} };
        }
        editToggle.addEventListener("change", () => setEditable(editToggle.checked, true));
    }

    return { init };
  })();
})();
