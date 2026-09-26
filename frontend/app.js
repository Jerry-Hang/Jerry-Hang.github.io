"use strict";

/* ============================================================
 * JerryHang 的个人博客 —— 胶囊目录静态博客（iOS 简洁风）
 * 纯原生 JS，零外部依赖。数据来自 posts.json。
 * ============================================================ */

const $  = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
const esc = s => String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");

const SITE = { title: "JerryHang 的个人博客", author: "JerryHang", repo: "https://github.com/Jerry-Hang/Jerry-Hang.github.io" };

/* 壁纸按方向区分：横版壁纸（桌面/平板/横屏）与竖版壁纸（手机竖屏） */
const WALLS = [
  { id: "clean", name: "纯色", img: "", orient: "any" },
  { id: "skull", name: "花海", img: "/assets/skull.jpg", orient: "portrait" },
  { id: "arch", name: "樱", img: "/assets/arch.jpg", orient: "portrait" },
  { id: "bg5", name: "雾", img: "/assets/bg5.jpg", orient: "portrait" },
  { id: "bg6", name: "夜", img: "/assets/bg6.jpg", orient: "portrait" },
  { id: "banner", name: "草地", img: "/assets/banner.jpg", orient: "landscape" },
  { id: "avatar3", name: "红伞", img: "/assets/avatar3.jpg", orient: "landscape" },
  { id: "long2", name: "原野", img: "/assets/long2.jpg", orient: "landscape" }
];
function isLandscape() { return window.innerWidth > window.innerHeight; }
function activeWalls() {
  return WALLS.filter(w => w.orient === "any" || (isLandscape() ? w.orient === "landscape" : w.orient === "portrait"));
}
const DEFAULT_WALL = () => "clean";

const state = {
  theme: localStorage.getItem("jb_theme") || "dark",
  wall: localStorage.getItem("jb_wall2") || DEFAULT_WALL(),
  posts: [],
  q: "",
  sideMode: "cat",
  sideView: "posts",
  outline: [],
  articleIdx: -1,
  pinnedPage: 1,
  // 默认字号档位见下面 FONT_SIZES 的注释。localStorage 里没有记录时用中间那档。
  fontScale: (function () {
    const v = localStorage.getItem("jb_font");
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) && n >= 0 && n <= 4 ? n : 2;
  })()
};

/* 正文字号档位。
   默认取中间那档（16.5px）—— 中文正文 16-17px 最舒服。
   之前默认是档位 0 也就是 13.5px，偏小，长文读起来累。

   注意：applyFontScale 往 #r-body 写的是内联样式，优先级高于 CSS 里的
   .md-body 规则，所以正文实际字号由这里的 FONT_SIZES 决定，改 CSS 没用。 */
const FONT_SIZES = [14, 15.5, 16.5, 18, 19.5];
const FONT_DEFAULT = 2;
function applyFontScale() {
  const el = document.getElementById("r-body");
  if (el) el.style.fontSize = FONT_SIZES[state.fontScale] + "px";
  const cur = document.getElementById("r-font-cur");
  if (cur) {
    const steps = state.fontScale - FONT_DEFAULT;
    cur.textContent = "A" + (steps > 0 ? "+".repeat(steps) : (steps < 0 ? "−".repeat(-steps) : ""));
  }
  localStorage.setItem("jb_font", String(state.fontScale));
}

