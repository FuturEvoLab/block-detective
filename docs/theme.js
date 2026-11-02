// 尽早应用主题和配色，避免页面闪一下（在 <head> 里同步加载；单独成文件是为了内容安全策略禁止内联脚本）
// 默认使用 HUD 深色主题；用户切换过则按其选择
let theme = "dark";
try { theme = localStorage.getItem("bd-theme") || "dark"; } catch {}
document.documentElement.dataset.theme = theme;
// 配色：蓝（默认）/ 绿
try { const acc = localStorage.getItem("bd-accent"); if (acc && acc !== "blue") document.documentElement.dataset.accent = acc; } catch {}
