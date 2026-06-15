// Get-Timesheet.js — GSS Time & Attendance
// Usage: node Get-Timesheet.js [-SaveCredential] [-StartDate MM/DD/YYYY] [-EndDate MM/DD/YYYY] [-OutputPath path]

'use strict';

const path         = require('path');
const fs           = require('fs');
const readline     = require('readline');
const { execSync } = require('child_process');

// ── Bootstrap ─────────────────────────────────────────────────────────────────

function tryRequire(name) {
    try { return require(name); }
    catch (e) {
        if (e.code !== 'MODULE_NOT_FOUND') throw e;
        console.log(`Installing ${name}...`);
        execSync(`npm install ${name}`, { cwd: __dirname, stdio: 'inherit' });
        return require(name);
    }
}

const { chromium } = tryRequire('playwright');
const keytar       = tryRequire('keytar');

// ── Helpers ───────────────────────────────────────────────────────────────────

const col = {
    cyan:      s => `\x1b[36m${s}\x1b[0m`,
    green:     s => `\x1b[32m${s}\x1b[0m`,
    yellow:    s => `\x1b[93m${s}\x1b[0m`,
    darkYellow:s => `\x1b[33m${s}\x1b[0m`,
    gray:      s => `\x1b[90m${s}\x1b[0m`,
    red:       s => `\x1b[31m${s}\x1b[0m`,
};

function formatHM(mins) {
    const abs = Math.abs(mins);
    return `${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, '0')}`;
}

function isoWeek(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return String(Math.ceil(((d - yearStart) / 86400000 + 1) / 7)).padStart(2, '0');
}

// Parse a single CSV line, respecting quoted fields.
// Header names are returned verbatim — trailing spaces in names like 'Time In ' are load-bearing.
function parseLine(line) {
    const vals = [];
    let cur = '', inQ = false;
    for (const ch of line) {
        if      (ch === '"')           inQ = !inQ;
        else if (ch === ',' && !inQ) { vals.push(cur); cur = ''; }
        else                           cur += ch;
    }
    vals.push(cur);
    return vals;
}

// Combine a date-only value ("6/9/2026 12:00:00 AM") with a time-only value ("07:57 AM")
function combineDateTime(dateVal, timeVal) {
    const d = new Date(dateVal.trim());
    return new Date(`${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} ${timeVal.trim()}`);
}

function parseCSV(filePath) {
    if (!fs.existsSync(filePath)) return [];
    const lines   = fs.readFileSync(filePath, 'utf8').replace(/\r/g, '').split('\n');
    const headers = parseLine(lines[0]);
    return lines.slice(1)
        .filter(l => l.trim())
        .map(l => Object.fromEntries(headers.map((h, i) => [h, parseLine(l)[i] ?? ''])))
        .filter(r => r['Start Date'] && r['Start Date'].trim());
}

function ask(question) {
    const iface = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(res => iface.question(question, a => { iface.close(); res(a.trim()); }));
}

function askPassword(question) {
    return new Promise(resolve => {
        const iface = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        // Use setPrompt so readline redraws the label itself on backspace/refresh,
        // rather than us writing it manually (which readline's clearLine erases).
        iface.setPrompt(question);
        iface._writeToOutput = s => {
            if (s.startsWith(question)) {
                // Line refresh path (e.g. after backspace): prompt + current input.
                // Write label as-is, then show one * per input character.
                process.stdout.write(question);
                const inputPart = s.slice(question.length);
                const n = inputPart.split('').filter(c => c.charCodeAt(0) >= 32).length;
                if (n > 0) process.stdout.write('*'.repeat(n));
            } else {
                // Single-character echo path: mask printable characters.
                const n = (s || '').split('').filter(c => c.charCodeAt(0) >= 32).length;
                if (n > 0) process.stdout.write('*'.repeat(n));
            }
        };
        iface.prompt();
        iface.once('line', a => { process.stdout.write('\n'); iface.close(); resolve(a.trim()); });
    });
}

// A punch is "live" (an ongoing session) only when it's open AND was clocked in
// today. An open punch (1900 end-date) left over from a previous day is a
// forgotten clock-out / stale export — treating it as live makes `now - clock-in`
// accrue days of phantom hours.
function isLivePunch(row, now = new Date()) {
    if (!row['End Date'].includes('1900')) return false;
    const timeIn = combineDateTime(row['Start Date'], row['Time In ']);
    return timeIn.toDateString() === now.toDateString();
}

// Minutes for a punch row. For a genuinely live punch compute from clock-in to
// now; otherwise use the portal's recorded 'Hours' snapshot.
function rowMins(row, now = new Date()) {
    if (isLivePunch(row, now)) {
        const timeIn = combineDateTime(row['Start Date'], row['Time In ']);
        return Math.max(0, Math.round((now.getTime() - timeIn) / 60000));
    }
    return parseInt(row['Hours'].trim(), 10) || 0;
}

// Keep only punch rows whose Start Date falls in the current Mon–Sun week, so the
// summary always reflects this week regardless of how wide an export (or fallback
// file) the portal handed back.
function rowsInCurrentWeek(rows, now = new Date()) {
    const start = new Date(now);
    start.setDate(start.getDate() + (start.getDay() === 0 ? -6 : 1 - start.getDay()));
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(start.getDate() + 7);
    return rows.filter(r => {
        const d = new Date(r['Start Date'].trim());
        return d >= start && d < end;
    });
}

