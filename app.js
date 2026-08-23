"use strict";

/* ============================================================
 * JerryHang 的个人博客 —— 胶囊目录静态博客（iOS 简洁风）
 * 纯原生 JS，零外部依赖。数据来自 posts.json。
 * ============================================================ */

const $  = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
const esc = s => String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");

const SITE = { title: "JerryHang 的个人博客", author: "JerryHang", repo: "https://github.com/Jerry-Hang/Jerry-Hang.github.io" };

const WALLS = [
  { id: "clean", name: "纯色", img: "" },
  { id: "skull", name: "花海", img: "assets/skull.jpg" },
  { id: "arch", name: "樱", img: "assets/arch.jpg" },
  { id: "banner", name: "草地", img: "assets/banner.jpg" }
];

const state = {
  theme: localStorage.getItem("jb_theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
  wall: localStorage.getItem("jb_wall2") || "skull",
  posts: [],
  q: "",
  sideMode: "cat",
  sideView: "posts",
  outline: [],
  articleIdx: -1,
  pinnedPage: 1,
  fontScale: Number(localStorage.getItem("jb_font") || 0)
};

const FONT_SIZES = [13.5, 15, 16.5, 18];
function applyFontScale() {
  const el = document.getElementById("r-body");
  if (el) el.style.fontSize = FONT_SIZES[state.fontScale] + "px";
  const cur = document.getElementById("r-font-cur");
  if (cur) cur.textContent = "A" + (state.fontScale > 0 ? "+".repeat(state.fontScale) : "");
  localStorage.setItem("jb_font", String(state.fontScale));
}

function applyWall() {
  const w = WALLS.find(x => x.id === state.wall) || WALLS[0];
  const el = document.getElementById("wallpaper");
  if (el) el.style.backgroundImage = w.img ? "url('" + w.img + "')" : "none";
  localStorage.setItem("jb_wall2", state.wall);
}

/* ---------- 主题：跟随系统 + 手动切换 ---------- */
function applyTheme() {
  document.body.classList.toggle("dark", state.theme === "dark");
  localStorage.setItem("jb_theme", state.theme);
}
function toggleTheme() { state.theme = state.theme === "dark" ? "light" : "dark"; applyTheme(); }

/* ---------- Markdown 渲染（轻量自包含） ---------- */
function mdInline(src) {
  let s = esc(src);
  s = s.replace(/\x60([^\x60]+)\x60/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  s = s.replace(/_([^_\n]+)_/g, "<em>$1</em>");
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '<img src="$2" alt="$1" loading="lazy">');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function(m, txt, url) {
    const u = url.replace(/[)\s"]+$/, "");
    return /^(https?:|mailto:|#)/.test(u) ? '<a href="' + u + '" target="_blank" rel="noopener">' + txt + '</a>' : '<a href="' + u + '">' + txt + '</a>';
  });
  return s;
}
function mdToHtml(md) {
  const lines = String(md || "").replace(/\r\n/g, "\n").split("\n");
  const FENCE = String.fromCharCode(96).repeat(3);
  let out = "", i = 0, inCode = false, codeBuf = [], listType = null;

  const closeList = () => { if (listType) { out += "</" + listType + ">"; listType = null; } };
  const openList = t => { if (listType === t) return; closeList(); out += "<" + t + ">"; listType = t; };

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().startsWith(FENCE)) {
      if (!inCode) { inCode = true; codeBuf = []; }
      else { out += "<pre><code>" + codeBuf.map(esc).join("\n") + "</code></pre>"; inCode = false; }
      i++; continue;
    }
    if (inCode) { codeBuf.push(line); i++; continue; }

    if (/^\s*$/.test(line)) { closeList(); i++; continue; }

    if (line.includes("|") && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1] || "") && (lines[i+1]||"").includes("-")) {
      closeList();
      const splitRow = r => r.trim().replace(/^\|/,"").replace(/\|$/,"").split("|").map(c => c.trim());
      const headCells = splitRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && !/^\s*$/.test(lines[i])) { rows.push(splitRow(lines[i])); i++; }
      let html = "<table><thead><tr>" + headCells.map(c => "<th>" + mdInline(c) + "</th>").join("") + "</tr></thead><tbody>";
      rows.forEach(r => { html += "<tr>" + r.map(c => "<td>" + mdInline(c) + "</td>").join("") + "</tr>"; });
      out += html + "</tbody></table>";
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closeList(); const lv = h[1].length; out += "<h" + lv + ">" + mdInline(h[2]) + "</h" + lv + ">"; i++; continue; }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { closeList(); out += "<hr>"; i++; continue; }

    if (/^\s*>\s?/.test(line)) {
      closeList();
      let buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
      out += "<blockquote>" + buf.map(x => mdInline(x)).join("<br>") + "</blockquote>";
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      openList("ul");
      out += "<li>" + mdInline(line.replace(/^\s*[-*+]\s+/, "")) + "</li>";
      i++; continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      openList("ol");
      out += "<li>" + mdInline(line.replace(/^\s*\d+[.)]\s+/, "")) + "</li>";
      i++; continue;
    }

    closeList();
    let buf = [line];
    i++;
    while (i < lines.length) {
      const nx = lines[i];
      if (/^\s*$/.test(nx) || /^(#{1,6})\s/.test(nx) || nx.trim().startsWith(FENCE) || /^\s*>\s?/.test(nx) ||
          /^\s*[-*+]\s+/.test(nx) || /^\s*\d+[.)]\s+/.test(nx) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(nx)) break;
      buf.push(nx); i++;
    }
    out += "<p>" + buf.map(mdInline).join("<br>") + "</p>";
  }
  closeList();
  if (inCode) out += "<pre><code>" + codeBuf.map(esc).join("\n") + "</code></pre>";
  return out;
}

