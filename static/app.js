// 区块侦探 前端
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const CAT_COLORS = { 交易所: "#4f8cff", 名人: "#a78bfa", 机构: "#2dd4bf", 巨鲸: "#38bdf8", 做市商: "#818cf8", 黑客: "#f43f5e", 合约: "#94a3b8", 混币器: "#fb923c", 风险: "#f87171", 嫌疑人: "#e11d48", 聪明钱: "#ffc93c", 其他: "#8b95a7" };
const DIR_TEXT = { in: "← 流入", out: "→ 流出", self: "↺ 自转" };
const METASLEUTH = { eth: "eth", bsc: "bsc", polygon: "polygon", arbitrum: "arbitrum", base: "base", optimism: "optimism", tron: "tron", btc: "btc" };

const state = {
  chains: {},
  labels: {},
  watchlist: [],
  center: null,              // {chain, address}
  fetched: new Map(),        // nodeId -> {chain, address}
  transfers: new Map(),      // 去重后的全部转账
  profiles: new Map(),       // nodeId -> profile
  lastEvents: [],
  session: 0,                // 每次新查询 +1，用来丢弃过期的异步结果
  watchNew: {},
};
let cy;

// ---------------------------------------------------------------- 工具函数

const apiLat = [], apiHist = [];
// 侧栏延迟走势小图（最近 32 次请求）
function drawSpark() {
  const svg = document.getElementById("sys-spark");
  if (!svg || apiHist.length < 2) return;
  const max = Math.max(...apiHist, 50), n = apiHist.length;
  const pts = apiHist.map((v, i) => [(i / (n - 1)) * 100, 20 - (v / max) * 17]);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join("");
  svg.querySelector(".line").setAttribute("d", line);
  svg.querySelector(".area").setAttribute("d", `${line}L100 22L0 22Z`);
  const [lx, ly] = pts[n - 1];
  svg.querySelector("circle").setAttribute("cx", lx); svg.querySelector("circle").setAttribute("cy", ly);
  svg.classList.add("has");
}
async function api(path, opts = {}) {
  const t0 = performance.now();
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: opts.body ? { "Content-Type": "application/json" } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json();
  apiHist.push(performance.now() - t0);
  if (apiHist.length > 32) apiHist.shift();
  drawSpark();
  if (/\/api\/(transfers|profile|watchlist\/refresh)/.test(path)) {
    apiLat.push(performance.now() - t0);
    if (apiLat.length > 5) apiLat.shift();
    const avg = apiLat.reduce((a, b) => a + b, 0) / apiLat.length;
    const el = document.getElementById("sys-lat");
    if (el) el.textContent = avg >= 1000 ? `${(avg / 1000).toFixed(1)} s` : `${Math.round(avg)} ms`;
  }
  if (!res.ok || data.error) throw new Error(data.error || res.statusText);
  return data;
}

function toast(text, ms = 2500) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), ms);
}

const isEvm = (chain) => state.chains[chain]?.type === "evm";
const nid = (chain, addr) => `${chain}:${addr}`;
const normAddr = (chain, a) => (isEvm(chain) ? a.trim().toLowerCase() : a.trim());
const labelKey = (chain, addr) => `${isEvm(chain) ? "evm" : chain}:${addr}`;
const labelOf = (chain, addr) => state.labels[labelKey(chain, addr)];
const short = (a) => (a && a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || "");
const watchOf = (chain, addr) => state.watchlist.find((w) => w.chain === chain && w.address === addr);
const nameOf = (chain, addr) => gl(labelOf(chain, addr)?.label || watchOf(chain, addr)?.label) || short(addr);
const isWatched = (chain, addr) => state.watchlist.some((w) => w.chain === chain && w.address === addr);

