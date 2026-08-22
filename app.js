"use strict";

/* ============================================================
 * Jerry 的赛博博客 —— 桌面系统式静态博客 · 核心逻辑
 * 纯原生 JS，零外部依赖。数据来自 posts.json（blog_ctl build 生成）。
 * ============================================================ */

const $  = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
const esc = s => String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");

const SITE = { title: "Jerry 的赛博博客", desc: "记录赛博修仙日常", author: "Jerry", repo: "https://github.com/Jerry-Hang/Jerry-Hang.github.io" };

/* ---------- 壁纸 & 主题 ---------- */
const WALLPAPERS = [
  { id:"aurora", name:"晨光极光", css:"linear-gradient(135deg,#7ec8ff 0%,#a78bfa 50%,#f0abfc 100%)" },
  { id:"sunset", name:"暮色黄昏", css:"linear-gradient(135deg,#ff9a8b 0%,#ff6a88 40%,#8b5cf6 100%)" },
  { id:"forest", name:"深林晨雾", css:"linear-gradient(135deg,#43e97b 0%,#38b2ac 55%,#28527a 100%)" },
  { id:"midnight", name:"午夜星河", css:"linear-gradient(135deg,#0f2027 0%,#2c5364 50%,#1a1a40 100%)" },
  { id:"sakura", name:"樱花微雨", css:"linear-gradient(135deg,#ffdde1 0%,#ee9ca7 55%,#a18cd1 100%)" },
  { id:"ocean", name:"深海蓝调", css:"linear-gradient(135deg,#2b5876 0%,#4e4376 60%,#1b2a4a 100%)" }
];

