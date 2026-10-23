// Records for DevTools -> Logs: the panel's own log files read as a table.
//
// core.log (and ws.log) are written by Python logging as
// `YYYY-MM-DD HH:MM:SS,mmm [LEVEL] message | key=value, key=value`; a traceback
// follows its line unprefixed. update.log is the old updater's run log, read
// here as one record per run. restart.log is the Xkeen operations journal: a
// result line per operation, with the output of xkeen and the core written
// right before it. Everything else is plain text with whatever time and tag a
// line happens to carry.
//
// The whole window is rebuilt on every update: the files are small and slow
// next to Xray's access.log, and grouping (runs, journal output) depends on
// lines that arrive later.

import { RESTART_SOURCE_META, RESTART_SUMMARY_RE, restartSourceLabel } from './restart_log_sources.js';

const CORE_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:[,.](\d{1,6}))? \[([A-Za-z]+)\] ?(.*)$/;
const KV_KEY_RE = /(?:^|, )([A-Za-z_][\w.-]*)=/g;
const ISO_BRACKET_RE = /^\[(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?Z?\]\s?(.*)$/;
const XRAY_TS_RE = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d+)?\s*(?:\[([A-Za-z]+)\])?\s*(.*)$/;
const HTTP_RE = /^\S+ - \S+ \[(\d{2})\/([A-Za-z]{3})\/(\d{4})[ :](\d{2}:\d{2}:\d{2})[^\]]*\] (.*)$/;
const TAG_RE = /^\[([A-Za-z][\w-]{0,23})\]\s*(.*)$/;
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_RU = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const ERROR_RE = /\b(error|errors|failed|failure|traceback|exception|fatal|critical)\b|ошибк|не удалось/i;
const WARNING_RE = /\b(warn|warning)\b|предупрежд/i;

// Where a core.log line comes from, by the start of its message.
const CORE_SOURCES = [
  [/^DNS-over-VLESS|^dns_over_vless/i, 'DNS-over-VLESS'],
  [/^xkeen-ui init\b/i, 'Запуск панели'],
  [/^(panel\b|logging setup|core logger|core_log|broadcast_event)/i, 'Панель'],
  [/^(xray |mihomo )?subscriptions?\b/i, 'Подписки'],
  [/^(fileops|fs|remotefs)[.:\s]/i, 'Файлы'],
  [/^self_update\b/i, 'Обновление'],
  [/^snapshot/i, 'Снимки'],
  [/^memory guard/i, 'Память'],
  [/^routing\b/i, 'Маршрутизация'],
  [/^xkeen[.:\s]/i, 'Xkeen'],
  [/^devtools\b/i, 'DevTools'],
  [/^(xray_assets|geodat|xk-geodat)/i, 'Геофайлы'],
  [/^happ\b/i, 'Утилита ссылок'],
  [/^mihomo\b/i, 'Mihomo'],
  [/^xray\b/i, 'Xray'],
];

export function panelLogKind(name) {
  const base = String(name || '').replace(/\.\d+$/, '');
  if (base === 'update') return 'update';
  if (base === 'restart') return 'restart';
  if (base === 'stdout' || base === 'stderr' || base === 'xkeen-ui') return 'text';
  return 'core';
}

function normLevel(raw) {
  const v = String(raw || '').toLowerCase();
  if (v.startsWith('debug')) return 'debug';
  if (v.startsWith('warn')) return 'warning';
  if (v.startsWith('err') || v === 'critical' || v.startsWith('fatal')) return 'error';
  return 'info';
}

function guessLevel(text) {
  if (ERROR_RE.test(text)) return 'error';
  if (WARNING_RE.test(text) || /^\[!\]/.test(text)) return 'warning';
  return 'info';
}

export function splitPanelLogKv(text) {
  const src = String(text || '');
  const keys = [];
  KV_KEY_RE.lastIndex = 0;
  let m;
  while ((m = KV_KEY_RE.exec(src))) keys.push({ key: m[1], start: m.index, valueAt: KV_KEY_RE.lastIndex });
  if (!keys.length || keys[0].start !== 0) return null;
  return keys.map((k, i) => [k.key, src.slice(k.valueAt, i + 1 < keys.length ? keys[i + 1].start : src.length)]);
}

export function panelLogCoreSource(msg) {
  const text = String(msg || '').trim();
  for (const [re, label] of CORE_SOURCES) if (re.test(text)) return label;
  const word = text.split(/[.:\s]/, 1)[0] || '';
  return word.slice(0, 24);
}

export function panelLogDayLabel(date, now) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  if (!m) return '';
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const ref = now instanceof Date ? now : new Date();
  const base = `${d} ${MONTHS_RU[mo] || ''}`;
  const day = Date.UTC(y, mo, d);
  const today = Date.UTC(ref.getFullYear(), ref.getMonth(), ref.getDate());
  if (day === today) return `Сегодня, ${base}`;
  if (day === today - 86400000) return `Вчера, ${base}`;
  return y === ref.getFullYear() ? base : `${base} ${y}`;
}

