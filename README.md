# gss-timesheet

Your GSS Time & Attendance week at a glance — a small **Apple-glass desktop app**
(Electron) with a terminal fallback. Logs into the GSS ServiceWeb portal with
Playwright, exports your punch data, and shows weekly hours, a daily vertical-bar
chart, today's clock-out target, and a Friday estimate.

## Quick start

```
npm install            # one-time (installs Electron + Playwright)
Get-Timesheet.bat -SaveCredential   # one-time: store your GSS login (Windows Credential Manager)
npm start              # launch the desktop app   (or double-click Timesheet.bat)
```

On first run Playwright downloads Chromium (~100 MB, one-time).

## The desktop app

A frameless liquid-glass window showing:

- **Hours Remaining** for the week (flips to overtime once you hit 40).
- **Daily Hours** — a vertical bar per weekday (weekends only if worked); the active day glows.
- **Today** — clocked-in time, a default lunch break (12:00–1:00 PM), and your clock-out-by time.
- **Friday Estimate** — when to clock out to hit 40.
- **Claude Code usage** — a small secondary card.

If the portal hands back an empty export, the app falls back to the last saved week
(and says so) instead of showing a confusing blank.

### Build a standalone .exe

```
npm run dist           # -> dist/GSS-Timesheet.exe (portable, no install)
```

## Terminal version

The original CLI is still available:

```
npm run cli                              # this week's summary as text
Get-Timesheet.bat --cli                  # same, via the launcher
Get-Timesheet.bat --cli -StartDate "6/1/2026" -EndDate "6/5/2026"
```

## Credentials

```
Get-Timesheet.bat -SaveCredential
```

Stored in Windows Credential Manager under the service `gss-timesheet`, readable only
by your Windows account. The desktop app reads them automatically; if none are saved
it shows a friendly prompt to run the command above.

## Tests

```
npm test               # unit tests for the timesheet math + models
```

## Parameters (CLI / credential mode)

| Parameter | Description |
|---|---|
| `--cli` | Render the text summary instead of launching the app |
| `-SaveCredential` | Prompt for and save credentials |
| `-StartDate` | Optional start date filter (e.g. `"6/1/2026"`) |
| `-EndDate` | Optional end date filter (e.g. `"6/5/2026"`) |
| `-OutputPath` | Custom path to save the CSV |

CSV files default to `.\timesheets\timesheet-YYYY-Www.csv` (ISO week number).