const state = {
  theme: localStorage.getItem("jb_theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
  wall: localStorage.getItem("jb_wall") || "aurora",
  bootAnim: localStorage.getItem("jb_boot") !== "0",
  visited: localStorage.getItem("jb_visited") === "1",
  posts: [],
  winSeq: 0, activeZ: 100,
  windows: [],
  filters: { q: "", cat: "全部" }
};

function applyWall() {
  const w = WALLPAPERS.find(x => x.id === state.wall) || WALLPAPERS[0];
  document.getElementById("wallpaper").style.setProperty("--wall", w.css);
}
function applyTheme() {
  document.body.classList.toggle("dark", state.theme === "dark");
  document.getElementById("mb-theme").textContent = state.theme === "dark" ? "☀️" : "🌙";
  document.getElementById("tb-theme").textContent = state.theme === "dark" ? "☀️" : "🌙";
  localStorage.setItem("jb_theme", state.theme);
}
function toggleTheme() { state.theme = state.theme === "dark" ? "light" : "dark"; applyTheme(); }

/* ---------- 时钟 ---------- */
function nowParts() {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return {
    t: p(d.getHours()) + ":" + p(d.getMinutes()),
    date: d.toLocaleDateString("zh-CN", { year:"numeric", month:"long", day:"numeric", weekday:"long" }),
    short: d.toLocaleDateString("zh-CN", { month:"2-digit", day:"2-digit", weekday:"short" })
  };
}
function tickClock() {
  const n = nowParts();
  document.getElementById("mb-clock").textContent = n.t;
  document.getElementById("tb-time").textContent = n.t;
  document.getElementById("tb-date").textContent = n.short;
  document.getElementById("ls-time").textContent = n.t;
  document.getElementById("ls-date").textContent = n.date;
}
setInterval(tickClock, 1000);

/* ---------- Markdown 渲染（轻量自包含） ---------- */
function mdInline(src) {
  let s = esc(src);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
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

/* ---------- 数据加载 ---------- */
async function loadPosts() {
  try {
    const res = await fetch("posts.json", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    state.posts = await res.json();
    if (!Array.isArray(state.posts)) state.posts = [];
  } catch (e) {
    console.warn("load posts.json failed:", e);
    state.posts = [];
  }
  buildDesktopIcons();
  buildStartMenu();
  renderTaskbar();
}
function getPosts() {
  const q = state.filters.q.trim().toLowerCase();
  const cat = state.filters.cat;
  let list = state.posts.slice();
  if (cat !== "全部") list = list.filter(p => (p.categories || []).includes(cat));
  if (q) list = list.filter(p =>
    (p.title || "").toLowerCase().includes(q) ||
    (p.tags || []).some(t => t.toLowerCase().includes(q)) ||
    (p.body || "").toLowerCase().includes(q)
  );
  return list;
}
function allCategories() {
  const s = new Set(["全部"]);
  state.posts.forEach(p => (p.categories || []).forEach(c => s.add(c)));
  return Array.from(s);
}
function allTags() { const s = new Set(); state.posts.forEach(p => (p.tags || []).forEach(t => s.add(t))); return Array.from(s); }

/* ---------- 窗口系统 ---------- */
function createWindow(opts) {
  const id = "win-" + (++state.winSeq);
  const win = document.createElement("div");
  win.className = "window";
  win.dataset.id = id;
  win.style.left = opts.x + "px";
  win.style.top = opts.y + "px";
  win.style.width = opts.width + "px";
  win.style.height = opts.height + "px";
  win.innerHTML =
    '<div class="win-titlebar">' +
      '<div class="win-dots">' +
        '<div class="win-dot close" data-act="close" title="关闭"></div>' +
        '<div class="win-dot min" data-act="min" title="最小化"></div>' +
        '<div class="win-dot max" data-act="max" title="最大化"></div>' +
      '</div>' +
      '<div class="win-title">' + esc(opts.title) + '</div>' +
      '<div class="win-actions">' +
        '<button class="win-btn" data-act="min" title="最小化">─</button>' +
        '<button class="win-btn" data-act="max" title="最大化">□</button>' +
        '<button class="win-btn" data-act="close" title="关闭">✕</button>' +
      '</div>' +
    '</div>' +
    '<div class="win-body"></div>';
  document.getElementById("windows-layer").appendChild(win);

  const rec = { id: id, el: win, title: opts.title, icon: opts.icon || "📄", minimized: false, maximized: false, onClose: opts.onClose };
  state.windows.push(rec);

  if (opts.content) {
    if (typeof opts.content === "string") win.querySelector(".win-body").innerHTML = opts.content;
    else opts.content(win.querySelector(".win-body"), win);
  }

  win.addEventListener("pointerdown", () => focusWindow(rec), true);

  win.querySelectorAll("[data-act]").forEach(btn => {
    btn.addEventListener("pointerdown", e => e.stopPropagation());
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const act = btn.dataset.act;
      if (act === "close") closeWindow(rec);
      else if (act === "min") minimizeWindow(rec);
      else if (act === "max") toggleMaximize(rec);
    });
  });

  const bar = win.querySelector(".win-titlebar");
  bar.addEventListener("pointerdown", e => {
    if (e.target.closest("[data-act]")) return;
    if (rec.maximized) return;
    if (window.innerWidth <= 720) return;
    const rect = win.getBoundingClientRect();
    const dx = e.clientX - rect.left, dy = e.clientY - rect.top;
    bar.classList.add("dragging");
    const move = ev => {
      let nx = Math.min(Math.max(ev.clientX - dx, -rect.width + 120), window.innerWidth - 120);
      let ny = Math.min(Math.max(ev.clientY - dy, 0), window.innerHeight - 40);
      win.style.left = nx + "px"; win.style.top = ny + "px";
    };
    const up = () => { bar.classList.remove("dragging"); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });

  focusWindow(rec);
  renderTaskbar();
  return rec;
}
function focusWindow(rec) {
  rec.el.classList.remove("inactive");
  state.windows.forEach(w => { if (w !== rec) w.el.classList.add("inactive"); });
  state.activeZ += 10;
  rec.el.style.zIndex = state.activeZ;
  renderTaskbar();
}
function closeWindow(rec) {
  if (rec.onClose) { try { rec.onClose(); } catch (e) { console.warn(e); } }
  rec.el.remove();
  state.windows = state.windows.filter(w => w !== rec);
  renderTaskbar();
}
function minimizeWindow(rec) {
  rec.minimized = true;
  rec.el.classList.add("minimized");
  renderTaskbar();
}
function toggleMaximize(rec) {
  rec.maximized = !rec.maximized;
  rec.el.classList.toggle("maximized", rec.maximized);
  if (rec.maximized) rec.el.classList.remove("minimized");
  renderTaskbar();
}
function restoreWindow(rec) {
  rec.minimized = false;
  rec.el.classList.remove("minimized");
  focusWindow(rec);
}

/* ---------- 任务栏同步 ---------- */
function renderTaskbar() {
  const c = document.getElementById("tb-center");
  c.innerHTML = "";
  state.windows.forEach(rec => {
    const b = document.createElement("button");
    b.className = "tb-btn" + (rec.minimized ? "" : " on");
    b.innerHTML = '<span>' + rec.icon + '</span><span class="label" style="font-size:11.5px;font-weight:600;max-width:52px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(rec.title) + '</span><span class="dot"></span>';
    b.title = rec.title;
    b.addEventListener("click", () => {
      if (rec.minimized) restoreWindow(rec);
      else if (rec.el.classList.contains("inactive")) focusWindow(rec);
      else minimizeWindow(rec);
    });
    c.appendChild(b);
  });
}

/* ---------- 应用注册 ---------- */
const APPS = {
  articles: { name: "文章", icon: "📚", desc: "浏览全部博客文章", open: () => openArticles() },
  about:    { name: "关于", icon: "ℹ️", desc: "关于本站", open: () => openAbout() },
  settings: { name: "设置", icon: "⚙️", desc: "个性化你的桌面", open: () => openSettings() },
  github:   { name: "GitHub", icon: "🐙", desc: "查看源码", open: () => { window.open(SITE.repo, "_blank"); } },
  refresh:  { name: "刷新", icon: "🔄", desc: "重新拉取文章数据", open: () => { toast("正在刷新文章数据…"); loadPosts().then(() => toast("已刷新 ✨")); } },
  stats:    { name: "统计", icon: "📊", desc: "站点数据一览", open: () => openStats() }
};

function openArticles(query) {
  if (query != null) state.filters.q = query;
  return createWindow({
    title: "文章 · 全部", icon: "📚", width: 640, height: 480,
    x: Math.max(16, (window.innerWidth - 640) / 2 - 40),
    y: Math.max(40, (window.innerHeight - 480) / 2 - 20),
    content: (body) => renderArticlesWindow(body)
  });
}
function renderArticlesWindow(body) {
  const cats = allCategories();
  body.innerHTML =
    '<div class="art-toolbar">' +
      '<div class="art-search-row"><input class="art-search" id="a-q" type="text" placeholder="🔍 搜索标题 / 标签 / 正文…" value="' + esc(state.filters.q) + '"></div>' +
      '<div class="chips" id="a-chips">' +
        cats.map(c => '<button class="chip' + (c === state.filters.cat ? " on" : "") + '" data-cat="' + esc(c) + '">' + esc(c) + '</button>').join("") +
      '</div>' +
    '</div>' +
    '<div class="art-list art-scroll" id="a-list"></div>';
  const listEl = body.querySelector("#a-list");
  const renderList = () => {
    const ps = getPosts();
    if (!ps.length) {
      listEl.innerHTML = '<div class="empty">' + (state.posts.length ? "没有匹配的文章 😶‍🌫️" : "还没有文章 —— 运行 blog_ctl new 「标题」 写下第一篇吧 ✍️") + '</div>';
      return;
    }
    listEl.innerHTML = ps.map(p => {
      const tags = (p.tags || []).map((t, i) => '<span class="tag' + (i % 2 ? " alt" : "") + '">' + esc(t) + '</span>').join("");
      const catsHtml = (p.categories || []).map(c => '<span class="cat">' + esc(c) + '</span>').join("");
      return '<button class="art-card" data-idx="' + state.posts.indexOf(p) + '">' +
        '<div class="row1"><span class="t">' + esc(p.title) + '</span><span class="d">' + esc(p.date) + '</span></div>' +
        (p.desc ? '<div class="ex">' + esc(p.desc) + '</div>' : "") +
        '<div class="meta">' + catsHtml + tags + '</div>' +
      '</button>';
    }).join("");
  };
  renderList();

  body.querySelector("#a-q").addEventListener("input", e => {
    state.filters.q = e.target.value; renderList();
  });
  body.querySelector("#a-chips").addEventListener("click", e => {
    const btn = e.target.closest(".chip");
    if (!btn) return;
    state.filters.cat = btn.dataset.cat;
    body.querySelectorAll(".chip").forEach(c => c.classList.toggle("on", c === btn));
    renderList();
  });
  listEl.addEventListener("click", e => {
    const card = e.target.closest(".art-card");
    if (!card) return;
    openReader(Number(card.dataset.idx));
  });
}

function openReader(idx) {
  const p = state.posts[idx];
  if (!p) return;
  const pos = state.posts.indexOf(p);
  const prev = state.posts.slice(0, pos).reverse()[0];
  const next = state.posts.slice(pos + 1)[0];
  createWindow({
    title: p.title, icon: "📖", width: 680, height: 560,
    x: Math.max(20, (window.innerWidth - 680) / 2 + 24),
    y: Math.max(36, (window.innerHeight - 560) / 2),
    content: (body) => {
      const tags = (p.tags || []).map((t, i) => '<span class="tag' + (i % 2 ? " alt" : "") + '">' + esc(t) + '</span>').join("");
      body.innerHTML =
        '<div class="reader-head">' +
          '<div class="reader-nav"><button class="back" id="r-back">← 返回列表</button><span class="sub">' + esc(p.date) + ' · ' + esc((p.categories || []).join(" / ")) + '</span></div>' +
          '<h1>' + esc(p.title) + '</h1>' +
          '<div class="sub">✍️ ' + esc(SITE.author) + ' · ' + tags + '</div>' +
        '</div>' +
        '<div class="md-body">' + mdToHtml(p.body) + '</div>' +
        '<div class="reader-foot">' +
          '<button class="pn-btn' + (prev ? "" : " disabled") + '" id="r-prev">⬆ ' + (prev ? esc(prev.title) : "已是第一篇") + '</button>' +
          '<button class="pn-btn' + (next ? "" : " disabled") + '" id="r-next">' + (next ? esc(next.title) : "已是最后一篇") + ' ⬇</button>' +
        '</div>';
      body.querySelector("#r-back").addEventListener("click", () => openListFromReader());
      const pv = body.querySelector("#r-prev"), nx = body.querySelector("#r-next");
      if (prev) pv.addEventListener("click", () => openReader(state.posts.indexOf(prev)));
      if (next) nx.addEventListener("click", () => openReader(state.posts.indexOf(next)));
    }
  });
}
function openListFromReader() {
  createWindow({
    title: "文章 · 全部", icon: "📚", width: 640, height: 480,
    x: Math.max(16, (window.innerWidth - 640) / 2 - 40),
    y: Math.max(40, (window.innerHeight - 480) / 2 - 20),
    content: (body) => renderArticlesWindow(body)
  });
}

function openAbout() {
  createWindow({
    title: "关于", icon: "ℹ️", width: 480, height: 480,
    x: Math.max(20, (window.innerWidth - 480) / 2),
    y: Math.max(40, (window.innerHeight - 480) / 2),
    content: body => {
      body.innerHTML =
        '<div class="about-hero">' +
          '<div class="about-avatar">J</div>' +
          '<div><h2>' + esc(SITE.title) + '</h2><div class="sub">' + esc(SITE.desc) + '</div></div>' +
        '</div>' +
        '<div class="stat-grid" id="about-stats"></div>' +
        '<div class="sect"><h3>技术栈</h3>' +
          '<div class="link-row">' +
            '<span class="link-btn">📄 原生 HTML / CSS / JS</span>' +
            '<span class="link-btn">🦀 Rust · blog_ctl</span>' +
            '<span class="link-btn">👨‍💻 GitHub Pages</span>' +
          '</div>' +
        '</div>' +
        '<div class="sect"><h3>链接</h3>' +
          '<div class="link-row">' +
            '<a class="link-btn" href="' + SITE.repo + '" target="_blank" rel="noopener">🐙 仓库源码</a>' +
            '<a class="link-btn" href="mailto:jerry@example.com">✉️ 联系我</a>' +
          '</div>' +
        '</div>' +
        '<p style="margin-top:18px;font-size:12px;color:var(--text-faint);text-align:center">© ' + new Date().getFullYear() + ' ' + esc(SITE.author) + ' · 赛博修仙，从记录开始</p>';
      const stats = body.querySelector(".stat-grid");
      if (stats) {
        const tags = allTags().length;
        const cats = allCategories().length - 1;
        const latest = state.posts.length ? state.posts[0].date : "—";
        stats.innerHTML =
          '<div class="stat"><b>' + state.posts.length + '</b><span>文章</span></div>' +
          '<div class="stat"><b>' + cats + '</b><span>分类</span></div>' +
          '<div class="stat"><b>' + tags + '</b><span>标签</span></div>' +
          '<div class="stat"><b>' + latest + '</b><span>最近更新</span></div>';
      }
    }
  });
}

function openStats() { openAbout(); }

function openSettings() {
  createWindow({
    title: "设置", icon: "⚙️", width: 480, height: 520,
    x: Math.max(20, (window.innerWidth - 480) / 2),
    y: Math.max(36, (window.innerHeight - 520) / 2),
    content: body => {
      body.innerHTML =
        '<div class="setting-row"><div><div class="st-name">壁纸</div><div class="st-desc">选择你的桌面背景</div></div></div>' +
        '<div class="swatches" style="margin:-2px 0 14px 4px">' +
          WALLPAPERS.map(w => '<button class="swatch' + (w.id === state.wall ? " on" : "") + '" data-w="' + w.id + '" style="background:' + w.css + '" title="' + esc(w.name) + '"></button>').join("") +
        '</div>' +
        '<div class="setting-row">' +
          '<div><div class="st-name">外观</div><div class="st-desc">亮色 / 暗色模式</div></div>' +
          '<div class="seg" id="set-theme">' +
            '<button data-t="light" class="' + (state.theme === "light" ? "on" : "") + '">☀️ 亮色</button>' +
            '<button data-t="dark" class="' + (state.theme === "dark" ? "on" : "") + '">🌙 暗色</button>' +
          '</div>' +
        '</div>' +
        '<div class="setting-row">' +
          '<div><div class="st-name">开机动画</div><div class="st-desc">解锁桌面时播放启动画面</div></div>' +
          '<button class="switch' + (state.bootAnim ? " on" : "") + '" id="set-boot" aria-label="开机动画"></button>' +
        '</div>' +
        '<div class="setting-row">' +
          '<div><div class="st-name">开机锁屏</div><div class="st-desc">下次访问时重新显示锁屏</div></div>' +
          '<button class="switch" id="set-lock" aria-label="锁屏"></button>' +
        '</div>' +
        '<p style="margin-top:14px;font-size:11.5px;color:var(--text-faint);text-align:center">所有设置保存在本地浏览器（localStorage）</p>';
      body.querySelectorAll(".swatch").forEach(s => s.addEventListener("click", () => {
        state.wall = s.dataset.w;
        localStorage.setItem("jb_wall", state.wall);
        body.querySelectorAll(".swatch").forEach(x => x.classList.toggle("on", x === s));
        applyWall();
      }));
      body.querySelectorAll("#set-theme button").forEach(b => b.addEventListener("click", () => {
        state.theme = b.dataset.t; applyTheme();
        body.querySelectorAll("#set-theme button").forEach(x => x.classList.toggle("on", x === b));
      }));
      body.querySelector("#set-boot").addEventListener("click", e => {
        state.bootAnim = !state.bootAnim;
        localStorage.setItem("jb_boot", state.bootAnim ? "1" : "0");
        e.currentTarget.classList.toggle("on", state.bootAnim);
      });
      body.querySelector("#set-lock").addEventListener("click", () => {
        localStorage.setItem("jb_visited", "0");
        toast("下次访问将显示锁屏 ✨");
      });
    }
  });
}

/* ---------- 桌面图标 & 开始菜单 ---------- */
const SHORTCUTS = [
  { id:"articles", name:"文章", glyph:"📚", bg:"linear-gradient(135deg,#0078ff,#00c6ff)" },
  { id:"about", name:"关于", glyph:"ℹ️", bg:"linear-gradient(135deg,#8b5cf6,#ec4899)" },
  { id:"settings", name:"设置", glyph:"⚙️", bg:"linear-gradient(135deg,#64748b,#94a3b8)" },
  { id:"github", name:"GitHub", glyph:"🐙", bg:"linear-gradient(135deg,#334155,#64748b)" },
  { id:"refresh", name:"刷新", glyph:"🔄", bg:"linear-gradient(135deg,#10b981,#34d399)" }
];
function buildDesktopIcons() {
  const c = document.getElementById("desktop-icons");
  c.innerHTML = SHORTCUTS.map(s =>
    '<button class="dicon" data-app="' + s.id + '">' +
      '<span class="glyph" style="background:' + s.bg + '">' + s.glyph + '</span>' +
      '<span class="lbl">' + esc(s.name) + '</span>' +
    '</button>').join("");
  c.querySelectorAll(".dicon").forEach(b => b.addEventListener("click", () => {
    const app = APPS[b.dataset.app];
    if (app) app.open();
  }));
  c.querySelectorAll(".dicon").forEach(b => b.addEventListener("contextmenu", e => {
    e.preventDefault();
    openContextMenu(e, [{ label: "打开", cb: () => APPS[b.dataset.app].open() }]);
  }));
}
function buildStartMenu() {
  const grid = document.getElementById("sm-grid");
  grid.innerHTML = Object.entries(APPS).map(([id, a]) =>
    '<button class="sm-app" data-app="' + id + '">' +
      '<span class="a-glyph">' + a.icon + '</span>' +
      '<span class="a-name">' + esc(a.name) + '</span>' +
    '</button>').join("");
  grid.querySelectorAll(".sm-app").forEach(b => b.addEventListener("click", () => {
    closeStartMenu();
    const app = APPS[b.dataset.app];
    if (app) app.open();
  }));
}

/* ---------- 开始菜单控制 ---------- */
function toggleStartMenu(force) {
  const m = document.getElementById("start-menu");
  const open = typeof force === "boolean" ? force : !m.classList.contains("open");
  m.classList.toggle("open", open);
  if (open) { const i = document.getElementById("sm-search"); setTimeout(() => i && i.focus(), 60); }
}
function closeStartMenu() { document.getElementById("start-menu").classList.remove("open"); }

/* ---------- 搜索 ---------- */
function doSearch(q) {
  state.filters.q = q;
  openArticles(state.filters.q);
}

/* ---------- Toast ---------- */
let toastTimer = null;
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2300);
}

