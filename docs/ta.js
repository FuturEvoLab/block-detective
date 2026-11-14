// 区块侦探 — 涨跌分析：单币技术指标（K 线 + 均线 + 布林带 + 成交额 + RSI + MACD）、价格与合约持仓、涨跌榜、与 BTC 的联动
// 数据来自 /api/ta、/api/movers、/api/corr（服务端从 Binance / CoinGecko 免费接口取数并计算指标、生成解读）

const ta = { sym: "BTC", tf: "1d", data: null, movers: null, corr: null, range: "24", at: 0, hover: null };
const TA_QUICK = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE"];
const TONE_ICON = { bull: "▲", bear: "▼", flat: "■" };
const fmtNum2 = (v, d = 2) => (v == null ? "—" : v.toFixed(d));

function readList(list) {
  return (list || []).map((r) => `<li class="${r.tone}"><i>${TONE_ICON[r.tone] || "■"}</i><div><div class="t"><span>${esc(r.title)}</span><b>${esc(r.value)}</b></div><p>${esc(r.text)}</p></div></li>`).join("")
    || `<li class="flat"><i>■</i><div><p>暂无数据</p></div></li>`;
}

async function loadTa(force = false) {
  if (!force && ta.data && Date.now() - ta.at < 240000) return renderTaAll();
  $("#ta-refresh").disabled = true;
  ta.at = Date.now();
  await Promise.all([loadTaCoin(), loadMovers(force), loadCorr(force)]);
  $("#ta-refresh").disabled = false;
}

async function loadTaCoin() {
  const box = $("#ta-chart");
  box.classList.add("loading");
  try {
    ta.data = await api(`/api/ta?sym=${encodeURIComponent(ta.sym)}&tf=${ta.tf}`);
    $("#ta-msg").innerHTML = "";
  } catch (e) {
    $("#ta-msg").innerHTML = `<div class="err">${esc(e.message)}</div>`;
    if (ta.data) { ta.sym = ta.data.sym; ta.tf = ta.data.tf; $("#ta-sym").value = ta.sym; } // 查不到时继续显示上一个结果
  }
  box.classList.remove("loading");
  renderTaCoin();
}

async function loadMovers(force) {
  if (ta.movers && !force) return renderMovers();
  try {
    ta.movers = await api("/api/movers");
    $("#ta-upd").textContent = `更新于 ${fmtTime(ta.movers.fetched).slice(11)}`;
    $("#ta-syms").innerHTML = (ta.movers.symbols || []).map((s) => `<option value="${esc(s)}">`).join("");
  } catch (e) {
    $("#ta-breadth").innerHTML = `<p class="err">${esc(e.message)}</p>`;
  }
  renderMovers();
}

async function loadCorr(force) {
  if (ta.corr && !force) return renderCorr();
  $("#ta-corr").innerHTML = `<tr><td class="muted">正在计算…</td></tr>`;
  try {
    ta.corr = await api("/api/corr");
  } catch (e) {
    $("#ta-corr").innerHTML = `<tr><td class="err">${esc(e.message)}</td></tr>`;
    return;
  }
  renderCorr();
}

function renderTaAll() { renderTaCoin(); renderMovers(); renderCorr(); }

// ---------------------------------------------------------------- 单币技术分析

