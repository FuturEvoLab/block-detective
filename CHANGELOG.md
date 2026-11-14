# Changelog

Times are Japan Standard Time (JST). The same notes appear in the app: click the version number in the top bar.

日本語・中文は各バージョンの折りたたみ欄 / 各版本下方可展开

## 1.5.0 — 2026-11-14 15:37 JST

**Web version: live Market and Price Analysis**

- On the web version (GitHub Pages), Market and Price Analysis are no longer recorded snapshots: the browser pulls live data straight from the free public APIs of Binance, CoinGecko, alternative.me and DefiLlama. No install, server or API key needed
- Any coin listed on Binance and every timeframe (1h / 4h / 1d / 1w) can be analyzed on the web; top movers, moves with BTC and the top-bar prices are live too
- Indicators and readings are computed in the browser exactly as in the local version, with a new automated test that runs both on the same data and compares the results
- Falls back to Binance's public market-data domain where the main domain is blocked, and to the recorded snapshot if live data can't be fetched
- Pages that need API keys or a background process (fund flow, whale watch, smart money, copy bot) still show sample data on the web; run it locally for the full features

<details><summary>日本語：Web 版：マーケットと値動き分析をリアルタイム化</summary>

- Web 版（GitHub Pages）の「マーケット」と「値動き分析」が記録済みのスナップショットではなくなりました。ブラウザが Binance・CoinGecko・alternative.me・DefiLlama の無料公開 API から直接リアルタイムのデータを取得するため、インストール・サーバー・API キーなしで使えます
- Web 版でも Binance 上場の任意の銘柄と 1h / 4h / 1d / 1w のすべての足を分析可能。騰落ランキング、BTC との連動性、上部の価格表示もリアルタイムです
- 指標と解説はローカル版とまったく同じ方法でブラウザ内で計算し、同じデータで両方の結果を照合する自動テストを追加しました
- Binance のメインドメインが使えない地域では公開マーケットデータ用ドメインに自動で切り替え、リアルタイムデータが取得できない場合は記録済みのスナップショットを表示します
- API キーや常駐処理が必要なページ（資金フロー、クジラ監視、スマートマネー、コピーボット）は Web 版ではサンプルデータのままです。すべての機能はローカルで実行してください

</details>
<details><summary>中文：网页版：市场监控和涨跌分析改为实时数据</summary>

- 网页版（GitHub Pages）的“市场监控”和“涨跌分析”不再是录好的快照：浏览器直接从 Binance、CoinGecko、alternative.me、DefiLlama 的免费公开接口取实时行情，打开网页即可使用，不需要安装、服务器或 API Key
- 网页版可以分析任意 Binance 上架的币种和 1h / 4h / 1d / 1w 全部周期，涨跌榜、与 BTC 的联动、顶部报价也都是实时的
- 指标和解读规则在浏览器里按与本地版完全相同的方法计算，并新增自动测试，用同一份数据对照两边结果
- Binance 主域名无法访问的地区自动改用公开行情域名；实时数据取不到时退回录好的快照
- 需要 API Key 或后台常驻的页面（资金流向、巨鲸监控、聪明钱、跟单机器人）在网页版仍是示例数据，完整功能请在本地运行

</details>

## 1.4.0 — 2026-11-14 15:25 JST

**New Price Analysis page**

- New Price Analysis page (shortcut 4): candlestick chart for any coin listed on Binance (1h / 4h / 1d / 1w) with MA 20 / 50 / 200, Bollinger Bands, volume, RSI and MACD; hover to read each candle
- Auto-generated technical read: MA order and golden / death crosses, RSI overbought / oversold, MACD momentum, position in the bands, ATR volatility, volume vs. average
- Price vs. open interest: reads price, futures OI, funding and the long/short ratio together, e.g. “price up, OI up: new longs are opening”
- Top movers: top 10 gainers and losers among the top 250 coins, the most actively traded coins and market breadth (stablecoins, wrapped tokens and tokenized stocks excluded)
- Moves with BTC: 30 / 90-day correlation, beta, strength relative to BTC and annualized volatility for major coins
- New update notes: click the version number in the top bar; a red dot appears when there is a new release
- Page shortcuts are now 1–9; when CoinGecko's free API rate-limits, the request is retried once and a clear message is shown
- 14 new automated tests for the indicators and readings