/* ---------- 右键菜单 ---------- */
function openContextMenu(e, items) {
  const m = document.getElementById("context-menu");
  m.innerHTML = items.map((it, i) => it.sep ? '<div class="sep"></div>' : '<button data-i="' + i + '">' + it.label + '</button>').join("");
  m.querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
    closeContextMenu();
    items[Number(b.dataset.i)].cb();
  }));
  m.classList.add("open");
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(e.clientX, window.innerWidth - r.width - 8) + "px";
  m.style.top = Math.min(e.clientY, window.innerHeight - r.height - 8) + "px";
}
function closeContextMenu() { document.getElementById("context-menu").classList.remove("open"); }

/* ---------- 启动流程 ---------- */
function enterDesktop() {
  document.getElementById("lockscreen").classList.add("hide");
  document.getElementById("boot-screen").classList.remove("show");
  localStorage.setItem("jb_visited", "1");
}
function unlock() {
  if (state.bootAnim) {
    document.getElementById("lockscreen").classList.add("hide");
    document.getElementById("boot-screen").classList.add("show");
    const phases = ["正在初始化桌面环境…", "正在加载文章数据…", "正在点亮赛博世界…"];
    let i = 0;
    const t = setInterval(() => {
      i++;
      const b = document.getElementById("boot-text");
      if (b && phases[i]) b.textContent = phases[i];
      if (i >= phases.length) { clearInterval(t); enterDesktop(); }
    }, 750);
  } else {
    enterDesktop();
  }
}

