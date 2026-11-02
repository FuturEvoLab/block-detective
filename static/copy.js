// 区块侦探 — 跟单机器人（模拟）与研究数据
// 机器人跑在服务端的后台检查里（和“后台大额提醒”同一个线程、同一个间隔）；这里只负责显示和改规则。

const cp = { book: null, research: null };
const pctTxt = (v, d = 1) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`);
const fmtPx = (v) => (v == null ? "—" : v >= 1 ? "$" + v.toFixed(4) : "$" + v.toPrecision(4));
const holdTxt = (s) => (s == null ? "—" : fmtDur(s));

async function loadCopy() {
  try {
    const [book, research, bt] = await Promise.all([api("/api/copy"), api(`/api/research?source=${$("#rs-source").value}`), api("/api/backtest")]);
    cp.book = book; cp.research = research; cp.bt = bt;
    renderCopy(); renderResearch(); renderBacktest();
    if (bt.stage && !["done", "error"].includes(bt.stage)) pollBacktest();
  } catch (e) { toast(e.message, 4000); }
}

async function saveCopy(body) {
  try { cp.book = await api("/api/copy", { method: "POST", body }); renderCopy(); } catch (e) { toast(e.message, 4000); }
}

function renderCopy() {
  const b = cp.book, st = b.settings;
  $("#cp-enabled").checked = st.enabled;
  $$("#tab-copy [data-k]").forEach((el) => {
    if (document.activeElement === el) return;
    if (el.type === "checkbox") el.checked = !!st[el.dataset.k]; else el.value = st[el.dataset.k];
  });
  const badge = $("#cp-state");
  badge.className = `badge ${st.enabled ? "ok" : ""}`;
  badge.textContent = st.enabled ? "运行中" : "已停止";

  const warn = [];
  // 健康检查：开着机器人却很久没跑，多半是服务停了；上次检查出错也要让人看到
  // 刚启动时第一次检查要等约 1 分钟，不算“停了”
  const nowS = Date.now() / 1000;
  const stale = st.enabled && (b.last_run ? nowS - b.last_run > b.interval * 60 * 3 : nowS - b.started > 180);
  if (stale) warn.push(`<div class="err"><span>机器人已超过 ${b.interval * 3} 分钟没有检查。</span> <span>请确认区块侦探服务在运行（关掉终端窗口会停止）。</span></div>`);
  const dl = b.discover_log?.[0];
  if (b.discovering) warn.push(`<div class="info"><span>正在从今天的热门代币里自动寻找新钱包…</span></div>`);
  else if (dl && st.auto_discover) warn.push(`<div class="info"><span>上次自动扩充 ${fmtTime(dl.ts).slice(5)}：</span> <span>${esc(dl.tokens.join(" / ") || "—")}</span> <span>新增 ${dl.added} 个钱包</span>${dl.error ? ` <span class="down">${esc(dl.error)}</span>` : ""}</div>`);
  if (b.last_error) warn.push(`<div class="err"><span>上次检查有错误：</span>${esc(b.last_error)}</div>`);
  if (!b.smart_wallets) warn.push(`<div>还没有可跟的钱包：在“聪明钱”页给钱包打“聪明钱”标签，或让排行榜里有 A 级以上、非机器人的钱包。</div>`);
  else warn.push(`<div class="info"><span>正在跟踪 ${b.smart_wallets} 个钱包（其中 ${b.labeled_wallets} 个是你标记的）。</span> <span>跟单 ${b.copy_wallets} 个，其余只记录研究数据。</span>${st.enabled ? ` <span>每 ${b.interval} 分钟检查一次。</span>` : ""}${b.last_run ? ` <span>上次检查 ${fmtTime(b.last_run).slice(5)}</span>` : ""}</div>`);
  $("#cp-status").innerHTML = warn.join("");

  const open = b.positions.filter((p) => p.status === "open"), closed = b.positions.filter((p) => p.status === "closed");
  const realized = closed.reduce((a, p) => a + p.pnl, 0), unreal = open.reduce((a, p) => a + (p.pnl || 0), 0);
  const wins = closed.filter((p) => p.pnl > 0).length;
  const avg = closed.length ? closed.reduce((a, p) => a + p.pnl_pct, 0) / closed.length : null;
  const k = (key, v, sub) => `<div class="kpi"><div class="k">${key}</div><div class="v">${v}</div><div class="s">${sub}</div></div>`;
  const money = (v) => `<span class="${pnlCls(v)}">${signUsd(v)}</span>`;
  $("#cp-kpis").innerHTML = [
    k("总盈亏", money(realized + unreal), `<span>已扣 Gas 和价格冲击</span> · <span>Gas ≈ ${fmtUsd(b.gas_now)}/笔</span>`),
    k("已实现", money(realized), `${closed.length} 笔已平仓`),
    k("浮动盈亏", money(unreal), `${open.length} 笔持仓中`),
    k("胜率", closed.length ? `<span class="${wins / closed.length >= 0.5 ? "up" : "down"}">${Math.round((wins / closed.length) * 100)}%</span>` : "—", `${wins} / ${closed.length} 笔盈利`),
    k("平均每笔", avg == null ? "—" : `<span class="${pnlCls(avg)}">${pctTxt(avg)}</span>`, "已平仓的平均收益率"),
    k("占用资金", fmtUsd(open.reduce((a, p) => a + p.size, 0)), `每笔 ${fmtUsd(st.size)}`),
    k("跳过信号", String(b.skipped.length), "不符合规则的买入"),
  ].join("");

  renderCurve(closed);
  // 按钱包统计
  const byW = new Map();
  for (const p of b.positions) {
    const w = byW.get(p.wallet) || { wallet: p.wallet, chain: p.chain, n: 0, closed: 0, win: 0, pnl: 0, pct: 0 };
    w.n++; w.pnl += p.pnl || 0;
    if (p.status === "closed") { w.closed++; w.win += p.pnl > 0; w.pct += p.pnl_pct; }
    byW.set(p.wallet, w);
  }
  const ws = [...byW.values()].sort((a, b) => b.pnl - a.pnl);
  $("#cp-wallets").innerHTML = ws.length ? `<tr><th>钱包</th><th class="num">跟单</th><th class="num">胜率</th><th class="num">平均收益</th><th class="num">盈亏</th></tr>` +
    ws.map((w) => `<tr><td>${addrLink(w.chain, w.wallet)}</td><td class="num">${w.n}</td><td class="num">${w.closed ? Math.round((w.win / w.closed) * 100) + "%" : "—"}</td>
      <td class="num ${pnlCls(w.closed ? w.pct : null)}">${w.closed ? pctTxt(w.pct / w.closed) : "—"}</td><td class="num ${pnlCls(w.pnl)}">${signUsd(w.pnl)}</td></tr>`).join("")
    : `<tr><td class="muted">还没有跟单记录</td></tr>`;

  const now = Date.now() / 1000;
  $("#cp-open-n").textContent = open.length;
  $("#cp-open").innerHTML = open.length ? `<tr><th>代币</th><th>跟随钱包</th><th>信号时间</th><th class="num">信号金额</th><th class="num">买入价</th><th class="num">现价</th><th class="num">浮动</th><th class="num">持有</th></tr>` +
    open.sort((a, b) => b.entry_ts - a.entry_ts).map((p) => `<tr><td><b>${esc(p.symbol)}</b> ${tokenLink(p.chain, p.token)}</td><td>${addrLink(p.chain, p.wallet)}</td><td>${fmtTime(p.signal_ts)}</td>
      <td class="num">${fmtUsd(p.signal_usd)}</td><td class="num mono">${fmtPx(p.entry_price)}</td><td class="num mono">${fmtPx(p.last_price)}</td>
      <td class="num ${pnlCls(p.pnl)}">${pctTxt(p.pnl_pct)} <span class="muted">${signUsd(p.pnl)}</span>${p.note ? `<div class="cp-pnote">${esc(p.note)}</div>` : ""}</td><td class="num">${holdTxt(now - p.entry_ts)}</td></tr>`).join("")
    : `<tr><td class="muted">没有持仓</td></tr>`;
  $("#cp-closed-n").textContent = closed.length;
  $("#cp-closed").innerHTML = closed.length ? `<tr><th>代币</th><th>跟随钱包</th><th class="num">买入价</th><th class="num">卖出价</th><th class="num">收益</th><th>平仓原因</th><th>平仓时间</th><th class="num">持有</th></tr>` +
    closed.sort((a, b) => b.exit_ts - a.exit_ts).slice(0, 100).map((p) => `<tr><td><b>${esc(p.symbol)}</b> ${tokenLink(p.chain, p.token)}</td><td>${addrLink(p.chain, p.wallet)}</td>
      <td class="num mono">${fmtPx(p.entry_price)}</td><td class="num mono">${fmtPx(p.exit_price)}</td>
      <td class="num ${pnlCls(p.pnl)}">${pctTxt(p.pnl_pct)} <span class="muted">${signUsd(p.pnl)}</span></td><td><span class="cp-reason">${esc(p.exit_reason)}</span></td>
      <td>${fmtTime(p.exit_ts)}</td><td class="num">${holdTxt(p.exit_ts - p.entry_ts)}</td></tr>`).join("")
    : `<tr><td class="muted">还没有平仓记录</td></tr>`;
  $("#cp-skipped").innerHTML = b.skipped.length ? `<tr><th>时间</th><th>代币</th><th>钱包</th><th class="num">信号金额</th><th>原因</th></tr>` +
    b.skipped.slice(0, 30).map((p) => `<tr><td>${fmtTime(p.signal_ts)}</td><td><b>${esc(p.symbol)}</b></td><td>${addrLink(p.chain, p.wallet)}</td><td class="num">${fmtUsd(p.signal_usd)}</td><td class="muted">${esc(p.reason)}</td></tr>`).join("")
    : `<tr><td class="muted">没有被跳过的信号</td></tr>`;
}

// 收益曲线：已平仓按时间累计
function renderCurve(closed) {
  const box = $("#cp-curve");
  const pts = closed.slice().sort((a, b) => a.exit_ts - b.exit_ts);
  if (pts.length < 2) return (box.innerHTML = `<p class="muted">有 2 笔以上平仓后，这里会画出累计盈亏曲线。</p>`);
  let acc = 0;
  const ys = [0, ...pts.map((p) => (acc += p.pnl))];
  const W = 600, H = 180, L = 46, R = 8, T = 10, B = 20;
  const min = Math.min(0, ...ys), max = Math.max(0, ...ys), rng = max - min || 1;
  const x = (i) => L + (i / (ys.length - 1)) * (W - L - R), y = (v) => T + (1 - (v - min) / rng) * (H - T - B);
  const line = ys.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join("");
  const last = ys[ys.length - 1], color = last >= 0 ? getVar("--in") : getVar("--out");
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" class="zero"/>
    <text x="${L - 6}" y="${y(max) + 4}" text-anchor="end">${signUsd(max)}</text><text x="${L - 6}" y="${y(min) + 4}" text-anchor="end">${signUsd(min)}</text>
    <path d="${line}L${x(ys.length - 1)} ${y(0)}L${x(0)} ${y(0)}Z" fill="${color}" opacity=".1"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="1.8" vector-effect="non-scaling-stroke" style="filter:drop-shadow(0 0 3px ${color})"/>
    <text x="${L}" y="${H - 4}">${fmtTime(pts[0].exit_ts, false)}</text><text x="${W - R}" y="${H - 4}" text-anchor="end">${fmtTime(pts[pts.length - 1].exit_ts, false)}</text></svg>`;
}