/* ---------- 数据 ---------- */
async function loadPosts() {
  document.getElementById("post-scroll").innerHTML = '<div class="loading-tip">加载中…</div>';
  try {
    const res = await fetch("posts.json", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    state.posts = Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn("load posts.json failed:", e);
    state.posts = [];
  }
  renderAll();
  openFromHashIfAny();
}
function allCats() {
  const s = new Set(["全部"]);
  state.posts.forEach(p => (p.categories || []).forEach(c => s.add(c)));
  return Array.from(s);
}
function filteredPosts() {
  const q = state.q.trim().toLowerCase();
  let list = state.posts.slice();
  if (q) list = list.filter(p =>
    (p.title || "").toLowerCase().includes(q) ||
    (p.tags || []).some(t => t.toLowerCase().includes(q)) ||
    (p.categories || []).some(c => c.toLowerCase().includes(q)) ||
    (p.body || "").toLowerCase().includes(q) ||
    (p.date || "").includes(q)
  );
  return list;
}
function pinnedPosts() {
  const ps = state.posts.filter(p => p.pinned);
  return ps.length ? ps : state.posts.slice(0, 4);
}
function readMinutes(p) {
  const words = (p.body || "").replace(/\s/g, "").length;
  return Math.max(1, Math.round(words / 420));
}
let toastTimer = null;
function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2000);
}
function copyPageLink() {
  const url = location.origin + location.pathname + (location.hash || "");
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(() => showToast("链接已复制")).catch(() => showToast("复制失败"));
  } else {
    const ta = document.createElement("textarea");
    ta.value = url;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); showToast("链接已复制"); } catch (e) { showToast("复制失败"); }
    ta.remove();
  }
}

