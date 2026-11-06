const NETWORK_ERROR = /timeout|timed out|connection|network|resolve|fetch failed|dns|тайм.?аут|соединен|подключен|сеть|недоступ|не удалось (?:получить|загрузить|скачать|подключ)|блокир|http 5\d\d/i;

// The window is the optional module tool.server-diagnostics: without it the
// hint would offer a button that opens nothing.
function serverDiagnosticsActive() {
  try {
    return window.XKeen?.pageConfig?.flags?.hasServerDiagnostics === true;
  } catch (_error) {
    return false;
  }
}

export function appendProviderDiagnosticsHint(container, message, core, sourceInputId) {
  if (!container || !serverDiagnosticsActive() || !NETWORK_ERROR.test(String(message || ''))) return;
  const hint = document.createElement('span');
  hint.className = 'xk-provider-check-error-hint';
  hint.append(' Возможен сетевой сбой или фильтрация. ');
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Проверить серверы';
  button.dataset.tooltip = 'Открыть диагностику адресов из редактора от имени процесса панели';
  button.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('xk-provider-check-open', {
      detail: { core, source: document.getElementById(sourceInputId)?.value?.trim() || '' },
    }));
  });
  hint.appendChild(button);
  container.appendChild(hint);
}