function renderResearch() {
  const r = cp.research;
  if (!r) return;
  $("#rs-info").innerHTML = `<span>共 ${r.total} 个信号 · 买入 ${r.buys} · 已有 24h 结果 ${r.with_24h} · 跟踪中 ${r.open}</span> <span>（实时 ${r.sources.live} · 回测 ${r.sources.backtest}）</span>`;
  const H = { r1h: "1 小时", r6h: "6 小时", r24h: "24 小时", r3d: "3 天", r7d: "7 天" };
  const pc = (v) => (v == null ? "—" : `<span class="${pnlCls(v)}">${pctTxt(v * 100)}</span>`);
  $("#rs-horizons").innerHTML = `<table class="rs-h"><tr><th>聪明钱买入后</th>${Object.values(H).map((h) => `<th class="num">${h}</th>`).join("")}</tr>
    <tr><td class="muted">样本数</td>${Object.keys(H).map((k) => `<td class="num">${r.horizons[k].n}</td>`).join("")}</tr>
    <tr><td class="muted">平均涨跌</td>${Object.keys(H).map((k) => `<td class="num">${pc(r.horizons[k].avg)}</td>`).join("")}</tr>
    <tr><td class="muted">中位数</td>${Object.keys(H).map((k) => `<td class="num">${pc(r.horizons[k].median)}</td>`).join("")}</tr>
    <tr><td class="muted">上涨比例</td>${Object.keys(H).map((k) => `<td class="num">${r.horizons[k].win == null ? "—" : Math.round(r.horizons[k].win * 100) + "%"}</td>`).join("")}</tr></table>`;
  $("#rs-factors").innerHTML = r.with_24h ? r.factors.filter((f) => f.buckets.length).map((f) => {
    const maxAbs = Math.max(0.0001, ...f.buckets.map((b) => Math.abs(b.avg || 0)));
    return `<div class="rs-f"><div class="rs-fh">${esc(f.name)}</div>${f.buckets.sort((a, b) => (b.avg ?? 0) - (a.avg ?? 0)).map((b) =>
      `<div class="rs-b"><span class="key">${esc(b.key)}</span><span class="n muted">n=${b.n}</span>
        <div class="bar"><i class="${pnlCls(b.avg)}" style="width:${((Math.abs(b.avg || 0) / maxAbs) * 100).toFixed(0)}%"></i></div>
        <b class="${pnlCls(b.avg)}">${pctTxt((b.avg || 0) * 100)}</b><span class="muted">${Math.round((b.win || 0) * 100)}%↑</span></div>`).join("")}</div>`;
  }).join("") : `<p class="muted">还没有满 24 小时的信号。机器人启动后，数据会随时间自动积累。</p>`;
  $("#rs-recent").innerHTML = r.recent.length ? `<tr><th>时间</th><th>钱包</th><th>代币</th><th>方向</th><th class="num">金额</th><th>机器人决定</th><th class="num">1h</th><th class="num">24h</th><th class="num">7d</th><th class="num">最高</th></tr>` +
    r.recent.slice(0, 30).map((x) => `<tr><td>${fmtTime(x.ts)}</td><td>${addrLink(x.chain, x.wallet)}</td><td><b>${esc(x.symbol)}</b></td>
      <td><span class="dir ${x.side === "buy" ? "in" : "out"}">${x.side === "buy" ? "买入" : "卖出"}</span></td><td class="num">${fmtUsd(x.signal_usd)}</td>
      <td class="muted">${esc(x.decision || "—")}</td><td class="num">${pc(x.r1h)}</td><td class="num">${pc(x.r24h)}</td><td class="num">${pc(x.r7d)}</td><td class="num">${pc(x.max_ret)}</td></tr>`).join("")
    : `<tr><td class="muted">还没有信号</td></tr>`;
}

