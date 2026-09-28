// Включение и выключение защиты DNS перезапускают ядро, а вместе с ним может
// оборваться и соединение браузера: доступ через туннель, который сам идёт
// через ядро, пропадает на полминуты. Операция на роутере при этом доходит до
// конца, но ответ уходит в мёртвое соединение, и окно ждёт впустую.
//
// Поэтому окно шлёт с запросом свой номер операции, сервер записывает ответ под
// этим номером, а статус возвращает последнюю запись. Если ответ задержался или
// соединение оборвалось, окно переспрашивает статус и берёт итог оттуда — ровно
// тот ответ, который сервер отправил бы самому запросу.

export const DNS_OPERATION_STALL_MS = 20000;
export const DNS_OPERATION_POLL_MS = 3000;
export const DNS_OPERATION_STATUS_TIMEOUT_MS = 5000;
export const DNS_OPERATION_GIVE_UP_MS = 150000;

export const DNS_OPERATION_WAITING_TEXT =
  'Ответ от роутера задерживается — возможно, прервалась связь. Проверяем, чем закончилась операция…';
export const DNS_OPERATION_UNKNOWN_TEXT =
  'Связь с роутером не восстановилась, итог операции неизвестен. Обновите страницу, чтобы увидеть текущее состояние.';

export function newDnsOperationId() {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID().replace(/-/g, '');
    }
  } catch (error) {
    // Без crypto — запасной путь ниже.
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Ответ сервера — это и отказ с кодом 409: операция дошла и чем-то кончилась.
// Обрыв и тайм-аут кода не несут, итог по ним неизвестен.
function answered(outcome) {
  return !!outcome && (outcome.ok || Number(outcome.error && outcome.error.status) > 0);
}

function unwrap(outcome) {
  if (outcome.ok) return outcome.data;
  throw outcome.error;
}

function fromRecord(entry) {
  const body = (entry && typeof entry.body === 'object' && entry.body) || {};
  const code = Number(entry && entry.status_code) || 0;
  if (code >= 200 && code < 300 && body.ok !== false) return { ok: true, data: body };
  const error = new Error(String(body.error || 'Операция не выполнена.'));
  error.status = code || 500;
  error.data = body;
  error.recovered = true;
  return { ok: false, error };
}

function recordFor(operationId, source) {
  const entry = source && source.last_operation;
  return entry && entry.id === operationId ? entry : null;
}

/**
 * Выполняет запрос операции и, если ответ не пришёл, достаёт его из статуса.
 *
 * send()            — сам POST, промис с ответом сервера;
 * readStatus(ms)    — GET статуса окна с заданным тайм-аутом;
 * onWaiting()       — вызывается один раз, когда окно перешло к переспросу.
 */
export async function awaitDnsOperation({
  operationId,
  send,
  readStatus,
  onWaiting,
  stallMs = DNS_OPERATION_STALL_MS,
  pollMs = DNS_OPERATION_POLL_MS,
  statusTimeoutMs = DNS_OPERATION_STATUS_TIMEOUT_MS,
  giveUpMs = DNS_OPERATION_GIVE_UP_MS,
}) {
  let outcome = null;
  const request = Promise.resolve()
    .then(send)
    .then((data) => { outcome = { ok: true, data }; }, (error) => { outcome = { ok: false, error }; });
  const startedAt = Date.now();

  await Promise.race([request, sleep(stallMs)]);
  if (answered(outcome)) return unwrap(outcome);

  if (typeof onWaiting === 'function') {
    try { onWaiting(); } catch (error) { /* подсказка не важнее итога */ }
  }
  while (Date.now() - startedAt < giveUpMs) {
    if (answered(outcome)) return unwrap(outcome);
    let entry = null;
    try {
      entry = recordFor(operationId, await readStatus(statusTimeoutMs));
    } catch (error) {
      // Статус тоже мог не дойти; отказ статуса приносит запись в теле.
      entry = recordFor(operationId, error && error.data);
    }
    if (answered(outcome)) return unwrap(outcome);
    if (entry) return unwrap(fromRecord(entry));
    await Promise.race([request, sleep(pollMs)]);
  }
  if (answered(outcome)) return unwrap(outcome);
  const error = new Error(DNS_OPERATION_UNKNOWN_TEXT);
  error.code = 'operation_unknown';
  error.unknown = true;
  throw error;
}
