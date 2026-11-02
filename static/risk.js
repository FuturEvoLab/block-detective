// 区块侦探 — 地址风险评分
// 只用已经加载到本地的数据，在浏览器里实时计算，不额外请求接口。
// 思路：标签给出“风险源”（黑客、混币器……），风险沿资金往来向外传播，每多隔一层打一次折；
// 再叠加几条行为特征（快进快出、分散转出、新地址大额）。交易所等已知实体不向外传播风险。

const RISK_BASE = { 黑客: 100, 混币器: 90, 嫌疑人: 85, 风险: 75 };
// 已知实体：和黑客打过交道很正常（比如黑客往交易所充值），所以既不传播风险，自己的分数也封顶
const RISK_TRUSTED = new Set(["交易所", "机构", "做市商", "合约"]);
const RISK_WORDS = /制裁|OFAC|sanction|被盗|stolen|exploit|钓鱼|phish|诈骗|scam|洗钱|launder/i;
const RISK_LEVELS = [
  { min: 75, key: "high", text: "高风险" },
  { min: 40, key: "mid", text: "中风险" },
  { min: 15, key: "low", text: "低风险" },
  { min: 0, key: "none", text: "未发现风险" },
];
const riskLevel = (score) => RISK_LEVELS.find((l) => score >= l.min);

function riskBase(chain, addr) {
  const lbl = labelOf(chain, addr);
  if (!lbl) return 0;
  let s = RISK_BASE[lbl.category] || 0;
  if (!RISK_TRUSTED.has(lbl.category) && RISK_WORDS.test(`${lbl.label} ${lbl.note}`)) s = Math.max(s, 80);
  return s;
}

// 占比越高越严重：哪怕只有一笔也至少算 40%，占到四分之一及以上算满
const shareFactor = (share) => 0.4 + 0.6 * Math.min(1, share * 4);
// 金额越大越严重：几美元的“粉尘”（黑客常用来骚扰或嘲讽）只算很少，1 万美元以上算满
const amountFactor = (usd) => 0.25 + 0.75 * Math.min(1, Math.log10(1 + usd) / 4);

let riskCache = { key: "", labels: null, map: new Map() };

function computeRisk() {
  const key = `${state.transfers.size}|${state.fetched.size}|${state.profiles.size}|${I18N.lang}`;
  if (riskCache.key === key && riskCache.labels === state.labels) return riskCache.map; // 标签每次保存都会换成新对象

  // 1. 汇总每对地址之间的往来（只看可信代币，避免投毒假币干扰）
  const pairs = new Map(); // id -> Map(cp -> {in, out, n})
  const tot = new Map();   // id -> {in, out, inN, outN, outCps:Set, fake}
  const node = (id) => {
    if (!pairs.has(id)) pairs.set(id, new Map());
    if (!tot.has(id)) tot.set(id, { in: 0, out: 0, inN: 0, outN: 0, outCps: new Set(), fake: 0 });
    return tot.get(id);
  };
  for (const t of state.transfers.values()) {
    if (t.from === t.to) continue;
    const s = nid(t.chain, t.from), d = nid(t.chain, t.to);
    const ts = node(s), td = node(d);
    if (!t.verified) { td.fake++; continue; }
    const v = Math.max(t.usd || 0, 1); // 未定价的也算一点权重
    ts.out += v; ts.outN++; ts.outCps.add(d);
    td.in += v; td.inN++;
    const a = pairs.get(s).get(d) || { in: 0, out: 0, n: 0 };
    a.out += v; a.n++; pairs.get(s).set(d, a);
    const b = pairs.get(d).get(s) || { in: 0, out: 0, n: 0 };
    b.in += v; b.n++; pairs.get(d).set(s, b);
  }

  const split = (id) => { const i = id.indexOf(":"); return [id.slice(0, i), id.slice(i + 1)]; };
  const info = new Map();
  for (const id of pairs.keys()) {
    const [chain, addr] = split(id);
    const cat = labelOf(chain, addr)?.category;
    info.set(id, { base: riskBase(chain, addr), trusted: RISK_TRUSTED.has(cat), score: 0, via: null });
  }
  for (const r of info.values()) r.score = r.base;

  // 2. 风险传播：直接接触风险源按原值，经过未标记地址中转则每层打五折；最多 3 层
  for (let round = 0; round < 3; round++) {
    const next = new Map();
    for (const [id, r] of info) {
      if (r.base >= 100) continue;
      const t = tot.get(id), total = t.in + t.out || 1;
      let best = r.score, via = r.via;
      for (const [cp, p] of pairs.get(id)) {
        const c = info.get(cp);
        if (!c || c.trusted || c.score <= 0) continue;
        const hop = c.base > 0 ? 1 : 0.5;
        const dirW = p.in >= p.out ? 1 : 0.7; // 收到风险资金比转给风险地址更严重
        const s = c.score * hop * dirW * shareFactor((p.in + p.out) / total) * amountFactor(p.in + p.out);
        if (s > best + 0.5) { best = s; via = { cp, p, direct: c.base > 0 }; }
      }
      if (best !== r.score) next.set(id, { score: best, via });
    }
    if (!next.size) break;
    for (const [id, v] of next) Object.assign(info.get(id), v);
  }

  // 3. 组装结果：分数 + 原因
  const map = new Map();
  for (const [id, r] of info) {
    const [chain, addr] = split(id);
    const t = tot.get(id);
    const reasons = [];
    let score = r.score;
    if (r.base > 0) {
      const lbl = labelOf(chain, addr);
      reasons.push({ pts: r.base, text: `标签为「${tr(lbl.category)}」：${gl(lbl.label)}` });
    } else if (r.via) {
      const { cp, p, direct } = r.via;
      const [cc, ca] = split(cp);
      const total = t.in + t.out || 1;
      const pct = Math.round(((p.in + p.out) / total) * 100);
      const verb = p.in >= p.out ? "收到" : "转给";
      const usd = p.in >= p.out ? p.in : p.out;
      reasons.push({
        pts: Math.round(r.score), ref: cp,
        text: direct
          ? `直接${verb}风险地址 ${nameOf(cc, ca)} ${fmtUsd(usd)}（占往来 ${pct}%）`
          : `间接关联：经 ${nameOf(cc, ca)} 与风险地址有资金往来（占往来 ${pct}%）`,
      });
    }
    // 行为特征只对已展开（数据较完整）的地址判断
    if (state.fetched.has(id) && !r.trusted) {
      if (t.in > 10000 && t.out > 10000 && Math.abs(t.in - t.out) / Math.max(t.in, t.out) < 0.1) {
        score += 12; reasons.push({ pts: 12, text: "资金快进快出、几乎不留存（疑似中转地址）" });
      }
      if (t.outCps.size >= 20 && t.outN >= 20 && t.inN <= t.outN / 5) {
        score += 10; reasons.push({ pts: 10, text: `少量流入后分散转给 ${t.outCps.size} 个地址（疑似拆分转移）` });
      }
      const prof = state.profiles.get(id);
      if (prof?.first_seen && Date.now() / 1000 - prof.first_seen < 30 * 86400 && t.in + t.out > 100000) {
        score += 10; reasons.push({ pts: 10, text: "新地址（30 天内首次活跃）却有大额往来" });
      }
    }
    if (r.trusted && score > 30) {
      score = 30; reasons.push({ pts: 0, text: "已知实体（交易所 / 机构等），风险分已封顶" });
    }
    if (t.fake >= 3) reasons.push({ pts: 0, info: true, text: `收到 ${t.fake} 笔未验证代币，可能是地址投毒目标（不计分）` });
    score = Math.min(100, Math.round(score));
    map.set(id, { score, level: riskLevel(score), reasons });
  }
  riskCache = { key, labels: state.labels, map };
  return map;
}

