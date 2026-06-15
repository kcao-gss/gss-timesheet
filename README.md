# gss-timesheet

Your GSS Time & Attendance week at a glance — a small **Apple-glass desktop app**
(Electron) with a terminal fallback. Logs into the GSS ServiceWeb portal with
Playwright, exports your punch data, and shows weekly hours, a daily vertical-bar
chart, today's clock-out target, and a Friday estimate. Built to sit open on a
second monitor all day — it refreshes itself.

## Quick start

```
npm install                          # one-time (installs Electron + Playwright)
Get-Timesheet.bat -SaveCredential    # one-time: store your GSS login (Windows Credential Manager)
npm start                            # launch the desktop app   (or double-click Timesheet.bat)
```

On first run Playwright downloads Chromium (~100 MB, one-time).

## The desktop app

A frameless liquid-glass window that **scales to fit any size** (no scrollbar — drag
the edges and everything stays in view). It shows:

- **Week** — "Week of …", the big **Hours Remaining** figure (flips to overtime once
  you hit 40), and a **vertical bar per weekday** (weekends only if worked; the active
  day glows) — all in one card.
- **Today** — clocked-in time, your **real lunch break** (detected from the gap between
  punches; "None yet" until you clock out/in), and your clock-out-by time.
- **Friday Estimate** — when to clock out to hit 40.
- **Claude Code usage** — a small secondary card.

### Stays live

While it's open it updates on its own — no clicking:

- **Every 60 s** — worked minutes, hours-remaining, clock-out-by and Claude usage
  recompute from the current time (no network call).
- **Every 20 min** — a silent background re-scrape picks up new punches (lunch, final
  clock-out). If a refresh glitches, it keeps showing the last good data.

If the portal hands back an empty export, the app falls back to the last saved week
(and labels it) instead of showing a confusing blank.

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
it shows a prompt to run the command above.

## Tests

```
npm test               # unit tests for the timesheet math + display models
```

## Troubleshooting

**`Electron failed to install correctly` / `npm start` throws on launch.**
Electron's binary download is separate from `npm install` and can silently fail to
unzip on some setups (notably when Node's unzip is interrupted). The download itself
is usually fine — re-extract the cached zip with Windows' native `tar` (bsdtar), which
is more robust than Git Bash's GNU `tar`:

```
ZIP=$(ls "$HOME/AppData/Local/electron/Cache/"*/electron-v*-win32-x64.zip | head -1)
rm -rf node_modules/electron/dist && mkdir -p node_modules/electron/dist
/c/Windows/System32/tar.exe -xf "$ZIP" -C node_modules/electron/dist
printf electron.exe > node_modules/electron/path.txt
```

Then `npm start` again.

## Parameters (CLI / credential mode)

| Parameter | Description |
|---|---|
| `--cli` | Render the text summary instead of launching the app |
| `-SaveCredential` | Prompt for and save credentials |
| `-StartDate` | Optional start date filter (e.g. `"6/1/2026"`) |
| `-EndDate` | Optional end date filter (e.g. `"6/5/2026"`) |
| `-OutputPath` | Custom path to save the CSV |

CSV files default to `.\timesheets\timesheet-YYYY-Www.csv` (ISO week number).
