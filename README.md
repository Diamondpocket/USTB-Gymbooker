# School Gym Booker

Current stable version: `2.2.3`

This is a date-time-court driven booking script for mobile-first school gym pages.

## Workspace Layout

- `src/`: booking scripts and local UI server
- `ui/`: browser control panel
- `config/`: runtime configuration
- `test/`: automated tests
- `launcher/` and `scripts/`: Windows launcher source and build script
- `dist/`: generated launcher exe, ignored by Git
- `research/`: local captured pages and analysis notes, ignored by Git

You give it:

- booking date
- time range
- optional court preference order for booking
- optional release time
- optional blocked-price rules
- fixed campus availability rules for class/team-training closures

`bookingPageUrl` must be the real booking page URL ending with `weixinordernewv7.aspx`.
Do not paste personal center, order notice, or other menu pages there.

The script then:

1. opens the booking page in a mobile viewport
2. waits until the release time if configured
3. keeps polling availability
4. filters out campus-closed courts and blocked prices
5. builds several valid target combinations from each availability scan
6. submits the best target first, then immediately switches to the next target if the backend says the first one failed

There are now two modes:

- `book`: mobile browser automation
- `book-api`: direct HTTP submission using the same backend method the page calls
- `scan-api`: fast availability polling for backup courts

It uses your real login session and normal page actions. It does not bypass login, CAPTCHA, or server-side restrictions.

## Before Publishing

This repository is safe to publish only when local-only files stay ignored:

- `config/local.json`
- `config/multi-instance.json`
- `.auth/`
- `.coordination/`
- `logs/`
- `research/`
- `dist/`
- `GymBooker.exe`

Never commit real `wxkey` values, session storage, booking logs, captured HTML, or generated executables. Use the `config/*.example.json` files as public templates and keep your real config files local.

## Install

```powershell
npm.cmd install
npx.cmd playwright install chromium
```

## First Login

Copy the config and put your real booking URL in it:

```powershell
Copy-Item config/example.json config/local.json
```

Then save your login session:

```powershell
npm.cmd run capture-session
```

## Local UI

Start the local control panel:

```powershell
npm.cmd run ui
```

Then open:

```text
http://localhost:3210
```

The UI lets you:

- edit booking date, time, and preferred courts
- save `config/local.json`
- run `scan-api`
- run `book-api` dry-run
- run real `book-api`

## Multi-Account Coordination

Version `1.1.0` adds same-machine multi-account coordination. Each UI/API process can use its own config, instance name, port, wxkey, and session file, while sharing one local resource registry so automatic booking avoids courts already selected by another instance.

Example shared config:

```powershell
Copy-Item config/multi-instance.example.json config/multi-instance.json
```

Then edit the `YOUR_WXKEY_*` values and start separate instances:

```powershell
node src/ui-server.js --config config/multi-instance.json --instance card_a --port 3210
node src/ui-server.js --config config/multi-instance.json --instance card_b --port 3211
node src/ui-server.js --config config/multi-instance.json --instance card_c --port 3212
```

Direct CLI also supports the same flags:

```powershell
node src/index.js book-api --config config/multi-instance.json --instance card_a --date 2026-04-16 --time 08:00-20:00 --dry-run
```

Coordination behavior:

- `coordination.enabled=true` turns on the shared registry.
- `coordination.statePath` stores selected/booked resources as JSON.
- `coordination.lockPath` is a tiny file lock that prevents two processes from writing the registry at the same time.
- Automatic mode skips resources selected or booked by other instances.
- Manual mode can restrict allowed courts with `preferences.courtNumbers`.
- `manual_override.allow_manual_override=true` lets manual mode overwrite shared locks, and logs a conflict warning.

Shared resource record shape:

```json
{
  "id": "2026-4-16|Y|18|8:00-9:00",
  "date": "2026-4-16",
  "lxbh": "Y",
  "courtNo": 18,
  "timeRange": "8:00-9:00",
  "sourceInstance": "card-a",
  "status": "selected",
  "updatedAt": "2026-04-13T03:30:00.000Z",
  "expiresAt": "2026-04-13T03:31:30.000Z"
}
```

Log format:

```text
[2026/4/13 11:30:00][card-a] Locked 2 resource(s) in shared registry.
[2026/4/13 11:30:00][card-b] Coordination skipped 2 resource(s) selected by other instance(s).
```

## Windows EXE Launcher

Build the simple Windows launcher:

```powershell
npm.cmd run build-exe
```

This generates:

```text
dist/GymBooker.exe
```

Usage:

1. Keep the whole project folder structure intact
2. Double-click `dist/GymBooker.exe`
3. It starts the local UI server and opens `http://localhost:3210`

Multi-instance launcher examples:

```powershell
dist\GymBooker.exe --config config\multi-instance.json --instance card_a --port 3210
dist\GymBooker.exe --config config\multi-instance.json --instance card_b --port 3211
dist\GymBooker.exe --config config\multi-instance.json --instance card_c --port 3212
```

