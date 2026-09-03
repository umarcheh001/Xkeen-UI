import { getXkeenCoreHttpApi } from '../../xkeen_runtime.js';
import { GUARD_RELEASED_BADGE, guardNotice, guardRelease, guardReleaseSummary, guardReleaseText } from '../../dns_guard_text.js';
import { getRoutingCardsNamespace } from '../../routing_cards_namespace.js';

/* Guarded, one-click DNS-over-VLESS assistant. */
(function () {
  'use strict';

  const RC = getRoutingCardsNamespace();
  const C = RC.common || {};
  const IDS = RC.IDS || {};
  const $ = (typeof C.$ === 'function') ? C.$ : (id) => document.getElementById(id);
  const toast = (typeof C.toast === 'function') ? C.toast : (message) => console.log(message);

  const DOM = {
    modal: 'routing-dns-over-vless-modal',
    layout: 'routing-dns-over-vless-layout',
    close: 'routing-dns-over-vless-close',
    cancel: 'routing-dns-over-vless-cancel',
    apply: 'routing-dns-over-vless-apply',
    badge: 'routing-dns-over-vless-badge',
    leadTitle: 'routing-dns-over-vless-lead-title',
    leadText: 'routing-dns-over-vless-lead-text',
    status: 'routing-dns-over-vless-status',
    details: 'routing-dns-over-vless-details',
    dot: 'routing-dns-over-vless-dot',
    route: 'routing-dns-over-vless-route',
    target: 'routing-dns-over-vless-target',
    targetTools: 'routing-dns-over-vless-target-tools',
    targetCount: 'routing-dns-over-vless-target-count',
    targetAll: 'routing-dns-over-vless-target-all',
    targetNone: 'routing-dns-over-vless-target-none',
    fallback: 'routing-dns-over-vless-route-fallback',
    multi: 'routing-dns-over-vless-multi',
    multiRow: 'routing-dns-over-vless-multi-row',
    upstreams: 'routing-dns-over-vless-upstreams',
    remote: 'routing-dns-over-vless-remote',
    local: 'routing-dns-over-vless-local',
    zones: 'routing-dns-over-vless-zones',
    zonesRow: 'routing-dns-over-vless-zones-row',
    zonePresets: 'routing-dns-over-vless-zone-presets',
    direct: 'routing-dns-over-vless-direct',
    directZones: 'routing-dns-over-vless-direct-zones',
    directZonesRow: 'routing-dns-over-vless-direct-zones-row',
    directFromRules: 'routing-dns-over-vless-direct-from-rules',
    pass: 'routing-dns-over-vless-pass',
    passRow: 'routing-dns-over-vless-pass-row',
    passNode: 'routing-dns-over-vless-pass-node',
    passHealth: 'routing-dns-over-vless-pass-health',
    clients: 'routing-dns-over-vless-clients',
    clientsSummary: 'routing-dns-over-vless-clients-summary',
    clientsList: 'routing-dns-over-vless-clients-list',
    capture: 'routing-dns-over-vless-capture',
    reset: 'routing-dns-over-vless-reset',
    lockedNote: 'routing-dns-over-vless-locked-note',
  };

  let status = null;
  let busy = false;
  // Функция включена: поля показываем, но правку запрещаем — применяются
  // они всё равно только при включении.
  let fieldsLocked = false;
  let chosenTargets = [];
  // Устройства, чей DNS заводим в туннель. Живёт отдельно от списка на
  // экране: список перечитывается сам по себе, а выбор должен пережить
  // и перечитывание, и уход устройства из сети.
  let capturedMacs = [];
  // Последний ответ про устройства: список перерисовывается и без нового
  // запроса — например, когда переключатель открывает галочки.
  let lastClients = null;
  let multiTouched = false;
  // A picked-clean list is a real answer ("nothing selected yet"), so the first
  // render may fill it in but a later manual clear must survive a re-render.
  let targetsTouched = false;
  let routePool = [];
  let routeVisible = false;

  function showModal(open) {
    const modal = $(DOM.modal);
    if (!modal) return;
    modal.classList.toggle('hidden', !open);
    document.body.classList.toggle('modal-open', !!open);
    if (open) setTimeout(() => { try { $(DOM.cancel).focus(); } catch (e) {} }, 0);
  }

  function http() {
    return getXkeenCoreHttpApi();
  }

  async function getStatus() {
    const client = http();
    if (client && typeof client.fetchJSON === 'function') {
      return client.fetchJSON('/api/routing/dns-over-vless', { cache: 'no-store', timeoutMs: 15000 });
    }
    const response = await fetch('/api/routing/dns-over-vless', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  function dnsSettings() {
    const upstreams = $(DOM.upstreams);
    const local = $(DOM.local);
    const settings = {};
    if (upstreams) settings.upstreams = String(upstreams.value || '').trim();
    const remote = $(DOM.remote);
    // Sent with the list itself: the same address is a mistake without it and
    // a deliberate choice with it.
    if (remote) settings.upstreams_remote = !!remote.checked;
    // An empty string is meaningful here: it switches the local exception off.
    if (local) settings.local_resolver = String(local.value || '').trim();
    const zones = $(DOM.zones);
    if (zones && settings.local_resolver) settings.local_domains = String(zones.value || '').trim();
    const direct = $(DOM.direct);
    // Same rule as above: an empty string switches the bypass group off.
    if (direct) settings.direct_resolver = String(direct.value || '').trim();
    const directZones = $(DOM.directZones);
    if (directZones && settings.direct_resolver) {
      settings.direct_domains = String(directZones.value || '').trim();
    }
    const pass = $(DOM.pass);
    if (pass) {
      settings.pass_non_ip = !!pass.checked;
      const node = $(DOM.passNode);
      // The node only means anything while the pass-through is on; sending it
      // otherwise would pin a choice the user cannot see.
      if (pass.checked && node && node.value) settings.pass_non_ip_node = node.value;
    }
    const capture = $(DOM.capture);
    if (capture) {
      settings.capture_clients = !!capture.checked;
      // Список шлём всегда: снятая галочка при выключенном переключателе
      // должна запомниться, а не потеряться до следующего включения.
      settings.capture_macs = capturedMacs.slice();
    }
    return settings;
  }

  async function postAction(action, targets) {
    const list = Array.isArray(targets) ? targets.filter(Boolean) : [];
    const payload = list.length ? { action, targets: list } : { action };
    if (action === 'enable') Object.assign(payload, dnsSettings());
    const client = http();
    if (client && typeof client.postJSON === 'function') {
      return client.postJSON('/api/routing/dns-over-vless', payload, { timeoutMs: 90000, retry: 0 });
    }
    const token = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';
    const response = await fetch('/api/routing/dns-over-vless', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error || `HTTP ${response.status}`);
      error.data = data;
      throw error;
    }
    return data;
  }

  function addDetail(text, kind) {
    const list = $(DOM.details);
    if (!list) return;
    const li = document.createElement('li');
    li.className = kind ? `is-${kind}` : '';
    li.textContent = String(text || '');
    list.appendChild(li);
  }

  function candidateMeta(item) {
    const bits = [];
    if (item.strategy_type) bits.push(item.strategy_type);
    if (item.kind === 'balancer') bits.push(`узлов: ${item.selector_count}`);
    if (!item.usable && item.reason) bits.push(item.reason);
    return bits.join(' · ');
  }

  function optionRow(item, selected, multi) {
    const row = document.createElement('div');
    row.className = 'routing-dns-over-vless-option';
    row.dataset.tag = item.tag;
    row.dataset.selected = selected ? '1' : '0';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', selected ? 'true' : 'false');
    row.tabIndex = -1;
    if (!item.usable || busy) row.setAttribute('aria-disabled', 'true');

    const mark = document.createElement('span');
    mark.className = 'routing-dns-over-vless-option-mark';
    mark.dataset.shape = multi ? 'check' : 'dot';
    mark.setAttribute('aria-hidden', 'true');
    if (multi) mark.textContent = '✓';
    row.appendChild(mark);

    const body = document.createElement('span');
    body.className = 'routing-dns-over-vless-option-body';
    const title = document.createElement('span');
    title.className = 'routing-dns-over-vless-option-title';
    title.textContent = item.label || item.tag;
    body.appendChild(title);
    const meta = candidateMeta(item);
    if (meta) {
      const small = document.createElement('small');
      small.className = 'routing-dns-over-vless-option-meta';
      small.textContent = meta;
      body.appendChild(small);
    }
    row.appendChild(body);
    return row;
  }

  function pickerRows(picker) {
    return Array.prototype.slice.call(picker.querySelectorAll('.routing-dns-over-vless-option'));
  }

  function renderPicker(picker, pool, wanted, multi) {
    // Redrawing throws the focused row away, so remember where the keyboard was.
    const active = document.activeElement;
    const hadFocus = !!(active && picker.contains(active));
    const focusedTag = hadFocus ? (active.dataset || {}).tag : '';

    picker.dataset.mode = multi ? 'multi' : 'single';
    picker.setAttribute('aria-multiselectable', multi ? 'true' : 'false');
    picker.textContent = '';
    pool.forEach((item) => {
      picker.appendChild(optionRow(item, wanted.indexOf(item.tag) !== -1, multi));
    });

    // Roving tabindex: one stop for the whole list, on the row that matters.
    const rows = pickerRows(picker).filter((row) => row.getAttribute('aria-disabled') !== 'true');
    const stop = rows.find((row) => row.dataset.tag === focusedTag)
      || rows.find((row) => row.dataset.selected === '1')
      || rows[0];
    if (stop) stop.tabIndex = 0;
    if (hadFocus && stop) { try { stop.focus(); } catch (e) {} }
  }

  function renderPickerTools(pool, wanted, multi) {
    const tools = $(DOM.targetTools);
    if (!tools) return;
    tools.classList.toggle('hidden', !multi);
    if (!multi) return;
    const usable = pool.filter((item) => item && item.usable);
    const count = $(DOM.targetCount);
    if (count) count.textContent = `Отмечено ${wanted.length} из ${usable.length}`;
    const all = $(DOM.targetAll);
    const none = $(DOM.targetNone);
    if (all) all.disabled = busy || wanted.length >= usable.length;
    if (none) none.disabled = busy || !wanted.length;
  }

  function toggleTarget(tag, multi) {
    if (!tag || busy) return;
    targetsTouched = true;
    if (!multi) {
      chosenTargets = [tag];
    } else if (chosenTargets.indexOf(tag) === -1) {
      chosenTargets = chosenTargets.concat([tag]);
    } else {
      chosenTargets = chosenTargets.filter((item) => item !== tag);
    }
    // A full redraw keeps the action button and the hint line in step with the
    // selection, not just the list itself.
    if (status) render(status);
  }

  function onPickerKeydown(event) {
    const picker = $(DOM.target);
    if (!picker) return;
    const rows = pickerRows(picker).filter((row) => row.getAttribute('aria-disabled') !== 'true');
    if (!rows.length) return;
    const current = rows.indexOf(document.activeElement);
    let next = -1;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = Math.min(rows.length - 1, current + 1);
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = Math.max(0, (current === -1 ? 0 : current - 1));
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = rows.length - 1;
    else if (event.key === ' ' || event.key === 'Enter') {
      if (current === -1) return;
      event.preventDefault();
      toggleTarget(rows[current].dataset.tag, picker.dataset.mode === 'multi');
      return;
    } else {
      return;
    }
    event.preventDefault();
    rows.forEach((row) => { row.tabIndex = -1; });
    const target = rows[next < 0 ? 0 : next];
    target.tabIndex = 0;
    try { target.focus(); } catch (e) {}
  }

  function multiEnabled() {
    const box = $(DOM.multi);
    return !!(box && box.checked);
  }

  function renderRoute(data) {
    const wrap = $(DOM.route);
    const picker = $(DOM.target);
    if (!wrap || !picker) return;
    const candidates = (data && Array.isArray(data.candidates)) ? data.candidates : [];
    const usable = candidates.filter((item) => item && item.usable);
    // The route is only chosen while enabling; disabling touches nothing.
    // A route cannot be applied under another core either, so asking for one
    // next to a blocked action button would only be noise.
    const show = !!(data && !data.enabled && !data.can_disable && candidates.length
      && coreOf(data) === 'xray');
    routeVisible = show;
    wrap.classList.toggle('hidden', !show);
    setFieldsLocked(!!(data && data.enabled));
    if (!show) {
      picker.textContent = '';
      routePool = [];
      const tools = $(DOM.targetTools);
      if (tools) tools.classList.add('hidden');
      return;
    }

    // Xray routes a rule to one outbound or one balancer, so combining is only
    // possible across plain proxies — a balancer can never join them.
    const proxies = usable.filter((item) => item.kind === 'outbound');
    const multiRow = $(DOM.multiRow);
    const multiBox = $(DOM.multi);
    const canCombine = proxies.length > 1;
    if (multiRow) multiRow.classList.toggle('hidden', !canCombine);
    if (multiBox && !canCombine) multiBox.checked = false;
    // Reopen in combined mode when that is what was saved last time.
    const savedCombined = !!(data && (data.selected_targets || []).length > 1);
    if (multiBox && canCombine && savedCombined && !multiTouched) multiBox.checked = true;
    const multi = multiEnabled() && canCombine;

    const pool = multi ? candidates.filter((item) => item.kind === 'outbound') : candidates;
    const poolUsable = pool.filter((item) => item.usable);

    let wanted = (targetsTouched || chosenTargets.length)
      ? chosenTargets
      : (data && (data.selected_targets || []).length ? data.selected_targets : [data && data.default_target].filter(Boolean));
    wanted = wanted.filter((tag) => poolUsable.some((item) => item.tag === tag));
    // Until the list is touched, keep a working default; after that an empty
    // selection is what the user asked for and must not be refilled.
    if (!wanted.length && poolUsable.length && !targetsTouched) wanted = [poolUsable[0].tag];
    if (!multi) wanted = wanted.slice(0, 1);

    routePool = pool;
    renderPicker(picker, pool, wanted, multi);
    renderPickerTools(pool, wanted, multi);
    chosenTargets = wanted;
    renderFallback(multi ? null : pool.find((item) => item.tag === wanted[0]), multi, wanted);
  }

  const PRESET_LABELS = {
    local: 'Локальные',
    ptr: 'Обратные приватные',
    ptr172: '172.16/12',
    keenetic: 'Keenetic',
    netcraze: 'Netcraze',
  };

  function parseZones(text) {
    return String(text || '')
      .split(/[,;\s]+/)
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
  }

  function writeZones(list) {
    const zones = $(DOM.zones);
    if (!zones) return;
    zones.value = list.join(', ');
    zones.dataset.touched = '1';
  }

  function togglePreset(key) {
    const presets = (status && status.zone_presets) || {};
    const group = (presets[key] || []).map((item) => String(item).toLowerCase());
    if (!group.length) return;
    const current = parseZones(($(DOM.zones) || {}).value);
    const hasAll = group.every((zone) => current.indexOf(zone) !== -1);
    const next = hasAll
      ? current.filter((zone) => group.indexOf(zone) === -1)
      : current.concat(group.filter((zone) => current.indexOf(zone) === -1));
    writeZones(next);
    renderZonePresets();
  }

  function renderZonePresets() {
    const holder = $(DOM.zonePresets);
    if (!holder) return;
    const presets = (status && status.zone_presets) || {};
    const keys = Object.keys(PRESET_LABELS).filter((key) => (presets[key] || []).length);
    const current = parseZones(($(DOM.zones) || {}).value);

    if (holder.dataset.keys !== keys.join(',')) {
      holder.dataset.keys = keys.join(',');
      holder.textContent = '';
      keys.forEach((key) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.preset = key;
        button.dataset.label = PRESET_LABELS[key];
        button.addEventListener('click', (event) => { event.preventDefault(); togglePreset(key); });
        holder.appendChild(button);
      });
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.dataset.role = 'reset';
      reset.textContent = 'По умолчанию';
      reset.addEventListener('click', (event) => {
        event.preventDefault();
        writeZones(((status && status.default_local_domains) || []).map((item) => String(item).toLowerCase()));
        renderZonePresets();
      });
      holder.appendChild(reset);
    }

    Array.prototype.forEach.call(holder.querySelectorAll('button[data-preset]'), (button) => {
      const group = (presets[button.dataset.preset] || []).map((item) => String(item).toLowerCase());
      const active = group.length && group.every((zone) => current.indexOf(zone) !== -1);
      button.dataset.active = active ? '1' : '0';
      // Colour alone reads as focus rather than state, so mark it in the text.
      button.textContent = (active ? '✓ ' : '+ ') + button.dataset.label;
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      button.title = active ? 'Убрать этот набор из списка' : 'Добавить этот набор в список';
      button.disabled = busy || fieldsLocked;
    });
    const reset = holder.querySelector('button[data-role="reset"]');
    if (reset) reset.disabled = busy || fieldsLocked;
  }

  // Выбор маршрута и поля настроек жили в одном контейнере, поэтому при
  // включённой функции пряталось и то и другое: посмотреть, что настроено,
  // можно было только выключив защиту. Менять маршрут на ходу и правда
  // нельзя — а читать настройки и готовить их к следующему включению можно.
  function setFieldsLocked(locked) {
    fieldsLocked = !!locked;
    const note = $(DOM.lockedNote);
    if (note) note.classList.toggle('hidden', !fieldsLocked);
    const ids = [DOM.upstreams, DOM.remote, DOM.local, DOM.zones, DOM.direct,
      DOM.directZones, DOM.pass, DOM.passNode, DOM.capture];
    for (let i = 0; i < ids.length; i += 1) {
      const field = $(ids[i]);
      if (field) field.disabled = fieldsLocked || busy;
    }
  }

  function renderDnsFields(data) {
    const upstreams = $(DOM.upstreams);
    const local = $(DOM.local);
    if (upstreams && !upstreams.dataset.touched) {
      upstreams.value = ((data && data.upstreams) || []).join(', ');
    }
    if (local && !local.dataset.touched) {
      local.value = ((data && data.local_resolvers) || []).join(', ');
    }
    if (upstreams) upstreams.disabled = busy || fieldsLocked;
    if (local) local.disabled = busy || fieldsLocked;

    const zones = $(DOM.zones);
    const zonesRow = $(DOM.zonesRow);
    // The zone list only means something once a local resolver answers them.
    const hasLocal = !!(local && String(local.value || '').trim());
    if (zonesRow) zonesRow.classList.toggle('hidden', !hasLocal);
    if (zones) {
      if (!zones.dataset.touched) {
        const list = (data && data.local_domains) || (data && data.default_local_domains) || [];
        zones.value = list.join(', ');
      }
      zones.disabled = busy || fieldsLocked;
    }
    if (hasLocal) renderZonePresets();

    const direct = $(DOM.direct);
    if (direct && !direct.dataset.touched) {
      direct.value = ((data && data.direct_resolvers) || []).join(', ');
    }
    if (direct) direct.disabled = busy || fieldsLocked;

    const directZones = $(DOM.directZones);
    const directZonesRow = $(DOM.directZonesRow);
    // Like the zone list above: the domains matter only once a resolver is
    // named, so the field appears together with one.
    const hasDirect = !!(direct && String(direct.value || '').trim());
    if (directZonesRow) directZonesRow.classList.toggle('hidden', !hasDirect);
    if (directZones) {
      if (!directZones.dataset.touched) {
        directZones.value = ((data && data.direct_domains) || []).join(', ');
      }
      directZones.disabled = busy || fieldsLocked;
    }
    const remote = $(DOM.remote);
    if (remote) {
      if (!remote.dataset.touched) remote.checked = !!(data && data.upstreams_remote);
      remote.disabled = busy || fieldsLocked;
    }
    const capture = $(DOM.capture);
    if (capture) {
      if (!capture.dataset.touched) {
        capture.checked = !!(data && data.capture_clients);
        capturedMacs = ((data && data.capture_macs) || []).slice();
      }
      capture.disabled = busy || fieldsLocked;
    }
    const pass = $(DOM.pass);
    const passRow = $(DOM.passRow);
    const passNode = $(DOM.passNode);
    if (pass) {
      if (!pass.dataset.touched) pass.checked = !!(data && data.pass_non_ip);
      pass.disabled = busy || fieldsLocked;
    }
    // The node matters only while the switch is on, so it appears with it.
    const passOn = !!(pass && pass.checked);
    if (passRow) passRow.classList.toggle('hidden', !passOn);
    if (passNode) {
      const options = (data && data.pass_non_ip_options) || [];
      const wanted = passNode.dataset.touched
        ? passNode.value
        : ((data && data.pass_non_ip_node) || '');
      const same = JSON.stringify(options) === (passNode.dataset.options || '');
      if (!same) {
        passNode.dataset.options = JSON.stringify(options);
        passNode.innerHTML = '';
        options.forEach((tag) => {
          const option = document.createElement('option');
          option.value = tag;
          option.textContent = tag;
          passNode.appendChild(option);
        });
      }
      // A remembered node that no longer exists must not look chosen.
      if (wanted && options.indexOf(wanted) >= 0) passNode.value = wanted;
      else if (options.length) passNode.value = options[0];
      passNode.disabled = busy || fieldsLocked || !options.length;
    }
    renderPassHealth(passOn ? (data && data.pass_non_ip_health) : null);
    const fromRules = $(DOM.directFromRules);
    if (fromRules) {
      // Nothing to offer when no rule of the user's own goes out directly.
      const offered = (data && data.direct_rule_domains) || [];
      fromRules.disabled = busy || fieldsLocked || !offered.length;
      fromRules.title = offered.length
        ? `Подставит домены из ваших правил: ${offered.join(', ')}`
        : 'В правилах роутинга нет доменов, ведущих напрямую';
    }
  }

  function passHealthMoment(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value <= 0) return '';
    try {
      return new Date(value * 1000).toLocaleString('ru-RU', {
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
      });
    } catch (error) {
      return '';
    }
  }

  /* Как живётся тем типам записей, что едут одним узлом.
   *
   * Проба сторожа спрашивает A, на который встроенный DNS отвечает сам, — то
   * есть отказ этого узла в остальном окне выглядит как полное здоровье.
   * Строка ниже — единственное место, где такой частичный отказ виден.
   */
  function renderPassHealth(health) {
    const line = $(DOM.passHealth);
    if (!line) return;
    if (!health) {
      line.classList.add('hidden');
      line.textContent = '';
      return;
    }
    line.classList.remove('hidden');
    const node = String(health.node || '').trim();
    const from = String(health.switched_from || '').trim();
    if (health.exhausted) {
      line.dataset.state = 'failed';
      line.textContent = 'Прочие типы записей не проходят: ни один узел маршрута на них не отвечает. '
        + 'A и AAAA идут обычным путём — отказ частичный. Панель больше не переключает узлы сама.';
      return;
    }
    if (health.ok) {
      const when = passHealthMoment(health.checked_at);
      line.dataset.state = 'kept';
      line.textContent = when
        ? `Прочие типы записей проходят через ${node}. Проверено ${when}.`
        : `Прочие типы записей проходят через ${node}.`;
      return;
    }
    line.dataset.state = 'dropped';
    if (from) {
      const when = passHealthMoment(health.switched_at);
      line.textContent = when
        ? `Прочие типы записей переведены на ${node}: узел ${from} на них не отвечал. Переключено ${when}.`
        : `Прочие типы записей переведены на ${node}: узел ${from} на них не отвечал.`;
      return;
    }
    line.textContent = `Прочие типы записей не получили ответ через ${node}; сторож проверит ещё раз.`;
  }

  function renderFallback(candidate, multi, wanted) {
    const line = $(DOM.fallback);
    if (!line) return;
    if (multi) {
      line.classList.remove('hidden');
      const list = (wanted || []);
      if (list.length > 1) {
        line.dataset.state = 'kept';
        // Тот же язык, что и у причины с сервера: что произойдёт, а не что
        // панель собрала в конфигурации.
        line.textContent = `Выбрано ${list.length}: ${list.join(', ')}. Панель распределит DNS-запросы между ними. Если откажут все разом, DNS перестанет отвечать: запасного пути в обход VPN здесь нет — по нему запросы ушли бы к провайдеру.`;
      } else if (list.length === 1) {
        // One proxy is not a balancer: be honest instead of promising one.
        line.dataset.state = 'dropped';
        line.textContent = `Выбран один прокси (${list[0]}) — балансировки не будет. Отметьте ещё хотя бы один.`;
      } else {
        line.dataset.state = 'dropped';
        line.textContent = 'Отметьте хотя бы два прокси, между которыми балансировать DNS.';
      }
      return;
    }
    const plan = candidate && candidate.fallback;
    const show = !!(plan && plan.tag);
    line.classList.toggle('hidden', !show);
    if (!show) {
      line.textContent = '';
      return;
    }
    line.dataset.state = plan.kept ? 'kept' : 'dropped';
    // Причина приходит с сервера целой фразой и печатается как есть. Прежняя
    // обёртка вокруг неё говорила языком конфигурации: читателю надо было знать,
    // что такое fallbackTag и что панель клонирует его балансировщик.
    line.textContent = plan.reason || '';
  }

  // Про сторожа оба окна — это и окно DNS Mihomo — говорят одними и теми же
  // словами: сторож у защит общий, и разные формулировки для разных ядер
  // читались как разные механизмы. Тексты живут в features/dns_guard_text.js.

  // Ядро определяет всё содержание карточки: DNS-over-VLESS собирает фрагмент
  // именно для Xray, а у Mihomo свой защищённый DNS в отдельном окне. Пока
  // тексты были написаны только про Xray, при активном Mihomo карточка
  // объясняла происходящее неверно.
  const CORE_NAMES = { xray: 'Xray', mihomo: 'Mihomo' };

  function coreOf(data) {
    return String((data && data.active_core) || '').toLowerCase();
  }

  function coreName(core) {
    return CORE_NAMES[core] || '';
  }

  const MIHOMO_HINT = 'У Mihomo свой защищённый DNS — кнопка «DNS» на вкладке Mihomo.';

  function renderLead(data) {
    const title = $(DOM.leadTitle);
    const text = $(DOM.leadText);
    if (!title || !text) return;
    const core = coreOf(data);
    if (core === 'xray') {
      title.textContent = 'DNS через защищённый туннель Xray';
      text.textContent = 'Панель подготовит отдельный DNS-фрагмент, добавит только два служебных правила и включит перехват DNS в Keenetic.';
      return;
    }
    if (core === 'mihomo') {
      // Единственное осмысленное действие при Mihomo — открыть его собственное
      // окно DNS, поэтому заголовок ведёт туда, а не упирается в запрет.
      title.textContent = 'Сейчас работает Mihomo — у него свой защищённый DNS';
      text.textContent = 'Настраивается он кнопкой «DNS» на вкладке Mihomo и прячет запросы так же. Это окно настраивает DNS-over-VLESS для ядра Xray, поэтому включение здесь доступно, только когда активно оно.';
      return;
    }
    if (!core || core === 'unknown') {
      title.textContent = 'Активное ядро не определено';
      text.textContent = 'Панель не смогла понять, какое ядро сейчас работает. Это окно настраивает DNS-over-VLESS для ядра Xray — проверьте состояние служб и откройте окно снова.';
      return;
    }
    title.textContent = `Сейчас работает ядро ${core}`;
    text.textContent = 'Это окно настраивает DNS-over-VLESS для ядра Xray. Переключите активное ядро на Xray, чтобы включить его здесь.';
  }

  // Каждому состоянию — короткая расшифровка рядом с бейджем и объяснение
  // обычными словами: что сейчас происходит с DNS и что делать дальше.
  function describeState(data, flags) {
    const core = coreOf(data);
    const otherCore = core && core !== 'xray' ? coreName(core) || core : '';
    if (flags.enabled && otherCore) {
      return {
        badge: 'Не действует',
        state: 'blocked',
        summary: `служебная конфигурация на месте, но активно ядро ${otherCore}`,
        text: `DNS-фрагмент и правила Xray сохранены, но работают они только под Xray, а сейчас активно ядро ${otherCore} — через туннель запросы не идут. Порт 53 при этом остаётся отданным Xray, поэтому имена могут вообще не разрешаться: сторож заметит это и вернёт DNS прошивке. Верните активным ядром Xray либо отключите настройку здесь.`,
      };
    }
    if (flags.enabled) {
      return {
        badge: 'Включено',
        state: 'enabled',
        summary: 'служебная конфигурация и настройка роутера согласованы',
        text: 'DNS-запросы всей сети уходят внутрь туннеля Xray: провайдер видит только зашифрованное соединение, а не список сайтов. Порт 53 обслуживает Xray, штатный резолвер роутера выключен.',
      };
    }
    if (flags.released) {
      // Сторож у обеих защит один, поэтому и бейдж, и первая фраза здесь те же,
      // что в окне DNS Mihomo: сначала общее «сторож вернул DNS роутеру» с его
      // собственной причиной, а уже потом — что делать именно с этой защитой.
      const back = otherCore
        // Сторож не перезапускает ядро, которое сменили намеренно: он сразу
        // отдаёт DNS прошивке и снимает служебную конфигурацию.
        ? ` Служебный DNS-фрагмент и правила Xray удалены; включить DNS-over-VLESS заново можно, вернув активным ядром Xray вместо ${otherCore}.`
        : ' Служебный DNS-фрагмент и правила Xray удалены; включите защиту заново, когда разберётесь, почему ядро перестало отвечать.';
      return {
        badge: GUARD_RELEASED_BADGE,
        state: 'blocked',
        summary: guardReleaseSummary(),
        text: `${guardReleaseText(data)}${back}`,
      };
    }
    if (otherCore) {
      return {
        badge: 'Нужно ядро Xray',
        state: 'blocked',
        summary: `сейчас активно ядро ${otherCore}`,
        text: `Это окно готовит DNS-фрагмент и правила маршрутизации для Xray, поэтому с активным ядром ${otherCore} включать здесь нечего — свой защищённый DNS у него настраивается отдельно. Имена сейчас разрешает штатный резолвер роутера. Переключите активное ядро на Xray, чтобы включить DNS-over-VLESS.`,
      };
    }
    if (!core || core === 'unknown') {
      return {
        badge: 'Ядро не определено',
        state: 'blocked',
        summary: 'непонятно, какое ядро сейчас работает',
        text: 'Панель не смогла определить активное ядро, поэтому не берётся менять настройку DNS. Проверьте состояние служб на вкладке XKeen и откройте окно заново.',
      };
    }
    if (data && data.partial) {
      return {
        badge: 'Нужно восстановить',
        state: 'blocked',
        summary: 'осталась неполная настройка от прерванной операции',
        text: 'Часть служебных объектов на месте, часть — нет, и в таком виде DNS через туннель не работает. Кнопка ниже удалит только то, что создавала панель, и вернёт разрешение имён роутеру.',
      };
    }
    if (data && data.prepared) {
      return {
        badge: 'Нужно восстановить',
        state: 'blocked',
        summary: 'конфигурация Xray готова, но перехват DNS на роутере не включён',
        text: 'Запросы пока идут мимо туннеля. Включите ещё раз, чтобы панель довела настройку до конца, или отключите — тогда служебная конфигурация будет удалена.',
      };
    }
    if (flags.blocked) {
      return {
        badge: 'Требует внимания',
        state: 'blocked',
        summary: 'найден конфликт: занятый порт, чужой DNS-блок или своё правило на 53',
        text: 'Включение остановлено, чтобы не сломать уже настроенную маршрутизацию. Что именно мешает — в списке ниже; после того как уберёте конфликт, проверка пройдёт сама.',
      };
    }
    return {
      badge: 'Готово',
      state: 'ready',
      summary: 'конфигурация совместима, можно включать',
      text: 'Сейчас имена разрешает штатный резолвер роутера, и провайдер видит, к каким доменам обращается сеть. При включении панель проверит конфигурацию во временном каталоге, сохранит снимок и протестирует DNS: если что-то пойдёт не так, всё вернётся как было.',
    };
  }

  // Сводка нужна ровно для того, чтобы свёрнутое не значило «спрятанное»:
  // по шапкам должно читаться состояние всего окна, без раскрытия зон.
  function zoneSummaryText(zone, data) {
    if (zone === 'home') {
      const list = (data && data.local_resolvers) || [];
      if (!list.length) return 'не настроена';
      const zones = parseZones(($(DOM.zones) || {}).value || '');
      return `${list.length} резолвер(ов) · ${zones.length} зон`;
    }
    if (zone === 'direct') {
      const list = (data && data.direct_resolvers) || [];
      if (!list.length) return 'не настроены';
      const domains = (data && data.direct_domains) || [];
      return `${list.length} резолвер(ов) · ${domains.length} доменов`;
    }
    if (zone === 'records') {
      if (!(data && data.pass_non_ip)) return 'выключено';
      const node = (data && data.pass_non_ip_node) || '';
      return node ? `включено · узел ${node}` : 'включено';
    }
    if (zone === 'devices') {
      const summary = $(DOM.clientsSummary);
      return (summary && summary.textContent.trim()) || 'проверяем…';
    }
    return '';
  }

  function renderZoneSummaries(data) {
    const slots = document.querySelectorAll('[data-zone-sum]');
    for (let i = 0; i < slots.length; i += 1) {
      const slot = slots[i];
      slot.textContent = zoneSummaryText(slot.dataset.zoneSum, data);
    }
  }

  function render(data) {
    status = data || null;
    const badge = $(DOM.badge);
    const text = $(DOM.status);
    const list = $(DOM.details);
    const apply = $(DOM.apply);
    const dot = $(DOM.dot);
    if (list) list.textContent = '';

    const enabled = !!(data && data.enabled);
    const canDisable = !!(data && data.can_disable);
    const blocked = !enabled && !canDisable && !(data && data.can_enable);
    // An automatic release is not a neutral "ready" state: the protection was
    // switched off by itself and the user has to know.
    const released = !enabled && !!guardRelease(data);
    const info = describeState(data, { enabled, canDisable, blocked, released });
    renderLead(data);
    if (badge) {
      badge.textContent = info.badge;
      badge.dataset.state = info.state;
      // Расшифровка целиком не помещается в бейдж, но нужна для подсказки и
      // для тех, кто читает карточку экранным диктором.
      badge.title = `${info.badge} — ${info.summary}`;
    }
    if (dot) {
      dot.dataset.state = enabled ? 'enabled' : (info.state === 'ready' ? 'off' : 'blocked');
    }
    if (text) {
      text.textContent = '';
      const summary = document.createElement('b');
      summary.className = 'routing-dns-over-vless-status-summary';
      summary.textContent = `${info.badge} — ${info.summary}`;
      const body = document.createElement('span');
      body.className = 'routing-dns-over-vless-status-text';
      body.textContent = info.text;
      text.appendChild(summary);
      text.appendChild(body);
    }

    if (data) {
      const core = coreOf(data);
      addDetail(
        core === 'xray'
          ? 'Активное ядро: Xray — то, что нужно для DNS-over-VLESS.'
          : (core === 'mihomo'
            ? `Активное ядро: Mihomo. Это окно настраивает DNS-over-VLESS для Xray. ${MIHOMO_HINT}`
            : `Активное ядро: ${coreName(core) || core || 'не определено'}. Это окно настраивает DNS-over-VLESS для Xray.`),
        core === 'xray' ? 'ok' : 'warn',
      );
      if (data.target && data.target.label) addDetail(`DNS-запросы идут через: ${data.target.label}`, 'ok');
      addDetail(
        data.dns_override === true
          ? 'Перехват DNS на роутере: включён — порт 53 отдан Xray.'
          : (data.dns_override === false
            ? 'Перехват DNS на роутере: выключен — имена разрешает штатный резолвер.'
            : 'Перехват DNS на роутере: определить не удалось.'),
        data.dns_override == null ? 'warn' : 'ok',
      );
      const guard = guardNotice(data, enabled);
      addDetail(guard.text, guard.kind);
      if (data.route_drift) {
        const drift = data.route_drift;
        const was = (drift.managed || []).join(', ') || '—';
        const now = (drift.current || []).join(', ') || '—';
        const parts = [];
        if (was !== now) parts.push(`узлы: было «${was}», стало «${now}»`);
        if ((drift.managed_fallback || '') !== (drift.current_fallback || '')) {
          parts.push(`резерв: было «${drift.managed_fallback || '—'}», стало «${drift.current_fallback || '—'}»`);
        }
        addDetail(`Балансировщик ${drift.source} изменился после включения (${parts.join('; ')}). Переключите DNS-over-VLESS, чтобы обновить маршрут.`, 'warn');
      }
      (data.blockers || []).forEach((item) => addDetail(item, 'warn'));
    }

    renderRoute(data);
    // Не внутри renderRoute: тот выходит раньше, когда выбор маршрута скрыт,
    // а скрыт он ровно при включённой функции — и тогда окно переставало
    // перечитывать с сервера и отмеченные устройства, и все прочие поля,
    // показывая вместо них то, что осталось в DOM.
    renderDnsFields(data);
    renderZoneSummaries(data);

    if (apply) {
      // With nothing ticked there is no route to build: block the action and let
      // the line under the list say what is missing.
      const needsTarget = routeVisible && !chosenTargets.length;
      apply.disabled = busy || (!enabled && !canDisable && (blocked || needsTarget));
      // «Включить безопасно» на неподходящем ядре обещало бы невозможное.
      const wrongCore = coreOf(data) !== 'xray' && !enabled && !canDisable;
      apply.textContent = busy
        ? 'Выполняется…'
        : ((enabled || canDisable) ? 'Отключить и восстановить' : (wrongCore ? 'Нужно ядро Xray' : 'Включить безопасно'));
      apply.classList.toggle('btn-danger', enabled || canDisable);
      apply.classList.toggle('btn-primary', !enabled && !canDisable);
    }
    const resetButton = $(DOM.reset);
    if (resetButton) resetButton.disabled = busy;
  }

  function renderError(error) {
    status = null;
    const badge = $(DOM.badge);
    const text = $(DOM.status);
    const apply = $(DOM.apply);
    if (badge) {
      badge.textContent = 'Ошибка проверки';
      badge.dataset.state = 'blocked';
    }
    if (text) text.textContent = String(error && error.message ? error.message : error || 'Не удалось проверить конфигурацию.');
    if (apply) {
      apply.disabled = true;
      apply.textContent = 'Недоступно';
    }
  }

  // Настройки теперь переживают выключение функции, поэтому нужен способ
  // начать с чистого листа. Роутер при этом не трогаем: поля окна применятся
  // только при включении, как и любые другие правки в нём.
  function resetFields() {
    const data = status || {};
    const values = [
      [DOM.upstreams, ((data.default_upstreams) || []).join(', ')],
      [DOM.local, ''],
      [DOM.zones, ''],
      [DOM.direct, ''],
      [DOM.directZones, ''],
    ];
    values.forEach(([id, value]) => {
      const field = $(id);
      if (!field) return;
      field.value = value;
      field.dataset.touched = '1';
    });
    [DOM.remote, DOM.pass, DOM.capture, DOM.multi].forEach((id) => {
      const box = $(id);
      if (!box) return;
      box.checked = false;
      box.dataset.touched = '1';
    });
    const node = $(DOM.passNode);
    if (node) delete node.dataset.touched;
    capturedMacs = [];
    // Маршрут тоже возвращается к тому, что панель предложила бы сама.
    chosenTargets = [];
    targetsTouched = false;
    multiTouched = false;
    render(status || {});
    if (lastClients) renderClients(lastClients);
    toast('Настройки окна сброшены. Чтобы применить их, включите функцию.');
  }

  // Три раскладки окна: авто (решает ширина экрана), и два принудительных
  // выбора. Значение живёт на сервере — это вкус человека, а не браузера.
  const LAYOUT_MODES = ['auto', 'single', 'split'];
  const LAYOUT_MIN_SPLIT_PX = 1100;

  function readLayout() {
    try {
      const settings = window.XKeen.ui.settings.get();
      const value = settings && settings.routing && settings.routing.dnsOverVlessLayout;
      return LAYOUT_MODES.indexOf(value) === -1 ? 'auto' : value;
    } catch (e) {
      return 'auto';
    }
  }

  // Ниже порога двух колонок физически нет, поэтому split там неотличим от
  // single — решает ширина, а не настройка.
  function resolveLayout(mode) {
    if (mode === 'single') return 'single';
    const fits = window.innerWidth >= LAYOUT_MIN_SPLIT_PX;
    if (mode === 'split') return fits ? 'split' : 'single';
    return fits ? 'split' : 'single';
  }

  function applyLayout(mode) {
    const content = document.querySelector('#routing-dns-over-vless-modal .modal-content');
    if (!content) return;
    content.dataset.dnsLayout = resolveLayout(mode);
    const button = $(DOM.layout);
    if (button) {
      const names = { auto: 'авто', single: 'одна колонка', split: 'две колонки' };
      button.title = `Раскладка окна: ${names[mode]}`;
    }
  }

  async function cycleLayout() {
    const next = LAYOUT_MODES[(LAYOUT_MODES.indexOf(readLayout()) + 1) % LAYOUT_MODES.length];
    applyLayout(next);
    try {
      await window.XKeen.ui.settings.patch({ routing: { dnsOverVlessLayout: next } });
    } catch (e) {
      // Настройка не сохранилась — раскладка всё равно уже применена на экране.
    }
  }

  async function refresh() {
    try {
      const data = await getStatus();
      render(data);
      return data;
    } catch (error) {
      renderError(error);
      return null;
    }
  }

  async function open() {
    showModal(true);
    applyLayout(readLayout());
    chosenTargets = [];
    multiTouched = false;
    targetsTouched = false;
    routePool = [];
    routeVisible = false;
    // Все поля, а не три: тронутый один раз переключатель иначе навсегда
    // переставал обновляться с сервера, даже после переоткрытия окна.
    [
      DOM.upstreams, DOM.local, DOM.zones, DOM.direct, DOM.directZones,
      DOM.remote, DOM.pass, DOM.passNode, DOM.capture, DOM.multi,
    ].forEach((id) => {
      const field = $(id);
      if (field) delete field.dataset.touched;
    });
    capturedMacs = [];
    lastClients = null;
    const text = $(DOM.status);
    const badge = $(DOM.badge);
    const apply = $(DOM.apply);
    if (text) text.textContent = 'Проверяем текущую конфигурацию…';
    if (badge) badge.textContent = 'Проверка…';
    if (apply) apply.disabled = true;
    await refresh();
    // Slower than everything else here -- it asks the firmware for the
    // device list -- so it fills in after the card is already usable.
    loadClients();
  }

  function renderClients(data) {
    lastClients = data;
    const summary = $(DOM.clientsSummary);
    const list = $(DOM.clientsList);
    if (!summary || !list) return;
    list.textContent = '';
    if (!data || data.available === false) {
      summary.textContent = (data && data.error) || 'Проверить не удалось.';
      return;
    }
    const counts = data.counts || {};
    const total = counts.total || 0;
    const taken = counts.intercepted || 0;
    summary.textContent = taken
      ? `Пользуются ${counts.reaches || 0} из ${total}; у ${taken} DNS забирает политика доступа.`
      : `Пользуются все ${total}.`;
    if (data.error) summary.textContent += ` Правила прочитать не удалось: ${data.error}`;

    // Устройства, до которых функция не доходит, идут первыми: ради них
    // и открывают этот список.
    const order = { intercepted: 0, unknown: 1, reaches: 2 };
    const clients = (data.clients || []).slice().sort((a, b) => {
      const byVerdict = (order[a.verdict] ?? 3) - (order[b.verdict] ?? 3);
      if (byVerdict) return byVerdict;
      if (a.active !== b.active) return a.active ? -1 : 1;
      return String(a.title || '').localeCompare(String(b.title || ''), 'ru');
    });
    const capture = $(DOM.capture);
    const capturing = !!(capture && capture.checked);
    clients.forEach((item) => {
      const row = document.createElement('li');
      row.dataset.verdict = item.verdict || 'unknown';
      const title = document.createElement('b');
      // Отмечать имеет смысл только тех, у кого DNS забирает политика:
      // остальные и так доходят, и галочка им ничего не даст.
      if (item.can_capture && item.mac) {
        const pick = document.createElement('input');
        pick.type = 'checkbox';
        pick.className = 'routing-dns-over-vless-clients-pick';
        pick.checked = capturedMacs.indexOf(item.mac) !== -1;
        pick.disabled = busy || !capturing;
        pick.title = capturing
          ? 'Завести DNS этого устройства в туннель'
          : 'Сначала включите переключатель ниже';
        pick.setAttribute('aria-label', `Завести DNS: ${item.title || item.mac}`);
        pick.addEventListener('change', () => {
          const at = capturedMacs.indexOf(item.mac);
          if (pick.checked && at === -1) capturedMacs.push(item.mac);
          if (!pick.checked && at !== -1) capturedMacs.splice(at, 1);
          if (capture) capture.dataset.touched = '1';
        });
        title.appendChild(pick);
      }
      title.appendChild(document.createTextNode(item.title || item.mac || '—'));
      const where = document.createElement('span');
      where.className = 'routing-dns-over-vless-clients-addr';
      // Устройство, которое давно не появлялось, теряет аренду адреса, и
      // прошивка отдаёт его как 0.0.0.0 — такой адрес сюда не доходит, и
      // остаётся MAC. Про саму отлучку говорим прямо, а не подсказкой.
      if (!item.active) {
        const offline = document.createElement('i');
        offline.className = 'routing-dns-over-vless-clients-offline';
        offline.textContent = 'не в сети';
        // Адрес остаётся виден, пока за устройством держится аренда DHCP;
        // после её конца прошивка отдаёт 0.0.0.0, и остаётся MAC. Разница
        // настоящая, поэтому объясняем её, а не прячем адрес у всех подряд.
        offline.title = item.ip
          ? 'Устройства нет в сети; адрес за ним держит аренда DHCP'
          : 'Устройства нет в сети; аренда адреса истекла, показан MAC';
        where.appendChild(offline);
      }
      const address = item.ip || item.mac || '';
      if (address) where.appendChild(document.createTextNode(address));
      const why = document.createElement('span');
      why.className = 'routing-dns-over-vless-clients-why';
      why.textContent = item.reason || '';
      // Домашние имена такого устройства знает резолвер его политики — назовём
      // адрес прямо здесь, иначе искать его придётся по SSH.
      if (item.can_capture && item.firmware_resolver) {
        why.textContent += ` · домашние имена знает ${item.firmware_resolver}`;
      }
      row.appendChild(title);
      row.appendChild(where);
      row.appendChild(why);
      if (!item.active) row.dataset.offline = '1';
      list.appendChild(row);
    });
  }

  async function loadClients() {
    const summary = $(DOM.clientsSummary);
    const list = $(DOM.clientsList);
    if (summary) summary.textContent = 'Проверяем…';
    if (list) list.textContent = '';
    try {
      const client = http();
      const data = (client && typeof client.fetchJSON === 'function')
        ? await client.fetchJSON('/api/routing/dns-over-vless/clients', { cache: 'no-store', timeoutMs: 25000 })
        : await (await fetch('/api/routing/dns-over-vless/clients', { cache: 'no-store' })).json();
      renderClients(data);
    } catch (error) {
      if (summary) {
        summary.textContent = `Проверить не удалось: ${error && error.message ? error.message : error}`;
      }
    }
  }

  async function apply() {
    if (busy || !status) return;
    const action = (status.enabled || status.can_disable) ? 'disable' : 'enable';
    const labels = (status.candidates || [])
      .filter((item) => item && chosenTargets.indexOf(item.tag) !== -1)
      .map((item) => item.label);
    const routeNote = (action === 'enable' && labels.length)
      ? (labels.length > 1
        ? `DNS будет балансироваться между: ${labels.join(', ')}. `
        : `DNS пойдёт через ${labels[0]}. `)
      : '';
    const question = action === 'enable'
      ? routeNote + 'Панель создаст отдельный DNS-фрагмент, добавит два служебных правила в начало routing, выполнит xray -test, включит DNS override Keenetic, перезапустит Xray и проверит DNS. При любой ошибке всё будет восстановлено.'
      : 'Панель удалит только созданный ей DNS-фрагмент и служебные правила, восстановит исходное состояние DNS override Keenetic и перезапустит Xray.';
    let confirmed = true;
    if (C && typeof C.confirmModal === 'function') {
      confirmed = await C.confirmModal({
        title: action === 'enable' ? 'Включить DNS-over-VLESS?' : 'Отключить DNS-over-VLESS?',
        message: question,
        okText: action === 'enable' ? 'Включить' : 'Отключить',
        cancelText: 'Отмена',
        danger: action === 'disable',
      });
    }
    if (!confirmed) return;

    busy = true;
    render(status);
    try {
      const result = await postAction(action, action === 'enable' ? chosenTargets : []);
      toast(action === 'enable'
        ? `DNS-over-VLESS включён${result.probe && result.probe.latency_ms != null ? ` · DNS ${result.probe.latency_ms} мс` : ''}`
        : 'DNS-over-VLESS отключён, исходная настройка восстановлена.');
      await refresh();
      // Строки списка сложились до применения: теперь у устройств другой
      // вердикт, и показывать прежний — значит показывать неправду.
      loadClients();
      try { document.dispatchEvent(new CustomEvent('xkeen-routing-fragment-saved', { detail: { reason: 'dns-over-vless' } })); } catch (e) {}
    } catch (error) {
      const data = error && error.data ? error.data : null;
      const message = String((data && data.error) || error.message || 'Операция не выполнена.');
      toast(`${message}${data && data.rolled_back ? ' Предыдущая конфигурация восстановлена.' : ''}`, true);
      await refresh();
    } finally {
      busy = false;
      render(status || {});
    }
  }

  function init() {
    const button = $(IDS.dnsOverVless || 'routing-dns-over-vless-btn');
    if (!button || button.dataset.wired === '1') return;
    button.dataset.wired = '1';
    button.addEventListener('click', (event) => { event.preventDefault(); open(); });
    const layoutBtn = $(DOM.layout);
    if (layoutBtn) layoutBtn.addEventListener('click', cycleLayout);
    window.addEventListener('resize', () => applyLayout(readLayout()));
    document.addEventListener('xkeen:ui-settings-changed', () => applyLayout(readLayout()));
    [DOM.close, DOM.cancel].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener('click', (event) => { event.preventDefault(); showModal(false); });
    });
    const applyButton = $(DOM.apply);
    if (applyButton) applyButton.addEventListener('click', (event) => { event.preventDefault(); apply(); });
    const resetButton = $(DOM.reset);
    if (resetButton) {
      resetButton.addEventListener('click', (event) => { event.preventDefault(); if (!busy) resetFields(); });
    }
    const picker = $(DOM.target);
    if (picker) {
      picker.addEventListener('click', (event) => {
        const row = event.target && event.target.closest
          ? event.target.closest('.routing-dns-over-vless-option')
          : null;
        if (!row || !picker.contains(row)) return;
        if (row.getAttribute('aria-disabled') === 'true') return;
        toggleTarget(row.dataset.tag, picker.dataset.mode === 'multi');
      });
      picker.addEventListener('keydown', onPickerKeydown);
    }
    const selectAll = $(DOM.targetAll);
    if (selectAll) {
      selectAll.addEventListener('click', (event) => {
        event.preventDefault();
        if (busy) return;
        targetsTouched = true;
        chosenTargets = routePool.filter((item) => item && item.usable).map((item) => item.tag);
        if (status) render(status);
      });
    }
    const selectNone = $(DOM.targetNone);
    if (selectNone) {
      selectNone.addEventListener('click', (event) => {
        event.preventDefault();
        if (busy) return;
        targetsTouched = true;
        chosenTargets = [];
        if (status) render(status);
      });
    }
    [DOM.upstreams, DOM.local, DOM.zones, DOM.direct, DOM.directZones].forEach((id) => {
      const field = $(id);
      if (!field) return;
      field.addEventListener('input', () => {
        field.dataset.touched = '1';
        // Typing a resolver reveals the matching domain list straight away.
        if ((id === DOM.local || id === DOM.direct) && status) renderDnsFields(status);
        // Editing the list by hand must keep the group buttons honest.
        if (id === DOM.zones) renderZonePresets();
      });
    });
    const fromRules = $(DOM.directFromRules);
    if (fromRules) {
      fromRules.addEventListener('click', () => {
        const offered = (status && status.direct_rule_domains) || [];
        const field = $(DOM.directZones);
        if (!field || !offered.length) return;
        // The routing rules are the source of truth: resolving these names
        // directly is only useful because they already travel directly.
        field.value = offered.join(', ');
        field.dataset.touched = '1';
      });
    }
    const remoteBox = $(DOM.remote);
    if (remoteBox) {
      remoteBox.addEventListener('change', () => { remoteBox.dataset.touched = '1'; });
    }
    const passBox = $(DOM.pass);
    if (passBox) {
      passBox.addEventListener('change', () => {
        passBox.dataset.touched = '1';
        if (status) renderDnsFields(status);
      });
    }
    const passNodeBox = $(DOM.passNode);
    if (passNodeBox) {
      passNodeBox.addEventListener('change', () => { passNodeBox.dataset.touched = '1'; });
    }
    const captureBox = $(DOM.capture);
    if (captureBox) {
      captureBox.addEventListener('change', () => {
        captureBox.dataset.touched = '1';
        // Галочки у устройств живут только при включённом переключателе:
        // перерисуем список, чтобы это было видно, а не только на словах.
        if (lastClients) renderClients(lastClients);
      });
    }
    const multiBox = $(DOM.multi);
    if (multiBox) {
      multiBox.addEventListener('change', () => {
        // Switching modes drops a selection the other mode cannot express.
        multiTouched = true;
        targetsTouched = false;
        chosenTargets = [];
        if (status) render(status);
      });
    }
    const modal = $(DOM.modal);
    if (modal) modal.addEventListener('click', (event) => { if (event.target === modal && !busy) showModal(false); });
    // Клик по переключателю в подшапке меняет настройку, а не сворачивает зону.
    // <summary> сворачивает <details> от клика в любом своём месте, а
    // переключатели зон records/devices сидят внутри него.
    document.addEventListener('click', (event) => {
      const target = event.target;
      if (!target || !target.closest) return;
      if (target.closest('.xk-dns-zone-head .dt-switch')) event.stopPropagation();
    }, true);
    refresh();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
