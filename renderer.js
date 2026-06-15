'use strict';
// Renderer: requests data from main, streams progress into the loading view,
// then paints the glass dashboard from the plain models. No Node access here.

const $ = id => document.getElementById(id);
const show = (el, on) => el.classList.toggle('hidden', !on);

const views = { loading: $('view-loading'), error: $('view-error'), dash: $('view-dash') };
function showView(name) {
    for (const [k, el] of Object.entries(views)) show(el, k === name);
}

// ── Title-bar controls ──────────────────────────────────────────────────────
$('btn-min').addEventListener('click', () => window.api.minimize());
$('btn-close').addEventListener('click', () => window.api.close());
$('btn-retry').addEventListener('click', () => start());

// ── Progress stream ──────────────────────────────────────────────────────────
window.api.onProgress(msg => { $('load-msg').textContent = msg; });

// ── Entry ─────────────────────────────────────────────────────────────────────
async function start() {
    showView('loading');
    $('load-msg').textContent = 'Connecting to GSS…';
    const res = await window.api.load();
    if (res.ok) render(res.data);
    else        renderError(res);
}

function renderError({ code, message }) {
    $('error-title').textContent =
        code === 'CREDENTIALS_MISSING' ? 'No saved credentials' :
        code === 'LOGIN_FAILED'        ? 'Sign-in failed' :
                                         'Couldn’t load your timesheet';
    $('error-msg').textContent = message || 'Please try again.';
    showView('error');
}

// ── Dashboard ──────────────────────────────────────────────────────────────────
function render({ week, today, claude, source }) {
    $('week-of').textContent = `Week of ${week.weekOf}`;

    // source chip (only when we fell back / have nothing fresh)
    const chip = $('source-chip');
    if (source === 'fallback') { chip.textContent = 'last saved'; show(chip, true); }
    else if (source === 'none') { chip.textContent = 'no data yet'; show(chip, true); }
    else show(chip, false);

    renderHeadline(week);

    if (week.hasData) {
        renderBars(week.days);
        renderToday(today);
        renderFriday(week.friday);
        renderClaude(claude);
        show($('friday-card'), week.friday.applicable && week.friday.kind);
    } else {
        // Empty week: keep it honest and quiet.
        $('bars').innerHTML = `<p class="muted" style="margin:auto">No punches recorded this week yet.</p>`;
        show($('view-dash').querySelector('.card--today'), false);
        show($('friday-card'), false);
        renderClaude(claude);
    }

    showView('dash');
}

function renderHeadline(week) {
    const big = $('remaining-big'), label = $('remaining-label');
    if (!week.hasData) { big.textContent = '0:00'; big.classList.remove('is-done'); label.textContent = 'no hours logged yet'; return; }
    if (week.targetReached) {
        big.textContent = week.overtimeHM;
        big.classList.add('is-done');
        label.textContent = '40-hr target met · overtime';
    } else {
        big.textContent = week.remainingHM;
        big.classList.remove('is-done');
        label.textContent = `remaining this week · ${week.totalHM} of 40:00`;
    }
}

function renderBars(days) {
    const wrap = $('bars');
    wrap.innerHTML = '';
    for (const d of days) {
        if (!d.show) continue;
        const bar = document.createElement('div');
        bar.className = 'bar' + (d.active ? ' is-active' : '') + (d.worked ? '' : ' is-idle');
        bar.innerHTML = `
            <span class="bar__hrs${d.worked ? '' : ' is-empty'}">${d.hm}</span>
            <div class="bar__track"><div class="bar__fill${d.full ? ' is-full' : ''}"></div></div>
            <span class="bar__day">${d.name}</span>
            <span class="bar__date">${d.date}</span>`;
        wrap.appendChild(bar);
        // animate fill after layout so the height transition runs
        const fill = bar.querySelector('.bar__fill');
        requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.height = `${d.pct}%`; }));
    }
}