function applyWall() {
  let w = WALLS.find(x => x.id === state.wall);
  if (!w || (w.orient !== "any" && (isLandscape() ? w.orient !== "landscape" : w.orient !== "portrait"))) {
    state.wall = DEFAULT_WALL();
    w = WALLS.find(x => x.id === state.wall);
  }
  const el = document.getElementById("wallpaper");
  if (el) el.style.backgroundImage = w.img ? "url('" + w.img + "')" : "none";
  // 有壁纸图时给 body 加标记，让极光那层 !important 渐变让位（见 index.html 的说明）
  document.body.classList.toggle("has-wall", !!w.img);
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
  let out = "", i = 0, inCode = false, codeBuf = [], listType = null, codeLang = "";

  const closeList = () => { if (listType) { out += "</" + listType + ">"; listType = null; } };
  const openList = t => { if (listType === t) return; closeList(); out += "<" + t + ">"; listType = t; };

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().startsWith(FENCE)) {
      if (!inCode) {
        inCode = true; codeBuf = [];
        // 取出围栏后的语言标识（```js / ```rust），给 <pre> 打 data-lang
        const info = line.trim().slice(FENCE.length).trim().split(/\s+/)[0] || "";
        codeLang = info.replace(/[^\w+#-]/g, "");
      } else {
        const attr = codeLang ? ' data-lang="' + esc(codeLang) + '"' : "";
        const cls = codeLang ? ' class="language-' + esc(codeLang) + '"' : "";
        out += "<pre" + attr + "><code" + cls + ">" + codeBuf.map(esc).join("\n") + "</code></pre>";
        inCode = false; codeLang = "";
      }
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
    const res = await fetch("/posts.json", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    state.posts = Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn("load posts.json failed:", e);
    state.posts = [];
  }
  renderAll();
  openFromHashIfAny();
  if (window.__ARTICLE__) {
    const idx = state.posts.findIndex(p => p.slug === window.__ARTICLE__ || p.title === window.__ARTICLE__);
    if (idx >= 0 && state.nav !== "reader") selectArticle(idx);
  }
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
function articleUrl(p) {
  return "/blog/" + (p.slug || p.title || "");
}
function copyPageLink() {
  let url;
  if (window.__ARTICLE__ && state.articleIdx >= 0 && state.posts[state.articleIdx]) {
    url = location.origin + articleUrl(state.posts[state.articleIdx]);
  } else if (state.articleIdx >= 0 && state.posts[state.articleIdx]) {
    url = location.origin + articleUrl(state.posts[state.articleIdx]);
  } else {
    url = location.origin + "/";
  }
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
    if (name !== "reader") { try { history.replaceState(null, "", "/"); } catch (e) { /* 忽略 */ } }
    $$(".view").forEach(v => v.classList.remove("on"));
    const v = document.getElementById("view-" + name);
    if (v) v.classList.add("on");
  $$("#tb-tabs button").forEach(b => b.classList.toggle("on", b.dataset.nav === name));
  document.body.classList.toggle("reading", name === "reader");
  // 首页用固定大图背景，其他视图回到极光底
  document.body.classList.toggle("home-bg", name === "home");
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
  const key = encodeURI(p.slug || p.title || "");
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
  try { history.replaceState(null, "", articleUrl(p)); } catch (e) { /* 忽略 */ }
}

/* ---------- 主页文章长条 3/4 + 翻页 ---------- */
function renderHome() {
  const list = state.posts;
  const grid = document.getElementById("pin-grid");

  if (!list.length) {
    const hc = document.getElementById("hero-card");
    if (hc) hc.innerHTML = '<div class="hc-body"><h2 class="hc-title">还没有文章</h2>' +
      '<p class="hc-desc">运行 blog_ctl new 创建第一篇。</p></div>';
    if (grid) grid.innerHTML = '<div class="empty-tip">暂无文章</div>';
    const pager0 = document.getElementById("pager-home");
    if (pager0) pager0.innerHTML = "";
    return;
  }

  /* ---------- 右栏：作者卡片 + 最新更新 + 站内链接 ---------- */

  // 简介：从「关于」类文章里取，取不到就用站点默认
  const aboutPost = list.find(p => (p.categories || []).some(c => c === "自述" || c === "关于")) || list[0];
  const bioEl = document.getElementById("pc-bio");
  if (bioEl) {
    bioEl.textContent = (aboutPost && aboutPost.desc)
      ? aboutPost.desc
      : "一个用 Rust 命令行工具与原生 HTML/CSS/JS 打造的胶囊目录静态博客。";
  }

  // 标签胶囊：用文章里出现最多的几个标签
  const tagCount = {};
  list.forEach(p => (p.tags || []).forEach(t => { tagCount[t] = (tagCount[t] || 0) + 1; }));
  const topTags = Object.keys(tagCount).sort((a, b) => tagCount[b] - tagCount[a]).slice(0, 3);
  const tagBox = document.getElementById("pc-tags");
  if (tagBox) {
    tagBox.innerHTML = topTags.map(t => '<span class="pc-tag">' + esc(t) + '</span>').join("");
  }

  // 最新更新：按日期倒序取 4 篇
  const latest = list.slice().sort((a, b) => String(b.date || "").localeCompare(String(a.date || ""))).slice(0, 4);
  const listBox = document.getElementById("latest-list");
  if (listBox) {
    listBox.innerHTML = latest.map(p => {
      const idx = list.indexOf(p);
      return '<button class="sc-item" data-idx="' + idx + '">' +
        '<span class="sc-title">' + esc(p.title) + '</span>' +
        '<span class="sc-date">' + esc(p.date || "") + '</span>' +
      '</button>';
    }).join("");
    $$("#latest-list .sc-item").forEach(b => b.addEventListener("click", () => selectArticle(Number(b.dataset.idx))));
  }

  /* ---------- 大卡：置顶优先，否则最新一篇 ---------- */
  const hero = list.find(p => p.pinned) || latest[0];
  const heroBox = document.getElementById("hero-card");
  if (heroBox && hero) {
    const idx = list.indexOf(hero);
    const words = (hero.body || "").replace(/\s/g, "").length;
    const tags = (hero.categories || []).concat(hero.tags || []).slice(0, 4)
      .map(t => '<span class="hc-tag">' + esc(t) + '</span>').join("");
    const cover = hero.cover || "/assets/banner.jpg";
    heroBox.innerHTML =
      '<img class="hc-cover" src="' + esc(cover) + '" alt="" loading="eager">' +
      '<div class="hc-body">' +
        (tags ? '<div class="hc-tags">' + tags + '</div>' : '') +
        '<h2 class="hc-title">' + esc(hero.title) + '</h2>' +
        (hero.desc ? '<p class="hc-desc">' + esc(hero.desc) + '</p>' : '') +
        '<div class="hc-meta">' +
          '<span>' + esc(hero.date || "") + '</span>' +
          '<span>' + esc(SITE.author) + '</span>' +
          '<span>' + words.toLocaleString() + ' 字 · 约 ' + readMinutes(hero) + ' 分钟</span>' +
          '<span class="hc-read">阅读全文 ›</span>' +
        '</div>' +
      '</div>';
    heroBox.onclick = () => selectArticle(idx);
  }

  /* ---------- 下方网格：排除大卡那篇，其余分页 ---------- */
  const rest = list.filter(p => p !== hero);
  const perPage = (window.innerWidth <= 720 ? 4 : 6);
  const pages = Math.max(1, Math.ceil(rest.length / perPage));
  if (state.pinnedPage > pages) state.pinnedPage = pages;
  const start = (state.pinnedPage - 1) * perPage;
  const pageItems = rest.slice(start, start + perPage);

  if (!pageItems.length) {
    grid.innerHTML = '<div class="empty-tip">没有更多文章了</div>';
  } else {
    grid.innerHTML = pageItems.map(p => {
      const idx = list.indexOf(p);
      const words = (p.body || "").replace(/\s/g, "").length;
      const tags = (p.tags || []).slice(0, 2).map(t => '<span class="p-tag">' + esc(t) + '</span>').join("");
      const cats = (p.categories || []).slice(0, 1).map(c => '<span class="hi-cats">' + esc(c) + '</span>').join("");
      return '<button class="home-item' + (p.cover ? "" : " no-cover") + '" data-idx="' + idx + '">' +
        (p.cover ? '<img class="hi-cover" src="' + esc(p.cover) + '" alt="" loading="lazy">' : '') +
        '<span class="hi-body">' +
          '<span class="hi-top"><span class="hi-date">' + esc(p.date || "") + '</span>' + cats + '</span>' +
          '<span class="hi-title">' + esc(p.title) + '</span>' +
          (p.desc ? '<span class="hi-excerpt">' + esc(p.desc) + '</span>' : '') +
          '<span class="hi-meta">' + tags + '<span class="p-words">' + words.toLocaleString() + ' 字 · ' + readMinutes(p) + ' 分钟</span>' +
            '<span class="hi-arrow">继续阅读 ›</span>' +
          '</span>' +
        '</span>' +
      '</button>';
    }).join("");
  }
  $$("#pin-grid .home-item").forEach(b => b.addEventListener("click", () => selectArticle(Number(b.dataset.idx))));
  if (window.bindTilt) window.bindTilt(grid);

  /* ---------- 分页 ---------- */
  const pager = document.getElementById("pager-home");
  if (rest.length <= perPage) {
    pager.innerHTML = "";
  } else {
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
  enhanceArticle(mdBody, outline);
}

/* ==========================================================================
   阅读增强
   --------------------------------------------------------------------------
   全部在渲染完成后对 DOM 做后处理，不改 mdToHtml 的输出结构。
   这样插件的、复制的、存档的旧 HTML 都不会受影响。
   ========================================================================== */

/* ---------- 极轻量语法高亮 ----------
   不引第三方库（站点是零依赖的单文件静态站）。
   策略：先把已转义的 HTML 文本按 token 切分，再逐段包 span，
   绝不回填未转义内容，避免破坏 XSS 防护。
   覆盖常见语言的关键字集，识别不了的按纯文本处理。 */

const HL_KEYWORDS = {
  js: "const let var function return if else for while do switch case break continue new typeof instanceof class extends super this null undefined true false try catch finally throw async await yield import export from default of in delete void static get set",
  ts: "const let var function return if else for while do switch case break continue new typeof instanceof class extends super this null undefined true false try catch finally throw async await yield import export from default of in delete void static get set interface type enum implements readonly public private protected",
  rust: "fn let mut const static struct enum impl trait pub use mod crate self super match if else for while loop return break continue where as dyn ref move async await unsafe extern box in true false Some None Ok Err String Vec Option Result",
  py: "def class return if elif else for while import from as try except finally raise with lambda None True False and or not in is pass break continue global nonlocal yield assert del async await self",
  sh: "if then else elif fi for while do done case esac function return export local readonly source alias echo cd ls cp mv rm mkdir cat grep sed awk curl wget sudo apt npm pnpm node git",
  sql: "SELECT FROM WHERE INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE DROP ALTER INDEX JOIN LEFT RIGHT INNER OUTER ON GROUP BY ORDER HAVING LIMIT OFFSET AND OR NOT NULL PRIMARY KEY FOREIGN REFERENCES DEFAULT",
  css: "important media supports keyframes import charset",
  json: "true false null",
  yaml: "true false null",
  toml: "true false",
  html: "",
  md: "",
  text: ""
};

function langKey(lang) {
  const l = String(lang || "").toLowerCase();
  if (!l) return "";
  if (l === "javascript" || l === "jsx" || l === "mjs" || l === "cjs") return "js";
  if (l === "typescript" || l === "tsx") return "ts";
  if (l === "rs") return "rust";
  if (l === "python" || l === "python3") return "py";
  if (l === "bash" || l === "shell" || l === "zsh" || l === "console" || l === "powershell" || l === "ps1") return "sh";
  if (l === "postgres" || l === "sqlite" || l === "mysql") return "sql";
  if (l === "yml") return "yaml";
  if (l === "htm") return "html";
  if (l === "markdown") return "md";
  if (l === "plain" || l === "plaintext" || l === "txt") return "text";
  return HL_KEYWORDS[l] !== undefined ? l : "";
}

/**
 * 对已转义的源码做高亮。
 * 输入必须是 escape 之后的文本；输出是可安全插入 innerHTML 的字符串。
 */
function highlight(escaped, lang) {
  const key = langKey(lang);
  if (!key || key === "html" || key === "md" || key === "text") return null;
  const kws = HL_KEYWORDS[key];
  if (!kws) return null;
  const kwSet = new Set(kws.split(/\s+/).filter(Boolean));

  // 一个总正则，按优先级匹配：注释 / 字符串 / 数字 / 标识符
  // 注意 \\x60 是反引号，避免和模板字符串的界定符冲突
  const BT = String.fromCharCode(96);
  const re = new RegExp(
    "(\\/\\/[^\\n]*|#[^\\n]*|--[^\\n]*)" +          // 1 行注释
    "|(\\/\\*[\\s\\S]*?\\*\\/)" +                    // 2 块注释
    "|(\"(?:[^\"\\\\\\n]|\\\\.)*\")" +               // 3 双引号串
    "|('(?:[^'\\\\\\n]|\\\\.)*')" +                  // 4 单引号串
    "|(" + BT + "[^" + BT + "]*" + BT + ")" +        // 5 反引号串
    "|(\\b\\d[\\d_.]*\\b)" +                         // 6 数字
    "|([A-Za-z_$][\\w$]*)" +                         // 7 标识符
    "|([{}()\\[\\];,.:=+\\-*/%<>!&|?~^]+)",          // 8 符号
    "g"
  );

  let out = "";
  let last = 0;
  let m;
  while ((m = re.exec(escaped)) !== null) {
    if (m.index > last) out += escaped.slice(last, m.index);
    if (m[1] || m[2]) {
      out += '<span class="tok-comment">' + m[0] + "</span>";
    } else if (m[3] || m[4] || m[5]) {
      out += '<span class="tok-string">' + m[0] + "</span>";
    } else if (m[6]) {
      out += '<span class="tok-number">' + m[0] + "</span>";
    } else if (m[7]) {
      const w = m[0];
      if (kwSet.has(w)) {
        out += '<span class="tok-keyword">' + w + "</span>";
      } else {
        // 后面紧跟 ( 的当成函数名
        const after = escaped.slice(re.lastIndex, re.lastIndex + 1);
        out += after === "("
          ? '<span class="tok-func">' + w + "</span>"
          : (/^[A-Z]/.test(w) ? '<span class="tok-type">' + w + "</span>" : w);
      }
    } else if (m[8]) {
      out += '<span class="tok-punct">' + m[0] + "</span>";
    } else {
      out += m[0];
    }
    last = re.lastIndex;
  }
  out += escaped.slice(last);
  return out;
}

/** 渲染完成后对文章正文做增强 */
function enhanceArticle(mdBody, outline) {
  if (!mdBody) return;

  /* ---- 1. 代码块：语言标签 + 高亮 + 复制按钮 ---- */
  mdBody.querySelectorAll("pre").forEach(pre => {
    let codeEl = pre.querySelector("code");
    if (!codeEl) return;

    // 语言从 class="language-xxx" 读（mdToHtml 目前不加，但存档页可能有）
    let lang = "";
    const cls = codeEl.className || "";
    const mm = /language-([\w+-]+)/.exec(cls);
    if (mm) lang = mm[1];
    if (!lang) {
      // 兼容之前生成的页面：有的把语言写在 pre 的 data-lang 上
      lang = pre.getAttribute("data-lang") || "";
    }
    if (lang) pre.setAttribute("data-lang", lang);

    const plain = codeEl.textContent;
    const highlighted = highlight(esc(plain), lang);
    if (highlighted !== null) codeEl.innerHTML = highlighted;

    if (!pre.querySelector(".code-copy")) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "code-copy";
      b.textContent = "复制";
      pre.appendChild(b);
    }
  });

  /* ---- 2. 标题锚点（hover 出现 §，点击复制该节链接） ---- */
  mdBody.querySelectorAll("h2,h3").forEach(h => {
    if (!h.id) return;
    if (h.querySelector(".h-anchor")) return;
    const a = document.createElement("a");
    a.className = "h-anchor";
    a.href = "#" + h.id;
    a.textContent = "§";
    a.setAttribute("aria-label", "本节链接");
    h.insertBefore(a, h.firstChild);
  });

  /* ---- 3. 目录 ---- */
  renderToc(mdBody, outline);

  /* ---- 4. 图片灯箱 ---- */
  bindLightbox(mdBody);
}

/** 生成目录并绑定滚动高亮 */
let tocObserver = null;
function renderToc(mdBody, outline) {
  const box = document.getElementById("r-toc");
  if (!box) return;

  if (tocObserver) { tocObserver.disconnect(); tocObserver = null; }

  const items = (outline || []).filter(x => x.text);
  // 少于 3 个标题就不显示目录，否则显得多余
  if (items.length < 3) { box.hidden = true; box.innerHTML = ""; return; }

  box.hidden = false;
  box.innerHTML =
    '<div class="toc-head">本文目录</div><ol>' +
    items.map(x =>
      '<li><a href="#' + esc(x.id) + '" class="lv-' + x.level + '" data-target="' + esc(x.id) + '">' +
        esc(x.text) + '</a></li>'
    ).join("") +
    '</ol>';

  // 平滑滚动（顶栏高度留白由 CSS 的 scroll-margin-top 处理）
  box.querySelectorAll("a").forEach(a => {
    a.addEventListener("click", e => {
      e.preventDefault();
      const el = document.getElementById(a.dataset.target);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      history.replaceState(null, "", "#" + a.dataset.target);
      setActiveToc(a.dataset.target);
    });
  });

  // 滚动高亮：用 IntersectionObserver 比监听 scroll 省性能
  const links = {};
  box.querySelectorAll("a").forEach(a => { links[a.dataset.target] = a; });

  if ("IntersectionObserver" in window) {
    tocObserver = new IntersectionObserver(entries => {
      // 取当前可见的最靠上的标题
      const vis = entries.filter(e => e.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (vis.length) setActiveToc(vis[0].target.id);
    }, { rootMargin: "-80px 0px -70% 0px", threshold: 0 });
    items.forEach(x => {
      const el = document.getElementById(x.id);
      if (el) tocObserver.observe(el);
    });
  }

  function setActiveToc(id) {
    box.querySelectorAll("a").forEach(a => a.classList.toggle("active", a.dataset.target === id));
  }
  window.__setActiveToc = setActiveToc;
}

/** 图片点击放大 */
function bindLightbox(mdBody) {
  const lb = document.getElementById("lightbox");
  if (!lb) return;
  const img = lb.querySelector("img");

  mdBody.querySelectorAll("img").forEach(im => {
    if (im.dataset.lbBound) return;
    im.dataset.lbBound = "1";
    im.addEventListener("click", () => {
      img.src = im.currentSrc || im.src;
      img.alt = im.alt || "";
      lb.classList.add("on");
      document.body.style.overflow = "hidden";
    });
  });
}
function closeLightbox() {
  const lb = document.getElementById("lightbox");
  if (lb) lb.classList.remove("on");
  document.body.style.overflow = "";
}

/* ---------- 进度条 + 回到顶部 ---------- */
function initReadingChrome() {
  const bar = document.getElementById("read-progress");
  const top = document.getElementById("to-top");
  if (!bar && !top) return;

  function onScroll() {
    const doc = document.documentElement;
    const max = doc.scrollHeight - doc.clientHeight;
    const y = window.scrollY || doc.scrollTop || 0;
    const pct = max > 8 ? Math.min(100, Math.max(0, (y / max) * 100)) : 0;

    if (bar) {
      // 只在阅读视图显示进度条
      const reading = state.nav === "reader";
      bar.style.width = pct + "%";
      bar.classList.toggle("on", reading && pct > 0.5);
    }
    if (top) top.classList.toggle("on", y > 400);
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll, { passive: true });
  if (top) top.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
  window.__refreshReadingChrome = onScroll;
  onScroll();
}

document.addEventListener("DOMContentLoaded", () => {
  const lb = document.getElementById("lightbox");
  if (lb) {
    lb.addEventListener("click", e => { if (e.target === lb) closeLightbox(); });
  }
  initReadingChrome();
});

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
  const tagsAll = new Set();
  const catsAll = new Set();
  state.posts.forEach(p => {
    (p.tags || []).forEach(t => tagsAll.add(t));
    (p.categories || []).forEach(c => catsAll.add(c));
  });
  const totalWords = state.posts.reduce((n, p) => n + (p.body || "").replace(/\s/g, "").length, 0);
  const catChips = Array.from(catsAll).map(c => '<span class="side-cap">' + esc(c) + '</span>').join("");
  const tagChips = Array.from(tagsAll).map(t => '<span class="side-cap">' + esc(t) + '</span>').join("");
  document.getElementById("about-body").innerHTML =
    '<div class="about-layout">' +
      '<aside class="about-side">' +
        '<div class="avatar"><img src="/assets/avatar.jpg" alt=""></div>' +
        '<h2>' + esc(SITE.title) + '</h2>' +
        '<p class="a-sub">记录与折腾 · 纯静态博客</p>' +
        '<div class="sect"><h3 class="sect-t">分类</h3><div class="cap-wrap">' + catChips + '</div></div>' +
        '<div class="sect"><h3 class="sect-t">标签</h3><div class="cap-wrap">' + tagChips + '</div></div>' +
        '<div class="a-links">' +
          '<a class="link-btn" href="' + SITE.repo + '" target="_blank" rel="noopener">GitHub 仓库</a>' +
          '<a class="link-btn" href="/feed.xml" target="_blank" rel="noopener">RSS 订阅</a>' +
          '<a class="link-btn" href="mailto:jerry@example.com">联系我</a>' +
        '</div>' +
      '</aside>' +
      '<div class="about-main">' +
        '<div class="about-stats">' +
          '<div class="stat"><b>' + state.posts.length + '</b><span>文章</span></div>' +
          '<div class="stat"><b>' + catsAll.size + '</b><span>分类</span></div>' +
          '<div class="stat"><b>' + tagsAll.size + '</b><span>标签</span></div>' +
          '<div class="stat"><b>' + totalWords.toLocaleString() + '</b><span>总字数</span></div>' +
        '</div>' +
        '<div class="sect"><h3 class="sect-t">壁纸（' + (isLandscape() ? "横版" : "竖版") + '）</h3>' +
          '<div class="wall-grid" id="wall-grid"></div>' +
        '</div>' +
        '<p class="a-desc">一个用 Rust 命令行工具与原生 HTML / CSS / JS 打造的胶囊目录静态博客。左侧目录栏像抽屉一样展开：搜索、筛选、滚动胶囊列表；右侧是置顶的精选内容。</p>' +
        '<p class="a-foot">© ' + new Date().getFullYear() + ' ' + esc(SITE.author) + ' · 记录与折腾</p>' +
      '</div>' +
    '</div>';
  const wg = document.getElementById("wall-grid");
  if (wg) {
    wg.innerHTML = activeWalls().map(w =>
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
  if (e.key === "Escape") {
    // 图片灯箱优先关闭，再关侧栏
    const lb = document.getElementById("lightbox");
    if (lb && lb.classList.contains("on")) { closeLightbox(); return; }
    toggleSidebar(false);
    return;
  }
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
    const key = decodeURI(m[1]);
    const idx = state.posts.findIndex(p => p.slug === key || p.title === key);
    if (idx >= 0) selectArticle(idx); else showView("home");
  } else {
    if (state.nav !== "home") showView("home");
  }
});
function openFromHashIfAny() {
  const m = (location.hash || "").match(/^#\/post\/(.+)$/);
  if (!m) return;
  const key = decodeURI(m[1]);
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