const riskOf = (id) => computeRisk().get(id) || { score: 0, level: riskLevel(0), reasons: [] };
const RISK_COLOR = { high: "#ff3b6b", mid: "#ff9f1c", low: "#ffd23f", none: "#22ffa6" };

function riskBadge(id, withScore = true) {
  const r = riskOf(id);
  if (r.level.key === "none") return "";
  return `<span class="risk-badge ${r.level.key}" title="${esc(r.reasons.map((x) => tr(x.text)).join("\n"))}"><span>${r.level.text}</span>${withScore ? `<span>${r.score}</span>` : ""}</span>`;
}

// 半圆仪表 + 原因列表
function riskSection(id) {
  const r = riskOf(id);
  const color = RISK_COLOR[r.level.key];
  const R = 46, L = Math.PI * R, len = (r.score / 100) * L;
  const list = r.reasons.length
    ? r.reasons.map((x) => `<li class="${x.info ? "info" : ""}">${x.pts ? `<b>+${x.pts}</b>` : "<b>·</b>"}<span>${
        x.ref ? `<span class="risk-ref" data-node="${esc(x.ref)}">${esc(x.text)}</span>` : esc(x.text)}</span></li>`).join("")
    : `<li class="info"><b>·</b><span>在已加载的数据里没有发现与风险地址的往来</span></li>`;
  return `<div class="section risk-box ${r.level.key}" style="--rc:${color}">
    <div class="section-title">风险评估</div>
    <div class="risk-main">
      <svg viewBox="0 0 110 62" class="risk-gauge" aria-hidden="true">
        <path d="M9 56a46 46 0 0 1 92 0" class="track"/>
        <path d="M9 56a46 46 0 0 1 92 0" class="val" stroke-dasharray="${len.toFixed(1)} ${L.toFixed(1)}"/>
        <text x="55" y="50" text-anchor="middle">${r.score}</text>
      </svg>
      <div><div class="risk-lv">${r.level.text}</div><div class="muted risk-note">基于已加载数据和标签库估算，仅供参考</div></div>
    </div>
    <ul class="risk-reasons">${list}</ul>
  </div>`;
}

// 点击原因里的地址：在图上定位到该节点
document.addEventListener("click", (e) => {
  const el = e.target.closest(".risk-ref");
  if (!el || !cy) return;
  const n = cy.getElementById(el.dataset.node);
  if (n.empty()) return;
  cy.animate({ center: { eles: n }, duration: REDUCED ? 0 : 400 });
  lockOn(n); showNode(n.id());
});