// Count punch rows in a CSV, treating any read/parse failure as 0.
function punchRowCount(p) {
    try { return fs.existsSync(p) ? parseCSV(p).length : 0; }
    catch { return 0; }
}

// Count punch rows that fall in the current Mon–Sun week — the same definition
// showWeekStats uses to render. A file can hold rows yet zero current-week rows
// (e.g. last week's file), in which case it would render "No punch data found",
// so it must NOT qualify as a fallback.
function currentWeekRowCount(p, now = new Date()) {
    try { return fs.existsSync(p) ? rowsInCurrentWeek(parseCSV(p), now).length : 0; }
    catch { return 0; }
}

// Pick the last good timesheet to fall back on when a fresh export is empty:
// prefer the current week's existing file, else the most-recently-modified
// timesheets/*.csv that actually contains current-week punch data. Returns null
// if nothing usable exists.
function lastGoodTimesheet(outputPath, now = new Date()) {
    if (currentWeekRowCount(outputPath, now) > 0) return outputPath;
    const dir = path.dirname(outputPath);
    let candidates = [];
    try {
        candidates = fs.readdirSync(dir)
            .filter(f => f.endsWith('.csv'))
            .map(f => path.join(dir, f))
            .filter(p => p !== outputPath && currentWeekRowCount(p, now) > 0)
            .map(p => ({ p, mtime: fs.statSync(p).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime);
    } catch { /* timesheets dir missing — no candidates */ }
    return candidates.length ? candidates[0].p : null;
}

// ── CLI args ──────────────────────────────────────────────────────────────────

function parseArgs() {
    const argv = process.argv.slice(2);
    const args = { saveCredential: false, startDate: '', endDate: '', outputPath: '', cli: false };
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i].replace(/^-+/, '').toLowerCase();
        if (key === 'savecredential') { args.saveCredential = true; continue; }
        if (key === 'cli')            { args.cli = true; continue; }
        const val = (i + 1 < argv.length && !argv[i + 1].startsWith('-')) ? argv[++i] : '';
        if      (key === 'startdate'  || key === 'start-date')  args.startDate  = val;
        else if (key === 'enddate'    || key === 'end-date')    args.endDate    = val;
        else if (key === 'outputpath' || key === 'output-path') args.outputPath = val;
    }
    return args;
}

// ── Stats display ─────────────────────────────────────────────────────────────

function showTodayStats(rows) {
    const today    = new Date();
    const todayKey = today.toISOString().slice(0, 10);

    const todayRows = rows
        .filter(r => {
            const s = r['Start Date'].trim();
            return s && new Date(s).toISOString().slice(0, 10) === todayKey;
        });

    if (!todayRows.length) return;

    // Sort by real Date objects — sorting on the bare 'Time In ' string (e.g. "07:57 AM")
    // gives Invalid Date and leaves rows in the portal's newest-first export order,
    // which breaks break detection and the "Clocked in" time.
    const punches = todayRows
        .map(r => ({
            timeIn:  combineDateTime(r['Start Date'], r['Time In ']),
            active:  r['End Date'].includes('1900'),
            timeOut: r['End Date'].includes('1900') ? null : combineDateTime(r['End Date'], r['Time Out ']),
            mins:    rowMins(r),
        }))
        .sort((a, b) => a.timeIn - b.timeIn);

    const isActive       = punches.some(p => p.active);
    const totalTodayMins = punches.reduce((s, p) => s + p.mins, 0);
    const completedMins  = punches.filter(p => !p.active).reduce((s, p) => s + p.mins, 0);
    const deficit        = 480 - totalTodayMins;
    const fmt            = d => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

    console.log(col.gray('  ' + '-'.repeat(50)));
    console.log(col.cyan(`  Today -- ${today.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`));
    console.log('');
    console.log(`  ${'Clocked in'.padEnd(18)}  ${fmt(punches[0].timeIn)}`);

    let anyBreak = false;
    for (let i = 0; i < punches.length - 1; i++) {
        if (punches[i].timeOut) {
            const brkMins = Math.round((punches[i + 1].timeIn - punches[i].timeOut) / 60000);
            if (brkMins > 0) {
                console.log(`  ${'Break'.padEnd(18)}  ${fmt(punches[i].timeOut)} - ${fmt(punches[i + 1].timeIn)}  (${brkMins} min)`);
                anyBreak = true;
            }
        }
    }
    if (!anyBreak) console.log(`  ${'Break'.padEnd(18)}  none so far`);
    console.log(`  ${'Total today'.padEnd(18)}  ${formatHM(totalTodayMins)}`);

    if (deficit <= 0) {
        console.log(col.green(`  ${'8-hr target'.padEnd(18)}  done!  (+${formatHM(-deficit)} over)`));
    } else if (isActive) {
        const active   = [...punches].filter(p => p.active).pop();
        const clockOut = new Date(active.timeIn.getTime() + (480 - completedMins) * 60000);
        console.log(col.yellow(`  ${'Clock out by'.padEnd(18)}  ${fmt(clockOut)}  (${formatHM(deficit)} remaining)`));
    } else {
        console.log(col.yellow(`  ${'8-hr target'.padEnd(18)}  need ${formatHM(deficit)} more today`));
    }
    console.log('');
}