function record(fields) {
  return Object.assign({
    id: '',
    date: '',
    time: '',
    level: 'info',
    source: '',
    msg: '',
    kv: [],
    extra: [],
    steps: [],
    raw: [],
    rep: 1,
    firstDate: '',
    firstTime: '',
    dur: '',
    key: '',
    text: '',
  }, fields);
}

function finish(records, fold) {
  const out = [];
  const seen = new Map();
  for (const rec of records) {
    rec.firstDate = rec.firstDate || rec.date;
    rec.firstTime = rec.firstTime || rec.time;
    const prev = out[out.length - 1];
    if (fold && prev && rec.key && prev.key === rec.key && !rec.extra.length && !prev.extra.length) {
      prev.rep += 1;
      prev.date = rec.date;
      prev.time = rec.time;
      prev.raw = rec.raw;
      continue;
    }
    out.push(rec);
  }
  for (const rec of out) {
    // Identified by its first line and how many times that line came before:
    // stable while the window grows, so an open row stays open.
    const first = rec.raw[0] || rec.msg;
    const n = (seen.get(first) || 0) + 1;
    seen.set(first, n);
    rec.id = `${n}:${first}`;
    rec.text = [rec.source, rec.msg, ...rec.kv.map(([k, v]) => `${k}=${v}`), ...rec.raw, ...rec.extra]
      .join('\n')
      .toLowerCase();
  }
  return out;
}

// ---------- core.log ----------

function parseCoreLine(line) {
  const m = CORE_RE.exec(line);
  if (!m) return null;
  const rest = m[5] || '';
  const bar = rest.indexOf(' | ');
  let msg = rest;
  let kv = [];
  if (bar >= 0) {
    const parsed = splitPanelLogKv(rest.slice(bar + 3));
    if (parsed) {
      msg = rest.slice(0, bar);
      kv = parsed;
    }
  }
  const source = panelLogCoreSource(msg);
  // "DNS-over-VLESS: правило…" -- the source column already says it.
  if (source && msg.startsWith(`${source}: `)) msg = msg.slice(source.length + 2);
  return record({
    date: m[1],
    time: m[2],
    level: normLevel(m[4]),
    source,
    msg,
    kv,
    raw: [line],
    key: `${normLevel(m[4])}|${rest}`,
  });
}

function buildCore(lines) {
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const rec = parseCoreLine(line);
    if (rec) {
      out.push(rec);
    } else if (out.length) {
      out[out.length - 1].extra.push(line);
    } else {
      out.push(record({ level: guessLevel(line), msg: line, raw: [line], key: `raw|${line}` }));
    }
  }
  return out;
}

// ---------- plain text ----------

function parseTextLine(line) {
  let m = CORE_RE.exec(line);
  if (m) return parseCoreLine(line);
  m = ISO_BRACKET_RE.exec(line);
  if (m) {
    const tag = TAG_RE.exec(m[3]);
    const msg = tag ? tag[2] : m[3];
    return record({ date: m[1], time: m[2], level: guessLevel(m[3]), source: tag ? tag[1] : '', msg, raw: [line], key: `t|${m[3]}` });
  }
  m = XRAY_TS_RE.exec(line);
  if (m) {
    const level = m[5] ? normLevel(m[5]) : guessLevel(m[6]);
    return record({ date: `${m[1]}-${m[2]}-${m[3]}`, time: m[4], level, msg: m[6], raw: [line], key: `x|${m[5] || ''}|${m[6]}` });
  }
  m = HTTP_RE.exec(line);
  if (m) {
    const mo = String(MONTHS_EN.indexOf(m[2]) + 1).padStart(2, '0');
    const status = /"\s+(\d{3})\b/.exec(m[5]);
    const code = status ? Number(status[1]) : 0;
    const level = code >= 500 ? 'error' : (code >= 400 ? 'warning' : 'info');
    return record({ date: `${m[3]}-${mo}-${m[1]}`, time: m[4], level, source: 'HTTP', msg: m[5], raw: [line], key: '' });
  }
  m = TAG_RE.exec(line);
  if (m) return record({ level: guessLevel(m[2]), source: m[1], msg: m[2], raw: [line], key: `g|${line}` });
  return record({ level: guessLevel(line), msg: line, raw: [line], key: `r|${line}` });
}

function buildText(lines) {
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const prev = out[out.length - 1];
    // Indented lines and the closing line of a traceback belong to the line above.
    const continues = prev && (/^\s/.test(line) || (/^[\w.]+(Error|Exception|Exit|Interrupt)\b/.test(line) && prev.extra.length));
    if (continues) {
      prev.extra.push(line);
      continue;
    }
    out.push(parseTextLine(line));
  }
  return out;
}

// ---------- update.log ----------

