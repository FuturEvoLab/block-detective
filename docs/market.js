// 区块侦探 — 市场监控：恐惧与贪婪指数、全市场概览、合约情绪、稳定币、主流币
// 数据来自 /api/market（服务端汇总 alternative.me / CoinGecko / Binance / DefiLlama，均为免费公开接口）

const FNG_ZONES = [
  { max: 24, key: "xfear", text: "极度恐慌", color: "#ff3b6b" },
  { max: 44, key: "fear", text: "恐慌", color: "#ff9f1c" },
  { max: 55, key: "neutral", text: "中性", color: "#ffd23f" },
  { max: 74, key: "greed", text: "贪婪", color: "#9be15d" },
  { max: 100, key: "xgreed", text: "极度贪婪", color: "#22ffa6" },
];
const fngZone = (v) => FNG_ZONES.find((z) => v <= z.max);
const mk = { data: null, range: 30, at: 0 };
const pct = (v, d = 2) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`);
const updn = (v) => (v == null ? "" : v >= 0 ? "up" : "down");
const fmtPrice = (v) => (v == null ? "—" : "$" + (v >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : v >= 1 ? v.toFixed(2) : v.toPrecision(4)));

async function loadMarket(force = false) {
  if (!force && mk.data && Date.now() - mk.at < 240000) return renderMarket();
  const btn = $("#mk-refresh");
  btn.disabled = true;
  try {
    mk.data = await api("/api/market");
    mk.at = Date.now();
    const bad = Object.keys(mk.data.errors || {});
    $("#mk-msg").innerHTML = bad.length ? `<div>部分数据源暂时不可用：${esc(bad.join(", "))}</div>` : "";
    renderMarket();
    // 服务端先给了旧缓存（比如刚重启）时，后台刷新完再取一次
    if (mk.data.fetched && Date.now() / 1000 - mk.data.fetched > 240) setTimeout(() => loadMarket(true), 6000);
  } catch (e) {
    $("#mk-msg").innerHTML = `<div class="err">${esc(e.message)}</div>`;
  }
  btn.disabled = false;
}

function renderMarket() {
  const d = mk.data;
  if (!d) return;
  renderHudFng();
  if (!$("#tab-market").classList.contains("active")) return; // 不在本页时只更新顶部读数
  $("#mk-upd").textContent = `更新于 ${fmtTime(d.fetched || mk.at / 1000).slice(11)}`; // 服务端可能先给缓存，显示数据真正的获取时间
  renderGauge(); renderReadings(); renderMkKpis(); renderFngChart(); renderDeriv(); renderCoins();
}

// 顶部状态栏的恐惧与贪婪读数
function renderHudFng() {
  const f = mk.data?.fng;
  if (!f?.length) return;
  const z = fngZone(f[0].v), el = $("#hb-fng");
  el.style.setProperty("--fc", z.color);
  flashVal($("#hb-fng b"), String(f[0].v));
  $("#hb-fng i").textContent = z.text;
}
$("#hb-fng").addEventListener("click", () => { switchTab("market"); loadMarket(); });

// 半圆仪表：五段颜色 + 指针
function renderGauge() {
  const f = mk.data.fng;
  if (!f?.length) return ($("#mk-gauge").innerHTML = `<p class="muted">暂无数据</p>`);
  const v = f[0].v, z = fngZone(v);
  const cx = 120, cy = 118, R = 96;
  const pt = (val, r) => { const a = Math.PI * (1 - val / 100); return [cx + r * Math.cos(a), cy - r * Math.sin(a)]; };
  let lo = 0;
  const arcs = FNG_ZONES.map((zz) => {
    const [x1, y1] = pt(lo + 0.6, R), [x2, y2] = pt(zz.max - 0.6, R);
    const path = `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)}A${R} ${R} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}" stroke="${zz.color}" class="${zz.key === z.key ? "cur" : ""}"/>`;
    lo = zz.max;
    return path;
  }).join("");
  const ticks = Array.from({ length: 21 }, (_, i) => {
    const [a, b] = [pt(i * 5, R - 14), pt(i * 5, R - (i % 5 ? 18 : 22))];
    return `<line x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" x2="${b[0].toFixed(1)}" y2="${b[1].toFixed(1)}"/>`;
  }).join("");
  const [nx, ny] = pt(v, R - 30);
  const prev = +($("#mk-gauge").dataset.v || 50);
  $("#mk-gauge").dataset.v = v;
  $("#mk-gauge").style.setProperty("--fc", z.color);
  $("#mk-gauge").innerHTML = `<svg viewBox="0 0 240 196" aria-hidden="true">
      <g class="arcs">${arcs}</g><g class="ticks">${ticks}</g>
      <g class="needle" style="--from:${(prev - v) * 1.8}deg"><line x1="${cx}" y1="${cy}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}"/><circle cx="${cx}" cy="${cy}" r="6"/></g>
      <text x="22" y="140" class="lbl">0</text><text x="218" y="140" class="lbl" text-anchor="end">100</text>
    </svg>
    <div class="mk-gv"><b>${v}</b><span>${z.text}</span></div>`;
  const cmp = [["昨天", f[1]], ["7 天前", f[7]], ["30 天前", f[30]]].filter(([, x]) => x);
  $("#mk-cmp").innerHTML = cmp.map(([k, x]) => {
    const zz = fngZone(x.v), dv = v - x.v;
    return `<div><span>${k}</span><b style="color:${zz.color}">${x.v}</b><small>${zz.text}</small><em class="${updn(dv)}">${dv >= 0 ? "▲" : "▼"}${Math.abs(dv)}</em></div>`;
  }).join("");
}

