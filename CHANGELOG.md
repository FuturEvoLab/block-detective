# 更新记录 / Changelog

版本号在 `server.py` 的 `VERSION`，设置页"服务"卡片里也能看到。扩展用 `REQUIRES_CORE` 声明需要的最低核心版本，核心过旧时不加载并在设置页说明。

## 1.5.1 — 2026-11-09

- 监控列表每行多了"编辑"：把该地址的名称、阈值、方向、代币名单、备注载入上方表单，改完点"加入监控"即更新。

## Pro 1.6–1.8 — 2026-11-09（扩展，核心未变）

- 反事实回测、阈值建议与一键应用、按概率调仓位、样本外累计收益曲线（同等资金折算）、分组诊断、漂移提醒、研究库读取缓存。方法见 METHODOLOGY.md §7b。

## 1.5.0 — 2026-11-09

- **巨鲸净流向**：巨鲸监控页新增卡片，汇总监控列表所有地址最近 24 小时 / 7 天的美元流入、流出、净流入和笔数（`/api/watchlist/flow`，后台统计、10 分钟缓存），并列出净流向最大的地址。持续的净流出 / 净流入比单笔大额更有信息量。

## Pro 1.5.0 — 2026-11-09（扩展，核心未变）

- 信号预测模型（逻辑回归 + 走前验证）、"最低上涨概率"过滤、凯利仓位建议。方法见 METHODOLOGY.md §7b。

## 1.4.0 — 2026-11-09

- **监控规则**：每个监控地址除了大额阈值，还可以限定方向（只看流入 / 只看流出）和代币名单（如 `USDT, ETH`，最多 20 个）。再次添加同一地址即更新规则。列表里显示非默认的规则。
- **Webhook 重试**：发送失败（网络问题、对方 5xx、429）30 秒后自动重试一次；4xx 不重试。设置页的状态里能看到重试次数。
- **资金路径追踪有了自动测试**：`tests/test_path.js` 用 `app.js` 里真正的边汇总函数 + `static/path.js`，覆盖瓶颈金额、时间顺序判断、排序规则、方向限制、6 跳上限、环路和反向查找；CI 一并运行。

## 1.3.0 — 2026-11-09

- **从 zip 恢复**：设置页"数据备份"卡片新增"从 zip 恢复"（`POST /api/backup/import`，请求体就是 zip）。只接受文件名合法的 `.json` / `.db`（忽略目录、路径和其他文件），JSON 要能解析、数据库要是 SQLite；`config.json` 按合并处理——zip 里没有的 API Key / Webhook 地址保留现有的。恢复前先把当前数据自动备份一份，恢复后自动重启服务并刷新页面。上限 200 MB。

## 1.2.0 — 2026-11-09

- **一键下载备份**：设置页"数据备份"卡片新增"下载备份 zip"（`/api/backup/export.zip`）：data/ 里的标签、监控、设置、排行榜、模拟账本和研究数据库打成一个 zip，不含缓存；API Key 和 Webhook 地址默认去掉（加 `?secrets=1` 才包含）。换电脑时解压到新机器的 data/ 即可。
- **风险评分有了自动测试**：`tests/test_risk.js` 在 Node 里加载 `static/risk.js`，覆盖直接 / 间接关联的传播与衰减、方向和金额权重、已知实体封顶、关键词风险源、行为特征、投毒提示和缓存；CI 一并运行。

## 1.1.0 — 2026-11-09

- **Webhook 通知**：巨鲸大额、聪明钱买入、测试通知（以及扩展发出的通知）除了 macOS 系统通知，还能推送到 Telegram / Discord / Slack 或任意 HTTPS 地址（收到 JSON `{title, text}`）。Windows 和 Linux 上这是第一种能收到提醒的方式。地址含密钥，按 API Key 的方式保存（支持 macOS 钥匙串）；只接受 https://（本机 127.0.0.1 允许 http://）。设置页可发测试通知、看最近发送状态。
- **版本与扩展兼容性**：新增 `/api/version`；设置页显示核心版本、Python 版本、已安装扩展和加载失败的扩展及原因。扩展可声明 `REQUIRES_CORE`。
- 设置页在用快捷键切换过去时也会加载服务和备份信息（以前只有鼠标点击才加载）。

## 1.0.0 — 2026-11-09

- 拆成开源核心 + 扩展：`ext/<名字>/__init__.py` 里的 `register(core, ext)` 启动时自动加载，可注册接口、钩子和界面页面。跟单机器人、历史回测、研究数据库、每天自动扩充钱包池移到单独授权的 Pro 扩展，核心仓库不再包含。
- 回测：跳空穿过止损价时按开盘价成交；K 线按"链 + 代币"存；研究数据补录改为二分查找。
- 接口对错误输入回 400（含 NaN / Infinity 防护），新增核心单元测试。

---

The version lives in `VERSION` in `server.py` and is shown on the Settings page. Extensions declare the minimum core version with `REQUIRES_CORE`; an extension that needs a newer core is skipped with the reason shown in Settings.

**1.4.0** — Watchlist rules (direction and token filters per address), one automatic webhook retry, Node tests for the path-tracing algorithm.

**1.3.0** — Restore from a backup zip (`POST /api/backup/import`): validated file names and contents, config merged so existing secrets survive, automatic safety backup first, then a service restart.

**1.2.0** — One-click backup download (`/api/backup/export.zip`, secrets stripped by default); the browser-side risk score now has a Node test suite run in CI.

**1.1.0** — Webhook notifications (Telegram / Discord / Slack / any HTTPS URL) in addition to macOS notifications, so Windows and Linux users get alerts too; `/api/version` and extension compatibility reporting; Settings loads on keyboard navigation as well.

**1.0.0** — Open core: extension loader; copy bot, backtests and research move to the separately licensed Pro extension. Backtest gap fills, per-chain candles, O(n log n) research backfill, 400s for bad API input, core unit tests.
