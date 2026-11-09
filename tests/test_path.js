// 资金路径追踪（static/path.js）的单元测试：在 Node 里用 vm 加载，边的汇总用 app.js 里真正的 aggregateEdges。
// 用法：node --test tests/test_path.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const PATH_SRC = fs.readFileSync(path.join(__dirname, "..", "static", "path.js"), "utf8");
const APP_SRC = fs.readFileSync(path.join(__dirname, "..", "static", "app.js"), "utf8");
const AGG_SRC = APP_SRC.match(/function aggregateEdges\(f\) \{[\s\S]*?\n\}\n/)[0];
assert.ok(AGG_SRC.includes("edges.set"), "aggregateEdges not found in app.js");

// transfers: [{from, to, usd, ts}]（都在 eth 链上，已验证代币）
function harness(transfers) {
  const state = {
    transfers: new Map(transfers.map((t, i) => [i, { chain: "eth", verified: true, symbol: "ETH", amount: 1, ...t }])),
    center: null, pathKeep: null,
  };
  const calls = { toast: [], render: 0, panel: 0, highlight: [] };
  const ctx = {
    state, REDUCED: true, cy: null, calls,
    nid: (c, a) => `${c}:${a}`,
    filters: () => ({ dir: "", token: "", min: 0, hide: false, from: 0, to: Infinity, top: 30 }),
    pass: () => true,
    toast: (m) => calls.toast.push(m), showNode() {}, nameOf: (c, a) => a, esc: (s) => String(s ?? ""),
    fmtUsd: (n) => "$" + Math.round(n), fmtTime: (t) => String(t), tr: (s) => s, setPanel() { calls.panel++; }, lockOn() {},
    renderAll() { calls.render++; }, centerId: () => null,
    $: () => ({ dataset: {}, addEventListener() {} }), $$: () => [],
    document: { addEventListener() {} }, Math, Set, Map, Infinity,
  };
  vm.createContext(ctx);
  vm.runInContext(AGG_SRC + "\n" + PATH_SRC, ctx);
  // vm 里创建的数组和测试里的 Array 不是同一个原型，deepEqual 会认为不同；拷贝一份到当前 realm
  const run = (code) => { const v = vm.runInContext(code, ctx); return v && typeof v === "object" ? structuredClone(v) : v; };
  return { ctx, state, calls, run };
}
const ids = (p) => [p.hops[0].source, ...p.hops.map((e) => e.target)].map((x) => x.slice(4));

test("直线路径：瓶颈 = 最小一段，时间顺序成立", () => {
  const h = harness([{ from: "A", to: "B", usd: 100, ts: 10 }, { from: "B", to: "C", usd: 50, ts: 20 }, { from: "C", to: "D", usd: 80, ts: 30 }]);
  const paths = h.run('findPaths("eth:A", "eth:D")');
  assert.equal(paths.length, 1);
  assert.deepEqual(ids(paths[0]), ["A", "B", "C", "D"]);
  assert.equal(paths[0].bottleneck, 50);
  assert.equal(paths[0].ordered, true);
});

test("时间顺序：下游那段早于上游时不成立；多笔转账里取第一笔不早于上一段的", () => {
  const bad = harness([{ from: "A", to: "B", usd: 100, ts: 50 }, { from: "B", to: "C", usd: 50, ts: 20 }]);
  assert.equal(bad.run('findPaths("eth:A", "eth:C")')[0].ordered, false);
  const ok = harness([{ from: "A", to: "B", usd: 100, ts: 50 }, { from: "B", to: "C", usd: 50, ts: 20 }, { from: "B", to: "C", usd: 10, ts: 60 }]);
  const p = ok.run('findPaths("eth:A", "eth:C")')[0];
  assert.equal(p.ordered, true);
  assert.equal(p.bottleneck, 60); // 同一对地址的多笔转账汇总成一条边
});

test("排序：时间顺序成立优先，再按跳数少，再按瓶颈大；只枚举不超过最短 + 1 跳的路径", () => {
  const h = harness([
    { from: "A", to: "D", usd: 5, ts: 1 },                                               // 直达，1 跳，瓶颈 5
    { from: "A", to: "B", usd: 100, ts: 1 }, { from: "B", to: "D", usd: 70, ts: 2 },     // 2 跳，瓶颈 70，顺序成立
    { from: "A", to: "C", usd: 100, ts: 9 }, { from: "C", to: "D", usd: 90, ts: 2 },     // 2 跳，瓶颈 90，顺序不成立
    { from: "A", to: "E", usd: 100, ts: 1 }, { from: "E", to: "F", usd: 100, ts: 2 }, { from: "F", to: "D", usd: 100, ts: 3 }, // 3 跳：超出最短 + 1
  ]);
  const paths = h.run('findPaths("eth:A", "eth:D")');
  assert.deepEqual(paths.map(ids), [["A", "D"], ["A", "B", "D"], ["A", "C", "D"]]);
  assert.deepEqual(paths.map((p) => p.ordered), [true, true, false]);
});

test("只沿资金方向走；找不到返回空；超过 6 跳不找", () => {
  const h = harness([{ from: "B", to: "A", usd: 100, ts: 1 }]);
  assert.deepEqual(h.run('findPaths("eth:A", "eth:B")'), []);
  assert.equal(h.run('findPaths("eth:B", "eth:A")').length, 1);
  const chain = Array.from({ length: 8 }, (_, i) => ({ from: `N${i}`, to: `N${i + 1}`, usd: 10, ts: i }));
  const long = harness(chain);
  assert.equal(long.run('findPaths("eth:N0", "eth:N6")').length, 1); // 6 跳刚好
  assert.deepEqual(long.run('findPaths("eth:N0", "eth:N7")'), []);  // 7 跳太远
  const self = harness([{ from: "A", to: "A", usd: 10, ts: 1 }, { from: "A", to: "B", usd: 10, ts: 1 }]);
  assert.equal(self.run('findPaths("eth:A", "eth:B")').length, 1);  // 自转账被忽略
});

test("环路不会无限循环，也不会重复经过同一个地址", () => {
  const h = harness([
    { from: "A", to: "B", usd: 10, ts: 1 }, { from: "B", to: "C", usd: 10, ts: 2 }, { from: "C", to: "B", usd: 10, ts: 3 },
    { from: "C", to: "A", usd: 10, ts: 3 }, { from: "C", to: "D", usd: 10, ts: 4 },
  ]);
  const paths = h.run('findPaths("eth:A", "eth:D")');
  assert.deepEqual(paths.map(ids), [["A", "B", "C", "D"]]);
});

test("tracePath：正向没有就找反向并标记 reversed；涉及的地址进入 pathKeep", () => {
  const h = harness([{ from: "X", to: "Y", usd: 10, ts: 1 }, { from: "Y", to: "Z", usd: 10, ts: 2 }]);
  h.run('pathState.from = "eth:Z"; tracePath("eth:X")');
  assert.equal(h.run("pathState.reversed"), true);
  assert.equal(h.run("pathState.paths.length"), 1);
  assert.deepEqual([...h.state.pathKeep].sort(), ["eth:X", "eth:Y", "eth:Z"]);
  assert.equal(h.calls.render, 1);
  assert.equal(h.calls.panel, 1);
  h.run("clearPath()");
  assert.equal(h.run("pathState.paths.length"), 0);
  assert.equal(h.state.pathKeep, null);
  h.run('pathState.from = null; tracePath("eth:X")');
  assert.match(h.calls.toast.at(-1), /设为路径起点/);
});