/* ---------- 侧栏 ---------- */
function toggleSidebar(force) {
  const open = typeof force === "boolean" ? force : !document.getElementById("layout").classList.contains("side-open");
  document.getElementById("layout").classList.toggle("side-open", open);
  const grip = document.getElementById("side-grip");
  if (grip) grip.setAttribute("aria-expanded", open ? "true" : "false");
}
function renderModes() {
  const box = document.getElementById("side-modes");
  const modes = [["cat", "分类"], ["tag", "标签"], ["pin", "精选"]];
  box.innerHTML = modes.map(m =>
    '<button class="mode' + (state.sideMode === m[0] ? " on" : "") + '" data-mode="' + m[0] + '" aria-pressed="' + (state.sideMode === m[0] ? "true" : "false") + '">' + m[1] + '</button>'
  ).join("");
  $$("#side-modes .mode").forEach(b => b.addEventListener("click", () => {
    state.sideMode = b.dataset.mode;
    renderSide();
  }));
}
function pillHtml(p) {
  const idx = state.posts.indexOf(p);
  const sel = idx === state.articleIdx ? " selected" : "";
  const words = (p.body || "").replace(/\s/g, "").length;
  const tags = (p.tags || []).slice(0, 2).map(t => '<span class="p-tag">' + esc(t) + '</span>').join("");
  return '<div class="pill-wrap">' +
    '<button class="pill' + sel + '" data-idx="' + idx + '">' +
      '<span class="p-date">' + esc(p.date || "") + '</span>' +
      '<span class="p-title">' + esc(p.title) + '</span>' +
      '<div class="p-meta">' + tags + '<span class="p-words">' + words.toLocaleString() + ' 字</span></div>' +
    '</button>' +
  '</div>';
}
function groupsBy(list, keyFn) {
  const groups = {};
  list.forEach(p => {
    const keys = keyFn(p);
    const list2 = (keys && keys.length) ? keys : ["未分类"];
    list2.forEach(k => { (groups[k] = groups[k] || []).push(p); });
  });
  return groups;
}
function bindPillEvents(scope) {
  $$(".pill", scope).forEach(btn => {
    btn.addEventListener("click", () => selectArticle(Number(btn.dataset.idx)));
    let tmr = null;
    const press = () => { tmr = setTimeout(() => btn.classList.add("pressing"), 380); };
    const release = () => { clearTimeout(tmr); btn.classList.remove("pressing"); };
    btn.addEventListener("pointerdown", press);
    btn.addEventListener("pointerup", release);
    btn.addEventListener("pointerleave", release);
    btn.addEventListener("pointercancel", release);
  });
  if (window.bindTilt) window.bindTilt(scope);
}
function renderArticleSide(box, q) {
  const ql = q.trim().toLowerCase();
  if (!ql) { renderOutlineInto(box); return; }
  const bodyEl = document.getElementById("r-body");
  if (!bodyEl) { renderOutlineInto(box); return; }
  const hits = [];
  bodyEl.querySelectorAll("p, li, blockquote").forEach(n => {
    if (n.textContent.toLowerCase().indexOf(ql) >= 0) hits.push(n);
  });
  if (!hits.length) {
    box.innerHTML = '<div class="outline-empty">本文中没有「' + esc(q.trim()) + '」</div>';
    return;
  }
  const snippet = n => {
    const t = n.textContent.replace(/\s+/g, " ").trim();
    const i = t.toLowerCase().indexOf(ql);
    return "…" + (i > 24 ? t.slice(i - 24) : t).slice(0, 46) + "…";
  };
  box.innerHTML = '<div class="group-head">本文中找到 ' + hits.length + ' 处</div>' +
    hits.slice(0, 60).map((n, i) =>
      '<button class="outline-item lv2" data-hit="' + i + '">' + esc(snippet(n)) + '</button>'
    ).join("");
  $$(".outline-item", box).forEach(b => b.addEventListener("click", () => {
    const n = hits[Number(b.dataset.hit)];
    if (!n) return;
    if (n.scrollIntoView) n.scrollIntoView({ behavior: "smooth", block: "center" });
    n.classList.remove("flash"); void n.offsetWidth; n.classList.add("flash");
    setTimeout(() => n.classList.remove("flash"), 1700);
  }));
}
function renderOutlineInto(box) {
  const hands = state.outline;
  if (!hands.length) { box.innerHTML = '<div class="outline-empty">本篇没有标题分节</div>'; return; }
  box.innerHTML = '<div class="group-head">文章摘要</div>' + hands.map(o =>
    '<button class="outline-item lv' + o.level + '" data-target="' + o.id + '">' + esc(o.text) + '</button>'
  ).join("");
  let cnt = 0;
  $$(".outline-item", box).forEach(b => b.addEventListener("click", () => {
    const el = document.getElementById(b.dataset.target);
    if (!el) return;
    if (el.scrollIntoView) el.scrollIntoView({ behavior: "smooth", block: "start" });
    el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 1700);
    cnt++;
  }));
}
function renderSide() {
  const modesBox = document.getElementById("side-modes");
  const searchBox = document.getElementById("side-search");
  const label = document.querySelector(".side-label");
  const box = document.getElementById("post-scroll");
  if (state.sideView === "outline") {
    if (modesBox) modesBox.style.display = "none";
    if (label) label.style.display = "none";
    if (searchBox) searchBox.placeholder = "搜索本文…";
    renderArticleSide(box, searchBox ? searchBox.value.trim() : "");
    return;
  }
  if (modesBox) modesBox.style.display = "";
  if (label) label.style.display = "";
  if (searchBox) searchBox.placeholder = "搜索文章…";
  renderModes();
  const list = filteredPosts();
  document.getElementById("side-count").textContent = list.length + " 篇";
  if (!list.length) { box.innerHTML = '<div class="empty-tip">没有匹配的文章</div>'; return; }
  let html = "";
  if (state.sideMode === "pin") {
    const pinned = list.filter(p => p.pinned);
    html = pinned.length ? '<div class="pill-grid">' + pinned.map(pillHtml).join("") + '</div>' : '<div class="empty-tip">暂无精选文章</div>';
  } else if (state.sideMode === "tag") {
    const groups = groupsBy(list, p => p.tags);
    html = Object.keys(groups).map(k =>
      '<div class="group-head">' + esc(k) + '</div><div class="pill-grid">' + groups[k].map(pillHtml).join("") + '</div>'
    ).join("");
  } else {
    const groups = groupsBy(list, p => p.categories);
    html = Object.keys(groups).map(k =>
      '<div class="group-head">' + esc(k) + '</div><div class="pill-grid">' + groups[k].map(pillHtml).join("") + '</div>'
    ).join("");
  }
  box.innerHTML = html;
  bindPillEvents(box);
}

