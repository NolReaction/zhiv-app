import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
const store = await vite.ssrLoadModule("/lib/dev-api-store.ts");
const dates = await vite.ssrLoadModule("/lib/check-in-calendar.ts");
beforeEach(() => store.resetDevStoreForTests());
after(async () => vite.close());

test("calendar accepts precise month keys and preserves leap and early civil dates", () => {
  for (const value of ["0001-01", "2024-02", "9999-12"]) assert.equal(dates.isCalendarMonth(value), true);
  for (const value of ["", "2024-2", "2024-13", "0000-01", "10000-01", "2024-02-01", " 2024-02"]) assert.equal(dates.isCalendarMonth(value), false);
  for (const value of ["0001-01-01", "0099-12-31", "2024-02-29", "2026-12-31", "9999-12-31"]) {
    assert.equal(dates.calendarDateKey(dates.calendarDate(value)), value);
  }
  assert.equal(dates.calendarDateKey(dates.calendarDate("2026-09")), "2026-09-01");
});

test("empty calendar defaults to the server profile month across UTC midnight", context => {
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2024-02-29T21:30:00Z") });
  const identity = store.createDevIdentity("Calendar", crypto.randomUUID());
  const calendar = store.getDevCheckInCalendar(identity.token, null);
  assert.equal(calendar.month, "2024-03");
  assert.equal(calendar.today, "2024-03-01");
  assert.equal(calendar.firstMonth, "2024-03");
  assert.equal(calendar.timeZone, "Europe/Moscow");
  assert.deepEqual(calendar.days, []);
  assert.equal(store.getDevCheckInCalendar(undefined, null), null);
  assert.equal(store.getDevCheckInCalendar("forged", null), null);
});

test("calendar groups real marks by saved local day without replay or other users", context => {
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2024-02-28T20:59:00Z") });
  const owner = store.createDevIdentity("Owner", crypto.randomUUID());
  const other = store.createDevIdentity("Other", crypto.randomUUID());
  for (const at of ["2024-02-28T20:59:00Z", "2024-02-28T21:01:00Z", "2024-02-29T20:59:00Z", "2024-02-29T21:01:00Z"]) {
    context.mock.timers.setTime(new Date(at).getTime());
    const key = crypto.randomUUID();
    assert.equal(store.createDevCheckIn(owner.token, key).kind, "accepted");
    assert.equal(store.createDevCheckIn(owner.token, key).value.replayed, true);
  }
  store.createDevCheckIn(other.token, crypto.randomUUID());
  assert.deepEqual(store.getDevCheckInCalendar(owner.token, "2024-02").days,
    [{ date: "2024-02-28", count: 1 }, { date: "2024-02-29", count: 2 }]);
  assert.deepEqual(store.getDevCheckInCalendar(owner.token, "2024-03").days,
    [{ date: "2024-03-01", count: 1 }]);
  const empty = store.getDevCheckInCalendar(owner.token, "2024-01");
  assert.deepEqual(empty.days, []);
  assert.equal(empty.firstMonth, "2024-02");
});
