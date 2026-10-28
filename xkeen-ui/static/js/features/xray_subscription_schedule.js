export function decodeSchedule(value) {
  const cron = String(value || '').trim();
  const fields = cron.split(/\s+/);
  if (fields.length !== 5) return { kind: 'custom', cron };
  const [minute, hour, day, month, weekday] = fields;
  if (!/^(0|[1-9]\d?)$/.test(minute) || Number(minute) > 59 ||
      !/^(0|[1-9]\d?)$/.test(hour) || Number(hour) > 23 || month !== '*') {
    return { kind: 'custom', cron };
  }
  const time = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  if (day === '*' && weekday === '*') return { kind: 'daily', time };
  if (day === '*' && /^[0-6](,[0-6])*$/.test(weekday)) {
    const weekdays = weekday.split(',').map(Number);
    if (new Set(weekdays).size === weekdays.length) return { kind: 'weekly', time, weekdays };
  }
  if (weekday === '*' && /^(?:[1-9]|[12]\d|3[01])$/.test(day)) return { kind: 'monthly', time, day: Number(day) };
  return { kind: 'custom', cron };
}

export function encodeSchedule(schedule) {
  if (schedule.kind === 'custom') return String(schedule.cron || '');
  const match = /^(\d{2}):(\d{2})$/.exec(String(schedule.time || ''));
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return '';
  const prefix = `${Number(match[2])} ${Number(match[1])}`;
  if (schedule.kind === 'daily') return `${prefix} * * *`;
  if (schedule.kind === 'monthly') {
    const day = Number(schedule.day);
    return Number.isInteger(day) && day >= 1 && day <= 31 ? `${prefix} ${day} * *` : '';
  }
  if (schedule.kind === 'weekly') {
    const days = schedule.weekdays;
    if (!Array.isArray(days) || !days.length || days.some(day => !Number.isInteger(day) || day < 0 || day > 6) || new Set(days).size !== days.length) return '';
    return `${prefix} * * ${days.join(',')}`;
  }
  return '';
}

export function describeSchedule(cron) {
  const schedule = decodeSchedule(cron);
  if (schedule.kind === 'daily') return 'По расписанию · каждый день';
  if (schedule.kind === 'monthly') return `По расписанию · ${schedule.day}-го числа`;
  if (schedule.kind === 'weekly') {
    const names = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
    return `По расписанию · ${schedule.weekdays.map(day => names[day]).join(', ')}`;
  }
  return 'Своё расписание';
}

export function subscriptionErrorSummary(value) {
  const error = String(value || '');
  if (/timed?\s*out|timeout/i.test(error)) return 'Сервер не ответил вовремя';
  if (/URL can't contain control|invalid\s*URL|unknown url type/i.test(error)) return 'Некорректный адрес подписки';
  const http = /HTTP(?:\s+Error)?\s+(\d{3})\b/i.exec(error);
  if (http) return `Сервер вернул ошибку HTTP ${http[1]}`;
  if (/certificate|CERTIFICATE_VERIFY_FAILED/i.test(error)) return 'Не удалось проверить сертификат сервера';
  if (/getaddrinfo|name resolution|name or service not known/i.test(error)) return 'Не удалось определить адрес сервера';
  if (/connection refused/i.test(error)) return 'Сервер отклонил соединение';
  return 'Не удалось загрузить подписку';
}