$("#cp-enabled").addEventListener("change", (e) => {
  saveCopy({ enabled: e.target.checked });
  toast(e.target.checked ? "机器人已启动（模拟，不会真实下单）" : "机器人已停止");
});
$("#tab-copy").addEventListener("change", (e) => {
  const el = e.target.closest("[data-k]");
  if (el) saveCopy({ [el.dataset.k]: el.type === "checkbox" ? el.checked : +el.value });
});
$("#tab-copy").addEventListener("click", (e) => {
  if (e.target.closest('[data-cp="goto-watch"]')) { switchTab("watch"); $("#alert-card").scrollIntoView({ behavior: "smooth" }); }
});
$("#cp-run").addEventListener("click", async () => {
  const b = $("#cp-run");
  b.disabled = true; b.textContent = "检查中…";
  try { await api("/api/alerts/run", { method: "POST" }); await loadCopy(); toast("检查完成"); } catch (e) { toast(e.message, 4000); }
  b.disabled = false; b.textContent = "立即检查";
});
$("#cp-reset").addEventListener("click", async () => {
  if (!confirm("清空模拟账本（持仓、平仓和跳过记录）？研究数据会保留。")) return;
  cp.book = await api("/api/copy/reset", { method: "POST" });
  renderCopy();
});
document.addEventListener("click", (e) => { if (e.target.closest('[data-tab="copy"]')) loadCopy(); });
document.addEventListener("keydown", (e) => { if (e.key === "5" && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName)) loadCopy(); });
setInterval(() => { if (!document.hidden && $("#tab-copy").classList.contains("active")) loadCopy(); }, 60000);

