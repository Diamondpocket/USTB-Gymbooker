# 北京科技大学体育馆抢场工具

当前稳定版本：`2.2.6`

这是一个专门为北京科技大学体育馆订场系统编写的本地抢场工具。  
它的核心目标是绕开移动端网页卡顿、拖动困难、放场瞬间响应慢这些问题，把“看余量、筛场地、选时段、提交订单”尽量压缩成更直接的本地控制台和后端链路。

## 项目用途

这个项目主要解决下面几类问题：

- 微信公众号里的订场页面偏移动端，电脑上操作很不顺手
- 9 点放场时网页容易卡死、超时、拖不动
- 手动切日期、切场地、点两次时段太慢
- 多个账号同时抢场时，容易互相撞到同一片场地

项目支持三种工作模式：

- `book`：浏览器自动化订场
- `book-api`：直接调用页面后端接口抢场
- `scan-api`：快速刷新可用场地，作为候补扫描

## 项目结构

- `src/`：核心脚本、本地 UI 服务、订场逻辑
- `ui/`：浏览器控制台页面
- `config/`：配置模板和本地配置
- `test/`：自动化测试
- `launcher/`：Windows 启动器源码
- `scripts/`：构建脚本
- `dist/`：生成出来的 exe，默认不进 Git
- `research/`：本地抓包和分析文件，默认不进 Git

## 你需要准备什么

使用前需要准备这些内容：

- 真实订场页面链接 `bookingPageUrl`
- 对应账号的 `wxkey`
- 抢场日期 `bookingWindow.date`
- 一个或两个目标时段 `bookingWindow.segments`
- 场地偏好 `preferences.courtNumbers`
- 禁抢价格 `rules.blockedPrices`
- 开抢时间 `releaseAt`

注意：

- `bookingPageUrl` 必须是真实订场页链接，也就是以 `weixinordernewv7.aspx` 结尾的页面
- 不要填个人中心、上级菜单、订单页之类的链接

## 程序会做什么

程序启动后会按下面的顺序工作：

1. 读取配置
2. 如有需要，等待到 `releaseAt`
3. 不断刷新可用场地
4. 过滤禁抢价格、已被其他实例锁定的资源
5. 根据你的时段和场地偏好生成候选组合
6. 优先提交最优候选
7. 如果后端明确返回失败，再立刻切换候选或重新扫描

它使用你的真实登录态和页面后端链路，不绕过登录、验证码或服务器限制。

## 发布前安全检查

这个仓库适合发布的前提是：本地敏感文件必须始终保持忽略状态。

默认不应进入 Git 的内容包括：

- `config/local.json`
- `config/multi-instance.json`
- `.auth/`
- `.coordination/`
- `logs/`
- `research/`
- `dist/`
- `GymBooker.exe`

不要提交这些内容：

- 真实 `wxkey`
- 登录态文件
- 订场日志
- 抓取下来的 HTML
- 生成出来的 exe

公开仓库只保留 `config/*.example.json` 作为模板，真实配置只放本地。

## 安装

```powershell
npm.cmd install
npx.cmd playwright install chromium
```

## 首次登录

先复制配置模板：

```powershell
Copy-Item config/example.json config/local.json
```

然后把你自己的订场页面链接填进 `config/local.json`。

接着保存登录态：

```powershell
npm.cmd run capture-session
```

## 本地控制台

启动本地控制台：

```powershell
npm.cmd run ui
```

打开：

```text
http://localhost:3210
```

控制台支持：

- 修改订场日期
- 修改一个或两个目标时段
- 选择场地偏好
- 保存 `config/local.json`
- 执行 `scan-api`
- 执行 `book-api` 的 `dry-run`
- 执行真实 `book-api`

## 多账号协同

从 `1.1.0` 开始，这个项目支持同机多账号协同。

每个实例都可以有自己的：

- `bookingPageUrl`
- `wxkey`
- 端口
- 登录态文件
- 实例名

但多个实例共享一个本地资源池，避免不同账号抢到同一片场地。

先复制多实例配置模板：

```powershell
Copy-Item config/multi-instance.example.json config/multi-instance.json
```

然后填写不同账号的 `YOUR_WXKEY_*`，再分别启动：

```powershell
node src/ui-server.js --config config/multi-instance.json --instance card_a --port 3210
node src/ui-server.js --config config/multi-instance.json --instance card_b --port 3211
node src/ui-server.js --config config/multi-instance.json --instance card_c --port 3212
```

命令行模式也支持同样的参数：

```powershell
node src/index.js book-api --config config/multi-instance.json --instance card_a --date 2026-04-16 --time 08:00-20:00 --dry-run
```

协同规则如下：

- `coordination.enabled=true`：启用共享资源池
- `coordination.statePath`：保存共享状态 JSON
- `coordination.lockPath`：文件锁，避免两个进程同时写状态
- 自动模式会自动跳过其他实例已锁定或已下单的资源
- 手动模式可通过 `preferences.courtNumbers` 限定场地
- `manual_override.allow_manual_override=true`：允许手动覆盖共享锁，但会在日志中警告冲突风险

共享资源记录示例：

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

日志示例：