function fmtNum(n) {
  if (n == null || isNaN(n)) return "-";
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (a >= 1e4) return (n / 1e3).toFixed(1) + "K";
  if (a >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (a === 0) return "0";
  return n.toPrecision(3);
}
const fmtUsd = (n) => (n == null ? "-" : "$" + fmtNum(n));
function fmtTime(ts, withTime = true) {
  if (!ts) return "-";
  const d = new Date(ts * 1000);
  const p = (x) => String(x).padStart(2, "0");
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return withTime ? `${day} ${p(d.getHours())}:${p(d.getMinutes())}` : day;
}
function ago(ts) {
  if (!ts) return "从未";
  const s = Date.now() / 1000 - ts;
  if (s < 60) return "刚刚";
  if (s < 3600) return Math.floor(s / 60) + " 分钟前";
  if (s < 86400) return Math.floor(s / 3600) + " 小时前";
  return Math.floor(s / 86400) + " 天前";
}

// 链接里的地址 / 哈希可能来自外部数据或别人发来的案件文件：先编码，再由调用处放进 href
const U = (x) => encodeURIComponent(String(x ?? ""));
function explorerAddr(chain, a) {
  if (chain === "tron") return `https://tronscan.org/#/address/${U(a)}`;
  if (chain === "btc") return `https://mempool.space/address/${U(a)}`;
  return `${state.chains[chain]?.explorer || "https://etherscan.io"}/address/${U(a)}`;
}
function explorerTx(chain, h) {
  if (chain === "tron") return `https://tronscan.org/#/transaction/${U(h)}`;
  if (chain === "btc") return `https://mempool.space/tx/${U(h)}`;
  return `${state.chains[chain]?.explorer || "https://etherscan.io"}/tx/${U(h)}`;
}
function externalLinks(chain, a) {
  const links = [["区块浏览器", explorerAddr(chain, a)], ["Arkham", `https://intel.arkm.com/explorer/address/${U(a)}`], ["MetaSleuth", `https://metasleuth.io/result/${METASLEUTH[chain]}/${U(a)}`]];
  if (isEvm(chain)) links.push(["DeBank", `https://debank.com/profile/${U(a)}`]);
  if (chain === "btc") links.push(["OXT", `https://oxt.me/address/${U(a)}`], ["Blockchair", `https://blockchair.com/bitcoin/address/${U(a)}`]);
  return links.map(([t, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener">${t} ↗</a>`).join("");
}
function catBadge(lbl) {
  if (!lbl?.category) return "";
  return `<span class="badge cat" style="--c:${CAT_COLORS[lbl.category] || "#8b95a7"}">${esc(lbl.category)}</span>`;
}
const dirPill = (d) => `<span class="dir ${d}">${DIR_TEXT[d]}</span>`;
const ICON = {
  copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h8"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" style="width:14px;height:14px"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
};
function addrLink(chain, a) {
  return `<span class="addr-link" data-chain="${esc(chain)}" data-addr="${esc(a)}" title="${esc(a)}">${esc(nameOf(chain, a))}</span>`;
}
document.addEventListener("click", (e) => {
  const el = e.target.closest(".addr-link");
  if (el) analyze(el.dataset.chain, el.dataset.addr);
});

function chainOptions(sel, value) {
  sel.innerHTML = Object.entries(state.chains).map(([k, c]) => `<option value="${k}">${c.name}</option>`).join("");
  if (value) sel.value = value;
}

// ---------------------------------------------------------------- 标签页切换

$$(".tabs button").forEach((b) =>
  b.addEventListener("click", () => switchTab(b.dataset.tab))
);
function switchTab(name) {
  if (!$(`#tab-${name}`)) return;
  $$(".tabs button").forEach((x) => x.classList.toggle("active", x.dataset.tab === name));
  $$(".tab").forEach((x) => x.classList.toggle("active", x.id === "tab-" + name));
  if (name === "flow" && cy) cy.resize();
  const h1 = $(`#tab-${name} h1`);
  moveNavIndicator();
  if (h1 && !REDUCED) { h1.dataset.text = h1.textContent; h1.classList.remove("glitch"); void h1.offsetWidth; h1.classList.add("glitch"); }
  document.dispatchEvent(new CustomEvent("bd:tab", { detail: name })); // 扩展页面据此加载自己的数据
}
const tabNames = () => $$(".tabs button").map((b) => b.dataset.tab);
// 导航序号和快捷键按实际顺序编号（扩展可能在中间插入页面）
function renumberNav() {
  $$(".tabs button").forEach((b, i) => {
    b.querySelector(".ni-idx").textContent = String(i + 1).padStart(2, "0");
    if (i < 9 && b.dataset.name) b.title = `${b.dataset.name}（快捷键 ${i + 1}）`; // 中文原文，由 i18n 层翻译
  });
}
renumberNav();

// ---------------------------------------------------------------- 扩展（ext/ 目录里的模块加的页面）
// 服务端 /api/ext 列出每个扩展加的页面：页面内容、脚本、样式、译文都从 /ext/<名字>/ 取，插在“聪明钱”之后
async function loadExtensions() {
  let exts = [];
  try { exts = await api("/api/ext"); } catch { return; } // 在线演示版没有这个接口
  const navAnchor = $('.tabs [data-tab="labels"]'), secAnchor = $("#tab-labels");
  const loadScript = (src) => new Promise((ok, bad) => { const el = document.createElement("script"); el.src = src; el.onload = ok; el.onerror = () => bad(new Error(src)); document.body.appendChild(el); });
  for (const ext of exts) for (const p of ext.pages || []) {
    if (!/^[a-z][a-z0-9_-]*$/.test(p.id) || $(`#tab-${p.id}`)) continue;
    try {
      if (p.i18n) await loadScript(p.i18n); // 译文先到，页面内容插入时才能被翻译
      const html = await (await fetch(p.html)).text();
      for (const href of p.css) { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = href; document.head.appendChild(l); }
      const sec = document.createElement("section"); sec.id = `tab-${p.id}`; sec.className = "tab"; sec.innerHTML = html;
      secAnchor.before(sec);
      const b = document.createElement("button"); b.dataset.tab = p.id; b.dataset.name = p.title;
      b.innerHTML = `<span class="ni-idx"></span><span class="ni-ico">${p.icon || ""}</span><span class="ni-txt"><b>${esc(p.title)}</b><small>${esc(p.sub || "")}</small></span><span class="ni-arrow">›</span>`;
      b.addEventListener("click", () => switchTab(p.id));
      navAnchor.before(b);
      for (const src of p.js) await loadScript(src);
    } catch (e) { console.error(`扩展 ${ext.name} 的页面 ${p.id} 加载失败`, e); }
  }
  renumberNav(); moveNavIndicator();
  document.dispatchEvent(new CustomEvent("bd:ext", { detail: exts }));
}
loadExtensions();

// ---------------------------------------------------------------- 侧边菜单：滑动指示器、点击闪光、折叠

function moveNavIndicator() {
  const btn = $(".nav .tabs button.active"), ind = $("#nav-ind");
  if (!btn || !ind) return;
  ind.style.transform = `translateY(${btn.offsetTop}px)`;
  ind.style.height = `${btn.offsetHeight}px`;
  ind.classList.remove("moving"); void ind.offsetWidth; ind.classList.add("moving");
}
$$(".nav .tabs button").forEach((b) => b.addEventListener("click", (e) => {
  if (REDUCED) return;
  const r = b.getBoundingClientRect();
  const f = document.createElement("span");
  f.className = "nav-flash";
  f.style.left = `${e.clientX - r.left}px`; f.style.top = `${e.clientY - r.top}px`;
  b.appendChild(f);
  setTimeout(() => f.remove(), 600);
}));
function setNavCollapsed(on) {
  $(".app").classList.toggle("nav-collapsed", on);
  try { localStorage.setItem("bd-nav", on ? "1" : "0"); } catch {}
  // 等宽度动画结束后再校正指示器和资金图尺寸
  setTimeout(() => { moveNavIndicator(); if (cy) { cy.resize(); updateReticle(); } }, 420);
}
$("#nav-collapse").addEventListener("click", () => setNavCollapsed(!$(".app").classList.contains("nav-collapsed")));
try { if (localStorage.getItem("bd-nav") === "1") $(".app").classList.add("nav-collapsed"); } catch {}
window.addEventListener("resize", moveNavIndicator);
document.fonts?.ready.then(moveNavIndicator);
requestAnimationFrame(moveNavIndicator);

// ---------------------------------------------------------------- 过滤

function filters() {
  const from = $("#f-from").value ? new Date($("#f-from").value + "T00:00:00").getTime() / 1000 : 0;
  const to = $("#f-to").value ? new Date($("#f-to").value + "T23:59:59").getTime() / 1000 : Infinity;
  return { dir: $("#f-dir").value, token: $("#f-token").value, min: parseFloat($("#f-min").value) || 0, hide: $("#f-hide").checked, from, to, top: parseInt($("#f-top").value) || 30 };
}
function pass(t, f) {
  if (f.hide && !t.verified) return false;
  if (f.token && t.symbol !== f.token) return false;
  if (t.ts < f.from || t.ts > f.to) return false;
  if (f.min > 0 && t.verified && (t.usd ?? 0) < f.min) return false;
  return true;
}
["#f-dir", "#f-token", "#f-min", "#f-from", "#f-to", "#f-hide", "#f-top"].forEach((s) =>
  $(s).addEventListener("change", () => renderAll())
);

// ---------------------------------------------------------------- 获取数据

const apiCache = new Map();
// 定期清掉过期缓存，长时间开着也不会越占越多内存
setInterval(() => { const now = Date.now(); for (const [k, v] of apiCache) if (now - v.t > 110000) apiCache.delete(k); }, 60000);
function cachedApi(url, ttl = 110000) {
  const hit = apiCache.get(url);
  if (hit && Date.now() - hit.t < ttl) return hit.p;
  const p = api(url).catch((e) => { apiCache.delete(url); throw e; });
  apiCache.set(url, { t: Date.now(), p });
  return p;
}
const transfersUrl = (chain, address, kind = "all") =>
  `/api/transfers?chain=${chain}&address=${encodeURIComponent(address)}&limit=${$("#q-limit").value}&kind=${kind}${state.fresh ? `&fresh=${state.session}` : ""}`;
// 按住 Shift 点“开始分析”：跳过服务端 10 分钟的本地缓存，强制重新获取
let shiftDown = false;
addEventListener("keydown", (e) => (shiftDown = e.shiftKey));
addEventListener("keyup", (e) => (shiftDown = e.shiftKey));
addEventListener("pointerdown", (e) => (shiftDown = e.shiftKey), true);
// 代币转账与原生币转账分两批请求：先到的先画，后到的再无缝补进图里
const partsOf = (chain) => (state.chains[chain]?.type === "btc" ? ["all"] : ["token", "native"]);
const prefetchAddress = (chain, address) => partsOf(chain).map((k) => cachedApi(transfersUrl(chain, address, k)).catch(() => {}));

function ingest(data, chain) {
  for (const t of data.transfers) state.transfers.set(`${t.chain}|${t.hash}|${t.from}|${t.to}|${t.token}|${t.amount}`, t);
  state.fetched.set(nid(chain, data.address), { chain, address: data.address });
}

async function fetchAddress(chain, address, onPart) {
  const session = state.session;
  const warnings = new Set();
  let addr = address, count = 0, ok = 0, err = null;
  await Promise.all(partsOf(chain).map(async (k) => {
    try {
      const d = await cachedApi(transfersUrl(chain, address, k));
      if (session !== state.session) return; // 期间用户已经换了查询对象
      ingest(d, chain);
      addr = d.address; count += d.transfers.length; ok++;
      d.warnings.forEach((w) => warnings.add(w));
      onPart?.(d);
    } catch (e) { err ||= e; }
  }));
  if (!ok && err) throw err;
  if (err) warnings.add("部分数据获取失败：" + err.message);
  return { address: addr, count, warnings: [...warnings], stale: session !== state.session };
}

async function analyze(chain, address) {
  switchTab("flow");
  address = normAddr(chain, address);
  $("#q-chain").value = chain;
  $("#q-addr").value = address;
  // 换了链或手动查询新地址时清空画布，从这个地址重新开始
  const session = ++state.session;
  state.fetched.clear();
  state.transfers.clear();
  state.center = { chain, address };
  clearPath(); pathState.from = null;
  if (cy) cy.elements().remove();
  lockOn(null);
  for (const k in kpiLast) kpiLast[k] = 0;
  $("#kpis").dataset.for = "";
  kpiSkeleton();
  setMsg("");
  setBusy(true);
  // 档案（余额、首次活跃）等第一批转账到了再查，不和转账请求抢 Etherscan 的每秒额度
  let profileStarted = false;
  const loadProfile = () => {
    if (profileStarted) return;
    profileStarted = true;
    cachedApi(`/api/profile?chain=${chain}&address=${encodeURIComponent(address)}`)
      .then((p) => {
        if (session !== state.session) return;
        state.profiles.set(nid(chain, p.address), p);
        renderKpis();
        if ($("#side").dataset.id === nid(chain, p.address)) showNode(nid(chain, p.address));
      })
      .catch((e) => session === state.session && setMsg("档案获取失败：" + e.message, true, true));
  };
  try {
    let parts = 0;
    const data = await fetchAddress(chain, address, () => {
      if (parts++ === 0) { $("#graph-loading").hidden = true; renderAll(true); }
      else { renderAll(false); setTimeout(() => cy.animate({ fit: { padding: 40 } }, { duration: 450, easing: "ease-in-out-cubic" }), REDUCED ? 0 : 420); }
      loadProfile();
    });
    state.fresh = false;
    if (data.stale) return;
    loadProfile();
    setMsg(data.warnings.join("；"));
    if (!data.count) setMsg("没有找到转账记录。", false, true);
    pushRecent(chain, data.address);
  } catch (e) {
    if (session !== state.session) return;
    setMsg(e.message, true);
    $("#kpis").innerHTML = "";
    $("#graph-empty").hidden = false;
  } finally {
    state.fresh = false;
    if (session === state.session) setBusy(false);
  }
}

async function expand(chain, address) {
  if (state.fetched.has(nid(chain, address))) return toast("这个地址已经展开过了");
  $("#query button").disabled = true;
  toast("正在展开 " + nameOf(chain, address) + " …");
  try {
    const data = await fetchAddress(chain, address, (d) => renderAll(false, nid(chain, d.address)));
    if (data.stale) return;
    if (data.warnings.length) setMsg(data.warnings.join("；"), false, true);
    const id = nid(chain, data.address);
    setTimeout(() => cy.animate({ fit: { padding: 40 } }, { duration: 500, easing: "ease-in-out-cubic" }), REDUCED ? 0 : 450);
    showNode(id);
  } catch (e) {
    setMsg(e.message, true, true);
  } finally {
    $("#query button").disabled = false;
  }
}

function setMsg(text, isErr = false, append = false) {
  const box = $("#flow-msg");
  if (!append) box.innerHTML = "";
  if (text) box.insertAdjacentHTML("beforeend", `<div class="${isErr ? "err" : ""}">${esc(text)}</div>`);
}
function setBusy(b) {
  $("#query button").disabled = b;
  $("#graph-loading").hidden = !b;
  if (b) $("#graph-empty").hidden = true;
}

$("#query").addEventListener("submit", (e) => {
  e.preventDefault();
  state.fresh = shiftDown;
  if (shiftDown) toast("强制刷新：跳过本地缓存");
  let addr = $("#q-addr").value.trim();
  // datalist 选项格式为 “地址”，若用户粘贴了带标签的文本，只取地址
  addr = addr.split(/\s+/)[0];
  if (!addr) return;
  let chain = $("#q-chain").value;
  // 自动识别链类型
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(addr)) chain = "tron";
  else if (/^(bc1|[13])/.test(addr) && !addr.startsWith("0x")) chain = "btc";
  else if (addr.startsWith("0x") && !isEvm(chain)) chain = "eth";
  // 先在本地检查地址格式，避免无效请求和重复报错
  const ok = { evm: /^0x[0-9a-fA-F]{40}$/, tron: /^T[1-9A-HJ-NP-Za-km-z]{33}$/, btc: /^(bc1[0-9a-z]{25,87}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/ }[state.chains[chain].type];
  if (!ok.test(addr)) return setMsg(`地址格式不正确（${state.chains[chain].name}）：${addr}`, true);
  analyze(chain, addr);
});

// ---------------------------------------------------------------- 渲染

function renderAll(fresh = false, expandedId = null) {
  updateTokenFilter();
  renderGraph(fresh, expandedId);
  renderTimeline();
  renderTable();
  renderKpis();
  if (fresh && state.center) showNode(nid(state.center.chain, state.center.address));
}

function updateTokenFilter() {
  const sel = $("#f-token");
  const cur = sel.value;
  const hide = $("#f-hide").checked;
  const syms = new Set();
  for (const t of state.transfers.values()) if (!hide || t.verified) syms.add(t.symbol);
  sel.innerHTML = `<option value="">全部</option>` + [...syms].sort().map((s) => `<option>${esc(s)}</option>`).join("");
  sel.value = syms.has(cur) ? cur : "";
}

function aggregateEdges(f) {
  const edges = new Map();
  for (const t of state.transfers.values()) {
    if (!pass(t, f) || t.from === t.to) continue;
    const s = nid(t.chain, t.from), d = nid(t.chain, t.to);
    const key = s + ">" + d;
    let e = edges.get(key);
    if (!e) edges.set(key, (e = { id: key, source: s, target: d, chain: t.chain, usd: 0, count: 0, tokens: {}, unpriced: false, list: [] }));
    e.count++;
    e.usd += t.usd || 0;
    if (t.usd == null) e.unpriced = true;
    e.tokens[t.symbol] = (e.tokens[t.symbol] || 0) + t.amount;
    e.list.push(t);
  }
  return edges;
}

function renderGraph(fresh, expandedId) {
  if (!cy) initCy();
  $("#graph-empty").hidden = !!state.center;
  const f = filters();
  const edges = aggregateEdges(f);

  // 每个已展开地址只保留金额最大的前 N 个对手方
  const keep = new Set([...state.fetched.keys(), ...(state.pathKeep || [])]); // 路径追踪涉及的地址始终显示
  const side = new Map(); // 对手方相对父节点的方向，用于摆放位置
  for (const id of state.fetched.keys()) {
    const score = new Map();
    for (const e of edges.values()) {
      let cp, dir;
      if (e.source === id) (cp = e.target), (dir = "out");
      else if (e.target === id) (cp = e.source), (dir = "in");
      else continue;
      if (f.dir && id === centerId() && dir !== f.dir) continue;
      const s = score.get(cp) || { v: 0, dirs: new Set() };
      s.v += e.usd + e.count * 1e-6;
      s.dirs.add(dir);
      score.set(cp, s);
    }
    [...score.entries()].sort((a, b) => b[1].v - a[1].v).slice(0, f.top).forEach(([cp, s], rank) => {
      keep.add(cp);
      if (!side.has(cp)) side.set(cp, { parent: id, dir: s.dirs.size > 1 ? "both" : [...s.dirs][0], rank });
    });
  }

  const volume = new Map(), inVol = new Map(), outVol = new Map();
  const visibleEdges = [...edges.values()].filter((e) => keep.has(e.source) && keep.has(e.target));
  for (const e of visibleEdges) {
    volume.set(e.source, (volume.get(e.source) || 0) + e.usd);
    volume.set(e.target, (volume.get(e.target) || 0) + e.usd);
    outVol.set(e.source, (outVol.get(e.source) || 0) + e.usd);
    inVol.set(e.target, (inVol.get(e.target) || 0) + e.usd);
  }

  // 光圈大小按资金量相对比例（开方，避免一个巨额把其他全压扁）；中心固定最大
  const cid = centerId();
  const maxVol = Math.max(1, ...[...volume].filter(([k]) => k !== cid).map(([, v]) => v));
  const maxEdge = Math.max(10, ...visibleEdges.map((e) => e.usd));
  const sizeOf = (id) => {
    if (id === cid) return 78;
    const s = 24 + 50 * Math.sqrt((volume.get(id) || 0) / maxVol);
    return state.fetched.has(id) ? Math.max(s, 44) : s;
  };

  const oldPos = {};
  cy.nodes().forEach((n) => (oldPos[n.id()] = { ...n.position() }));

  const nodes = [...keep].map((id) => {
    const i = id.indexOf(":");
    const chain = id.slice(0, i), addr = id.slice(i + 1);
    const lbl = labelOf(chain, addr);
    const color = id === cid ? getVar("--accent") : CAT_COLORS[lbl?.category] || getVar("--node");
    const iv = inVol.get(id) || 0, ov = outVol.get(id) || 0;
    const risk = riskOf(id).level.key;
    return {
      group: "nodes",
      data: {
        id, chain, addr,
        name: nameOf(chain, addr),
        color,
        img: nodeIcon({
          color, chain, cat: id === cid ? "center" : lbl?.category, inRatio: iv + ov > 0 ? iv / (iv + ov) : 0.5,
          fetched: state.fetched.has(id), watched: isWatched(chain, addr), risk,
        }),
        risk,
        size: sizeOf(id),
        glow: Math.round(sizeOf(id) * 0.32),
        fetched: state.fetched.has(id) ? 1 : 0,
        center: id === cid ? 1 : 0,
        watched: isWatched(chain, addr) ? 1 : 0,
      },
    };
  });
  const els = visibleEdges.map((e) => {
    const sf = state.fetched.has(e.source), tf = state.fetched.has(e.target);
    const color = sf && tf ? getVar("--between") : tf ? getVar("--in") : getVar("--out");
    const tokenText = Object.entries(e.tokens).map(([s, a]) => `${fmtNum(a)} ${s}`).join(" + ");
    return {
      group: "edges",
      data: {
        id: e.id, source: e.source, target: e.target, color,
        width: 2 + 2 * (Math.log10(1 + e.usd) / Math.log10(1 + maxEdge)), // 2 ~ 4 px（虚点直径）
        // 按相对最大额的对数比例分 5 档，决定流速：金额越大流得越快
        tier: 1 + Math.min(4, Math.floor(5 * Math.log10(1 + e.usd) / Math.log10(1 + maxEdge))),
        // 标签放在靠近对手方的一端，跟着对手方节点排开，避免都挤在中心附近
        ...(() => {
          const text = (e.usd > 0 ? fmtUsd(e.usd) : tokenText) + "\n" + tr(`${e.count} 笔`); // 画布文字需手动翻译
          if (sf && tf) return { label: text, srcLabel: "", tgtLabel: "" };
          return tf ? { label: "", srcLabel: text, tgtLabel: "" } : { label: "", srcLabel: "", tgtLabel: text };
        })(),
        textColor: color,
      },
    };
  });
  // 增量更新：只删掉不再需要的、更新已有的、添加新的（比整张图重建快很多）
  const wanted = new Set([...nodes, ...els].map((d) => d.data.id));
  cy.batch(() => {
    cy.elements().filter((el) => !wanted.has(el.id())).remove();
    for (const def of [...nodes, ...els]) {
      const el = cy.getElementById(def.data.id);
      if (el.empty()) { cy.add(def); continue; }
      const cur = el.data();
      for (const k in def.data) if (cur[k] !== def.data[k]) { el.data(def.data); break; } // 数据没变就不触发重算样式
    }
  });
  // 样式表只在主题或流动样式变化时重新生成
  const styleKey = `${document.documentElement.dataset.theme}|${document.documentElement.dataset.accent || "blue"}|${flow.mode}`;
  if (cy.scratch("styleKey") !== styleKey) { cy.style(cyStyle()); cy.scratch("styleKey", styleKey); }
  edgeIndex = edges;
  flow.groups = [1, 2, 3, 4, 5].map((t) => cy.edges(`[tier = ${t}]`));

  // 摆放：保留旧位置；新节点按“左流入 / 右流出 / 下双向”围绕父节点
  const groups = {};
  cy.nodes().forEach((n) => {
    const id = n.id();
    if (oldPos[id]) return; // 已有节点保持原位
    if (id === centerId() && !expandedId) return n.position({ x: 0, y: 0 });
    const s = side.get(id) || { parent: centerId(), dir: "both" };
    // 中心地址：流入左 / 流出右；后续展开的地址：新节点统一放在远离中心的一侧，避免重叠
    (groups[s.parent + "|" + (s.parent === centerId() ? s.dir : "away")] ||= []).push(n);
  });
  // 流入放左侧、流出放右侧，按列排开（每列最多 12 个，金额大的离父节点近）；双向的放在下方
  const PER_COL = 12, GAP_Y = 58, GAP_X = 210;
  for (const [k, list] of Object.entries(groups)) {
    const [parent, dir] = k.split("|");
    list.sort((a, b) => (side.get(a.id())?.rank ?? 0) - (side.get(b.id())?.rank ?? 0));
    const p = cy.getElementById(parent).position() || { x: 0, y: 0 };
    const c = cy.getElementById(centerId()).position() || { x: 0, y: 0 };
    list.forEach((n, i) => {
      if (dir === "away") {
        const away = p.x < c.x ? -1 : 1;
        const col = Math.floor(i / PER_COL), rowIdx = i % PER_COL;
        const inCol = Math.min(PER_COL, list.length - col * PER_COL);
        n.position({ x: p.x + away * (280 + col * GAP_X), y: p.y + (rowIdx - (inCol - 1) / 2) * GAP_Y });
        return;
      }
      if (dir === "both") {
        const perRow = 6, row = Math.floor(i / perRow), col = i % perRow;
        const inRow = Math.min(perRow, list.length - row * perRow);
        n.position({ x: p.x + (col - (inRow - 1) / 2) * 220, y: p.y + 280 + row * 90 });
        return;
      }
      const col = Math.floor(i / PER_COL), rowIdx = i % PER_COL;
      const inCol = Math.min(PER_COL, list.length - col * PER_COL);
      const sign = dir === "in" ? -1 : 1;
      n.position({ x: p.x + sign * (320 + col * GAP_X), y: p.y + (rowIdx - (inCol - 1) / 2) * GAP_Y });
    });
  }
  if (fresh) { cy.resize(); cy.fit(undefined, 40); }
  animateIn(oldPos, side, expandedId);
  updateReadout();
  applyRiskView();
  if (pathState.paths.length) highlightPath(pathState.cur, false); // 过滤条件变化后保留路径高亮
  if (locked?.removed()) lockOn(cy.getElementById(locked.id())); else updateReticle();
  if (fresh && cid) setTimeout(() => lockOn(cy.getElementById(cid)), REDUCED ? 0 : 450);
}

const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
function animateIn(oldPos, side, expandedId) {
  if (REDUCED) return;
  const fresh = cy.nodes().filter((n) => !oldPos[n.id()]);
  if (!fresh.length) return;
  fresh.forEach((n, i) => {
    const target = { ...n.position() };
    const parentId = side.get(n.id())?.parent || expandedId || centerId();
    const from = parentId && parentId !== n.id() ? cy.getElementById(parentId).position() : null;
    if (!from) { n.style("opacity", 0); n.animate({ style: { opacity: 1 } }, { duration: 400, complete: () => n.removeStyle("opacity") }); return; }
    n.position({ ...from });
    n.style("opacity", 0);
    n.delay(Math.min(i * 6, 180)).animate({ position: target, style: { opacity: 1 } }, { duration: 420, easing: "ease-out-cubic", complete: () => n.removeStyle("opacity") });
  });
  const edges = fresh.connectedEdges();
  edges.style("opacity", 0);
  edges.delay(120).animate({ style: { opacity: 1 } }, { duration: 380, complete: () => edges.removeStyle("opacity") });
}

// ---------------------------------------------------------------- 节点图标（HUD 仪表盘）
// 外圈刻度（监控中=金色）+ 环形占比（绿=流入 / 红=流出）+ 中心分类图标；按参数缓存，避免重复生成

// 分类图标：统一的实心剪影风格（24×24 坐标），D = 暗色填充，ink = 描边/高光
function glyphFor(cat, chain, ink) {
  const D = "#070a10", RED = "#ff4d6d";
  const G = {
    交易所: `<path d="M12 2.5L22 8H2z" fill="${D}" stroke="${ink}" stroke-width="1.1"/><circle cx="12" cy="5.9" r="1" fill="${ink}"/>
      <path d="M5 10v7.5M9.7 10v7.5M14.3 10v7.5M19 10v7.5" stroke="${ink}" stroke-width="1.9"/><rect x="2" y="18.6" width="20" height="2.8" rx=".6" fill="${ink}"/>`,
    聪明钱: `<circle cx="12" cy="12" r="10" fill="${D}" stroke="${ink}" stroke-width="1.1"/><path d="M5.5 15.5l4-4 3 3 6-6.5" fill="none" stroke="${ink}" stroke-width="2"/><path d="M14.5 8h4v4" fill="none" stroke="${ink}" stroke-width="2"/>`,
    巨鲸: `<path d="M1.8 13.2c0 4.6 4.3 7.3 10 7.3 5.6 0 9.5-3.6 9.5-8.2 1.4-.4 2.2-2.2 1.4-3.8-1 .9-2.3 1.3-3.4.9C17.9 6.9 15.2 5.3 11.6 5.3 5.7 5.3 1.8 8.7 1.8 13.2z" fill="${D}" stroke="${ink}" stroke-width="1.1"/>
      <path d="M7.5 4.6c-.6-1.2-.4-2.2.5-3M7.5 4.6c.6-1.2 1.6-1.6 2.8-1.3M7.5 4.6c-1-.8-2.1-.9-3.1-.2" fill="none" stroke="${ink}" stroke-width="1"/>
      <circle cx="6.4" cy="12" r="1" fill="${ink}"/><path d="M4.2 16.2c3 1.6 7 2 10.5 1.2" fill="none" stroke="${ink}" stroke-width=".7" opacity=".7"/>`,
    名人: `<path d="M3 8l4.5 4L12 4.5 16.5 12 21 8l-1.8 10.2H4.8z" fill="${D}" stroke="${ink}" stroke-width="1.1"/><rect x="4.8" y="19.3" width="14.4" height="2.2" rx=".5" fill="${ink}"/>
      <circle cx="3" cy="8" r="1.3" fill="${ink}"/><circle cx="12" cy="4.5" r="1.3" fill="${ink}"/><circle cx="21" cy="8" r="1.3" fill="${ink}"/><circle cx="12" cy="14" r="1.4" fill="${ink}"/>`,
    机构: `<path d="M12 2l8.5 3.2v6.3c0 5.3-3.6 8.6-8.5 10.3C7.1 20.1 3.5 16.8 3.5 11.5V5.2z" fill="${D}" stroke="${ink}" stroke-width="1.1"/>
      <path d="M8.3 11.8l2.6 2.6 5-5" fill="none" stroke="${ink}" stroke-width="1.9"/>`,
    做市商: `<circle cx="12" cy="12" r="10" fill="${D}" stroke="${ink}" stroke-width="1.1"/>
      <path d="M6.5 9.5h10.5l-2.8-2.8M17.5 14.5H7l2.8 2.8" fill="none" stroke="${ink}" stroke-width="1.7"/>`,
    混币器: `<path d="M2.5 4h19M5 8h14M7.5 12h10M9.2 16h6.3M10.6 20h3.4" fill="none" stroke="${ink}" stroke-width="2.1"/>`,
    合约: `<path d="M5 2.5h9.5L19 7v14.5H5z" fill="${D}" stroke="${ink}" stroke-width="1.1"/><path d="M14.5 2.5V7H19" fill="none" stroke="${ink}" stroke-width="1.1"/>
      <path d="M10 11l-2.5 2.5L10 16M14 11l2.5 2.5L14 16" fill="none" stroke="${ink}" stroke-width="1.5"/>`,
    风险: `<path d="M12 2.5l10.5 18.5h-21z" fill="${D}" stroke="${ink}" stroke-width="1.1"/><path d="M12 9v5.5" stroke="${RED}" stroke-width="2.3"/><circle cx="12" cy="17.6" r="1.3" fill="${RED}"/>`,
    嫌疑人: `<circle cx="12" cy="12" r="8.5" fill="${D}" stroke="${ink}" stroke-width="1.1"/><circle cx="12" cy="12" r="4.6" fill="none" stroke="${ink}" stroke-width="1"/>
      <path d="M12 1v5M12 18v5M1 12h5M18 12h5" stroke="${ink}" stroke-width="1.4"/><circle cx="12" cy="12" r="1.9" fill="${RED}"/>`,
    黑客: `<path d="M12 1.8c-4 0-6.6 3.2-6.6 7.6v2.4c0 1.2-.5 2.3-1.3 3.1L2.2 17.4c-.4 1.5-.6 3-.6 4.3h20.8c0-1.3-.2-2.8-.6-4.3l-1.9-2.5c-.8-.8-1.3-1.9-1.3-3.1V9.4c0-4.4-2.6-7.6-6.6-7.6z" fill="${D}" stroke="${ink}" stroke-width="1.1"/>
      <path d="M8.3 10.7c0-2.5 1.6-4.4 3.7-4.4s3.7 1.9 3.7 4.4c0 2.3-1.6 4.5-3.7 4.5s-3.7-2.2-3.7-4.5z" fill="#000" stroke="${ink}" stroke-opacity=".35" stroke-width=".6"/>
      <circle cx="10.4" cy="10.9" r="1.5" fill="#ff2d55" opacity=".35"/><circle cx="13.6" cy="10.9" r="1.5" fill="#ff2d55" opacity=".35"/>
      <path d="M9.4 10.4l1.9.7M14.6 10.4l-1.9.7" stroke="#ff4d6d" stroke-width="1.2"/>
      <path d="M10.3 15.8v3.2M13.7 15.8v3.2" stroke="${ink}" stroke-width=".9" opacity=".8"/><circle cx="10.3" cy="19.3" r=".5" fill="${ink}"/><circle cx="13.7" cy="19.3" r=".5" fill="${ink}"/>`,
  };
  // 未标记 / “其他”：显示所在链的标志
  const CHAIN = {
    // 以太坊：按官方标志的四个切面，用明暗区分，不画分隔线
    eth: `<path d="M12 1.5L5.4 12.3 12 16.1z" fill="${ink}"/><path d="M12 1.5l6.6 10.8L12 16.1z" fill="${ink}" opacity=".62"/>
      <path d="M5.4 13.7L12 22.5v-5.1z" fill="${ink}" opacity=".88"/><path d="M18.6 13.7L12 22.5v-5.1z" fill="${ink}" opacity=".55"/>`,
    bsc: `<path d="M12 2.5l3 3-3 3-3-3zM12 15.5l3 3-3 3-3-3zM5.5 9l3 3-3 3-3-3zM18.5 9l3 3-3 3-3-3zM12 9l3 3-3 3-3-3z" fill="${ink}"/>`,
    polygon: `<path d="M16.2 8.3a1.2 1.2 0 0 0-1.2 0l-2.8 1.6-1.9 1.1-2.8 1.6a1.2 1.2 0 0 1-1.2 0l-2.2-1.3a1.2 1.2 0 0 1-.6-1V7.8a1.2 1.2 0 0 1 .6-1l2.2-1.2a1.2 1.2 0 0 1 1.2 0l2.2 1.2a1.2 1.2 0 0 1 .6 1v1.6l1.9-1.1V6.6a1.2 1.2 0 0 0-.6-1L7.5 3.3a1.2 1.2 0 0 0-1.2 0L2.1 5.6a1.2 1.2 0 0 0-.6 1v4.7a1.2 1.2 0 0 0 .6 1l4.2 2.4a1.2 1.2 0 0 0 1.2 0l2.8-1.6 1.9-1.1 2.8-1.6a1.2 1.2 0 0 1 1.2 0l2.2 1.2a1.2 1.2 0 0 1 .6 1v2.5a1.2 1.2 0 0 1-.6 1l-2.2 1.3a1.2 1.2 0 0 1-1.2 0l-2.2-1.3a1.2 1.2 0 0 1-.6-1v-1.6l-1.9 1.1v1.7a1.2 1.2 0 0 0 .6 1l4.2 2.4a1.2 1.2 0 0 0 1.2 0l4.2-2.4a1.2 1.2 0 0 0 .6-1v-4.8a1.2 1.2 0 0 0-.6-1z" fill="${ink}" transform="translate(0 1)"/>`,
    tron: `<path d="M2.5 4l19 4.2L12 21.5z" fill="${ink}" opacity=".18" stroke="${ink}" stroke-width="1.4"/><path d="M2.5 4l9.5 17.5M21.5 8.2l-8.6 2.7M2.5 4l10.4 6.9" fill="none" stroke="${ink}" stroke-width="1.1"/>`,
    btc: `<circle cx="12" cy="12" r="10" fill="${D}" stroke="${ink}" stroke-width="1.1"/>
      <path d="M9.4 7h3.9a2.4 2.4 0 0 1 0 4.8H9.4zM9.4 11.8h4.4a2.6 2.6 0 0 1 0 5.2H9.4zM9.4 7v10M10.8 5.4V7M12.8 5.4V7M10.8 17v1.6M12.8 17v1.6" fill="none" stroke="${ink}" stroke-width="1.4"/>`,
  };
  CHAIN.arbitrum = CHAIN.base = CHAIN.optimism = CHAIN.eth;
  const body = G[cat] || CHAIN[chain] || CHAIN.eth;
  return `<g transform="translate(29 28) scale(1.75)" stroke-linecap="round" stroke-linejoin="round">${body}</g>`;
}

const iconCache = new Map();
function nodeIcon({ color, cat, chain, inRatio, fetched, watched, risk = "none" }) {
  const hud = document.documentElement.dataset.theme === "dark";
  const ratio = Math.round(inRatio * 20) / 20; // 量化到 5%，提高缓存命中
  const key = [color, cat, chain, ratio, fetched, watched, hud, risk].join("|");
  if (iconCache.has(key)) return iconCache.get(key);
  const IN = getVar("--in"), OUT = getVar("--out"), GOLD = hud ? "#ffb627" : "#d99a1e";
  const ink = hud ? "#eaffff" : "#ffffff";
  const R = 39, C = 2 * Math.PI * R, gap = ratio > 0 && ratio < 1 ? 3 : 0;
  const inLen = Math.max(0, ratio * C - gap), outLen = Math.max(0, (1 - ratio) * C - gap);
  const center = cat === "center";
  const glyph = center
    ? `<circle cx="50" cy="50" r="13" fill="none" stroke="${ink}" stroke-width="2.4" stroke-dasharray="5 2.6"/><circle cx="50" cy="50" r="6.5" fill="${ink}"/>`
    : glyphFor(cat, chain, ink);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
    <defs><radialGradient id="g" cx="50%" cy="42%" r="60%">
      <stop offset="0" stop-color="${color}" stop-opacity="${hud ? 0.95 : 1}"/><stop offset=".7" stop-color="${color}" stop-opacity="${hud ? 0.55 : 0.85}"/><stop offset="1" stop-color="${color}" stop-opacity="${hud ? 0.25 : 0.7}"/>
    </radialGradient></defs>
    <circle cx="50" cy="50" r="48" fill="none" stroke="${watched ? GOLD : color}" stroke-width="${watched ? 2.2 : 1.2}" stroke-dasharray="${watched ? "3 3" : "1.2 3.6"}" opacity="${watched ? 1 : fetched ? 0.95 : 0.6}"/>
    <circle cx="50" cy="50" r="${R}" fill="none" stroke="${color}" stroke-width="7" opacity=".14"/>
    ${inLen > 0 ? `<circle cx="50" cy="50" r="${R}" fill="none" stroke="${IN}" stroke-width="7" stroke-dasharray="${inLen.toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 50 50)"/>` : ""}
    ${outLen > 0 ? `<circle cx="50" cy="50" r="${R}" fill="none" stroke="${OUT}" stroke-width="7" stroke-dasharray="${outLen.toFixed(1)} ${C.toFixed(1)}" stroke-dashoffset="${(-(ratio * C)).toFixed(1)}" transform="rotate(-90 50 50)"/>` : ""}
    <circle cx="50" cy="50" r="30" fill="url(#g)"/>
    <circle cx="50" cy="50" r="30" fill="none" stroke="${hud ? "#ffffff" : color}" stroke-opacity="${hud ? 0.35 : 0.9}" stroke-width="1"/>
    ${fetched && !center ? `<circle cx="50" cy="50" r="33.5" fill="none" stroke="${ink}" stroke-width="1" opacity=".7"/>` : ""}
    ${glyph}
    ${risk === "high" || risk === "mid" ? `<g transform="translate(60 0) scale(1.5)"><path d="M13 1.5L25 23H1z" fill="${RISK_COLOR[risk]}" stroke="#070a10" stroke-width="2" stroke-linejoin="round"/>
      <path d="M13 8.5v7" stroke="#070a10" stroke-width="3" stroke-linecap="round"/><circle cx="13" cy="19.3" r="1.7" fill="#070a10"/></g>` : ""}
  </svg>`;
  const uri = "data:image/svg+xml;utf8," + encodeURIComponent(svg.replace(/\s+/g, " "));
  iconCache.set(key, uri);
  return uri;
}

// "#00e5ff" → "rgba(0,229,255,a)"（不含空格，便于 Cytoscape 解析颜色列表）
function rgba(color, a) {
  let h = String(color).trim();
  const m = h.match(/^rgba?\(([^)]+)\)$/);
  if (m) { const [r, g, b] = m[1].split(",").map((x) => parseFloat(x)); return `rgba(${r},${g},${b},${a})`; }
  h = h.replace("#", "");
  if (h.length === 3) h = h.split("").map((x) => x + x).join("");
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

let edgeIndex = new Map();
const centerId = () => (state.center ? nid(state.center.chain, state.center.address) : null);
const getVar = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

function cyStyle() {
  const v = (n) => getVar(n);
  const hud = document.documentElement.dataset.theme === "dark";
  return [
    { selector: "node", style: {
      width: "data(size)", height: "data(size)", "background-opacity": 0, "border-width": 0,
      "background-image": "data(img)", "background-fit": "contain", "background-clip": "none", "background-image-smoothing": "yes",
      "underlay-color": "data(color)", "underlay-opacity": hud ? 0.13 : 0.1, "underlay-padding": "data(glow)", "underlay-shape": "ellipse",
      label: "data(name)", "font-size": 11, "font-family": hud ? "JetBrains Mono, PingFang SC, monospace" : "Inter, PingFang SC, sans-serif", color: v("--text-2"),
      "text-valign": "bottom", "text-margin-y": 6, "text-wrap": "ellipsis", "text-max-width": 150,
      "text-background-color": v("--bg"), "text-background-opacity": hud ? 0.7 : 0.85, "text-background-padding": 3,
      "text-background-shape": "roundrectangle",
    } },
    { selector: "node[fetched = 1]", style: { "font-weight": 700, color: v("--text") } },
    { selector: "node[center = 1]", style: { "underlay-color": v("--accent"), "underlay-opacity": 0.28, "underlay-padding": 14, "font-size": 12.5 } },
    { selector: "node[risk = 'high']", style: { "underlay-color": RISK_COLOR.high, "underlay-opacity": 0.3 } },
    { selector: "node[risk = 'mid']", style: { "underlay-color": RISK_COLOR.mid, "underlay-opacity": 0.24 } },
    { selector: ".risk-dim", style: { opacity: 0.12 } },
    { selector: "node:selected", style: { "overlay-color": v("--accent"), "overlay-opacity": 0.2, "overlay-padding": 6 } },
    { selector: "edge", style: {
      width: "data(width)", "line-color": "data(color)", "target-arrow-color": "data(color)",
      "target-arrow-shape": "triangle", "arrow-scale": 0.9, "curve-style": "bezier", "line-opacity": 0.6, // 只让线条半透明，标签保持清晰
      // 流动样式：虚点（圆点）/ 虚线 / 关闭
      "line-style": flow.mode === "off" ? "solid" : "dashed",
      "line-dash-pattern": flow.mode === "dots" ? [0.01, 8] : [10, 6],
      "line-cap": flow.mode === "dots" ? "round" : "butt",
      // 标签：水平显示、两行（金额 / 笔数），颜色跟随连线，带描边底牌，缩得太小时自动隐藏
      label: "data(label)", "font-size": 11, "font-weight": 600, "font-family": "JetBrains Mono, monospace",
      color: "data(textColor)", "text-wrap": "wrap", "line-height": 1.25, "text-rotation": "none",
      "text-background-color": v("--surface"), "text-background-opacity": 0.96, "text-background-padding": 4, "text-background-shape": "roundrectangle",
      "text-border-width": 1, "text-border-color": "data(textColor)", "text-border-opacity": 0.45,
      "min-zoomed-font-size": 7, "text-events": "yes",
      "source-label": "data(srcLabel)", "target-label": "data(tgtLabel)", "source-text-offset": 95, "target-text-offset": 95,
    } },
    { selector: "edge:selected", style: { opacity: 1, "overlay-color": v("--accent"), "overlay-opacity": 0.15 } },
    { selector: ".faded", style: { opacity: 0.12 } },
    { selector: ".path-dim", style: { opacity: 0.1 } },
    { selector: "edge.path", style: { "line-color": "#ffc93c", "target-arrow-color": "#ffc93c", "line-opacity": 1, width: 4.5, "z-index": 30, color: "#ffc93c", "text-border-color": "#ffc93c", "min-zoomed-font-size": 0 } },
    { selector: "node.path", style: { "underlay-color": "#ffc93c", "underlay-opacity": 0.32, "font-weight": 700, color: v("--text"), "z-index": 30 } },
    { selector: "edge[tier >= 4]", style: { "line-opacity": 0.9 } },
    { selector: "edge[tier <= 2]", style: { "line-opacity": 0.45 } },
    { selector: "edge.hl", style: { "line-opacity": 1, "z-index": 20, "font-size": 13, "text-border-opacity": 1, "text-background-opacity": 1, "min-zoomed-font-size": 0 } },
  ];
}

function initCy() {
  cy = cytoscape({
    container: $("#cy"), wheelSensitivity: 0.35, minZoom: 0.05, maxZoom: 3, style: cyStyle(),
    // 不用 textureOnViewport：它在点击/拖动时会用静态截图代替实时画面，导致流动动画短暂停住
    textureOnViewport: false, motionBlur: false, pixelRatio: "auto",
  });
  cy.on("tap", "node", (e) => { showNode(e.target.id()); ripple(e.target); lockOn(e.target); });
  cy.on("tap", (e) => { if (e.target === cy) lockOn(null); });
  cy.on("viewport position", () => { updateReticle(); hideTip(); updateReadout(); });
  cy.on("dbltap", "node", (e) => expand(e.target.data("chain"), e.target.data("addr")));
  cy.on("tap", "edge", (e) => showEdge(e.target.id()));
  // 悬停节点时淡化无关连线，看清它的资金关系
  cy.on("mouseover", "node", (e) => {
    cy.elements().not(e.target.closedNeighborhood()).addClass("faded");
    e.target.connectedEdges().addClass("hl");
    showTip(e.target);
    schedulePrefetch(e.target);
  });
  cy.on("mouseout", "node", () => { cy.elements().removeClass("faded hl"); hideTip(); clearTimeout(prefetchTimer); });
  cy.on("mouseover", "edge", (e) => e.target.addClass("hl"));
  cy.on("mouseout", "edge", (e) => e.target.removeClass("hl"));
  startFlow();
}

// ---------------------------------------------------------------- HUD 交互：预加载、锁定准星、悬停卡、波纹、读数

// 鼠标停在未展开节点上 280ms 就在后台预取它的数据，双击展开时几乎瞬间完成
let prefetchTimer, prefetching = 0;
function schedulePrefetch(n) {
  clearTimeout(prefetchTimer);
  if (state.fetched.has(n.id()) || prefetching >= 2) return;
  prefetchTimer = setTimeout(() => {
    prefetching++;
    Promise.all(prefetchAddress(n.data("chain"), n.data("addr"))).finally(() => prefetching--);
  }, 280);
}

let locked = null;
function lockOn(n) {
  locked = n && n.nonempty() ? n : null;
  const r = $("#reticle");
  r.hidden = !locked;
  if (!locked) return;
  r.classList.remove("in"); void r.offsetWidth; r.classList.add("in");
  $("#reticle .rt-label").textContent = `TARGET LOCKED · ${short(locked.data("addr")).toUpperCase()}`;
  updateReticle();
}
function updateReticle() {
  if (!locked) return;
  if (locked.removed()) { locked = cy.getElementById(locked.id()); if (locked.empty()) return lockOn(null); }
  const p = locked.renderedPosition(), d = locked.renderedWidth() + 30;
  const r = $("#reticle");
  r.style.transform = `translate(${p.x - d / 2}px, ${p.y - d / 2}px)`;
  r.style.width = r.style.height = `${d}px`;
}

function ripple(n) {
  if (REDUCED) return;
  const p = n.renderedPosition(), d = n.renderedWidth();
  const el = document.createElement("div");
  el.className = "ripple";
  Object.assign(el.style, { left: `${p.x}px`, top: `${p.y}px`, width: `${d}px`, height: `${d}px` });
  $(".graph-wrap").appendChild(el);
  setTimeout(() => el.remove(), 700);
}

function showTip(n) {
  const id = n.id(), chain = n.data("chain"), addr = n.data("addr");
  const st = statsFor(id, filters());
  const lbl = labelOf(chain, addr);
  const tip = $("#hud-tip");
  tip.innerHTML = `<div class="tt-h">${esc(nameOf(chain, addr))} ${catBadge(lbl)}</div>
    <div class="tt-a">${esc(short(addr))} · ${esc(state.chains[chain].name)}</div>
    <div class="tt-g"><span>IN</span><b class="in">${fmtUsd(st.inUsd)}</b><span>OUT</span><b class="out">${fmtUsd(st.outUsd)}</b><span>TXS</span><b>${st.n}</b><span>RISK</span><b style="color:${RISK_COLOR[riskOf(id).level.key]}">${riskOf(id).score} · <span>${riskOf(id).level.text}</span></b></div>
    <div class="tt-f">${state.fetched.has(id) ? "已展开 · 单击查看详情" : "双击展开资金流 · 已在后台预取"}</div>`;
  const p = n.renderedPosition(), w = $("#cy").clientWidth;
  const left = p.x + n.renderedWidth() / 2 + 14;
  tip.style.transform = `translate(${left + 230 > w ? p.x - n.renderedWidth() / 2 - 244 : left}px, ${Math.max(8, p.y - 40)}px)`;
  tip.hidden = false;
}
function hideTip() { $("#hud-tip").hidden = true; }

function updateReadout() {
  if (!cy) return;
  const vol = [...edgeIndex.values()].reduce((a, e) => a + (cy.getElementById(e.id).nonempty() ? e.usd : 0), 0);
  $("#hud-readout").innerHTML = `<span>NODES <b>${cy.nodes().length}</b></span><span>LINKS <b>${cy.edges().length}</b></span><span>ZOOM <b>${Math.round(cy.zoom() * 100)}%</b></span><span>VOL <b>${fmtUsd(vol)}</b></span>`;
}

// 字符解码效果：标题先乱码滚动再定格
function decode(el) {
  if (!el) return;
  el.setAttribute("translate", "no"); // 自己负责文字，翻译层跳过动画中间帧
  el.textContent = tr(el.textContent);
  if (REDUCED) return;
  const final = el.textContent, chars = "ABCDEF0123456789#$%&*<>/\\";
  let frame = 0;
  const total = 14;
  const run = () => {
    frame++;
    const keep = Math.floor((frame / total) * final.length);
    el.textContent = final.slice(0, keep) + [...final.slice(keep)].map((c) => (c === " " ? " " : chars[(Math.random() * chars.length) | 0])).join("");
    if (frame < total) requestAnimationFrame(run); else el.textContent = final;
  };
  requestAnimationFrame(run);
}

const FLOW_MODES = { dots: "虚点流动", dash: "虚线流动", off: "流动已关闭" };
const flow = { mode: "dots", raf: 0, last: 0, offset: 0 };
try {
  const m = localStorage.getItem("bd-flow-mode");
  flow.mode = matchMedia("(prefers-reduced-motion: reduce)").matches ? "off" : FLOW_MODES[m] ? m : "dots";
} catch {}
const FLOW_SPEED = [0.35, 0.8, 1.4, 2.1, 3]; // 5 档：小额慢、大额快

function startFlow() {
  cancelAnimationFrame(flow.raf);
  const tick = (t) => {
    flow.raf = requestAnimationFrame(tick);
    if (flow.mode === "off" || !cy || document.hidden || !$("#tab-flow").classList.contains("active")) return;
    if (t - flow.last < 40) return; // 约 25 帧/秒，虚点流动足够顺滑
    const dt = flow.last ? Math.min(t - flow.last, 100) : 33;
    flow.last = t;
    const edges = cy.edges();
    if (!edges.length) return;
    flow.offset = (flow.offset - dt * 0.03) % 1600; // 偏移递减 = 虚线朝箭头方向移动
    const core = centerId() && cy.getElementById(centerId());
    cy.batch(() => {
      // 小额慢、大额快：一眼看出主要资金通道
      // 只更新视野内的连线，画布放大或边很多时省掉大部分开销
      const ext = cy.extent(), pad = 40;
      const inView = (p) => p.x > ext.x1 - pad && p.x < ext.x2 + pad && p.y > ext.y1 - pad && p.y < ext.y2 + pad;
      flow.groups?.forEach((g, k) => {
        const off = flow.offset * FLOW_SPEED[k];
        g.forEach((e) => { if (inView(e.source().position()) || inView(e.target().position())) e.style("line-dash-offset", off); });
      });
      if (core?.nonempty()) core.style({ "underlay-padding": 13 + 7 * Math.sin(t / 420), "underlay-opacity": 0.22 + 0.1 * Math.sin(t / 420) });
    });
  };
  flow.raf = requestAnimationFrame(tick);
}

function setFlow(mode) {
  flow.mode = mode;
  try { localStorage.setItem("bd-flow-mode", mode); } catch {}
  $("#btn-flow").classList.toggle("on", mode !== "off");
  $("#btn-flow").title = `${FLOW_MODES[mode]}（点击切换：虚点 → 虚线 → 关闭）`;
  if (cy) { cy.style(cyStyle()); cy.scratch("styleKey", `${document.documentElement.dataset.theme}|${mode}`); }
}
// 点击循环切换：虚点 → 虚线 → 关闭
$("#btn-flow").addEventListener("click", () => {
  const next = { dots: "dash", dash: "off", off: "dots" }[flow.mode];
  setFlow(next);
  toast(FLOW_MODES[next]);
});
setFlow(flow.mode);

$$(".graph-tools [data-zoom]").forEach((b) => b.addEventListener("click", () => {
  if (!cy) return;
  const z = b.dataset.zoom;
  if (z === "fit") return cy.animate({ fit: { padding: 40 } }, { duration: 300 });
  cy.animate({ zoom: { level: cy.zoom() * (z === "in" ? 1.3 : 1 / 1.3), renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } } }, { duration: 200 });
}));

// 风险视图：只突出中高风险地址以及和它们直接相连的连线
let riskView = false;
function applyRiskView() {
  if (!cy) return;
  cy.batch(() => {
    cy.elements().removeClass("risk-dim");
    if (!riskView) return;
    const hot = cy.nodes().filter((n) => ["high", "mid"].includes(n.data("risk")));
    const keep = hot.union(hot.connectedEdges()).union(hot.neighborhood("node"));
    cy.elements().not(keep).addClass("risk-dim");
  });
}
$("#btn-risk").addEventListener("click", () => {
  riskView = !riskView;
  $("#btn-risk").classList.toggle("on", riskView);
  applyRiskView();
  const n = cy ? cy.nodes().filter((x) => ["high", "mid"].includes(x.data("risk"))).length : 0;
  toast(riskView ? (n ? `风险视图：突出 ${n} 个中高风险地址` : "风险视图：图中未发现中高风险地址") : "已退出风险视图");
});

$("#btn-relayout").addEventListener("click", () => {
  if (!cy || !cy.nodes().length) return;
  cy.layout({ name: "cose", animate: true, nodeRepulsion: 9000, idealEdgeLength: 140, padding: 30 }).run();
});
$("#btn-reset").addEventListener("click", () => {
  state.fetched.clear(); state.transfers.clear(); state.center = null;
  if (cy) cy.elements().remove();
  $("#side").innerHTML = SIDE_EMPTY;
  lockOn(null); updateReadout();
  $("#graph-empty").hidden = false;
  renderTimeline(); renderTable(); renderKpis(); setMsg("");
});

// ---------------------------------------------------------------- 侧边栏

function statsFor(id, f) {
  let inUsd = 0, outUsd = 0, n = 0, inN = 0, outN = 0, first = Infinity, last = 0;
  const cps = new Set();
  for (const t of state.transfers.values()) {
    if (!pass(t, f)) continue;
    const s = nid(t.chain, t.from), d = nid(t.chain, t.to);
    if (s !== id && d !== id) continue;
    n++;
    if (d === id && s !== id) inUsd += t.usd || 0, inN++, cps.add(s);
    if (s === id && d !== id) outUsd += t.usd || 0, outN++, cps.add(d);
    first = Math.min(first, t.ts); last = Math.max(last, t.ts);
  }
  return { inUsd, outUsd, n, inN, outN, cps: cps.size, first: n ? first : null, last: n ? last : null };
}

function avatar(chain, addr) {
  const lbl = labelOf(chain, addr);
  const color = nid(chain, addr) === centerId() ? getVar("--accent") : CAT_COLORS[lbl?.category] || getVar("--node");
  const ch = (nameOf(chain, addr) || addr).replace(/^0x/, "").trim().charAt(0).toUpperCase();
  return `<div class="avatar" style="background:${color}">${esc(ch)}</div>`;
}

function showNode(id) {
  const i = id.indexOf(":");
  const chain = id.slice(0, i), addr = id.slice(i + 1);
  const lbl = labelOf(chain, addr);
  const prof = state.profiles.get(id);
  const st = statsFor(id, filters());
  const fetched = state.fetched.has(id);
  const title = gl(lbl?.label || watchOf(chain, addr)?.label) || "未标记地址";
  let html = `<div class="ins-head">${avatar(chain, addr)}<div>
      <h3>${esc(title)}</h3>
      <div class="ins-sub">${esc(state.chains[chain].name)} ${catBadge(lbl)} ${isWatched(chain, addr) ? '<span class="badge big">监控中</span>' : ""}</div>
    </div></div>
    <div class="addr-box"><span class="mono">${esc(addr)}</span><button class="icon-btn" data-act="copy" title="复制地址">${ICON.copy}</button></div>
    ${riskSection(id)}
    ${lbl?.note || lbl?.source ? `<div class="muted" style="margin-top:6px">${esc(gl(lbl.note || ""))}${lbl.source ? `${lbl.note ? " · " : ""}来源：${esc(lbl.source)}` : ""}</div>` : ""}
    <div class="actions">
      ${fetched ? "" : `<button class="small primary" data-act="expand">展开资金流</button>`}
      ${id === centerId() ? "" : `<button class="small" data-act="center">设为中心</button>`}
      ${isWatched(chain, addr) ? "" : `<button class="small" data-act="watch">加入监控</button>`}
      <button class="small" data-act="label">${lbl ? "修改标签" : "打标签"}</button>
      ${isEvm(chain) ? `<button class="small" data-act="smart">交易表现</button>` : ""}
      ${pathState.from && pathState.from !== id ? `<button class="small primary" data-act="path-to">追踪到这里</button>` : ""}
      <button class="small ghost" data-act="path-from">${pathState.from === id ? "已是路径起点" : "设为路径起点"}</button>
    </div>
    <div class="section"><div class="section-title">外部查询</div><div class="links">${externalLinks(chain, addr)}</div></div>`;
  if (prof) {
    html += `<div class="section"><div class="section-title">地址档案</div><dl class="kv">
      ${prof.balances.map((b) => `<dt>余额 ${esc(b.symbol)}</dt><dd><b>${fmtNum(b.amount)}</b> <span class="muted">${fmtUsd(b.usd)}</span></dd>`).join("")}
      ${prof.first_seen ? `<dt>首次活跃</dt><dd>${fmtTime(prof.first_seen)}</dd>` : ""}
      ${prof.tx_count != null ? `<dt>总交易数</dt><dd>${prof.tx_count.toLocaleString()}</dd>` : ""}
      ${prof.funded_by ? `<dt>最初资金来源</dt><dd>${addrLink(chain, prof.funded_by)}</dd>` : ""}
    </dl></div>`;
  } else if (fetched) {
    html += `<div class="actions"><button class="small ghost" data-act="profile">加载余额与首次活跃时间</button></div>`;
  }
  html += `<div class="section"><div class="section-title">已加载数据（受过滤影响）</div>
    <div class="flow-bars">
      <div><div class="k">流入 · ${st.inN} 笔</div><div class="v in">${fmtUsd(st.inUsd)}</div></div>
      <div><div class="k">流出 · ${st.outN} 笔</div><div class="v out">${fmtUsd(st.outUsd)}</div></div>
    </div>
    <dl class="kv" style="margin-top:10px">
      <dt>对手方</dt><dd>${st.cps} 个</dd>
      <dt>时间范围</dt><dd>${st.first ? fmtTime(st.first, false) + " ~ " + fmtTime(st.last, false) : "-"}</dd>
    </dl>
    ${fetched ? "" : `<p class="muted">该地址尚未展开，这里只包含它与已分析地址之间的转账。双击节点或点“展开资金流”可以继续追踪。</p>`}
  </div>`;
  html += topCounterparties(id);
  const side = $("#side");
  setPanel(html);
  $("#side").dataset.id = id;
  decode($("#side .ins-head h3"));
  side.onclick = async (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    if (act === "expand") expand(chain, addr);
    if (act === "center") analyze(chain, addr);
    if (act === "watch") quickWatch(chain, addr);
    if (act === "label") quickLabel(chain, addr);
    if (act === "smart") smartAnalyze(chain, addr);
    if (act === "path-from") setPathFrom(id);
    if (act === "path-to") tracePath(id);
    if (act === "copy") navigator.clipboard.writeText(addr).then(() => toast("已复制"));
    if (act === "profile") {
      try {
        state.profiles.set(id, await api(`/api/profile?chain=${chain}&address=${encodeURIComponent(addr)}`));
        showNode(id);
      } catch (err) { toast(err.message, 5000); }
    }
  };
}

function topCounterparties(id) {
  const f = filters();
  const m = new Map();
  for (const e of edgeIndex.values()) {
    if (e.source !== id && e.target !== id) continue;
    const cp = e.source === id ? e.target : e.source;
    const r = m.get(cp) || { in: 0, out: 0 };
    if (e.target === id) r.in += e.usd; else r.out += e.usd;
    m.set(cp, r);
  }
  const rows = [...m.entries()].sort((a, b) => b[1].in + b[1].out - (a[1].in + a[1].out)).slice(0, 15);
  if (!rows.length) return "";
  return `<div class="section"><div class="section-title">主要对手方</div><table><tr><th>地址</th><th class="num">流入</th><th class="num">流出</th></tr>${rows
    .map(([cp, r]) => {
      const j = cp.indexOf(":");
      return `<tr><td>${addrLink(cp.slice(0, j), cp.slice(j + 1))}</td><td class="num in">${r.in ? fmtUsd(r.in) : ""}</td><td class="num out">${r.out ? fmtUsd(r.out) : ""}</td></tr>`;
    })
    .join("")}</table></div>`;
}

function showEdge(id) {
  const e = edgeIndex.get(id);
  if (!e) return;
  const [s, d] = [e.source, e.target].map((x) => x.slice(x.indexOf(":") + 1));
  const sf = state.fetched.has(e.target) && !state.fetched.has(e.source) ? "in" : "out";
  setPanel(`<div class="section-title">资金流向</div>
    <div class="edge-flow">
      <div>${avatar(e.chain, s)}<div>${addrLink(e.chain, s)}</div></div>
      <span class="${sf}">${ICON.arrow}</span>
      <div>${avatar(e.chain, d)}<div>${addrLink(e.chain, d)}</div></div>
    </div>
    <div class="flow-bars" style="margin-top:14px">
      <div><div class="k">合计金额</div><div class="v">${fmtUsd(e.usd)}</div></div>
      <div><div class="k">转账笔数</div><div class="v">${e.count}</div></div>
    </div>
    ${e.unpriced ? '<p class="muted">含未定价代币，美元合计未计入这部分</p>' : ""}
    <dl class="kv" style="margin-top:10px">${Object.entries(e.tokens).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${fmtNum(v)}</dd>`).join("")}</dl>
    <div class="section"><div class="section-title">逐笔明细</div>
    <table><tr><th>时间</th><th class="num">数量</th><th>交易</th></tr>
    ${e.list.sort((a, b) => b.ts - a.ts).slice(0, 200).map((t) => `<tr><td>${fmtTime(t.ts)}</td><td class="num">${fmtNum(t.amount)} ${esc(t.symbol)}</td><td><a class="mono" href="${explorerTx(t.chain, t.hash)}" target="_blank" rel="noopener">${short(t.hash)}</a></td></tr>`).join("")}
    </table></div>`);
}

function setPanel(html) {
  const side = $("#side");
  side.classList.remove("swap");
  side.innerHTML = html;
  void side.offsetWidth; // 重新触发动画
  side.classList.add("swap");
  side.scrollTop = 0;
}

// ---------------------------------------------------------------- 时间线

function centerTransfers(f) {
  if (!state.center) return [];
  const id = centerId();
  return [...state.transfers.values()].filter((t) => {
    if (!pass(t, f)) return false;
    const s = nid(t.chain, t.from), d = nid(t.chain, t.to);
    if (s !== id && d !== id) return false;
    if (f.dir && t.dir !== f.dir) return false;
    return true;
  }).sort((a, b) => b.ts - a.ts);
}

function renderTimeline() {
  const box = $("#timeline");
  const list = centerTransfers(filters()).filter((t) => t.verified && t.dir !== "self");
  if (!list.length) { box.innerHTML = `<p class="empty-line">分析地址后显示每段时间的流入和流出</p>`; $("#tl-info").textContent = ""; return; }
  const min = list[list.length - 1].ts, max = list[0].ts;
  const span = max - min;
  const unit = span <= 120 * 86400 ? 86400 : span <= 3 * 365 * 86400 ? 7 * 86400 : 30 * 86400;
  const unitName = unit === 86400 ? "天" : unit === 7 * 86400 ? "周" : "月";
  const start = Math.floor(min / unit) * unit;
  const n = Math.floor((max - start) / unit) + 1;
  const bins = Array.from({ length: n }, (_, i) => ({ t: start + i * unit, in: 0, out: 0, c: 0 }));
  for (const t of list) {
    const b = bins[Math.floor((t.ts - start) / unit)];
    b[t.dir] += t.usd || 0; b.c++;
  }
  const W = 1000, H = 190, mid = 88, pad = 14;
  const peak = Math.max(1, ...bins.map((b) => Math.max(b.in, b.out)));
  const bw = (W - 60) / n;
  const y = (v) => (Math.sqrt(v / peak) * (mid - pad)); // 开方比例，避免一笔巨额压扁其他柱子
  let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">`;
  svg += `<line class="grid" x1="50" x2="${W}" y1="${pad}" y2="${pad}"/><line class="grid" x1="50" x2="${W}" y1="${2 * mid - pad}" y2="${2 * mid - pad}"/>`;
  svg += `<line x1="50" x2="${W}" y1="${mid}" y2="${mid}"/>`;
  svg += `<text x="0" y="${pad + 4}">${fmtUsd(peak)}</text><text x="0" y="${mid - 6}">流入↑</text><text x="0" y="${mid + 14}">流出↓</text><text x="0" y="${2 * mid - pad + 4}">${fmtUsd(peak)}</text>`;
  const ticks = Math.min(6, n);
  for (let k = 0; k < ticks; k++) {
    const i = Math.round((k * (n - 1)) / Math.max(1, ticks - 1));
    svg += `<text x="${50 + i * bw + bw / 2}" y="${H - 2}" text-anchor="middle">${fmtTime(bins[i].t, false).slice(unit >= 30 * 86400 ? 0 : 5, unit >= 30 * 86400 ? 7 : 10)}</text>`;
  }
  bins.forEach((b, i) => {
    const x = 50 + i * bw, w = Math.max(1, bw - 1);
    const tip = `${fmtTime(b.t, false)} 起 1${unitName}\n流入 ${fmtUsd(b.in)}\n流出 ${fmtUsd(b.out)}\n${b.c} 笔`;
    const dl = `style="animation-delay:${Math.min(i * (300 / n), 300)}ms"`;
    if (b.in) svg += `<rect ${dl} class="bar-in" x="${x}" y="${mid - y(b.in)}" width="${w}" height="${y(b.in)}"><title>${tip}</title></rect>`;
    if (b.out) svg += `<rect ${dl} class="bar-out" x="${x}" y="${mid}" width="${w}" height="${y(b.out)}"><title>${tip}</title></rect>`;
  });
  svg += `</svg>`;
  box.innerHTML = svg;
  $("#tl-info").textContent = `${fmtTime(min, false)} ~ ${fmtTime(max, false)} · 按${unitName}汇总 · 柱高为开方比例，悬停可看数值`;
}

// ---------------------------------------------------------------- 明细表

function renderTable() {
  const f = filters();
  const q = $("#tx-search").value.trim().toLowerCase();
  const list = centerTransfers(f).filter((t) => {
    if (!q) return true;
    const cp = t.dir === "in" ? t.from : t.to;
    return (cp + " " + nameOf(t.chain, cp) + " " + t.hash + " " + t.symbol).toLowerCase().includes(q);
  });
  const tbl = $("#tx-table");
  if (!list.length) { tbl.innerHTML = ""; $("#tx-info").textContent = ""; return; }
  $("#tx-info").textContent = `共 ${list.length} 条${list.length > 500 ? "，显示前 500 条（导出 CSV 可得全部）" : ""}`;
  tbl.innerHTML = `<tr><th>时间</th><th>方向</th><th>对手方</th><th class="num">数量</th><th>代币</th><th class="num">美元</th><th>交易</th></tr>` +
    list.slice(0, 500).map((t, k) => {
      const cp = t.dir === "in" ? t.from : t.to;
      return `<tr class="${k < 40 ? "row-in" : ""}" style="--d:${k * 8}ms"><td>${fmtTime(t.ts)}</td>
        <td>${dirPill(t.dir)}</td>
        <td>${addrLink(t.chain, cp)} ${catBadge(labelOf(t.chain, cp))} ${riskBadge(nid(t.chain, cp))}</td>
        <td class="num">${fmtNum(t.amount)}</td>
        <td>${esc(t.symbol)}${t.verified ? "" : ' <span class="badge" title="不在可信代币名单，可能是垃圾币/假币">未验证</span>'}</td>
        <td class="num">${fmtUsd(t.usd)}</td>
        <td><a href="${explorerTx(t.chain, t.hash)}" target="_blank" rel="noopener" class="mono">${short(t.hash)}</a></td></tr>`;
    }).join("");
}

let txSearchTimer;
$("#tx-search").addEventListener("input", () => { clearTimeout(txSearchTimer); txSearchTimer = setTimeout(renderTable, 150); });

$("#btn-csv").addEventListener("click", () => {
  const list = [...state.transfers.values()].filter((t) => pass(t, filters())).sort((a, b) => b.ts - a.ts);
  if (!list.length) return toast("没有可导出的数据");
  const head = ["时间", "链", "交易哈希", "发送方", "发送方标签", "接收方", "接收方标签", "数量", "代币", "代币合约", "已验证", "美元"];
  const rows = list.map((t) => [fmtTime(t.ts), t.chain, t.hash, t.from, labelOf(t.chain, t.from)?.label || "", t.to, labelOf(t.chain, t.to)?.label || "", t.amount, t.symbol, t.token, t.verified ? "是" : "否", t.usd ?? ""]);
  const csv = "﻿" + [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = `区块侦探_${state.center ? short(state.center.address).replace("…", "_") : "export"}_${fmtTime(Date.now() / 1000, false)}.csv`;
  a.click();
});

// CSV 单元格：代币名可以由任何人随便起，以 = + - @ 开头时 Excel 会当成公式执行，前面加 ' 让它只当文字
function csvCell(v) {
  let s = String(v ?? "");
  if (typeof v !== "number" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

// ---------------------------------------------------------------- 标签

async function loadLabels() {
  state.labels = await api("/api/labels");
  renderLabels();
  updateSuggest();
}

function quickLabel(chain, addr) {
  const cur = labelOf(chain, addr);
  const name = prompt("给这个地址起个名字：\n" + addr, cur?.label || "");
  if (name == null) return;
  const cat = prompt("分类（交易所 / 名人 / 机构 / 巨鲸 / 合约 / 混币器 / 风险 / 嫌疑人 / 其他）：", cur?.category || "其他");
  if (cat == null) return;
  saveLabel(labelKey(chain, addr), name, cat, cur?.note || "", "手动添加");
}

async function saveLabel(key, label, category, note, source) {
  state.labels = await api("/api/labels", { method: "POST", body: { key, label, category, note, source } });
  toast("标签已保存");
  renderLabels(); updateSuggest();
  if (state.center) renderAll();
}

$("#label-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const chain = $("#l-chain").value, addr = $("#l-addr").value.trim();
  if (!addr || !$("#l-label").value.trim()) return toast("请填写地址和名称");
  saveLabel(labelKey(chain, normAddr(chain, addr)), $("#l-label").value, $("#l-cat").value, $("#l-note").value, "手动添加");
  $("#l-addr").value = $("#l-label").value = $("#l-note").value = "";
});
$("#l-search").addEventListener("input", renderLabels);

function renderLabels() {
  const q = $("#l-search").value.trim().toLowerCase();
  const rows = Object.entries(state.labels).filter(([k, v]) => !q || (k + JSON.stringify(v)).toLowerCase().includes(q));
  $("#label-table").innerHTML = `<tr><th>分类</th><th>名称</th><th>链</th><th>地址</th><th>备注</th><th>来源</th><th></th></tr>` +
    rows.map(([k, v]) => {
      const i = k.indexOf(":"), grp = k.slice(0, i), addr = k.slice(i + 1);
      const chain = grp === "evm" ? "eth" : grp;
      return `<tr><td>${catBadge(v)}</td><td>${esc(gl(v.label))}</td><td>${grp === "evm" ? "EVM" : esc(state.chains[grp]?.name || grp)}</td>
        <td class="mono">${esc(addr)}</td><td>${esc(gl(v.note))}</td><td class="muted">${esc(v.source)}</td>
        <td class="num"><button class="small ghost" data-an="${esc(chain)}|${esc(addr)}">分析</button> ${grp === "evm" || isWatched(chain, addr) ? "" : `<button class="small ghost" data-watch="${esc(chain)}|${esc(addr)}">监控</button>`} <button class="small ghost" data-del="${esc(k)}">删除</button></td></tr>`;
    }).join("");
  $("#label-count").textContent = `${rows.length} / ${Object.keys(state.labels).length}`;
}
$("#label-table").addEventListener("click", async (e) => {
  if (e.target.dataset.del) {
    if (!confirm("删除这个标签？")) return;
    state.labels = await api(`/api/labels?key=${encodeURIComponent(e.target.dataset.del)}`, { method: "DELETE" });
    renderLabels(); updateSuggest();
  }
  if (e.target.dataset.an) {
    const [c, a] = e.target.dataset.an.split("|");
    analyze(c, a);
  }
  if (e.target.dataset.watch) {
    const [c, a] = e.target.dataset.watch.split("|");
    await quickWatch(c, a);
    renderLabels();
  }
});
$("#l-export").addEventListener("click", () => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(state.labels, null, 2)], { type: "application/json" }));
  a.download = "区块侦探_标签库.json";
  a.click();
});
$("#l-import").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    state.labels = await api("/api/labels", { method: "POST", body: { import: data } });
    renderLabels(); updateSuggest();
    toast(`已导入 ${Object.keys(data).length} 条标签`);
  } catch (err) { toast("导入失败：" + err.message, 5000); }
  e.target.value = "";
});

