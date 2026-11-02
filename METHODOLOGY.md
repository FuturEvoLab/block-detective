# Methodology

How Block Detective turns public on-chain data into scores. Everything below is a heuristic estimate built only from the data the tool has loaded (usually each address's most recent ~1,000 transfers). Treat every number as a lead to investigate, not a verdict and not investment advice.

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

- **Replay.** The tracked wallets' buys of $100 or more over the last 45 days are replayed on hourly GeckoTerminal candles. Entry is at the open of the first candle 15 minutes after the signal. If a candle touches both the stop loss and the take profit, the stop loss is assumed (the conservative choice). Gas is deducted.
- **Grid search.** 640 combinations are tested: minimum signal × stop loss × take profit × maximum hold × follow sells. Results are ranked by total return.
- **Biases.** Wallets are graded with today's data (selection bias), and parameters are chosen on the same data (overfitting). Validate any choice with live simulation before trusting it.

## 8. Market page

- **Fear & Greed:** alternative.me.
- **Market overview and major coins:** CoinGecko.
- **Funding rate, open interest and long/short ratio:** Binance USDT-margined perpetuals.
- **Stablecoin supply:** DefiLlama.

The "market read" notes are rule-based descriptions of these numbers, not forecasts.