```text
[2026/4/13 11:30:00][card-a] Locked 2 resource(s) in shared registry.
[2026/4/13 11:30:00][card-b] Coordination skipped 2 resource(s) selected by other instance(s).
```

## Windows EXE 启动器

构建简易启动器：

```powershell
npm.cmd run build-exe
```

会生成：

```text
dist/GymBooker.exe
```

使用方式：

1. 保持整个项目目录结构完整
2. 双击 `dist/GymBooker.exe`
3. 程序会启动本地 UI 服务，并打开 `http://localhost:3210`

多实例示例：

```powershell
dist\GymBooker.exe --config config\multi-instance.json --instance card_a --port 3210
dist\GymBooker.exe --config config\multi-instance.json --instance card_b --port 3211
dist\GymBooker.exe --config config\multi-instance.json --instance card_c --port 3212
```

`GymBooker-card-a.exe`、`GymBooker-card-b.exe`、`GymBooker-card-c.exe` 会自动对应 `3210`、`3211`、`3212` 端口。

说明：

- 这是简易启动器，不是单文件完全打包版
- `config/`、`.auth/`、`src/`、`ui/`、`node_modules/` 仍然要和项目放在一起
- 如果只想测试，不打开浏览器：

```powershell
dist\GymBooker.exe --no-browser
```

## 直接带参数运行

浏览器自动化示例：

```powershell
npm.cmd run book -- --date 2026-04-12 --time 19:00-20:00 --courts 6,7,8 --release-at "2026-04-09 08:59:58"
```

API 干跑示例：

```powershell
npm.cmd run book-api -- --date 2026-04-12 --time 19:00-20:00 --courts 6,7,8 --dry-run
```

快速扫描候补示例：

```powershell
npm.cmd run scan-api -- --date 2026-04-12 --time 19:00-20:00 --courts 6,7,8 --scan-loops 20 --scan-interval-ms 500
```

两个分离时段示例：

```powershell
npm.cmd run book-api -- --date 2026-04-12 --times 08:00-09:00,18:00-19:00 --courts 12,13,14,15,16,17,18,19,20 --dry-run
```

现在 UI 默认把每片场地视为“整点开始、持续 1 小时”的整点时段。  
你只需要选择开始时间，结束时间会自动推算。程序默认会把日期设置为“下周同一天”，并把开抢时间默认设为当天 `09:00`。

主要参数说明：

- `--date`：订场日期
- `--time`：单个时段，格式 `HH:mm-HH:mm`
- `--times`：多个分离时段，例如 `08:00-09:00,18:00-19:00`
- `--courts`：场地偏好顺序
- `--release-at`：开抢时间
- `--booking-url`：临时覆盖配置中的 `bookingPageUrl`
- `--dry-run`：只搜索并打印 payload，不真实下单
- `--scan-loops`：扫描轮数
- `--scan-interval-ms`：扫描间隔
- `--config`：指定配置文件
- `--instance`：指定多实例配置里的实例

## 关键配置项

当前项目主要围绕这些配置项工作：

- `bookingWindow.date`
- `bookingWindow.startTime`
- `bookingWindow.endTime`
- `bookingWindow.segments`
- `preferences.courtNumbers`
- `rules.blockedPrices`
- `rules.requiredCourtCount`
- `rules.allowSingleSlot`
- `campusAvailabilityRules`
- `optimization`
- `releaseAt`

一般情况下，订场链接固定放在配置文件里就可以，抢场目标通过 UI 或命令行临时调整。

## 快速切换策略

从 `2.1.5` 起，`book-api` 采用“先扫描、再候选切换”的策略：

- 一次 availability 扫描会生成多个合法候选组合
- 如果后端明确返回某个候选失败，会把该目标短时间加入失败冷却
- 程序可以立刻切换到同轮扫描得到的下一组候选，而不是傻等整轮重扫
- `submitTimeoutMs` 刻意保持较长，因为后端可能几十秒才返回
- `networkRetryCount` 默认是 `0`，避免一个请求未决时又发第二个
- 提交超时、HTTP 504、纯网络失败，都不视为明确成功或明确失败
- 像 `今天已经预订了1次，不能再预订` 这种明确日限额，会立刻停止实例
- 像 `球馆还没有上线` 这种提示，不会封死目标，只会继续轮询
- 如果后端只返回部分订单号，程序会记录为部分成功，不再误报成两片全中

`optimization` 下可调字段示例：

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

## 候补扫描

如果目标场地被抢走，可以用 `scan-api` 快速刷新同一天、同时段的剩余场地，及时观察候补机会。

扫描输出还会附带：

- `@price`：当前价格
- `[blocked]`：这个价格被禁抢，不会自动下单

## 9 点抢场规则

当前 API 抢场逻辑默认面向 9 点放场场景：

- 可以从 `08:59:00` 开始等待
- 到点后持续扫描和尝试
- 默认目标是一次下单尽量带两片场地
- 场地按照你的偏好顺序筛选

## 最后说明

如果后端本身还没放开订场，这个工具也不能在服务器未开放时凭空下单。  
它做的是尽可能减少前端拖动、点击、等待和页面卡顿带来的损失，把抢场速度尽量压到后端链路本身。
