// Who wrote a line of the Xkeen operations journal (restart.log), in words.
//
// Shared by the journal on the panel screens and by DevTools -> Logs, so a
// source reads the same in both places.

// `[YYYY-MM-DD HH:MM:SS] source=<name> result=<OK|FAIL> key=value ...` -- the
// result line the panel writes after an operation; output of xkeen and the
// core goes in before it.
export const RESTART_SUMMARY_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]\s+source=([^\s]+)\s+result=([A-Z]+)(?:\s+(.*?))?\s*$/i;

export const RESTART_SOURCE_META = Object.freeze({
  api: {
    label: 'Xkeen',
    successText: 'перезапущен успешно',
    failureText: 'перезапуск завершился ошибкой',
    bucket: 'service',
  },
  'api-button': {
    label: 'Xkeen',
    successText: 'перезапущен вручную',
    failureText: 'ручной перезапуск завершился ошибкой',
    bucket: 'service',
  },
  'api-start': {
    label: 'Xkeen',
    successText: 'запущен',
    failureText: 'не удалось запустить',
    bucket: 'service',
  },
  'api-stop': {
    label: 'Xkeen',
    successText: 'остановлен',
    failureText: 'не удалось остановить',
    bucket: 'service',
  },
  'core-switch': {
    label: 'Ядро Xkeen',
    successText: 'ядро переключено, xkeen перезапущен',
    failureText: 'смена ядра завершилась ошибкой',
    bucket: 'core',
  },
  routing: {
    label: 'Routing',
    successText: 'сохранён, xkeen перезапущен',
    failureText: 'сохранён, но перезапуск xkeen завершился ошибкой',
    bucket: 'routing',
  },
  inbounds: {
    label: 'Inbounds',
    successText: 'сохранены, xkeen перезапущен',
    failureText: 'сохранены, но перезапуск xkeen завершился ошибкой',
    bucket: 'xray',
  },
  outbounds: {
    label: 'Outbounds',
    successText: 'сохранены, xkeen перезапущен',
    failureText: 'сохранены, но перезапуск xkeen завершился ошибкой',
    bucket: 'xray',
  },
  'observatory-preset': {
    label: 'Observatory',
    successText: 'пресет применён, xkeen перезапущен',
    failureText: 'пресет применён, но перезапуск xkeen завершился ошибкой',
    bucket: 'xray',
  },
  'mihomo-config': {
    label: 'Mihomo',
    successText: 'конфиг применён, xkeen перезапущен',
    failureText: 'конфиг применён, но перезапуск xkeen завершился ошибкой',
    bucket: 'mihomo',
  },
  'mihomo-security-migration': {
    label: 'Mihomo security',
    successText: 'безопасная миграция применена, xkeen перезапущен',
    failureText: 'миграция сохранена, но перезапуск xkeen завершился ошибкой',
    bucket: 'mihomo',
  },
  'mihomo-profile-activate': {
    label: 'Mihomo',
    successText: 'профиль активирован, xkeen перезапущен',
    failureText: 'профиль активирован, но перезапуск xkeen завершился ошибкой',
    bucket: 'mihomo',
  },
  'mihomo-backup-restore': {
    label: 'Mihomo',
    successText: 'бэкап восстановлен, xkeen перезапущен',
    failureText: 'бэкап восстановлен, но перезапуск xkeen завершился ошибкой',
    bucket: 'mihomo',
  },
  'manual-mihomo': {
    label: 'Xkeen',
    successText: 'перезапущен вручную',
    failureText: 'ручной перезапуск завершился ошибкой',
    bucket: 'service',
  },
  'snapshot-restore': {
    label: 'Бэкап',
    successText: 'восстановлен, xkeen перезапущен',
    failureText: 'восстановлен, но перезапуск xkeen завершился ошибкой',
    bucket: 'backup',
  },
  'backups-page': {
    label: 'Бэкап',
    successText: 'операция выполнена, xkeen перезапущен',
    failureText: 'операция выполнена, но перезапуск xkeen завершился ошибкой',
    bucket: 'backup',
  },
  'port-proxying': {
    label: 'Port proxying',
    successText: 'список сохранён, xkeen перезапущен',
    failureText: 'список сохранён, но перезапуск xkeen завершился ошибкой',
    bucket: 'service',
  },
  'port-exclude': {
    label: 'Port exclude',
    successText: 'список сохранён, xkeen перезапущен',
    failureText: 'список сохранён, но перезапуск xkeen завершился ошибкой',
    bucket: 'service',
  },
  'ip-exclude': {
    label: 'IP exclude',
    successText: 'список сохранён, xkeen перезапущен',
    failureText: 'список сохранён, но перезапуск xkeen завершился ошибкой',
    bucket: 'service',
  },
  'xkeen-config': {
    label: 'xkeen.json',
    successText: 'сохранён, xkeen перезапущен',
    failureText: 'сохранён, но перезапуск xkeen завершился ошибкой',
    bucket: 'service',
  },
  'xray-subscription-delete': {
    label: 'Подписка Xray',
    successText: 'удалена, xkeen перезапущен',
    failureText: 'удалена, но перезапуск xkeen завершился ошибкой',
    bucket: 'subscription',
  },
  'xray-subscription-refresh': {
    label: 'Подписка Xray',
    successText: 'обновлена, xkeen перезапущен',
    failureText: 'обновлена, но перезапуск xkeen завершился ошибкой',
    bucket: 'subscription',
    toastSuccess: 'Подписка Xray обновлена. xkeen перезапущен.',
    toastFailure: 'Подписка Xray обновлена, но перезапуск xkeen завершился ошибкой.',
  },
  'dns-over-vless': {
    label: 'DNS-over-VLESS',
    successText: 'настройка применена, xkeen перезапущен',
    failureText: 'настройка применена, но перезапуск xkeen завершился ошибкой',
    bucket: 'routing',
  },
  'dns-over-vless-rollback': {
    label: 'DNS-over-VLESS',
    successText: 'настройка отменена, xkeen перезапущен',
    failureText: 'настройка отменена, но перезапуск xkeen завершился ошибкой',
    bucket: 'routing',
  },
  'dns-over-vless-watchdog-release': {
    label: 'DNS-over-VLESS',
    successText: 'сторож вернул DNS роутеру, xkeen перезапущен',
    failureText: 'сторож вернул DNS роутеру, но перезапуск xkeen завершился ошибкой',
    bucket: 'routing',
  },
  'xray-subscriptions-batch': {
    label: 'Подписки Xray',
    successText: 'обновлены одной пачкой, xkeen перезапущен',
    failureText: 'обновлены, но перезапуск xkeen завершился ошибкой',
    bucket: 'subscription',
  },
  'xray-subscriptions-delete-all': {
    label: 'Подписки Xray',
    successText: 'удалены все, xkeen перезапущен',
    failureText: 'удалены все, но перезапуск xkeen завершился ошибкой',
    bucket: 'subscription',
  },
  'xray-subscriptions-pause': {
    label: 'Подписки Xray',
    successText: 'приостановлены, xkeen перезапущен',
    failureText: 'приостановлены, но перезапуск xkeen завершился ошибкой',
    bucket: 'subscription',
  },
  'xray-subscriptions-resume': {
    label: 'Подписки Xray',
    successText: 'возобновлены, xkeen перезапущен',
    failureText: 'возобновлены, но перезапуск xkeen завершился ошибкой',
    bucket: 'subscription',
  },
  'xray-preflight': {
    label: 'Xray preflight',
    successText: 'конфиг прошёл проверку',
    failureText: 'конфиг отклонён, xkeen не перезапускался',
    bucket: 'preflight',
  },
  'xray-logs-enable': {
    label: 'Логи Xray',
    successText: 'запись включена, Xray перезапущен',
    failureText: 'запись не включена',
    bucket: 'service',
  },
  'xray-logs-disable': {
    label: 'Логи Xray',
    successText: 'запись выключена, Xray перезапущен',
    failureText: 'запись не выключена',
    bucket: 'service',
  },
});

export function restartSourceLabel(source) {
  const meta = RESTART_SOURCE_META[String(source || '').trim()];
  if (meta && meta.label) return meta.label;
  const raw = String(source || '').trim();
  if (!raw) return 'Событие';
  return raw.replace(/[-_]+/g, ' ').replace(/(^|\s)(\S)/g, (m, sp, ch) => sp + ch.toUpperCase());
}
