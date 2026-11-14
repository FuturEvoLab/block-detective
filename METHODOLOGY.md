# Methodology

How ChainLoupe turns public on-chain data into scores. Everything below is a heuristic estimate built only from the data the tool has loaded (usually each address's most recent ~1,000 transfers). Treat every number as a lead to investigate, not a verdict and not investment advice.

## 1. Fund flow graph

- Transfers come from Etherscan V2 (EVM), Blockscout (Optimism), TronGrid (TRON) and mempool.space (Bitcoin).
- USD values use **current** prices (CoinGecko). Only native coins and a short allow-list of trusted token contracts (`KNOWN_TOKENS` in `server.py`) are priced. Unknown tokens are marked "unverified" and hidden by default, which filters out address-poisoning spam such as fake USDT.
- Bitcoin is UTXO-based. With several inputs, value is attributed to senders in proportion to what each input contributed; change returning to the sender is not counted as an outflow.

## 2. Address risk score (0–100)

**Sources.** Labels in the categories hacker (100), mixer (90), suspect (85) and risk (75) are risk sources. A label whose name or note mentions sanctions, theft, phishing, scams or laundering counts as 80.

**Propagation (up to 3 rounds).** For each address, the score inherited from a counterparty is:

```
counterparty score × hop × direction × share factor × amount factor
hop          = 1 if the counterparty is itself a labeled source, 0.5 if it only inherited risk
direction    = 1 when receiving from it, 0.7 when sending to it
share factor = 0.4 + 0.6 × min(1, 4 × share of this address's volume)
amount       = 0.25 + 0.75 × min(1, log10(1 + USD) / 4)     (≈ full weight at $10k; dust counts little)
```

The address keeps the highest of its own base score and any inherited score.

**Known entities.** Exchanges, institutions, market makers and contracts do not pass risk on (hackers routinely deposit to exchanges), and their own score is capped at 30.

**Behaviour (expanded addresses only).** +12 if inflow and outflow are both above $10k and within 10% of each other (pass-through); +10 if it fans out to 20+ addresses with few inflows (splitting); +10 if it is under 30 days old with more than $100k of flow.

**Levels.** High ≥ 75, medium ≥ 40, low ≥ 15.

## 3. Smart-money analysis (EVM)

**Rebuilding trades.** Within one transaction, paying a quote asset (the native coin, WETH or a major stablecoin) and receiving another token is a **buy**; the reverse is a **sell**. Token-to-token swaps cannot be priced and are skipped. Other stablecoins (crvUSD, USDe and similar) are not treated as trades. Quote assets are valued at that day's price.

**Profit and loss.** Average-cost accounting per token. Realized P&L applies only to the quantity that was actually bought. Remaining holdings are valued at the DexScreener price. The win rate is the share of **sold** tokens with positive realized P&L.

**Score.**

```
40 × win rate × min(1, sold tokens / 3)
+ 25 × min(1, ROI / 100%)
+ 20 × min(1, log10(realized USD) / 6)
+ 15 × min(1, sold tokens / 20)
→ halved if overall P&L is negative
```

Grades: S ≥ 80, A ≥ 65, B ≥ 50, C ≥ 35, D below.

**"Smart money" requires all of the following:** score ≥ 65, at least 5 sold tokens, not a likely bot, a median buy of at least $100, and at least $2,000 invested. High win rates on $5 trades are mostly noise, so trade size matters.

## 4. Bot detection

Each signal adds one point; **two or more points means "likely bot"**:

1. The address is a contract (multisig wallets are contracts too, so this signal alone is never enough).
2. The median hold of closed positions is under 10 minutes.
3. 40 or more trades per active day (with at least 20 trades).
4. 40% or more of trades happen in bursts of 3+ within the same minute.
5. 30 or more tokens traded with an average hold under 1 hour.
6. 20 or more buys with a median size under $20 (airdrop farming or sniping scripts).

## 5. Copy-trading simulator

The bot only keeps a ledger: no private keys and no real orders.

- **Entry.** The DEX price when the signal is detected × (1 + base slippage + price impact). Price impact ≈ 2 × size ÷ pool liquidity, capped at 50%.
- **Costs.** Gas is charged on both sides (an Ethereum swap ≈ 180k gas at the current gas price; L2s cost a few cents). Unrealized P&L is computed as if the position were sold now.
- **Skipped signals.** Signals are skipped if they are older than 60 minutes; the open-position limit (20) is reached; the wallet is a likely bot; there is no DEX price; liquidity is below the minimum; the price is already more than 30% above the smart wallet's own fill (chasing) or more than 50% below it (abnormal); the token had only buys and no sells in 24 hours; or GoPlus flags it (honeypot, tax above 10%, owner can change balances or taxes, hidden owner, trading cooldown).
- **Exits.**
  - The smart wallet has sold at least 50% of what it bought (smaller trims are only noted).
  - Stop loss, take profit or maximum hold is hit.
  - Liquidity falls below $5k.
  - There has been no price for 6 hours, which is treated as a rug and closed at −100%.
- **Signal detection.** Each check re-scans the previous 30 minutes and de-duplicates by transaction, because Etherscan indexes internal transactions late. The checkpoint does not advance if internal transactions failed to load.

These rules are covered by `tests/test_copybot.py`.

**Known optimism.** Fills use the current price plus a fixed slippage model. There is no MEV, failed transactions or sandwiching. Real trading would very likely do worse.

## 6. Research dataset

Every buy or sell signal from a tracked wallet is stored in `data/research.db`, whether or not the bot copied it. Each signal records:

- **Wallet features:** grade, score, win rate, ROI, number of trades, average hold, bot points.
- **Token features:** liquidity, FDV, age, price change over 5 minutes / 1 hour / 6 hours / 24 hours, 24-hour volume, buy share.
- **Signal features:** size, whether it is a first buy, detection delay, UTC hour and weekday, and how many smart wallets bought the same token in the last 24 hours.
- **Market:** the Fear & Greed index.

Outcomes are recorded at 1 hour, 6 hours, 24 hours, 3 days and 7 days, using the first check after each mark, so timings are approximate. Maximum and minimum prices over the 7 days are also kept.

The factor tables group 24-hour outcomes by feature buckets. **Groups with fewer than 30 samples are not reliable.**

## 7. Backtest and parameter search

- **Replay.** The tracked wallets' buys of $100 or more over the last 45 days are replayed on hourly GeckoTerminal candles. Entry is at the open of the first candle 15 minutes after the signal. If a candle touches both the stop loss and the take profit, the stop loss is assumed (the conservative choice).
- **Backtest costs (simplified).** Fills use the fixed base slippage from Settings; price impact is not modelled. Gas is charged for a buy and a sell (≈ 180k gas each) at Ethereum's **current** gas price, converted to a percentage of the per-trade size and subtracted from each trade's return. Historical gas prices are not used, so results for wallets on L2s are on the conservative side. The live simulator is more detailed (price impact, per-chain gas).
- **Grid search.** 640 combinations are tested: minimum signal × stop loss × take profit × maximum hold × follow sells. Results are ranked by total return.
- **Biases.** Wallets are graded with today's data (selection bias), and parameters are chosen on the same data (overfitting). Validate any choice with live simulation before trusting it.

## 8. Market page

- **Fear & Greed:** alternative.me.
- **Market overview and major coins:** CoinGecko.
- **Funding rate, open interest and long/short ratio:** Binance USDT-margined perpetuals.
- **Stablecoin supply:** DefiLlama.

The "market read" notes are rule-based descriptions of these numbers, not forecasts.

## 9. Price analysis

- **Data.** Candles come from Binance spot (`/api/v3/klines`, 300 candles, quote volume in USDT); the chart shows the latest 160, and indicators use all 300 so the 200-period average is valid. Open interest, funding and the long/short account ratio come from Binance USDT-margined futures. Rankings use CoinGecko's top 250 by market cap.
- **Indicators.** Simple moving averages 20 / 50 / 200. RSI(14) with Wilder smoothing. MACD = EMA 12 − EMA 26, signal = EMA 9 of MACD (each EMA is seeded with the simple average of its first n values). Bollinger Bands = SMA 20 ± 2 population standard deviations. ATR(14) with Wilder smoothing, shown as a percentage of price.
- **Technical read (rules).**
  - Trend: price > MA50 > MA200 is bullish order; price < MA50 < MA200 is bearish order; anything else is "no clear trend". A golden / death cross is reported if MA50 crossed MA200 within the last 10 candles.
  - RSI ≥ 70 overbought, ≤ 30 oversold; 55 / 45 split "firm", "neutral" and "soft" momentum.
  - MACD: a cross of the signal line within the last 3 candles is reported; otherwise the side of zero and whether the histogram is growing or shrinking.
  - Bollinger: close above the upper or below the lower band; "narrowed sharply" when the band width is in the lowest 10% of the last 120 candles.
  - Volume: the last *closed* candle's volume against the average of the 20 before it (≥ 1.8× high, ≤ 0.6× low). The candle still in progress is excluded because its volume is incomplete.
- **Price vs. open interest.** Over a window that follows the timeframe (1h → 24 h, 4h → 3 days, 1d → 7 days, 1w → 28 days): price change ≥ +1% / ≤ −1% and OI change ≥ +3% / ≤ −3% give the four quadrants (new longs, short covering, new shorts, long liquidation); otherwise "flat". Funding above 0.03% per 8 h is "crowded longs"; negative funding while price rises is flagged as a possible short squeeze.
- **Top movers.** Stablecoins, wrapped / staked tokens and tokenized real-world assets (stocks, treasury / money-market funds, gold) are excluded by symbol list and name. Breadth counts coins up or down more than 0.5% in 24 h. Turnover = 24 h volume ÷ market cap.
- **Correlation with BTC.** Up to 14 of the largest remaining coins that trade against USDT on Binance. Daily simple returns over the last 90 days, aligned by date with BTC. Correlation is Pearson's r on returns (30 and 90 days); beta = cov(coin, BTC) ÷ var(BTC) over 30 days; "vs BTC" is the coin's percentage change minus BTC's; volatility is the 30-day standard deviation of daily returns × √365.
- These are descriptions of the current numbers, not forecasts or investment advice.