function renderToday(t) {
    const list = $('today-list');
    show($('view-dash').querySelector('.card--today'), t.hasData);
    show($('live-pill'), !!t.isActive);
    if (!t.hasData) { list.innerHTML = ''; return; }

    const brk =
        !t.breaks || t.breaks.length === 0 ? { v: 'None yet' } :
        t.breaks.length === 1              ? { v: `${t.breaks[0].from} – ${t.breaks[0].to}`, tail: `${t.breaks[0].mins} min` } :
                                             { v: `${t.breaks.length} breaks`, tail: `${t.breaks.reduce((s, b) => s + b.mins, 0)} min` };

    const rows = [
        { glyph: '◷', cls: '',         k: 'Clocked in', v: t.clockedIn },
        { glyph: '☕', cls: 'is-amber', k: 'Break',      v: brk.v, tail: brk.tail },
    ];
    if (t.status === 'done') {
        rows.push({ glyph: '✓', cls: 'is-green', k: 'Eight-hour day', v: 'Complete', tail: `+${t.overHM}` });
    } else if (t.status === 'clockout') {
        rows.push({ glyph: '→', cls: '', k: 'Clock out by', v: t.clockOutBy, tail: `${t.remainingHM} left` });
    } else {
        rows.push({ glyph: '→', cls: '', k: 'To hit 8 hrs', v: `${t.remainingHM} more` });
    }

    list.innerHTML = rows.map(r => `
        <li class="row">
            <span class="row__glyph ${r.cls}">${r.glyph}</span>
            <span class="row__body"><span class="row__k">${r.k}</span><span class="row__v">${r.v}</span></span>
            ${r.tail ? `<span class="row__tail">${r.tail}</span>` : ''}
        </li>`).join('');
}

function renderFriday(f) {
    const text = $('friday-text'), sub = $('friday-sub');
    sub.textContent = '';
    text.classList.remove('is-good');
    switch (f.kind) {
        case 'done':
            text.textContent = 'You’ve hit 40 hours — nothing more required.';
            text.classList.add('is-good'); break;
        case 'ahead':
            text.textContent = 'At this pace you’ll hit 40 hours before Friday.';
            text.classList.add('is-good'); break;
        case 'friday-active':
            text.textContent = `Stay clocked in until ${f.clockOut}.`;
            sub.textContent = `${f.needHM} more to reach the 40-hour week.`; break;
        case 'friday-inactive':
            text.textContent = `Need ${f.needHM} more today.`;
            sub.textContent = `Clock out around ${f.clockOut}.`; break;
        case 'need':
            text.textContent = `Need ${f.needHM} on Friday (${f.fridayDateStr}).`;
            sub.textContent = `Avg start ~${f.avgStart} → clock out ~${f.fridayClockOut} · assumes ${f.avgPerDayHM}/day Mon–Thu.`; break;
        default:
            text.textContent = '';
    }
}

function renderClaude(c) {
    const card = $('claude-card');
    if (!c || !c.available) { show(card, false); return; }
    show(card, true);
    $('meter-session').innerHTML = meterHTML('Session', c.session);
    $('meter-weekly').innerHTML  = meterHTML('Weekly',  c.weekly);
    // animate widths
    requestAnimationFrame(() => requestAnimationFrame(() => {
        card.querySelectorAll('.meter__fill').forEach(el => { el.style.width = el.dataset.pct + '%'; });
    }));
}

function meterHTML(name, m) {
    const cls = m.pct >= 90 ? 'crit' : m.pct >= 70 ? 'warn' : '';
    const pct = Math.min(100, m.pct);
    return `
        <div class="meter__top"><span class="meter__name">${name}</span>
            <span class="meter__val">${m.pct}% · ${m.used}/${m.budget}</span></div>
        <div class="meter__track"><div class="meter__fill ${cls}" data-pct="${pct}" style="width:0"></div></div>
        <div class="meter__reset">${m.reset}</div>`;
}

start();