function formatTokens(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return Math.round(n / 1e3) + 'K';
    return String(n);
}

// ── Claude usage bars ───────────────────────────────────────────────────────
// Claude does NOT expose your real plan limits to any script (those live only in
// the in-app /usage view). So these bars track your real local token usage against
// SELF-SET budgets. Tune the two budgets to match what /usage shows you, and set
// WEEKLY_RESET to your real weekly reset (read it from /usage once).
// Calibrated 2026-06-11 against /usage (both bars read ~3%) on the $100 Max 5x plan.
// Re-calibrate when usage is higher for more precision: budget = my_tokens / (usage% / 100).
const SESSION_BUDGET = 13_000_000;           // ~5-hour window budget (calibrated)
const WEEKLY_BUDGET  = 800_000_000;          // weekly budget (calibrated)
const WEEKLY_RESET   = { day: 6, hour: 18 }; // Sat 6pm Central (from /usage); 0=Sun..6=Sat

function bar20(pct) {
    const filled = Math.max(0, Math.min(20, Math.round(20 * pct / 100)));
    return '█'.repeat(filled) + '░'.repeat(20 - filled);
}

// First message of the current 5-hour session block: walk timestamps ascending and
// open a new window whenever a message lands at/after the previous window's end.
function sessionWindowStart(timesMs, windowMs = 5 * 3600 * 1000) {
    let start = null;
    for (const t of [...timesMs].sort((a, b) => a - b)) {
        if (start === null || t >= start + windowMs) start = t;
    }
    return start;
}

