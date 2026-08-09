export const MIHOMO_CLASH_SUBVIEWS = Object.freeze([
  'control',
  'connections',
  'rules',
  'config',
]);

export const MIHOMO_CLASH_STATUS_COPY = Object.freeze({
  idle: ['API · ожидание', 'Проверяем локальный Mihomo API', 'Подключение ещё не выполнялось.'],
  loading: ['API · проверка', 'Проверяем локальный Mihomo API', 'Панель подключается к controller только через защищённый backend facade.'],
  ready: ['API · готов', 'Mihomo API доступен', 'Оперативный контур готов к загрузке данных.'],
  controller_missing: ['API · не настроен', 'Controller не настроен', 'Добавьте loopback controller или Unix socket в активную конфигурацию.'],
  not_configured: ['API · нет конфига', 'Конфигурация Mihomo недоступна', 'Проверьте активный config.yaml и повторите запрос.'],
  blocked: ['API · заблокирован', 'Controller заблокирован политикой', 'Проверьте allowlist порта или безопасный путь Unix socket.'],
  core_stopped: ['API · ядро остановлено', 'Mihomo не отвечает', 'Запустите ядро или проверьте конфигурацию, затем повторите запрос.'],
  unauthorized: ['API · отказ авторизации', 'Mihomo отклонил credential', 'Проверьте secret в config.yaml. Пароль панели не используется.'],
  paused: ['API · пауза', 'Проверка приостановлена', 'Скрытая вкладка не выполняет сетевые запросы.'],
  error: ['API · ошибка', 'Не удалось проверить Mihomo API', 'Проверьте состояние ядра и повторите запрос.'],
});

export function normalizeMihomoClashState(payload) {
  const raw = payload && typeof payload === 'object' ? String(payload.state || '') : '';
  return Object.prototype.hasOwnProperty.call(MIHOMO_CLASH_STATUS_COPY, raw) ? raw : 'error';
}

export function mihomoClashStateCopy(state) {
  return MIHOMO_CLASH_STATUS_COPY[state] || MIHOMO_CLASH_STATUS_COPY.error;
}

export function normalizeMihomoClashSubview(name) {
  const value = String(name || '').trim().toLowerCase();
  if (value === 'rules') return 'control';
  return MIHOMO_CLASH_SUBVIEWS.includes(value) ? value : 'control';
}