function updateSuggest() {
  const opts = new Map();
  for (const w of state.watchlist) opts.set(w.address, `监控 · ${w.label || ""} (${state.chains[w.chain]?.name})`);
  for (const [k, v] of Object.entries(state.labels)) {
    const addr = k.slice(k.indexOf(":") + 1);
    if (!opts.has(addr)) opts.set(addr, `${v.category || ""} · ${v.label}`);
  }
  $("#addr-suggest").innerHTML = [...opts].map(([a, t]) => `<option value="${esc(a)}">${esc(t)}</option>`).join("");
}

// ---------------------------------------------------------------- 巨鲸监控

async function loadWatchlist() {
  state.watchlist = await api("/api/watchlist");
  renderWatch();
  updateSuggest();
}

async function quickWatch(chain, addr) {
  if (isWatched(chain, addr)) return toast("已在监控列表中");
  const name = prompt("监控名称：", labelOf(chain, addr)?.label || "");
  if (name == null) return;
  const th = prompt("大额提醒阈值（美元）：", "1000000");
  if (th == null) return;
  await addWatch({ chain, address: addr, label: name, threshold_usd: th });
}
async function addWatch(item) {
  try {
    state.watchlist = await api("/api/watchlist", { method: "POST", body: item });
    renderWatch(); updateSuggest();
    toast("已加入监控");
    if (state.center) renderAll();
  } catch (e) { toast(e.message, 5000); }
}
$("#watch-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const addr = $("#w-addr").value.trim();
  if (!addr) return toast("请填写地址");
  addWatch({ chain: $("#w-chain").value, address: addr, label: $("#w-label").value, threshold_usd: $("#w-th").value, note: $("#w-note").value,
             direction: $("#w-dir").value, tokens: $("#w-tokens").value });
  $("#w-addr").value = $("#w-label").value = $("#w-note").value = $("#w-tokens").value = "";
  $("#w-dir").value = "all";
});