// ---------------------------------------------------------------- 历史回测

const BT_STAGE = { start: "准备中…", wallets: "读取钱包的历史买卖…", candles: "拉取代币 K 线…", simulate: "按规则重放…", grid: "测试参数组合…", research: "补录研究数据…" };
let btTimer = 0;
function pollBacktest() {
  clearTimeout(btTimer);
  btTimer = setTimeout(async () => {
    try { cp.bt = await api("/api/backtest"); } catch { return; }
    renderBacktest();
    if (!["done", "error"].includes(cp.bt.stage)) pollBacktest();
    else { cp.research = await api(`/api/research?source=${$("#rs-source").value}`); renderResearch(); }
  }, 3000);
}
$("#bt-run").addEventListener("click", async () => {
  try { cp.bt = await api("/api/backtest", { method: "POST" }); renderBacktest(); pollBacktest(); } catch (e) { toast(e.message, 4000); }
});
$("#rs-source").addEventListener("change", async () => { cp.research = await api(`/api/research?source=${$("#rs-source").value}`); renderResearch(); });

const paramTxt = (p) => `<span>信号 ≥${fmtUsd(p.min_signal)}</span> · <span>止损 ${p.sl ? p.sl + "%" : "无"}</span> · <span>止盈 ${p.tp ? p.tp + "%" : "无"}</span> · <span>持有 ≤${p.max_days} 天</span> · <span>${p.follow_sell ? "跟随卖出" : "不跟卖出"}</span>`;