function secondsBetween(a, b) {
  const t1 = Date.parse(`${a.date}T${a.time}Z`);
  const t2 = Date.parse(`${b.date}T${b.time}Z`);
  if (!Number.isFinite(t1) || !Number.isFinite(t2) || t2 < t1) return '';
  const s = Math.round((t2 - t1) / 1000);
  return s >= 60 ? `${Math.floor(s / 60)} мин ${s % 60} с` : `${s} с`;
}

function finishRun(run) {
  const tag = (run.steps.find(([, t]) => /^Latest tag: /.test(t)) || [])[1];
  const version = tag ? tag.replace(/^Latest tag: /, '') : '';
  if (version) run.kv.push(['Выпуск', version]);
  const rollback = run.steps.some(([, t]) => /^Rollback from: /.test(t));
  if (run.done) {
    run.level = 'ok';
    run.msg = rollback ? 'Панель откачена из копии' : (version ? `Панель обновлена до ${version}` : 'Обновление завершено');
  } else if (run.warn) {
    run.level = 'error';
    run.msg = `Обновление прервано: ${run.warn}`;
  } else {
    run.level = run.closed ? 'error' : 'info';
    run.msg = run.closed ? 'Обновление оборвалось без итога' : 'Обновление идёт';
  }
  return run;
}

function buildUpdate(lines) {
  const out = [];
  let run = null;
  const close = () => {
    if (run) {
      run.closed = true;
      out.push(finishRun(run));
    }
    run = null;
  };
  for (const line of lines) {
    const m = ISO_BRACKET_RE.exec(line);
    const body = m ? m[3] : line;
    if (m && /^=== .*updater start ===$/.test(body)) {
      close();
      run = record({ date: m[1], time: m[2], source: 'Обновление панели', raw: [line], done: false, warn: '', closed: false });
      continue;
    }
    if (!run) {
      if (!line.trim()) continue;
      run = record({ date: m ? m[1] : '', time: m ? m[2] : '', source: 'Обновление панели', raw: [], done: false, warn: '', closed: false });
    }
    run.raw.push(line);
    if (m && /^=== .*updater done ===$/.test(body)) {
      run.done = true;
      run.dur = secondsBetween(run, { date: m[1], time: m[2] });
      out.push(finishRun(run));
      run = null;
      continue;
    }
    if (m && /^repo=/.test(body)) {
      const ch = /\bchannel=(\S+)/.exec(body);
      const act = /\baction=(\S+)/.exec(body);
      if (ch) run.kv.push(['Канал', ch[1]]);
      if (act) run.kv.push(['Действие', act[1]]);
      continue;
    }
    if (m && /^\[\*\] /.test(body)) {
      run.steps.push([m[2], body.slice(4)]);
      continue;
    }
    if (m && /^\[!\] /.test(body)) {
      run.warn = body.slice(4);
      run.steps.push([m[2], body.slice(4)]);
      continue;
    }
    if (line.trim()) run.extra.push(line);
  }
  if (run) out.push(finishRun(run));
  // Every run is its own record: nothing to fold.
  out.forEach((r) => { r.key = ''; delete r.done; delete r.warn; delete r.closed; });
  return out;
}

// ---------- restart.log ----------

function decodeValue(value) {
  try {
    return decodeURIComponent(String(value || '').replace(/\+/g, '%20'));
  } catch (e) {
    return String(value || '');
  }
}

function buildRestart(lines) {
  const out = [];
  let pending = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = RESTART_SUMMARY_RE.exec(line);
    if (!m) {
      pending.push(line);
      continue;
    }
    const source = decodeValue(m[2]).trim();
    const ok = String(m[3] || '').toUpperCase() === 'OK';
    const meta = RESTART_SOURCE_META[source] || null;
    const kv = [];
    const re = /([A-Za-z0-9_.-]+)=(\S+)/g;
    let kvm;
    while ((kvm = re.exec(m[4] || ''))) kv.push([kvm[1], decodeValue(kvm[2])]);
    const [date, time] = String(m[1]).split(' ');
    out.push(record({
      date,
      time,
      level: ok ? 'ok' : 'error',
      source: restartSourceLabel(source),
      msg: ok
        ? (meta && meta.successText ? meta.successText : 'операция завершилась успешно')
        : (meta && meta.failureText ? meta.failureText : 'операция завершилась с ошибкой'),
      kv,
      extra: pending,
      raw: [line],
    }));
    pending = [];
  }
  if (pending.length) {
    out.push(record({ level: 'info', source: 'Xkeen', msg: 'вывод без итога', extra: pending, raw: [] }));
  }
  return out;
}

export function buildPanelLogRecords(kind, lines, options) {
  const fold = !options || options.fold !== false;
  const src = (Array.isArray(lines) ? lines : []).map((l) => String(l == null ? '' : l).replace(/[\r\n]+$/, ''));
  if (kind === 'update') return finish(buildUpdate(src), false);
  if (kind === 'restart') return finish(buildRestart(src), false);
  if (kind === 'text') return finish(buildText(src), fold);
  return finish(buildCore(src), fold);
}