// 监控规则（方向 / 代币）的小字说明；都是默认值时不显示
function watchRule(w) {
  const parts = [];
  if (w.direction === "in") parts.push("只看流入");
  if (w.direction === "out") parts.push("只看流出");
  if (w.tokens?.length) parts.push(esc(w.tokens.join(" / ")));
  return parts.length ? `<div class="muted watch-rule">${parts.join(" · ")}</div>` : "";
}
// 巨鲸净流向：服务端后台算，算的时候每 3 秒问一次
let flowTimer = null;
async function loadFlow(refresh = false) {
  try {
    const f = await api(`/api/watchlist/flow${refresh ? "?refresh=1" : ""}`);
    renderFlow(f);
    clearTimeout(flowTimer);
    if (f.running) flowTimer = setTimeout(() => loadFlow(), 3000);
  } catch (e) { toast(e.message, 4000); }
}
function renderFlow(f) {
  const t = f.totals || {};
  const signed = (v) => (v == null ? "—" : `<span class="${v >= 0 ? "up" : "down"}">${v >= 0 ? "+" : "−"}${fmtUsd(Math.abs(v)).slice(0)}</span>`);
  $("#fl-info").textContent = f.running ? `${tr("正在统计")} ${f.wallets || 0} ${tr("个地址")}…` : f.ts ? `${f.rows?.length || 0}/${f.wallets || 0} ${tr("个地址")} · ${fmtTime(f.ts)}` + (f.errors?.length ? ` · ${f.errors.length} ${tr("个失败")}` : "") : "";
  const k = (key, v, sub) => `<div class="kpi"><div class="k">${key}</div><div class="v">${v}</div><div class="s">${sub}</div></div>`;
  $("#fl-kpis").innerHTML = f.rows?.length ? [
    k("24h 净流入", signed(t.net_24h), `${tr("流入")} ${fmtUsd(t.in_24h)} · ${tr("流出")} ${fmtUsd(t.out_24h)} · ${t.n_24h} ${tr("笔")}`),
    k("7 天净流入", signed(t.net_7d), `${tr("流入")} ${fmtUsd(t.in_7d)} · ${tr("流出")} ${fmtUsd(t.out_7d)} · ${t.n_7d} ${tr("笔")}`),
    k("24h 最大净流入", f.rows.filter((r) => r.net_24h > 0)[0] ? esc(gl(f.rows.filter((r) => r.net_24h > 0)[0].label) || short(f.rows.filter((r) => r.net_24h > 0)[0].address)) : "—", f.rows.filter((r) => r.net_24h > 0)[0] ? fmtUsd(f.rows.filter((r) => r.net_24h > 0)[0].net_24h) : ""),
    k("24h 最大净流出", f.rows.filter((r) => r.net_24h < 0)[0] ? esc(gl(f.rows.filter((r) => r.net_24h < 0)[0].label) || short(f.rows.filter((r) => r.net_24h < 0)[0].address)) : "—", f.rows.filter((r) => r.net_24h < 0)[0] ? fmtUsd(-f.rows.filter((r) => r.net_24h < 0)[0].net_24h) : ""),
  ].join("") : "";
  const rows = (f.rows || []).filter((r) => r.n_7d > 0).slice(0, 12);
  $("#fl-table").innerHTML = rows.length ? `<tr><th>地址</th><th class="num">24h 流入</th><th class="num">24h 流出</th><th class="num">24h 净</th><th class="num">7 天净</th><th class="num">7 天笔数</th></tr>` +
    rows.map((r) => `<tr><td>${addrLink(r.chain, r.address)}</td><td class="num">${fmtUsd(r.in_24h)}</td><td class="num">${fmtUsd(r.out_24h)}</td><td class="num">${signed(r.net_24h)}</td><td class="num">${signed(r.net_7d)}</td><td class="num">${r.n_7d}</td></tr>`).join("")
    : `<tr><td class="muted">${f.running ? tr("正在统计…") : f.wallets ? tr("最近 7 天没有可定价的转账") : tr("监控列表为空")}</td></tr>`;
}
$("#fl-refresh").addEventListener("click", () => loadFlow(true));
document.addEventListener("bd:tab", (e) => { if (e.detail === "watch") loadFlow(); });

