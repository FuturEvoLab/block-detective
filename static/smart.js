// 区块侦探 — 聪明钱：分析钱包的 DEX 交易表现（买过什么、盈亏、胜率），并维护排行榜
// 数据来自 /api/smart（服务端按同一笔交易里的“付出 / 收到”识别买卖，平均成本法算盈亏）

const sm = { last: null };
const GRADE_COLOR = { S: "#ffc93c", A: "#22ffa6", B: "#00e5ff", C: "#9fb3c8", D: "#ff3b6b" };
const pnlCls = (v) => (v == null ? "" : v >= 0 ? "up" : "down");
const signUsd = (v) => (v == null ? "—" : (v >= 0 ? "+" : "-") + fmtUsd(Math.abs(v)));
const fmtDur = (s) => {
  if (s == null) return "—";
  const h = s / 3600;
  return h < 1 ? `${Math.max(1, Math.round(s / 60))} 分钟` : h < 48 ? `${h.toFixed(1)} 小时` : `${(h / 24).toFixed(1)} 天`;
};
const STATUS_TEXT = { closed: "已清仓", partial: "部分卖出", holding: "持有中" };

async function smartAnalyze(chain, address) {
  switchTab("smart");
  address = normAddr(chain, address);
  $("#sm-chain").value = chain;
  $("#sm-addr").value = address;
  $("#sm-msg").innerHTML = "";
  $("#sm-result").innerHTML = `<div class="card sm-loading"><svg class="reactor loader-reactor" viewBox="0 0 32 32" aria-hidden="true">
      <circle class="ring" cx="16" cy="16" r="12" fill="none" stroke="var(--accent)" stroke-width="1.8" stroke-dasharray="5 2.6"/>
      <circle class="core" cx="16" cy="16" r="5" fill="var(--accent)"/></svg>
    <div class="scanbar"><i></i></div><p>正在拉取最近约 1000 笔转账并还原买卖记录…</p></div>`;
  try {
    const d = await api(`/api/smart?chain=${chain}&address=${encodeURIComponent(address)}`);
    sm.last = d;
    renderSmart(d);
    loadBoard();
  } catch (e) {
    $("#sm-result").innerHTML = "";
    $("#sm-msg").innerHTML = `<div class="err">${esc(e.message)}</div>`;
  }
}

$("#sm-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const a = $("#sm-addr").value.trim();
  if (!a) return toast("请输入地址");
  smartAnalyze($("#sm-chain").value, a);
});

