// 区块侦探 — 网页版（GitHub Pages）的实时行情：浏览器直接调用 Binance / CoinGecko / alternative.me / DefiLlama 的免费公开接口，
// 在本地算出和 server.py 相同的结果（市场监控、涨跌分析、顶部报价）。不需要服务器，也不需要 API Key。
// 指标和解读规则是 server.py 里同名函数的移植，两边的结果由 tests/test_live_parity.py 对照检查，改一边时请同步另一边。
(function (root) {
  // ---------------------------------------------------------------- 取数：内存 + sessionStorage 缓存，减少免费接口的调用次数
  const mem = new Map();
  class ApiError extends Error {}

  async function getJson(url, ttl = 120) {
    const now = Date.now() / 1000;
    const hit = mem.get(url) || (() => { try { return JSON.parse(sessionStorage.getItem("bd-live|" + url)); } catch { return null; } })();
    if (hit && now - hit.t < ttl) return hit.d;
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      throw new ApiError(`网络错误: ${e.message}`);
    }
    if (!res.ok) throw new ApiError(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const d = await res.json();
    const rec = { t: now, d };
    mem.set(url, rec);
    try { sessionStorage.setItem("bd-live|" + url, JSON.stringify(rec)); } catch {} // 太大存不下就只留内存
    return d;
  }

  // Binance 主域名在部分地区不可用（例如美国返回 451），现货行情改用公开的 data-api.binance.vision
  let spotBase = "https://api.binance.com";
  async function spot(path, ttl) {
    try {
      return await getJson(spotBase + path, ttl);
    } catch (e) {
      if (spotBase !== "https://data-api.binance.vision" && !/HTTP 400/.test(e.message)) {
        spotBase = "https://data-api.binance.vision";
        return getJson(spotBase + path, ttl);
      }
      throw e;
    }
  }
  const FAPI = "https://fapi.binance.com";
  const CG = "https://api.coingecko.com/api/v3";

  // ---------------------------------------------------------------- 指标（与 server.py 一致）
  function sma(xs, n) {
    const out = []; let s = 0;
    xs.forEach((x, i) => { s += x; if (i >= n) s -= xs[i - n]; out.push(i >= n - 1 ? s / n : null); });
    return out;
  }
  function ema(xs, n) {
    const out = [], k = 2 / (n + 1), seed = []; let e = null;
    for (const x of xs) {
      if (x == null) out.push(null);
      else if (e == null) { seed.push(x); if (seed.length === n) e = seed.reduce((a, b) => a + b, 0) / n; out.push(e); }
      else { e = x * k + e * (1 - k); out.push(e); }
    }
    return out;
  }
  function rsi(closes, n = 14) {
    const out = closes.map(() => null);
    if (closes.length <= n) return out;
    const d = closes.slice(1).map((c, i) => c - closes[i]);
    let ag = d.slice(0, n).reduce((a, x) => a + Math.max(x, 0), 0) / n;
    let al = d.slice(0, n).reduce((a, x) => a + Math.max(-x, 0), 0) / n;
    const val = () => (ag === 0 && al === 0 ? 50 : al === 0 ? 100 : 100 - 100 / (1 + ag / al));
    out[n] = val();
    for (let i = n; i < d.length; i++) {
      ag = (ag * (n - 1) + Math.max(d[i], 0)) / n;
      al = (al * (n - 1) + Math.max(-d[i], 0)) / n;
      out[i + 1] = val();
    }
    return out;
  }
  function macd(closes, fast = 12, slow = 26, sig = 9) {
    const f = ema(closes, fast), s = ema(closes, slow);
    const line = f.map((a, i) => (a != null && s[i] != null ? a - s[i] : null));
    const signal = ema(line, sig);
    const hist = line.map((a, i) => (a != null && signal[i] != null ? a - signal[i] : null));
    return [line, signal, hist];
  }
  function bollinger(closes, n = 20, k = 2) {
    const mid = sma(closes, n), up = [], lo = [];
    mid.forEach((m, i) => {
      if (m == null) { up.push(null); lo.push(null); return; }
      const w = closes.slice(i - n + 1, i + 1);
      const sd = Math.sqrt(w.reduce((a, x) => a + (x - m) ** 2, 0) / n);
      up.push(m + k * sd); lo.push(m - k * sd);
    });
    return [mid, up, lo];
  }
  function atr(highs, lows, closes, n = 14) {
    const tr = [highs[0] - lows[0]];
    for (let i = 1; i < closes.length; i++) tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
    const out = closes.map(() => null);
    if (tr.length <= n) return out;
    let a = tr.slice(1, n + 1).reduce((x, y) => x + y, 0) / n;
    out[n] = a;
    for (let i = n + 1; i < tr.length; i++) { a = (a * (n - 1) + tr[i]) / n; out[i] = a; }
    return out;
  }
  const pctReturns = (c) => c.slice(1).map((x, i) => [x, c[i]]).filter(([, p]) => p).map(([x, p]) => x / p - 1);
  function corr(a, b) {
    const n = Math.min(a.length, b.length);
    if (n < 3) return null;
    a = a.slice(-n); b = b.slice(-n);
    const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
    let cov = 0, va = 0, vb = 0;
    for (let i = 0; i < n; i++) { cov += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; }
    return va && vb ? cov / Math.sqrt(va * vb) : null;
  }
  function beta(a, b) {
    const n = Math.min(a.length, b.length);
    if (n < 3) return null;
    a = a.slice(-n); b = b.slice(-n);
    const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
    let cov = 0, vb = 0;
    for (let i = 0; i < n; i++) { cov += (a[i] - ma) * (b[i] - mb); vb += (b[i] - mb) ** 2; }
    return vb ? cov / vb : null;
  }
  const last = (xs, back = 0) => { const v = xs.filter((x) => x != null); return v.length > back ? v[v.length - 1 - back] : null; };
  function crossed(a, b, bars) {
    for (let i = a.length - 1; i > Math.max(a.length - 1 - bars, 0); i--) {
      if ([a[i], b[i], a[i - 1], b[i - 1]].some((x) => x == null)) break;
      if (a[i - 1] <= b[i - 1] && a[i] > b[i]) return 1;
      if (a[i - 1] >= b[i - 1] && a[i] < b[i]) return -1;
    }
    return 0;
  }
  const f1 = (v) => v.toFixed(1), signed = (v, d) => (v >= 0 ? "+" : "") + v.toFixed(d);
  // Python 的 f"{v:+.4g}"：4 位有效数字，指数 < -4 或 >= 4 时用科学计数法，去掉末尾的 0
  const g4 = (v) => {
    const e = v === 0 ? 0 : Math.floor(Math.log10(Math.abs(Number(v.toPrecision(4)))));
    const s = e < -4 || e >= 4 ? v.toExponential(3).replace(/\.?0+e/, "e").replace(/e([+-])(\d)$/, "e$10$2") : String(Number(v.toPrecision(4)));
    return v >= 0 ? "+" + s : s;
  };

  // ---------------------------------------------------------------- 解读（与 server.py 的 ta_read / deriv_read 一致）
  function taRead(c, ind) {
    const out = [], add = (tone, title, value, text) => out.push({ tone, title, value, text });
    const close = c[c.length - 1][4], m50 = last(ind.ma50), m200 = last(ind.ma200);
    if (m50 && m200) {
      if (close > m50 && m50 > m200) add("bull", "均线趋势", "MA50 > MA200", "价格在 50 / 200 均线之上，多头排列");
      else if (close < m50 && m50 < m200) add("bear", "均线趋势", "MA50 < MA200", "价格在 50 / 200 均线之下，空头排列");
      else add("flat", "均线趋势", `${signed((close / m200 - 1) * 100, 1)}% vs MA200`, "价格与均线交织，趋势不明确");
      const x = crossed(ind.ma50, ind.ma200, 10);
      if (x) add(x > 0 ? "bull" : "bear", "均线交叉", "MA50 × MA200", x > 0 ? "近期出现黄金交叉（50 均线上穿 200 均线）" : "近期出现死亡交叉（50 均线下穿 200 均线）");
    }
    const r = last(ind.rsi);
    if (r != null) {
      if (r >= 70) add("flat", "RSI(14)", f1(r), "RSI 在 70 以上，处于超买区");
      else if (r <= 30) add("flat", "RSI(14)", f1(r), "RSI 在 30 以下，处于超卖区");
      else add(r >= 55 ? "bull" : r <= 45 ? "bear" : "flat", "RSI(14)", f1(r), r >= 55 ? "动能偏强" : r <= 45 ? "动能偏弱" : "动能中性");
    }
    const h = last(ind.hist), h1 = last(ind.hist, 1);
    if (h != null && h1 != null) {
      const x = crossed(ind.macd, ind.signal, 3);
      if (x) add(x > 0 ? "bull" : "bear", "MACD", g4(h), x > 0 ? "MACD 刚刚金叉，短期动能转强" : "MACD 刚刚死叉，短期动能转弱");
      else {
        const above = last(ind.macd) > 0, grow = Math.abs(h) > Math.abs(h1);
        add(h > 0 ? "bull" : "bear", "MACD", g4(h), (above ? "MACD 在零轴上方" : "MACD 在零轴下方") + "，" +
          (grow ? (h > 0 ? "多头动能增强" : "空头动能增强") : (h > 0 ? "多头动能减弱" : "空头动能减弱")));
      }
    }
    const up = last(ind.bb_up), lo = last(ind.bb_lo), mid = last(ind.bb_mid);
    if (up && lo && mid) {
      const widths = ind.bb_up.map((u, i) => [u, ind.bb_lo[i], ind.bb_mid[i]]).filter(([u, l, m]) => u && l && m).map(([u, l, m]) => (u - l) / m).slice(-120);
      const w = (up - lo) / mid, ws = `${(w * 100).toFixed(1)}%`;
      if (close > up) add("bull", "布林带", ws, "价格突破布林带上轨");
      else if (close < lo) add("bear", "布林带", ws, "价格跌破布林带下轨");
      else if (widths.length >= 40 && w <= widths.slice().sort((a, b) => a - b)[Math.floor(widths.length / 10)]) add("flat", "布林带", ws, "布林带明显收窄，波动率处于近期低位");
      else add("flat", "布林带", ws, close > mid ? "价格在布林带中轨上方运行" : "价格在布林带中轨下方运行");
    }
    const a = last(ind.atr);
    if (a) add("flat", "波动率 ATR(14)", `${(a / close * 100).toFixed(2)}%`, "每根 K 线平均波动幅度（占价格的比例）");
    const vols = c.map((x) => x[5]);
    if (vols.length > 22) { // 最后一根 K 线还没走完，量价用最近一根已收盘的 K 线比
      const avg = vols.slice(-22, -2).reduce((x, y) => x + y, 0) / 20;
      const vr = avg ? vols[vols.length - 2] / avg : null;
      if (vr != null) {
        const rising = c[c.length - 2][4] >= c[c.length - 3][4], v = `${f1(vr)}×`;
        if (vr >= 1.8) add(rising ? "bull" : "bear", "量价", v, rising ? "放量上涨：成交量明显高于均量，上涨有成交配合" : "放量下跌：成交量明显高于均量，抛压较重");
        else if (vr <= 0.6) add("flat", "量价", v, rising ? "缩量上涨：成交量低于均量，上涨缺少成交配合" : "缩量下跌：成交量低于均量，抛压不重");
        else add("flat", "量价", v, "成交量接近均量");
      }
    }
    return out;
  }

  function derivRead(priceChg, oiChg, funding, longRatio) {
    const out = [], add = (tone, title, value, text) => out.push({ tone, title, value, text });
    if (priceChg != null && oiChg != null) {
      const pu = priceChg >= 1, pd = priceChg <= -1, ou = oiChg >= 3, od = oiChg <= -3;
      const v = `${signed(priceChg, 1)}% / OI ${signed(oiChg, 1)}%`, T = "价格 × 持仓";
      if (pu && ou) add("bull", T, v, "价涨仓增：新多单进场，上涨由新增杠杆推动");
      else if (pu && od) add("flat", T, v, "价涨仓减：主要是空头平仓（回补）推动的上涨");
      else if (pd && ou) add("bear", T, v, "价跌仓增：新空单进场，下跌由新增杠杆推动");
      else if (pd && od) add("flat", T, v, "价跌仓减：多头平仓、杠杆在出清");
      else if (ou) add("flat", T, v, "价格横盘但持仓增加，多空在积累仓位");
      else if (od) add("flat", T, v, "价格横盘且持仓减少，市场在降杠杆");
      else add("flat", T, v, "价格和持仓变化都不大");
    }
    if (funding != null) {
      const fr = funding * 100, v = `${fr.toFixed(4)}%`;
      if (fr > 0.03) add("flat", "资金费率", v, "资金费率偏高，多头拥挤");
      else if (fr < 0) {
        const rising = (priceChg || 0) >= 1;
        add(rising ? "bull" : "bear", "资金费率", v, rising ? "价格上涨但资金费率为负，空头可能被挤压" : "资金费率为负，空头占优");
      } else add("flat", "资金费率", v, "资金费率处于常规水平");
    }
    if (longRatio != null) {
      add("flat", "多空账户", `${(longRatio * 100).toFixed(0)}% / ${((1 - longRatio) * 100).toFixed(0)}%`,
        longRatio >= 0.65 ? "多数账户做多，散户偏多" : longRatio <= 0.4 ? "多数账户做空，散户偏空" : "多空账户分布均衡");
    }
    return out;
  }

  // ---------------------------------------------------------------- 接口（返回结构与 server.py 相同）
  const TA_TF = { "1h": ["1h", 24, "24h"], "4h": ["4h", 18, "3d"], "1d": ["1d", 7, "7d"], "1w": ["1d", 28, "28d"] };
  const TA_SHOW = 160;

  async function klines(sym, interval, limit = 300) {
    let d;
    try {
      d = await spot(`/api/v3/klines?symbol=${sym}USDT&interval=${interval}&limit=${limit}`, interval === "1h" ? 60 : 300);
    } catch (e) {
      if (/HTTP 400/.test(e.message)) throw new ApiError(`Binance 现货没有 ${sym}/USDT 交易对`);
      throw e;
    }
    return d.map((x) => [Math.floor(x[0] / 1000), +x[1], +x[2], +x[3], +x[4], +x[7]]);
  }

  async function taDeriv(sym, tf, closes) {
    const [period, n, label] = TA_TF[tf];
    const [oi, fund, ls] = await Promise.all([
      getJson(`${FAPI}/futures/data/openInterestHist?symbol=${sym}USDT&period=${period}&limit=${Math.min(n + 1, 30)}`, 300),
      getJson(`${FAPI}/fapi/v1/fundingRate?symbol=${sym}USDT&limit=30`, 600),
      getJson(`${FAPI}/futures/data/globalLongShortAccountRatio?symbol=${sym}USDT&period=${period}&limit=1`, 300),
    ]);
    if (!oi?.length) return null;
    const series = oi.map((x) => ({ ts: Math.floor(x.timestamp / 1000), v: +x.sumOpenInterestValue }));
    const oiChg = series[0].v ? (series[series.length - 1].v / series[0].v - 1) * 100 : null;
    const back = tf !== "1w" ? n : 4;
    const priceChg = closes.length > back ? (closes[closes.length - 1] / closes[closes.length - 1 - back] - 1) * 100 : null;
    const funding = fund?.length ? +fund[fund.length - 1].fundingRate : null;
    const lr = ls?.length ? +ls[0].longAccount : null;
    return { window: label, price_chg: priceChg, oi: series[series.length - 1].v, oi_chg: oiChg, oi_series: series, funding,
      funding_series: (fund || []).map((x) => ({ ts: Math.floor(x.fundingTime / 1000), v: +x.fundingRate })), long_ratio: lr,
      readings: derivRead(priceChg, oiChg, funding, lr) };
  }

  async function ta(q) {
    const sym = String(q.sym || "BTC").toUpperCase().trim(), tf = q.tf || "1d";
    if (!/^[A-Z0-9]{2,15}$/.test(sym)) throw new ApiError("币种代码格式不正确（例如 BTC、ETH、SOL）");
    if (["USDT", "USDC", "FDUSD"].includes(sym)) throw new ApiError("稳定币不做涨跌分析");
    if (!TA_TF[tf]) throw new ApiError("周期只能是 1h、4h、1d、1w");
    const c = await klines(sym, tf);
    if (c.length < 30) throw new ApiError(`${sym} 的历史 K 线太少，无法计算指标`);
    const closes = c.map((x) => x[4]), highs = c.map((x) => x[2]), lows = c.map((x) => x[3]);
    const [line, signal, hist] = macd(closes), [mid, up, lo] = bollinger(closes);
    const ind = { ma20: sma(closes, 20), ma50: sma(closes, 50), ma200: sma(closes, 200), bb_mid: mid, bb_up: up, bb_lo: lo,
      rsi: rsi(closes), macd: line, signal, hist, atr: atr(highs, lows, closes) };
    const shown = c.slice(-TA_SHOW), rng = shown.slice(-Math.min(shown.length, 30));
    const out = { sym, tf, candles: shown, stats: {
      price: closes[closes.length - 1], chg: closes.length > 1 ? (closes[closes.length - 1] / closes[closes.length - 2] - 1) * 100 : null,
      hi30: Math.max(...rng.map((x) => x[2])), lo30: Math.min(...rng.map((x) => x[3])),
      atr_pct: (last(ind.atr) || 0) / closes[closes.length - 1] * 100, rsi: last(ind.rsi) },
      readings: taRead(c, ind), deriv: null, deriv_error: null };
    for (const [k, s] of Object.entries(ind)) out[k] = s.slice(-TA_SHOW);
    try {
      out.deriv = await taDeriv(sym, tf, closes);
    } catch (e) {
      out.deriv_error = /HTTP 400/.test(e.message) ? `${sym} 没有 Binance USDT 永续合约` : e.message.slice(0, 160);
    }
    return out;
  }

  const STABLE = new Set("usdt usdc dai fdusd tusd usde usds pyusd usdd busd frax lusd gusd usdp eurc rlusd usd1 susde susds usdy usdtb usdf usd0 gho crvusd eurt xaut paxg bfusd usdx".split(" "));
  const WRAPPED = new Set("wbtc weth steth wsteth weeth cbbtc reth wbeth meth lbtc solvbtc ezeth rseth bnsol jitosol msol tbtc wbnb cbeth oseth lseth clbtc btcb".split(" "));
  const RWA = /tokeni[sz]ed|xstock|bstock|\bfund\b|treasury|t-bills?|\bgold\b|reinsurance|government/i;
  function coinIsPlain(c) {
    const s = (c.symbol || "").toLowerCase(), name = c.name || "";
    if (STABLE.has(s) || WRAPPED.has(s) || /^(wrapped|bridged|staked)/i.test(name) || RWA.test(name)) return false;
    const p = c.current_price || 0, ch = c.price_change_percentage_7d_in_currency;
    return !(Math.abs(p - 1) < 0.02 && ch != null && Math.abs(ch) < 1.5);
  }

  async function cgMarkets() {
    const url = `${CG}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&price_change_percentage=24h,7d`;
    try {
      return await getJson(url, 300);
    } catch (e) {
      if (/HTTP 429/.test(e.message)) throw new ApiError("CoinGecko 免费接口暂时限流，请 1 分钟后再刷新");
      throw e;
    }
  }

  async function movers() {
    const rows = [];
    for (const c of await cgMarkets()) {
      if (!coinIsPlain(c) || !c.market_cap) continue;
      rows.push({ sym: c.symbol.toUpperCase(), name: c.name, rank: c.market_cap_rank, price: c.current_price,
        chg24: c.price_change_percentage_24h_in_currency ?? null, chg7: c.price_change_percentage_7d_in_currency ?? null,
        mcap: c.market_cap, vol: c.total_volume || 0, turnover: (c.total_volume || 0) / c.market_cap });
    }
    const has = (k) => rows.filter((r) => r[k] != null);
    const top = (k, rev) => has(k).sort((a, b) => (rev ? b[k] - a[k] : a[k] - b[k])).slice(0, 10);
    const ch24 = has("chg24").map((r) => r.chg24).sort((a, b) => a - b), ch7 = has("chg7").map((r) => r.chg7).sort((a, b) => a - b);
    const up = ch24.filter((x) => x > 0.5).length, down = ch24.filter((x) => x < -0.5).length;
    const share = ch24.length ? up / ch24.length : 0.5;
    const read = share >= 0.7 ? { tone: "bull", text: "大部分币种上涨，普涨行情" } : down / Math.max(ch24.length, 1) >= 0.7
      ? { tone: "bear", text: "大部分币种下跌，普跌行情" } : { tone: "flat", text: "涨跌互现，行情分化" };
    return { breadth: { n: ch24.length, up, down, flat: ch24.length - up - down, median24: ch24[Math.floor(ch24.length / 2)] ?? null,
      median7: ch7[Math.floor(ch7.length / 2)] ?? null, up7: ch7.filter((x) => x > 0).length, n7: ch7.length, ...read },
      gainers24: top("chg24", true), losers24: top("chg24", false), gainers7: top("chg7", true), losers7: top("chg7", false),
      turnover: rows.slice().sort((a, b) => b.turnover - a.turnover).slice(0, 10), symbols: rows.slice(0, 120).map((r) => r.sym),
      fetched: Math.floor(Date.now() / 1000) };
  }

  const CORR_N = 14;
  async function btcCorr() {
    const syms = (await cgMarkets()).slice(0, 40).filter((c) => coinIsPlain(c) && c.symbol.toLowerCase() !== "btc").map((c) => c.symbol.toUpperCase());
    const daily = async (s) => Object.fromEntries((await klines(s, "1d", 91)).map((x) => [x[0], x[4]]));
    const btc = await daily("BTC");
    const got = await Promise.all(syms.slice(0, CORR_N + 6).map((s) => daily(s).then((px) => [s, px], () => null)));
    const vol30 = (r) => { const w = r.slice(-30), m = w.reduce((a, x) => a + x, 0) / 30; return Math.sqrt(w.reduce((a, x) => a + (x - m) ** 2, 0) / 30) * Math.sqrt(365) * 100; };
    const chg = (xs, n) => (xs.length > n ? (xs[xs.length - 1] / xs[xs.length - 1 - n] - 1) * 100 : null);
    const rows = [];
    for (const g of got) {
      if (!g || rows.length >= CORR_N) continue;
      const [s, px] = g, ts = Object.keys(px).filter((t) => t in btc).map(Number).sort((a, b) => a - b);
      if (ts.length < 35) continue;
      const a = ts.map((t) => px[t]), b = ts.map((t) => btc[t]), ra = pctReturns(a), rb = pctReturns(b);
      rows.push({ sym: s, corr30: corr(ra.slice(-30), rb.slice(-30)), corr90: corr(ra, rb), beta30: beta(ra.slice(-30), rb.slice(-30)),
        chg7: chg(a, 7), chg30: chg(a, 30), rel7: chg(a, 7) - chg(b, 7), rel30: chg(a, 30) - chg(b, 30), vol30: vol30(ra) });
    }
    const bc = Object.keys(btc).map(Number).sort((a, b) => a - b).map((t) => btc[t]), rb = pctReturns(bc);
    const cs = rows.map((r) => r.corr30).filter((x) => x != null), avg = cs.length ? cs.reduce((a, x) => a + x, 0) / cs.length : null;
    const beat = rows.filter((r) => r.rel30 > 0).length, readings = [];
    if (avg != null) readings.push({ tone: "flat", title: "平均相关系数（30 日）", value: avg.toFixed(2),
      text: avg >= 0.75 ? "主流币高度跟随 BTC，走势同涨同跌" : avg >= 0.5 ? "主流币与 BTC 中度相关" : "主流币走势相对独立，与 BTC 关联较弱" });
    if (rows.length) readings.push({ tone: beat > rows.length / 2 ? "bull" : "bear", title: "30 日跑赢 BTC", value: `${beat} / ${rows.length}`,
      text: beat > rows.length / 2 ? "多数主流币跑赢 BTC，资金在向山寨币扩散" : "多数主流币跑输 BTC，资金集中在比特币" });
    return { btc: { chg7: chg(bc, 7), chg30: chg(bc, 30), vol30: vol30(rb) }, rows, readings, fetched: Math.floor(Date.now() / 1000) };
  }

  // 市场监控页（与 server.py 的 market() 相同结构）；各项独立，失败的返回 null
  async function market() {
    const jobs = {
      fng: async () => ((await getJson("https://api.alternative.me/fng/?limit=90", 600)).data || []).map((x) => ({ v: +x.value, ts: +x.timestamp })),
      overview: async () => {
        const d = (await getJson(`${CG}/global`, 300)).data, pct = d.market_cap_percentage || {};
        return { mcap: d.total_market_cap.usd, vol: d.total_volume.usd, mcap_chg: d.market_cap_change_percentage_24h_usd, btc_dom: pct.btc, eth_dom: pct.eth };
      },
      coins: async () => (await getJson(`${CG}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=15&sparkline=true&price_change_percentage=24h,7d`, 300)).map((c) => {
        const sp = c.sparkline_in_7d?.price || [], step = Math.max(1, Math.floor(sp.length / 42));
        return { sym: c.symbol.toUpperCase(), name: c.name, price: c.current_price, mcap: c.market_cap, vol: c.total_volume,
          chg24: c.price_change_percentage_24h_in_currency, chg7: c.price_change_percentage_7d_in_currency, spark: sp.filter((_, i) => i % step === 0) };
      }),
      btc: () => deriv("BTC"), eth: () => deriv("ETH"),
      stables: async () => {
        const d = (await getJson("https://stablecoins.llama.fi/stablecoincharts/all", 3600)).slice(-31);
        const series = d.map((x) => ({ ts: +x.date, v: x.totalCirculatingUSD?.peggedUSD })).filter((x) => x.v);
        const now = series[series.length - 1].v, wk = series.length >= 8 ? series[series.length - 8].v : null;
        return { total: now, chg7: wk ? (now / wk - 1) * 100 : null, series };
      },
    };
    async function deriv(sym) {
      const [prem, oi, ls] = await Promise.all([
        getJson(`${FAPI}/fapi/v1/premiumIndex?symbol=${sym}USDT`, 120),
        getJson(`${FAPI}/futures/data/openInterestHist?symbol=${sym}USDT&period=1h&limit=25`, 300),
        getJson(`${FAPI}/futures/data/globalLongShortAccountRatio?symbol=${sym}USDT&period=1h&limit=1`, 300),
      ]);
      const now = oi?.length ? +oi[oi.length - 1].sumOpenInterestValue : null, old = oi?.length ? +oi[0].sumOpenInterestValue : null;
      return { sym, mark: +prem.markPrice, funding: +prem.lastFundingRate, next_funding: Math.floor(prem.nextFundingTime / 1000),
        oi: now, oi_chg: now && old ? (now / old - 1) * 100 : null,
        long_ratio: ls?.length ? +ls[0].longAccount : null, ls: ls?.length ? +ls[0].longShortRatio : null };
    }
    const keys = Object.keys(jobs), res = await Promise.allSettled(keys.map((k) => jobs[k]()));
    const out = {}, errors = {};
    res.forEach((r, i) => { out[keys[i]] = r.status === "fulfilled" ? r.value : null; if (r.status === "rejected") errors[keys[i]] = String(r.reason?.message || r.reason).slice(0, 160); });
    out.deriv = [out.btc, out.eth].filter(Boolean);
    delete out.btc; delete out.eth;
    out.errors = errors;
    out.fetched = Math.floor(Date.now() / 1000);
    return out;
  }

  // 顶部报价（与 server.py 的 prices() 相同）
  const PRICE_IDS = { ETH: "ethereum", BTC: "bitcoin", TRX: "tron", BNB: "binancecoin", POL: "polygon-ecosystem-token" };
  async function prices() {
    const d = await getJson(`${CG}/simple/price?ids=${Object.values(PRICE_IDS).join(",")}&vs_currencies=usd&include_24hr_change=true`, 600);
    const out = { _chg: {} };
    for (const [s, id] of Object.entries(PRICE_IDS)) { out[s] = d[id]?.usd ?? null; out._chg[s] = d[id]?.usd_24h_change ?? null; }
    out.USD = 1;
    return out;
  }

  root.BD_LIVE = { "/api/ta": ta, "/api/movers": movers, "/api/corr": btcCorr, "/api/market": market, "/api/prices": prices };
  root.BD_TA = { sma, ema, rsi, macd, bollinger, atr, pctReturns, corr, beta, taRead, derivRead, coinIsPlain };
})(typeof window !== "undefined" ? window : globalThis);