function renderWatch() {
  $("#watch-table").innerHTML = `<tr><th>名称</th><th>链</th><th>地址</th><th class="num">大额阈值</th><th>最后活动</th><th>上次检查</th><th>新动态</th><th>备注</th><th></th></tr>` +
    state.watchlist.map((w) => {
      const k = `${w.chain}:${w.address}`;
      const r = state.watchNew[k];
      const cls = state.refreshing?.has(k) ? "refreshing" : state.justDone?.has(k) ? "just-done" : "";
      return `<tr class="${cls}"><td><div class="name-cell">${avatar(w.chain, w.address)}<b>${esc(gl(w.label) || "-")}</b></div></td><td><span class="chip">${esc(state.chains[w.chain]?.name)}</span></td>
        <td class="mono" title="${esc(w.address)}">${esc(short(w.address))}</td><td class="num">${fmtUsd(w.threshold_usd)}${watchRule(w)}</td>
        <td>${w.last_ts ? fmtTime(w.last_ts) : "-"}</td><td class="muted">${ago(w.last_checked)}</td>
        <td>${r?.error ? `<span class="badge no" title="${esc(r.error)}">出错</span>` : r?.new_count ? `<span class="badge new">${r.new_count} 条新</span>` : ""}</td>
        <td class="muted">${esc(gl(w.note))}</td>
        <td class="num"><button class="small ghost" data-an="${esc(k)}">分析</button> <button class="small ghost" data-del="${esc(k)}">删除</button></td></tr>`;
    }).join("");
  $("#watch-count").textContent = `${state.watchlist.length} 个地址`;
  $("#hud-watch").textContent = `WATCH ${state.watchlist.length}`;
}
$("#watch-table").addEventListener("click", async (e) => {
  const k = e.target.dataset.an || e.target.dataset.del;
  if (!k) return;
  const i = k.indexOf(":"), chain = k.slice(0, i), addr = k.slice(i + 1);
  if (e.target.dataset.an) return analyze(chain, addr);
  if (!confirm("从监控列表移除？")) return;
  state.watchlist = await api(`/api/watchlist?chain=${chain}&address=${encodeURIComponent(addr)}`, { method: "DELETE" });
  renderWatch(); updateSuggest();
});