/* ---------- 视图 ---------- */
function showView(name) {
  const doIt = () => {
    if (name !== "reader") { try { history.replaceState(null, "", "#/"); } catch (e) { /* 忽略 */ } }
    $$(".view").forEach(v => v.classList.remove("on"));
    const v = document.getElementById("view-" + name);
    if (v) v.classList.add("on");
  $$("#tb-tabs button").forEach(b => b.classList.toggle("on", b.dataset.nav === name));
  document.body.classList.toggle("reading", name === "reader");
  state.nav = name;
  if (name !== "reader") { state.sideView = "posts"; renderSide(); }
  if (window.innerWidth <= 720) toggleSidebar(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  if (document.startViewTransition) {
    try { document.startViewTransition(doIt); return; } catch (e) { /* 降级为直接切换 */ }
  }
  doIt();
}
function articleHash(p) {
  const key = encodeURIComponent(p.slug || p.title || "");
  return "#/post/" + key;
}
function selectArticle(idx) {
  const p = state.posts[idx];
  if (!p) return;
  state.articleIdx = idx;
  Array.from(document.querySelectorAll(".pill")).forEach(p2 => p2.classList.toggle("selected", Number(p2.dataset.idx) === idx));
  openArticle(idx);
  showView("reader");
  state.sideView = "outline";
  const sb = document.getElementById("side-search");
  if (sb) { sb.value = ""; sb.placeholder = "搜索本文…"; }
  toggleSidebar(false);
  renderSide();
  try { history.replaceState(null, "", articleHash(p)); } catch (e) { /* 忽略 */ }
}

/* ---------- 主页文章长条 3/4 + 翻页 ---------- */
function renderHome() {
  const grid = document.getElementById("pin-grid");
  const list = state.posts;
  const perPage = (window.innerWidth <= 720 ? 4 : 6);
  const pages = Math.max(1, Math.ceil(list.length / perPage));
  if (state.pinnedPage > pages) state.pinnedPage = pages;
  const start = (state.pinnedPage - 1) * perPage;
  const pageItems = list.slice(start, start + perPage);

  if (!pageItems.length) {
    grid.innerHTML = '<div class="empty-tip">暂无文章，运行 blog_ctl new 创建第一篇。</div>';
  } else {
    grid.innerHTML = pageItems.map(p => {
      const idx = state.posts.indexOf(p);
      const words = (p.body || "").replace(/\s/g, "").length;
      const tags = (p.tags || []).slice(0, 2).map(t => '<span class="p-tag">' + esc(t) + '</span>').join("");
      return '<button class="home-item" data-idx="' + idx + '">' +
        '<span class="hi-date">' + esc(p.date || "") + '</span>' +
        '<span class="hi-main">' +
          '<span class="hi-title">' + esc(p.title) + '</span>' +
          (p.desc ? '<span class="hi-excerpt">' + esc(p.desc) + '</span>' : '') +
        '</span>' +
        '<span class="hi-meta">' + tags + '<span class="p-words">' + words.toLocaleString() + ' 字 · ' + readMinutes(p) + ' 分钟</span></span>' +
        '<span class="hi-arrow">›</span>' +
      '</button>';
    }).join("");
  }
  $$("#pin-grid .home-item").forEach(b => b.addEventListener("click", () => selectArticle(Number(b.dataset.idx))));
  if (window.bindTilt) window.bindTilt(grid);

  const pager = document.getElementById("pager-home");
  pager.innerHTML =
    '<button class="pg-btn" id="pg-prev" ' + (state.pinnedPage <= 1 ? "disabled" : "") + '>‹ 上一页</button>' +
    '<span class="pg-info">第 <b>' + state.pinnedPage + '</b> / ' + pages + ' 页</span>' +
    '<input class="pg-input" id="pg-input" type="number" min="1" max="' + pages + '" value="' + state.pinnedPage + '" aria-label="页码">' +
    '<button class="pg-btn" id="pg-go">前往</button>' +
    '<button class="pg-btn" id="pg-next" ' + (state.pinnedPage >= pages ? "disabled" : "") + '>下一页 ›</button>';
  document.getElementById("pg-prev").addEventListener("click", () => { state.pinnedPage--; renderHome(); });
  document.getElementById("pg-next").addEventListener("click", () => { state.pinnedPage++; renderHome(); });
  document.getElementById("pg-go").addEventListener("click", () => {
    let n = parseInt(document.getElementById("pg-input").value, 10);
    if (isNaN(n)) return;
    n = Math.min(pages, Math.max(1, n));
    state.pinnedPage = n; renderHome();
  });
  document.getElementById("pg-input").addEventListener("keydown", e => { if (e.key === "Enter") document.getElementById("pg-go").click(); });
}

/* ---------- 阅读 ---------- */
function openArticle(idx) {
  const p = state.posts[idx];
  if (!p) return;
  const cats = (p.categories || []).map(c => '<span class="tag">' + esc(c) + '</span>').join("");
  const tags = (p.tags || []).map(t => '<span class="cat-tag">' + esc(t) + '</span>').join("");
  document.getElementById("r-cats").innerHTML = cats + tags;
  document.getElementById("r-title").textContent = p.title;
  document.getElementById("r-meta").innerHTML =
    '<span>' + esc(p.date || "") + '</span>' +
    '<span>' + esc(SITE.author) + '</span>' +
    '<span>' + esc((p.body || "").length) + ' 字</span>' +
    '<span>约 ' + readMinutes(p) + ' 分钟</span>';
  const mdBody = document.getElementById("r-body");
  mdBody.innerHTML = mdToHtml(p.body);
  mdBody.querySelectorAll("pre").forEach(pre => {
    const b = document.createElement("button");
    b.className = "code-copy";
    b.textContent = "复制";
    pre.appendChild(b);
  });
  applyFontScale();
  const outline = [];
  mdBody.querySelectorAll("h2,h3").forEach((h, i) => {
    h.id = "sec-" + i;
    outline.push({ id: "sec-" + i, level: Number(h.tagName[1]), text: h.textContent.trim() });
  });
  state.outline = outline;
  const prev = state.posts[idx - 1];
  const next = state.posts[idx + 1];
  document.getElementById("r-foot").innerHTML =
    '<button class="pn-btn' + (prev ? "" : " disabled") + '" id="r-prev">‹ ' + (prev ? esc(prev.title) : "已是最早") + '</button>' +
    '<button class="pn-btn" id="r-back">返回</button>' +
    '<button class="pn-btn" id="r-copy">复制链接</button>' +
    '<button class="pn-btn' + (next ? "" : " disabled") + '" id="r-next">' + (next ? esc(next.title) : "已是最新") + ' ›</button>';
  document.getElementById("r-copy").addEventListener("click", copyPageLink);
  if (prev) document.getElementById("r-prev").addEventListener("click", () => selectArticle(idx - 1));
  if (next) document.getElementById("r-next").addEventListener("click", () => selectArticle(idx + 1));
  document.getElementById("r-back").addEventListener("click", () => showView("home"));

  // 相关文章（同分类优先，最多2篇）
  const relBox = document.getElementById("r-related");
  if (relBox) {
    const catsHere = p.categories || [];
    const rels = state.posts
      .filter(q => q !== p && (q.categories || []).some(c => catsHere.includes(c)))
      .slice(0, 2);
    if (rels.length) {
      relBox.innerHTML = '<div class="rel-title">相关文章</div>' +
        '<div class="rel-list">' +
        rels.map(q => {
          const qi = state.posts.indexOf(q);
          return '<button class="rel-item" data-idx="' + qi + '">' +
            '<span class="rel-date">' + esc(q.date || "") + '</span>' +
            '<span class="rel-t">' + esc(q.title) + '</span>' +
          '</button>';
        }).join("") +
        '</div>';
      $$(".rel-item", relBox).forEach(b => b.addEventListener("click", () => selectArticle(Number(b.dataset.idx))));
    } else {
      relBox.innerHTML = "";
    }
  }
}

/* ---------- 归档 ---------- */
function renderArchive() {
  const box = document.getElementById("arch-body");
  const list = state.posts;
  if (!list.length) { box.innerHTML = '<div class="empty-tip">暂无文章</div>'; return; }
  const years = {};
  list.forEach(p => {
    const y = (p.date || "").slice(0, 4) || "未知";
    (years[y] = years[y] || []).push(p);
  });
  box.innerHTML = Object.keys(years).sort().reverse().map(y =>
    '<div class="arch-year"><h2>' + esc(y) + '</h2><span class="count">' + years[y].length + ' 篇</span></div>' +
    '<div class="arch-list">' +
      years[y].map(p => {
        const idx = state.posts.indexOf(p);
        return '<button class="arch-item" data-idx="' + idx + '">' +
          '<span class="a-date">' + esc(p.date || "") + '</span>' +
          '<span class="a-title">' + esc(p.title) + '</span>' +
        '</button>';
      }).join("") +
    '</div>'
  ).join("");
  $$("#arch-body .arch-item").forEach(b => b.addEventListener("click", () => selectArticle(Number(b.dataset.idx))));
}

/* ---------- 关于 ---------- */
function renderAbout() {
  const tags = new Set();
  const cats = new Set();
  state.posts.forEach(p => {
    (p.tags || []).forEach(t => tags.add(t));
    (p.categories || []).forEach(c => cats.add(c));
  });
  const latest = state.posts.length ? state.posts[0].date : "—";
  const totalWords = state.posts.reduce((n, p) => n + (p.body || "").replace(/\s/g, "").length, 0);
  document.getElementById("about-body").innerHTML =
    '<div class="a-hero">' +
      '<div class="avatar"><img src="assets/avatar.jpg" alt=""></div>' +
      '<div><h2>' + esc(SITE.title) + '</h2><p>记录与折腾 · 纯静态博客</p></div>' +
    '</div>' +
    '<div class="about-stats">' +
      '<div class="stat"><b>' + state.posts.length + '</b><span>文章</span></div>' +
      '<div class="stat"><b>' + cats.size + '</b><span>分类</span></div>' +
      '<div class="stat"><b>' + tags.size + '</b><span>标签</span></div>' +
      '<div class="stat"><b>' + totalWords.toLocaleString() + '</b><span>总字数</span></div>' +
    '</div>' +
    '<div class="sect"><h3 style="font-size:11px;font-weight:600;color:var(--text-faint);text-transform:uppercase;letter-spacing:.06em;margin-bottom:2px;">壁纸</h3>' +
      '<div class="wall-grid" id="wall-grid"></div>' +
    '</div>' +
    '<p style="font-size:13px;line-height:1.8;color:var(--text-soft)">' +
      '一个用 Rust 命令行工具与原生 HTML / CSS / JS 打造的胶囊目录静态博客。' +
      '左侧目录栏像抽屉一样展开：搜索、筛选、滚动胶囊列表；右侧是置顶的精选内容。' +
    '</p>' +
    '<div class="a-links">' +
      '<a class="link-btn" href="' + SITE.repo + '" target="_blank" rel="noopener">GitHub 仓库</a>' +
      '<a class="link-btn" href="feed.xml" target="_blank" rel="noopener">RSS 订阅</a>' +
      '<a class="link-btn" href="mailto:jerry@example.com">联系我</a>' +
    '</div>' +
    '<div class="sect" style="margin-top:16px;"><h3 style="font-size:11px;font-weight:600;color:var(--text-faint);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px;">参考与友链</h3>' +
      '<div class="a-links">' +
        '<a class="link-btn" href="https://github.com/Eric-Terminal/cf-astro-blog" target="_blank" rel="noopener">cf-astro-blog 参考项目</a>' +
      '</div>' +
    '</div>' +
    '<p style="margin-top:16px;font-size:11.5px;color:var(--text-faint);text-align:center">© ' + new Date().getFullYear() + ' ' + esc(SITE.author) + ' · 记录与折腾</p>';
  const wg = document.getElementById("wall-grid");
  if (wg) {
    wg.innerHTML = WALLS.map(w =>
      '<button class="wall-thumb' + (w.id === state.wall ? " on" : "") + (w.img ? "" : " clean") + '" data-wall="' + w.id + '"' +
      (w.img ? ' style="background-image:url(&quot;' + w.img + '&quot;)"' : '') + '>' +
        '<span class="wt-name">' + esc(w.name) + '</span>' +
      '</button>'
    ).join("");
    $$(".wall-thumb", wg).forEach(b => b.addEventListener("click", () => {
      state.wall = b.dataset.wall;
      applyWall();
      $$(".wall-thumb", wg).forEach(x => x.classList.toggle("on", x === b));
      showToast("壁纸已切换");
    }));
  }
}

/* ---------- 3D tilt（仅精细指针设备） ---------- */
(function() {
  const fine = window.matchMedia && window.matchMedia("(pointer: fine)").matches;
  function attach(root) {
    if (!fine) return;
    (root || document).querySelectorAll(".pill:not([data-tilt]), .pin-card:not([data-tilt]), .home-item:not([data-tilt])").forEach(el => {
      el.setAttribute("data-tilt", "1");
      el.addEventListener("mousemove", e => {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return;
        const px = (e.clientX - r.left) / r.width - 0.5;
        const py = (e.clientY - r.top) / r.height - 0.5;
        el.style.transform = "perspective(700px) rotateX(" + (-py * 7).toFixed(2) + "deg) rotateY(" + (px * 9).toFixed(2) + "deg) translateY(-2px)";
        try {
          el.style.setProperty("--mx", (px * 100 + 50).toFixed(1) + "%");
          el.style.setProperty("--my", (py * 100 + 50).toFixed(1) + "%");
        } catch (err) { /* 自定义属性在个别环境受限 */ }
      });
      el.addEventListener("mouseleave", () => { el.style.transform = ""; });
    });
  }
  window.bindTilt = attach;
  attach();
})();

/* ---------- 总渲染 ---------- */
function renderAll() {
  renderSide();
  renderHome();
  renderArchive();
  renderAbout();
}

/* ---------- 事件 ---------- */
document.getElementById("side-collapse").addEventListener("click", () => toggleSidebar(false));
document.getElementById("side-grip").addEventListener("click", () => toggleSidebar(true));
document.getElementById("scrim").addEventListener("click", () => toggleSidebar(false));
document.getElementById("tb-theme").addEventListener("click", toggleTheme);
document.getElementById("side-search").addEventListener("input", e => { state.q = e.target.value; renderSide(); });
$$("#tb-tabs button").forEach(b => b.addEventListener("click", () => {
  if (b.dataset.nav === "home") showView("home");
  else if (b.dataset.nav === "archive") showView("archive");
  else showView("about");
}));
document.getElementById("r-font-dec").addEventListener("click", () => {
  if (state.fontScale > 0) { state.fontScale--; applyFontScale(); }
});
document.getElementById("r-font-inc").addEventListener("click", () => {
  if (state.fontScale < FONT_SIZES.length - 1) { state.fontScale++; applyFontScale(); }
});
document.getElementById("r-body").addEventListener("click", e => {
  const btn = e.target.closest(".code-copy");
  if (!btn) return;
  const pre = btn.closest("pre");
  const code = pre ? (pre.querySelector("code") ? pre.querySelector("code").textContent : "") : "";
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(code).then(() => showToast("代码已复制")).catch(() => showToast("复制失败"));
  } else {
    showToast("复制失败");
  }
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape") { toggleSidebar(false); return; }
  if (e.key === "/" && !e.ctrlKey && !e.metaKey) {
    const tag2 = (e.target && e.target.tagName) || "";
    if (tag2 !== "INPUT" && tag2 !== "TEXTAREA") { e.preventDefault(); document.getElementById("side-search").focus(); return; }
  }
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  if (state.nav === "reader" && state.articleIdx >= 0) {
    if (e.key === "ArrowLeft" && state.articleIdx > 0) selectArticle(state.articleIdx - 1);
    if (e.key === "ArrowRight" && state.articleIdx < state.posts.length - 1) selectArticle(state.articleIdx + 1);
  }
});
window.addEventListener("resize", () => { renderHome(); });

/* hash 路由：直链打开文章 / 回主页 */
window.addEventListener("hashchange", () => {
  const m = (location.hash || "").match(/^#\/post\/(.+)$/);
  if (m) {
    const key = decodeURIComponent(m[1]);
    const idx = state.posts.findIndex(p => p.slug === key || p.title === key);
    if (idx >= 0) selectArticle(idx); else showView("home");
  } else {
    if (state.nav !== "home") showView("home");
  }
});
function openFromHashIfAny() {
  const m = (location.hash || "").match(/^#\/post\/(.+)$/);
  if (!m) return;
  const key = decodeURIComponent(m[1]);
  const idx = state.posts.findIndex(p => p.slug === key || p.title === key);
  if (idx >= 0) selectArticle(idx);
}

/* 返回顶部 + 阅读进度 */
(function() {
  const btn = document.getElementById("back-top");
  const bar = document.getElementById("progress-bar");
  let show = false;
  window.addEventListener("scroll", () => {
    const s = window.scrollY > 480;
    if (s !== show) { show = s; btn.classList.toggle("show", s); }
    const doc = document.documentElement;
    const max = doc.scrollHeight - window.innerHeight;
    if (max > 0 && document.body.classList.contains("reading")) {
      bar.style.width = Math.min(100, (window.scrollY / max) * 100).toFixed(2) + "%";
      bar.classList.add("show");
    } else {
      bar.classList.remove("show");
    }
  }, { passive: true });
  btn.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
})();

/* 滚动收缩：顶部横条 → 悬浮胶囊（平滑过渡） */
(function() {
  const topArea = document.querySelector(".top-area");
  let compact = false;
  window.addEventListener("scroll", () => {
    const should = window.scrollY > 70;
    if (should !== compact) { compact = should; topArea.classList.toggle("compact", compact); }
  }, { passive: true });
})();

/* ---------- 初始化 ---------- */
(function init() {
  applyTheme();
  applyWall();
  toggleSidebar(false);
  showView("home");
  loadPosts();
})();