// Scan ~/.claude logs and return token usage vs. the self-set budgets — pure data,
// so both the CLI bars and the desktop card render from it. Returns { available:false }
// when there are no Claude logs on this machine.
function computeClaudeUsage(now = new Date()) {
    const root = path.join(require('os').homedir(), '.claude', 'projects');
    if (!fs.existsSync(root)) return { available: false };

    // Weekly window: most recent WEEKLY_RESET day/hour at or before now.
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - ((now.getDay() - WEEKLY_RESET.day + 7) % 7));
    weekStart.setHours(WEEKLY_RESET.hour, 0, 0, 0);
    if (weekStart > now) weekStart.setDate(weekStart.getDate() - 7);

    const WIN = 5 * 3600 * 1000; // Claude's 5-hour session window

    let weekTok = 0;
    const entries = []; // {ms, tok} inside the weekly window — also used for session tiling

    const files = [];
    for (const dir of fs.readdirSync(root)) {
        const d = path.join(root, dir);
        if (!fs.statSync(d).isDirectory()) continue;
        for (const f of fs.readdirSync(d)) if (f.endsWith('.jsonl')) files.push(path.join(d, f));
    }
    for (const file of files) {
        let lines;
        try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch { continue; }
        for (const line of lines) {
            if (!line.includes('"usage"')) continue;
            let o; try { o = JSON.parse(line); } catch { continue; }
            const u = o.message && o.message.usage;
            if (!u || !o.timestamp) continue;
            const t = new Date(o.timestamp);
            if (t < weekStart) continue;
            const tok = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0);
            weekTok += tok;
            entries.push({ ms: t.getTime(), tok });
        }
    }

    // Session = the current 5-hour block, anchored at the first message after the last
    // >5h gap. (Using the trailing-window edge made "resets in" stick at 0h 0m during
    // continuous use.) Once the block has fully elapsed with no new activity, it's idle.
    const winStart   = sessionWindowStart(entries.map(e => e.ms), WIN);
    const sessActive = winStart != null && winStart + WIN > now.getTime();
    const sessTok    = sessActive ? entries.reduce((s, e) => (e.ms >= winStart ? s + e.tok : s), 0) : 0;

    const until = d => {
        const ms = Math.max(0, d - now), h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000);
        return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${m}m`;
    };
    const fmtReset = d => d.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true });

    const sessPct   = Math.floor(100 * sessTok / SESSION_BUDGET);
    const weekPct    = Math.floor(100 * weekTok / WEEKLY_BUDGET);
    const sessReset  = sessActive ? new Date(winStart + WIN) : null;
    const weekReset  = new Date(weekStart.getTime() + 7 * 24 * 3600 * 1000);

    return {
        available: true,
        session: { pct: sessPct, used: formatTokens(sessTok), budget: formatTokens(SESSION_BUDGET),
                   reset: sessReset ? 'resets in ' + until(sessReset) : 'idle' },
        weekly:  { pct: weekPct, used: formatTokens(weekTok), budget: formatTokens(WEEKLY_BUDGET),
                   reset: `resets ${fmtReset(weekReset)}  (${until(weekReset)})` },
    };
}

function showClaudeUsage() {
    const u = computeClaudeUsage();
    if (!u.available) return;
    const colFor = p => p >= 90 ? col.red : p >= 70 ? col.yellow : s => s;

    console.log(col.gray('  ' + '-'.repeat(50)));
    console.log(col.cyan('  Claude Code  --  Usage'));
    console.log('');
    console.log(colFor(u.session.pct)(`  ${'Session'.padEnd(8)} [${bar20(u.session.pct)}] ${String(u.session.pct).padStart(3)}%  ${u.session.used}/${u.session.budget}`));
    console.log(col.gray(`  ${''.padEnd(8)} ${u.session.reset}`));
    console.log(colFor(u.weekly.pct)(`  ${'Weekly'.padEnd(8)} [${bar20(u.weekly.pct)}] ${String(u.weekly.pct).padStart(3)}%  ${u.weekly.used}/${u.weekly.budget}`));
    console.log(col.gray(`  ${''.padEnd(8)} ${u.weekly.reset}`));
    console.log('');
}

// Build a plain data model for the current week — pure (no console I/O), so the
// desktop UI and the CLI can both render from it and it can be unit-tested.
// NOTE: the legacy console renderer (showWeekStats, behind --cli) keeps its own
// copy of the Friday-estimate math; keep the two in sync if the algorithm changes.
function computeWeekModel(allRows, now = new Date()) {
    const TARGET = 2400, DAY_TARGET = 480;
    const rows = rowsInCurrentWeek(allRows, now);

    const moOff   = now.getDay() === 0 ? -6 : 1 - now.getDay();
    const weekMon = new Date(now);
    weekMon.setDate(now.getDate() + moOff);
    weekMon.setHours(0, 0, 0, 0);
    const weekOf = weekMon.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    if (!rows.length) return { hasData: false, weekOf };

    const dayKey = d => d.toISOString().slice(0, 10);
    const workDays = {};
    let totalMins = 0, isActive = false;
    for (const row of rows) {
        const mins   = rowMins(row, now);
        totalMins   += mins;
        const key    = new Date(row['Start Date'].trim()).toISOString().slice(0, 10);
        const timeIn = combineDateTime(row['Start Date'], row['Time In ']);
        const active = isLivePunch(row, now);
        if (active) isActive = true;
        (workDays[key] = workDays[key] || []).push({ timeIn, active, mins });
    }

    const daysWorked    = Object.keys(workDays).length;
    const todayKey      = now.toISOString().slice(0, 10);
    const completedKeys = Object.keys(workDays).filter(k => k !== todayKey);
    const completedMins = completedKeys.reduce(
        (s, k) => s + workDays[k].reduce((a, p) => a + p.mins, 0), 0);
    const avgMinsPerDay = completedKeys.length
        ? Math.floor(completedMins / completedKeys.length)
        : DAY_TARGET; // 8 h fallback when no completed days exist yet (e.g. Mon AM)
    const remaining     = Math.max(0, TARGET - totalMins);
    const overtime      = Math.max(0, totalMins - TARGET);

    const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const days = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(weekMon);
        d.setDate(weekMon.getDate() + i);
        d.setHours(0, 0, 0, 0);
        const punches = workDays[dayKey(d)] || [];
        const mins    = punches.reduce((s, p) => s + p.mins, 0);
        const weekend = i >= 5;
        days.push({
            name:    dayNames[i],
            date:    d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' }),
            mins,
            hm:      mins ? formatHM(mins) : '--',
            pct:     Math.min(100, Math.round(100 * mins / DAY_TARGET)),
            active:  punches.some(p => p.active),
            worked:  mins > 0,
            full:    mins >= DAY_TARGET,
            weekend,
            show:    !weekend || mins > 0,
        });
    }

    // ── Friday estimate ──────────────────────────────────────────────────────
    const fmt          = d => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    const dayIndexMap  = [null, 0, 1, 2, 3, 4, null]; // Sun=null, Mon=0..Fri=4, Sat=null
    const dayIndex     = dayIndexMap[now.getDay()];
    const friday       = { applicable: dayIndex !== null };

    if (dayIndex !== null) {
        const avgStartMins = Math.floor(
            Object.values(workDays).reduce((sum, punches) => {
                const first = [...punches].sort((a, b) => a.timeIn - b.timeIn)[0];
                return sum + first.timeIn.getHours() * 60 + first.timeIn.getMinutes();
            }, 0) / daysWorked);
        const avgStartRef = new Date(now); avgStartRef.setHours(0, avgStartMins, 0, 0);
        const todayWorked = (workDays[todayKey] || []).reduce((s, p) => s + p.mins, 0);

        if (remaining === 0) {
            friday.kind = 'done';
        } else if (dayIndex === 4 && isActive) {
            friday.kind     = 'friday-active';
            friday.clockOut = fmt(new Date(now.getTime() + remaining * 60000));
            friday.needHM   = formatHM(remaining);
        } else if (dayIndex === 4) {
            const clockOut = new Date(now); clockOut.setHours(0, avgStartMins + todayWorked + remaining, 0, 0);
            friday.kind     = 'friday-inactive';
            friday.clockOut = fmt(clockOut);
            friday.needHM   = formatHM(remaining);
        } else {
            const todayProjected = Math.max(todayWorked, avgMinsPerDay);
            const daysAfterToday = 3 - dayIndex;
            const projThruThu    = completedMins + todayProjected + avgMinsPerDay * daysAfterToday;
            const fridayNeed     = Math.max(0, TARGET - projThruThu);
            if (fridayNeed === 0) {
                friday.kind = 'ahead';
            } else {
                const daysToFri   = 4 - dayIndex;
                const fridayStart = new Date(now);
                fridayStart.setDate(now.getDate() + daysToFri);
                fridayStart.setHours(0, avgStartMins, 0, 0);
                friday.kind          = 'need';
                friday.needMins      = fridayNeed;
                friday.needHM        = formatHM(fridayNeed);
                friday.fridayDateStr = fridayStart.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
                friday.avgStart      = fmt(avgStartRef);
                friday.fridayClockOut = fmt(new Date(fridayStart.getTime() + fridayNeed * 60000));
                friday.avgPerDayHM   = formatHM(avgMinsPerDay);
            }
        }
    }

    return {
        hasData: true, weekOf,
        totalMins, totalHM: formatHM(totalMins),
        remaining, remainingHM: formatHM(remaining),
        overtime, overtimeHM: formatHM(overtime),
        targetMins: TARGET, targetReached: remaining === 0,
        daysWorked, avgMinsPerDay, avgPerDayHM: formatHM(avgMinsPerDay),
        isActive, days, friday,
    };
}

// Today's-card model — pure. Per the desktop design the break is a fixed default
// lunch (informational); clock-out-by uses the existing worked-hours math.
function computeTodayModel(allRows, now = new Date()) {
    const todayKey  = now.toISOString().slice(0, 10);
    const todayRows = allRows.filter(r => {
        const s = r['Start Date'].trim();
        return s && new Date(s).toISOString().slice(0, 10) === todayKey;
    });
    if (!todayRows.length) return { hasData: false };

    const fmt = d => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    const punches = todayRows.map(r => ({
        timeIn:  combineDateTime(r['Start Date'], r['Time In ']),
        active:  r['End Date'].includes('1900'),
        timeOut: r['End Date'].includes('1900') ? null : combineDateTime(r['End Date'], r['Time Out ']),
        mins:    rowMins(r, now),
    })).sort((a, b) => a.timeIn - b.timeIn);

    // Real breaks: the gap between one punch clocking out and the next clocking in.
    const breaks = [];
    for (let i = 0; i < punches.length - 1; i++) {
        if (!punches[i].timeOut) continue;
        const mins = Math.round((punches[i + 1].timeIn - punches[i].timeOut) / 60000);
        if (mins > 0) breaks.push({ from: fmt(punches[i].timeOut), to: fmt(punches[i + 1].timeIn), mins });
    }

    const isActive       = punches.some(p => p.active);
    const totalTodayMins = punches.reduce((s, p) => s + p.mins, 0);
    const completedMins  = punches.filter(p => !p.active).reduce((s, p) => s + p.mins, 0);
    const deficit        = 480 - totalTodayMins;

    const model = {
        hasData:   true,
        clockedIn: fmt(punches[0].timeIn),
        breaks,
        totalHM:   formatHM(totalTodayMins),
        isActive,
    };
    if (deficit <= 0) {
        model.status = 'done';
        model.overHM = formatHM(-deficit);
    } else if (isActive) {
        const active   = [...punches].filter(p => p.active).pop();
        const clockOut = new Date(active.timeIn.getTime() + (480 - completedMins) * 60000);
        model.status      = 'clockout';
        model.clockOutBy  = fmt(clockOut);
        model.remainingHM = formatHM(deficit);
    } else {
        model.status      = 'need';
        model.remainingHM = formatHM(deficit);
    }
    return model;
}

function showWeekStats(csvPath) {
    const rows = rowsInCurrentWeek(parseCSV(csvPath));
    if (!rows.length) { console.log(col.yellow('  No punch data found.')); return; }

    let totalMins = 0;
    const workDays = {};
    let isActive = false;

    for (const row of rows) {
        const mins   = rowMins(row);
        totalMins   += mins;
        const dayKey = new Date(row['Start Date'].trim()).toISOString().slice(0, 10);
        const timeIn = combineDateTime(row['Start Date'], row['Time In ']);
        const active = isLivePunch(row);
        if (active) isActive = true;
        if (!workDays[dayKey]) workDays[dayKey] = [];
        workDays[dayKey].push({ timeIn, active, mins });
    }

    const daysWorked    = Object.keys(workDays).length;

    // Exclude today (in-progress) from the hours average so a short morning
    // session doesn't deflate the per-day figure and skew the Friday estimate.
    const todayKey      = new Date().toISOString().slice(0, 10);
    const completedKeys = Object.keys(workDays).filter(k => k !== todayKey);
    const completedMins = completedKeys.reduce(
        (s, k) => s + workDays[k].reduce((a, p) => a + p.mins, 0), 0);
    const DEFAULT_DAY   = 480; // 8 h fallback when no completed days exist yet (e.g. Mon AM)
    const avgMinsPerDay = completedKeys.length
        ? Math.floor(completedMins / completedKeys.length)
        : DEFAULT_DAY;
    const targetMins    = 2400;
    const remaining     = Math.max(0, targetMins - totalMins);
    const overtime      = Math.max(0, totalMins - targetMins);

    const today   = new Date();
    const dow     = today.getDay();
    const moOff   = dow === 0 ? -6 : 1 - dow;
    const weekMon = new Date(today);
    weekMon.setDate(today.getDate() + moOff);

    console.log('');
    console.log(col.cyan(`  Time & Attendance  --  Week of ${weekMon.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`));
    console.log(col.gray('  ' + '-'.repeat(50)));

    // ── Daily breakdown ─────────────────────────────────────────────────────
    // One bar per day, scaled to the 8-hr day target. Weekdays always show (so a
    // skipped day is visible); weekends only show when something was worked.
    const DAY_TARGET = 480;
    const dayNames   = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    console.log(col.cyan('  Daily Hours'));
    console.log('');
    for (let i = 0; i < 7; i++) {
        const d = new Date(weekMon);
        d.setDate(weekMon.getDate() + i);
        d.setHours(0, 0, 0, 0);
        const key     = d.toISOString().slice(0, 10);
        const punches = workDays[key] || [];
        const mins    = punches.reduce((s, p) => s + p.mins, 0);
        if (i >= 5 && mins === 0) continue; // hide empty weekends
        const pct    = Math.min(100, Math.round(100 * mins / DAY_TARGET));
        const label  = `${dayNames[i]} ${d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })}`;
        const active = punches.some(p => p.active);
        const hrs    = mins ? formatHM(mins) : '--';
        const tint   = mins >= DAY_TARGET ? col.green : mins > 0 ? col.yellow : col.gray;
        console.log(tint(`  ${label.padEnd(10)} [${bar20(pct)}] ${hrs.padStart(5)}${active ? ' *' : ''}`));
    }
    console.log('');
    if (remaining > 0) {
        console.log(col.yellow(`  ${'Hours Remaining'.padEnd(18)}  ${formatHM(remaining).padStart(7)}`));
    } else {
        console.log(col.green(`  ${'40-hr Target'.padEnd(18)}  ${'DONE'.padStart(7)}   (+ ${formatHM(overtime)} overtime)`));
    }
    console.log('');

    showClaudeUsage();

    showTodayStats(rows);

    // ── Friday estimate ───────────────────────────────────────────────────────
    const dayIndexMap = [null, 0, 1, 2, 3, 4, null]; // Sun=null, Mon=0..Fri=4, Sat=null
    const dayIndex    = dayIndexMap[today.getDay()];
    if (dayIndex === null) return;

    const avgStartMins = Math.floor(
        Object.values(workDays).reduce((sum, punches) => {
            const first = [...punches].sort((a, b) => a.timeIn - b.timeIn)[0];
            return sum + first.timeIn.getHours() * 60 + first.timeIn.getMinutes();
        }, 0) / daysWorked
    );
    const avgStartRef = new Date(); avgStartRef.setHours(0, avgStartMins, 0, 0);
    const fmt = d => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

    console.log(col.gray('  ' + '-'.repeat(50)));
    console.log(col.cyan('  Friday Estimate'));
    console.log('');

    if (remaining === 0) {
        console.log(col.green("  You've already hit 40 hours -- no more required!"));
    } else if (dayIndex === 4) {
        if (isActive) {
            const clockOut = new Date(Date.now() + remaining * 60000);
            console.log(col.yellow(`  Stay clocked in until  ${fmt(clockOut)}  (need ${formatHM(remaining)} more)`));
            console.log(col.gray(`  (this is the 40-hr week target; "Clock out by" above is the 8-hr day target --`));
            console.log(col.gray(`   if it's earlier, you banked extra time Mon-Thu)`));
        } else {
            const todayKey    = today.toISOString().slice(0, 10);
            const todayWorked = (workDays[todayKey] || []).reduce((s, p) => s + p.mins, 0);
            const clockOut    = new Date(); clockOut.setHours(0, avgStartMins + todayWorked + remaining, 0, 0);
            console.log(col.yellow(`  Need ${formatHM(remaining)} more today  ->  clock out ~${fmt(clockOut)}`));
        }
    } else {
        // Project today to a full average day (so a partial morning doesn't under-count it),
        // then add avg for each remaining day between today and Thursday.
        const todayWorked    = (workDays[todayKey] || []).reduce((s, p) => s + p.mins, 0);
        const todayProjected = Math.max(todayWorked, avgMinsPerDay);
        const daysAfterToday = 3 - dayIndex; // days strictly after today up to Thu
        const projThruThu    = completedMins + todayProjected + avgMinsPerDay * daysAfterToday;
        const fridayNeed     = Math.max(0, targetMins - projThruThu);

        if (fridayNeed === 0) {
            console.log(col.green("  At this pace you'll hit 40 hours before Friday!"));
        } else {
            const daysToFri      = 4 - dayIndex;
            const fridayStart    = new Date(today);
            fridayStart.setDate(today.getDate() + daysToFri);
            fridayStart.setHours(0, avgStartMins, 0, 0);
            const fridayClockOut = new Date(fridayStart.getTime() + fridayNeed * 60000);
            const fridayDateStr  = fridayStart.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
            console.log(col.yellow(`  Need ${formatHM(fridayNeed)} hrs on Friday  (${fridayDateStr})`));
            console.log(`  Avg start ~${fmt(avgStartRef)}  ->  clock out ~${fmt(fridayClockOut)}`);
            console.log(col.gray(`  (assumes avg ${formatHM(avgMinsPerDay)}/day for today + remaining Mon-Thu days)`));
        }
    }
    console.log('');
}

