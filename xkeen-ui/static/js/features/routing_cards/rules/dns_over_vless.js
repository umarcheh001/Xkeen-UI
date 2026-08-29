import { getXkeenCoreHttpApi } from '../../xkeen_runtime.js';
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
    local: 'routing-dns-over-vless-local',
    zones: 'routing-dns-over-vless-zones',
    zonesRow: 'routing-dns-over-vless-zones-row',
    zonePresets: 'routing-dns-over-vless-zone-presets',
  };

  let status = null;
  let busy = false;
  let chosenTargets = [];
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
    // An empty string is meaningful here: it switches the local exception off.
    if (local) settings.local_resolver = String(local.value || '').trim();
    const zones = $(DOM.zones);
    if (zones && settings.local_resolver) settings.local_domains = String(zones.value || '').trim();
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
    renderDnsFields(data);
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
      button.disabled = busy;
    });
    const reset = holder.querySelector('button[data-role="reset"]');
    if (reset) reset.disabled = busy;
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
    if (upstreams) upstreams.disabled = busy;
    if (local) local.disabled = busy;

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
      zones.disabled = busy;
    }
    if (hasLocal) renderZonePresets();
  }

  function renderFallback(candidate, multi, wanted) {
    const line = $(DOM.fallback);
    if (!line) return;
    if (multi) {
      line.classList.remove('hidden');
      const list = (wanted || []);
      if (list.length > 1) {
        line.dataset.state = 'kept';
        line.textContent = `Выбрано ${list.length}: ${list.join(', ')}. Панель создаст из них свой балансировщик; резервного маршрута у него нет.`;
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
    line.textContent = plan.kept
      ? `Резервирование сохранено: ${plan.reason}.`
      : `Резервирование не переносится: ${plan.reason}.`;
  }

  function plural(count, one, many) {
    const n = Math.abs(Number(count) || 0);
    return (n % 10 === 1 && n % 100 !== 11) ? one : many;
  }

  // Формулировка сторожа собирается из действующих настроек, а не из констант:
  // пользователь мог изменить их переменными окружения.
  function watchdogText(data) {
    const cfg = (data && data.watchdog_settings) || null;
    const core = coreOf(data);
    // Сторож один на обе защиты и следит за той, что включена. Пока
    // DNS-over-VLESS выключен, сторожить здесь нечего — обещать проверки
    // «каждые N секунд» было бы неправдой.
    if (core !== 'xray' && !(data && data.enabled)) {
      return {
        text: coreName(core)
          ? `Сторож общий для обоих ядер и следит за включённой защитой: сейчас это забота ядра ${coreName(core)}. Для DNS-over-VLESS он заступит, когда защиту включат под Xray.`
          : 'Сторож общий для обоих ядер и следит за включённой защитой. Для DNS-over-VLESS он заступит, когда защиту включат под Xray.',
        kind: 'ok',
      };
    }
    if (cfg && cfg.enabled === false) {
      return {
        text: 'Сторож отключён настройкой: если ядро упадёт, сеть останется без разрешения имён, пока вы не вмешаетесь вручную.',
        kind: 'warn',
      };
    }
    const interval = Math.round(Number(cfg && cfg.interval) || 30);
    const fails = Math.round(Number(cfg && cfg.fail_threshold) || 3);
    const restarts = Math.round(Number(cfg && cfg.restart_attempts) || 0);
    const tail = restarts > 0
      ? `перезапустит ядро (до ${restarts} ${plural(restarts, 'попытки', 'попыток')}), а если не поможет — вернёт DNS роутеру`
      : 'сразу вернёт DNS роутеру — перезапуски отключены настройкой';
    return {
      text: `Сторож проверяет ядро каждые ${interval} с; после ${fails} ${plural(fails, 'сбоя', 'сбоев')} подряд ${tail}.`,
      kind: 'ok',
    };
  }

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
      text.textContent = 'Настраивается он кнопкой «DNS» на вкладке Mihomo. Здесь собирается DNS-фрагмент для ядра Xray, поэтому включение доступно, только когда активно оно.';
      return;
    }
    if (!core || core === 'unknown') {
      title.textContent = 'Активное ядро не определено';
      text.textContent = 'Панель не смогла понять, какое ядро сейчас работает. DNS-over-VLESS настраивает только Xray — проверьте состояние служб и откройте окно снова.';
      return;
    }
    title.textContent = `Активно ядро ${core} — здесь настраивается только Xray`;
    text.textContent = 'DNS-over-VLESS собирает DNS-фрагмент для ядра Xray. Переключите активное ядро на Xray, чтобы включить защиту.';
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
        text: `DNS-фрагмент и правила Xray сохранены, однако запросы через них сейчас не идут: сеть обслуживает ядро ${otherCore}. Верните активным ядром Xray, чтобы защита снова работала, либо отключите её здесь и уберите служебную конфигурацию.`,
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
    if (flags.released && otherCore) {
      // Сторож один на обе защиты: увидев, что имена перестали разрешаться под
      // чужим ядром, он не перезапускает Xray (это была не авария), а сразу
      // отдаёт DNS прошивке и снимает служебную конфигурацию.
      return {
        badge: 'Защита снята',
        state: 'blocked',
        summary: `ядро сменили на ${otherCore}, DNS возвращён прошивке`,
        text: `После перехода на ${otherCore} разрешение имён через туннель Xray перестало отвечать, и сторож вернул DNS прошивке роутера — перезапускать Xray он не стал, потому что ядро сменили намеренно. Служебный DNS-фрагмент и правила при этом удалены, а запросы снова идут в открытом виде. Включить DNS-over-VLESS заново можно, вернув активным ядром Xray.`,
      };
    }
    if (flags.released) {
      return {
        badge: 'Отключено сторожем',
        state: 'blocked',
        summary: 'ядро не поднялось, DNS возвращён прошивке',
        text: 'Ядро Xray перестало отвечать, и сторож вернул разрешение имён прошивке роутера, чтобы сеть не осталась без интернета. Сейчас DNS-запросы идут в открытом виде. Разберитесь, почему упало ядро, и включите защиту заново — сама она не вернётся.',
      };
    }
    if (otherCore) {
      return {
        badge: 'Нужно ядро Xray',
        state: 'blocked',
        summary: `сейчас активно ядро ${otherCore}`,
        text: `DNS-over-VLESS готовит DNS-фрагмент и правила маршрутизации для Xray, поэтому с активным ядром ${otherCore} включать нечего. Имена сейчас разрешает штатный резолвер роутера. Переключите активное ядро на Xray, чтобы защита стала доступна.`,
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
    const released = !enabled && !!(data && data.watchdog && data.watchdog.reason);
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
            ? `Активное ядро: Mihomo. DNS-over-VLESS работает только с Xray. ${MIHOMO_HINT}`
            : `Активное ядро: ${coreName(core) || core || 'не определено'}. DNS-over-VLESS работает только с Xray.`),
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
      if (data.watchdog && data.watchdog.reason) {
        addDetail(`Сторож снял защиту: ${data.watchdog.reason} Порт 53 снова обслуживает прошивка роутера.`, 'warn');
      } else {
        const guard = watchdogText(data);
        addDetail(guard.text, guard.kind);
      }
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
    chosenTargets = [];
    multiTouched = false;
    targetsTouched = false;
    routePool = [];
    routeVisible = false;
    [DOM.upstreams, DOM.local, DOM.zones].forEach((id) => {
      const field = $(id);
      if (field) delete field.dataset.touched;
    });
    const text = $(DOM.status);
    const badge = $(DOM.badge);
    const apply = $(DOM.apply);
    if (text) text.textContent = 'Проверяем текущую конфигурацию…';
    if (badge) badge.textContent = 'Проверка…';
    if (apply) apply.disabled = true;
    await refresh();
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
    [DOM.close, DOM.cancel].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener('click', (event) => { event.preventDefault(); showModal(false); });
    });
    const applyButton = $(DOM.apply);
    if (applyButton) applyButton.addEventListener('click', (event) => { event.preventDefault(); apply(); });
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
    [DOM.upstreams, DOM.local, DOM.zones].forEach((id) => {
      const field = $(id);
      if (!field) return;
      field.addEventListener('input', () => {
        field.dataset.touched = '1';
        // Typing a local resolver reveals the zone list straight away.
        if (id === DOM.local && status) renderDnsFields(status);
        // Editing the list by hand must keep the group buttons honest.
        if (id === DOM.zones) renderZonePresets();
      });
    });
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
    refresh();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
