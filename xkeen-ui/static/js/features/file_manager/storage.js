import { getFileManagerNamespace } from '../file_manager_namespace.js';
import { iconHtml } from 'xk-core/js/ui/operator_icons.js';

(() => {
  'use strict';

  const FM = getFileManagerNamespace();
  const C = FM.common || {};
  const API = FM.api || {};
  const el = (id) => document.getElementById(id);
  const escape = (value) => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const size = (bytes) => {
    if (bytes == null || !Number.isFinite(Number(bytes))) return '—';
    let n = Number(bytes);
    const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n >= 10 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`;
  };

  let wired = false;
  let busy = false;
  let disks = [];
  let selected = null;
  let activityTimer = null;
  let activityStarted = 0;

  function activity(title, detail) {
    const panel = el('fm-volumes-progress');
    panel.classList.remove('hidden');
    el('fm-volumes-progress-title').textContent = title;
    el('fm-volumes-progress-detail').textContent = detail;
    if (!activityTimer) {
      activityStarted = Date.now();
      activityTimer = window.setInterval(() => {
        el('fm-volumes-progress-time').textContent = `${Math.floor((Date.now() - activityStarted) / 1000)} с`;
      }, 1000);
    }
  }

  function clearActivity() {
    window.clearInterval(activityTimer);
    activityTimer = null;
    el('fm-volumes-progress')?.classList.add('hidden');
    el('fm-volumes-progress-time').textContent = '';
  }

  function validLabel(value, fstype) {
    const text = String(value || '').trim();
    const max = /^ext[234]$/.test(fstype) ? 16 : fstype === 'vfat' ? 11 : 30;
    if (!text || new TextEncoder().encode(text).length > max || /[\x00-\x1f/\\]/.test(text)) {
      notify(`Метка ${fstype.toUpperCase()}: от 1 до ${max} байт, без / и \\.`, 'error');
      return false;
    }
    return true;
  }

  function notify(message, level = 'info') {
    if (typeof C.toast === 'function') C.toast(message, level);
  }

  function setBusy(value) {
    busy = !!value;
    el('fm-volumes-spinner')?.classList.toggle('hidden', !busy);
    el('fm-volumes-refresh-btn').disabled = busy;
    document.querySelectorAll('#fm-volumes-list button, #fm-volumes-action button, #fm-volumes-action input, #fm-volumes-action select')
      .forEach((item) => { item.disabled = busy || item.dataset.staticDisabled === '1'; });
  }

  function partButton(action, label, di, pi, disabled = false, title = '') {
    const icons = { open: 'open', mount: 'play', unmount: 'stop', check: 'validate',
      label: 'edit', format: 'format', repartition: 'list-details', eject: 'detach',
      add: 'file-add', delete: 'trash', split: 'list-details', merge: 'replace', more: 'more' };
    const tone = ['format', 'repartition', 'delete', 'split', 'merge'].includes(action) ? 'is-danger'
      : ['unmount', 'eject'].includes(action) ? 'is-caution' : '';
    return `<button type="button" class="btn-secondary fm-volume-icon-btn fm-volume-text-btn ${tone}" data-act="${action}" data-di="${di}" data-pi="${pi}" ${disabled ? 'disabled data-static-disabled="1"' : ''} title="${escape(title || label)}">${iconHtml(icons[action])}<span>${escape(label)}</span></button>`;
  }

  function render() {
    const box = el('fm-volumes-list');
    if (!box) return;
    if (!disks.length) {
      box.innerHTML = '<div class="status">USB-накопители не найдены.</div>';
      return;
    }
    box.innerHTML = disks.map((disk, di) => {
      const name = [disk.manufacturer, disk.product].filter(Boolean).join(' ') || disk.id;
      const location = [disk.port ? `Порт ${disk.port}` : '', disk.version ? `USB ${disk.version}` : ''].filter(Boolean).join(' · ');
      const eject = partButton('eject', 'Безопасно извлечь', di, -1,
        disk.protected || !disk.ejectable, disk.protected ? 'На накопителе работает OPKG' : 'Безопасно извлечь накопитель');
      const repartition = partButton('repartition', 'Разметить', di, -1,
        !disk.partitionable, disk.protected ? 'На накопителе работает OPKG'
          : !disk.partitionable ? 'Разметка недоступна: проверьте утилиту parted и использование накопителя'
          : 'Создать новую таблицу разделов');
      const add = partButton('add', 'Добавить', di, -1, !disk.free_ranges?.length,
        disk.free_ranges?.length ? 'Создать раздел в свободной области' : 'Нет свободной области от 64 МиБ');
      const rows = (disk.partitions || []).map((part, pi) => {
        const mounted = part.state === 'mounted';
        const protectedPart = !!part.protected;
        const working = ['formatting', 'checking', 'mounting', 'unmounting'].includes(part.state);
        const used = part.total != null && part.free != null ? Math.max(0, part.total - part.free) : null;
        const fill = part.total ? Math.min(100, Math.round(100 * used / part.total)) : 0;
        const status = protectedPart ? 'OPKG · защищён' : part.state === 'mounted' ? 'Подключён' : part.state === 'unmounted' ? 'Отключён' : part.state || '—';
        const labelHint = !part.label_tool ? 'Смена метки не поддерживается' : !part.label_available ? `Нужна утилита ${part.label_tool}` : mounted ? 'Сначала отключите раздел' : 'Изменить метку';
        const actions = [
          mounted && part.mountpoint ? partButton('open', 'Открыть', di, pi) : '',
          partButton(mounted ? 'unmount' : 'mount', mounted ? 'Отключить' : 'Подключить', di, pi,
            working || !part.uuid || (protectedPart && mounted), !part.uuid ? 'Сначала отформатируйте раздел' : protectedPart ? 'На разделе работает OPKG' : ''),
          partButton('format', 'Форматировать', di, pi, working || protectedPart || !part.format_types?.length,
            protectedPart ? 'На разделе работает OPKG' : 'Удалить все данные раздела'),
          partButton('more', 'Ещё', di, pi),
        ].filter(Boolean).join('');
        const neighbor = disk.partitions?.find((candidate) => candidate !== part && candidate?.empty && part.empty
          && (candidate.end_sector + 1 === part.start_sector || part.end_sector + 1 === candidate.start_sector));
        const secondary = [
          partButton('check', 'Проверить', di, pi, working || protectedPart || !part.check_supported,
            protectedPart ? 'На разделе работает OPKG' : 'Проверить файловую систему'),
          partButton('label', 'Метка', di, pi, working || protectedPart || mounted || !part.label_available, labelHint),
          partButton('delete', 'Удалить', di, pi, protectedPart || mounted || !!part.used_by?.length || !disk.partitionable,
            mounted ? 'Сначала отключите раздел' : 'Удалить раздел и все его данные'),
          partButton('split', 'Разделить', di, pi, !disk.partitionable || !part.empty ||
            (part.end_sector - part.start_sector + 1) * (disk.sector_size || 512) < 128 * 1048576,
          'Можно разделить только пустой подключённый том'),
          partButton('merge', 'Объединить', di, pi, !disk.partitionable || !neighbor,
            'Можно объединить соседние пустые тома'),
        ].join('');
        return `<tr>
          <td><strong>${escape(part.label || part.partition_id)}</strong><small>${escape(part.partition_id)} · ${escape(part.uuid)}</small>${part.label_pending ? '<small class="fm-volume-pending">Имя в прошивке обновится после переподключения USB</small>' : ''}</td>
          <td>${escape((part.fstype || '—').toUpperCase())}</td>
          <td><div>${size(part.total)}</div><div class="fm-volume-meter"><span style="width:${fill}%"></span></div><small>${used == null ? '—' : `${size(used)} занято`}</small></td>
          <td>${escape((part.used_by || []).join(', ') || '—')}</td>
          <td><span class="fm-volumes-state ${mounted ? 'is-mounted' : 'is-unmounted'}">${escape(status)}</span></td>
          <td><div class="fm-volume-actions">${actions}</div></td>
        </tr><tr class="fm-volume-extra" hidden><td colspan="6"><div class="fm-volume-extra-actions">${secondary}</div></td></tr>`;
      }).join('');
      return `<section class="fm-volume-disk" aria-label="${escape(name)}">
        <div class="fm-volume-disk-head"><div><strong>${escape(name)}</strong><span>${escape(disk.id)} · ${size(disk.size)}${location ? ` · ${escape(location)}` : ''}</span></div><div class="fm-volume-disk-actions">${add}${repartition}${eject}</div></div>
        <div class="fm-volume-table-wrap"><table class="fm-volumes-table"><thead><tr><th>Раздел</th><th>Тип</th><th>Объём</th><th>Используется</th><th>Состояние</th><th>Действия</th></tr></thead><tbody>${rows || '<tr><td colspan="6">Разделы не обнаружены.</td></tr>'}</tbody></table></div>
      </section>`;
    }).join('');
    setBusy(busy);
  }

  async function refresh({ silent = false } = {}) {
    if (busy && !silent) return false;
    if (!silent) setBusy(true);
    const summary = el('fm-volumes-summary');
    if (!silent) summary.textContent = 'Обновление…';
    try {
      const data = await API.fetchJsonOk('/api/storage/usb', { method: 'GET' }, { feature: 'storageUsb', op: 'list' });
      disks = Array.isArray(data.disks) ? data.disks : [];
      render();
      summary.textContent = `${disks.length} накопителей · ${disks.reduce((n, d) => n + (d.partitions || []).length, 0)} разделов`;
      return true;
    } catch (error) {
      if (!silent) {
        summary.textContent = 'Ошибка загрузки';
        el('fm-volumes-list').textContent = error.message || 'Не удалось получить список накопителей.';
      }
      return false;
    } finally {
      if (!silent) setBusy(false);
    }
  }

  function closeAction() {
    selected = null;
    el('fm-volumes-modal')?.classList.remove('fm-volumes-editing');
    const panel = el('fm-volumes-action');
    panel.classList.add('hidden');
    panel.replaceChildren();
  }

  function openAction(action, di, pi) {
    const part = disks[di]?.partitions?.[pi];
    if (!part || part.protected) return;
    selected = { action, di, pi, uuid: part.uuid };
    const panel = el('fm-volumes-action');
    if (action === 'format') {
      selected.labelableTypes = part.labelable_format_types || (part.label_available ? [part.fstype] : []);
      panel.innerHTML = `<form id="fm-volume-form"><div class="fm-volume-form-head"><strong>Форматирование: ${escape(part.label || part.partition_id)}</strong><button type="button" class="btn-secondary btn-icon fm-volume-icon-btn" data-close-action="1" aria-label="Закрыть" title="Закрыть">${iconHtml('close')}</button></div>
        <label>Файловая система<select name="fstype">${part.format_types.map((type) => `<option value="${escape(type)}" ${type === part.fstype ? 'selected' : ''}>${escape(type.toUpperCase())}</option>`).join('')}</select></label>
        <label>Метка тома<input name="label" value="${escape(part.label)}" maxlength="30" autocomplete="off"></label><span class="fm-volume-label-hint" data-label-hint></span>
        <label>Для подтверждения введите ${escape(part.label || part.partition_id)}<input name="confirmation" autocomplete="off" required></label>
        <div class="fm-volume-form-footer"><span>Все данные раздела будут удалены.</span><button type="submit" class="btn-secondary fm-volume-commit is-danger">${iconHtml('format')}<span>Форматировать</span></button></div></form>`;
    } else {
      panel.innerHTML = `<form id="fm-volume-form"><div class="fm-volume-form-head"><strong>Метка: ${escape(part.label || part.partition_id)}</strong><button type="button" class="btn-secondary btn-icon fm-volume-icon-btn" data-close-action="1" aria-label="Закрыть" title="Закрыть">${iconHtml('close')}</button></div>
        <label>Новая метка<input name="label" value="${escape(part.label)}" maxlength="30" required autocomplete="off"></label>
        <div class="fm-volume-form-footer"><span>${escape(part.fstype.toUpperCase())} · ${escape(part.label_tool)}</span><button type="submit" class="btn-secondary fm-volume-commit">${iconHtml('save')}<span>Сохранить</span></button></div></form>`;
    }
    panel.classList.remove('hidden');
    if (action === 'format') syncFormatLabel();
    panel.querySelector('input')?.focus();
  }

  function syncFormatLabel() {
    if (selected?.action !== 'format') return;
    const panel = el('fm-volumes-action');
    const fstype = panel.querySelector('[name="fstype"]').value;
    const available = selected.labelableTypes.includes(fstype);
    const input = panel.querySelector('[name="label"]');
    input.dataset.staticDisabled = available ? '0' : '1';
    input.disabled = !available;
    panel.querySelector('[data-label-hint]').textContent = available
      ? '' : 'Утилита смены метки для этой файловой системы не установлена.';
  }

  const partitionTones = ['accent', 'success', 'warning', 'neutral'];

  function partitionRows(count) {
    return Array.from({ length: count }, (_, index) => {
      const head = `<div class="fm-layout-row-head"><i class="fm-layout-swatch is-${partitionTones[index]}"></i><strong>Раздел ${index + 1}</strong><output data-partition-size="${index}"></output></div>`;
      const option = selected.layoutOptions[index];
      const format = `<div class="fm-layout-row-options"><label>Файловая система<select data-format-type="${index}" aria-label="Файловая система раздела ${index + 1}">${selected.formatTypes.map((type) => `<option value="${escape(type)}" ${type === option.fstype ? 'selected' : ''}>${escape(type.toUpperCase())}</option>`).join('')}</select></label><label>Метка тома<input data-volume-label="${index}" aria-label="Метка раздела ${index + 1}" value="${escape(option.label)}" maxlength="30" required autocomplete="off"></label></div>`;
      const sizing = index === count - 1
        ? '<span class="fm-layout-remainder">Оставшееся место</span>'
        : `<div class="fm-layout-row-controls"><input type="range" data-size-range="${index}" min="64" step="16" aria-label="Размер раздела ${index + 1}"><label>ГБ<input type="number" name="size_gib" data-size-input="${index}" min="0.0625" step="any" required aria-label="Размер раздела ${index + 1}, ГБ"></label></div>`;
      return `<div class="fm-layout-row ${index === count - 1 ? 'is-remainder' : ''}" data-partition-row="${index}">${head}${sizing}${format}</div>`;
    }).join('');
  }

  function syncPartitionEditor() {
    if (selected?.action !== 'repartition') return;
    const sizes = selected.sizesMiB;
    const remaining = selected.totalMiB - sizes.reduce((sum, amount) => sum + amount, 0);
    const amounts = [...sizes, remaining];
    const panel = el('fm-volumes-action');
    panel.querySelector('#fm-volume-layout-bar').innerHTML = amounts.map((amount, index) => {
      const percent = Math.max(0, 100 * amount / selected.totalMiB);
      return `<span class="fm-layout-segment is-${partitionTones[index]}" style="width:${percent}%" title="Раздел ${index + 1}: ${size(amount * 1048576)}">${percent > 8 ? index + 1 : ''}</span>`;
    }).join('');
    amounts.forEach((amount, index) => {
      panel.querySelector(`[data-partition-size="${index}"]`).textContent = size(amount * 1048576);
      if (index === sizes.length) return;
      const max = selected.totalMiB - 64 - sizes.reduce((sum, value, other) => sum + (other === index ? 0 : value), 0);
      const slider = panel.querySelector(`[data-size-range="${index}"]`);
      const input = panel.querySelector(`[data-size-input="${index}"]`);
      slider.max = String(max);
      slider.value = String(amount);
      slider.style.setProperty('--fm-range-fill', `${max === 64 ? 100 : 100 * (amount - 64) / (max - 64)}%`);
      input.max = String((max / 1024).toFixed(4));
      input.value = String(Number((amount / 1024).toFixed(2)));
    });
  }

  function setPartitionCount(count) {
    if (selected?.action !== 'repartition' || ![1, 2, 3, 4].includes(count) || selected.totalMiB < count * 64) return;
    const panel = el('fm-volumes-action');
    const previous = Array.from(panel.querySelectorAll('[data-partition-row]'), (row) => ({
      fstype: row.querySelector('[data-format-type]').value,
      label: row.querySelector('[data-volume-label]').value,
    }));
    selected.layoutOptions = Array.from({ length: count }, (_, index) => previous[index]
      || { fstype: selected.formatTypes[0], label: `DATA${index + 1}` });
    const share = Math.max(64, Math.floor(selected.totalMiB / count / 16) * 16);
    selected.sizesMiB = Array(count - 1).fill(share);
    panel.querySelectorAll('[data-count]').forEach((button) => {
      button.setAttribute('aria-pressed', String(Number(button.dataset.count) === count));
    });
    panel.querySelector('#fm-volume-partition-fields').innerHTML = partitionRows(count);
    panel.querySelector('.fm-volume-commit span').textContent = count === 1 ? 'Создать раздел' : 'Создать разделы';
    syncPartitionEditor();
  }

  function setPartitionSize(index, amount) {
    if (selected?.action !== 'repartition' || !Number.isFinite(amount)) return;
    const sizes = selected.sizesMiB;
    if (index < 0 || index >= sizes.length) return;
    const other = sizes.reduce((sum, value, position) => sum + (position === index ? 0 : value), 0);
    sizes[index] = Math.min(selected.totalMiB - other - 64, Math.max(64, Math.round(amount / 16) * 16));
    syncPartitionEditor();
  }

  function openDiskAction(di) {
    const disk = disks[di];
    if (!disk?.partitionable) return;
    const totalMiB = Math.floor((disk.size || 0) / 1048576) - 3;
    if (totalMiB < 128) return;
    const formatTypes = [...new Set(disk.partitions.flatMap((part) => part.labelable_format_types
      || (part.label_available ? [part.fstype] : [])))].filter(Boolean);
    selected = {
      action: 'repartition', di, serial: disk.serial,
      expectedParts: disk.partitions.map((part) => ({ partition_id: part.partition_id, uuid: part.uuid })),
      totalMiB, sizesMiB: [], formatTypes: formatTypes.length ? formatTypes : ['ext4'], layoutOptions: [],
    };
    el('fm-volumes-modal')?.classList.add('fm-volumes-editing');
    const panel = el('fm-volumes-action');
    const name = [disk.manufacturer, disk.product].filter(Boolean).join(' ') || disk.id;
    panel.innerHTML = `<form id="fm-volume-form" class="fm-layout-form">
      <div class="fm-layout-heading"><button type="button" class="btn-secondary btn-icon fm-volume-icon-btn" data-close-action="1" aria-label="Назад к накопителям" title="Назад к накопителям">${iconHtml('back')}</button><div><strong>${escape(name)}</strong><span>${escape(disk.id)} · ${size(disk.size)}</span></div></div>
      <div class="fm-layout-settings"><fieldset><legend>Количество разделов</legend><div class="fm-layout-count" role="group" aria-label="Количество разделов">${[1, 2, 3, 4].map((count) => `<button type="button" data-count="${count}" aria-pressed="${count === 1}" ${totalMiB < count * 64 ? 'disabled data-static-disabled="1"' : ''}>${count}</button>`).join('')}</div></fieldset><span>Доступно: ${size(totalMiB * 1048576)}</span></div>
      <div class="fm-layout-editor"><div id="fm-volume-layout-bar" class="fm-layout-bar" role="img" aria-label="Схема разделов"></div><div id="fm-volume-partition-fields" class="fm-layout-rows"></div></div>
      <div class="fm-layout-bottom"><div class="fm-layout-warning">${iconHtml('alert')}<span>Все данные на ${escape(name)} будут удалены.</span></div><label>Для подтверждения введите ${escape(disk.id)}<input name="confirmation" autocomplete="off" required></label><div class="fm-layout-footer"><button type="button" class="btn-secondary" data-close-action="1">Отмена</button><button type="submit" class="btn-secondary fm-volume-commit is-danger">${iconHtml('list-details')}<span>Создать разделы</span></button></div></div>
    </form>`;
    panel.classList.remove('hidden');
    setPartitionCount(1);
    panel.querySelector('[data-count="1"]')?.focus();
  }

  function openStructureAction(action, di, pi) {
    const disk = disks[di];
    const part = disk?.partitions?.[pi];
    if (!disk?.partitionable || (action !== 'add' && !part)) return;
    const name = [disk.manufacturer, disk.product].filter(Boolean).join(' ') || disk.id;
    const free = disk.free_ranges || [];
    const neighbors = action === 'merge' ? disk.partitions.filter((candidate) => candidate !== part
      && candidate.empty && part.empty && (candidate.end_sector + 1 === part.start_sector
        || part.end_sector + 1 === candidate.start_sector)) : [];
    if (action === 'add' && !free.length || action === 'merge' && !neighbors.length) return;
    const formatTypes = [...new Set(disk.partitions.flatMap((item) => item.labelable_format_types || []))];
    if (!formatTypes.length) formatTypes.push('ext4');
    const firstFree = free[0];
    const sectorsMiB = 1048576 / (disk.sector_size || 512);
    const alignedStart = action === 'add' ? Math.ceil(firstFree.start_sector / sectorsMiB) * sectorsMiB : 0;
    const maxMiB = action === 'add' ? Math.floor((firstFree.end_sector - alignedStart + 1) / sectorsMiB)
      : action === 'split' ? Math.floor((part.end_sector - part.start_sector + 1) / sectorsMiB) - 64 : 0;
    const initialMiB = Math.max(64, Math.floor(maxMiB / 2 / 16) * 16);
    const titles = { add: 'Добавить раздел', delete: 'Удалить раздел', split: 'Разделить пустой том', merge: 'Объединить пустые тома' };
    const detail = action === 'add' ? 'Новый раздел появится в свободной области.'
      : action === 'delete' ? `Раздел ${part.label || part.partition_id} и все его данные будут удалены.`
      : action === 'split' ? `Том ${part.label || part.partition_id} будет заменён двумя новыми разделами.`
      : 'Оба тома будут заменены одним разделом. Их содержимое будет удалено.';
    selected = { action, di, pi, serial: disk.serial, uuid: part?.uuid,
      expectedParts: disk.partitions.map((item) => ({ partition_id: item.partition_id, uuid: item.uuid })),
      formatTypes, maxMiB, initialMiB, free };
    const options = (index) => `<div class="fm-layout-row-options"><label>Файловая система<select data-format-type="${index}">${formatTypes.map((type) => `<option value="${escape(type)}">${escape(type.toUpperCase())}</option>`).join('')}</select></label><label>Метка тома<input data-volume-label="${index}" value="DATA${index + 1}" maxlength="30" required autocomplete="off"></label></div>`;
    const range = `<div class="fm-layout-row-controls"><input type="range" data-structure-range min="64" max="${maxMiB}" step="16" value="${initialMiB}" aria-label="Размер первого раздела"><label>ГБ<input type="number" data-structure-size min="0.0625" max="${(maxMiB / 1024).toFixed(3)}" step="any" value="${(initialMiB / 1024).toFixed(2)}" required></label></div>`;
    const region = action === 'add' ? `<label class="fm-structure-field">Свободная область<select name="start_sector">${free.map((item) => `<option value="${item.start_sector}">${size(item.size_bytes)} · сектор ${item.start_sector}</option>`).join('')}</select></label>` : '';
    const neighbor = action === 'merge' ? `<label class="fm-structure-field">Соседний пустой том<select name="other_id">${neighbors.map((item) => `<option value="${escape(item.partition_id)}">${escape(item.label || item.partition_id)} · ${size(item.total)}</option>`).join('')}</select></label>` : '';
    const editor = action === 'delete' ? '' : `<div class="fm-layout-editor">${region}${neighbor}
      ${action === 'split' || action === 'add' ? `<div class="fm-layout-row"><div class="fm-layout-row-head"><i class="fm-layout-swatch is-accent"></i><strong>${action === 'add' ? 'Новый раздел' : 'Раздел 1'}</strong><output data-structure-output>${size(initialMiB * 1048576)}</output></div>${range}${options(0)}</div>` : `<div class="fm-layout-row">${options(0)}</div>`}
      ${action === 'split' ? `<div class="fm-layout-row"><div class="fm-layout-row-head"><i class="fm-layout-swatch is-success"></i><strong>Раздел 2</strong><output data-structure-remainder></output></div><span class="fm-layout-remainder">Оставшееся место</span>${options(1)}</div>` : ''}
      </div>`;
    el('fm-volumes-modal')?.classList.add('fm-volumes-editing');
    const panel = el('fm-volumes-action');
    panel.innerHTML = `<form id="fm-volume-form" class="fm-layout-form"><div class="fm-layout-heading"><button type="button" class="btn-secondary btn-icon fm-volume-icon-btn" data-close-action="1" aria-label="Назад" title="Назад">${iconHtml('back')}</button><div><strong>${titles[action]}</strong><span>${escape(name)} · ${escape(disk.id)}</span></div></div>
      ${editor}<div class="fm-layout-bottom"><div class="fm-layout-warning">${iconHtml('alert')}<span>${escape(detail)}</span></div><label>Для подтверждения введите ${escape(disk.id)}<input name="confirmation" autocomplete="off" required></label><div class="fm-layout-footer"><button type="button" class="btn-secondary" data-close-action="1">Отмена</button><button type="submit" class="btn-secondary fm-volume-commit ${action === 'add' ? '' : 'is-danger'}">${iconHtml(action === 'delete' ? 'trash' : action === 'add' ? 'file-add' : 'list-details')}<span>${titles[action]}</span></button></div></div></form>`;
    panel.classList.remove('hidden');
    syncStructureEditor();
  }

  function syncStructureEditor() {
    if (!selected || !['add', 'split'].includes(selected.action)) return;
    const panel = el('fm-volumes-action');
    const range = panel.querySelector('[data-structure-range]');
    const input = panel.querySelector('[data-structure-size]');
    const amount = Math.min(selected.maxMiB, Math.max(64, Math.round(Number(range.value) / 16) * 16));
    range.value = String(amount);
    input.value = String(Number((amount / 1024).toFixed(2)));
    panel.querySelector('[data-structure-output]').textContent = size(amount * 1048576);
    const remainder = panel.querySelector('[data-structure-remainder]');
    if (remainder) remainder.textContent = size((selected.maxMiB + 64 - amount) * 1048576);
  }

  function selectFreeRange(startSector) {
    if (selected?.action !== 'add') return;
    const disk = disks[selected.di];
    const free = selected.free.find((item) => item.start_sector === startSector);
    if (!free) return;
    const sectorsMiB = 1048576 / (disk.sector_size || 512);
    const aligned = Math.ceil(free.start_sector / sectorsMiB) * sectorsMiB;
    selected.maxMiB = Math.floor((free.end_sector - aligned + 1) / sectorsMiB);
    const panel = el('fm-volumes-action');
    const range = panel.querySelector('[data-structure-range]');
    range.max = String(selected.maxMiB);
    range.value = String(selected.maxMiB);
    panel.querySelector('[data-structure-size]').max = String((selected.maxMiB / 1024).toFixed(3));
    syncStructureEditor();
  }

  async function openPath(path) {
    const state = FM.state?.S;
    const side = state?.activeSide === 'right' ? 'right' : 'left';
    const target = state?.panels?.[side];
    if (!target || !path) return;
    target.target = 'local';
    target.cwd = path;
    const panel = FM.state.panelDom?.(side);
    if (panel?.pathInput) panel.pathInput.value = path;
    await FM.listing?.listPanel?.(side, { fromInput: true });
    C.modalClose?.(el('fm-volumes-modal'));
  }

  async function post(action, payload) {
    const data = await API.fetchJsonOk(`/api/storage/usb/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    }, { feature: 'storageUsb', op: action });
    return data;
  }

  const workingStates = ['formatting', 'checking', 'mounting', 'unmounting'];
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function currentDisk(disk) {
    const current = disks.find((item) => item.id === disk.id && item.serial === disk.serial);
    if (!current) throw new Error('Накопитель отключён или заменён. Проверьте его состояние.');
    return current;
  }

  async function waitFor(disk, predicate, detail, attempts = 45) {
    activity('Операция выполняется', detail);
    for (let attempt = 0; attempt < attempts; attempt++) {
      await pause(2000);
      if (!await refresh({ silent: true })) continue;
      const updated = disks.find((item) => item.id === disk.id);
      if (updated && updated.serial !== disk.serial) throw new Error('Накопитель заменён во время операции.');
      if (!updated) continue;
      const result = predicate(updated);
      if (result) return result;
    }
    throw new Error(`${detail}: прошивка пока не подтвердила завершение. Обновите список перед повторной операцией.`);
  }

  async function formatWithLabel(disk, part, fstype, label, detail) {
    const current = currentDisk(disk).partitions.find((item) => item.partition_id === part.partition_id);
    if (!current || current.uuid !== part.uuid) throw new Error('Состав накопителя изменился. Обновите список.');
    if (!current.format_types?.includes(fstype)) throw new Error(`${detail}: файловая система ${fstype.toUpperCase()} недоступна.`);
    if (label && !current.labelable_format_types?.includes(fstype)) {
      throw new Error(`${detail}: утилита для метки ${fstype.toUpperCase()} недоступна.`);
    }
    activity('Форматирование', detail);
    await post('format', { media_id: disk.id, partition_id: part.partition_id, uuid: part.uuid,
      fstype, confirm: `FORMAT ${disk.id}/${part.partition_id}` });
    let sawWorking = false;
    const formatted = await waitFor(disk, (updatedDisk) => {
      const updated = updatedDisk.partitions.find((item) => item.partition_id === part.partition_id);
      if (workingStates.includes(updated?.state)) sawWorking = true;
      const changed = updated?.uuid !== part.uuid || sawWorking
        || (!label && updated?.fstype === fstype && part.fstype !== fstype);
      return updated && !workingStates.includes(updated.state) && changed
        && (!label || updated.uuid) ? updated : null;
    }, `${detail}: ожидание новой файловой системы`);
    if (!label) return;
    if (formatted.state === 'mounted') {
      activity('Отключение раздела', detail);
      await post('unmount', { media_id: disk.id, partition_id: part.partition_id, uuid: formatted.uuid });
      await waitFor(disk, (updatedDisk) => {
        const updated = updatedDisk.partitions.find((item) => item.partition_id === part.partition_id);
        return updated?.uuid === formatted.uuid && updated.state === 'unmounted' ? updated : null;
      }, `${detail}: ожидание отключения`);
    } else if (formatted.state !== 'unmounted') {
      throw new Error(`${detail}: файловая система ещё не готова к записи метки.`);
    }
    activity('Запись метки', `${detail} · ${label}`);
    await post('label', { media_id: disk.id, partition_id: part.partition_id, uuid: formatted.uuid, label });
    if (formatted.state === 'mounted') {
      activity('Подключение раздела', detail);
      await post('mount', { media_id: disk.id, partition_id: part.partition_id, uuid: formatted.uuid });
      await waitFor(disk, (updatedDisk) => updatedDisk.partitions.find((item) =>
        item.partition_id === part.partition_id && item.uuid === formatted.uuid && item.state === 'mounted'),
      `${detail}: ожидание подключения`, 15);
    }
  }

  async function createLayout(disk, payload, options) {
    activity('Создание таблицы разделов', `${options.length} разделов`);
    await post('repartition', payload);
    const before = JSON.stringify(payload.expected_parts.map((part) => [part.partition_id, part.uuid]).sort());
    const created = await waitFor(disk, (updatedDisk) => {
      const parts = updatedDisk.partitions;
      const signature = JSON.stringify(parts.map((part) => [part.partition_id, part.uuid]).sort());
      return parts.length === options.length && signature !== before ? [...parts].sort((a, b) =>
        Number(a.partition_id.match(/\d+$/)?.[0] || 0) - Number(b.partition_id.match(/\d+$/)?.[0] || 0)) : null;
    }, 'Ожидание новых разделов');
    for (const [index, part] of created.entries()) {
      const option = options[index];
      await formatWithLabel(disk, part, option.fstype, option.label, `Раздел ${index + 1} из ${options.length}`);
    }
  }

  async function changeStructure(action, disk, payload, options) {
    const previous = new Map(disk.partitions.map((part) => [part.partition_id, part.uuid]));
    activity('Изменение разделов', `${action === 'delete' ? 'Удаление' : action === 'split' ? 'Деление' : action === 'merge' ? 'Объединение' : 'Создание'} · ${disk.product || disk.id}`);
    const response = await post(action, payload);
    if (action === 'delete') {
      await waitFor(disk, (updated) => !updated.partitions.some((part) =>
        part.partition_id === payload.partition_id && part.uuid === payload.uuid), 'Ожидание удаления раздела');
      return response;
    }
    const ids = response.created_partition_ids || [];
    if (ids.length !== options.length) throw new Error('Таблица создана, но список новых разделов неполон. Обновите список.');
    const created = await waitFor(disk, (updated) => {
      const parts = ids.map((id) => updated.partitions.find((part) => part.partition_id === id));
      return parts.every((part) => part && part.uuid !== previous.get(part.partition_id)) ? parts : null;
    }, 'Ожидание новых разделов');
    for (const [index, part] of created.entries()) {
      await formatWithLabel(disk, part, options[index].fstype, options[index].label,
        `Раздел ${index + 1} из ${options.length}`);
    }
    return { message: 'Разделы созданы, отформатированы и подписаны.',
      remount_failed: response.remount_failed || [] };
  }

  async function run(action, di, pi, extra = {}) {
    if (busy) return;
    const disk = disks[di];
    const part = disk?.partitions?.[pi];
    if (!disk || (!['eject', 'repartition', 'add'].includes(action) && !part)) return;
    const { layout_options: layoutOptions, label: desiredLabel, ...requestExtra } = extra;
    const payload = ['repartition', 'add', 'delete', 'split', 'merge'].includes(action)
      ? { media_id: disk.id, serial: disk.serial, ...requestExtra }
      : action === 'eject'
      ? { media_id: disk.id, serial: disk.serial }
      : { media_id: disk.id, partition_id: part.partition_id, uuid: part.uuid,
        ...requestExtra, ...(action === 'label' ? { label: desiredLabel } : {}) };
    setBusy(true);
    try {
      let result;
      if (action === 'repartition') {
        await createLayout(disk, payload, layoutOptions);
        result = { message: 'Разделы созданы, отформатированы и подписаны.' };
      } else if (['add', 'delete', 'split', 'merge'].includes(action)) {
        result = await changeStructure(action, disk, payload, layoutOptions || []);
      } else if (action === 'format') {
        await formatWithLabel(disk, part, payload.fstype, desiredLabel, part.label || part.partition_id);
        result = { message: desiredLabel ? 'Форматирование и запись метки завершены.' : 'Форматирование завершено.' };
      } else {
        activity('Операция выполняется', action === 'label' ? 'Запись метки' : part?.label || disk.product || disk.id);
        result = await post(action, payload);
        if (action === 'mount' || action === 'unmount') {
          const targetState = action === 'mount' ? 'mounted' : 'unmounted';
          await waitFor(disk, (updatedDisk) => updatedDisk.partitions.find((item) =>
            item.partition_id === part.partition_id && item.uuid === part.uuid && item.state === targetState),
          `Ожидание ${action === 'mount' ? 'подключения' : 'отключения'} раздела`, 15);
        }
      }
      closeAction();
      const remountWarning = result.remount_failed?.length
        ? ` Не удалось вновь подключить ${result.remount_failed.join(', ')}. Подключите вручную.` : '';
      notify((result.label_pending ? 'Метка записана. Имя в прошивке обновится после переподключения USB.'
        : result.message || 'Операция выполнена') + remountWarning,
      remountWarning ? 'warning' : 'success');
      await refresh({ silent: true });
      FM.listing?.refreshAll?.();
    } catch (error) {
      closeAction();
      notify([error.message, error.hint].filter(Boolean).join(' '), 'error');
      el('fm-volumes-summary').textContent = [error.message, error.hint].filter(Boolean).join(' ');
      await refresh({ silent: true });
    } finally {
      clearActivity();
      setBusy(false);
    }
  }

  async function handleListClick(event) {
    const button = event.target.closest('button[data-act]');
    if (!button || busy || button.disabled) return;
    const di = Number(button.dataset.di);
    const pi = Number(button.dataset.pi);
    const action = button.dataset.act;
    const disk = disks[di];
    const part = disk?.partitions?.[pi];
    if (action === 'more') {
      const row = button.closest('tr')?.nextElementSibling;
      if (row?.classList.contains('fm-volume-extra')) {
        row.hidden = !row.hidden;
        button.setAttribute('aria-expanded', String(!row.hidden));
      }
      return;
    }
    if (action === 'open') return openPath(part?.mountpoint);
    if (action === 'repartition') return openDiskAction(di);
    if (['add', 'delete', 'split', 'merge'].includes(action)) return openStructureAction(action, di, pi);
    if (action === 'format' || action === 'label') return openAction(action, di, pi);
    if (action === 'eject' || action === 'unmount' || action === 'check') {
      const name = action === 'eject' ? disk?.product : part?.label || part?.partition_id;
      const title = action === 'eject' ? 'Извлечь накопитель' : action === 'check' ? 'Проверить раздел' : 'Отключить раздел';
      const ok = await C.confirm?.({ title, message: `${title}: ${name}?`, okText: 'Продолжить', cancelText: 'Отмена' });
      if (!ok) return;
    }
    run(action, di, pi);
  }

  function init() {
    if (wired) return;
    wired = true;
    el('fm-volumes-btn')?.addEventListener('click', () => {
      closeAction();
      C.modalOpen?.(el('fm-volumes-modal'));
      refresh();
    });
    el('fm-volumes-close-btn')?.addEventListener('click', () => {
      closeAction();
      C.modalClose?.(el('fm-volumes-modal'));
    });
    el('fm-volumes-refresh-btn')?.addEventListener('click', () => refresh());
    el('fm-volumes-list')?.addEventListener('click', handleListClick);
    el('fm-volumes-action')?.addEventListener('click', (event) => {
      if (event.target.closest('[data-close-action]')) return closeAction();
      const countButton = event.target.closest('[data-count]');
      if (countButton && !busy) setPartitionCount(Number(countButton.dataset.count));
    });
    el('fm-volumes-action')?.addEventListener('input', (event) => {
      if (event.target.matches('[data-size-range]') && !busy) {
        setPartitionSize(Number(event.target.dataset.sizeRange), Number(event.target.value));
      }
      if (event.target.matches('[data-structure-range]') && !busy) syncStructureEditor();
    });
    el('fm-volumes-action')?.addEventListener('change', (event) => {
      if (event.target.matches('[name="fstype"]')) syncFormatLabel();
      if (event.target.matches('[name="start_sector"]')) selectFreeRange(Number(event.target.value));
      if (event.target.matches('[data-size-input]') && !busy) {
        setPartitionSize(Number(event.target.dataset.sizeInput), Number(event.target.value) * 1024);
      }
      if (event.target.matches('[data-structure-size]') && !busy && selected) {
        event.target.form.querySelector('[data-structure-range]').value = String(Number(event.target.value) * 1024);
        syncStructureEditor();
      }
    });
    el('fm-volumes-action')?.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!selected || busy) return;
      if (selected.action === 'repartition') {
        const disk = disks[selected.di];
        if (!disk || disk.serial !== selected.serial) return closeAction();
        const form = new FormData(event.target);
        if (String(form.get('confirmation') || '') !== disk.id) {
          notify('Введите идентификатор накопителя точно.', 'error');
          return;
        }
        if (selected.totalMiB - selected.sizesMiB.reduce((sum, amount) => sum + amount, 0) < 64) {
          notify('Для последнего раздела недостаточно места.', 'error');
          return;
        }
        const layoutOptions = Array.from(event.target.querySelectorAll('[data-partition-row]'), (row) => ({
          fstype: row.querySelector('[data-format-type]').value,
          label: row.querySelector('[data-volume-label]').value.trim(),
        }));
        if (layoutOptions.some((option) => !validLabel(option.label, option.fstype))) return;
        run('repartition', selected.di, -1, {
          expected_parts: selected.expectedParts, sizes_mib: [...selected.sizesMiB, 0],
          confirm: `REPARTITION ${disk.id}/${disk.serial}`,
          layout_options: layoutOptions,
        });
        return;
      }
      if (['add', 'delete', 'split', 'merge'].includes(selected.action)) {
        const disk = disks[selected.di];
        if (!disk || disk.serial !== selected.serial) return closeAction();
        const form = new FormData(event.target);
        if (String(form.get('confirmation') || '') !== disk.id) {
          notify('Введите идентификатор накопителя точно.', 'error');
          return;
        }
        const part = disk.partitions[selected.pi];
        if (selected.action !== 'add' && (!part || part.uuid !== selected.uuid)) return closeAction();
        const options = Array.from(event.target.querySelectorAll('[data-format-type]'), (field, index) => ({
          fstype: field.value, label: event.target.querySelector(`[data-volume-label="${index}"]`).value.trim(),
        }));
        if (options.some((option) => !validLabel(option.label, option.fstype))) return;
        const other = disk.partitions.find((item) => item.partition_id === String(form.get('other_id') || ''));
        const extra = { expected_parts: selected.expectedParts, confirm: `EDIT ${disk.id}/${disk.serial}`,
          ...(part ? { partition_id: part.partition_id, uuid: part.uuid } : {}),
          ...(other ? { other_id: other.partition_id, other_uuid: other.uuid } : {}),
          ...(selected.action === 'add' ? { start_sector: Number(form.get('start_sector')) } : {}),
          ...(['add', 'split'].includes(selected.action)
            ? { size_mib: Number(event.target.querySelector('[data-structure-range]').value) } : {}),
          layout_options: options };
        run(selected.action, selected.di, selected.pi, extra);
        return;
      }
      const part = disks[selected.di]?.partitions?.[selected.pi];
      if (!part || part.uuid !== selected.uuid) return closeAction();
      const form = new FormData(event.target);
      if (selected.action === 'format') {
        if (String(form.get('confirmation') || '') !== (part.label || part.partition_id)) {
          notify('Введите название раздела точно.', 'error');
          return;
        }
        const fstype = String(form.get('fstype') || '');
        const label = String(form.get('label') || '').trim();
        if (label && !validLabel(label, fstype)) return;
        run('format', selected.di, selected.pi, {
          fstype, label,
          confirm: `FORMAT ${part.media_id}/${part.partition_id}`,
        });
      } else {
        const label = String(form.get('label') || '').trim();
        if (validLabel(label, part.fstype)) run('label', selected.di, selected.pi, { label });
      }
    });
  }

  FM.storage = { init, open: () => el('fm-volumes-btn')?.click(), refresh };
})();