function renderBacktest() {
  const j = cp.bt || {}, size = cp.book?.settings.size || 100;
  const running = j.stage && !["done", "error"].includes(j.stage);
  $("#bt-run").disabled = running;
  $("#bt-info").textContent = j.finished ? `上次回测 ${fmtTime(j.finished).slice(5)}` : "";
  $("#bt-status").innerHTML = running
    ? `<div class="sd-prog"><span>${BT_STAGE[j.stage] || ""}</span>${j.total ? `<span class="mono muted">${j.done} / ${j.total}</span>` : ""}</div><div class="progress"><i style="width:${j.total ? (j.done / j.total) * 100 : 5}%"></i></div>`
    : j.error ? `<div class="msg"><div class="err">${esc(j.error)}</div></div>`
    : j.stage === "done" ? `<div class="msg">${j.skipped_tokens ? `<div><span>还有 ${j.skipped_tokens} 个代币的 K 线没拉完（接口限流）。</span> <span>再点一次“开始回测”会接着补齐。</span></div>` : ""}<div class="info"><span>有 K 线的代币 ${j.priced_tokens} 个，补录研究数据 ${j.backfilled} 条。</span> <span>注意：钱包评级用的是现在的分析结果，回测会偏乐观；参数组合是在同一批历史数据上挑的，有过拟合风险，实盘前请用实时模拟验证。</span></div></div>`
    : "";
  const c = j.current;
  const k = (key, v, sub) => `<div class="kpi"><div class="k">${key}</div><div class="v">${v}</div><div class="s">${sub}</div></div>`;
  const usd = (r) => `<span class="${pnlCls(r)}">${signUsd(r * size)}</span>`;
  $("#bt-kpis").innerHTML = c ? [
    k("回测交易", String(c.n), `已平仓 ${c.closed} 笔`),
    k("胜率", c.win == null ? "—" : `<span class="${c.win >= 0.5 ? "up" : "down"}">${Math.round(c.win * 100)}%</span>`, "收益为正的比例"),
    k("平均每笔", c.avg == null ? "—" : `<span class="${pnlCls(c.avg)}">${pctTxt(c.avg * 100)}</span>`, "含滑点"),
    k("总盈亏", usd(c.total), `每笔 ${fmtUsd(size)}`),
    k("最大回撤", `<span class="down">${signUsd(c.max_dd * size)}</span>`, "累计盈亏从高点回落"),
    k("盈亏比", c.pf == null ? "—" : c.pf.toFixed(2), "总盈利 ÷ 总亏损"),
    k("当前规则排名", j.current_rank ? `#${j.current_rank}` : "—", `共 ${j.grid_size || 0} 组参数`),
  ].join("") : "";
  $("#bt-grid").innerHTML = j.grid?.length ? `<tr><th>#</th><th>参数</th><th class="num">交易</th><th class="num">胜率</th><th class="num">总盈亏</th><th class="num">回撤</th><th></th></tr>` +
    j.grid.map((g, i) => `<tr class="${c && Object.keys(c.params).every((key) => +g.params[key] === +c.params[key]) ? "bt-cur" : ""}"><td>${i + 1}</td><td class="bt-p">${paramTxt(g.params)}</td><td class="num">${g.n}</td>
      <td class="num">${g.win == null ? "—" : Math.round(g.win * 100) + "%"}</td><td class="num">${usd(g.total)}</td><td class="num down">${signUsd(g.max_dd * size)}</td>
      <td><button type="button" class="small ghost" data-bt-apply="${i}">应用</button></td></tr>`).join("") : `<tr><td class="muted">还没有回测结果</td></tr>`;
  $("#bt-wallets").innerHTML = j.wallets?.length ? `<tr><th>钱包</th><th class="num">交易</th><th class="num">胜率</th><th class="num">平均</th><th class="num">总盈亏</th></tr>` +
    j.wallets.map((w) => `<tr><td>${addrLink(w.chain, w.wallet)} ${w.copy ? "" : '<span class="badge">仅研究</span>'}</td><td class="num">${w.n}</td>
      <td class="num">${w.win == null ? "—" : Math.round(w.win * 100) + "%"}</td><td class="num ${pnlCls(w.avg)}">${w.avg == null ? "—" : pctTxt(w.avg * 100)}</td><td class="num">${usd(w.total)}</td></tr>`).join("")
    : `<tr><td class="muted">—</td></tr>`;
  $("#bt-trades").innerHTML = j.trades?.length ? `<tr><th>信号时间</th><th>代币</th><th>钱包</th><th class="num">信号金额</th><th class="num">买入价</th><th class="num">卖出价</th><th class="num">收益</th><th>出场</th><th class="num">持有</th></tr>` +
    j.trades.slice(0, 60).map((t) => `<tr><td>${fmtTime(t.signal_ts)}</td><td><b>${esc(t.symbol)}</b></td><td>${addrLink("eth", t.wallet)}</td><td class="num">${fmtUsd(t.signal_usd)}</td>
      <td class="num mono">${fmtPx(t.entry_price)}</td><td class="num mono">${fmtPx(t.exit_price)}</td><td class="num ${pnlCls(t.ret)}">${pctTxt(t.ret * 100)}</td>
      <td><span class="cp-reason">${esc(t.reason)}</span></td><td class="num">${holdTxt(t.exit_ts - t.entry_ts)}</td></tr>`).join("") : "";
}
$("#bt-grid").addEventListener("click", (e) => {
  const b = e.target.closest("[data-bt-apply]");
  if (!b) return;
  const p = cp.bt.grid[+b.dataset.btApply].params;
  saveCopy(p);
  toast("已应用这组参数到机器人规则");
});
