// Unit tests for the opt-in send window (quiet hours). Pure + clock-injectable.
// End-to-end enforcement (campaign halt / follow-up defer) is in the DB tier.

import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveSendWindow, isWithinSendWindow, localHourAndWeekday } from '../packages/backend-core/src/lib/sendWindow.ts'

test('resolve: null unless both hours are present and valid', () => {
  assert.equal(resolveSendWindow(null), null)
  assert.equal(resolveSendWindow({ sendWindowStartHour: 9, sendWindowEndHour: null }), null)
  assert.equal(resolveSendWindow({ sendWindowStartHour: 9, sendWindowEndHour: 25 }), null, 'out-of-range → unconfigured')
  const cfg = resolveSendWindow({ sendWindowStartHour: 9, sendWindowEndHour: 17, sendTimezone: 'America/New_York', sendWeekdaysOnly: true })
  assert.deepEqual(cfg, { startHour: 9, endHour: 17, timeZone: 'America/New_York', weekdaysOnly: true })
})

test('resolve: defaults timezone to UTC when not set', () => {
  const cfg = resolveSendWindow({ sendWindowStartHour: 8, sendWindowEndHour: 18 })
  assert.equal(cfg!.timeZone, 'UTC')
  assert.equal(cfg!.weekdaysOnly, false)
})

test('within window: a UTC mid-window time is allowed, outside is blocked', () => {
  const cfg = { startHour: 9, endHour: 17, timeZone: 'UTC', weekdaysOnly: false }
  // 2026-06-22 is a Monday. 12:00Z is inside 9–17.
  assert.equal(isWithinSendWindow(new Date('2026-06-22T12:00:00Z'), cfg), true)
  assert.equal(isWithinSendWindow(new Date('2026-06-22T03:00:00Z'), cfg), false)
  assert.equal(isWithinSendWindow(new Date('2026-06-22T17:00:00Z'), cfg), false, 'end hour is exclusive')
})

test('within window: respects the timezone offset', () => {
  const cfg = { startHour: 9, endHour: 17, timeZone: 'America/New_York', weekdaysOnly: false }
  // 13:00Z = 09:00 EDT (Mon) → inside; 12:00Z = 08:00 EDT → outside.
  assert.equal(isWithinSendWindow(new Date('2026-06-22T13:00:00Z'), cfg), true)
  assert.equal(isWithinSendWindow(new Date('2026-06-22T12:00:00Z'), cfg), false)
})

test('within window: weekdaysOnly blocks the weekend', () => {
  const cfg = { startHour: 0, endHour: 24, timeZone: 'UTC', weekdaysOnly: true }
  // 2026-06-20 is a Saturday, 2026-06-21 Sunday, 2026-06-22 Monday.
  assert.equal(isWithinSendWindow(new Date('2026-06-20T12:00:00Z'), cfg), false)
  assert.equal(isWithinSendWindow(new Date('2026-06-21T12:00:00Z'), cfg), false)
  assert.equal(isWithinSendWindow(new Date('2026-06-22T12:00:00Z'), cfg), true)
})

test('within window: fail-open on a misconfigured window or bad timezone', () => {
  assert.equal(isWithinSendWindow(new Date('2026-06-22T03:00:00Z'), { startHour: 17, endHour: 9, timeZone: 'UTC', weekdaysOnly: false }), true, 'start>=end → no constraint')
  assert.equal(isWithinSendWindow(new Date('2026-06-22T03:00:00Z'), { startHour: 9, endHour: 17, timeZone: 'Not/AZone', weekdaysOnly: false }), true, 'bad tz → fail open')
})

test('localHourAndWeekday: converts into the target timezone', () => {
  const { hour, weekday } = localHourAndWeekday(new Date('2026-06-22T13:30:00Z'), 'America/New_York')
  assert.equal(hour, 9)   // 13:30Z = 09:30 EDT
  assert.equal(weekday, 1) // Monday
})
