/* One voice for the shared port-53 guard.
 *
 * The guard itself (``services/dns_guard.py``) is a single loop that watches
 * whichever DNS protection is on — DNS-over-VLESS under Xray or the Mihomo DNS
 * assistant — and behaves identically for both.  Its windows used to describe
 * it in their own words: the Xray one spoke about "the core" as if only Xray
 * could ever be guarded, and the Mihomo one said nothing at all.  A user who
 * switched cores saw two different stories about one mechanism.
 *
 * Every sentence about the guard now comes from here, and none of them names a
 * core: what matters to the reader is whether the guard is watching, whether it
 * is switched off, and whether it has already handed DNS back to the router.
 */

export const GUARD_RELEASED_BADGE = 'Снято сторожем';

const DEFAULTS = Object.freeze({ interval: 30, fail_threshold: 3, restart_attempts: 0 });

function plural(count, one, many) {
  const n = Math.abs(Number(count) || 0);
  return (n % 10 === 1 && n % 100 !== 11) ? one : many;
}

function knobs(settings) {
  const cfg = settings || {};
  return {
    interval: Math.round(Number(cfg.interval) || DEFAULTS.interval),
    fails: Math.round(Number(cfg.fail_threshold) || DEFAULTS.fail_threshold),
    restarts: Math.round(Number(cfg.restart_attempts) || DEFAULTS.restart_attempts),
    off: cfg.enabled === false,
  };
}

/** The guard's own release record, if it stood the protection down. */
export function guardRelease(data) {
  const record = data && data.watchdog;
  return (record && record.reason) ? record : null;
}

/** Why the protection is off, in the guard's words — the same in both windows. */
export function guardReleaseText(data) {
  const record = guardRelease(data);
  if (!record) return '';
  const reason = String(record.reason || '').trim();
  const tail = reason.endsWith('.') ? reason : `${reason}.`;
  if (record.source === 'user') {
    return `DNS возвращён роутеру по вашей команде: ${tail} Пользовательский DNS-блок сохранён, его переключатель enable выключен.`;
  }
  const preserved = record.preserved_current
    ? ' Текущий DNS-блок сохранён и отключён без возврата старого снимка.'
    : '';
  return `Сторож вернул DNS роутеру: ${tail} Порт 53 снова обслуживает прошивка, запросы идут в открытом виде — защита сама не включится.${preserved}`;
}

function releasedAtLabel(record) {
  const seconds = Number(record && record.released_at);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  try {
    return new Date(seconds * 1000).toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch (error) {
    return '';
  }
}

/**
 * The same fact for the details list, in one line.
 *
 * The paragraph above the list already carries the guard's reason; repeating it
 * verbatim made the window say the same thing twice, so the line adds the one
 * thing the paragraph has no room for — when the guard actually acted.
 */
export function guardReleaseLine(data) {
  const record = guardRelease(data);
  if (!record) return '';
  const when = releasedAtLabel(record);
  if (record.source === 'user') {
    return when
      ? `Возврат DNS: выполнен ${when} по команде пользователя; текущий DNS-блок сохранён и отключён.`
      : 'Возврат DNS: выполнен по команде пользователя; текущий DNS-блок сохранён и отключён.';
  }
  const preserved = record.preserved_current ? ' Текущий DNS-блок сохранён.' : '';
  return when
    ? `Сторож: сработал ${when} — DNS возвращён роутеру, защита выключена.${preserved}`
    : `Сторож: сработал — DNS возвращён роутеру, защита выключена.${preserved}`;
}

/** Short decoding for the badge tooltip and the summary line. */
export function guardReleaseSummary() {
  return 'сторож вернул DNS роутеру, защита выключена';
}

/**
 * The single line the details list shows about the guard.
 *
 * ``enabled`` is this window's protection, not the guard: while it is off the
 * guard may well be watching the other one, so the wording never claims that
 * nothing is guarded — only that there is nothing to guard *here*.
 */
export function guardNotice(data, enabled) {
  const released = enabled ? '' : guardReleaseLine(data);
  if (released) return { text: released, kind: 'warn' };

  const { interval, fails, restarts, off } = knobs(data && data.watchdog_settings);
  if (off) {
    return {
      text: 'Сторож отключён настройкой: если разрешение имён откажет, сеть останется без DNS, пока вы не вмешаетесь вручную.',
      kind: 'warn',
    };
  }
  if (!enabled) {
    return {
      text: `Сторож общий для обеих защит DNS и следит за той, что включена. Здесь защита выключена — сторожить нечего; после включения он станет проверять разрешение имён каждые ${interval}\u00A0с.`,
      kind: 'ok',
    };
  }
  const tail = restarts > 0
    ? `перезапустит активное ядро (до ${restarts} ${plural(restarts, 'попытки', 'попыток')}), а если не поможет — вернёт DNS роутеру`
    : 'сразу вернёт DNS роутеру — перезапуски отключены настройкой';
  return {
    text: `Сторож следит: проверяет разрешение имён каждые ${interval}\u00A0с; после ${fails} ${plural(fails, 'сбоя', 'сбоев')} подряд ${tail}.`,
    kind: 'ok',
  };
}

/**
 * What saves the network when DNS goes quiet.
 *
 * The card warns that a total proxy outage leaves DNS unanswered, and without
 * this the sentence reads as a dead end.  The rescue is real -- the guard
 * hands port 53 back to the firmware -- but not free, so both halves are said
 * here.  Same wording as ``guard_rescue_note`` in services/dns_over_vless.py,
 * which appends it to the reason the server composes for a single proxy.
 */
export function guardRescueNote(data) {
  const { off } = knobs(data && data.watchdog_settings);
  if (off) return 'Сторож отключён настройкой — вернуть DNS роутеру автоматически будет некому.';
  return 'Без имён сеть не останется: сторож заметит молчание и вернёт DNS роутеру, выключив защиту, — с этого момента имена снова видит провайдер, а включить функцию обратно нужно вручную.';
}

export default {
  GUARD_RELEASED_BADGE,
  guardNotice,
  guardRelease,
  guardReleaseLine,
  guardReleaseSummary,
  guardReleaseText,
  guardRescueNote,
};