// 市场解读：只做客观描述
function renderReadings() {
  const d = mk.data, out = [];
  const add = (tone, title, value, text) => out.push({ tone, title, value, text });
  if (d.fng?.length) {
    const v = d.fng[0].v, z = fngZone(v);
    const t = { xfear: "市场处于极度恐慌，抛售情绪浓厚", fear: "市场偏向恐慌，投资者情绪谨慎", neutral: "市场情绪中性", greed: "市场偏向贪婪，追涨情绪升温", xgreed: "市场极度贪婪，情绪过热" }[z.key];
    add(v <= 44 ? "bear" : v >= 56 ? "bull" : "flat", "恐惧与贪婪", `${v}`, t);
    if (d.fng[7]) {
      const dv = v - d.fng[7].v;
      if (Math.abs(dv) >= 15) add(dv < 0 ? "bear" : "bull", "情绪变化", `${dv > 0 ? "+" : ""}${dv} / 7d`, dv < 0 ? "一周内情绪明显转冷" : "一周内情绪明显升温");
    }
  }
  const o = d.overview;
  if (o?.mcap_chg != null) {
    add(o.mcap_chg <= -3 ? "bear" : o.mcap_chg >= 3 ? "bull" : "flat", "全市场市值", pct(o.mcap_chg),
      o.mcap_chg <= -3 ? "全市场市值 24 小时明显下跌" : o.mcap_chg >= 3 ? "全市场市值 24 小时明显上涨" : "全市场市值 24 小时波动不大");
  }
  const btc = d.deriv?.find((x) => x.sym === "BTC");
  if (btc) {
    const fr = btc.funding * 100;
    add(fr > 0.03 ? "bull" : fr < 0 ? "bear" : "flat", "BTC 资金费率", `${fr.toFixed(4)}%`,
      fr > 0.03 ? "资金费率偏高，多头拥挤" : fr < 0 ? "资金费率为负，空头占优" : "资金费率处于常规水平");
    if (btc.oi_chg != null) add(btc.oi_chg <= -5 ? "bear" : btc.oi_chg >= 5 ? "bull" : "flat", "BTC 合约持仓", pct(btc.oi_chg, 1),
      btc.oi_chg <= -5 ? "24 小时持仓明显减少，杠杆在出清" : btc.oi_chg >= 5 ? "24 小时持仓明显增加，杠杆在累积" : "24 小时持仓变化不大");
    if (btc.long_ratio != null) add(btc.long_ratio >= 0.65 ? "bull" : btc.long_ratio <= 0.4 ? "bear" : "flat", "BTC 多空账户", `${Math.round(btc.long_ratio * 100)}% / ${Math.round((1 - btc.long_ratio) * 100)}%`,
      btc.long_ratio >= 0.65 ? "多数账户做多，散户偏多" : btc.long_ratio <= 0.4 ? "多数账户做空，散户偏空" : "多空账户分布均衡");
  }
  const st = d.stables;
  if (st?.chg7 != null) add(st.chg7 >= 1 ? "bull" : st.chg7 <= -1 ? "bear" : "flat", "稳定币供应", pct(st.chg7) + " / 7d",
    st.chg7 >= 1 ? "稳定币供应增加，场外资金在流入" : st.chg7 <= -1 ? "稳定币供应减少，资金在流出" : "稳定币供应基本持平");
  if (o?.btc_dom != null && (o.btc_dom >= 58 || o.btc_dom <= 45)) add("flat", "BTC 市占率", `${o.btc_dom.toFixed(1)}%`,
    o.btc_dom >= 58 ? "资金集中在比特币，山寨币相对弱势" : "山寨币占比上升，资金在向外扩散");
  const icon = { bull: "▲", bear: "▼", flat: "■" };
  $("#mk-read").innerHTML = out.map((r) => `<li class="${r.tone}"><i>${icon[r.tone]}</i><div><div class="t"><span>${r.title}</span><b>${esc(r.value)}</b></div><p>${r.text}</p></div></li>`).join("")
    || `<li class="flat"><i>■</i><div><p>暂无数据</p></div></li>`;
}