// ── Scraper ───────────────────────────────────────────────────────────────────

const jsClick = (page, id) => page.evaluate(id => document.getElementById(id).click(), id);

async function scrape(username, password, startDate, endDate, outputPath, log = console.log) {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ acceptDownloads: true });
    const page    = await context.newPage();

    try {
        // ── Login ──────────────────────────────────────────────────────────
        log('Logging in...');
        // 'domcontentloaded' instead of default 'load' — a hanging third-party
        // resource can stall the load event past 30s even though the form is
        // ready; the waitForSelector below is the real readiness check.
        await page.goto('https://www.gss-service.com/Logon', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('#TxtUsername_I');
        await page.fill('#TxtUsername_I', username);
        await page.fill('#passPassword_I', password);

        await jsClick(page, 'btnSaveLogon_I');
        try {
            await page.waitForURL(url => !url.href.includes('/Logon'), { timeout: 20000 });
        } catch {
            await page.press('#passPassword_I', 'Enter');
            await page.waitForURL(url => !url.href.includes('/Logon'), { timeout: 10000 });
        }

        if (page.url().includes('/Logon')) {
            const loginErr = new Error('Login failed — still on login page. Check credentials.');
            loginErr.code = 'LOGIN_FAILED';
            throw loginErr;
        }
        log('Logged in.');

        // ── Time & Attendance ──────────────────────────────────────────────
        log('Loading Time and Attendance...');
        await page.goto('https://www.gss-service.com/TimeAttendance/Index', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('[name="StartDateSearch2"]');

        if (startDate) {
            await page.fill('[name="StartDateSearch2"]', startDate);
            await page.dispatchEvent('[name="StartDateSearch2"]', 'change');
        }
        if (endDate) {
            await page.fill('[name="EndDateSearch2"]', endDate);
            await page.dispatchEvent('[name="EndDateSearch2"]', 'change');
        }
        if (startDate || endDate) await page.waitForLoadState('networkidle');

        // Always click Search — grid data loads via AJAX after page render
        await jsClick(page, 'btnSearch_I');
        await page.waitForLoadState('networkidle');

        // Wait for page to re-stabilise — the grid triggers a secondary navigation
        // after networkidle that destroys the JS context if we proceed too soon
        await page.waitForSelector('[name="StartDateSearch2"]', { timeout: 15000 });
        await page.waitForLoadState('networkidle');

        // ── Export CSV ─────────────────────────────────────────────────────
        log('Exporting CSV...');

        const downloadPromise = page.waitForEvent('download', { timeout: 15000 });

        await page.evaluate(() => {
            const items = document.querySelectorAll('li');
            for (const li of items) {
                if (li.textContent.trim() === 'Export to') { li.click(); return; }
            }
        }).catch(() => {});

        await page.waitForFunction(
            () => Array.from(document.querySelectorAll('li')).some(li => li.textContent.trim() === 'Export to CSV'),
            { timeout: 3000 }
        ).catch(() => {});

        await page.evaluate(() => {
            const items = document.querySelectorAll('li');
            for (const li of items) {
                if (li.textContent.trim() === 'Export to CSV') { li.click(); return; }
            }
        }).catch(() => {});

        const download = await downloadPromise;
        await download.saveAs(outputPath);

    } finally {
        await browser.close();
    }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const SERVICE = 'gss-timesheet';

async function promptAndSaveCredentials() {
    let username = '';
    while (!username) {
        username = await ask('GSS Username: ');
        if (!username) console.log(col.yellow('Username cannot be empty.'));
    }
    let password = '';
    while (!password) {
        password = await askPassword('GSS Password: ');
        if (!password) console.log(col.yellow('Password cannot be empty.'));
    }
    await keytar.setPassword(SERVICE, 'username', username);
    await keytar.setPassword(SERVICE, 'password', password);
    console.log('Credentials saved to Windows Credential Manager.');
    return { username, password };
}

// Make sure Playwright's Chromium is present; download once if not. `log` lets the
// desktop app surface the one-time download notice in its loading view.
async function ensureChromium(log = console.log) {
    try {
        const b = await chromium.launch({ headless: true });
        await b.close();
    } catch {
        log('Downloading Chromium (one-time, ~100MB)...');
        execSync('npx playwright install chromium', { cwd: __dirname, stdio: 'inherit' });
    }
}

function defaultOutputPath() {
    const dir = path.join(__dirname, 'timesheets');
    fs.mkdirSync(dir, { recursive: true });
    const now = new Date();
    return path.resolve(path.join(dir, `timesheet-${now.getFullYear()}-W${isoWeek(now)}.csv`));
}

// Resolve a freshly-downloaded temp export against the empty-export fallback, then
// build the display models. Shared by the CLI and the desktop app.
// Build the display models from a CSV on disk (no scrape) — used for live in-app
// refreshes so worked-minutes and Claude usage tick with the clock, without
// re-downloading. computeWeekModel/computeTodayModel default to the current time.
function modelsFromCsv(csvPath) {
    const rows = parseCSV(csvPath);
    return { week: computeWeekModel(rows), today: computeTodayModel(rows), claude: computeClaudeUsage() };
}

function resolveFetched(outputPath, tmpPath) {
    let csvPath, source;
    if (punchRowCount(tmpPath) > 0) {
        fs.renameSync(tmpPath, outputPath);
        csvPath = outputPath; source = 'fresh';
    } else {
        fs.rmSync(tmpPath, { force: true });
        const fallback = lastGoodTimesheet(outputPath);
        csvPath = fallback || outputPath;
        source  = fallback ? 'fallback' : 'none';
    }
    return { source, csvPath, ...modelsFromCsv(csvPath) };
}

// GUI entry point: fetch + build models without any interactive prompts. Throws a
// typed CREDENTIALS_MISSING / LOGIN_FAILED error the renderer turns into a message.
async function loadTimesheetForApp({ startDate = '', endDate = '', log = () => {} } = {}) {
    await ensureChromium(log);
    const username = await keytar.getPassword(SERVICE, 'username');
    const password = await keytar.getPassword(SERVICE, 'password');
    if (!username || !password) {
        const e = new Error('No saved credentials. Run "Get-Timesheet.bat -SaveCredential" in a terminal first.');
        e.code = 'CREDENTIALS_MISSING';
        throw e;
    }
    const outputPath = defaultOutputPath();
    const tmpPath    = outputPath + '.download';
    await scrape(username, password, startDate, endDate, tmpPath, log);
    return resolveFetched(outputPath, tmpPath);
}

// Spawn the Electron desktop app (default when run without --cli / -SaveCredential).
function launchDesktopApp() {
    const { spawn } = require('child_process');
    let electronPath;
    try { electronPath = require('electron'); }
    catch { console.error(col.red('Electron is not installed. Run: npm install')); process.exit(1); }
    const child = spawn(electronPath, [__dirname], { stdio: 'inherit' });
    child.on('close', code => process.exit(code == null ? 0 : code));
}

async function main() {
    const args = parseArgs();

    // Default experience is the desktop app; the console UI stays available via --cli.
    // -SaveCredential always uses the terminal (it needs an interactive prompt).
    if (!args.cli && !args.saveCredential) { launchDesktopApp(); return; }

    await ensureChromium();

    // ── Credentials ──────────────────────────────────────────────────────────
    let username = await keytar.getPassword(SERVICE, 'username');
    let password = await keytar.getPassword(SERVICE, 'password');
    const credentialsMissing = !username || !password;
    if (args.saveCredential || credentialsMissing) {
        if (!args.saveCredential)
            console.log(col.yellow('No saved credentials found. You will be prompted once.'));
        ({ username, password } = await promptAndSaveCredentials());
    }

    // ── Output path ───────────────────────────────────────────────────────────
    let outputPath = args.outputPath;
    if (!outputPath) {
        const dir = path.join(__dirname, 'timesheets');
        fs.mkdirSync(dir, { recursive: true });
        const now = new Date();
        outputPath = path.join(dir, `timesheet-${now.getFullYear()}-W${isoWeek(now)}.csv`);
    }
    outputPath = path.resolve(outputPath);

    // ── Scrape + display ──────────────────────────────────────────────────────
    // Download to a temp file first so a glitchy empty export can never clobber
    // a previously-good CSV.
    const tmpPath = outputPath + '.download';
    try {
        await scrape(username, password, args.startDate, args.endDate, tmpPath);
    } catch (err) {
        if (err.code !== 'LOGIN_FAILED') throw err;
        console.log(col.yellow('\nSaved credentials were rejected. Please re-enter them.'));
        await keytar.deletePassword(SERVICE, 'username');
        await keytar.deletePassword(SERVICE, 'password');
        ({ username, password } = await promptAndSaveCredentials());
        await scrape(username, password, args.startDate, args.endDate, tmpPath);
    }

    const newRows = punchRowCount(tmpPath);
    if (newRows > 0) {
        // Good data — promote the temp file to the real week file.
        fs.renameSync(tmpPath, outputPath);
        console.log(col.green(`Saved: ${outputPath}  (${newRows} rows)`));
        showWeekStats(outputPath);
    } else {
        // Portal returned empty or malformed CSV — discard it and fall back.
        fs.rmSync(tmpPath, { force: true });
        console.log(col.yellow('Portal returned no punch data — keeping last good timesheet.'));
        const fallback = lastGoodTimesheet(outputPath);
        if (fallback) {
            console.log(col.gray(`Showing: ${fallback}`));
            showWeekStats(fallback);
        } else {
            console.log(col.yellow('No previous timesheet available to fall back on.'));
            showWeekStats(outputPath); // renders "No punch data found."
        }
    }

}

if (require.main === module) {
    main().catch(err => {
        console.error(col.red(`\nERROR: ${err.message}`));
        process.exit(1);
    });
}

module.exports = { rowMins, isLivePunch, rowsInCurrentWeek, parseCSV, combineDateTime, lastGoodTimesheet, computeWeekModel, computeTodayModel, computeClaudeUsage, loadTimesheetForApp, modelsFromCsv, sessionWindowStart };
