# 北京科技大学体育馆抢场工具

当前稳定版本：`2.2.6`

这是一个专门为北京科技大学体育馆订场系统编写的本地抢场工具，核心目标是绕开移动端网页卡顿、拖动困难、9 点放场时响应过慢这些问题。

## 项目结构

- `src/`: booking scripts and local UI server
- `ui/`: browser control panel
- `config/`: runtime configuration
- `test/`: automated tests
- `launcher/` and `scripts/`: Windows launcher source and build script
- `dist/`: generated launcher exe, ignored by Git
- `research/`: local captured pages and analysis notes, ignored by Git

你需要提供：

- booking date
- time range
- optional court preference order for booking
- optional release time
- optional blocked-price rules
- fixed campus availability rules for class/team-training closures

`bookingPageUrl` must be the real booking page URL ending with `weixinordernewv7.aspx`.
Do not paste personal center, order notice, or other menu pages there.

程序会：

1. opens the booking page in a mobile viewport
2. waits until the release time if configured
3. keeps polling availability
4. filters out campus-closed courts and blocked prices
5. builds several valid target combinations from each availability scan
6. submits the best target first, then immediately switches to the next target if the backend says the first one failed

当前支持的模式：

- `book`: mobile browser automation
- `book-api`: direct HTTP submission using the same backend method the page calls
- `scan-api`: fast availability polling for backup courts

它使用你的真实登录态和页面后端链路，不绕过登录、验证码或服务器限制。

## 发布前检查

这个仓库只有在本地敏感文件持续保持忽略状态时，才适合发布：

- `config/local.json`
- `config/multi-instance.json`
- `.auth/`
- `.coordination/`
- `logs/`
- `research/`
- `dist/`
- `GymBooker.exe`

不要提交真实 `wxkey`、登录态文件、订场日志、抓取的 HTML 或生成出来的 exe。公开仓库里只保留 `config/*.example.json` 作为模板，真实配置始终放在本地。

## 安装

```powershell
npm.cmd install
npx.cmd playwright install chromium
```

## 首次登录

先复制配置模板，并填入你自己的订场链接：

```powershell
Copy-Item config/example.json config/local.json
```

然后保存登录态：

```powershell
npm.cmd run capture-session
```

## 本地控制台

启动本地控制台：

```powershell
npm.cmd run ui
```

Then open:

```text
http://localhost:3210
```

控制台可以：

- 修改订场日期、时段、场地偏好
- 保存 `config/local.json`
- 执行 `scan-api`
- 执行 `book-api` dry-run
- 执行真实 `book-api`

## 多账号协同

从 `1.1.0` 开始支持同机多账号协同。每个 UI/API 进程都可以使用独立配置、实例名、端口、`wxkey` 和登录态文件，同时通过本地共享资源池避免不同账号抢到同一片场地。

共享配置示例：

```powershell
Copy-Item config/multi-instance.example.json config/multi-instance.json
```

然后填写 `YOUR_WXKEY_*`，分别启动不同实例：

```powershell
node src/ui-server.js --config config/multi-instance.json --instance card_a --port 3210
node src/ui-server.js --config config/multi-instance.json --instance card_b --port 3211
node src/ui-server.js --config config/multi-instance.json --instance card_c --port 3212
```

命令行同样支持这些参数：

```powershell
node src/index.js book-api --config config/multi-instance.json --instance card_a --date 2026-04-16 --time 08:00-20:00 --dry-run
```

协同行为：

- `coordination.enabled=true` turns on the shared registry.
- `coordination.statePath` stores selected/booked resources as JSON.
- `coordination.lockPath` is a tiny file lock that prevents two processes from writing the registry at the same time.
- Automatic mode skips resources selected or booked by other instances.
- Manual mode can restrict allowed courts with `preferences.courtNumbers`.
- `manual_override.allow_manual_override=true` lets manual mode overwrite shared locks, and logs a conflict warning.

共享资源记录结构：

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

日志格式：

```text
[2026/4/13 11:30:00][card-a] Locked 2 resource(s) in shared registry.
[2026/4/13 11:30:00][card-b] Coordination skipped 2 resource(s) selected by other instance(s).
```

## Windows EXE 启动器

构建简易 Windows 启动器：

```powershell
npm.cmd run build-exe
```

会生成：

```text
dist/GymBooker.exe
```

使用方式：

1. Keep the whole project folder structure intact
2. Double-click `dist/GymBooker.exe`
3. It starts the local UI server and opens `http://localhost:3210`

多实例启动示例：

```powershell
dist\GymBooker.exe --config config\multi-instance.json --instance card_a --port 3210
dist\GymBooker.exe --config config\multi-instance.json --instance card_b --port 3211
dist\GymBooker.exe --config config\multi-instance.json --instance card_c --port 3212
```

生成的 `GymBooker-card-a.exe`、`GymBooker-card-b.exe`、`GymBooker-card-c.exe` 会自动对应 `3210`、`3211`、`3212` 端口。

说明：

- 这是简易启动器，不是单文件完全打包版
- `config/`、`.auth/`、`src/`、`ui/`、`node_modules/` 仍然要和项目放在一起
- 如果只想测试，不自动打开浏览器：

```powershell
dist\GymBooker.exe --no-browser
```

## 直接带参数运行

示例：

```powershell
npm.cmd run book -- --date 2026-04-12 --time 19:00-20:00 --courts 6,7,8 --release-at "2026-04-09 08:59:58"
```

直接 API 干跑：

```powershell
npm.cmd run book-api -- --date 2026-04-12 --time 19:00-20:00 --courts 6,7,8 --dry-run
```

快速扫描候补：

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
  "availabilityTimeoutMs": 100000,
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