async function refreshWatch() {
  if (refreshWatch.busy) return;
  refreshWatch.busy = true;
  const btn = $("#w-refresh"), bar = $("#w-progress"), txt = $("#w-progress-text");
  const items = [...state.watchlist];
  const queue = items.map((w) => `${w.chain}:${w.address}`);
  const events = [];
  let done = 0;
  state.refreshing = new Set(queue);
  btn.disabled = true; btn.textContent = "刷新中…";
  bar.hidden = false; bar.firstElementChild.style.width = "0%";
  renderWatch();
  // 3 路并行：EVM / TRON 的限速由后端统一控制，BTC 等不受影响，总耗时明显缩短
  const worker = async () => {
    while (queue.length) {
      const key = queue.shift();
      let r;
      try { r = await api(`/api/watchlist/refresh?key=${encodeURIComponent(key)}`, { method: "POST" }); }
      catch (e) { r = { results: [{ key, error: e.message, new_count: 0 }], events: [] }; }
      for (const x of r.results) state.watchNew[x.key] = x;
      events.push(...r.events);
      state.refreshing.delete(key);
      (state.justDone ||= new Set()).add(key);
      done++;
      bar.firstElementChild.style.width = `${(done / items.length) * 100}%`;
      txt.textContent = `正在刷新 ${done} / ${items.length}`;
      state.lastEvents = [...events].sort((a, b) => b.ts - a.ts).slice(0, 500);
      renderWatch(); renderFeed();
    }
  };
  try {
    await Promise.all([worker(), worker(), worker()]);
    await loadWatchlist();
    const newCount = events.filter((e) => e.is_new && (e.usd ?? 0) >= 1).length;
    $("#nav-new").hidden = !newCount;
    $("#nav-new").textContent = newCount;
    const errs = Object.values(state.watchNew).filter((r) => r.error).length;
    txt.textContent = `${new Date().toLocaleTimeString()} 已刷新`;
    toast(`刷新完成：${newCount} 条新动态${errs ? `，${errs} 个地址出错（悬停“出错”查看原因）` : ""}`, 4000);
    notifyBig(events.filter((e) => e.is_new && e.is_big));
    renderMarquee();
  } finally {
    refreshWatch.busy = false;
    state.refreshing.clear();
    setTimeout(() => { bar.hidden = true; state.justDone?.clear(); }, 1200);
    btn.disabled = false; btn.textContent = "立即刷新";
  }
}
$("#w-refresh").addEventListener("click", refreshWatch);
$("#feed-big").addEventListener("change", renderFeed);
$("#feed-chain").addEventListener("change", renderFeed);

function renderFeed() {
  const only = $("#feed-big").checked;
  const ch = $("#feed-chain").value;
  const list = state.lastEvents.filter((e) => (e.usd ?? 0) >= 1 && (!only || e.is_big) && (!ch || e.chain === ch)); // 过滤粉尘/投毒小额
  $("#feed-info").textContent = state.lastEvents.length ? `每个地址最近 50 笔，已过滤未验证代币；新 = 上次检查之后出现` : "点击“立即刷新”获取";
  $("#feed-table").innerHTML = `<tr><th>时间</th><th>监控对象</th><th>方向</th><th>对手方</th><th class="num">数量</th><th>代币</th><th class="num">美元</th><th>交易</th></tr>` +
    list.map((t) => {
      const cp = t.dir === "in" ? t.from : t.to;
      return `<tr class="${t.is_big ? "big" : ""} ${t.is_new ? "new" : ""}">
        <td>${fmtTime(t.ts)} ${t.is_new ? '<span class="badge new">新</span>' : ""}</td>
        <td>${addrLink(t.chain, t.watch.address)} <span class="muted">${esc(state.chains[t.chain]?.name)}</span></td>
        <td>${dirPill(t.dir)}</td>
        <td>${addrLink(t.chain, cp)} ${catBadge(labelOf(t.chain, cp))}</td>
        <td class="num">${fmtNum(t.amount)}</td><td>${esc(t.symbol)}</td>
        <td class="num">${fmtUsd(t.usd)} ${t.is_big ? '<span class="badge big">大额</span>' : ""}</td>
        <td><a href="${explorerTx(t.chain, t.hash)}" target="_blank" rel="noopener" class="mono">${short(t.hash)}</a></td></tr>`;
    }).join("");
}

let autoTimer;
$("#w-auto").addEventListener("change", (e) => {
  clearInterval(autoTimer);
  const s = parseInt(e.target.value);
  try { localStorage.setItem("bd-auto", s); } catch {}
  if (s) { autoTimer = setInterval(refreshWatch, s * 1000); toast(`已开启自动刷新（页面需保持打开）`); }
});
$("#w-notify").addEventListener("click", async () => {
  if (!("Notification" in window)) return toast("浏览器不支持通知");
  const p = await Notification.requestPermission();
  toast(p === "granted" ? "已开启：新的大额动态会弹出桌面通知" : "未获得通知权限");
});
function notifyBig(list) {
  if (!list.length || !("Notification" in window) || Notification.permission !== "granted") return;
  const t = list[0];
  new Notification(`🐋 ${t.watch.label || short(t.watch.address)} ${t.dir === "in" ? "流入" : "流出"} ${fmtUsd(t.usd)}`, {
    body: `${fmtNum(t.amount)} ${t.symbol}${list.length > 1 ? `（另有 ${list.length - 1} 条大额）` : ""}`,
  });
}

// ---------------------------------------------------------------- 后台大额提醒（服务端定时检查 + macOS 通知）

