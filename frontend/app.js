"use strict";

/* ============================================================
 * JerryHang 的个人博客 —— 胶囊目录静态博客（iOS 简洁风）
 * 纯原生 JS，零外部依赖。数据来自 posts.json。
 * ============================================================ */

const $  = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
const esc = s => String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");

const SITE = { title: "JerryHang 的个人博客", author: "JerryHang", repo: "https://github.com/Jerry-Hang/Jerry-Hang.github.io" };

/* 友链列表（精选推荐与朋友们） */
const FRIENDS = [
  {
    name: "Eric-Terminal",
    url: "https://blog.ericterminal.com",
    avatar: "/assets/eric-terminal.png",
    bio: "专注于现代前端技术与全栈折腾，cf-astro-blog 作者。",
    tags: ["前端", "Astro", "开源"]
  },
  {
    name: "Rust 官方社区",
    url: "https://www.rust-lang.org",
    avatar: "/assets/avatar.jpg",
    bio: "一门赋予每个人构建可靠且高效软件能力的现代系统级编程语言。",
    tags: ["Rust", "系统编程", "高性能"]
  },
  {
    name: "MDN Web Docs",
    url: "https://developer.mozilla.org",
    avatar: "/assets/avatar.jpg",
    bio: "面向全球 Web 开发者的权威开放文档库与现代网络技术标准。",
    tags: ["Web", "文档", "标准"]
  },
  {
    name: "JerryHang's GitHub",
    url: "https://github.com/Jerry-Hang",
    avatar: "/assets/avatar.jpg",
    bio: "开源探索与技术实验项目沉淀，记录每一次折腾与突破。",
    tags: ["开源", "个人主页", "折腾"]
  }
];

/* 壁纸按方向区分：横版壁纸与竖版壁纸全部开放供用户自由选用 */
const WALLS = [
  { id: "clean", name: "纯色", img: "", orient: "any" },
  { id: "banner", name: "草地", img: "/assets/banner.jpg", orient: "landscape" },
  { id: "skull", name: "花海", img: "/assets/skull.jpg", orient: "portrait" },
  { id: "arch", name: "樱", img: "/assets/arch.jpg", orient: "portrait" },
  { id: "avatar3", name: "红伞", img: "/assets/avatar3.jpg", orient: "landscape" },
  { id: "bg5", name: "雾", img: "/assets/bg5.jpg", orient: "portrait" },
  { id: "bg6", name: "夜", img: "/assets/bg6.jpg", orient: "portrait" },
  { id: "long2", name: "原野", img: "/assets/long2.jpg", orient: "landscape" }
];
function isLandscape() { return window.innerWidth > window.innerHeight; }
function activeWalls() { return WALLS; }
const DEFAULT_WALL = () => "banner";

const wallSaved = localStorage.getItem("jb_wall3");
let initWall = wallSaved || "banner";
localStorage.setItem("jb_wall3", initWall);

const state = {
  theme: localStorage.getItem("jb_theme") || "dark",
  wall: initWall,
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
  if (!w) {
    state.wall = "banner";
    w = WALLS.find(x => x.id === "banner") || WALLS[0];
  }
  const el = document.getElementById("wallpaper");
  const shade = document.getElementById("wall-shade");
  const isClean = !w || w.id === "clean" || !w.img;
  if (el) {
    if (isClean) {
      el.style.setProperty("background-image", "none", "important");
      el.style.setProperty("display", "none", "important");
      el.style.setProperty("opacity", "0", "important");
    } else {
      el.style.setProperty("background-image", "url('" + w.img + "')", "important");
      el.style.setProperty("display", "block", "important");
      el.style.setProperty("opacity", "1", "important");
    }
  }
  if (shade) {
    shade.style.setProperty("display", isClean ? "none" : "block", "important");
    shade.style.setProperty("opacity", isClean ? "0" : "1", "important");
  }
  document.body.classList.toggle("wall-clean", isClean);
  document.body.classList.toggle("has-wall", !isClean);
  localStorage.setItem("jb_wall3", state.wall);
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
  // 宽屏下手动操作过一次就记住，下次打开不再自动展开
  if (window.innerWidth >= 1000) {
    try { localStorage.setItem("jb_side", open ? "open" : "closed"); } catch (e) { /* 隐私模式忽略 */ }
  }
}

