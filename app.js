"use strict";

/* ============================================================
 * Jerry 的赛博博客 —— 胶囊目录静态博客（iOS 简洁风）
 * 纯原生 JS，零外部依赖。数据来自 posts.json。
 * ============================================================ */

const $  = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
const esc = s => String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");

const SITE = { title: "Jerry 的赛博博客", author: "Jerry", repo: "https://github.com/Jerry-Hang/Jerry-Hang.github.io" };

const state = {
  theme: localStorage.getItem("jb_theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
  posts: [],
  q: "",
  cat: "全部",
  articleIdx: -1,
  pinnedPage: 1
};

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
}
function allCats() {
  const s = new Set(["全部"]);
  state.posts.forEach(p => (p.categories || []).forEach(c => s.add(c)));
  return Array.from(s);
}
function filteredPosts() {
  const q = state.q.trim().toLowerCase();
  const cat = state.cat;
  let list = state.posts.slice();
  if (cat !== "全部") list = list.filter(p => (p.categories || []).includes(cat));
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

/* ---------- 侧栏 ---------- */
function toggleSidebar(force) {
  const open = typeof force === "boolean" ? force : !document.getElementById("layout").classList.contains("side-open");
  document.getElementById("layout").classList.toggle("side-open", open);
}
function renderChips() {
  const box = document.getElementById("side-chips");
  const cats = allCats();
  box.innerHTML = cats.map(c =>
    '<button class="chip' + (c === state.cat ? " on" : "") + '" data-cat="' + esc(c) + '">' + esc(c) + '</button>'
  ).join("");
  $$("#side-chips .chip").forEach(b => b.addEventListener("click", () => {
    state.cat = b.dataset.cat;
    renderChips();
    renderPills();
  }));
}
function renderPills() {
  const list = filteredPosts();
  const box = document.getElementById("post-scroll");
  document.getElementById("side-count").textContent = list.length + " 篇";
  if (!list.length) {
    box.innerHTML = '<div class="empty-tip">没有匹配的文章</div>';
    return;
  }
  box.innerHTML = '<div class="pill-grid">' + list.map(p => {
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
  }).join("") + '</div>';

  $$("#post-scroll .pill").forEach(btn => {
    btn.addEventListener("click", () => selectArticle(Number(btn.dataset.idx)));
    let tmr = null;
    const press = () => { tmr = setTimeout(() => btn.classList.add("pressing"), 380); };
    const release = () => { clearTimeout(tmr); btn.classList.remove("pressing"); };
    btn.addEventListener("pointerdown", press);
    btn.addEventListener("pointerup", release);
    btn.addEventListener("pointerleave", release);
    btn.addEventListener("pointercancel", release);
  });
}

/* ---------- 视图 ---------- */
function showView(name) {
  $$(".view").forEach(v => v.classList.remove("on"));
  const v = document.getElementById("view-" + name);
  if (v) v.classList.add("on");
  $$(".tabbar button").forEach(b => b.classList.toggle("on", b.dataset.nav === name));
  if (window.innerWidth <= 720) toggleSidebar(false);
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function selectArticle(idx) {
  state.articleIdx = idx;
  Array.from(document.querySelectorAll(".pill")).forEach(p => p.classList.toggle("selected", Number(p.dataset.idx) === idx));
  openArticle(idx);
  showView("reader");
}

/* ---------- 精选 + 翻页 ---------- */
function renderHome() {
  const grid = document.getElementById("pin-grid");
  const pins = pinnedPosts();
  const perPage = (window.innerWidth <= 720 ? 2 : 4);
  const pages = Math.max(1, Math.ceil(pins.length / perPage));
  if (state.pinnedPage > pages) state.pinnedPage = pages;
  const start = (state.pinnedPage - 1) * perPage;
  const pageItems = pins.slice(start, start + perPage);

  if (!pageItems.length) {
    grid.innerHTML = '<div class="empty-tip" style="grid-column:1/-1">暂无文章，运行 blog_ctl new 创建第一篇。</div>';
  } else {
    grid.innerHTML = pageItems.map(p => {
      const idx = state.posts.indexOf(p);
      const tags = (p.tags || []).map(t => '<span class="tag">' + esc(t) + '</span>').join("");
      const cats = (p.categories || []).map(c => '<span class="cat-tag">' + esc(c) + '</span>').join("");
      return '<button class="pin-card" data-idx="' + idx + '">' +
        '<div class="pc-top"><span class="pc-date">' + esc(p.date || "") + '</span></div>' +
        '<h3>' + esc(p.title) + '</h3>' +
        '<p>' + esc(p.desc || (p.body || "").slice(0, 90) || "") + '</p>' +
        '<div class="pc-meta">' + cats + tags + '<span class="pc-more">阅读</span></div>' +
      '</button>';
    }).join("");
  }
  $$("#pin-grid .pin-card").forEach(b => b.addEventListener("click", () => selectArticle(Number(b.dataset.idx))));

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
    '<span>' + esc((p.body || "").length) + ' 字</span>';
  document.getElementById("r-body").innerHTML = mdToHtml(p.body);
  const prev = state.posts[idx - 1];
  const next = state.posts[idx + 1];
  document.getElementById("r-foot").innerHTML =
    '<button class="pn-btn' + (prev ? "" : " disabled") + '" id="r-prev">‹ ' + (prev ? esc(prev.title) : "已是最早") + '</button>' +
    '<button class="pn-btn" id="r-back">返回精选</button>' +
    '<button class="pn-btn' + (next ? "" : " disabled") + '" id="r-next">' + (next ? esc(next.title) : "已是最新") + ' ›</button>';
  if (prev) document.getElementById("r-prev").addEventListener("click", () => selectArticle(idx - 1));
  if (next) document.getElementById("r-next").addEventListener("click", () => selectArticle(idx + 1));
  document.getElementById("r-back").addEventListener("click", () => showView("home"));
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
  document.getElementById("about-body").innerHTML =
    '<div class="a-hero">' +
      '<div class="avatar">J</div>' +
      '<div><h2>' + esc(SITE.title) + '</h2><p>记录赛博修仙日常 · 纯静态博客</p></div>' +
    '</div>' +
    '<div class="about-stats">' +
      '<div class="stat"><b>' + state.posts.length + '</b><span>文章</span></div>' +
      '<div class="stat"><b>' + cats.size + '</b><span>分类</span></div>' +
      '<div class="stat"><b>' + tags.size + '</b><span>标签</span></div>' +
      '<div class="stat"><b>' + latest + '</b><span>最近更新</span></div>' +
    '</div>' +
    '<p style="font-size:13px;line-height:1.8;color:var(--text-soft)">' +
      '一个用 Rust 命令行工具与原生 HTML / CSS / JS 打造的胶囊目录静态博客。' +
      '左侧目录栏像抽屉一样展开：搜索、筛选、滚动胶囊列表；右侧是置顶的精选内容。' +
    '</p>' +
    '<div class="a-links">' +
      '<a class="link-btn" href="' + SITE.repo + '" target="_blank" rel="noopener">GitHub 仓库</a>' +
      '<a class="link-btn" href="mailto:jerry@example.com">联系我</a>' +
    '</div>' +
    '<p style="margin-top:16px;font-size:11.5px;color:var(--text-faint);text-align:center">© ' + new Date().getFullYear() + ' ' + esc(SITE.author) + ' · 赛博修仙，从记录开始</p>';
}

/* ---------- 总渲染 ---------- */
function renderAll() {
  renderChips();
  renderPills();
  renderHome();
  renderArchive();
  renderAbout();
}

/* ---------- 事件 ---------- */
document.getElementById("tb-side-btn").addEventListener("click", () => toggleSidebar());
document.getElementById("side-collapse").addEventListener("click", () => toggleSidebar(false));
document.getElementById("side-grip").addEventListener("click", () => toggleSidebar(true));
document.getElementById("scrim").addEventListener("click", () => toggleSidebar(false));
document.getElementById("tb-theme").addEventListener("click", toggleTheme);
document.getElementById("side-search").addEventListener("input", e => { state.q = e.target.value; renderPills(); });
$$(".tabbar button").forEach(b => b.addEventListener("click", () => {
  if (b.dataset.nav === "home") showView("home");
  else if (b.dataset.nav === "archive") showView("archive");
  else showView("about");
}));
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && window.innerWidth <= 720) toggleSidebar(false);
});
window.addEventListener("resize", () => { renderHome(); });

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
  toggleSidebar(false);
  showView("home");
  loadPosts();
})();