<details><summary>日本語：「値動き分析」ページを追加</summary>

- 新ページ「値動き分析」（ショートカット 4）：Binance 上場銘柄のローソク足（1h / 4h / 1d / 1w）に MA20 / 50 / 200、ボリンジャーバンド、出来高、RSI、MACD を表示。カーソルを合わせると各足の数値を確認できます
- テクニカル解説を自動生成：移動平均線の並びとゴールデン / デッドクロス、RSI の買われすぎ・売られすぎ、MACD の勢い、バンド内の位置、ATR ボラティリティ、出来高の増減
- 価格と先物建玉：価格、建玉、資金調達率、ロング / ショート比をまとめて解説（例：「価格上昇・建玉増加：新規ロングが流入」）
- 騰落ランキング：時価総額上位 250 銘柄の値上がり / 値下がり上位 10、売買が最も活発な銘柄、市場の広がり（ステーブルコイン、ラップド系、トークン化株式は除外）
- BTC との連動性：主要銘柄の 30 / 90 日相関係数、ベータ、対 BTC の強弱、年率ボラティリティ
- 「更新のお知らせ」を追加：上部バーのバージョン番号をクリックで表示し、新しい更新があると赤い点が付きます
- ページのショートカットを 1〜9 に変更。CoinGecko 無料 API の制限時は 1 回自動で再試行し、案内を表示
- 指標計算と解説の自動テストを 14 件追加

</details>
<details><summary>中文：新增“涨跌分析”页面</summary>

- 新页面“涨跌分析”（快捷键 4）：任意 Binance 上架币种的 K 线图（1h / 4h / 1d / 1w），叠加 MA20 / 50 / 200、布林带、成交额、RSI 和 MACD，鼠标悬停可看每根 K 线的数值
- 技术面自动解读：均线排列和金叉 / 死叉、RSI 超买超卖、MACD 动能、布林带位置、ATR 波动率、放量 / 缩量
- 价格与合约持仓：把价格涨跌、合约持仓量、资金费率和多空账户比放在一起解读，例如“价涨仓增：新多单进场”
- 涨跌榜：市值前 250 的涨幅 / 跌幅前 10、成交最活跃的币和市场宽度（已排除稳定币、包装币和代币化股票）
- 与 BTC 的联动：主流币 30 / 90 日相关系数、Beta、相对 BTC 的强弱和年化波动率
- 新增“更新公告”：点击顶部栏的版本号查看，有新版本时显示红点
- 页面快捷键改为 1–9；CoinGecko 免费接口限流时自动重试一次并给出提示
- 新增 14 项指标计算与解读的自动测试

</details>

## 1.3.1 — 2026-11-03 23:14 JST

**Tests and release workflow**

- Copy-bot tests now use real assertions; any failing check fails the run
- GitHub Actions runs the tests on every push on Ubuntu (Python 3.9 / 3.12) and macOS
- Backtest cost docs match the code: fixed slippage, both sides charged at Ethereum's current gas price, no price impact
- Third-party notices added (fonts under OFL 1.1, Cytoscape.js under MIT); the macOS launchers can be double-clicked right after download

<details><summary>日本語：テストとリリース手順</summary>

- コピーボットのテストを実際のアサーションに変更し、1 件でも失敗するとエラーになるように
- GitHub Actions を導入：push のたびに Ubuntu（Python 3.9 / 3.12）と macOS でテストを実行
- バックテストのコスト説明をコードと統一：固定スリッページ、イーサリアムの現在のガス代で売買 2 回分を計上、価格インパクトは含まない
- サードパーティのライセンス表記を追加（フォント OFL 1.1、Cytoscape.js MIT）。macOS の起動ファイルはダウンロード後すぐダブルクリックで実行可能に

</details>
<details><summary>中文：测试与发布流程</summary>