/// 宽屏首次进入时自动展开目录栏。
///
/// 侧栏（胶囊目录）在移动端是汉堡抽屉：默认收起、点按钮展开。
/// 但桌面上有 300px 的横向空间，一直收着会让左侧留一条 2px 的缝、
/// 导航被推到屏幕中间，看起来像坏掉了。所以宽屏默认展开一次；
/// 用户手动收起过（localStorage 有记录）就尊重用户的选择。
function initSidebarDefault() {
  if (window.innerWidth < 1000) return;
  let saved = null;
  try { saved = localStorage.getItem("jb_side"); } catch (e) { /* 忽略 */ }
  if (saved === "closed") return;
  document.getElementById("layout").classList.add("side-open");
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
  $$("#tb-tabs button").forEach(b => b.classList.toggle("on", b.dataset.nav === name));
  const doIt = () => {
    if (name !== "reader") { try { history.replaceState(null, "", "/"); } catch (e) { /* 忽略 */ } }
    $$(".view").forEach(v => v.classList.remove("on"));
    const v = document.getElementById("view-" + name);
    if (v) v.classList.add("on");
    $$("#tb-tabs button").forEach(b => b.classList.toggle("on", b.dataset.nav === name));
    document.body.classList.toggle("reading", name === "reader");
    // 全局保持个性化背景一致
    document.body.classList.toggle("home-bg", true);
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

  // 简介固定取「自述/关于」那篇。
  // 之前这里退化成 list[0]（最新一篇），结果作者卡片里显示的是最新技术文的摘要，
  // 跟「作者简介」完全不搭。
  const aboutPost =
    list.find(p => p.slug === "about-me") ||
    list.find(p => (p.categories || []).some(c => c === "自述" || c === "关于")) ||
    list.find(p => /自述|关于|自我介绍|about/i.test(p.title || "")) ||
    null;
  const bioEl = document.getElementById("pc-bio");
  if (bioEl) {
    if (aboutPost && aboutPost.desc) {
      bioEl.textContent = aboutPost.desc;
    } else if (aboutPost && aboutPost.body) {
      // 没有 desc 就从正文截一段，去掉 markdown 标记
      const plain = String(aboutPost.body)
        .replace(/^#+\s.*$/gm, "")
        .replace(/[*_`>\[\]()!]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      bioEl.textContent = plain.slice(0, 90) + (plain.length > 90 ? "…" : "");
    } else {
      bioEl.textContent = "一个用 Rust 命令行工具与原生 HTML/CSS/JS 打造的胶囊目录静态博客。";
    }
  }

  // 标签胶囊：用文章里出现最多的几个标签
  const tagCount = {};
  list.forEach(p => (p.tags || []).forEach(t => { tagCount[t] = (tagCount[t] || 0) + 1; }));
  const topTags = Object.keys(tagCount).sort((a, b) => tagCount[b] - tagCount[a]).slice(0, 3);
  const tagBox = document.getElementById("pc-tags");
  if (tagBox) {
    tagBox.innerHTML = topTags.map(t => '<span class="pc-tag">' + esc(t) + '</span>').join("");
  }

  /* ---------- 大卡：置顶优先，否则最新一篇 ---------- */
  // 先定 hero，右栏的「最新更新」和下方网格都要把它排除掉，
  // 否则同一篇会同时出现在三个地方。
  const byDate = list.slice().sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  const hero = list.find(p => p.pinned) || byDate[0];

  // 最新更新：排除 hero 之后的最近 4 篇
  const latest = byDate.filter(p => p !== hero).slice(0, 4);
  const listBox = document.getElementById("latest-list");
  if (listBox) {
    listBox.innerHTML = latest.length
      ? latest.map(p => {
          const idx = list.indexOf(p);
          return '<button class="sc-item" data-idx="' + idx + '">' +
            '<span class="sc-title">' + esc(p.title) + '</span>' +
            '<span class="sc-date">' + esc(p.date || "") + '</span>' +
          '</button>';
        }).join("")
      : '<div class="sc-empty">暂无其他文章</div>';
    $$("#latest-list .sc-item").forEach(b => b.addEventListener("click", () => selectArticle(Number(b.dataset.idx))));
  }

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
          '<span class="hc-read">阅读全文</span>' +
        '</div>' +
      '</div>';
    heroBox.onclick = () => selectArticle(idx);
  } else if (heroBox) {
    heroBox.innerHTML = "";
  }

  /* ---------- 下方网格：排除大卡那篇，其余分页 ---------- */
  const rest = list.filter(p => p !== hero);
  const perPage = (window.innerWidth <= 720 ? 6 : 9);
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
            '<span class="hi-arrow">阅读全文</span>' +
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
      '<button class="pg-btn" id="pg-prev" ' + (state.pinnedPage <= 1 ? "disabled" : "") + '>上一页</button>' +
      '<span class="pg-info">第 <b>' + state.pinnedPage + '</b> / ' + pages + ' 页</span>' +
      '<input class="pg-input" id="pg-input" type="number" min="1" max="' + pages + '" value="' + state.pinnedPage + '" aria-label="页码">' +
      '<button class="pg-btn" id="pg-go">前往</button>' +
      '<button class="pg-btn" id="pg-next" ' + (state.pinnedPage >= pages ? "disabled" : "") + '>下一页</button>';
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
    b.type = "button";
    b.className = "code-copy";
    b.setAttribute("aria-label", "复制代码");
    b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>复制</span>';
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
  const slug = p.slug || p.title;
  document.getElementById("r-foot").innerHTML =
    '<div class="r-foot-pagers">' +
      '<button class="pn-btn pn-prev' + (prev ? "" : " disabled") + '" id="r-prev" title="' + (prev ? esc(prev.title) : "") + '">' +
        '<svg class="pn-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="15 18 9 12 15 6"/></svg>' +
        '<span class="pn-text"><small>上一篇</small><b>' + (prev ? esc(prev.title) : "已是最早") + '</b></span>' +
      '</button>' +
      '<button class="pn-btn pn-next' + (next ? "" : " disabled") + '" id="r-next" title="' + (next ? esc(next.title) : "") + '">' +
        '<span class="pn-text"><small>下一篇</small><b>' + (next ? esc(next.title) : "已是最新") + '</b></span>' +
        '<svg class="pn-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="9 18 15 12 9 6"/></svg>' +
      '</button>' +
    '</div>' +
    '<div class="r-foot-actions">' +
      '<button class="act-btn r-like-btn" id="r-like" title="喜欢这篇文章">' +
        '<svg class="act-icon like-heart" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>' +
        '<span id="r-like-count">点赞</span>' +
      '</button>' +
      '<button class="act-btn" id="r-share-qr" title="生成二维码分享">' +
        '<svg class="act-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>' +
        '<span>扫码阅读</span>' +
      '</button>' +
      '<button class="act-btn" id="r-copy"><svg class="act-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>复制链接</span></button>' +
      '<button class="act-btn" id="r-back"><svg class="act-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="15 18 9 12 15 6"/><line x1="9" y1="12" x2="20" y2="12"/></svg><span>返回主页</span></button>' +
    '</div>';

  fetchLikes(slug);
  document.getElementById("r-like").addEventListener("click", () => submitLike(slug));
  document.getElementById("r-share-qr").addEventListener("click", () => showShareModal(p));
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
      b.setAttribute("aria-label", "复制代码");
      b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>复制</span>';
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
  const isMobile = window.innerWidth <= 768;
  if (isMobile) box.classList.add("collapsed"); else box.classList.remove("collapsed");
  box.innerHTML =
    '<div class="toc-head" role="button" tabindex="0" aria-expanded="' + (!isMobile) + '">' +
      '<span>本文目录</span><svg class="toc-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><polyline points="6 9 12 15 18 9"/></svg>' +
    '</div><ol>' +
    items.map(x =>
      '<li><a href="#' + esc(x.id) + '" class="lv-' + x.level + '" data-target="' + esc(x.id) + '">' +
        esc(x.text) + '</a></li>'
    ).join("") +
    '</ol>';

  const head = box.querySelector(".toc-head");
  if (head) {
    head.addEventListener("click", () => {
      box.classList.toggle("collapsed");
      head.setAttribute("aria-expanded", String(!box.classList.contains("collapsed")));
    });
  }

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

/* ---------- 友链 ---------- */
function renderFriends() {
  const grid = document.getElementById("friends-grid");
  if (!grid) return;
  grid.innerHTML = FRIENDS.map(f => {
    const initial = (f.name || "?").trim().charAt(0).toUpperCase();
    const tagsHtml = (f.tags || []).map(t => '<span class="friend-tag">' + esc(t) + '</span>').join("");
    return '<a class="friend-card" href="' + esc(f.url) + '" target="_blank" rel="noopener noreferrer">' +
      '<div class="friend-avatar-wrap">' +
        '<img class="friend-avatar" src="' + esc(f.avatar) + '" alt="' + esc(f.name) + '" loading="lazy" onerror="this.style.display=\'none\';if(this.nextElementSibling)this.nextElementSibling.style.display=\'flex\';">' +
        '<div class="friend-fallback-avatar" style="display:none;">' + esc(initial) + '</div>' +
      '</div>' +
      '<div class="friend-info">' +
        '<div class="friend-name-row">' +
          '<span class="friend-name">' + esc(f.name) + '</span>' +
          '<svg class="friend-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></svg>' +
        '</div>' +
        '<p class="friend-desc">' + esc(f.bio) + '</p>' +
        (tagsHtml ? '<div class="friend-tags">' + tagsHtml + '</div>' : '') +
      '</div>' +
    '</a>';
  }).join("");

  const copyBtn = document.getElementById("copy-my-info");
  if (copyBtn && !copyBtn.dataset.bound) {
    copyBtn.dataset.bound = "1";
    copyBtn.addEventListener("click", () => {
      const info = "博客名称：JerryHang 的个人博客\n博客网址：https://jerry-hang.blog\n博客简介：记录与折腾 · 纯静态轻量博客\n博客头像：https://jerry-hang.blog/assets/avatar.jpg";
      const notify = () => showToast("本站信息已复制");
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(info).then(notify).catch(() => fallbackCopy(info, notify));
      } else {
        fallbackCopy(info, notify);
      }
    });
  }
}

/* ---------- 全局命令搜索浮层 (Ctrl+K / Cmd+K) ---------- */
let searchActiveIdx = -1;
let searchMatches = [];

function openSearchModal() {
  const modal = document.getElementById("search-modal");
  const input = document.getElementById("sm-input");
  if (!modal || !input) return;
  modal.removeAttribute("hidden");
  modal.classList.add("open");
  input.focus();
  input.select();
  runSearch(input.value.trim());
  document.body.style.overflow = "hidden";
}

function closeSearchModal() {
  const modal = document.getElementById("search-modal");
  if (!modal) return;
  modal.classList.remove("open");
  setTimeout(() => {
    modal.setAttribute("hidden", "");
    document.body.style.overflow = "";
  }, 200);
}

function highlightText(text, query) {
  if (!query) return esc(text);
  const escapedText = esc(text);
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return escapedText;
  const regex = new RegExp("(" + terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "gi");
  return escapedText.replace(regex, '<mark class="sm-highlight">$1</mark>');
}

function getSnippet(body, query, maxLen) {
  const limit = maxLen || 110;
  const plain = (body || "")
    .replace(/^#+\s.*$/gm, "")
    .replace(/[*_`>\[\]()!#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!query) return plain.slice(0, limit) + (plain.length > limit ? "…" : "");
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  let bestIdx = -1;
  const lower = plain.toLowerCase();
  for (const t of terms) {
    const idx = lower.indexOf(t);
    if (idx >= 0 && (bestIdx === -1 || idx < bestIdx)) bestIdx = idx;
  }
  if (bestIdx === -1) return plain.slice(0, limit) + (plain.length > limit ? "…" : "");
  const start = Math.max(0, bestIdx - 20);
  const end = Math.min(plain.length, start + limit);
  return (start > 0 ? "…" : "") + plain.slice(start, end) + (end < plain.length ? "…" : "");
}

function runSearch(query) {
  const resultsBox = document.getElementById("sm-results");
  const countBox = document.getElementById("sm-count");
  const clearBtn = document.getElementById("sm-clear");
  if (!resultsBox) return;
  if (clearBtn) clearBtn.hidden = !query;

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) {
    searchMatches = state.posts.slice(0, 5);
    searchActiveIdx = -1;
    if (countBox) countBox.textContent = "全站共 " + state.posts.length + " 篇文章";
    resultsBox.innerHTML = '<div class="sm-section-label">RECOMMENDED / 推荐阅读</div>' +
      searchMatches.map((p, idx) => renderSearchItem(p, idx, "")).join("");
    bindSearchItemClicks();
    return;
  }

  const scored = [];
  state.posts.forEach(p => {
    let score = 0;
    const titleL = (p.title || "").toLowerCase();
    const descL = (p.desc || "").toLowerCase();
    const bodyL = (p.body || "").toLowerCase();
    const tagsL = (p.tags || []).map(t => t.toLowerCase()).join(" ");
    const catsL = (p.categories || []).map(c => c.toLowerCase()).join(" ");

    let allMatched = true;
    for (const t of terms) {
      let termMatched = false;
      if (titleL.includes(t)) { score += 20; termMatched = true; }
      if (tagsL.includes(t)) { score += 10; termMatched = true; }
      if (catsL.includes(t)) { score += 8; termMatched = true; }
      if (descL.includes(t)) { score += 6; termMatched = true; }
      if (bodyL.includes(t)) { score += 3; termMatched = true; }
      if (!termMatched) allMatched = false;
    }
    if (allMatched && score > 0) scored.push({ post: p, score });
  });

  scored.sort((a, b) => b.score - a.score);
  searchMatches = scored.map(x => x.post);
  searchActiveIdx = searchMatches.length ? 0 : -1;

  if (countBox) countBox.textContent = "找到 " + searchMatches.length + " 篇相关文章";

  const isAuthQuery = /^(admin|auth|login|后台|管理|验证|设备)/i.test(query.trim());

  if (!searchMatches.length) {
    if (isAuthQuery) {
      resultsBox.innerHTML = '<div class="sm-item" id="sm-auth-action" style="cursor:pointer;border-left:3px solid var(--accent);background:rgba(230,0,0,0.06);padding:14px;">' +
        '<div class="sm-item-head"><span class="sm-item-title" style="color:var(--accent);font-weight:700;">受信任设备授权 (解锁管理入口)</span></div>' +
        '<div class="sm-item-snippet" style="color:var(--text);margin-top:4px;">输入管理员密码或配对凭证，永久为当前设备开启导航栏后台管理入口。</div>' +
        '</div>';
      const actionEl = document.getElementById("sm-auth-action");
      if (actionEl) {
        actionEl.addEventListener("click", () => {
          closeSearchModal();
          openDeviceAuthModal();
        });
      }
      return;
    }
    resultsBox.innerHTML = '<div class="sm-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="28" height="28" style="opacity:.3;margin-bottom:8px;"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><div>未找到关于 “<b>' + esc(query) + '</b>” 的相关文章</div></div>';
    return;
  }

  let html = searchMatches.map((p, idx) => renderSearchItem(p, idx, query)).join("");
  if (isAuthQuery) {
    html = '<div class="sm-item" id="sm-auth-action" style="cursor:pointer;border-left:3px solid var(--accent);background:rgba(230,0,0,0.06);padding:14px;margin-bottom:8px;">' +
      '<div class="sm-item-head"><span class="sm-item-title" style="color:var(--accent);font-weight:700;">受信任设备授权 (解锁管理入口)</span></div>' +
      '<div class="sm-item-snippet" style="color:var(--text);margin-top:4px;">输入管理员密码或配对凭证，永久为当前设备开启导航栏后台管理入口。</div>' +
      '</div>' + html;
  }
  resultsBox.innerHTML = html;
  const actionEl = document.getElementById("sm-auth-action");
  if (actionEl) {
    actionEl.addEventListener("click", () => {
      closeSearchModal();
      openDeviceAuthModal();
    });
  }
  bindSearchItemClicks();
  updateSearchActive();
}

function renderSearchItem(p, idx, query) {
  const cat = (p.categories && p.categories[0]) || "";
  const snippet = getSnippet(p.body || p.desc, query, 110);
  const activeCls = idx === searchActiveIdx ? " active" : "";
  return '<button class="sm-item' + activeCls + '" data-sidx="' + idx + '">' +
    '<div class="sm-item-head">' +
      '<span class="sm-item-title">' + highlightText(p.title, query) + '</span>' +
      '<span class="sm-item-date">' + esc(p.date || "") + '</span>' +
    '</div>' +
    '<div class="sm-item-snippet">' + highlightText(snippet, query) + '</div>' +
    (cat ? '<div class="sm-item-meta"><span class="sm-item-cat">' + esc(cat) + '</span></div>' : '') +
  '</button>';
}

function bindSearchItemClicks() {
  $$("#sm-results .sm-item").forEach(b => {
    b.addEventListener("click", () => {
      const idx = Number(b.dataset.sidx);
      const post = searchMatches[idx];
      if (post) {
        const postIdx = state.posts.indexOf(post);
        if (postIdx >= 0) selectArticle(postIdx);
      }
      closeSearchModal();
    });
    b.addEventListener("mouseenter", () => {
      searchActiveIdx = Number(b.dataset.sidx);
      updateSearchActive();
    });
  });
}

function updateSearchActive() {
  const items = $$("#sm-results .sm-item");
  items.forEach((item, i) => {
    const isAct = i === searchActiveIdx;
    item.classList.toggle("active", isAct);
    if (isAct) item.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
}

function fallbackCopy(text, cb) {
  const ta = document.createElement("textarea");
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); if (cb) cb(); } catch (e) { showToast("复制失败"); }
  document.body.removeChild(ta);
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
      const cur = WALLS.find(x => x.id === state.wall);
      showToast("壁纸已切换为「" + (cur ? cur.name : "纯色") + "」");
    }));
  }
}

/* 瑞士国际平面风格：平整稳定排版，废除 3D 摇晃与拟物物理 */
window.bindTilt = function() {};

/* ---------- 总渲染 ---------- */
function renderAll() {
  renderSide();
  renderHome();
  renderArchive();
  renderFriends();
  renderAbout();
}

/* ---------- 事件 ---------- */
document.getElementById("side-collapse").addEventListener("click", () => toggleSidebar(false));
document.getElementById("side-grip").addEventListener("click", () => toggleSidebar(true));
document.getElementById("scrim").addEventListener("click", () => toggleSidebar(false));
document.getElementById("tb-theme").addEventListener("click", toggleTheme);
document.getElementById("side-search").addEventListener("input", e => { state.q = e.target.value; renderSide(); });

const searchBtn = document.getElementById("tb-search");
if (searchBtn) searchBtn.addEventListener("click", openSearchModal);
const smBackdrop = document.getElementById("sm-backdrop");
if (smBackdrop) smBackdrop.addEventListener("click", closeSearchModal);
const smClear = document.getElementById("sm-clear");
if (smClear) smClear.addEventListener("click", () => {
  const input = document.getElementById("sm-input");
  if (input) { input.value = ""; input.focus(); runSearch(""); }
});
const smInput = document.getElementById("sm-input");
if (smInput) {
  smInput.addEventListener("input", e => runSearch(e.target.value.trim()));
}
const scArchive = document.getElementById("sc-archive");
if (scArchive) {
  scArchive.addEventListener("click", e => {
    e.preventDefault();
    showView("archive");
  });
}

$$("#tb-tabs button").forEach(b => b.addEventListener("click", () => {
  if (b.dataset.nav === "home") showView("home");
  else if (b.dataset.nav === "archive") showView("archive");
  else if (b.dataset.nav === "friends") showView("friends");
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
  const doFeedback = () => {
    btn.classList.add("copied");
    const orig = btn.innerHTML;
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="13" height="13" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg><span>已复制</span>';
    showToast("代码已复制到剪贴板");
    setTimeout(() => {
      btn.classList.remove("copied");
      btn.innerHTML = orig;
    }, 2000);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(code).then(doFeedback).catch(() => fallbackCopy(code, doFeedback));
  } else {
    fallbackCopy(code, doFeedback);
  }
});
document.addEventListener("keydown", e => {
  const modal = document.getElementById("search-modal");
  const isSearchOpen = modal && !modal.hasAttribute("hidden") && modal.classList.contains("open");

  if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    if (isSearchOpen) closeSearchModal(); else openSearchModal();
    return;
  }

  if ((e.key === "a" || e.key === "A") && (e.metaKey || e.ctrlKey) && e.shiftKey) {
    e.preventDefault();
    openDeviceAuthModal();
    return;
  }

  const authModal = document.getElementById("auth-modal");
  const isAuthOpen = authModal && !authModal.hasAttribute("hidden") && authModal.classList.contains("open");
  if (isAuthOpen && e.key === "Escape") {
    e.preventDefault();
    closeDeviceAuthModal();
    return;
  }

  if (isSearchOpen) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeSearchModal();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (searchMatches.length) {
        searchActiveIdx = (searchActiveIdx + 1) % searchMatches.length;
        updateSearchActive();
      }
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (searchMatches.length) {
        searchActiveIdx = (searchActiveIdx - 1 + searchMatches.length) % searchMatches.length;
        updateSearchActive();
      }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (searchActiveIdx >= 0 && searchMatches[searchActiveIdx]) {
        const post = searchMatches[searchActiveIdx];
        const postIdx = state.posts.indexOf(post);
        if (postIdx >= 0) selectArticle(postIdx);
        closeSearchModal();
      }
      return;
    }
  }

  if (e.key === "Escape") {
    // 图片灯箱优先关闭，再关侧栏
    const lb = document.getElementById("lightbox");
    if (lb && lb.classList.contains("on")) { closeLightbox(); return; }
    toggleSidebar(false);
    return;
  }
  if (e.key === "/" && !e.ctrlKey && !e.metaKey && !isSearchOpen) {
    const tag2 = (e.target && e.target.tagName) || "";
    if (tag2 !== "INPUT" && tag2 !== "TEXTAREA") {
      e.preventDefault();
      openSearchModal();
      return;
    }
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
  const hash = location.hash || "";
  const m = hash.match(/^#\/post\/(.+)$/);
  if (m) {
    const key = decodeURI(m[1]);
    const idx = state.posts.findIndex(p => p.slug === key || p.title === key);
    if (idx >= 0) selectArticle(idx); else showView("home");
  } else if (hash === "#/archive") {
    showView("archive");
  } else if (hash === "#/friends") {
    showView("friends");
  } else if (hash === "#/about") {
    showView("about");
  } else {
    if (state.nav !== "home") showView("home");
  }
});
function openFromHashIfAny() {
  const hash = location.hash || "";
  const m = hash.match(/^#\/post\/(.+)$/);
  if (m) {
    const key = decodeURI(m[1]);
    const idx = state.posts.findIndex(p => p.slug === key || p.title === key);
    if (idx >= 0) selectArticle(idx);
  } else if (hash === "#/archive") {
    showView("archive");
  } else if (hash === "#/friends") {
    showView("friends");
  } else if (hash === "#/about") {
    showView("about");
  }
}

/* 返回顶部 + 阅读进度 */
(function() {
  const btn = document.getElementById("back-top");
  const bar = document.getElementById("progress-bar");
  let show = false;
  window.addEventListener("scroll", () => {
    const s = window.scrollY > 300;
    if (s !== show) { show = s; if (btn) btn.classList.toggle("show", s); }
    const doc = document.documentElement;
    const max = doc.scrollHeight - window.innerHeight;
    if (bar) {
      if (max > 0 && document.body.classList.contains("reading")) {
        bar.style.width = Math.min(100, (window.scrollY / max) * 100).toFixed(2) + "%";
        bar.classList.add("show");
      } else {
        bar.classList.remove("show");
      }
    }
  }, { passive: true });
  if (btn) btn.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
})();

/* 瑞士顶栏保持稳固架构与全宽对齐，不使用滚动变悬浮胶囊动效 */

/* ---------- 互动点赞与二维码分享 ---------- */

async function fetchLikes(slug) {
  try {
    const res = await fetch("/api/posts/" + encodeURIComponent(slug) + "/likes");
    if (!res.ok) return;
    const d = await res.json();
    const el = document.getElementById("r-like-count");
    if (el) el.textContent = d.likes > 0 ? d.likes + " 赞" : "点赞";
  } catch (e) { /* 静默失败 */ }
}

async function submitLike(slug) {
  const btn = document.getElementById("r-like");
  const el = document.getElementById("r-like-count");
  if (!btn) return;
  btn.classList.add("liked");
  try {
    const res = await fetch("/api/posts/" + encodeURIComponent(slug) + "/like", { method: "POST" });
    if (!res.ok) { showToast("频率过快，请稍后"); return; }
    const d = await res.json();
    if (el) el.textContent = d.likes + " 赞";
    showToast("+1 感谢喜欢！");
  } catch (e) {
    showToast("网络连接失败");
  }
}

function showShareModal(p) {
  const modal = document.getElementById("qr-modal");
  if (!modal) return;
  const url = window.location.origin + articleUrl(p);
  const titleEl = document.getElementById("qr-post-title");
  if (titleEl) titleEl.textContent = p.title;
  const qrWrap = document.getElementById("qr-svg-wrap");
  if (qrWrap) qrWrap.innerHTML = generateQrSvg(url, 170);

  modal.removeAttribute("hidden");
  modal.classList.add("open");

  const closeBtn = document.getElementById("qr-modal-close");
  if (closeBtn) closeBtn.onclick = () => {
    modal.classList.remove("open");
    setTimeout(() => modal.setAttribute("hidden", ""), 220);
  };
  modal.onclick = e => {
    if (e.target === modal) {
      modal.classList.remove("open");
      setTimeout(() => modal.setAttribute("hidden", ""), 220);
    }
  };
  const copyBtn = document.getElementById("qr-copy-btn");
  if (copyBtn) copyBtn.onclick = () => {
    copyPageLink();
    modal.classList.remove("open");
    setTimeout(() => modal.setAttribute("hidden", ""), 220);
  };
}

/* 纯原生 JS 生成矢量 SVG 二维码（零外部依赖、零 CDN） */
function generateQrSvg(str, size) {
  size = size || 180;
  const PAD0 = 0xEC, PAD1 = 0x11;
  const EXP = new Array(256), LOG = new Array(256);
  for (let i = 0; i < 8; i++) EXP[i] = 1 << i;
  for (let i = 8; i < 256; i++) EXP[i] = EXP[i-4] ^ EXP[i-5] ^ EXP[i-6] ^ EXP[i-8];
  for (let i = 0; i < 255; i++) LOG[EXP[i]] = i;
  const glog = n => LOG[n];
  const gexp = n => EXP[(n % 255 + 255) % 255];

  function polyMul(p1, p2) {
    const num = new Array(p1.length + p2.length - 1).fill(0);
    for (let i = 0; i < p1.length; i++) {
      for (let j = 0; j < p2.length; j++) {
        num[i + j] ^= gexp(glog(p1[i]) + glog(p2[j]));
      }
    }
    return num;
  }
  function polyMod(p, ec) {
    let num = p.slice();
    while (num.length >= ec.length) {
      const leading = num[0];
      if (leading !== 0) {
        const factor = glog(leading);
        for (let i = 0; i < ec.length; i++) {
          num[i] ^= gexp(glog(ec[i]) + factor);
        }
      }
      num.shift();
    }
    return num;
  }
  function getEcPoly(ecCount) {
    let p = [1];
    for (let i = 0; i < ecCount; i++) p = polyMul(p, [1, gexp(i)]);
    return p;
  }

  const VERSIONS = [
    [1, 19, 7, 1, 21],
    [2, 34, 10, 1, 25],
    [3, 55, 15, 1, 29],
    [4, 80, 20, 1, 33],
    [5, 108, 26, 1, 37],
    [6, 136, 18, 2, 41],
    [7, 156, 20, 2, 45],
    [8, 194, 24, 2, 49],
    [9, 232, 30, 2, 53],
    [10, 274, 18, 4, 57]
  ];

  const utf8Bytes = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 128) utf8Bytes.push(c);
    else if (c < 2048) { utf8Bytes.push(192 | (c >> 6), 128 | (c & 63)); }
    else { utf8Bytes.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63)); }
  }

  let spec = null;
  for (let v of VERSIONS) {
    const headerBits = 4 + (v[0] < 10 ? 8 : 16);
    if (utf8Bytes.length + Math.ceil(headerBits / 8) <= v[1]) {
      spec = v;
      break;
    }
  }
  if (!spec) spec = VERSIONS[VERSIONS.length - 1];
  const [ver, totalData, ecBytes, blocks, modCount] = spec;

  let bits = [];
  function pushBits(val, len) {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  }

  pushBits(0b0100, 4);
  pushBits(utf8Bytes.length, ver < 10 ? 8 : 16);
  for (let b of utf8Bytes) pushBits(b, 8);

  const maxDataBits = totalData * 8;
  const termLen = Math.min(4, maxDataBits - bits.length);
  pushBits(0, termLen);
  while (bits.length % 8 !== 0) bits.push(0);

  const dataBytes = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    dataBytes.push(b);
  }

  let padIdx = 0;
  while (dataBytes.length < totalData) {
    dataBytes.push(padIdx % 2 === 0 ? PAD0 : PAD1);
    padIdx++;
  }

  const ecPoly = getEcPoly(ecBytes);
  const dataPerBlock = Math.floor(totalData / blocks);
  const blockDataList = [];
  const blockEcList = [];

  for (let b = 0; b < blocks; b++) {
    const start = b * dataPerBlock;
    const bData = dataBytes.slice(start, start + dataPerBlock);
    blockDataList.push(bData);
    const padded = bData.concat(new Array(ecBytes).fill(0));
    blockEcList.push(polyMod(padded, ecPoly));
  }

  const finalBytes = [];
  for (let i = 0; i < dataPerBlock; i++) {
    for (let b = 0; b < blocks; b++) finalBytes.push(blockDataList[b][i]);
  }
  for (let i = 0; i < ecBytes; i++) {
    for (let b = 0; b < blocks; b++) finalBytes.push(blockEcList[b][i]);
  }

  const matrix = Array.from({ length: modCount }, () => new Array(modCount).fill(null));
  const isFunction = Array.from({ length: modCount }, () => new Array(modCount).fill(false));

  function setModule(r, c, val) {
    matrix[r][c] = val;
    isFunction[r][c] = true;
  }

  function addFinder(top, left) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const mr = top + r, mc = left + c;
        if (mr < 0 || mr >= modCount || mc < 0 || mc >= modCount) continue;
        const val = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                    (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
                    (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        setModule(mr, mc, val ? 1 : 0);
      }
    }
  }
  addFinder(0, 0);
  addFinder(0, modCount - 7);
  addFinder(modCount - 7, 0);

  for (let i = 8; i < modCount - 8; i++) {
    if (!isFunction[6][i]) setModule(6, i, i % 2 === 0 ? 1 : 0);
    if (!isFunction[i][6]) setModule(i, 6, i % 2 === 0 ? 1 : 0);
  }

  setModule(modCount - 8, 8, 1);

  const ALIGNMENT_LOCS = [
    [], [], [6, 18], [6, 22], [6, 26], [6, 30],
    [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]
  ];
  const align = ALIGNMENT_LOCS[ver] || [];
  for (let r of align) {
    for (let c of align) {
      if (isFunction[r][c]) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          setModule(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1 ? 1 : 0);
        }
      }
    }
  }

  for (let i = 0; i < 9; i++) {
    if (!isFunction[8][i]) isFunction[8][i] = true;
    if (!isFunction[i][8]) isFunction[i][8] = true;
  }
  for (let i = 0; i < 8; i++) {
    if (!isFunction[8][modCount - 1 - i]) isFunction[8][modCount - 1 - i] = true;
    if (!isFunction[modCount - 1 - i][8]) isFunction[modCount - 1 - i] = true;
  }

  let byteIdx = 0, bitIdx = 7;
  let dir = -1;
  let row = modCount - 1, col = modCount - 1;

  while (col > 0) {
    if (col === 6) col--;
    for (let i = 0; i < modCount; i++) {
      const r = dir === -1 ? row - i : row + i;
      for (let c = col; c >= col - 1; c--) {
        if (!isFunction[r][c]) {
          let bit = 0;
          if (byteIdx < finalBytes.length) {
            bit = (finalBytes[byteIdx] >> bitIdx) & 1;
            bitIdx--;
            if (bitIdx < 0) { bitIdx = 7; byteIdx++; }
          }
          if ((r + c) % 2 === 0) bit ^= 1;
          matrix[r][c] = bit;
        }
      }
    }
    row = dir === -1 ? 0 : modCount - 1;
    dir = -dir;
    col -= 2;
  }

  const formatBits = [1,1,1,0,1,1,1,1,1,0,0,0,1,0,0];
  for (let i = 0; i < 6; i++) matrix[8][i] = formatBits[i];
  matrix[8][7] = formatBits[6];
  matrix[8][8] = formatBits[7];
  matrix[7][8] = formatBits[8];
  for (let i = 9; i < 15; i++) matrix[14 - i][8] = formatBits[i];

  for (let i = 0; i < 8; i++) matrix[modCount - 1 - i][8] = formatBits[i];
  for (let i = 8; i < 15; i++) matrix[8][modCount - 15 + i] = formatBits[i];

  let pathD = "";
  for (let r = 0; r < modCount; r++) {
    for (let c = 0; c < modCount; c++) {
      if (matrix[r][c] === 1) pathD += `M${c},${r}h1v1h-1z `;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ${modCount + 4} ${modCount + 4}" width="${size}" height="${size}" style="display:block;border-radius:8px"><rect x="-2" y="-2" width="${modCount + 4}" height="${modCount + 4}" fill="#ffffff"/><path d="${pathD}" fill="#0f172a"/></svg>`;
}

/* ---------- 可信设备远程后台检测与配对 ---------- */
async function initTrustedDeviceAuth() {
  const params = new URLSearchParams(window.location.search);
  const pairCode = params.get("pair") || params.get("auth");
  if (pairCode) {
    let devId = localStorage.getItem("jb_dev_id");
    if (!devId) {
      devId = Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map(b => b.toString(16).padStart(2, "0")).join("");
      localStorage.setItem("jb_dev_id", devId);
    }
    try {
      const res = await fetch("/api/auth/pair-device", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: pairCode.trim(),
          device_id: devId,
          name: /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ? "移动端受信任设备" : "桌面受信任设备"
        })
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        showToast("设备授权成功！已永久解锁后台管理入口");
        injectAdminNavButton();
        params.delete("pair");
        params.delete("auth");
        const newSearch = params.toString();
        const newUrl = window.location.pathname + (newSearch ? "?" + newSearch : "") + window.location.hash;
        history.replaceState(null, "", newUrl);
        return;
      } else {
        showToast(data.error || "配对失败或凭证已失效");
      }
    } catch (e) {
      showToast("连接配对服务失败");
    }
  }

  try {
    const res = await fetch("/api/auth/check");
    if (res.ok) {
      const data = await res.json();
      if (data.trusted) {
        injectAdminNavButton();
      }
    }
  } catch (e) { /* 未授权或离线保持静默 */ }
}

