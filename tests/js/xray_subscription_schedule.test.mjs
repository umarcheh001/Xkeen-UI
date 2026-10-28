import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeSchedule, encodeSchedule, describeSchedule, subscriptionErrorSummary } from '../../xkeen-ui/static/js/features/xray_subscription_schedule.js';

test('simple daily, weekly and monthly schedules round-trip', () => {
  for (const cron of ['0 4 * * *', '30 8 * * 1,3,5', '15 9 31 * *']) {
    assert.equal(encodeSchedule(decodeSchedule(cron)), cron);
  }
});

test('calendar description hides cron syntax from ordinary schedules', () => {
  assert.equal(describeSchedule('0 4 * * *'), 'По расписанию · каждый день');
  assert.equal(describeSchedule('30 8 * * 1,3,5'), 'По расписанию · Пн, Ср, Пт');
  assert.equal(describeSchedule('15 9 31 * *'), 'По расписанию · 31-го числа');
  assert.equal(describeSchedule('*/15 * * * *'), 'Своё расписание');
});

test('complex schedules remain unchanged in expert mode', () => {
  for (const cron of ['*/15 8-18 * * 1-5', '0 4 1 * 1', '0 4 * 2 *']) {
    assert.deepEqual(decodeSchedule(cron), { kind: 'custom', cron });
    assert.equal(encodeSchedule(decodeSchedule(cron)), cron);
  }
});

test('invalid simple values cannot generate a cron expression', () => {
  assert.equal(encodeSchedule({ kind: 'weekly', time: '04:00', weekdays: [] }), '');
  assert.equal(encodeSchedule({ kind: 'monthly', time: '25:00', day: 1 }), '');
  assert.equal(encodeSchedule({ kind: 'monthly', time: '04:00', day: 32 }), '');
});

test('subscription errors explain known causes without echoing secrets', () => {
  assert.equal(subscriptionErrorSummary('<urlopen error timed out>'), 'Сервер не ответил вовремя');
  assert.equal(subscriptionErrorSummary("URL can't contain control characters. '/sub?token=private-secret bad'"), 'Некорректный адрес подписки');
  assert.equal(subscriptionErrorSummary('HTTP Error 403 for https://example.com/?token=secret'), 'Сервер вернул ошибку HTTP 403');
  assert.equal(subscriptionErrorSummary('provider failed with token=secret'), 'Не удалось загрузить подписку');
});