function renderTaCoin() {
  $("#ta-quick").innerHTML = TA_QUICK.map((s) => `<button type="button" class="chip${s === ta.sym ? " on" : ""}" data-sym="${s}">${s}</button>`).join("");
  $$("#ta-tf button").forEach((b) => b.classList.toggle("on", b.dataset.tf === ta.tf));
  const d = ta.data;
  if (!d) {
    $("#ta-kpis").innerHTML = ""; $("#ta-read").innerHTML = readList([]); $("#ta-chart").innerHTML = ""; $("#ta-dv").innerHTML = "";
    return;
  }
  const s = d.stats, ma200 = d.ma200.filter((x) => x != null).pop();
  const k = (key, v, sub) => `<div class="kpi"><div class="k">${key}</div><div class="v">${v}</div><div class="s">${sub}</div></div>`;
  const zone = s.rsi >= 70 ? "超买" : s.rsi <= 30 ? "超卖" : s.rsi >= 55 ? "偏强" : s.rsi <= 45 ? "偏弱" : "中性";
  $("#ta-kpis").innerHTML = [
    k(`${esc(d.sym)} / USDT`, fmtPrice(s.price), `<span class="mk-chg ${updn(s.chg)}">${pct(s.chg)}</span> <span>最新 K 线</span>`),
    k("近 30 根高点", fmtPrice(s.hi30), `<span class="mk-chg down">${pct((s.price / s.hi30 - 1) * 100, 1)}</span> <span>距高点</span>`),
    k("近 30 根低点", fmtPrice(s.lo30), `<span class="mk-chg up">${pct((s.price / s.lo30 - 1) * 100, 1)}</span> <span>距低点</span>`),
    k("RSI(14)", fmtNum2(s.rsi, 1), `<span>${zone}</span>`),
    k("波动率 ATR(14)", `${fmtNum2(s.atr_pct)}%`, `<span>每根 K 线平均波动</span>`),
    k("距 MA200", ma200 ? pct((s.price / ma200 - 1) * 100, 1) : "—", ma200 ? `<span>MA200 ${fmtPrice(ma200)}</span>` : `<span>K 线不足 200 根</span>`),
  ].join("");
  $("#ta-read").innerHTML = readList(d.readings);
  drawTaChart();
  renderDerivBlock();
}

function pathOf(vals, x, y) {
  let p = "", pen = false;
  vals.forEach((v, i) => {
    if (v == null) { pen = false; return; }
    p += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
    pen = true;
  });
  return p;
}