function renderAlerts(st) {
  $("#al-on").checked = st.enabled;
  $("#al-int").value = String(st.interval);
  $("#al-sound").checked = st.sound !== false;
  $("#al-smart").checked = st.smart_enabled !== false;
  if (document.activeElement !== $("#al-smart-min")) $("#al-smart-min").value = st.smart_min ?? 1000;
  $("#al-smart-first").checked = !!st.smart_first_only;
  $("#al-smart-info").innerHTML = st.smart_wallets
    ? `<span>跟踪 ${st.smart_wallets} 个已标为“聪明钱”的钱包</span>`
    : `<span>还没有标为“聪明钱”的钱包：到“聪明钱”页分析后点“标为聪明钱”</span>`;
  const badge = $("#al-state");
  badge.className = `badge ${st.enabled ? "ok" : ""}`;
  badge.textContent = st.running ? "检查中…" : st.enabled ? "运行中" : "已关闭";
  const bits = [];
  if (st.last_run) bits.push(`上次检查 ${fmtTime(st.last_run).slice(5)}`);
  if (st.enabled && st.next_run) bits.push(`下次约 ${fmtTime(st.next_run).slice(11, 16)}`);
  if (st.last_error) bits.push(`部分失败：${st.last_error}`);
  $("#al-info").innerHTML = bits.map((b) => `<span>${esc(b)}</span>`).join(" · ");
  const h = st.history || [];
  $("#al-hist").innerHTML = h.length
    ? `<div class="section-title">最近提醒</div>` + h.slice(0, 8).map((r) => r.type === "smart_buy"
        ? `<div class="al-row smart"><span class="mono">${fmtTime(r.ts).slice(5)}</span><span>${addrLink(r.chain, r.address)}</span><span class="dir in">聪明钱买入</span><b>${fmtUsd(r.usd)}</b><span class="muted">${fmtNum(r.amount)} ${esc(r.symbol)}${r.first ? ' <span class="badge new">首次</span>' : ""}</span></div>`
        : `<div class="al-row ${r.dir}"><span class="mono">${fmtTime(r.ts).slice(5)}</span><span>${addrLink(r.chain, r.address)}</span>${dirPill(r.dir)}<b>${fmtUsd(r.usd)}</b><span class="muted">${fmtNum(r.amount)} ${esc(r.symbol)}</span></div>`).join("")
    : `<div class="muted">还没有提醒记录。提醒按每个监控地址设置的“大额阈值”判断。</div>`;
}
async function loadAlerts(body) {
  try { renderAlerts(await api("/api/alerts", body ? { method: "POST", body } : {})); } catch (e) { toast(e.message, 4000); }
}
$("#al-on").addEventListener("change", async (e) => {
  await loadAlerts({ enabled: e.target.checked, lang: I18N.lang, interval: +$("#al-int").value });
  toast(e.target.checked ? "已开启后台提醒：约 30 秒后做第一次检查" : "已关闭后台提醒");
});
$("#al-int").addEventListener("change", (e) => loadAlerts({ interval: +e.target.value }));
$("#al-sound").addEventListener("change", (e) => loadAlerts({ sound: e.target.checked }));
$("#al-smart").addEventListener("change", (e) => loadAlerts({ smart: e.target.checked }));
$("#al-smart-min").addEventListener("change", (e) => loadAlerts({ smart_min: +e.target.value || 0 }));
$("#al-smart-first").addEventListener("change", (e) => loadAlerts({ smart_first_only: e.target.checked }));
$("#al-test").addEventListener("click", async () => {
  await api("/api/alerts", { method: "POST", body: { lang: I18N.lang } });
  await api("/api/alerts/test", { method: "POST" });
  toast("已发送测试通知。如果没看到，请在“系统设置 → 通知”里允许“脚本编辑器”的通知");
});
$("#al-run").addEventListener("click", async () => {
  const b = $("#al-run");
  b.disabled = true; b.textContent = "检查中…";
  try {
    const r = await api("/api/alerts/run", { method: "POST" });
    renderAlerts(r);
    toast(r.found.length ? `发现 ${r.found.length} 笔新的大额转账，已推送通知` : "没有新的大额转账（第一次检查只记录当前位置）");
  } catch (e) { toast(e.message, 4000); }
  b.disabled = false; b.textContent = "立即检查一次";
});
setInterval(() => { if (!document.hidden && $("#tab-watch").classList.contains("active")) loadAlerts(); }, 30000);

// ---------------------------------------------------------------- 工具导航

const TOOLS = [
  ["资金流向图 / 追踪", [
    ["MetaSleuth", "https://metasleuth.io", "多链拖拽式资金流向图，跨链追踪"],
    ["MistTrack 慢雾", "https://misttrack.io", "TRON-USDT 追踪强，风险评分"],
    ["Arkham Intelligence", "https://intel.arkm.com", "实体标签、资金图谱、监控提醒"],
    ["Breadcrumbs", "https://www.breadcrumbs.app", "多链资金流向图"],
    ["OXT", "https://oxt.me", "BTC 交易图深度分析"],
    ["Bubblemaps", "https://bubblemaps.io", "代币持有人关系图"],
  ]],
  ["区块浏览器", [
    ["Etherscan", "https://etherscan.io", "Ethereum"], ["BscScan", "https://bscscan.com", "BSC"],
    ["Tronscan", "https://tronscan.org", "TRON"], ["mempool.space", "https://mempool.space", "Bitcoin"],
    ["Blockchair", "https://blockchair.com", "多链"], ["Solscan", "https://solscan.io", "Solana"],
  ]],
  ["巨鲸 / 聪明钱监控", [
    ["Whale Alert", "https://whale-alert.io", "大额转账实时播报"],
    ["DeBank", "https://debank.com", "EVM 资产组合与历史"],
    ["Cielo", "https://app.cielo.finance", "钱包追踪推送"],
    ["Nansen", "https://www.nansen.ai", "聪明钱标签（部分免费）"],
  ]],
  ["交易解析 / 数据查询", [
    ["Phalcon Explorer", "https://app.blocksec.com/explorer", "单笔交易调用栈与资金流"],
    ["Dune", "https://dune.com", "SQL 查询链上数据"],
    ["Tenderly", "https://dashboard.tenderly.co", "交易模拟与调试"],
  ]],
  ["风险 / 诈骗地址", [
    ["Chainabuse", "https://www.chainabuse.com", "诈骗地址举报库"],
    ["ScamSniffer", "https://www.scamsniffer.io", "钓鱼与诈骗监测"],
    ["OFAC 制裁名单", "https://sanctionssearch.ofac.treas.gov", "美国财政部官方"],
  ]],
];
$("#tools-grid").innerHTML = TOOLS.map(([g, list]) => `<div class="card"><div class="tool-group"><i></i>${g}</div>${list.map(([n, u, d]) => `<a class="tool" href="${u}" target="_blank" rel="noopener"><b>${n}</b><span>${d}</span></a>`).join("")}</div>`).join("");

// ---------------------------------------------------------------- 最近查询

function loadRecent() {
  try { return JSON.parse(localStorage.getItem("bd-recent") || "[]"); } catch { return []; }
}
function saveRecent(list) {
  try { localStorage.setItem("bd-recent", JSON.stringify(list.slice(0, 8))); } catch {}
  renderRecent();
}
function pushRecent(chain, address) {
  saveRecent([{ chain, address }, ...loadRecent().filter((r) => !(r.chain === chain && r.address === address))]);
}
function renderRecent() {
  const list = loadRecent().filter((r) => state.chains[r.chain]);
  $("#recent").innerHTML = list.length
    ? `<span class="lbl">最近查询</span>` + list.map((r, i) =>
        `<span class="recent-chip" data-i="${i}" title="${esc(r.address)}">${esc(nameOf(r.chain, r.address))}<em>${esc(state.chains[r.chain].name)}</em><span class="x" data-x="${i}">×</span></span>`).join("")
    : "";
}
$("#recent").addEventListener("click", (e) => {
  const list = loadRecent();
  const x = e.target.closest("[data-x]");
  if (x) { list.splice(+x.dataset.x, 1); return saveRecent(list); }
  const chip = e.target.closest("[data-i]");
  if (chip) { const r = list[+chip.dataset.i]; analyze(r.chain, r.address); }
});

// ---------------------------------------------------------------- 快捷键

document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName);
  if (e.key === "Escape") {
    if (typing) return document.activeElement.blur();
    if (cy) { cy.elements().unselect(); cy.elements().removeClass("faded hl"); }
    if (pathState.paths.length) { clearPath(); renderAll(); }
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  const TABS = tabNames();
  if (/^[1-9]$/.test(e.key) && TABS[+e.key - 1]) { switchTab(TABS[+e.key - 1]); return; }
  if (e.key === "/") { e.preventDefault(); switchTab("flow"); $("#q-addr").focus(); $("#q-addr").select(); }
  if ((e.key === "f" || e.key === "F") && cy && $("#tab-flow").classList.contains("active")) cy.animate({ fit: { padding: 40 } }, { duration: 300 });
});

// ---------------------------------------------------------------- 案件文件（保存 / 打开调查进度）

$("#btn-case-save").addEventListener("click", () => {
  if (!state.center) return toast("还没有正在进行的调查");
  const name = prompt("案件名称：", `${nameOf(state.center.chain, state.center.address)} 资金追踪`);
  if (name == null) return;
  const positions = {};
  cy.nodes().forEach((n) => (positions[n.id()] = n.position()));
  const f = filters();
  const data = {
    app: "block-detective", version: 1, name, savedAt: new Date().toISOString(),
    center: state.center, fetched: [...state.fetched.values()],
    transfers: [...state.transfers.values()], profiles: Object.fromEntries(state.profiles),
    positions, notes: "",
    filters: { dir: f.dir, token: f.token, min: f.min, hide: f.hide, top: f.top, from: $("#f-from").value, to: $("#f-to").value },
  };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
  a.download = `案件_${name.replace(/[\\/:*?"<>|\s]+/g, "_")}_${fmtTime(Date.now() / 1000, false)}.json`;
  a.click();
  toast(`案件已保存：${state.fetched.size} 个已展开地址，${state.transfers.size} 条转账`);
});

$("#case-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const c = JSON.parse(await file.text());
    if (c.app !== "block-detective" || !c.center || !Array.isArray(c.transfers)) throw new Error("不是区块侦探的案件文件");
    switchTab("flow");
    state.center = c.center;
    state.fetched = new Map(c.fetched.map((x) => [nid(x.chain, x.address), x]));
    state.transfers = new Map(c.transfers.map((t) => [`${t.chain}|${t.hash}|${t.from}|${t.to}|${t.token}|${t.amount}`, t]));
    state.profiles = new Map(Object.entries(c.profiles || {}));
    const fl = c.filters || {};
    $("#f-dir").value = fl.dir || ""; $("#f-min").value = fl.min ?? 1; $("#f-hide").checked = fl.hide ?? true;
    $("#f-top").value = fl.top || 30; $("#f-from").value = fl.from || ""; $("#f-to").value = fl.to || "";
    $("#q-chain").value = c.center.chain; $("#q-addr").value = c.center.address;
    if (cy) cy.elements().remove();
    for (const k in kpiLast) kpiLast[k] = 0;
    $("#kpis").dataset.for = "";
    renderAll(true);
    if (fl.token) { $("#f-token").value = fl.token; renderAll(); }
    // 还原保存时的节点位置
    cy.nodes().forEach((n) => { const p = c.positions?.[n.id()]; if (p) { n.stop(); n.position(p); n.removeStyle("opacity"); } });
    cy.edges().removeStyle("opacity");
    cy.fit(undefined, 40);
    updateReticle();
    setMsg(`已打开案件「${c.name || file.name}」· 保存于 ${fmtTime(Date.parse(c.savedAt) / 1000)} · 数据为当时的快照，重新分析可获取最新数据`);
    toast("案件已还原");
  } catch (err) {
    toast("打开失败：" + err.message, 5000);
  }
});

// ---------------------------------------------------------------- 导出图片

$("#btn-png").addEventListener("click", () => {
  if (!cy || !cy.nodes().length) return toast("画布上还没有内容");
  const a = document.createElement("a");
  a.href = cy.png({ full: true, scale: 2, maxWidth: 6000, bg: getVar("--surface") });
  const name = state.center ? nameOf(state.center.chain, state.center.address).replace(/[\\/:*?"<>|…\s]+/g, "_") : "graph";
  a.download = `区块侦探_资金图_${name}_${fmtTime(Date.now() / 1000, false)}.png`;
  a.click();
  toast("已导出 PNG");
});

// ---------------------------------------------------------------- KPI

function kpiSkeleton() {
  $("#kpis").innerHTML = Array.from({ length: 5 }, (_, i) =>
    `<div class="kpi ${i ? "" : "id"} reveal" style="--d:${i * 50}ms"><span class="sk sm"></span><span class="sk lg"></span><span class="sk sm"></span></div>`).join("");
}

// 数字从上一次的值滚动到新值
const kpiLast = {};
function countUp(el, key, to, fmt) {
  const from = REDUCED ? to : kpiLast[key] ?? 0;
  kpiLast[key] = to;
  if (from === to) return (el.textContent = fmt(to));
  const t0 = performance.now(), dur = 550;
  const step = (now) => {
    const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(from + (to - from) * e);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderKpis() {
  const box = $("#kpis");
  if (!state.center) return (box.innerHTML = "");
  const animate = box.dataset.for !== centerId() || !box.querySelector(".kpi:not(.id) .v [data-k]");
  box.dataset.for = centerId();
  const { chain, address } = state.center;
  const id = centerId();
  const st = statsFor(id, filters());
  const prof = state.profiles.get(id);
  const bal = prof ? prof.balances.reduce((a, b) => a + (b.usd || 0), 0) : null;
  const net = st.inUsd - st.outUsd;
  const lbl = labelOf(chain, address);
  let idx = 0;
  const kpi = (k, v, sub, cls = "") => `<div class="kpi ${cls} ${animate ? "reveal" : ""}" style="--d:${++idx * 60}ms"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${sub}</div></div>`;
  const num = (key, val, cls = "", sign = false) => `<span class="${cls}" data-k="${key}" data-v="${val}" data-sign="${sign ? 1 : ""}">${fmtUsd(val)}</span>`;
  box.innerHTML =
    `<div class="kpi id ${animate ? "reveal" : ""}"><div class="k">${esc(state.chains[chain].name)} ${catBadge(lbl)}</div><div class="v">${esc(nameOf(chain, address))}</div><div class="s" title="${esc(address)}">${esc(address)}</div></div>` +
    kpi("当前余额", bal == null ? "-" : num("bal", bal), prof?.first_seen ? `首次活跃 ${fmtTime(prof.first_seen, false)}` : prof?.tx_count != null ? `总交易 ${prof.tx_count.toLocaleString()} 笔` : "原生币与主流稳定币") +
    kpi("流入", num("in", st.inUsd, "in"), `${st.inN} 笔 · 已加载数据`) +
    kpi("流出", num("out", st.outUsd, "out"), `${st.outN} 笔 · 已加载数据`) +
    kpi("净流入", num("net", net, net >= 0 ? "in" : "out", true), `${st.cps} 个对手方 · ${st.first ? fmtTime(st.first, false) + " 起" : ""}`) +
    (() => {
      const r = riskOf(id), risky = [...computeRisk().entries()].filter(([k, v]) => k !== id && (v.level.key === "high" || v.level.key === "mid")).length;
      return kpi("风险评分", `<span class="risk-kpi ${r.level.key}">${r.score}<small>${r.level.text}</small></span>`, risky ? `图中 ${risky} 个中高风险地址` : "图中未发现中高风险地址", "risk");
    })();
  box.querySelectorAll("[data-k]").forEach((el) => {
    const sign = el.dataset.sign;
    const fmt = (v) => (sign ? (v >= 0 ? "+" : "-") + fmtUsd(Math.abs(v)) : fmtUsd(v));
    if (!animate) kpiLast[el.dataset.k] = kpiLast[el.dataset.k] ?? +el.dataset.v;
    countUp(el, el.dataset.k, +el.dataset.v, fmt);
  });
}

// ---------------------------------------------------------------- 主题
// （KPI 数字在 renderKpis 写入后统一滚动）

const SIDE_EMPTY = $("#side").innerHTML;
$("#theme-toggle").addEventListener("click", () => {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  const cur = document.documentElement.dataset.theme || (dark ? "dark" : "light");
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("bd-theme", next); } catch {}
  if (cy) renderAll();
  if (state.center && $("#side .ins-head")) showNode(centerId());
});

// 配色切换：蓝 / 绿。资金图、行情图等画布颜色要重新画
function markAccent() {
  const acc = document.documentElement.dataset.accent || "blue";
  $$(".accent-switch [data-accent]").forEach((b) => b.classList.toggle("on", b.dataset.accent === acc));
}
document.addEventListener("click", (e) => {
  const b = e.target.closest(".accent-switch [data-accent]");
  if (!b) return;
  const acc = b.dataset.accent;
  if (acc === "blue") delete document.documentElement.dataset.accent; else document.documentElement.dataset.accent = acc;
  try { localStorage.setItem("bd-accent", acc); } catch {}
  markAccent();
  iconCache.clear();
  if (cy) renderAll();
  if (state.center && $("#side .ins-head")) showNode(centerId());
  if (typeof renderMarket === "function") renderMarket();
  document.dispatchEvent(new CustomEvent("bd:accent", { detail: acc })); // 扩展页面据此重画图表
});
markAccent();

// ---------------------------------------------------------------- 服务：一键重启（加载最新代码）

async function loadService() {
  try {
    const v = await api("/api/version");
    $("#svc-info").innerHTML = `<dt>版本</dt><dd class="mono">${esc(v.version)}</dd><dt>地址</dt><dd class="mono">${esc(location.origin)}</dd><dt>本次启动</dt><dd>${fmtTime(v.started)}</dd><dt>Python</dt><dd class="mono">${esc(v.python)}</dd>`;
    const ok = (v.extensions || []).map((e) => `<span class="badge ok">${esc(e.name)} ${esc(e.version || "")}</span>`);
    const bad = (v.ext_errors || []).map((e) => `<span class="badge no" title="${esc(e.error)}">${esc(e.name)}：未加载</span> <span>${esc(e.error)}</span>`);
    $("#svc-ext").innerHTML = ok.length || bad.length ? `<span>已安装扩展：</span>${ok.join(" ")} ${bad.join(" ")}` : `<span>没有安装扩展（ext/ 目录为空）。</span>`;
  } catch {}
}
// 重启服务，等新进程起来（启动时间变了）再刷新页面；返回 false 表示没等到
async function restartService() {
  const { started } = await api("/api/restart", { method: "POST" });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try { const b = await api("/api/alerts"); if (b.started !== started) { location.reload(); return true; } } catch {}
  }
  toast("服务 60 秒内没有重新启动，请查看日志或双击启动文件", 6000);
  return false;
}
$("#svc-restart").addEventListener("click", async () => {
  const btn = $("#svc-restart");
  btn.disabled = true; btn.textContent = "重启中…";
  try { await restartService(); } catch (e) { toast(e.message, 4000); }
  btn.disabled = false; btn.textContent = "重启服务（加载最新代码）";
});
// 从备份 zip 恢复：确认 → 上传 → 服务重启
$("#bk-import").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  if (!confirm(`用「${file.name}」覆盖当前的标签库、监控列表、设置、排行榜、模拟账本和研究数据？恢复前会先自动备份一份当前数据，恢复后服务会重启。`)) return;
  try {
    toast("正在恢复…", 8000);
    const r = await fetch("/api/backup/import", { method: "POST", headers: { "Content-Type": "application/zip" }, body: file });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    toast(`已恢复 ${j.restored.length} 个文件，正在重启服务…`, 8000);
    await restartService();
  } catch (err) { toast("恢复失败：" + err.message, 8000); }
});
document.addEventListener("bd:tab", (e) => { if (e.detail === "settings") loadService(); });