/* ---------- 全局事件 ---------- */
window.addEventListener("contextmenu", e => e.preventDefault());
document.addEventListener("click", e => {
  if (!e.target.closest("#start-menu") && !e.target.closest("#tb-start")) closeStartMenu();
  if (!e.target.closest("#context-menu")) closeContextMenu();
  if (!e.target.closest(".dropdown") && !e.target.closest("[data-menu]")) closeDropdown();
});
document.getElementById("desktop").addEventListener("contextmenu", e => {
  if (e.target.closest(".window")) return;
  e.preventDefault();
  openContextMenu(e, [
    { label: "🔄 刷新数据", cb: () => { toast("正在刷新文章数据…"); loadPosts().then(() => toast("已刷新 ✨")); } },
    { label: state.theme === "dark" ? "☀️ 切换亮色模式" : "🌙 切换暗色模式", cb: toggleTheme },
    { label: "🎨 更换壁纸", cb: () => { const idx = WALLPAPERS.findIndex(w => w.id === state.wall); state.wall = WALLPAPERS[(idx + 1) % WALLPAPERS.length].id; localStorage.setItem("jb_wall", state.wall); applyWall(); toast("已更换壁纸 ✨"); } },
    { sep: true },
    { label: "ℹ️ 关于本站", cb: openAbout }
  ]);
});
document.getElementById("tb-start").addEventListener("click", e => { e.stopPropagation(); toggleStartMenu(); });
document.getElementById("sm-power").addEventListener("click", () => { closeStartMenu(); toast("重启中…"); setTimeout(() => { location.reload(); }, 600); });
document.getElementById("mb-theme").addEventListener("click", toggleTheme);
document.getElementById("tb-theme").addEventListener("click", toggleTheme);
document.getElementById("tb-search").addEventListener("click", () => { doSearch(document.getElementById("mb-search").value); });
document.getElementById("mb-search").addEventListener("keydown", e => { if (e.key === "Enter") doSearch(e.target.value); });
document.getElementById("sm-search").addEventListener("keydown", e => { if (e.key === "Enter") { doSearch(e.target.value); closeStartMenu(); } });
document.getElementById("lockscreen").addEventListener("click", unlock);
document.addEventListener("keydown", e => {
  if (e.key === "Escape") { closeStartMenu(); closeContextMenu(); closeDropdown(); }
  if (e.key === "F2") { openArticles(); }
});

