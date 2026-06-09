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

// Count punch rows in a CSV, treating any read/parse failure as 0.
function punchRowCount(p) {
    try { return fs.existsSync(p) ? parseCSV(p).length : 0; }
    catch { return 0; }
}

// Pick the last good timesheet to fall back on when a fresh export is empty:
// prefer the current week's existing file, else the most-recently-modified
// timesheets/*.csv that actually contains punch data. Returns null if nothing
// usable exists.
function lastGoodTimesheet(outputPath) {
    if (punchRowCount(outputPath) > 0) return outputPath;
    const dir = path.dirname(outputPath);
    let candidates = [];
    try {
        candidates = fs.readdirSync(dir)
            .filter(f => f.endsWith('.csv'))
            .map(f => path.join(dir, f))
            .filter(p => p !== outputPath && punchRowCount(p) > 0)
            .map(p => ({ p, mtime: fs.statSync(p).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime);
    } catch { /* timesheets dir missing — no candidates */ }
    return candidates.length ? candidates[0].p : null;
}

// ── CLI args ──────────────────────────────────────────────────────────────────

function parseArgs() {
    const argv = process.argv.slice(2);
    const args = { saveCredential: false, startDate: '', endDate: '', outputPath: '' };
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i].replace(/^-+/, '').toLowerCase();
        if (key === 'savecredential') { args.saveCredential = true; continue; }
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
            mins:    parseInt(r['Hours'].trim(), 10),
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

function showWeekStats(csvPath) {
    const rows = parseCSV(csvPath);
    if (!rows.length) { console.log(col.yellow('  No punch data found.')); return; }

    let totalMins = 0;
    const workDays = {};
    let isActive = false;

    for (const row of rows) {
        const mins   = parseInt(row['Hours'].trim(), 10);
        totalMins   += mins;
        const dayKey = new Date(row['Start Date'].trim()).toISOString().slice(0, 10);
        const timeIn = combineDateTime(row['Start Date'], row['Time In ']);
        const active = row['End Date'].includes('1900');
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
    const pct           = Math.min(100, Math.floor((totalMins / targetMins) * 100));
    const barFilled     = Math.floor(20 * pct / 100);
    const bar           = '█'.repeat(barFilled) + '░'.repeat(20 - barFilled);

    const today   = new Date();
    const dow     = today.getDay();
    const moOff   = dow === 0 ? -6 : 1 - dow;
    const weekMon = new Date(today);
    weekMon.setDate(today.getDate() + moOff);

    console.log('');
    console.log(col.cyan(`  Time & Attendance  --  Week of ${weekMon.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`));
    console.log(col.gray('  ' + '-'.repeat(50)));

    const mainCol = remaining === 0 ? col.green : pct >= 75 ? col.yellow : s => s;
    console.log(mainCol(`  ${'Total Worked'.padEnd(18)}  ${formatHM(totalMins).padStart(7)}   [${bar}] ${String(pct).padStart(3)}%`));
    console.log(`  ${'Days Worked'.padEnd(18)}  ${String(daysWorked).padStart(7)}`);
    console.log(`  ${'Avg / Day'.padEnd(18)}  ${formatHM(avgMinsPerDay).padStart(7)}`);
    if (remaining > 0) {
        console.log(col.yellow(`  ${'Hours Remaining'.padEnd(18)}  ${formatHM(remaining).padStart(7)}`));
    } else {
        console.log(col.green(`  ${'40-hr Target'.padEnd(18)}  ${'DONE'.padStart(7)}   (+ ${formatHM(overtime)} overtime)`));
    }
    if (isActive) console.log(col.darkYellow('  * Clock-in active -- hours include current session'));
    console.log('');

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

async function scrape(username, password, startDate, endDate, outputPath) {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ acceptDownloads: true });
    const page    = await context.newPage();

    try {
        // ── Login ──────────────────────────────────────────────────────────
        console.log('Logging in...');
        await page.goto('https://www.gss-service.com/Logon');
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
        console.log('Logged in.');

        // ── Time & Attendance ──────────────────────────────────────────────
        console.log('Loading Time and Attendance...');
        await page.goto('https://www.gss-service.com/TimeAttendance/Index');
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
        console.log('Exporting CSV...');

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

(async () => {
    // Ensure Chromium is installed
    try {
        const b = await chromium.launch({ headless: true });
        await b.close();
    } catch {
        console.log('Downloading Chromium (one-time, ~100MB)...');
        execSync('npx playwright install chromium', { cwd: __dirname, stdio: 'inherit' });
    }

    const args = parseArgs();

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

})().catch(err => {
    console.error(col.red(`\nERROR: ${err.message}`));
    process.exit(1);
});