// ---------------------------------------------------------------- 数据备份

async function loadBackup(run = false) {
  try {
    const b = await api("/api/backup", run ? { method: "POST" } : {});
    $("#bk-info").innerHTML = `<dt>位置</dt><dd class="mono">${esc(b.dir)}</dd>
      <dt>最近一次</dt><dd>${b.latest_ts ? fmtTime(b.latest_ts) : "还没有备份"}</dd>
      <dt>已保留</dt><dd>${b.count} / ${b.keep} 天</dd>
      <dt>内容</dt><dd class="muted">${esc(b.files.join("、") || "—")}</dd>`;
    if (run) toast("已备份");
  } catch (e) { toast(e.message, 4000); }
}
$("#bk-run").addEventListener("click", () => loadBackup(true));
document.addEventListener("bd:tab", (e) => { if (e.detail === "settings") loadBackup(); });

// ---------------------------------------------------------------- 设置

async function loadConfig() {
  const c = await api("/api/config");
  const b = (ok) => `<span class="badge ${ok ? "ok" : "no"}">${ok ? "已配置" : "未配置"}</span>`;
  $("#cfg-eth").outerHTML = `<span id="cfg-eth">${b(c.etherscan_key)}</span>`;
  $("#cfg-tron").outerHTML = `<span id="cfg-tron">${b(c.trongrid_key)}</span>`;
  $("#cfg-bs").outerHTML = `<span id="cfg-bs">${b(c.blockscout_key)}</span>`;
  $("#cfg-wh").outerHTML = `<span id="cfg-wh">${b(c.webhook_url)}</span>`;
  loadWebhookState();
  // Key 存放位置：明文文件 → 可由用户一键移进 macOS 钥匙串
  $("#secret-store").innerHTML = c.storage === "keychain"
    ? `<span class="badge ok">已加密</span> <span class="muted">API Key 保存在 macOS 钥匙串里，外接硬盘和备份中都没有明文。</span>`
    : `<span class="badge no">明文</span> <span class="muted">API Key 目前明文保存在外接硬盘的 data/config.json（以及每天的备份）里，硬盘插到别的电脑上就能读到。</span>` +
      (c.keychain_available ? ` <button type="button" class="small primary" id="to-keychain">移到 macOS 钥匙串（推荐）</button>` : "");
  const src = [["EVM", "eth", c.etherscan_key, c.etherscan_key ? "Etherscan" : "未配置 Key"], ["TRON", "tron", true, c.trongrid_key ? "TronGrid" : "免 Key · 限速"], ["Bitcoin", "btc", true, "mempool"]];
  $("#src-status").innerHTML = src.map(([n, k, ok, t]) =>
    `<div class="src-row" title="${n} · ${t}"><i class="${ok ? "" : "off"}"></i><span class="src-name">${n}</span><span class="sig ${ok ? (/限速/.test(t) ? "weak" : "") : "off"}"><s></s><s></s><s></s></span><small>${t}</small><b class="blk" id="blk-${k}" translate="no">${chainStat[k] ? "#" + chainStat[k].height.toLocaleString("en-US") : "—"}</b></div>`).join("");
  return c;
}
document.addEventListener("click", async (e) => {
  if (!e.target.closest("#to-keychain")) return;
  if (!confirm("把 API Key 移进 macOS 钥匙串，并从 data/config.json 和备份里删除明文？之后 Key 只能在这台 Mac 上读取。")) return;
  try {
    await api("/api/secrets/migrate", { method: "POST" });
    toast("已移到钥匙串");
  } catch (err) { toast(err.message, 6000); }
  loadConfig();
});
$("#cfg-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {};
  if ($("#cfg-eth-key").value.trim()) body.etherscan_key = $("#cfg-eth-key").value;
  if ($("#cfg-tron-key").value.trim()) body.trongrid_key = $("#cfg-tron-key").value;
  if ($("#cfg-bs-key").value.trim()) body.blockscout_key = $("#cfg-bs-key").value;
  if ($("#cfg-wh-url").value.trim()) body.webhook_url = $("#cfg-wh-url").value;
  try { await api("/api/config", { method: "POST", body }); } catch (err) { return toast(err.message, 6000); }
  $("#cfg-eth-key").value = $("#cfg-tron-key").value = $("#cfg-bs-key").value = $("#cfg-wh-url").value = "";
  await loadConfig();
  toast("已保存");
});
// Webhook：发送状态、测试、清除
async function loadWebhookState() {
  try {
    const a = await api("/api/alerts");
    const w = a.webhook || {};
    const kind = { telegram: "Telegram", discord: "Discord", slack: "Slack", generic: "自定义" }[w.kind] || "";
    $("#wh-state").textContent = !w.configured ? "" : w.last_error ? `${kind} · 上次发送失败：${w.last_error}` : w.last_ok ? `${kind} · 已发送 ${w.sent} 条，最近 ${fmtTime(w.last_ok)}` : `${kind} · 还没有发送过`;
  } catch {}
}
$("#wh-test").addEventListener("click", async () => {
  try {
    await api("/api/alerts/test", { method: "POST" });
    toast("测试通知已发送");
    setTimeout(loadWebhookState, 1500);
  } catch (err) { toast(err.message, 4000); }
});
$("#wh-clear").addEventListener("click", async () => {
  if (!confirm("清除 Webhook 地址？之后只发 macOS 通知。")) return;
  try { await api("/api/config", { method: "POST", body: { webhook_url: "" } }); await loadConfig(); toast("已清除"); } catch (err) { toast(err.message, 4000); }
});

// ---------------------------------------------------------------- HUD 状态栏

function renderMarquee() {
  const big = state.lastEvents.filter((e) => e.is_big).slice(0, 12);
  const items = big.length
    ? big.map((e) => `<span class="mq ${e.dir}">◆ ${esc(e.watch.label || short(e.watch.address))} ${e.dir === "in" ? "流入" : "流出"} <b>${fmtUsd(e.usd)}</b> ${esc(e.symbol)} · ${fmtTime(e.ts).slice(5)}</span>`)
    : [`<span class="mq">◆ SYSTEM READY · 监控 ${state.watchlist.length} 个目标</span>`, `<span class="mq">◆ 到「巨鲸监控」点击立即刷新，这里会滚动播报大额动向</span>`, `<span class="mq">◆ 快捷键 / 搜索 · F 适应窗口 · Esc 取消选择</span>`];
  const html = items.join("");
  const track = $("#marquee-track");
  track.innerHTML = html + html; // 两份首尾相接，无缝循环
  track.style.animationDuration = `${Math.max(30, items.length * 9)}s`;
}
$("#marquee").addEventListener("click", () => switchTab("watch"));

const bootAt = Date.now();
function tickClock() {
  const d = new Date(), p = (x) => String(x).padStart(2, "0");
  const up = Math.floor((Date.now() - bootAt) / 1000);
  $("#sys-up").textContent = `${p(Math.floor(up / 3600))}:${p(Math.floor(up / 60) % 60)}:${p(up % 60)}`;
  $("#clock").textContent = `UTC ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}
async function loadTicker() {
  try {
    const px = await api("/api/prices");
    const f = (v) => (v == null ? "—" : "$" + (v >= 100 ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : v.toFixed(4)));
    const chg = px._chg || {};
    const c = (v) => (v == null ? "" : `<i class="chg ${v >= 0 ? "up" : "down"}">${v >= 0 ? "▲" : "▼"}${Math.abs(v).toFixed(1)}%</i>`);
    $("#ticker").innerHTML = ["BTC", "ETH", "TRX", "BNB"].map((k) => `<span>${k} <b>${f(px[k])}</b>${c(chg[k])}</span>`).join("");
  } catch {}
}

// 链上遥测：区块高度 / Gas，每 15 秒一次；只有出新区块时数字才柔和地亮一下
const chainStat = {};
const STAT_EVERY = 15000;
function flashVal(el, text) {
  if (!el || el.textContent === text) return;
  const first = el.textContent === "—";
  el.textContent = text;
  if (first) return;
  el.classList.remove("flash-val"); void el.offsetWidth; el.classList.add("flash-val");
}
async function loadChainStat() {
  if (document.hidden) return;
  const beat = $("#hb-beat");
  try {
    const st = await api("/api/chainstat");
    for (const k of ["eth", "tron", "btc"]) {
      const v = st[k];
      if (!v || !v.height) continue;
      chainStat[k] = v;
      const el = $(`#blk-${k}`);
      flashVal(el, "#" + v.height.toLocaleString("en-US"));
      if (el) el.parentElement.title = k === "eth" ? `ETH #${v.height} · Gas ${v.gas} gwei` : k === "btc" ? `BTC #${v.height} · ${v.fee} sat/vB` : `TRON #${v.height}`;
    }
    if (st.eth && st.eth.gas != null) {
      const g = st.eth.gas;
      $("#hb-gas small").textContent = "ETH GAS";
      flashVal($("#hb-gas b"), `${g >= 10 ? g.toFixed(0) : g >= 1 ? g.toFixed(1) : g.toFixed(2)} gwei`);
    } else if (st.btc && st.btc.fee != null) {
      $("#hb-gas small").textContent = "BTC FEE";
      flashVal($("#hb-gas b"), `${st.btc.fee} sat/vB`);
    }
  } catch {}
  beat.style.setProperty("--beat", `${STAT_EVERY / 1000}s`);
  beat.classList.remove("run"); void beat.offsetWidth; beat.classList.add("run");
}
setInterval(loadChainStat, STAT_EVERY);
document.addEventListener("visibilitychange", () => { if (!document.hidden) loadChainStat(); });
tickClock(); setInterval(tickClock, 1000);
loadTicker(); setInterval(loadTicker, 120000);

// 启动自检动画：每个浏览器会话只播放一次，可点击跳过
const boot = (() => {
  let show = false;
  try { show = !sessionStorage.getItem("bd-booted") && !matchMedia("(prefers-reduced-motion: reduce)").matches; } catch {}
  const el = $("#boot"), t0 = performance.now();
  const finish = () => { el.classList.add("done"); try { sessionStorage.setItem("bd-booted", "1"); } catch {} setTimeout(() => (el.hidden = true), 600); };
  if (show) { el.hidden = false; el.addEventListener("click", finish); }
  return {
    line(text, status = "OK") {
      if (!show) return;
      const dots = ".".repeat(Math.max(3, 34 - text.length));
      $("#boot-lines").insertAdjacentHTML("beforeend", `<div>${esc(text)} ${dots} <b>${esc(status)}</b></div>`);
    },
    async end() {
      if (!show) return;
      const wait = Math.max(0, 900 - (performance.now() - t0));
      await new Promise((r) => setTimeout(r, wait));
      this.line("ALL SYSTEMS NOMINAL", "READY");
      setTimeout(finish, 250);
    },
  };
})();
boot.line("INITIALIZING CORE SYSTEMS");

// ---------------------------------------------------------------- 启动

// ---------------------------------------------------------------- 语言

function rerenderForLang() {
  if (state.center && cy) { renderAll(); if ($("#side").dataset.id) showNode($("#side").dataset.id); }
  renderWatch(); renderLabels(); renderFeed(); renderRecent(); renderMarquee(); updateSuggest();
  moveNavIndicator();
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-lang]");
  if (!b) return;
  applyLang(b.dataset.lang);
  rerenderForLang();
  api("/api/alerts", { method: "POST", body: { lang: b.dataset.lang } }).catch(() => {});
});

(async function init() {
  i18nInit();
  state.chains = await api("/api/chains");
  boot.line("LOADING CHAIN MODULES", `${Object.keys(state.chains).length} CHAINS`);
  chainOptions($("#q-chain"), "eth");
  chainOptions($("#w-chain"), "eth");
  chainOptions($("#l-chain"), "eth");
  chainOptions($("#sm-chain"), "eth");
  $$("#sm-chain option").forEach((o) => { if (!isEvm(o.value)) o.remove(); });
  $("#feed-chain").insertAdjacentHTML("beforeend", Object.entries(state.chains).map(([k, c]) => `<option value="${k}">${c.name}</option>`).join(""));
  await Promise.all([loadLabels(), loadWatchlist()]);
  boot.line("ENTITY DATABASE", `${Object.keys(state.labels).length} ENTITIES`);
  boot.line("WATCHLIST TARGETS", `${state.watchlist.length} LOCKED`);
  renderRecent();
  loadAlerts();
  const cfg = await loadConfig();
  loadChainStat();
  boot.line("LINK ETHERSCAN V2", cfg.etherscan_key ? "OK" : "NO KEY");
  boot.line("LINK TRONGRID / MEMPOOL", "OK");
  boot.end();
  renderMarquee();
  (window.requestIdleCallback || setTimeout)(() => loadRecent().slice(0, 2).forEach((r) => state.chains[r.chain] && prefetchAddress(r.chain, r.address)), { timeout: 2500 });
  if (!cfg.etherscan_key) setMsg("还没有配置 Etherscan API Key，EVM 链暂时无法查询；TRON 和 BTC 可以直接用。请到“设置”页填写。");
  try {
    const s = localStorage.getItem("bd-auto");
    if (s && s !== "0") { $("#w-auto").value = s; $("#w-auto").dispatchEvent(new Event("change")); }
  } catch {}
})();
