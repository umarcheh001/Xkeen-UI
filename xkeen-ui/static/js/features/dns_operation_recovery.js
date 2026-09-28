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

export const DNS_OPERATION_WAITING_TITLE = 'Ждём ответа роутера';
export const DNS_OPERATION_WAITING_TEXT =
  'Ответ задерживается — скорее всего, прервалась связь: так бывает, когда перезапускается ядро, '
  + 'а к роутеру вы подключены через туннель. Операция на роутере продолжается; окно само покажет '
  + 'итог, как только связь вернётся. Ничего нажимать не нужно.';
export const DNS_OPERATION_UNKNOWN_TITLE = 'Итог операции неизвестен';
export const DNS_OPERATION_UNKNOWN_TEXT =
  'Связь с роутером не восстановилась за две с половиной минуты. Операция на роутере могла '
  + 'завершиться — обновите страницу, чтобы увидеть текущее состояние.';

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
 * onWaiting(start)  — вызывается один раз, когда окно перешло к переспросу;
 *                     start — момент отправки запроса, для счётчика секунд.
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
    try { onWaiting(startedAt); } catch (error) { /* подсказка не важнее итога */ }
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
    // Пока запрос ещё висит, его ответ может прийти раньше паузы. Упавший
    // запрос уже ничего не принесёт, и гонка с ним закончилась бы мгновенно:
    // без паузы окно засыпало бы роутер запросами статуса.
    await (outcome ? sleep(pollMs) : Promise.race([request, sleep(pollMs)]));
  }
  if (answered(outcome)) return unwrap(outcome);
  const error = new Error(DNS_OPERATION_UNKNOWN_TEXT);
  error.code = 'operation_unknown';
  error.unknown = true;
  throw error;
}


const SVG_NS = 'http://www.w3.org/2000/svg';
const ICON_PATHS = {
  // Стрелка по кругу: идёт процесс.
  info: ['M21 12a9 9 0 1 1-3-6.7', 'M21 4v5h-5'],
  // Треугольник с восклицательным знаком: нужно действие человека.
  warn: ['M12 3 2 21h20L12 3z', 'M12 10v5', 'M12 18h.01'],
};

function noticeIcon(tone) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('xk-dns-op-notice-icon');
  (ICON_PATHS[tone] || ICON_PATHS.info).forEach((d) => {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  });
  return svg;
}

/**
 * Плашка в строке статуса и кнопка со счётчиком на время ожидания.
 *
 * labelId — элемент подписи внутри кнопки, если в ней есть иконка.
 *
 * Окно перерисовывает строку статуса и кнопку по каждому ответу сервера,
 * поэтому плашка накладывается поверх, а окно зовёт paint() в конце своей
 * отрисовки. Синяя плашка — ждём, делать ничего не нужно; оранжевая — итог
 * так и не пришёл, человеку пора обновить страницу.
 */
export function createDnsOperationNotice({ statusId, buttonId, labelId = '' }) {
  let notice = null;
  let timer = null;

  function stopTimer() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function releaseButton() {
    const button = document.getElementById(buttonId);
    if (!button) return;
    button.removeAttribute('aria-disabled');
    button.classList.remove('xk-dns-op-waiting');
  }

  function paint() {
    if (!notice) return;
    const waiting = notice.kind === 'wait';
    const tone = waiting ? 'info' : 'warn';
    const seconds = waiting ? Math.max(0, Math.round((Date.now() - notice.startedAt) / 1000)) : 0;
    const status = document.getElementById(statusId);
    if (status) {
      let box = status.querySelector(':scope > .xk-dns-op-notice');
      if (!box || box.dataset.tone !== tone) {
        status.textContent = '';
        box = document.createElement('div');
        box.className = 'xk-dns-op-notice';
        box.dataset.tone = tone;
        box.setAttribute('role', 'status');
        const body = document.createElement('div');
        body.className = 'xk-dns-op-notice-body';
        const title = document.createElement('b');
        title.className = 'xk-dns-op-notice-title';
        const text = document.createElement('span');
        text.className = 'xk-dns-op-notice-text';
        text.textContent = waiting ? DNS_OPERATION_WAITING_TEXT : DNS_OPERATION_UNKNOWN_TEXT;
        body.append(title, text);
        box.append(noticeIcon(tone), body);
        status.appendChild(box);
      }
      box.querySelector('.xk-dns-op-notice-title').textContent = waiting
        ? `${DNS_OPERATION_WAITING_TITLE} · ${seconds} с`
        : DNS_OPERATION_UNKNOWN_TITLE;
    }
    const button = document.getElementById(buttonId);
    if (button && waiting) {
      // Кнопка остаётся яркой — бледную выключенную со счётчиком никто не
      // заметит. Нажатия окно и так не примет, пока идёт операция.
      button.disabled = false;
      button.setAttribute('aria-disabled', 'true');
      button.classList.add('xk-dns-op-waiting');
      // У кнопки с иконкой подпись в своём элементе — иконку не трогаем.
      const label = labelId ? document.getElementById(labelId) : null;
      (label || button).textContent = `${DNS_OPERATION_WAITING_TITLE}… ${seconds} с`;
    }
  }

  return {
    waiting(startedAt) {
      stopTimer();
      notice = { kind: 'wait', startedAt: Number(startedAt) || Date.now() };
      paint();
      timer = setInterval(paint, 1000);
    },
    unknown() {
      stopTimer();
      releaseButton();
      notice = { kind: 'unknown' };
      paint();
    },
    clear() {
      stopTimer();
      releaseButton();
      notice = null;
    },
    paint,
  };
}