function openDeviceAuthModal() {
  const modal = document.getElementById("auth-modal");
  const input = document.getElementById("auth-input-key");
  const msg = document.getElementById("auth-status-msg");
  if (!modal) return;
  modal.removeAttribute("hidden");
  modal.classList.add("open");
  if (msg) { msg.hidden = true; msg.className = "am-msg"; msg.textContent = ""; }
  if (input) {
    input.value = "";
    setTimeout(() => input.focus(), 80);
  }
}

function closeDeviceAuthModal() {
  const modal = document.getElementById("auth-modal");
  if (!modal) return;
  modal.classList.remove("open");
  setTimeout(() => modal.setAttribute("hidden", ""), 180);
}

function initDeviceAuthModal() {
  const modal = document.getElementById("auth-modal");
  const backdrop = document.getElementById("auth-backdrop");
  const closeBtn = document.getElementById("auth-modal-close");
  const submitBtn = document.getElementById("auth-submit-btn");
  const input = document.getElementById("auth-input-key");
  const msg = document.getElementById("auth-status-msg");
  const footerBtn = document.getElementById("btn-device-auth");

  if (footerBtn) {
    footerBtn.addEventListener("click", e => {
      e.preventDefault();
      openDeviceAuthModal();
    });
  }
  if (backdrop) backdrop.addEventListener("click", closeDeviceAuthModal);
  if (closeBtn) closeBtn.addEventListener("click", closeDeviceAuthModal);

  async function doAuth() {
    const key = input ? input.value.trim() : "";
    if (!key) {
      if (msg) {
        msg.hidden = false;
        msg.className = "am-msg err";
        msg.textContent = "请输入管理员密码或配对凭证";
      }
      return;
    }
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "正在验证..."; }
    let devId = localStorage.getItem("jb_dev_id");
    if (!devId) {
      devId = Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map(b => b.toString(16).padStart(2, "0")).join("");
      localStorage.setItem("jb_dev_id", devId);
    }
    try {
      const res = await fetch("/api/auth/pair-device", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: key,
          device_id: devId,
          name: /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ? "移动端受信任设备" : "桌面受信任设备"
        })
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        if (msg) {
          msg.hidden = false;
          msg.className = "am-msg ok";
          msg.innerHTML = "验证成功！此设备已永久授权。<br><a href='/admin' style='color:var(--accent);font-weight:700;display:inline-block;margin-top:6px;text-decoration:underline;'>点击立即前往管理后台 &rarr;</a>";
        }
        injectAdminNavButton();
        showToast("设备授权成功！已永久解锁管理入口");
        if (input) input.value = "";
      } else {
        if (msg) {
          msg.hidden = false;
          msg.className = "am-msg err";
          msg.textContent = data.error || "验证失败，凭证不正确或已失效";
        }
      }
    } catch (e) {
      if (msg) {
        msg.hidden = false;
        msg.className = "am-msg err";
        msg.textContent = "请求失败，请检查网络或后端连接";
      }
    } finally {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "验证并绑定本设备"; }
    }
  }

  if (submitBtn) submitBtn.addEventListener("click", doAuth);
  if (input) {
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        e.preventDefault();
        doAuth();
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeDeviceAuthModal();
      }
    });
  }
}

