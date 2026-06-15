# GSS Timesheet — Apple-Glass Desktop App

**Date:** 2026-06-15
**Status:** Approved, pre-implementation

## Goal

Replace the terminal-text output of the GSS timesheet tool with a double-clickable
**Electron desktop app** rendering a polished **Apple "liquid glass"** dashboard.
The existing Playwright scraper and credential flow are preserved; only the
presentation layer is new.

## Architecture

Three layers, each independently testable:

1. **Data core** (`Get-Timesheet.js`, refactored) — pure model builders that take
   parsed CSV rows + `now` and return plain data objects, no `console.log`:
   - `computeWeekModel(rows, now)` — week totals, per-day hours, remaining/overtime,
     days worked, avg/day, active flag, and the Friday estimate.
   - `computeTodayModel(rows, now)` — clocked-in time, default lunch break, clock-out-by.
   - `computeClaudeUsage(now)` — session/weekly token usage data (extracted from the
     current `showClaudeUsage`).
   The existing console renderers (`showWeekStats` etc.) become thin consumers of these
   models, kept behind a `--cli` flag.

2. **Electron main process** (`electron-main.js`) — owns the window lifecycle; runs the
   existing `scrape()` + `keytar` flow; parses CSV via existing `parseCSV` /
   `lastGoodTimesheet`; builds the models; returns them to the renderer over a secure
   IPC channel (`contextIsolation: true`, `nodeIntegration: false`, a `preload.js`
   exposing a minimal `window.api.getTimesheet()`).

3. **Renderer** (`index.html` + `renderer.js` + `styles.css`) — draws the glass UI from
   the model. No Node access.

## UI

Single window, soft gradient backdrop, frosted-glass cards (`backdrop-filter: blur +
saturate`, translucent white, 1px light border, large radius, soft shadow), system font
stack, one system-blue accent.

- **Header card:** "Week of <Mon date>" + **Hours Remaining** as the headline number
  (flips to "40-hr target met (+overtime)" when complete). No progress ring.
- **Daily Hours:** **vertical** bars, Mon–Fri always (Sat/Sun only if worked), each
  scaled to the 8h day target; hours labeled above, day below; active day glows.
- **Today card:** three rows — `Clocked in`, `Break` (the real lunch, detected from
  the gap between punches; "None yet" if you haven't clocked out/in), `Clock out by`.
- **Friday Estimate card.**
- **Claude usage:** small secondary glass card (de-emphasized).
- **States:** glass loading view ("Logging in… Exporting…") and a friendly
  error / empty-data view that reuses the empty-export fallback logic.

## Decisions

- **Clock-out-by math unchanged** (worked-hours based). Breaks are real gaps between
  punches, so they're naturally excluded from worked minutes — no extra adjustment.
- **Old CLI** retained behind a `--cli` flag (preserves existing tests + a debug path).
- **Scraper unchanged** — Playwright stays; Chromium downloads on first run (~100 MB)
  with a progress message instead of a blocking `execSync`.

## Packaging

`electron-builder` → portable `.exe` (no installer). Size ~150–200 MB (accepted).

## What stays / changes / is new

- **Unchanged:** `scrape()`, `parseCSV`, `lastGoodTimesheet`, `rowMins`, `isLivePunch`,
  credential flow, all existing tests.
- **Refactored:** `showWeekStats`/`showTodayStats`/`showClaudeUsage` split into
  model + thin renderer.
- **New:** `computeWeekModel` / `computeTodayModel` / `computeClaudeUsage` (+ tests),
  `electron-main.js`, `preload.js`, `index.html`, `renderer.js`, `styles.css`,
  electron-builder config, launcher.

## Verification

- Unit tests for the three model builders (TDD).
- CLI (`--cli`) output stays equivalent to today's.
- App launches, shows loading → dashboard against live data; error/empty states render.
