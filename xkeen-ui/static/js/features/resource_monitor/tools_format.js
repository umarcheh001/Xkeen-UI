// Small text helpers of the tool tabs: escaping, numbers, sizes, rates, durations.
// Every string that comes from the router or the server goes through esc().

export const NBSP = " ";

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

export function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function toNumber(value) {
  if (value == null || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function num(value, digits = 0) {
  if (!finite(value)) return "—";
  return value.toLocaleString("ru-RU", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

// 1536 -> "1,5 КБ"; the digit count follows the size (two significant digits at least).
export function bytesText(value) {
  const amount = toNumber(value);
  if (amount == null || amount < 0) return "—";
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  let current = amount;
  let unit = 0;
  while (current >= 1024 && unit < units.length - 1) {
    current /= 1024;
    unit += 1;
  }
  return `${num(current, current >= 10 || unit === 0 ? 0 : 1)}${NBSP}${units[unit]}`;
}

const BIT_UNITS = ["бит/с", "Кбит/с", "Мбит/с", "Гбит/с"];

export function bitsText(value) {
  const amount = toNumber(value);
  if (amount == null || amount < 0) return "—";
  let current = amount;
  let unit = 0;
  while (current >= 1000 && unit < BIT_UNITS.length - 1) {
    current /= 1000;
    unit += 1;
  }
  return `${num(current, current >= 10 || unit === 0 ? 0 : 1)}${NBSP}${BIT_UNITS[unit]}`;
}

// "5,6 / 0,8 Мбит/с": two values of one kind share the unit of the bigger one.
export function bitsPairText(first, second) {
  const a = toNumber(first);
  const b = toNumber(second);
  if (a == null && b == null) return "—";
  const top = Math.max(a ?? 0, b ?? 0);
  let unit = 0;
  let divisor = 1;
  while (top / divisor >= 1000 && unit < BIT_UNITS.length - 1) {
    divisor *= 1000;
    unit += 1;
  }
  const part = (value) => (value == null ? "—" : num(value / divisor, value / divisor >= 10 || unit === 0 ? 0 : 1));
  return `${part(a)} / ${part(b)}${NBSP}${BIT_UNITS[unit]}`;
}

const BYTE_UNITS = ["Б", "КБ", "МБ", "ГБ", "ТБ"];

export function bytesPairText(first, second) {
  const a = toNumber(first);
  const b = toNumber(second);
  if (a == null && b == null) return "—";
  const top = Math.max(a ?? 0, b ?? 0);
  let unit = 0;
  let divisor = 1;
  while (top / divisor >= 1024 && unit < BYTE_UNITS.length - 1) {
    divisor *= 1024;
    unit += 1;
  }
  const part = (value) => (value == null ? "—" : num(value / divisor, value / divisor >= 10 || unit === 0 ? 0 : 1));
  return `${part(a)} / ${part(b)}${NBSP}${BYTE_UNITS[unit]}`;
}

// 65 -> "1 ч 5 мин", 12 -> "12 мин", 3 -> "меньше минуты", 90000 -> "1 д 1 ч".
export function durationText(seconds) {
  const value = toNumber(seconds);
  if (value == null || value < 0) return "";
  const minutes = Math.floor(value / 60);
  if (minutes < 1) return "меньше минуты";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days) return hours ? `${days} д ${hours} ч` : `${days} д`;
  if (hours) return rest ? `${hours} ч ${rest} мин` : `${hours} ч`;
  return `${rest} мин`;
}

export function clockText(seconds, withSeconds = false) {
  const value = toNumber(seconds);
  if (value == null) return "";
  return new Date(value * 1000).toLocaleTimeString("ru-RU", withSeconds
    ? { hour: "2-digit", minute: "2-digit", second: "2-digit" }
    : { hour: "2-digit", minute: "2-digit" });
}

export function percentWidth(value, min, max) {
  const number = toNumber(value);
  if (number == null || max <= min) return 0;
  return Math.max(0, Math.min(100, ((number - min) / (max - min)) * 100));
}
