// 区块侦探 — 在线演示版（GitHub Pages）专用：没有后端，页面的 /api/ 请求由这里用预先录好的示例数据回答。
// 只在 tools/build_demo.py 生成的 docs/ 里加载，本地运行的完整版不会用到这个文件。
(function () {
  const REPO = "https://github.com/FuturEvoLab/block-detective";
  const DEMO_ERR = "在线演示版只包含预置的示例数据，不能查询新地址或修改设置。完整功能请下载到本地运行";
  const base = document.currentScript.src.replace(/demo\.js.*$/, "");
  // 链接参数：?lang=en|ja|zh 指定界面语言（README 各语言版本用），?tab=market 等直接打开某个页面
  const params = new URLSearchParams(location.search);
  const LANGS = { en: "en", ja: "ja", zh: "zh" };
  if (LANGS[params.get("lang")]) try { localStorage.setItem("bd-lang", LANGS[params.get("lang")]); } catch {}
  let data = {};
  const ready = fetch(base + "demo-data.json").then((r) => r.json()).then((d) => (data = d)).catch(() => {});
  const realFetch = window.fetch.bind(window);
  const reply = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

  window.fetch = async (input, opts = {}) => {
    const u = new URL(typeof input === "string" ? input : input.url, location.href);
    const at = u.pathname.indexOf("/api/");
    if (at < 0) return realFetch(input, opts);
    await ready;
    const path = u.pathname.slice(at), q = Object.fromEntries(u.searchParams);
    if ((opts.method || "GET").toUpperCase() !== "GET") return reply({ error: DEMO_ERR }, 400);
    let key = path;
    if (path === "/api/transfers") key = `transfers|${q.chain}|${(q.address || "").toLowerCase()}|${q.kind || "all"}`;
    if (path === "/api/profile") key = `profile|${q.chain}|${(q.address || "").toLowerCase()}`;
    return key in data ? reply(data[key]) : reply({ error: DEMO_ERR }, 400);
  };

  // 顶部横幅 + 打开后自动载入示例案例
  document.addEventListener("DOMContentLoaded", () => {
    const bar = document.createElement("div");
    bar.className = "demo-bar";
    bar.innerHTML = `<b>DEMO</b><span>在线演示版：数据为示例快照，只能浏览预置案例</span>` +
      `<a href="${REPO}" target="_blank" rel="noopener">下载完整版（本地运行）↗</a>`;
    if (params.get("clean") !== "1") document.body.prepend(bar); // ?clean=1：README 截图用，不显示提示条
    const style = document.createElement("link");
    style.rel = "stylesheet";
    style.href = base + "demo.css";
    document.head.appendChild(style);
    const start = () => {
      if (typeof analyze !== "function" || !Object.keys(state.chains || {}).length || !data.case) return setTimeout(start, 200);
      if (!state.center) analyze(data.case.chain, data.case.address);
      const tab = params.get("tab");
      const btn = tab && /^[a-z]+$/.test(tab) && document.querySelector(`.tabs [data-tab="${tab}"]`);
      if (btn) btn.click(); // 走真实的点击，各页面的加载逻辑才会触发
    };
    ready.then(start);
  });
})();
