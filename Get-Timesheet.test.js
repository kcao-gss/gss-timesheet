'use strict';
// One-off test for the timesheet summary math. Run: node Get-Timesheet.test.js
const assert = require('assert');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { rowMins, isLivePunch, rowsInCurrentWeek, lastGoodTimesheet, computeWeekModel, computeTodayModel, computeClaudeUsage } = require('./Get-Timesheet.js');

let pass = 0, fail = 0;
function test(name, fn) {
    try { fn(); console.log('  ok   -', name); pass++; }
    catch (e) { console.log('  FAIL -', name, '\n        ' + e.message); fail++; }
}

const dstr = d => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} 12:00:00 AM`;
const now  = new Date('2026-06-15T11:00:00');                 // fixed reference: Mon Jun 15, 11:00
const day  = n => { const d = new Date(now); d.setDate(d.getDate() + n); return d; };

// An open punch (1900 end-date) left over from a previous day — the real-world bug.
const staleOpen = { 'Start Date': dstr(day(-3)), 'Time In ': '01:05 PM',
                    'End Date': '1/1/1900 12:00:00 AM', 'Time Out ': '12:00 AM', 'Hours': '79' };
// An open punch clocked in today — a genuinely active session.
const liveToday = { 'Start Date': dstr(now), 'Time In ': '09:00 AM',
                    'End Date': '1/1/1900 12:00:00 AM', 'Time Out ': '12:00 AM', 'Hours': '5' };
const lastWeek  = { 'Start Date': dstr(day(-8)), 'Time In ': '08:00 AM',
                    'End Date': dstr(day(-8)), 'Time Out ': '04:00 PM', 'Hours': '480' };
const thisWeek  = { 'Start Date': dstr(now), 'Time In ': '08:00 AM',
                    'End Date': dstr(now), 'Time Out ': '04:00 PM', 'Hours': '480' };

test('stale open punch from a previous day uses snapshot, not phantom days', () => {
    assert.strictEqual(rowMins(staleOpen, now), 79);
});
test('open punch clocked in today counts live minutes from clock-in', () => {
    assert.strictEqual(rowMins(liveToday, now), 120); // 09:00 -> 11:00 = 120 min
});
test('isLivePunch is true only for today\'s open punch', () => {
    assert.strictEqual(isLivePunch(liveToday, now), true);
    assert.strictEqual(isLivePunch(staleOpen, now), false);
});
test('rowsInCurrentWeek excludes prior-week rows', () => {
    const kept = rowsInCurrentWeek([lastWeek, thisWeek], now);
    assert.strictEqual(kept.length, 1);
    assert.strictEqual(kept[0], thisWeek);
});

const HEADER = 'Start Date,Time In ,End Date,Time Out ,Hours,Reason';
function withTempDir(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gss-'));
    try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('lastGoodTimesheet rejects a file whose only rows are from a prior week', () => {
    withTempDir(dir => {
        // Last week's file (rows dated 3 days before `now`, i.e. prior Mon–Sun week).
        const w24 = path.join(dir, 'timesheet-2026-W24.csv');
        fs.writeFileSync(w24, `${HEADER}\n${dstr(day(-3))},08:00 AM,${dstr(day(-3))},04:00 PM,480,Time and Attendance\n`);
        // This week's file doesn't exist yet — exactly the boundary case.
        const w25 = path.join(dir, 'timesheet-2026-W25.csv');
        assert.strictEqual(lastGoodTimesheet(w25, now), null);
    });
});

test('lastGoodTimesheet returns a file that has current-week rows', () => {
    withTempDir(dir => {
        const w25 = path.join(dir, 'timesheet-2026-W25.csv');
        fs.writeFileSync(w25, `${HEADER}\n${dstr(now)},08:00 AM,${dstr(now)},04:00 PM,480,Time and Attendance\n`);
        assert.strictEqual(lastGoodTimesheet(w25, now), w25);
    });
});

test('computeWeekModel: completed Monday rolls into day 0 and totals', () => {
    const m = computeWeekModel([thisWeek], now);
    assert.strictEqual(m.hasData, true);
    assert.strictEqual(m.totalMins, 480);
    assert.strictEqual(m.remaining, 1920);
    assert.strictEqual(m.daysWorked, 1);
    assert.strictEqual(m.days[0].name, 'Mon');
    assert.strictEqual(m.days[0].mins, 480);
    assert.strictEqual(m.days[0].pct, 100);
    assert.strictEqual(m.days[0].full, true);
    assert.strictEqual(m.days[5].show, false); // Sat hidden when not worked
});

test('computeWeekModel: live punch today is active and counts to now', () => {
    const m = computeWeekModel([liveToday], now);
    assert.strictEqual(m.isActive, true);
    assert.strictEqual(m.days[0].mins, 120); // 09:00 -> 11:00
    assert.strictEqual(m.days[0].active, true);
});

test('computeWeekModel: Monday projects a Friday need', () => {
    const m = computeWeekModel([thisWeek], now);
    assert.strictEqual(m.friday.applicable, true);
    assert.strictEqual(m.friday.kind, 'need');
    assert.strictEqual(m.friday.needMins, 480);
    assert.ok(m.friday.fridayDateStr.includes('Fri'));
});

test('computeWeekModel: no current-week rows -> hasData false', () => {
    const m = computeWeekModel([lastWeek], now);
    assert.strictEqual(m.hasData, false);
});

test('computeTodayModel: single live punch yields clock-out-by and no break yet', () => {
    const m = computeTodayModel([liveToday], now);
    assert.strictEqual(m.hasData, true);
    assert.strictEqual(m.clockedIn, '9:00 AM');
    assert.strictEqual(m.breaks.length, 0);
    assert.strictEqual(m.status, 'clockout');
    assert.strictEqual(m.clockOutBy, '5:00 PM'); // 9:00 + 8h worked
});

test('computeTodayModel: break is detected from the gap between punches', () => {
    const am = { 'Start Date': dstr(now), 'Time In ': '07:55 AM', 'End Date': dstr(now), 'Time Out ': '12:02 PM', 'Hours': '247' };
    const pm = { 'Start Date': dstr(now), 'Time In ': '12:31 PM', 'End Date': '1/1/1900 12:00:00 AM', 'Time Out ': '12:00 AM', 'Hours': '77' };
    const m = computeTodayModel([pm, am], now); // unsorted on purpose
    assert.strictEqual(m.breaks.length, 1);
    assert.strictEqual(m.breaks[0].mins, 29); // 12:02 -> 12:31
    assert.strictEqual(m.breaks[0].from, '12:02 PM');
    assert.strictEqual(m.breaks[0].to, '12:31 PM');
});

test('computeTodayModel: no punches today -> hasData false', () => {
    assert.strictEqual(computeTodayModel([lastWeek], now).hasData, false);
});

test('computeClaudeUsage: returns an availability flag without throwing', () => {
    assert.strictEqual(typeof computeClaudeUsage(now).available, 'boolean');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