function injectAdminNavButton() {
  if (document.getElementById("tb-btn-admin")) return;
  const nav = document.getElementById("tb-tabs");
  if (!nav) return;
  const btn = document.createElement("button");
  btn.id = "tb-btn-admin";
  btn.className = "tb-tab tb-admin-btn";
  btn.dataset.nav = "admin";
  btn.textContent = "后台";
  btn.title = "进入博客管理后台";
  btn.addEventListener("click", () => {
    window.location.href = "/admin";
  });
  nav.appendChild(btn);

  // 侧边栏抽屉导航如果已初始化也添加
  const sideScroll = document.getElementById("post-scroll");
  if (sideScroll && !document.getElementById("side-btn-admin")) {
    const sideDiv = document.createElement("div");
    sideDiv.id = "side-btn-admin";
    sideDiv.style.padding = "10px 14px 4px";
    sideDiv.innerHTML = '<button class="act-btn" style="width:100%;justify-content:center;background:var(--accent);border-color:var(--accent);color:#ffffff;font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" stroke-linecap="round" stroke-linejoin="round" style="margin-right:6px"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>管理后台</button>';
    sideDiv.querySelector("button").addEventListener("click", () => {
      window.location.href = "/admin";
    });
    const sideModes = document.getElementById("side-modes");
    if (sideModes && sideModes.parentNode) {
      sideModes.parentNode.insertBefore(sideDiv, sideModes);
    }
  }
}

/* ---------- 初始化 ---------- */
(function init() {
  applyTheme();
  applyWall();
  // 侧栏初始状态：
  //   窄屏 —— 收起（汉堡抽屉，点按钮展开）
  //   宽屏 —— 默认展开，除非用户之前手动收起过
  if (window.innerWidth < 1000) {
    toggleSidebar(false);
  } else {
    initSidebarDefault();
  }
  showView("home");
  loadPosts();
  initTrustedDeviceAuth();
  initDeviceAuthModal();
})();