The generated convenience launcher names `GymBooker-card-a.exe`, `GymBooker-card-b.exe`, and `GymBooker-card-c.exe` automatically map to ports `3210`, `3211`, and `3212`.

Notes:

- This is the simple launcher version, not a single-file full bundle
- `config/`, `.auth/`, `src/`, `ui/`, and `node_modules/` still need to stay with the project
- For testing without opening a browser:

```powershell
dist\GymBooker.exe --no-browser
```

## Run With Direct Parameters

Example:

```powershell
npm.cmd run book -- --date 2026-04-12 --time 19:00-20:00 --courts 6,7,8 --release-at "2026-04-09 08:59:58"
```

Direct API dry run:

```powershell
npm.cmd run book-api -- --date 2026-04-12 --time 19:00-20:00 --courts 6,7,8 --dry-run
```

Fast fallback scan:

```powershell
npm.cmd run scan-api -- --date 2026-04-12 --time 19:00-20:00 --courts 6,7,8 --scan-loops 20 --scan-interval-ms 500
```

Two separate time segments:

```powershell
npm.cmd run book-api -- --date 2026-04-12 --times 08:00-09:00,18:00-19:00 --courts 12,13,14,15,16,17,18,19,20 --dry-run
```

The UI now treats every court as a one-hour whole-hour slot. Pick only the start hour; the end hour is calculated automatically. On every launch it defaults to booking the same weekday next week and release time today at `09:00`.

Parameter meanings:

- `--date`: booking date
- `--time`: time range in `HH:mm-HH:mm`
- `--times`: two or more separate time ranges, for example `08:00-09:00,18:00-19:00`
- `--courts`: preferred court numbers in priority order
- `--release-at`: local time when booking opens
- `--booking-url`: optional override for the booking page URL
- `--dry-run`: print the API payload without placing the order
- `--scan-loops`: how many refreshes to run in scan mode
- `--scan-interval-ms`: refresh interval in milliseconds for scan mode
- `--config`: choose a specific config file
- `--instance`: choose an instance from `config/multi-instance.json`

## Config Fields

The script is now centered on these fields in `config/local.json`:

- `bookingWindow.date`
- `bookingWindow.startTime`
- `bookingWindow.endTime`
- `preferences.courtNumbers`
- `rules.blockedPrices`
- `rules.requiredCourtCount`
- `campusAvailabilityRules`
- `optimization`
- `releaseAt`

You can keep the URL fixed in config and override only the booking target from the command line.

## Fast-Switch Optimization

Version `2.1.5` keeps `book-api` scan-first and adds submit-time prefetch: while one order request is waiting for a response, the runner keeps scanning in the background but never sends a second submit until the first response returns.

- one availability scan now produces multiple legal booking plans
- a backend business failure marks that exact plan as temporarily failed
- the runner can immediately try the next plan from the latest prefetched scan instead of waiting for another full polling cycle after the response
- submit timeout is intentionally long because the gym backend can take tens of seconds to respond
- submit network retry defaults to `0` to preserve the single-submit-flight rule
- submit timeout, HTTP 504, and network errors are not decisive success/failure signals, so the runner rescans and continues
- explicit daily-limit responses, for example `今天已经预订了1次，不能再预订`, stop the instance
- pre-release responses, for example `球馆还没有上线`, do not block the target and keep polling
- partial success releases shared locks instead of marking all requested courts booked, so other instances can rely on fresh scans
- rate-limit style messages are treated as fatal safety stops. The runner does not cooldown and continue.
- `maxSubmitsPerScan` limits how many scanned candidates can be submitted from one scan before rescanning.

Tunable fields live under `optimization`:

```json
{
  "fastTargetSwitch": true,
  "maxPlansPerScan": 16,
  "maxSubmitsPerScan": 2,
  "prefetchWhileSubmitting": true,
  "prefetchScanIntervalMs": 800,
  "availabilityTimeoutMs": 20000,
  "submitTimeoutMs": 120000,
  "networkRetryCount": 0,
  "networkRetryDelayMs": 80,
  "fastRescanDelayMs": 0,
  "failedTargetCooldownMs": 5000
}
```

## Fallback Workflow

When your target court gets taken quickly, use `scan-api` to poll the same date and time range at high frequency and immediately see which backup courts are still available.

Scan output also shows:

- `@price`: current price for that court
- `[blocked]`: a court price that is excluded from auto-booking

## Rush Booking Rule

The API booking mode is now designed for the 9:00 release pattern:

- start trying from `08:59:00`
- keep polling until booking succeeds or max attempts are exhausted
- every order must include exactly two courts
- courts are chosen by your configured preference order

## Practical Note

If the system only allows booking after a certain time, the script can wait and submit immediately at that time, but it cannot create a valid booking before the server opens it.
