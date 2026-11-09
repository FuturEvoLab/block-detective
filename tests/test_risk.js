// 风险评分（static/risk.js）的单元测试：在 Node 里用 vm 加载，给它需要的全局对象打桩。
// 用法：node --test tests/test_risk.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "static", "risk.js"), "utf8");

// labels: { "evm:<addr>": {label, category, note} }；transfers: [{from, to, usd, verified}]（都在 eth 链上）
function harness({ labels = {}, transfers = [], fetched = [], profiles = {} } = {}) {
  const state = {
    labels,
    transfers: new Map(transfers.map((t, i) => [i, { chain: "eth", verified: true, ...t }])),
    fetched: new Set(fetched.map((a) => `eth:${a}`)),
    profiles: new Map(Object.entries(profiles).map(([a, p]) => [`eth:${a}`, p])),
  };
  const ctx = {
    state, I18N: { lang: "zh" }, REDUCED: true, cy: null,
    labelOf: (chain, addr) => state.labels[`evm:${addr}`],
    nid: (chain, addr) => `${chain}:${addr}`,
    tr: (s) => s, gl: (s) => s, esc: (s) => String(s ?? ""),
    nameOf: (chain, addr) => state.labels[`evm:${addr}`]?.label || addr.slice(0, 6),
    fmtUsd: (n) => "$" + Math.round(n),
    lockOn() {}, showNode() {},
    document: { addEventListener() {} },
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const risk = (addr) => vm.runInContext(`riskOf(${JSON.stringify("eth:" + addr)})`, ctx);
  return { ctx, state, risk, run: (code) => vm.runInContext(code, ctx) };
}

const HACKER = { "evm:0xhack": { label: "Some Exploiter", category: "黑客", note: "" } };

test("直接收到黑客大额资金 → 高风险，原因写明来源", () => {
  const h = harness({ labels: HACKER, transfers: [{ from: "0xhack", to: "0xa", usd: 50000 }] });
  const r = h.risk("0xa");
  assert.equal(r.level.key, "high");
  assert.ok(r.score >= 90, `score ${r.score}`);
  assert.match(r.reasons[0].text, /直接收到风险地址/);
  assert.equal(r.reasons[0].ref, "eth:0xhack");
  assert.equal(h.risk("0xhack").score, 100);
  assert.match(h.risk("0xhack").reasons[0].text, /标签为「黑客」/);
});

test("隔一层中转打五折，隔两层再打五折；没有往来的地址没有风险", () => {
  const h = harness({ labels: HACKER, transfers: [
    { from: "0xhack", to: "0xb", usd: 50000 }, { from: "0xb", to: "0xc", usd: 50000 }, { from: "0xc", to: "0xd", usd: 50000 },
    { from: "0xe", to: "0xf", usd: 50000 },
  ] });
  assert.equal(h.risk("0xb").score, 100);
  assert.equal(h.risk("0xc").score, 50);
  assert.equal(h.risk("0xc").level.key, "mid");
  assert.match(h.risk("0xc").reasons[0].text, /间接关联/);
  assert.equal(h.risk("0xd").score, 25);
  assert.equal(h.risk("0xe").score, 0);
  assert.equal(h.risk("0xf").level.key, "none");
  assert.equal(h.risk("0xnothere").score, 0);
});

test("转给风险地址比收到风险资金轻（×0.7）", () => {
  const h = harness({ labels: HACKER, transfers: [{ from: "0xa", to: "0xhack", usd: 50000 }] });
  assert.equal(h.risk("0xa").score, 70);
  assert.match(h.risk("0xa").reasons[0].text, /直接转给风险地址/);
});

test("粉尘金额几乎不算；占往来比例小也打折", () => {
  const h = harness({ labels: HACKER, transfers: [
    { from: "0xhack", to: "0xdust", usd: 3 },
    { from: "0xhack", to: "0xbig", usd: 50000 }, { from: "0xclean", to: "0xbig", usd: 950000 },
  ] });
  const dust = h.risk("0xdust").score;
  assert.ok(dust > 15 && dust < 40, `dust ${dust}`);
  // 风险资金只占 5%：shareFactor = 0.4 + 0.6 × min(1, 0.05 × 4) = 0.52
  assert.equal(h.risk("0xbig").score, 52);
});

test("交易所等已知实体：分数封顶 30，而且不向外传播风险", () => {
  const labels = { ...HACKER, "evm:0xcex": { label: "Big Exchange", category: "交易所", note: "" } };
  const h = harness({ labels, transfers: [{ from: "0xhack", to: "0xcex", usd: 500000 }, { from: "0xcex", to: "0xuser", usd: 500000 }] });
  const cex = h.risk("0xcex");
  assert.equal(cex.score, 30);
  assert.ok(cex.reasons.some((x) => /封顶/.test(x.text)));
  assert.equal(h.risk("0xuser").score, 0);
});

test("标签备注里的制裁 / 被盗关键词也算风险源（80 分），已知实体除外", () => {
  const labels = {
    "evm:0xofac": { label: "Wallet X", category: "其他", note: "OFAC sanctioned 2024" },
    "evm:0xcex": { label: "Exchange", category: "交易所", note: "stolen funds passed through" },
  };
  const h = harness({ labels, transfers: [{ from: "0xofac", to: "0xk", usd: 50000 }, { from: "0xcex", to: "0xm", usd: 50000 }] });
  assert.equal(h.risk("0xofac").score, 80);
  assert.equal(h.risk("0xk").score, 80);
  assert.equal(h.risk("0xcex").score, 0);
  assert.equal(h.risk("0xm").score, 0);
});

test("行为特征只对已展开的地址判断：快进快出、分散转出、新地址大额", () => {
  const spread = Array.from({ length: 25 }, (_, i) => ({ from: "0xsplit", to: `0xout${i}`, usd: 1000 }));
  const transfers = [
    { from: "0xx", to: "0xpass", usd: 100000 }, { from: "0xpass", to: "0xy", usd: 98000 },
    { from: "0xfund", to: "0xsplit", usd: 30000 }, ...spread,
    { from: "0xz", to: "0xfresh", usd: 200000 },
  ];
  const profiles = { "0xfresh": { first_seen: Date.now() / 1000 - 5 * 86400 } };
  const unexpanded = harness({ transfers, profiles });
  assert.equal(unexpanded.risk("0xpass").score, 0);
  const h = harness({ transfers, profiles, fetched: ["0xpass", "0xsplit", "0xfresh"] });
  assert.equal(h.risk("0xpass").score, 12);
  assert.match(h.risk("0xpass").reasons[0].text, /快进快出/);
  assert.equal(h.risk("0xsplit").score, 10);
  assert.match(h.risk("0xsplit").reasons[0].text, /分散转给 25 个地址/);
  assert.equal(h.risk("0xfresh").score, 10);
  assert.match(h.risk("0xfresh").reasons[0].text, /新地址/);
  assert.equal(h.risk("0xpass").level.key, "none"); // 12 分还不到“低风险”
});

test("收到多笔未验证代币 → 提示可能是投毒目标，不计分", () => {
  const h = harness({ transfers: [1, 2, 3].map((i) => ({ from: `0xspam${i}`, to: "0xv", usd: 0, verified: false })) });
  const r = h.risk("0xv");
  assert.equal(r.score, 0);
  assert.ok(r.reasons.some((x) => x.info && /投毒/.test(x.text)));
});

test("结果有缓存：数据和标签没变时返回同一个对象，标签换了重新算", () => {
  const h = harness({ labels: HACKER, transfers: [{ from: "0xhack", to: "0xa", usd: 50000 }] });
  const a = h.run("computeRisk()");
  assert.equal(h.run("computeRisk()"), a);
  h.state.labels = { ...HACKER, "evm:0xa": { label: "Binance", category: "交易所", note: "" } };
  const b = h.run("computeRisk()");
  assert.notEqual(b, a);
  assert.equal(h.risk("0xa").score, 30);
});

test("分级阈值与徽章", () => {
  const h = harness();
  assert.deepEqual([0, 14, 15, 39, 40, 74, 75, 100].map((s) => h.run(`riskLevel(${s}).key`)),
    ["none", "none", "low", "low", "mid", "mid", "high", "high"]);
  assert.equal(h.run('riskBadge("eth:0xnone")'), "");
});
