# 更新记录 / Changelog

版本号在 `server.py` 的 `VERSION`，设置页"服务"卡片里也能看到。扩展用 `REQUIRES_CORE` 声明需要的最低核心版本，核心过旧时不加载并在设置页说明。

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

**1.1.0** — Webhook notifications (Telegram / Discord / Slack / any HTTPS URL) in addition to macOS notifications, so Windows and Linux users get alerts too; `/api/version` and extension compatibility reporting; Settings loads on keyboard navigation as well.

**1.0.0** — Open core: extension loader; copy bot, backtests and research move to the separately licensed Pro extension. Backtest gap fills, per-chain candles, O(n log n) research backfill, 400s for bad API input, core unit tests.
