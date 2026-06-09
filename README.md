# gss-timesheet

Downloads your GSS Time & Attendance timesheet and displays weekly statistics — all from the command line.

## What it does

Logs into the GSS ServiceWeb portal using Playwright, exports your punch data as a CSV, and prints a formatted weekly summary with hours worked, days worked, 40-hour progress, and a Friday clock-out estimate.

```
  Time & Attendance  --  Week of Jun 2, 2026
  --------------------------------------------------
  Total Worked         36:15   [██████████████████  ] 91%
  Days Worked          4
  Avg / Day            9:04
  40-hr Target         3:45 remaining

  --------------------------------------------------
  Friday Estimate

  Clock out at 4:00 PM Friday to hit 40:00.
```

## Requirements

- Windows
- Node.js

Playwright and Chromium are installed automatically on first run (~100 MB download).

## Setup

Save your GSS credentials to Windows Credential Manager (one-time):

```
Get-Timesheet.bat -SaveCredential
```

You'll be prompted for your username and password. They're stored securely in Windows Credential Manager under the service `gss-timesheet` and can only be accessed by your Windows account.

## Usage

```
# Download timesheet for the current week and show stats
Get-Timesheet.bat

# Filter by date range
Get-Timesheet.bat -StartDate "6/1/2026" -EndDate "6/5/2026"

# Save the CSV to a custom location
Get-Timesheet.bat -OutputPath "C:\path\to\timesheet.csv"
```

CSV files default to `.\timesheets\timesheet-YYYY-Www.csv` (ISO week number).

## Parameters

| Parameter | Description |
|---|---|
| `-SaveCredential` | Prompt for and save credentials to Windows Credential Manager |
| `-StartDate` | Optional start date filter (e.g. `"6/1/2026"`) |
| `-EndDate` | Optional end date filter (e.g. `"6/5/2026"`) |
| `-OutputPath` | Custom path to save the CSV |