- 跟单机器人的测试改为真正的断言，任何一项不通过都会报错
- 接入 GitHub Actions：每次推送自动在 Ubuntu（Python 3.9 / 3.12）和 macOS 上运行测试
- 回测成本说明与代码统一：固定滑点，按以太坊当前 Gas 估算买卖两笔，不计价格冲击
- 补充第三方许可证说明（字体 OFL 1.1、Cytoscape.js MIT）；macOS 启动脚本下载后可直接双击

</details>

## 1.3.0 — 2026-11-02 21:39 JST

**Open-source release**

- Released under AGPL-3.0 with English / Japanese / Chinese READMEs, a methodology document and a security policy
- Online demo on GitHub Pages: browse a sample case without installing anything
- API keys can optionally be stored in the macOS Keychain
- Preset labels and wording made neutral; the sample case is now the Ethereum Foundation's public wallet
- Scripts to install and remove auto-start at login
- Fixed: the Market page stayed empty when opened from another page

<details><summary>日本語：オープンソースとして公開</summary>

- AGPL-3.0 で公開。英語 / 日本語 / 中国語の README、分析手法、セキュリティの文書を用意
- GitHub Pages のオンラインデモ：インストール不要でサンプル事例を閲覧可能
- API キーを macOS キーチェーンに保存できるように（任意）
- プリセットのラベルと説明文を中立的な表現に変更し、サンプル事例をイーサリアム財団の公開ウォレットに
- 自動起動の設定 / 解除スクリプト
- 修正：他のページから移動したときにマーケット画面が表示されない問題

</details>
<details><summary>中文：开源发布</summary>

- 以 AGPL-3.0 开源，提供英文 / 日文 / 中文说明、分析方法和安全说明文档
- GitHub Pages 在线演示版：无需安装即可浏览示例案例
- API Key 可以选择存入 macOS 钥匙串
- 预置标签和说明改为中性描述，示例案例改为以太坊基金会的公开钱包
- 开机自启的安装 / 取消脚本
- 修复：从其他页面跳转时市场监控页不显示数据

</details>

## 1.2.0 — 2026-10-31 21:04 JST

**Security hardening and wallet sources**

- XSS protection, Content Security Policy, CSV formula-injection protection, link encoding and request size limits
- Smart money: bulk import of wallets from leaderboards; Optimism support
- Double-click launcher on Windows; one-click service restart from Settings
- Fixed: the path-tracing panel did not respond to clicks

<details><summary>日本語：セキュリティ強化とウォレットの取り込み</summary>

- XSS 対策、コンテンツセキュリティポリシー（CSP）、CSV 数式インジェクション対策、リンクのエンコード、リクエストサイズの上限
- スマートマネー：ランキングからウォレットを一括取り込み。Optimism に対応
- Windows でもダブルクリックで起動。設定画面からワンクリックで再起動
- 修正：資金経路パネルがクリックに反応しない問題

</details>
<details><summary>中文：安全加固与钱包来源</summary>

- 防 XSS、内容安全策略（CSP）、CSV 公式注入防护、链接编码、请求大小限制
- 聪明钱：从排行榜批量导入钱包；新增 Optimism
- Windows 双击启动；设置页一键重启服务
- 修复：资金路径面板点击无效

</details>

## 1.0.0 — 2026-10-31 20:00 JST

**First release**

- Fund-flow graph, risk score, path tracing, whale watch with background alerts
- Market page, smart-money analysis, simulated copy bot, research data and backtests
- Entity labels, external tools, and a Japanese / Chinese / English UI

<details><summary>日本語：最初のバージョン</summary>

- 資金フロー図、リスクスコア、資金経路の追跡、クジラ監視とバックグラウンド通知
- マーケット、スマートマネー分析、模擬コピーボット、研究データとバックテスト
- ラベル DB、外部ツール集、日本語 / 中国語 / 英語の 3 言語 UI

</details>
<details><summary>中文：首个版本</summary>

- 资金流向图、风险评分、资金路径追踪、巨鲸监控与后台提醒
- 市场监控、聪明钱分析、模拟跟单机器人、研究数据与回测
- 标签库、工具导航，日文 / 中文 / 英文三种界面语言

</details>