function drawTaChart() {
  const d = ta.data, box = $("#ta-chart");
  if (!d || !$("#tab-ta").classList.contains("active")) return;
  const c = d.candles, n = c.length;
  const W = Math.max(480, box.clientWidth || 900), L = 6, R = 66;
  const P = { top: 8, price: 290, gap: 16, vol: 56, rsi: 74, macd: 84, axis: 20 };
  const yPrice0 = P.top, yVol0 = yPrice0 + P.price + P.gap, yRsi0 = yVol0 + P.vol + P.gap, yMacd0 = yRsi0 + P.rsi + P.gap;
  const H = yMacd0 + P.macd + P.axis;
  const cw = (W - L - R) / n, x = (i) => L + (i + 0.5) * cw, bw = Math.max(1, cw * 0.62);
  const vals = (a) => a.filter((v) => v != null);
  const hiAll = Math.max(...c.map((k) => k[2]), ...vals(d.bb_up)), loAll = Math.min(...c.map((k) => k[3]), ...vals(d.bb_lo));
  const pad = (hiAll - loAll) * 0.04 || hiAll * 0.01;
  const pMax = hiAll + pad, pMin = loAll - pad;
  const y = (v) => yPrice0 + (1 - (v - pMin) / (pMax - pMin)) * P.price;
  const vMax = Math.max(...c.map((k) => k[5])) || 1;
  const yV = (v) => yVol0 + P.vol - (v / vMax) * P.vol;
  const yR = (v) => yRsi0 + (1 - v / 100) * P.rsi;
  const mAbs = Math.max(...vals(d.macd).map(Math.abs), ...vals(d.signal).map(Math.abs), ...vals(d.hist).map(Math.abs)) || 1;
  const yM = (v) => yMacd0 + P.macd / 2 - (v / mAbs) * (P.macd / 2 - 4);

  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const v = pMin + (pMax - pMin) * (1 - f), yy = yPrice0 + f * P.price;
    return `<line class="g" x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}"/><text x="${W - R + 6}" y="${yy + 3}">${fmtPrice(v)}</text>`;
  }).join("");
  // 布林带：上轨到下轨的填充
  const bbIdx = d.bb_up.map((v, i) => (v != null && d.bb_lo[i] != null ? i : -1)).filter((i) => i >= 0);
  const bb = bbIdx.length > 1 ? `<path class="bb" d="${bbIdx.map((i, j) => `${j ? "L" : "M"}${x(i).toFixed(1)} ${y(d.bb_up[i]).toFixed(1)}`).join("")}${bbIdx.slice().reverse().map((i) => `L${x(i).toFixed(1)} ${y(d.bb_lo[i]).toFixed(1)}`).join("")}Z"/>` : "";
  const candles = c.map((k, i) => {
    const up = k[4] >= k[1], top = y(Math.max(k[1], k[4])), bot = y(Math.min(k[1], k[4]));
    return `<g class="${up ? "cu" : "cd"}"><line x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="${y(k[2]).toFixed(1)}" y2="${y(k[3]).toFixed(1)}"/><rect x="${(x(i) - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, bot - top).toFixed(1)}"/></g>`;
  }).join("");
  const vols = c.map((k, i) => `<rect class="${k[4] >= k[1] ? "vu" : "vd"}" x="${(x(i) - bw / 2).toFixed(1)}" y="${yV(k[5]).toFixed(1)}" width="${bw.toFixed(1)}" height="${(yVol0 + P.vol - yV(k[5])).toFixed(1)}"/>`).join("");
  const last = c[n - 1][4], lastUp = last >= c[n - 1][1];
  const lastTag = `<line class="lastp ${lastUp ? "u" : "d"}" x1="${L}" x2="${W - R}" y1="${y(last)}" y2="${y(last)}"/><rect class="lastb ${lastUp ? "u" : "d"}" x="${W - R + 2}" y="${y(last) - 8}" width="${R - 4}" height="16"/><text class="lastt" x="${W - R + 6}" y="${y(last) + 4}">${fmtPrice(last)}</text>`;
  const rsiPanel = `<rect class="rsiband" x="${L}" y="${yR(70)}" width="${W - L - R}" height="${yR(30) - yR(70)}"/>` +
    [30, 50, 70].map((v) => `<line class="g" x1="${L}" x2="${W - R}" y1="${yR(v)}" y2="${yR(v)}"/><text x="${W - R + 6}" y="${yR(v) + 3}">${v}</text>`).join("") +
    `<path class="rsi" d="${pathOf(d.rsi, x, yR)}"/>`;
  const hist = d.hist.map((v, i) => (v == null ? "" : `<rect class="${v >= 0 ? "vu" : "vd"}" x="${(x(i) - bw / 2).toFixed(1)}" y="${Math.min(yM(v), yM(0)).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0.5, Math.abs(yM(v) - yM(0))).toFixed(1)}"/>`)).join("");
  const macdPanel = `<line class="g" x1="${L}" x2="${W - R}" y1="${yM(0)}" y2="${yM(0)}"/>${hist}<path class="macd" d="${pathOf(d.macd, x, yM)}"/><path class="sig" d="${pathOf(d.signal, x, yM)}"/>`;
  const withTime = ta.tf === "1h" || ta.tf === "4h";
  const dates = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const i = Math.round(f * (n - 1));
    return `<text x="${x(i)}" y="${H - 6}" text-anchor="${f === 0 ? "start" : f === 1 ? "end" : "middle"}">${fmtTime(c[i][0], withTime).slice(withTime ? 5 : 0)}</text>`;
  }).join("");
  const lbl = (t, yy) => `<text class="plbl" x="${L + 4}" y="${yy + 12}">${t}</text>`;
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
    ${grid}${bb}<path class="ma200" d="${pathOf(d.ma200, x, y)}"/><path class="ma50" d="${pathOf(d.ma50, x, y)}"/><path class="ma20" d="${pathOf(d.ma20, x, y)}"/>
    ${candles}${lastTag}
    ${vols}${rsiPanel}${macdPanel}${dates}
    ${lbl("成交额", yVol0)}${lbl("RSI 14", yRsi0)}${lbl("MACD 12 26 9", yMacd0)}
    <line class="cursor" x1="0" x2="0" y1="${P.top}" y2="${H - P.axis}" visibility="hidden"/>
    <rect class="hit" x="${L}" y="0" width="${W - L - R}" height="${H}"/>
  </svg><div class="ta-tip" hidden></div>`;
  const svg = box.querySelector("svg"), tip = box.querySelector(".ta-tip"), cur = box.querySelector(".cursor");
  svg.querySelector(".hit").onmousemove = (e) => {
    const r = svg.getBoundingClientRect(), px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.floor((px - L) / cw)));
    const k = c[i];
    cur.setAttribute("x1", x(i)); cur.setAttribute("x2", x(i)); cur.setAttribute("visibility", "visible");
    const row = (name, v, cls = "") => `<span>${name}</span><b class="${cls}">${v}</b>`;
    tip.innerHTML = `<div class="tt">${fmtTime(k[0], withTime)}</div><div class="tg">` +
      row("开", fmtPrice(k[1])) + row("高", fmtPrice(k[2])) + row("低", fmtPrice(k[3])) + row("收", fmtPrice(k[4]), k[4] >= k[1] ? "up" : "down") +
      row("成交额", fmtUsd(k[5])) + row("RSI", fmtNum2(d.rsi[i], 1)) + row("MACD", d.hist[i] == null ? "—" : d.hist[i].toPrecision(3)) + `</div>`;
    tip.hidden = false;
    const left = (x(i) / W) * r.width;
    tip.style.left = `${left > r.width / 2 ? left - tip.offsetWidth - 14 : left + 14}px`;
  };
  svg.querySelector(".hit").onmouseleave = () => { tip.hidden = true; cur.setAttribute("visibility", "hidden"); };
}

// ---------------------------------------------------------------- 价格与合约持仓

function barsSvg(vals, w = 220, h = 44) {
  if (!vals?.length) return "";
  const m = Math.max(...vals.map(Math.abs)) || 1, bw = w / vals.length;
  return `<svg class="ta-bars" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><line x1="0" x2="${w}" y1="${h / 2}" y2="${h / 2}"/>` +
    vals.map((v, i) => { const hh = (Math.abs(v) / m) * (h / 2 - 2); return `<rect class="${v >= 0 ? "vu" : "vd"}" x="${(i * bw + bw * 0.15).toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" y="${(v >= 0 ? h / 2 - hh : h / 2).toFixed(1)}" height="${Math.max(0.5, hh).toFixed(1)}"/>`; }).join("") + `</svg>`;
}

function renderDerivBlock() {
  const d = ta.data, box = $("#ta-dv");
  if (!d) return (box.innerHTML = "");
  const x = d.deriv;
  if (!x) return (box.innerHTML = `<p class="muted">${esc(d.deriv_error || "暂无数据")}</p>`);
  const IN = getVar("--in"), OUT = getVar("--out");
  const fr = x.funding == null ? null : x.funding * 100;
  box.innerHTML = `<div class="ta-dv-grid">
      <div class="kpi"><div class="k">统计窗口</div><div class="v">${esc(x.window)}</div><div class="s">${esc(d.sym)} · ${esc(d.tf)}</div></div>
      <div class="kpi"><div class="k">价格变化</div><div class="v mk-chg ${updn(x.price_chg)}">${pct(x.price_chg, 1)}</div><div class="s">现货收盘价</div></div>
      <div class="kpi"><div class="k">持仓量</div><div class="v">${fmtUsd(x.oi)}</div><div class="s"><span class="mk-chg ${updn(x.oi_chg)}">${pct(x.oi_chg, 1)}</span></div>${sparkSvg(x.oi_series.map((p) => p.v), (x.oi_chg ?? 0) >= 0 ? IN : OUT)}</div>
      <div class="kpi"><div class="k">资金费率</div><div class="v ${fr > 0.03 ? "up" : fr < 0 ? "down" : ""}">${fr == null ? "—" : fr.toFixed(4) + "%"}</div><div class="s">${fr == null ? "" : `<span>年化</span> ${(fr * 3 * 365).toFixed(1)}%`}</div>${barsSvg(x.funding_series.map((p) => p.v))}</div>
      <div class="kpi"><div class="k">多空账户比</div><div class="v">${x.long_ratio == null ? "—" : `${Math.round(x.long_ratio * 100)}% / ${Math.round((1 - x.long_ratio) * 100)}%`}</div><div class="s"><span>多</span> / <span>空</span></div></div>
    </div>
    <ul class="mk-list ta-dv-read">${readList(x.readings)}</ul>`;
}

// ---------------------------------------------------------------- 涨跌榜

function moverRows(list, key) {
  if (!list?.length) return `<tr><td class="muted">暂无数据</td></tr>`;
  return `<tr><th>币种</th><th class="num">价格</th><th class="num">${key === "chg7" ? "7d" : "24h"}</th><th class="num">市值</th></tr>` +
    list.map((r) => `<tr class="click" data-sym="${esc(r.sym)}"><td><b>${esc(r.sym)}</b> <span class="muted">${esc(r.name)}</span></td><td class="num mono">${fmtPrice(r.price)}</td>
      <td class="num mk-chg ${updn(r[key])}">${pct(r[key], 1)}</td><td class="num">${fmtUsd(r.mcap)}</td></tr>`).join("");
}

function renderMovers() {
  const m = ta.movers;
  if (!m) return;
  $$("#ta-mv-range button").forEach((b) => b.classList.toggle("on", b.dataset.r === ta.range));
  const b = m.breadth, r7 = ta.range === "7";
  const n = r7 ? b.n7 : b.n, up = r7 ? b.up7 : b.up, down = r7 ? b.n7 - b.up7 : b.down, flat = r7 ? 0 : b.flat, med = r7 ? b.median7 : b.median24;
  const tone = up / n >= 0.7 ? ["bull", "大部分币种上涨，普涨行情"] : down / n >= 0.7 ? ["bear", "大部分币种下跌，普跌行情"] : ["flat", "涨跌互现，行情分化"];
  $("#ta-breadth").innerHTML = `<div class="ta-bar"><i class="u" style="width:${(up / n) * 100}%"></i><i class="f" style="width:${(flat / n) * 100}%"></i><i class="d" style="width:${(down / n) * 100}%"></i></div>
    <div class="ta-bar-t"><span class="up"><span>上涨</span> <b>${up}</b></span>${r7 ? "" : `<span><span>持平</span> <b>${flat}</b></span>`}<span class="down"><span>下跌</span> <b>${down}</b></span>
    <span class="spacer"></span><span><span>中位数涨跌</span> <b class="mk-chg ${updn(med)}">${pct(med, 1)}</b></span></div>
    <ul class="mk-list"><li class="${tone[0]}"><i>${TONE_ICON[tone[0]]}</i><div><div class="t"><span>市场宽度</span><b>${up} / ${n}</b></div><p>${tone[1]}</p></div></li></ul>`;
  const key = r7 ? "chg7" : "chg24";
  $("#ta-gain").innerHTML = moverRows(r7 ? m.gainers7 : m.gainers24, key);
  $("#ta-lose").innerHTML = moverRows(r7 ? m.losers7 : m.losers24, key);
  $("#ta-turn").innerHTML = m.turnover?.length ? `<tr><th>币种</th><th class="num">价格</th><th class="num">24h</th><th class="num">24h 成交额</th><th class="num">成交额 / 市值</th></tr>` +
    m.turnover.map((r) => `<tr class="click" data-sym="${esc(r.sym)}"><td><b>${esc(r.sym)}</b> <span class="muted">${esc(r.name)}</span></td><td class="num mono">${fmtPrice(r.price)}</td>
      <td class="num mk-chg ${updn(r.chg24)}">${pct(r.chg24, 1)}</td><td class="num">${fmtUsd(r.vol)}</td><td class="num"><b>${(r.turnover * 100).toFixed(0)}%</b></td></tr>`).join("")
    : `<tr><td class="muted">暂无数据</td></tr>`;
}

// ---------------------------------------------------------------- 与 BTC 的联动

function corrCell(v) {
  if (v == null) return `<td class="num">—</td>`;
  const w = Math.min(1, Math.abs(v)) * 100;
  return `<td class="num"><span class="ta-cbar"><i class="${v >= 0 ? "p" : "n"}" style="width:${w.toFixed(0)}%"></i></span> <b>${v.toFixed(2)}</b></td>`;
}

function renderCorr() {
  const c = ta.corr;
  if (!c) return;
  $("#ta-corr-read").innerHTML = readList(c.readings);
  const b = c.btc;
  $("#ta-corr").innerHTML = `<tr><th>币种</th><th class="num">相关系数 30 日</th><th class="num">90 日</th><th class="num">Beta</th><th class="num">相对 BTC 7 日</th><th class="num">相对 BTC 30 日</th><th class="num">波动率（年化）</th></tr>` +
    `<tr class="click bench" data-sym="BTC"><td><b>BTC</b> <span class="muted">基准</span></td><td class="num">1.00</td><td class="num">1.00</td><td class="num">1.00</td>
      <td class="num mk-chg ${updn(b.chg7)}">${pct(b.chg7, 1)}</td><td class="num mk-chg ${updn(b.chg30)}">${pct(b.chg30, 1)}</td><td class="num">${b.vol30.toFixed(0)}%</td></tr>` +
    c.rows.map((r) => `<tr class="click" data-sym="${esc(r.sym)}"><td><b>${esc(r.sym)}</b></td>${corrCell(r.corr30)}<td class="num">${fmtNum2(r.corr90)}</td><td class="num">${fmtNum2(r.beta30)}</td>
      <td class="num mk-chg ${updn(r.rel7)}">${pct(r.rel7, 1)}</td><td class="num mk-chg ${updn(r.rel30)}">${pct(r.rel30, 1)}</td><td class="num">${r.vol30.toFixed(0)}%</td></tr>`).join("");
}

// ---------------------------------------------------------------- 交互

function analyzeSym(sym) {
  ta.sym = String(sym || "").trim().toUpperCase() || "BTC";
  $("#ta-sym").value = ta.sym;
  loadTaCoin();
  $("#tab-ta .card").scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "start" });
}
$("#ta-form").addEventListener("submit", (e) => { e.preventDefault(); analyzeSym($("#ta-sym").value); });
$("#ta-tf").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tf]");
  if (!b || b.dataset.tf === ta.tf) return;
  ta.tf = b.dataset.tf;
  loadTaCoin();
});
$("#ta-quick").addEventListener("click", (e) => { const b = e.target.closest("[data-sym]"); if (b) analyzeSym(b.dataset.sym); });
$("#ta-mv-range").addEventListener("click", (e) => { const b = e.target.closest("[data-r]"); if (b) { ta.range = b.dataset.r; renderMovers(); } });
for (const id of ["#ta-gain", "#ta-lose", "#ta-turn", "#ta-corr"]) {
  $(id).addEventListener("click", (e) => { const tr = e.target.closest("tr[data-sym]"); if (tr) analyzeSym(tr.dataset.sym); });
}
$("#ta-refresh").addEventListener("click", () => loadTa(true));
let taResize;
addEventListener("resize", () => { clearTimeout(taResize); taResize = setTimeout(drawTaChart, 150); });
// 切到本页时加载（4 分钟内的数据不重新请求）
document.addEventListener("click", (e) => { if (e.target.closest('[data-tab="ta"]')) setTimeout(() => loadTa(), 0); });
document.addEventListener("keydown", (e) => { if (e.key === "4" && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName) && !e.metaKey && !e.ctrlKey && !e.altKey) setTimeout(() => loadTa(), 0); });
