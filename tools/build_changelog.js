// 由 static/changelog.js（应用内“更新公告”的内容）生成仓库根目录的 CHANGELOG.md。
// 用法：node tools/build_changelog.js   （改了 changelog.js 后运行一次）
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..");
const CHANGELOG = new Function(fs.readFileSync(path.join(root, "static", "changelog.js"), "utf8") + ";return CHANGELOG")();
let md = "# Changelog\n\nTimes are Japan Standard Time (JST). The same notes appear in the app: click the version number in the top bar.\n\n" +
  "日本語・中文は各バージョンの折りたたみ欄 / 各版本下方可展开\n";
for (const c of CHANGELOG) {
  md += `\n## ${c.v} — ${c.date} JST\n\n**${c.en.title}**\n\n` + c.en.items.map((x) => "- " + x).join("\n") + "\n";
  md += `\n<details><summary>日本語：${c.ja.title}</summary>\n\n` + c.ja.items.map((x) => "- " + x).join("\n") + "\n\n</details>\n";
  md += `<details><summary>中文：${c.zh.title}</summary>\n\n` + c.zh.items.map((x) => "- " + x).join("\n") + "\n\n</details>\n";
}
fs.writeFileSync(path.join(root, "CHANGELOG.md"), md);
console.log(`CHANGELOG.md: ${CHANGELOG.length} versions`);
