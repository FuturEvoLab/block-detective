// 区块侦探 — 调查报告：把当前调查导出成一个独立的 HTML 文件（含资金图），可直接发给别人或打印成 PDF
// 报告语言跟随界面语言（固定文案经 tr() 翻译）；样式为浅色、适合打印。

function buildReport() {
  const { chain, address } = state.center;
  const id = centerId(), f = filters();
  const st = statsFor(id, f), prof = state.profiles.get(id), lbl = labelOf(chain, address), risk = riskOf(id);
  const T = (s) => esc(tr(s));
  const now = new Date();
  // 按当前主题配色导出资金图，节点文字才清楚
  const img = cy && cy.nodes().length ? cy.png({ full: true, scale: 2, maxWidth: 2400, bg: getVar("--bg") || "#ffffff" }) : "";
  const rc = { high: "#d61f45", mid: "#d97706", low: "#b59a00", none: "#16a34a" }[risk.level.key];

  // 主要对手方
  const cps = new Map();
  for (const t of centerTransfers(f)) {
    const cp = t.dir === "in" ? t.from : t.to;
    const r = cps.get(cp) || { in: 0, out: 0, n: 0 };
    r[t.dir === "in" ? "in" : "out"] += t.usd || 0; r.n++;
    cps.set(cp, r);
  }
  const top = [...cps].sort((a, b) => b[1].in + b[1].out - (a[1].in + a[1].out)).slice(0, 20);
  // 图中的中高风险地址
  const risky = [...computeRisk()].filter(([k, v]) => k !== id && ["high", "mid"].includes(v.level.key)).sort((a, b) => b[1].score - a[1].score).slice(0, 20);
  // 大额转账
  const big = centerTransfers(f).filter((t) => t.usd).sort((a, b) => b.usd - a.usd).slice(0, 25);
  // 按月汇总
  const months = new Map();
  for (const t of centerTransfers(f)) {
    const m = fmtTime(t.ts, false).slice(0, 7), r = months.get(m) || { in: 0, out: 0, n: 0 };
    r[t.dir === "in" ? "in" : "out"] += t.usd || 0; r.n++;
    months.set(m, r);
  }
  const name = (c, a) => esc(nameOf(c, a));
  const cpRow = ([cp, r]) => `<tr><td>${name(chain, cp)}<div class="a">${esc(cp)}</div></td><td>${esc(tr(labelOf(chain, cp)?.category || ""))}</td><td class="n in">${r.in ? fmtUsd(r.in) : ""}</td><td class="n out">${r.out ? fmtUsd(r.out) : ""}</td><td class="n">${r.n}</td></tr>`;
  const paths = pathState.paths.slice(0, 3);

  return `<!doctype html><html lang="${document.documentElement.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${T("调查报告")} · ${name(chain, address)}</title>
<style>
  body { font: 14px/1.6 -apple-system, "Hiragino Sans", "PingFang SC", "Segoe UI", sans-serif; color: #111827; margin: 0; background: #f3f4f6; }
  main { max-width: 980px; margin: 24px auto; background: #fff; padding: 36px 44px; box-shadow: 0 2px 16px rgba(0,0,0,.06); }
  h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 28px 0 10px; padding-bottom: 6px; border-bottom: 2px solid #111827; }
  .sub { color: #6b7280; font-size: 12.5px; } .a { font: 11px ui-monospace, Menlo, monospace; color: #6b7280; word-break: break-all; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-top: 16px; }
  .k { border: 1px solid #e5e7eb; padding: 10px 12px; } .k span { display: block; font-size: 11.5px; color: #6b7280; } .k b { font-size: 18px; }
  .risk { display: flex; gap: 16px; align-items: center; border-left: 4px solid ${rc}; background: #fafafa; padding: 12px 16px; margin-top: 14px; }
  .risk .s { font-size: 34px; font-weight: 800; color: ${rc}; } .risk ul { margin: 4px 0 0; padding-left: 18px; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; } th, td { padding: 6px 8px; border-bottom: 1px solid #e5e7eb; text-align: left; vertical-align: top; }
  th { background: #f9fafb; font-size: 11.5px; color: #374151; } .n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .in { color: #059669; } .out { color: #dc2626; } img { width: 100%; border: 1px solid #e5e7eb; }
  .path { border: 1px solid #e5e7eb; padding: 8px 12px; margin-bottom: 8px; font-size: 13px; }
  .foot { margin-top: 32px; font-size: 11.5px; color: #6b7280; border-top: 1px solid #e5e7eb; padding-top: 10px; }
  @media print { body { background: #fff; } main { box-shadow: none; margin: 0; padding: 0; } h2 { break-after: avoid; } tr, .path { break-inside: avoid; } }
</style></head><body><main>
<div class="sub">${T("区块侦探 · 调查报告")} · ${esc(fmtTime(now / 1000))}</div>
<h1>${name(chain, address)}</h1>
<div class="a">${esc(address)} · ${esc(state.chains[chain].name)}${lbl ? ` · ${esc(tr(lbl.category))}` : ""}</div>
${lbl?.note ? `<p class="sub">${esc(gl(lbl.note))}</p>` : ""}

<div class="risk"><div class="s">${risk.score}</div><div><b style="color:${rc}">${T(risk.level.text)}</b>
  <ul>${risk.reasons.map((r) => `<li>${esc(tr(r.text))}</li>`).join("") || `<li>${T("在已加载的数据里没有发现与风险地址的往来")}</li>`}</ul></div></div>

<div class="grid">
  <div class="k"><span>${T("当前余额")}</span><b>${prof ? fmtUsd(prof.balances.reduce((a, b) => a + (b.usd || 0), 0)) : "-"}</b></div>
  <div class="k"><span>${T("流入")}</span><b class="in">${fmtUsd(st.inUsd)}</b></div>
  <div class="k"><span>${T("流出")}</span><b class="out">${fmtUsd(st.outUsd)}</b></div>
  <div class="k"><span>${T("对手方")}</span><b>${st.cps}</b></div>
  <div class="k"><span>${T("首次活跃")}</span><b>${prof?.first_seen ? fmtTime(prof.first_seen, false) : "-"}</b></div>
  <div class="k"><span>${T("最初资金来源")}</span><b style="font-size:13px">${prof?.funded_by ? name(chain, prof.funded_by) : "-"}</b></div>
  <div class="k"><span>${T("时间范围")}</span><b style="font-size:13px">${st.first ? fmtTime(st.first, false) + " ~ " + fmtTime(st.last, false) : "-"}</b></div>
  <div class="k"><span>${T("已展开地址")}</span><b>${state.fetched.size}</b></div>
</div>

${img ? `<h2>${T("资金流向图")}</h2><img src="${img}" alt="">` : ""}

${paths.length ? `<h2>${T("资金路径")}</h2>${paths.map((p, i) => `<div class="path"><b>${i + 1}.</b> ${name(...splitId(p.hops[0].source))}${p.hops.map((e) => ` → <span class="sub">${fmtUsd(e.usd)}</span> → ${name(...splitId(e.target))}`).join("")}
  <div class="sub">${esc(tr(`${p.hops.length} 跳`))} · ${T("瓶颈")} ${fmtUsd(p.bottleneck)} · ${T(p.ordered ? "时间顺序成立" : "时间顺序不成立")}</div></div>`).join("")}` : ""}

<h2>${T("主要对手方")}</h2>
<table><tr><th>${T("地址")}</th><th>${T("分类")}</th><th class="n">${T("流入")}</th><th class="n">${T("流出")}</th><th class="n">${T("笔数")}</th></tr>${top.map(cpRow).join("")}</table>

${risky.length ? `<h2>${T("图中的中高风险地址")}</h2><table><tr><th>${T("地址")}</th><th class="n">${T("风险评分")}</th><th>${T("原因")}</th></tr>${risky.map(([k, v]) => {
    const [c, a] = splitId(k);
    return `<tr><td>${name(c, a)}<div class="a">${esc(a)}</div></td><td class="n">${v.score}</td><td>${v.reasons.map((r) => esc(tr(r.text))).join("<br>")}</td></tr>`;
  }).join("")}</table>` : ""}

<h2>${T("大额转账")}</h2>
<table><tr><th>${T("时间")}</th><th>${T("方向")}</th><th>${T("对手方")}</th><th class="n">${T("数量")}</th><th class="n">${T("美元")}</th><th>${T("交易")}</th></tr>${big.map((t) => {
    const cp = t.dir === "in" ? t.from : t.to;
    return `<tr><td>${fmtTime(t.ts)}</td><td class="${t.dir}">${T(t.dir === "in" ? "流入" : "流出")}</td><td>${name(chain, cp)}<div class="a">${esc(cp)}</div></td><td class="n">${fmtNum(t.amount)} ${esc(t.symbol)}</td><td class="n">${fmtUsd(t.usd)}</td><td><a href="${explorerTx(t.chain, t.hash)}">${esc(short(t.hash))}</a></td></tr>`;
  }).join("")}</table>

<h2>${T("按月汇总")}</h2>
<table><tr><th>${T("月份")}</th><th class="n">${T("流入")}</th><th class="n">${T("流出")}</th><th class="n">${T("净流入")}</th><th class="n">${T("笔数")}</th></tr>${[...months].sort((a, b) => b[0].localeCompare(a[0])).map(([m, r]) =>
    `<tr><td>${m}</td><td class="n in">${fmtUsd(r.in)}</td><td class="n out">${fmtUsd(r.out)}</td><td class="n ${r.in - r.out >= 0 ? "in" : "out"}">${(r.in - r.out >= 0 ? "+" : "-") + fmtUsd(Math.abs(r.in - r.out))}</td><td class="n">${r.n}</td></tr>`).join("")}</table>

<div class="foot">${T("数据来源：Etherscan / TronGrid / mempool.space 链上数据，CoinGecko 价格（当前价格，非交易时价格）。只包含每个地址最近的部分转账；风险评分基于标签库和已加载数据估算，仅供参考。")}</div>
</main></body></html>`;
}

$("#btn-report").addEventListener("click", () => {
  if (!state.center || !state.transfers.size) return toast("还没有正在进行的调查");
  const html = buildReport();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  const nm = nameOf(state.center.chain, state.center.address).replace(/[\\/:*?"<>|…\s]+/g, "_");
  a.download = `${tr("区块侦探")}_${tr("调查报告")}_${nm}_${fmtTime(Date.now() / 1000, false)}.html`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast("已导出调查报告（HTML，可在浏览器里打印成 PDF）");
});
