// 多语言层（static/i18n.js）的单元测试：词典、带变量的模式、术语替换、扩展补充词条。
// 用法：node --test tests/test_i18n.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "static", "i18n.js"), "utf8");
const PRO_I18N = path.join(__dirname, "..", "ext", "pro", "static", "i18n.js");

function harness(lang = "ja") {
  // i18n.js 在加载时会读 localStorage 和 document；给最小的桩
  const ctx = {
    localStorage: { getItem: () => lang, setItem() {} },
    document: { body: null, documentElement: {}, addEventListener() {}, querySelectorAll: () => [] },
    window: { prompt: () => null, confirm: () => true },
    MutationObserver: class { observe() {} },
    WeakMap, Map, Set, console, String, RegExp,
  };
  ctx.window.prompt = ctx.window.prompt.bind(ctx.window);
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { ctx, run: (code) => vm.runInContext(code, ctx) };
}

test("每条 PATTERNS 的正则都能编译，且 ja / en 模板引用的 $n 不超过捕获组数", () => {
  const h = harness();
  const bad = h.run(`PATTERNS.filter(([re, ja, en]) => {
    const groups = new RegExp(re.source + "|").exec("").length - 1;
    const maxRef = Math.max(0, ...(ja + en).split(/\\$(\\d)/).filter((_, i) => i % 2).map(Number));
    return maxRef > groups;
  }).map(([re]) => re.source)`);
  assert.equal(bad.length, 0, "bad patterns: " + bad.join(" | "));  // vm 里的数组和宿主 Array 原型不同，不能 deepEqual
  assert.ok(h.run("PATTERNS.length") > 100);
});

test("词典：精确匹配、首尾空白保留、未知文案原样返回并记录缺失", () => {
  const ja = harness("ja"), en = harness("en"), zh = harness("zh");
  assert.equal(ja.run('tr("资金流向")'), "資金フロー");
  assert.equal(en.run('tr("  资金流向 ")'), "  Fund flow ");
  assert.equal(zh.run('tr("资金流向")'), "资金流向");
  assert.equal(en.run('tr("这句话没有译文")'), "这句话没有译文");
  assert.equal(en.run('I18N.miss.has("这句话没有译文")'), true);
  assert.equal(en.run('tr("no cjk here")'), "no cjk here");
  assert.equal(en.run("tr(null)"), null);
});

test("带变量的模式：数字原样、捕获到的中文再查词典", () => {
  const en = harness("en"), ja = harness("ja");
  assert.equal(en.run('tr("标签库（快捷键 6）")'), `${en.run('tr("标签库")')} (shortcut 6)`);  // 捕获到的页面名也走词典
  assert.equal(ja.run('tr("设置（快捷键 8）")'), "設定（ショートカット 8）");
  assert.equal(en.run('tr("12 分钟前")'), "12 min ago");
  assert.equal(en.run('tr("已恢复 4 个文件，正在重启服务…")'), "Restored 4 files, restarting the service…");
  assert.match(en.run('tr("OFAC：新增 12 条，已有 3 条未覆盖；1 个列表拉取失败")'), /^OFAC: 12 added, 3 existing kept/);
});

test("术语替换 gl()：只替换用户数据里的常见词，中文模式不动", () => {
  const en = harness("en"), zh = harness("zh");
  assert.notEqual(en.run('gl("某交易所热钱包")'), "某交易所热钱包");
  assert.equal(zh.run('gl("某交易所热钱包")'), "某交易所热钱包");
  assert.equal(en.run('gl("0xabc")'), "0xabc");
});

test("扩展可以补充词条和模式（I18N.add / I18N.addPatterns），并立即可用", () => {
  const en = harness("en");
  en.run('I18N.add([["扩展专用文案", "拡張の文", "Extension text"]])');
  assert.equal(en.run('tr("扩展专用文案")'), "Extension text");
  en.run('I18N.addPatterns([[/^正在跟踪 (\\d+) 个钱包$/, "$1 件を追跡中", "Tracking $1 wallets"]])');
  assert.equal(en.run('tr("正在跟踪 7 个钱包")'), "Tracking 7 wallets");
});

test("Pro 扩展的 i18n.js（如果在场）能加载，词条里没有空译文", { skip: !fs.existsSync(PRO_I18N) }, () => {
  const en = harness("en");
  const before = en.run("I18N.en.size");
  en.run(fs.readFileSync(PRO_I18N, "utf8"));
  assert.ok(en.run("I18N.en.size") > before + 50);
  const empty = en.run('[...I18N.en.entries()].filter(([k, v]) => !String(v).trim() && k !== "的").map(([k]) => k)');
  assert.equal(empty.length, 0, "empty translations: " + empty.join(","));
  assert.equal(en.run('tr("聪明钱共识持仓")'), "Smart-money consensus holdings");
});
