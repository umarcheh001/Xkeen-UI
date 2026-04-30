import {
  ensureXkeenTerminalInViewport,
  focusXkeenTerminal,
  getXkeenLazyRuntimeApi,
  getXkeenTerminalApi,
  isXkeenTerminalPtyConnected,
  openXkeenTerminal,
  sendXkeenTerminal,
  toastXkeen,
} from './xkeen_runtime.js';

let coresStatusModuleApi = null;

(() => {
  'use strict';

  const CS = {};
  coresStatusModuleApi = CS;

  const API_VERSIONS = '/api/cores/versions';
  const API_UPDATES = '/api/cores/updates';
  const NOT_INSTALLED_LABEL = '—';
  let lastInstalled = {};

  function $(id) {
    return document.getElementById(id);
  }

  function setText(el, text) {
    if (!el) return;
    el.textContent = String(text == null ? '' : text);
  }

  function show(el, yes) {
    if (!el) return;
    el.style.display = yes ? '' : 'none';
  }

  function setBusy(el, isBusy) {
    if (!el) return;
    el.disabled = !!isBusy;
    el.classList.toggle('loading', !!isBusy);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
  }

  async function waitFor(fn, timeoutMs = 3000, stepMs = 100) {
    const startedAt = Date.now();
    const timeout = Math.max(100, Number(timeoutMs) || 0);
    const step = Math.max(25, Number(stepMs) || 0);
    while ((Date.now() - startedAt) <= timeout) {
      try {
        if (fn()) return true;
      } catch (e) {}
      await sleep(step);
    }
    return false;
  }

  function clampTerminalViewportSoon() {
    const run = () => {
      try { ensureXkeenTerminalInViewport(); } catch (e) {}
    };
    try { setTimeout(run, 0); } catch (e0) {}
    try { setTimeout(run, 120); } catch (e1) {}
    try { setTimeout(run, 360); } catch (e2) {}
  }

  function normVer(v) {
    let s = String(v || '').trim();
    if (s.toLowerCase().startsWith('v')) s = s.slice(1).trim();
    return s;
  }

  function isSemverLikeTag(v) {
    return /^\d+(?:\.\d+){1,2}(?:-[0-9A-Za-z.-]+)?$/.test(normVer(v));
  }

  function formatReleaseLabel(tag, { preferV = false } = {}) {
    const raw = String(tag || '').trim();
    if (!raw) return '';
    if (preferV || isSemverLikeTag(raw) || raw.toLowerCase().startsWith('v')) {
      return `v${normVer(raw)}`;
    }
    return raw;
  }

  function formatInstalledVersionLabel(version) {
    const raw = String(version || '').trim();
    if (!raw) return 'v?';
    return formatReleaseLabel(raw);
  }

  function normalizeVersionCompareToken(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (isSemverLikeTag(raw) || raw.toLowerCase().startsWith('v')) {
      return normVer(raw).toLowerCase();
    }
    return raw.toLowerCase();
  }

  function formatReleaseTitle(baseTitle, release) {
    const parts = [String(baseTitle || '').trim()].filter(Boolean);
    const publishedAt = String((release && release.published_at) || '').trim();
    if (publishedAt) {
      try {
        parts.push(new Date(publishedAt).toLocaleDateString());
      } catch (e) {}
    }
    return parts.join(' | ');
  }

  function fmtTime(ts) {
    try {
      const d = new Date(ts * 1000);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      return `${hh}:${mm}`;
    } catch (e) {
      return '';
    }
  }

  function shSingleQuote(value) {
    const raw = String(value == null ? '' : value).replace(/[\r\n]+/g, '');
    return `'${raw.replace(/'/g, `'\\''`)}'`;
  }

  function buildShellPrintfLine(text) {
    return `printf '%s\\n' ${shSingleQuote(String(text == null ? '' : text))}`;
  }

  function buildShellScript(lines) {
    return (Array.isArray(lines) ? lines : [])
      .map((line) => String(line == null ? '' : line))
      .join('\n');
  }

  function buildQuietTerminalScript(lines) {
    return buildShellScript([
      'stty -echo 2>/dev/null || true',
      '(',
      ...(Array.isArray(lines) ? lines : []),
      ')',
      '__xk_script_status="$?"',
      'stty echo 2>/dev/null || true',
      'unset __xk_script_status',
    ]);
  }

  async function getJSON(url) {
    const res = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }

  function setPillState(pillEl, state) {
    if (!pillEl) return;
    pillEl.classList.toggle('has-update', !!state.hasUpdate);
    pillEl.classList.toggle('has-error', !!state.hasError);
  }

  function applyReleaseLink(linkEl, release, {
    versionSelector,
    preferV = false,
    title = '',
  } = {}) {
    if (!linkEl) return;
    const has = !!(release && release.tag);
    show(linkEl, has);
    if (!has) return;
    const verSpan = versionSelector ? linkEl.querySelector(versionSelector) : null;
    const displayTag = String((release && (release.display_tag || release.tag)) || '').trim();
    if (verSpan) verSpan.textContent = formatReleaseLabel(displayTag, { preferV });
    try { linkEl.href = release.url || '#'; } catch (e) {}
    const nextTitle = formatReleaseTitle(title, release);
    if (nextTitle) linkEl.title = nextTitle;
  }

  function findCommandButton(flag) {
    try {
      return document.querySelector(`.command-item[data-flag="${CSS.escape(String(flag || ''))}"]`);
    } catch (e) {
      return document.querySelector(`.command-item[data-flag="${String(flag || '')}"]`);
    }
  }

  async function runXkeenCommand(flag) {
    const btn = findCommandButton(flag);
    if (btn) {
      try { btn.click(); return true; } catch (e) {}
    }

    const label = `xkeen ${flag}`;
    try {
      await Promise.resolve(openXkeenTerminal({ cmd: label, mode: 'xkeen' }));
      return true;
    } catch (e) {
      return false;
    }
  }

  function toastMsg(msg, kind) {
    toastXkeen(String(msg || ''), kind || 'info');
  }

  function wasDelivered(sendRes) {
    return !!(
      sendRes === true ||
      (sendRes && sendRes.ok === true) ||
      (sendRes && sendRes.handled === true) ||
      (sendRes && sendRes.result && sendRes.result.ok === true)
    );
  }

  function buildPrereleaseVersionSummaryCommand(flag, coreLabel) {
    const normalizedFlag = String(flag || '').trim();
    const normalizedCore = String(coreLabel || '').trim() || 'ядра';
    if (normalizedFlag === '-ux') {
      return `__xk_installed_version="$(/opt/sbin/xray version 2>/dev/null | head -n 1)"; if [ -n "$__xk_installed_version" ]; then printf '%s\\n' "[Xkeen UI] Текущая версия ${normalizedCore}: $__xk_installed_version"; fi; unset __xk_installed_version`;
    }
    if (normalizedFlag === '-um') {
      return `__xk_installed_version="$(/opt/sbin/mihomo -v 2>/dev/null | head -n 1)"; if [ -n "$__xk_installed_version" ]; then printf '%s\\n' "[Xkeen UI] Текущая версия ${normalizedCore}: $__xk_installed_version"; fi; unset __xk_installed_version`;
    }
    return '';
  }

  function buildPrereleaseUpdateCommand(flag, tag, coreLabel) {
    const normalizedFlag = String(flag || '').trim();
    const normalizedTag = String(tag || '').trim();
    const normalizedCore = String(coreLabel || '').trim() || 'core';
    if (!normalizedFlag || !normalizedTag) return '';
    const releaseLabel = formatReleaseLabel(normalizedTag, { preferV: true });
    const versionSummaryCommand = buildPrereleaseVersionSummaryCommand(normalizedFlag, normalizedCore);
    const lines = [
      `${buildShellPrintfLine('')};`,
      `${buildShellPrintfLine(`[Xkeen UI] Запускаем обновление ${normalizedCore} до pre-release ${releaseLabel}.`)};`,
      `${buildShellPrintfLine('[Xkeen UI] Xkeen ниже выполнит установку и покажет свой прогресс.')};`,
      `if printf '%s\\n%s\\n' '9' ${shSingleQuote(normalizedTag)} | xkeen ${normalizedFlag}; then`,
      `  ${buildShellPrintfLine(`[Xkeen UI] Обновление ${normalizedCore} завершено.`)};`,
      versionSummaryCommand ? `  ${versionSummaryCommand};` : '',
      'else',
      '  __xk_prerelease_status="$?";',
      `  printf '%s\\n' "[Xkeen UI] Обновление ${normalizedCore} до pre-release ${releaseLabel} завершилось с кодом $__xk_prerelease_status. Проверьте вывод выше.";`,
      '  unset __xk_prerelease_status;',
      'fi',
    ];
    return buildQuietTerminalScript(lines.filter(Boolean));
  }

  function normalizePrereleaseInstallAssets(installMeta) {
    const assets = Array.isArray(installMeta && installMeta.assets) ? installMeta.assets : [];
    return assets
      .map((asset) => ({
        name: String((asset && asset.name) || '').trim(),
        url: String((asset && asset.url) || '').trim(),
      }))
      .filter((asset) => asset.name && asset.url);
  }

  function normalizePrereleaseBuildIds(installMeta) {
    const buildIds = Array.isArray(installMeta && installMeta.build_ids) ? installMeta.build_ids : [];
    return buildIds
      .map((buildId) => normalizeVersionCompareToken(buildId))
      .filter(Boolean);
  }

  function getPrereleaseInstallMeta(btn) {
    if (!btn || !btn.__xkPrereleaseInstallMeta || typeof btn.__xkPrereleaseInstallMeta !== 'object') {
      return null;
    }
    return btn.__xkPrereleaseInstallMeta;
  }

  function isDirectAssetPrereleaseInstall(installMeta) {
    if (!installMeta || typeof installMeta !== 'object') return false;
    return String(installMeta.mode || '').trim() === 'direct_asset';
  }

  function buildMihomoPrereleaseInstallCommand(tag, installMeta, coreLabel) {
    const normalizedTag = String(tag || '').trim();
    const normalizedCore = String(coreLabel || '').trim() || 'Mihomo';
    const releaseInstall = (installMeta && typeof installMeta === 'object') ? installMeta : null;
    const assets = normalizePrereleaseInstallAssets(releaseInstall);
    if (!normalizedTag || !assets.length) return '';

    const arch = String((releaseInstall && releaseInstall.arch) || '').trim() || 'unknown';
    const opkgArch = String((releaseInstall && releaseInstall.opkg_arch) || '').trim();
    const endian = String((releaseInstall && releaseInstall.endian) || '').trim() || 'unknown';
    const note = String((releaseInstall && releaseInstall.note) || '').trim();
    const checksumUrl = String((releaseInstall && releaseInstall.checksum_url) || '').trim();

    const lines = [
      buildShellPrintfLine(''),
      buildShellPrintfLine(`[Xkeen UI] Установка ${normalizedCore} pre-release ${normalizedTag}`),
      buildShellPrintfLine(`[Xkeen UI] Архитектура: ${arch}${opkgArch ? ` | opkg: ${opkgArch}` : ''}${endian ? ` | endian: ${endian}` : ''}`),
      ...(note ? [buildShellPrintfLine(`[Xkeen UI] ${note}`)] : []),
      '__xk_tmpdir="$(mktemp -d /tmp/xkeen-mihomo-pre.XXXXXX 2>/dev/null || true)"',
      'if [ -z "$__xk_tmpdir" ]; then',
      '  __xk_tmpdir="/tmp/xkeen-mihomo-pre.$$"',
      '  mkdir -p "$__xk_tmpdir" || exit 1',
      'fi',
      '__xk_cleanup() {',
      '  rm -rf "$__xk_tmpdir"',
      '}',
      '__xk_fetch() {',
      '  _url="$1"',
      '  _out="$2"',
      '  if command -v curl >/dev/null 2>&1; then',
      '    curl -fsSL "$_url" -o "$_out"',
      '    return "$?"',
      '  fi',
      '  if command -v wget >/dev/null 2>&1; then',
      '    wget -O "$_out" "$_url"',
      '    return "$?"',
      '  fi',
      `  ${buildShellPrintfLine('[Xkeen UI] Не найден curl или wget для скачивания.')}`,
      '  return 127',
      '}',
      '__xk_unpack_gzip() {',
      '  _archive="$1"',
      '  _out="$2"',
      '  if command -v gzip >/dev/null 2>&1; then',
      '    gzip -dc "$_archive" > "$_out"',
      '    return "$?"',
      '  fi',
      '  if command -v gunzip >/dev/null 2>&1; then',
      '    gunzip -c "$_archive" > "$_out"',
      '    return "$?"',
      '  fi',
      `  ${buildShellPrintfLine('[Xkeen UI] Не найден gzip или gunzip для распаковки .gz.')}`,
      '  return 127',
      '}',
      '__xk_checksum_file=""',
    ];

    if (checksumUrl) {
      lines.push(
        '__xk_checksum_file="$__xk_tmpdir/checksums.txt"',
        `if __xk_fetch ${shSingleQuote(checksumUrl)} "$__xk_checksum_file"; then`,
        '  :',
        'else',
        '  __xk_checksum_file=""',
        'fi',
      );
    }

    lines.push(
      '__xk_verify_checksum() {',
      '  _asset_name="$1"',
      '  _archive="$2"',
      '  if [ -z "$__xk_checksum_file" ] || [ ! -f "$__xk_checksum_file" ]; then',
      '    return 0',
      '  fi',
      "  _expected=\"$(grep -F \" ./$_asset_name\" \"$__xk_checksum_file\" | cut -d ' ' -f 1 | head -n 1)\"",
      '  if [ -z "$_expected" ]; then',
      '    return 0',
      '  fi',
      '  if command -v sha256sum >/dev/null 2>&1; then',
      "    _actual=\"$(sha256sum \"$_archive\" | cut -d ' ' -f 1)\"",
      '  elif command -v openssl >/dev/null 2>&1; then',
      "    _actual=\"$(openssl dgst -sha256 \"$_archive\" | awk '{print $NF}')\"",
      '  else',
      '    return 0',
      '  fi',
      '  [ "$_expected" = "$_actual" ]',
      '}',
      '__xk_try_asset() {',
      '  _asset_name="$1"',
      '  _asset_url="$2"',
      '  _archive="$__xk_tmpdir/$_asset_name"',
      '  _binary="$__xk_tmpdir/$_asset_name.bin"',
      '  rm -f "$_archive" "$_binary"',
      '  printf \'%s\\n\' "[Xkeen UI] Скачиваем $_asset_name..."',
      '  if ! __xk_fetch "$_asset_url" "$_archive"; then',
      '    printf \'%s\\n\' "[Xkeen UI] Не удалось скачать $_asset_name, пробуем следующий вариант."',
      '    return 1',
      '  fi',
      '  if ! __xk_verify_checksum "$_asset_name" "$_archive"; then',
      '    printf \'%s\\n\' "[Xkeen UI] Контрольная сумма не совпала для $_asset_name, пробуем следующий вариант."',
      '    return 1',
      '  fi',
      '  if ! __xk_unpack_gzip "$_archive" "$_binary"; then',
      '    printf \'%s\\n\' "[Xkeen UI] Не удалось распаковать $_asset_name, пробуем следующий вариант."',
      '    return 1',
      '  fi',
      '  chmod 755 "$_binary" || return 1',
      '  _version_out="$("$_binary" -v 2>&1)"',
      '  _version_rc="$?"',
      '  if [ "$_version_rc" -ne 0 ]; then',
      '    printf \'%s\\n\' "[Xkeen UI] $_asset_name не запускается на этом роутере, пробуем следующий вариант."',
      '    return 1',
      '  fi',
      '  __xk_selected_asset_name="$_asset_name"',
      '  __xk_selected_binary="$_binary"',
      '  return 0',
      '}',
      '__xk_selected_asset_name=""',
      '__xk_selected_binary=""',
    );

    assets.forEach((asset) => {
      lines.push(`if __xk_try_asset ${shSingleQuote(asset.name)} ${shSingleQuote(asset.url)}; then`);
      lines.push('  break');
      lines.push('fi');
    });

    lines.push(
      'if [ -z "$__xk_selected_binary" ] || [ ! -f "$__xk_selected_binary" ]; then',
      `  ${buildShellPrintfLine('[Xkeen UI] Не удалось подобрать рабочий Mihomo pre-release для этого роутера.')}`,
      '  __xk_cleanup',
      '  exit 1',
      'fi',
      'printf \'%s\\n\' "[Xkeen UI] Выбран asset: $__xk_selected_asset_name"',
      'mkdir -p /opt/sbin /opt/backups || true',
      '__xk_backup=""',
      'if [ -f /opt/sbin/mihomo ]; then',
      '  __xk_backup="/opt/backups/mihomo.backup.$(date +%Y%m%d-%H%M%S 2>/dev/null || echo current)"',
      `  ${buildShellPrintfLine('[Xkeen UI] Сохраняем резервную копию текущего Mihomo.')}`,
      '  if ! cp /opt/sbin/mihomo "$__xk_backup"; then',
      `    ${buildShellPrintfLine('[Xkeen UI] Не удалось сохранить резервную копию, продолжаем без неё.')}`,
      '    __xk_backup=""',
      '  fi',
      'fi',
      `  ${buildShellPrintfLine('[Xkeen UI] Останавливаем xkeen...')}`,
      'xkeen -stop',
      '__xk_stop_rc="$?"',
      'if [ "$__xk_stop_rc" -ne 0 ]; then',
      '  printf \'%s\\n\' "[Xkeen UI] xkeen -stop завершился с кодом $__xk_stop_rc, продолжаем замену бинарника."',
      'fi',
      `  ${buildShellPrintfLine('[Xkeen UI] Обновляем бинарник Mihomo...')}`,
      'if ! cp "$__xk_selected_binary" /opt/sbin/mihomo.new; then',
      `  ${buildShellPrintfLine('[Xkeen UI] Не удалось записать /opt/sbin/mihomo.new.')}`,
      '  xkeen -start >/dev/null 2>&1 || true',
      '  __xk_cleanup',
      '  exit 1',
      'fi',
      'chmod 755 /opt/sbin/mihomo.new || true',
      'if ! mv /opt/sbin/mihomo.new /opt/sbin/mihomo; then',
      `  ${buildShellPrintfLine('[Xkeen UI] Не удалось заменить /opt/sbin/mihomo.')}`,
      '  if [ -n "$__xk_backup" ] && [ -f "$__xk_backup" ]; then',
      '    cp "$__xk_backup" /opt/sbin/mihomo >/dev/null 2>&1 || true',
      '  fi',
      '  xkeen -start >/dev/null 2>&1 || true',
      '  __xk_cleanup',
      '  exit 1',
      'fi',
      `  ${buildShellPrintfLine('[Xkeen UI] Запускаем xkeen...')}`,
      'xkeen -start',
      '__xk_start_rc="$?"',
      'if [ "$__xk_start_rc" -ne 0 ]; then',
      '  printf \'%s\\n\' "[Xkeen UI] xkeen -start завершился с кодом $__xk_start_rc."',
      '  if [ -n "$__xk_backup" ] && [ -f "$__xk_backup" ]; then',
      `    ${buildShellPrintfLine('[Xkeen UI] Восстанавливаем предыдущий Mihomo из резервной копии.')}`,
      '    cp "$__xk_backup" /opt/sbin/mihomo >/dev/null 2>&1 || true',
      '    chmod 755 /opt/sbin/mihomo >/dev/null 2>&1 || true',
      '    xkeen -start >/dev/null 2>&1 || true',
      '  fi',
      '  __xk_cleanup',
      '  exit 1',
      'fi',
      `  ${buildShellPrintfLine('[Xkeen UI] Проверяем установленную версию Mihomo...')}`,
      '/opt/sbin/mihomo -v 2>&1',
      '__xk_final_rc="$?"',
      'if [ "$__xk_final_rc" -eq 0 ]; then',
      `  ${buildShellPrintfLine('[Xkeen UI] Установка Mihomo pre-release завершена.')}`,
      'else',
      '  printf \'%s\\n\' "[Xkeen UI] Mihomo заменён, но проверка версии завершилась с кодом $__xk_final_rc."',
      'fi',
      '__xk_cleanup',
      'unset __xk_selected_asset_name __xk_selected_binary __xk_checksum_file __xk_tmpdir __xk_backup __xk_stop_rc __xk_start_rc __xk_final_rc',
    );

    return buildQuietTerminalScript(lines);
  }

  async function runTerminalCommand(command, source = 'cores_status') {
    const cmd = String(command || '').trim();
    if (!cmd) return false;

    try {
      const lazyRuntime = getXkeenLazyRuntimeApi();
      const ensureReady = lazyRuntime && typeof lazyRuntime.ensureTerminalReady === 'function'
        ? lazyRuntime.ensureTerminalReady
        : null;
      if (ensureReady) await Promise.resolve(ensureReady());
    } catch (e0) {}

    try {
      await Promise.resolve(openXkeenTerminal({ mode: 'pty', cmd: '' }));
    } catch (e1) {
      return false;
    }

    clampTerminalViewportSoon();

    const apiReady = await waitFor(() => {
      const api = getXkeenTerminalApi();
      return !!(api && typeof api.send === 'function');
    }, 4000, 100);
    if (!apiReady) return false;

    const api = getXkeenTerminalApi();
    if (!api || typeof api.send !== 'function') return false;

    let mode = 'shell';
    try {
      mode = typeof api.getMode === 'function' ? String(api.getMode() || 'shell') : 'shell';
    } catch (e2) {}

    if (mode === 'pty') {
      const connected = await waitFor(() => isXkeenTerminalPtyConnected(), 12000, 150);
      if (!connected) {
        toastMsg('PTY не подключён, не удалось запустить команду.', 'error');
        return false;
      }
    } else {
      await sleep(120);
    }

    let sendRes = null;
    try {
      sendRes = await Promise.resolve(api.send(cmd, { source }));
    } catch (e3) {
      sendRes = null;
    }

    if (!wasDelivered(sendRes)) {
      try {
        if (mode === 'pty') {
          sendRes = await Promise.resolve(sendXkeenTerminal(`${cmd}\r`, {
            raw: true,
            prefer: 'pty',
            allowWhenDisconnected: false,
            source,
          }));
        } else {
          sendRes = await Promise.resolve(sendXkeenTerminal(cmd, { source }));
        }
      } catch (e4) {
        sendRes = null;
      }
    }

    if (!wasDelivered(sendRes)) return false;

    try { focusXkeenTerminal(); } catch (e5) {}
    clampTerminalViewportSoon();
    return true;
  }

  async function runPrereleaseUpdate(btn) {
    if (!btn) return;
    const flag = String(btn.dataset.prereleaseFlag || '').trim();
    const tag = String(btn.dataset.prereleaseTag || '').trim();
    const coreLabel = String(btn.dataset.prereleaseCore || '').trim() || 'ядра';
    const installMeta = getPrereleaseInstallMeta(btn);
    const mode = String(btn.dataset.prereleaseMode || '').trim();
    let command = '';
    if (mode === 'direct_asset') {
      if (!isDirectAssetPrereleaseInstall(installMeta)) {
        toastMsg(`Не удалось подготовить прямую установку pre-release для ${coreLabel}.`, 'error');
        return;
      }
      if (installMeta.supported === false) {
        const note = String(installMeta.note || '').trim();
        toastMsg(note || `Для ${coreLabel} pre-release не найден подходящий asset под архитектуру роутера.`, 'error');
        return;
      }
      command = buildMihomoPrereleaseInstallCommand(tag, installMeta, coreLabel);
    } else {
      command = buildPrereleaseUpdateCommand(flag, tag, coreLabel);
    }
    if (!command) {
      toastMsg(`Не удалось определить pre-release для ${coreLabel}.`, 'error');
      return;
    }

    setBusy(btn, true);
    try {
      const ok = await runTerminalCommand(command, `cores_status_prerelease_${coreLabel.toLowerCase()}`);
      if (!ok) {
        toastMsg(`Не удалось запустить обновление ${coreLabel} до pre-release.`, 'error');
        return;
      }
      if (mode === 'direct_asset') {
        toastMsg(`${coreLabel}: запущена прямая установка pre-release ${tag}, детали показываются в терминале.`, 'info');
      } else {
        toastMsg(`${coreLabel}: авто-обновление до pre-release ${tag} запущено, в терминале показаны подсказки по шагам.`, 'info');
      }
    } finally {
      setBusy(btn, false);
    }
  }

  function configurePrereleaseAction(btn, release, installedVersion, { flag, coreLabel } = {}) {
    if (!btn) return;
    const tag = String((release && release.tag) || '').trim();
    const releaseInstall = (release && release.install && typeof release.install === 'object') ? release.install : null;
    const installedToken = normalizeVersionCompareToken(installedVersion);
    const releaseToken = normalizeVersionCompareToken((release && (release.display_tag || release.tag)) || '');
    const buildIds = normalizePrereleaseBuildIds(releaseInstall);
    const installedIsCurrentDirect = !!installedToken && buildIds.includes(installedToken);
    const shouldShow = !!tag && !installedIsCurrentDirect && (!installedToken || installedToken !== releaseToken);
    show(btn, shouldShow);
    if (!shouldShow) {
      btn.removeAttribute('data-prerelease-tag');
      btn.removeAttribute('data-prerelease-flag');
      btn.removeAttribute('data-prerelease-core');
      btn.removeAttribute('data-prerelease-mode');
      btn.title = '';
      btn.removeAttribute('data-tooltip');
      btn.__xkPrereleaseInstallMeta = null;
      return;
    }
    btn.dataset.prereleaseTag = tag;
    btn.dataset.prereleaseFlag = String(flag || '').trim();
    btn.dataset.prereleaseCore = String(coreLabel || '').trim();
    if (isDirectAssetPrereleaseInstall(releaseInstall)) {
      btn.dataset.prereleaseMode = 'direct_asset';
      btn.__xkPrereleaseInstallMeta = releaseInstall;
      if (releaseInstall.supported === false) {
        btn.title = String(releaseInstall.note || `Для ${coreLabel} pre-release не найден подходящий asset под архитектуру роутера.`).trim();
      } else {
        btn.title = `Установить ${coreLabel} pre-release ${tag} напрямую из GitHub asset под архитектуру роутера.`;
      }
    } else {
      btn.dataset.prereleaseMode = 'xkeen_prompt';
      btn.__xkPrereleaseInstallMeta = null;
      btn.title = `Запустить обновление ${coreLabel} до pre-release ${tag} через терминал с авто-вводом: 9 и выбранный тег.`;
    }
    btn.dataset.tooltip = btn.title;
  }

  function setLoading(isLoading) {
    const checkBtn = $('cores-check-btn');
    if (!checkBtn) return;
    checkBtn.disabled = !!isLoading;
    checkBtn.classList.toggle('loading', !!isLoading);
  }

  function applyVersions(cores) {
    const xray = (cores && cores.xray) ? cores.xray : {};
    const mihomo = (cores && cores.mihomo) ? cores.mihomo : {};
    lastInstalled = { xray, mihomo };

    setText($('core-xray-installed'), xray.installed ? formatInstalledVersionLabel(xray.version) : NOT_INSTALLED_LABEL);
    setText($('core-mihomo-installed'), mihomo.installed ? formatInstalledVersionLabel(mihomo.version) : NOT_INSTALLED_LABEL);

    const pillX = $('core-pill-xray');
    const pillM = $('core-pill-mihomo');
    if (pillX) pillX.classList.toggle('not-installed', !xray.installed);
    if (pillM) pillM.classList.toggle('not-installed', !mihomo.installed);
  }

  function applyUpdates(payload) {
    const latest = (payload && payload.latest) ? payload.latest : {};
    const upd = (payload && payload.update_available) ? payload.update_available : {};
    const installed = (payload && payload.installed) ? payload.installed : lastInstalled;
    const checkedTs = payload && payload.checked_ts ? payload.checked_ts : null;
    const stale = !!(payload && payload.stale);

    const checkedEl = $('cores-checked-at');
    if (checkedEl) {
      if (checkedTs) {
        checkedEl.textContent = `проверено: ${fmtTime(checkedTs)}${stale ? ' (кэш)' : ''}`;
      } else {
        checkedEl.textContent = stale ? 'кэш' : '';
      }
    }

    const x = latest.xray || {};
    const xStable = x.stable || ((x.tag || x.url) ? x : null);
    const xPre = x.prerelease || null;
    const xLatestEl = $('core-xray-latest');
    const xPreEl = $('core-xray-prerelease');
    const xUpdateBtn = $('core-xray-update-btn');
    const xPreUpdateBtn = $('core-xray-prerelease-update-btn');
    const pillX = $('core-pill-xray');

    applyReleaseLink(xLatestEl, xStable, {
      versionSelector: '.core-latest-ver',
      preferV: true,
      title: 'Открыть стабильный релиз на GitHub',
    });
    applyReleaseLink(xPreEl, xPre, {
      versionSelector: '.core-prerelease-ver',
      title: 'Открыть pre-release на GitHub',
    });
    configurePrereleaseAction(xPreUpdateBtn, xPre, installed && installed.xray ? installed.xray.version : '', {
      flag: '-ux',
      coreLabel: 'Xray',
    });
    show(xUpdateBtn, !!upd.xray);
    setPillState(pillX, { hasUpdate: !!upd.xray, hasError: x.ok === false });

    const m = latest.mihomo || {};
    const mStable = m.stable || ((m.tag || m.url) ? m : null);
    const mPre = m.prerelease || null;
    const mLatestEl = $('core-mihomo-latest');
    const mPreEl = $('core-mihomo-prerelease');
    const mUpdateBtn = $('core-mihomo-update-btn');
    const mPreUpdateBtn = $('core-mihomo-prerelease-update-btn');
    const pillM = $('core-pill-mihomo');

    applyReleaseLink(mLatestEl, mStable, {
      versionSelector: '.core-latest-ver',
      preferV: true,
      title: 'Открыть стабильный релиз на GitHub',
    });
    applyReleaseLink(mPreEl, mPre, {
      versionSelector: '.core-prerelease-ver',
      title: 'Открыть pre-release на GitHub',
    });
    configurePrereleaseAction(mPreUpdateBtn, mPre, installed && installed.mihomo ? installed.mihomo.version : '', {
      flag: '-um',
      coreLabel: 'Mihomo',
    });
    show(mUpdateBtn, !!upd.mihomo);
    setPillState(pillM, { hasUpdate: !!upd.mihomo, hasError: m.ok === false });
  }

  async function refreshVersions() {
    const { res, data } = await getJSON(API_VERSIONS);
    if (!res.ok || !data || data.ok === false) {
      throw new Error('versions_failed');
    }
    applyVersions(data.cores || {});
    return data;
  }

  async function refreshUpdates(force) {
    const url = API_UPDATES + (force ? '?force=1' : '');
    const { res, data } = await getJSON(url);
    if (!res.ok || !data) throw new Error('updates_failed');
    if (data.installed) applyVersions(data.installed);
    applyUpdates(data);
    return data;
  }

  function wire() {
    const checkBtn = $('cores-check-btn');
    if (checkBtn && !checkBtn.dataset.xkWired) {
      checkBtn.addEventListener('click', async () => {
        setLoading(true);
        try {
          await refreshUpdates(true);
          toastMsg('Проверка обновлений выполнена.', 'info');
        } catch (e) {
          toastMsg('Не удалось проверить обновления.', 'error');
        } finally {
          setLoading(false);
        }
      });
      checkBtn.dataset.xkWired = '1';
    }

    const xUpd = $('core-xray-update-btn');
    if (xUpd && !xUpd.dataset.xkWired) {
      xUpd.addEventListener('click', async () => {
        const ok = await runXkeenCommand('-ux');
        if (!ok) toastMsg('Терминал недоступен.', 'error');
      });
      xUpd.dataset.xkWired = '1';
    }

    const xPreUpd = $('core-xray-prerelease-update-btn');
    if (xPreUpd && !xPreUpd.dataset.xkWired) {
      xPreUpd.addEventListener('click', async () => {
        await runPrereleaseUpdate(xPreUpd);
      });
      xPreUpd.dataset.xkWired = '1';
    }

    const mUpd = $('core-mihomo-update-btn');
    if (mUpd && !mUpd.dataset.xkWired) {
      mUpd.addEventListener('click', async () => {
        const ok = await runXkeenCommand('-um');
        if (!ok) toastMsg('Терминал недоступен.', 'error');
      });
      mUpd.dataset.xkWired = '1';
    }

    const mPreUpd = $('core-mihomo-prerelease-update-btn');
    if (mPreUpd && !mPreUpd.dataset.xkWired) {
      mPreUpd.addEventListener('click', async () => {
        await runPrereleaseUpdate(mPreUpd);
      });
      mPreUpd.dataset.xkWired = '1';
    }
  }

  let started = false;
  CS.init = function init() {
    const row = $('commands-status-row');
    if (!row || started) return;
    started = true;

    wire();

    (async () => {
      try {
        await refreshVersions();
      } catch (e) {}

      setLoading(true);
      try {
        await refreshUpdates(false);
      } catch (e) {
      } finally {
        setLoading(false);
      }
    })();
  };
})();

export function getCoresStatusApi() {
  try {
    return coresStatusModuleApi && typeof coresStatusModuleApi.init === 'function' ? coresStatusModuleApi : null;
  } catch (error) {
    return null;
  }
}

export function initCoresStatus(...args) {
  const api = getCoresStatusApi();
  if (!api || typeof api.init !== 'function') return null;
  return api.init(...args);
}

export const coresStatusApi = Object.freeze({
  get: getCoresStatusApi,
  init: initCoresStatus,
});
