// 区块侦探 — 资金路径追踪：在已加载的数据里找出资金从 A 流到 B 经过的中转地址
// 按资金方向搜索最短的几条路径（最多 6 跳），按“瓶颈金额”（路径上最小一段的金额）排序，
// 并检查时间顺序：每一段都要能找到晚于上一段的转账，才算资金可能真的沿这条路走过。

const pathState = { from: null, to: null, paths: [], cur: 0 };
const PATH_MAX_HOPS = 6, PATH_MAX = 8;

function setPathFrom(id) {
  pathState.from = id;
  const [c, a] = splitId(id);
  toast(`已设为路径起点：${nameOf(c, a)}。再选一个地址点“追踪到这里”`);
  showNode(id);
}
const splitId = (id) => { const i = id.indexOf(":"); return [id.slice(0, i), id.slice(i + 1)]; };

function findPaths(from, to) {
  const edges = aggregateEdges({ ...filters(), dir: "", min: 0 });
  const out = new Map();
  for (const e of edges.values()) (out.get(e.source) || out.set(e.source, []).get(e.source)).push(e);
  // BFS 求最短跳数，再用 DFS 枚举不超过“最短 + 1”跳的简单路径
  const dist = new Map([[from, 0]]), q = [from];
  while (q.length) {
    const u = q.shift();
    if (dist.get(u) >= PATH_MAX_HOPS) continue;
    for (const e of out.get(u) || []) if (!dist.has(e.target)) { dist.set(e.target, dist.get(u) + 1); q.push(e.target); }
  }
  if (!dist.has(to)) return [];
  const limit = Math.min(PATH_MAX_HOPS, dist.get(to) + 1), found = [];
  let budget = 20000;
  const walk = (u, trail, seen) => {
    if (--budget < 0 || found.length >= 200) return;
    if (u === to) return found.push(trail.slice());
    if (trail.length >= limit) return;
    for (const e of out.get(u) || []) {
      if (seen.has(e.target)) continue;
      seen.add(e.target); trail.push(e);
      walk(e.target, trail, seen);
      trail.pop(); seen.delete(e.target);
    }
  };
  walk(from, [], new Set([from]));
  return found.map((hops) => {
    // 时间顺序：每段取不早于上一段的最早一笔
    let t = -Infinity, ordered = true;
    for (const e of hops) {
      const ts = e.list.map((x) => x.ts).filter((x) => x >= t).sort((a, b) => a - b)[0];
      if (ts == null) { ordered = false; break; }
      t = ts;
    }
    return { hops, bottleneck: Math.min(...hops.map((e) => e.usd)), ordered };
  }).sort((a, b) => b.ordered - a.ordered || a.hops.length - b.hops.length || b.bottleneck - a.bottleneck).slice(0, PATH_MAX);
}

function tracePath(to) {
  const from = pathState.from;
  if (!from || from === to) return toast("请先在另一个地址上点“设为路径起点”");
  let paths = findPaths(from, to), reversed = false;
  if (!paths.length) { paths = findPaths(to, from); reversed = paths.length > 0; }
  pathState.to = to; pathState.paths = paths; pathState.cur = 0; pathState.reversed = reversed;
  state.pathKeep = new Set(paths.flatMap((p) => p.hops.flatMap((e) => [e.source, e.target])));
  renderAll();
  renderPathPanel();
  highlightPath(0);
}

function highlightPath(i, fit = true) {
  if (!cy) return;
  pathState.cur = i;
  const p = pathState.paths[i];
  cy.batch(() => {
    cy.elements().removeClass("path path-dim");
    if (!p) return;
    const ids = new Set(p.hops.flatMap((e) => [e.id, e.source, e.target]));
    cy.elements().forEach((el) => el.addClass(ids.has(el.id()) ? "path" : "path-dim"));
  });
  if (p && fit) cy.animate({ fit: { eles: cy.elements(".path"), padding: 70 } }, { duration: REDUCED ? 0 : 500, easing: "ease-in-out-cubic" });
  $$("#side .path-card").forEach((c) => c.classList.toggle("on", +c.dataset.i === i));
}

function clearPath() {
  pathState.paths = []; pathState.to = null;
  state.pathKeep = null;
  if (cy) cy.elements().removeClass("path path-dim");
}

function renderPathPanel() {
  const { paths, reversed } = pathState;
  const [fc, fa] = splitId(reversed ? pathState.to : pathState.from), [tc, ta] = splitId(reversed ? pathState.from : pathState.to);
  const node = (id) => { const [c, a] = splitId(id); return `<span class="path-node" data-node="${esc(id)}">${esc(nameOf(c, a))}</span>`; };
  const cards = paths.map((p, i) => `<div class="path-card ${i === 0 ? "on" : ""}" data-i="${i}">
      <div class="path-meta"><b>${i + 1}</b><span class="badge">${p.hops.length} 跳</span><span class="badge">瓶颈 ${fmtUsd(p.bottleneck)}</span>
        ${p.ordered ? `<span class="badge ok">时间顺序成立</span>` : `<span class="badge no">时间顺序不成立</span>`}</div>
      <div class="path-chain">${node(p.hops[0].source)}${p.hops.map((e) => `<div class="path-hop"><i></i><span>${e.usd > 0 ? fmtUsd(e.usd) : Object.keys(e.tokens).join("+")} · <span>${tr(`${e.count} 笔`)}</span> · ${fmtTime(Math.min(...e.list.map((x) => x.ts)), false)}</span></div>${node(e.target)}`).join("")}</div>
    </div>`).join("");
  setPanel(`<div class="section-title">资金路径</div>
    <div class="path-head">${node(nid(fc, fa))}<span class="path-arrow">→</span>${node(nid(tc, ta))}</div>
    ${reversed ? `<p class="muted">没有找到从起点流向这里的路径，下面是反方向（从这里流向起点）的路径。</p>` : ""}
    ${paths.length ? `<p class="muted">在已加载的数据里找到 ${paths.length} 条路径。瓶颈金额是路径上最小一段的金额，表示最多可能有多少资金沿这条路走过。</p>${cards}`
      : `<p class="muted">在已加载的数据里没有找到两者之间的资金路径。可以先双击展开中间的地址，加载更多数据后再试。</p>`}
    <div class="actions"><button class="small" data-path="clear">清除路径</button></div>`);
  $("#side").dataset.id = "";
}

$("#side").addEventListener("click", (e) => {
  const card = e.target.closest(".path-card"), n = e.target.closest(".path-node"), act = e.target.closest("[data-path]");
  if (n && cy) {
    const el = cy.getElementById(n.dataset.node);
    if (el.nonempty()) { lockOn(el); cy.animate({ center: { eles: el } }, { duration: REDUCED ? 0 : 300 }); }
    return;
  }
  if (card) highlightPath(+card.dataset.i);
  if (act?.dataset.path === "clear") { clearPath(); renderAll(); if (state.center) showNode(centerId()); }
});
