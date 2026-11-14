// 区块侦探 — 更新公告：顶部栏显示当前版本号，有没看过的新版本时亮红点；点击打开公告面板（内容在 changelog.js）

const NOTES_TEXT = {
  zh: { head: "更新公告", latest: "最新", close: "关闭", tz: "日本时间", full: "完整记录见仓库里的 CHANGELOG.md" },
  ja: { head: "更新のお知らせ", latest: "最新", close: "閉じる", tz: "日本時間", full: "全履歴はリポジトリの CHANGELOG.md をご覧ください" },
  en: { head: "What's new", latest: "Latest", close: "Close", tz: "JST", full: "Full history: CHANGELOG.md in the repository" },
};
const NOTES_SEEN = "bd-notes-seen";
const notesLatest = CHANGELOG[0].v;

function notesSeen() { try { return localStorage.getItem(NOTES_SEEN); } catch { return null; } }

function renderNotesBadge() {
  $("#hb-ver").textContent = "v" + notesLatest;
  const bv = $("#brand-ver");
  if (bv) bv.textContent = "v" + notesLatest; // 侧栏品牌下的版本号也以更新公告为准
  $("#hb-notes .dot").hidden = notesSeen() === notesLatest;
}

function renderNotes() {
  const lang = NOTES_TEXT[I18N.lang] ? I18N.lang : "ja", t = NOTES_TEXT[lang];
  $("#notes-h").textContent = t.head;
  $("#notes-close").title = t.close;
  $("#notes-body").innerHTML = CHANGELOG.map((c, i) => {
    const n = c[lang] || c.en;
    return `<article class="note${i === 0 ? " latest" : ""}">
      <header><b class="nv">v${esc(c.v)}</b>${i === 0 ? `<span class="ntag">${t.latest}</span>` : ""}<time>${esc(c.date)} <small>${t.tz}</small></time></header>
      <h4>${esc(n.title)}</h4>
      <ul>${n.items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
    </article>`;
  }).join("") + `<p class="muted nfoot">${t.full}</p>`;
}

function openNotes() {
  renderNotes();
  $("#notes").hidden = false;
  try { localStorage.setItem(NOTES_SEEN, notesLatest); } catch {}
  renderNotesBadge();
  $("#notes-close").focus();
}
function closeNotes() { $("#notes").hidden = true; $("#hb-notes").focus(); }

$("#hb-notes").addEventListener("click", openNotes);
$("#notes-close").addEventListener("click", closeNotes);
$("#notes").addEventListener("click", (e) => { if (e.target.id === "notes") closeNotes(); }); // 点遮罩关闭
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#notes").hidden) { e.stopPropagation(); closeNotes(); } }, true);
// 面板开着时切换语言，内容跟着换
document.addEventListener("click", (e) => { if (e.target.closest("[data-lang]") && !$("#notes").hidden) setTimeout(renderNotes, 0); });
renderNotesBadge();