function sparkSvg(vals, color, w = 100, h = 28) {
  if (!vals?.length) return "";
  const min = Math.min(...vals), max = Math.max(...vals), rng = max - min || 1;
  const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - min) / rng) * (h - 4)).toFixed(1)}`).join(" ");
  return `<svg class="mk-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="0,${h} ${pts} ${w},${h}" fill="${color}" opacity=".12" stroke="none"/><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.4" vector-effect="non-scaling-stroke"/></svg>`;
}

function renderMkKpis() {
  const o = mk.data.overview, st = mk.data.stables;
  const IN = getVar("--in"), OUT = getVar("--out");
  const k = (key, v, sub, extra = "") => `<div class="kpi"><div class="k">${key}</div><div class="v">${v}</div><div class="s">${sub}</div>${extra}</div>`;
  const chg = (v, d = 2) => `<span class="mk-chg ${updn(v)}">${pct(v, d)}</span>`;
  const btcSpark = mk.data.coins?.find((c) => c.sym === "BTC")?.spark;
  $("#mk-kpis").innerHTML = o ? [
    k("总市值", fmtUsd(o.mcap), `24h ${chg(o.mcap_chg)}`),
    k("24h 成交额", fmtUsd(o.vol), `换手率 ${((o.vol / o.mcap) * 100).toFixed(1)}%`),
    k("BTC 市占率", `${o.btc_dom.toFixed(1)}%`, "比特币占总市值比例", btcSpark ? sparkSvg(btcSpark, getVar("--gold") || "#ffb627") : ""),
    k("ETH 市占率", `${o.eth_dom.toFixed(1)}%`, "以太坊占总市值比例"),
    st ? k("稳定币总量", fmtUsd(st.total), `7d ${chg(st.chg7)}`, sparkSvg(st.series.map((x) => x.v), st.chg7 >= 0 ? IN : OUT)) : "",
    mk.data.fng?.length ? k("情绪 30 日均值", String(Math.round(mk.data.fng.slice(0, 30).reduce((a, x) => a + x.v, 0) / Math.min(30, mk.data.fng.length))), `<span>${fngZone(Math.round(mk.data.fng.slice(0, 30).reduce((a, x) => a + x.v, 0) / Math.min(30, mk.data.fng.length))).text}</span>`) : "",
  ].join("") : "";
}

// 情绪走势：背景按五个区间着色，折线 + 悬停读数
function renderFngChart() {
  const f = (mk.data.fng || []).slice(0, mk.range).reverse();
  const box = $("#mk-chart");
  if (f.length < 2) return (box.innerHTML = `<p class="muted">暂无数据</p>`);
  const W = 640, H = 200, L = 28, R = 8, T = 8, B = 22;
  const x = (i) => L + (i / (f.length - 1)) * (W - L - R), y = (v) => T + (1 - v / 100) * (H - T - B);
  let lo = 0;
  const bands = FNG_ZONES.map((z) => { const r = `<rect x="${L}" y="${y(z.max)}" width="${W - L - R}" height="${y(lo) - y(z.max)}" fill="${z.color}" opacity=".06"/>`; lo = z.max; return r; }).join("");
  const grid = [0, 25, 50, 75, 100].map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="g"/><text x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${v}</text>`).join("");
  const line = f.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.v).toFixed(1)}`).join("");
  const dots = f.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="${i === f.length - 1 ? 4 : 2.2}" fill="${fngZone(p.v).color}" ${i === f.length - 1 ? 'class="last"' : ""}/>`).join("");
  const dates = [0, Math.floor((f.length - 1) / 2), f.length - 1].map((i) => `<text x="${x(i)}" y="${H - 6}" text-anchor="${i === 0 ? "start" : i === f.length - 1 ? "end" : "middle"}">${fmtTime(f[i].ts, false).slice(5)}</text>`).join("");
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${bands}${grid}
    <path d="${line}L${x(f.length - 1)} ${y(0)}L${x(0)} ${y(0)}Z" class="area"/><path d="${line}" class="line"/>${dots}${dates}
    <line class="cursor" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/></svg><div class="mk-tip" hidden></div>`;
  const svg = box.querySelector("svg"), tip = box.querySelector(".mk-tip"), cur = box.querySelector(".cursor");
  svg.onmousemove = (e) => {
    const r = svg.getBoundingClientRect(), px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(f.length - 1, Math.round(((px - L) / (W - L - R)) * (f.length - 1))));
    const p = f[i], z = fngZone(p.v);
    cur.setAttribute("x1", x(i)); cur.setAttribute("x2", x(i)); cur.setAttribute("visibility", "visible");
    tip.innerHTML = `${fmtTime(p.ts, false)} · <b style="color:${z.color}">${p.v}</b> <span>${z.text}</span>`;
    tip.hidden = false;
    tip.style.left = `${Math.min(r.width - 150, Math.max(0, (x(i) / W) * r.width - 70))}px`;
  };
  svg.onmouseleave = () => { tip.hidden = true; cur.setAttribute("visibility", "hidden"); };
}
$("#mk-range").addEventListener("click", (e) => {
  const b = e.target.closest("[data-d]");
  if (!b) return;
  mk.range = +b.dataset.d;
  $$("#mk-range button").forEach((x) => x.classList.toggle("on", x === b));
  renderFngChart();
});

function renderDeriv() {
  const list = mk.data.deriv || [];
  if (!list.length) return ($("#mk-deriv").innerHTML = `<p class="muted">暂无数据（Binance 接口不可用）</p>`);
  $("#mk-deriv").innerHTML = list.map((x) => {
    const fr = x.funding * 100, lr = x.long_ratio ?? 0.5;
    const mins = Math.max(0, Math.round((x.next_funding - Date.now() / 1000) / 60));
    return `<div class="mk-dv">
      <div class="mk-dv-h"><b>${esc(x.sym)}</b><span class="mono">${fmtPrice(x.mark)}</span></div>
      <dl class="kv">
        <dt>资金费率</dt><dd><b class="${fr > 0.03 ? "up" : fr < 0 ? "down" : ""}">${fr.toFixed(4)}%</b> <span class="muted">/ 8h · 年化 ${(fr * 3 * 365).toFixed(1)}%</span></dd>
        <dt>下次结算</dt><dd>${Math.floor(mins / 60)}h ${mins % 60}m</dd>
        <dt>持仓量</dt><dd><b>${fmtUsd(x.oi)}</b> <span class="mk-chg ${updn(x.oi_chg)}">${pct(x.oi_chg, 1)}</span> <span class="muted">24h</span></dd>
        <dt>多空账户比</dt><dd><b>${x.ls?.toFixed(2) ?? "—"}</b></dd>
      </dl>
      <div class="mk-ls"><i style="width:${(lr * 100).toFixed(1)}%"></i></div>
      <div class="mk-ls-t"><span class="up">多 ${(lr * 100).toFixed(1)}%</span><span class="down">空 ${((1 - lr) * 100).toFixed(1)}%</span></div>
    </div>`;
  }).join("");
}

function renderCoins() {
  const cs = mk.data.coins || [];
  const IN = getVar("--in"), OUT = getVar("--out");
  $("#mk-coins").innerHTML = cs.length ? `<tr><th>#</th><th>币种</th><th class="num">价格</th><th class="num">24h</th><th class="num">7d</th><th class="num">市值</th><th class="num">24h 成交额</th><th>7 日走势</th></tr>` +
    cs.map((c, i) => `<tr><td class="muted">${i + 1}</td><td><b>${esc(c.sym)}</b> <span class="muted">${esc(c.name)}</span></td>
      <td class="num mono">${fmtPrice(c.price)}</td><td class="num mk-chg ${updn(c.chg24)}">${pct(c.chg24)}</td><td class="num mk-chg ${updn(c.chg7)}">${pct(c.chg7)}</td>
      <td class="num">${fmtUsd(c.mcap)}</td><td class="num">${fmtUsd(c.vol)}</td><td class="spark-td">${sparkSvg(c.spark, (c.chg7 ?? 0) >= 0 ? IN : OUT, 120, 30)}</td></tr>`).join("")
    : `<tr><td class="muted">暂无数据</td></tr>`;
}

$("#mk-refresh").addEventListener("click", () => loadMarket(true));
// 切到本页时渲染（数据 4 分钟内有效就不重新请求）
document.addEventListener("click", (e) => { if (e.target.closest('[data-tab="market"]')) setTimeout(() => loadMarket(), 0); });
document.addEventListener("keydown", (e) => { if (e.key === "3" && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName)) setTimeout(() => loadMarket(), 0); });
loadMarket();
setInterval(() => { if (!document.hidden) loadMarket(true); }, 300000);