/* ---------- 菜单栏下拉 ---------- */
function closeDropdown() { $$(".dropdown").forEach(d => d.remove()); $$("[data-menu]").forEach(b => b.classList.remove("open")); }
function openMenuBarDropdown(btn, items) {
  closeDropdown();
  btn.classList.add("open");
  const dd = document.createElement("div");
  dd.className = "dropdown";
  dd.style.left = btn.getBoundingClientRect().left + "px";
  dd.innerHTML = items.map((it, i) => it.sep ? '<div class="dd-sep"></div>' : '<button data-i="' + i + '"><span>' + it.label + '</span>' + (it.key ? '<span class="dd-key">' + it.key + '</span>' : "") + '</button>').join("");
  document.body.appendChild(dd);
  dd.querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
    items[Number(b.dataset.i)].cb();
    closeDropdown();
  }));
}
$$("[data-menu]").forEach(btn => {
  btn.addEventListener("click", e => {
    e.stopPropagation();
    const items = [
      { label: "📚 全部文章", key: "F2", cb: () => openArticles() },
      { label: "🔄 刷新数据", cb: () => { toast("正在刷新文章数据…"); loadPosts().then(() => toast("已刷新 ✨")); } },
      { sep: true },
      { label: "ℹ️ 关于本站", cb: openAbout },
      { label: "⚙️ 设置", cb: openSettings },
      { sep: true },
      { label: state.theme === "dark" ? "☀️ 切换亮色模式" : "🌙 切换暗色模式", cb: toggleTheme }
    ];
    openMenuBarDropdown(btn, items);
  });
});
document.getElementById("menu-logo").addEventListener("click", e => { e.stopPropagation(); toggleStartMenu(); });

/* ---------- 初始化 ---------- */
(function init() {
  applyTheme();
  applyWall();
  tickClock();
  loadPosts();

  if (!state.visited) {
    document.getElementById("lockscreen").style.display = "flex";
  } else {
    document.getElementById("lockscreen").style.display = "none";
  }
  const updateBatt = () => {
    const pct = 50;
    const f = document.getElementById("batt-fill"), f2 = document.getElementById("batt-fill2");
    if (f) f.style.width = (pct / 100 * 18) + "px";
    if (f2) f2.style.width = (pct / 100 * 18) + "px";
    const col = pct > 40 ? "#28c840" : pct > 15 ? "#febc2e" : "#ff5f57";
    if (f) f.setAttribute("fill", col);
    if (f2) f2.setAttribute("fill", col);
  };
  updateBatt();
})();