function renderSmart(d) {
  const { chain, address } = d;
  const lbl = labelOf(chain, address);
  const gc = GRADE_COLOR[d.grade];
  d.warnings = (d.warnings || []).filter((w) => !w.startsWith("只取了最近"));
  const warn = d.warnings?.length ? `<div class="msg"><div>${esc(d.warnings.join("；"))}</div></div>` : "";
  if (!d.trades) {
    $("#sm-result").innerHTML = `${warn}<div class="card"><p class="muted">在最近 ${d.transfers} 笔转账里没有识别出用原生币或稳定币买卖代币的交易。这个地址可能是交易所、合约、机器人，或主要做代币之间的互换（已跳过 ${d.swaps_skipped} 笔）。</p></div>`;
    return;
  }
  const wr = d.win_rate == null ? null : d.win_rate * 100;
  const R = 34, C = 2 * Math.PI * R;
  const k = (key, v, sub, cls = "") => `<div class="kpi ${cls}"><div class="k">${key}</div><div class="v">${v}</div><div class="s">${sub}</div></div>`;

  // 盈亏分布：前 12 个代币的已实现 + 未实现
  const top = d.positions.slice().sort((a, b) => Math.abs(b.realized + (b.unrealized || 0)) - Math.abs(a.realized + (a.unrealized || 0))).slice(0, 12);
  const maxAbs = Math.max(1, ...top.map((p) => Math.abs(p.realized + (p.unrealized || 0))));
  const bars = top.map((p) => {
    const v = p.realized + (p.unrealized || 0), w = (Math.abs(v) / maxAbs) * 50;
    return `<div class="sm-bar"><span class="sym" title="${esc(p.name || p.symbol)}">${esc(p.symbol)}</span><div class="track"><i class="${pnlCls(v)}" style="${v >= 0 ? `left:50%` : `right:50%`};width:${w.toFixed(1)}%"></i></div><b class="${pnlCls(v)}">${signUsd(v)}</b></div>`;
  }).join("");

  const buys = d.recent.filter((t) => t.side === "buy").slice(0, 10);

  $("#sm-result").innerHTML = `${warn}
  <div class="card sm-head" style="--gc:${gc}">
    <div class="sm-grade">
      <svg viewBox="0 0 80 80" aria-hidden="true"><circle cx="40" cy="40" r="${R}" class="trk"/><circle cx="40" cy="40" r="${R}" class="val" stroke-dasharray="${((d.score / 100) * C).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 40 40)"/></svg>
      <b>${d.grade}</b><small>${d.score}</small>
    </div>
    <div class="sm-id">
      <div class="sm-name">${esc(nameOf(chain, address))} ${catBadge(lbl)} ${d.smart ? `<span class="sm-tag">聪明钱</span>` : ""} ${botBadge(d.bot)}</div>
      <div class="mono muted">${esc(address)} · ${esc(state.chains[chain]?.name || chain)}</div>
      ${d.bot?.reasons?.length ? `<ul class="sm-bot">${d.bot.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
      <div class="muted sm-span">分析了最近 ${d.transfers} 笔转账 · 识别出 ${d.trades} 笔买卖 · ${d.first_trade ? fmtTime(d.first_trade, false) + " ~ " + fmtTime(d.last_trade, false) : ""}</div>
    </div>
    <div class="sm-acts">
      <button type="button" class="primary small" data-sm="label">标为聪明钱</button>
      <button type="button" class="small" data-sm="watch">${isWatched(chain, address) ? "已在监控" : "加入监控"}</button>
      <button type="button" class="small" data-sm="flow">资金流向图</button>
    </div>
  </div>
  <div class="kpis sm-kpis">
    ${k("胜率", wr == null ? "—" : `<span class="${wr >= 50 ? "up" : "down"}">${wr.toFixed(0)}%</span>`, `${d.wins} / ${d.sold_tokens} 个卖出过的代币盈利`)}
    ${k("已实现盈亏", `<span class="${pnlCls(d.realized)}">${signUsd(d.realized)}</span>`, "卖出部分的利润")}
    ${k("未实现盈亏", `<span class="${pnlCls(d.unrealized)}">${signUsd(d.unrealized)}</span>`, "仍持有部分按现价估算")}
    ${k("总投入", fmtUsd(d.invested), `<span>${d.tokens} 个代币</span> · <span>单笔中位数 ${fmtUsd(d.median_buy)}</span>`)}
    ${k("收益率", `<span class="${pnlCls(d.roi)}">${d.roi == null ? "—" : (d.roi >= 0 ? "+" : "") + d.roi.toFixed(1) + "%"}</span>`, "（已实现 + 未实现）÷ 投入")}
    ${k("平均持仓", fmtDur(d.avg_hold), "已清仓代币从买到卖")}
    ${k("最近交易", d.last_trade ? ago(d.last_trade) : "—", `代币互换 ${d.swaps_skipped} 笔未计入`)}
  </div>
  <div class="sm-two">
    <div class="card"><div class="card-head"><h3>盈亏分布</h3><span class="spacer"></span><span class="muted">按代币 · 已实现 + 未实现</span></div><div class="sm-bars">${bars}</div></div>
    <div class="card"><div class="card-head"><h3>最近买入</h3><span class="spacer"></span><span class="muted">它在买什么</span></div>
      <div class="sm-buys">${buys.map((t) => `<div><span class="mono muted">${fmtTime(t.ts).slice(5)}</span><b>${esc(t.symbol)}</b><span class="num">${fmtUsd(t.usd)}</span>${tokenLink(chain, t.token)}</div>`).join("") || `<p class="muted">暂无</p>`}</div></div>
  </div>
  <div class="card">
    <div class="card-head"><h3>代币持仓与盈亏</h3><span class="chip">${d.positions.length}</span></div>
    <div class="table-wrap tall"><table class="sm-pos"><tr><th>代币</th><th>状态</th><th class="num">买 / 卖</th><th class="num">投入</th><th class="num">卖出所得</th><th class="num">已实现</th><th class="num">未实现</th><th class="num">收益率</th><th>首次买入</th><th class="num">持有时长</th></tr>
    ${d.positions.map((p) => `<tr><td><b>${esc(p.symbol)}</b> ${p.name ? `<span class="muted">${esc(p.name)}</span>` : ""} ${tokenLink(chain, p.token)}</td>
      <td><span class="sm-st ${p.status}">${STATUS_TEXT[p.status]}</span></td><td class="num">${p.buys} / ${p.sells}</td>
      <td class="num">${fmtUsd(p.cost)}</td><td class="num">${p.proceeds ? fmtUsd(p.proceeds) : "—"}</td>
      <td class="num ${pnlCls(p.sells ? p.realized : null)}">${p.sells ? signUsd(p.realized) : "—"}</td>
      <td class="num ${pnlCls(p.unrealized)}">${p.status === "closed" ? "—" : signUsd(p.unrealized)}</td>
      <td class="num ${pnlCls(p.roi)}">${p.roi == null ? "—" : (p.roi >= 0 ? "+" : "") + p.roi.toFixed(0) + "%"}</td>
      <td>${fmtTime(p.first, false)}</td><td class="num">${fmtDur(p.hold)}</td></tr>`).join("")}</table></div>
  </div>
  <div class="card">
    <div class="card-head"><h3>最近买卖记录</h3></div>
    <div class="table-wrap"><table><tr><th>时间</th><th>方向</th><th>代币</th><th class="num">数量</th><th class="num">美元</th><th>交易</th></tr>
    ${d.recent.slice(0, 40).map((t) => `<tr><td>${fmtTime(t.ts)}</td><td><span class="dir ${t.side === "buy" ? "in" : "out"}">${t.side === "buy" ? "买入" : "卖出"}</span></td><td><b>${esc(t.symbol)}</b></td>
      <td class="num">${fmtNum(t.qty)}</td><td class="num">${fmtUsd(t.usd)}</td><td><a class="mono" href="${explorerTx(chain, t.hash)}" target="_blank" rel="noopener">${short(t.hash)}</a></td></tr>`).join("")}</table></div>
  </div>
  <p class="muted sm-note">说明：只统计用原生币、WETH 或主流稳定币直接买卖的交易，代币之间互换、跨链和中心化交易所内的交易不在其中；只看最近约 1000 笔转账；原生币按交易当天价格、持仓按 DexScreener 现价估算。结果仅供参考，不构成投资建议。</p>`;
}

// 机器人标记：满足 2 条及以上特征为“疑似机器人”，1 条为“有机器人特征”
function botBadge(bot) {
  if (!bot?.points) return "";
  const tip = esc(bot.reasons.map((r) => tr(r)).join("\n"));
  // 自己翻译好再标 translate="no"，避免翻译层把已翻译的提示文字再处理一遍
  return `<span class="sm-bot-tag ${bot.likely ? "" : "weak"}" title="${tip}" translate="no">${esc(tr(bot.likely ? "疑似机器人" : "有机器人特征"))}</span>`;
}

function tokenLink(chain, token) {
  const base = { eth: "https://etherscan.io", bsc: "https://bscscan.com", polygon: "https://polygonscan.com", arbitrum: "https://arbiscan.io", base: "https://basescan.org", optimism: "https://optimistic.etherscan.io" }[chain];
  return base ? `<a class="sm-tok" href="${esc(`${base}/token/${encodeURIComponent(token)}`)}" target="_blank" rel="noopener" title="${esc(token)}">↗</a>` : "";
}

$("#sm-result").addEventListener("click", async (e) => {
  const act = e.target.closest("[data-sm]")?.dataset.sm, d = sm.last;
  if (!act || !d) return;
  const { chain, address } = d;
  if (act === "flow") analyze(chain, address);
  if (act === "watch") quickWatch(chain, address);
  if (act === "label" && await tagSmart(d)) { renderSmart(d); loadBoard(); }
});

async function loadBoard() {
  try {
    const list = await api("/api/smart/board");
    $("#sm-count").textContent = list.length;
    $("#sm-board").innerHTML = list.length ? `<tr><th>评级</th><th>地址</th><th>链</th><th class="num">胜率</th><th class="num">已实现</th><th class="num">未实现</th><th class="num">收益率</th><th class="num">交易</th><th>最近交易</th><th>分析于</th><th></th></tr>` +
      list.map((r) => `<tr><td><span class="sm-g" style="--gc:${GRADE_COLOR[r.grade]}">${r.grade}<small>${r.score}</small></span></td>
        <td>${addrLink(r.chain, r.address)} ${catBadge(labelOf(r.chain, r.address))} ${botBadge(r.bot)}</td><td>${esc(state.chains[r.chain]?.name || r.chain)}</td>
        <td class="num">${r.win_rate == null ? "—" : Math.round(r.win_rate * 100) + "%"} <span class="muted">${r.wins}/${r.sold_tokens}</span></td>
        <td class="num ${pnlCls(r.realized)}">${signUsd(r.realized)}</td><td class="num ${pnlCls(r.unrealized)}">${signUsd(r.unrealized)}</td>
        <td class="num ${pnlCls(r.roi)}">${r.roi == null ? "—" : (r.roi >= 0 ? "+" : "") + r.roi.toFixed(0) + "%"}</td><td class="num">${r.trades}</td>
        <td>${r.last_trade ? ago(r.last_trade) : "—"}</td><td>${fmtTime(r.analyzed).slice(5)}</td>
        <td class="row-acts"><button type="button" class="small" data-re="${esc(r.chain)}|${esc(r.address)}">重新分析</button><button type="button" class="small ghost" data-del="${esc(r.chain)}:${esc(r.address)}">删除</button></td></tr>`).join("")
      : `<tr><td class="muted">还没有分析过的钱包。输入地址开始，或在资金流向图里点节点详情的“交易表现”。</td></tr>`;
  } catch (e) { toast(e.message, 4000); }
}
$("#sm-board").addEventListener("click", async (e) => {
  const re = e.target.closest("[data-re]"), del = e.target.closest("[data-del]");
  if (re) { const [c, a] = re.dataset.re.split("|"); smartAnalyze(c, a); }
  if (del && confirm("从排行榜删除这个钱包？")) { await api(`/api/smart/board?key=${encodeURIComponent(del.dataset.del)}`, { method: "DELETE" }); loadBoard(); }
});
document.addEventListener("click", (e) => { if (e.target.closest('[data-tab="smart"]')) loadBoard(); });
loadBoard();

async function tagSmart(d) {
  const { chain, address } = d;
  const name = prompt("标签名称：", labelOf(chain, address)?.label || `聪明钱 ${short(address)}`);
  if (name == null) return false;
  const note = `评级 ${d.grade}（${d.score} 分）· 胜率 ${d.win_rate == null ? "—" : Math.round(d.win_rate * 100) + "%"} · 已实现 ${signUsd(d.realized)} · ${fmtTime(d.analyzed, false)} 分析`;
  await saveLabel(labelKey(chain, address), name, "聪明钱", note, "交易表现分析");
  loadAlerts();
  return true;
}

// ---------------------------------------------------------------- 从代币发现聪明钱
// 服务端后台任务：拉代币最早 / 最近的 1000 笔转账，找出从交易池买入的钱包，逐个分析；这里每 1.5 秒取一次进度

const sd = { job: null, timer: 0 };
$("#sd-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const token = $("#sd-token").value.trim(), chain = $("#sm-chain").value;
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) return toast("请输入代币的合约地址（0x 开头的 42 位）");
  clearTimeout(sd.timer);
  try {
    sd.job = await api(`/api/smart/discover?chain=${chain}&token=${token}&mode=${$("#sd-mode").value}&n=${$("#sd-n").value}`, { method: "POST" });
    renderDiscover();
    pollDiscover();
  } catch (err) { toast(err.message, 4000); }
});
async function pollDiscover() {
  if (!sd.job) return;
  try { sd.job = await api(`/api/smart/discover?job=${sd.job.id}`); } catch (err) { $("#sd-status").innerHTML = `<div class="msg"><div class="err">${esc(err.message)}</div></div>`; return; }
  renderDiscover();
  if (!["done", "error"].includes(sd.job.stage)) sd.timer = setTimeout(pollDiscover, 1500);
  else loadBoard();
}
$("#sd-nobot").addEventListener("change", renderDiscover);

function renderDiscover() {
  const j = sd.job;
  if (!j) return;
  const t = j.token || {};
  const stageText = { start: "准备中…", token: "正在读取代币信息…", wallets: `正在分析钱包 ${j.done} / ${j.total}…`, done: `完成：分析了 ${j.done} 个钱包`, error: "失败" }[j.stage];
  $("#sd-status").innerHTML = `
    ${t.symbol ? `<div class="sd-token"><b>${esc(t.symbol)}</b><span class="muted">${esc(t.name || "")}</span>
      <span>${t.price != null ? fmtUsd(t.price) : ""}</span><span class="muted">流动性 ${fmtUsd(t.liquidity)}</span>${t.created ? `<span class="muted">上线 ${fmtTime(t.created, false)}</span>` : ""}
      ${j.buyers ? `<span class="muted">样本 ${j.sample} 笔转账里找到 ${j.buyers} 个买家</span>` : ""}</div>` : ""}
    <div class="sd-prog"><span>${stageText}</span>${j.current && j.stage === "wallets" ? `<span class="mono muted">${esc(short(j.current))}</span>` : ""}</div>
    ${j.stage !== "done" && j.stage !== "error" ? `<div class="progress"><i style="width:${j.total ? (j.done / j.total) * 100 : 5}%"></i></div>` : ""}
    ${j.error ? `<div class="msg"><div class="err">${esc(j.error)}</div></div>` : ""}`;
  const hideBots = $("#sd-nobot").checked;
  const rows = j.results.filter((r) => !r.error && r.trades).sort((a, b) => b.score - a.score);
  const shown = rows.filter((r) => !(hideBots && r.bot?.likely));
  const bots = rows.length - shown.length, empty = j.results.length - rows.length;
  $("#sd-table").innerHTML = !j.results.length ? "" :
    `<tr><th>评级</th><th>钱包</th><th class="num">${j.mode === "early" ? "第几个买家" : "买入次数"}</th><th class="num">胜率</th><th class="num">已实现</th><th class="num">收益率</th><th class="num">本币盈亏</th><th>首次买入本币</th><th></th></tr>` +
    shown.map((r, i) => `<tr><td><span class="sm-g" style="--gc:${GRADE_COLOR[r.grade]}">${r.grade}<small>${r.score}</small></span></td>
      <td>${addrLink(r.chain, r.address)} ${catBadge(labelOf(r.chain, r.address))} ${botBadge(r.bot)}</td>
      <td class="num">${j.mode === "early" ? "#" + r.rank : r.buys}</td>
      <td class="num">${r.win_rate == null ? "—" : Math.round(r.win_rate * 100) + "%"} <span class="muted">${r.wins}/${r.sold_tokens}</span></td>
      <td class="num ${pnlCls(r.realized)}">${signUsd(r.realized)}</td>
      <td class="num ${pnlCls(r.roi)}">${r.roi == null ? "—" : (r.roi >= 0 ? "+" : "") + r.roi.toFixed(0) + "%"}</td>
      <td class="num ${pnlCls(r.token_pnl)}">${r.token_pnl == null ? "—" : signUsd(r.token_pnl)}${r.token_status ? ` <span class="sm-st ${r.token_status}">${STATUS_TEXT[r.token_status]}</span>` : ""}</td>
      <td>${fmtTime(r.first)}</td>
      <td class="row-acts"><button type="button" class="small" data-sd="open" data-i="${j.results.indexOf(r)}">详情</button><button type="button" class="small ghost" data-sd="tag" data-i="${j.results.indexOf(r)}">打标签</button></td></tr>`).join("") +
    (bots || empty ? `<tr><td colspan="9" class="muted">${bots ? `已隐藏 ${bots} 个疑似机器人。` : ""}${empty ? `另有 ${empty} 个钱包没有识别出可计价的买卖（多为代币互换或只买未卖）。` : ""}</td></tr>` : "");
}
$("#sd-table").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-sd]");
  if (!b) return;
  const r = sd.job.results[+b.dataset.i];
  if (b.dataset.sd === "open") { smartAnalyze(r.chain, r.address); window.scrollTo({ top: 0, behavior: "smooth" }); }
  if (b.dataset.sd === "tag" && await tagSmart(r)) renderDiscover();
});

// ---------------------------------------------------------------- 批量导入

const im = { job: null, timer: 0 };
const ADDR_RE = /0x[0-9a-fA-F]{40}/g;
$("#im-text").addEventListener("input", () => {
  const n = new Set(($("#im-text").value.match(ADDR_RE) || []).map((a) => a.toLowerCase())).size;
  $("#im-count").textContent = n ? `识别到 ${n} 个地址` : "";
});
$("#im-run").addEventListener("click", async () => {
  const text = $("#im-text").value;
  if (!(text.match(ADDR_RE) || []).length) return toast("没有找到 0x 开头的钱包地址");
  clearTimeout(im.timer);
  try {
    im.job = await api("/api/smart/import", { method: "POST", body: { chain: $("#sm-chain").value, text } });
    renderImport(); pollImport();
  } catch (e) { toast(e.message, 4000); }
});
async function pollImport() {
  try { im.job = await api(`/api/smart/discover?job=${im.job.id}`); } catch (e) { $("#im-status").innerHTML = `<div class="msg"><div class="err">${esc(e.message)}</div></div>`; return; }
  renderImport();
  if (!["done", "error"].includes(im.job.stage)) im.timer = setTimeout(pollImport, 1500);
  else loadBoard();
}
function renderImport() {
  const j = im.job;
  if (!j) return;
  const running = !["done", "error"].includes(j.stage);
  $("#im-run").disabled = running;
  $("#im-status").innerHTML = `<div class="sd-prog"><span>${running ? `正在分析钱包 ${j.done} / ${j.total}…` : j.stage === "error" ? "失败" : `完成：分析了 ${j.done} 个钱包`}</span>
      ${j.truncated ? `<span class="muted">找到 ${j.found} 个地址，只分析前 60 个</span>` : ""}${j.skipped_known ? `<span class="muted">跳过 ${j.skipped_known} 个已知交易所 / 合约</span>` : ""}</div>
    ${running ? `<div class="progress"><i style="width:${j.total ? (j.done / j.total) * 100 : 5}%"></i></div>` : ""}
    ${j.error ? `<div class="msg"><div class="err">${esc(j.error)}</div></div>` : ""}`;
  const rows = j.results.filter((r) => !r.error && r.trades).sort((a, b) => b.score - a.score);
  const hideBots = $("#sd-nobot").checked, shown = rows.filter((r) => !(hideBots && r.bot?.likely));
  const errs = j.results.filter((r) => r.error).length, empty = j.results.length - rows.length - errs;
  $("#im-table").innerHTML = !j.results.length ? "" :
    `<tr><th>评级</th><th>钱包</th><th class="num">胜率</th><th class="num">已实现</th><th class="num">收益率</th><th class="num">单笔中位数</th><th class="num">交易</th><th>最近交易</th><th></th></tr>` +
    shown.map((r) => `<tr><td><span class="sm-g" style="--gc:${GRADE_COLOR[r.grade]}">${r.grade}<small>${r.score}</small></span></td>
      <td>${addrLink(r.chain, r.address)} ${catBadge(labelOf(r.chain, r.address))} ${botBadge(r.bot)} ${r.smart ? '<span class="sm-tag">聪明钱</span>' : ""}</td>
      <td class="num">${r.win_rate == null ? "—" : Math.round(r.win_rate * 100) + "%"} <span class="muted">${r.wins}/${r.sold_tokens}</span></td>
      <td class="num ${pnlCls(r.realized)}">${signUsd(r.realized)}</td>
      <td class="num ${pnlCls(r.roi)}">${r.roi == null ? "—" : (r.roi >= 0 ? "+" : "") + r.roi.toFixed(0) + "%"}</td>
      <td class="num">${fmtUsd(r.median_buy)}</td><td class="num">${r.trades}</td><td>${r.last_trade ? ago(r.last_trade) : "—"}</td>
      <td class="row-acts"><button type="button" class="small" data-im="open" data-i="${j.results.indexOf(r)}">详情</button><button type="button" class="small ghost" data-im="tag" data-i="${j.results.indexOf(r)}">打标签</button></td></tr>`).join("") +
    (rows.length - shown.length || empty || errs ? `<tr><td colspan="9" class="muted">${rows.length - shown.length ? `<span>已隐藏 ${rows.length - shown.length} 个疑似机器人。</span>` : ""}${empty ? `<span>${empty} 个钱包没有识别出可计价的买卖。</span>` : ""}${errs ? `<span>${errs} 个查询失败。</span>` : ""}</td></tr>` : "");
}
$("#im-table").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-im]");
  if (!b) return;
  const r = im.job.results[+b.dataset.i];
  if (b.dataset.im === "open") { smartAnalyze(r.chain, r.address); window.scrollTo({ top: 0, behavior: "smooth" }); }
  if (b.dataset.im === "tag" && await tagSmart(r)) renderImport();
});
$("#sd-nobot").addEventListener("change", renderImport);
