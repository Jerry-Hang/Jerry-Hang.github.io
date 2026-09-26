/* ==========================================================================
   后台管理界面脚本
   ==========================================================================
   约定：
     · 所有 DOM 文本一律走 esc() 或 textContent，避免 XSS
     · 图表用 Canvas 2D 手绘，无第三方依赖，按 devicePixelRatio 缩放保证清晰
     · 视图切换用 URL hash，刷新后停在同一个标签页
   ========================================================================== */

(function () {
  'use strict';

  /* ------------------------------------------------------------ 工具 */

  const $ = (id) => document.getElementById(id);

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** 去掉骨架屏占位 */
  function setVal(el, text) {
    if (el) el.textContent = text;
  }

  async function api(path, opts) {
    const r = await fetch(path, opts);
    if (r.status === 401) {
      // 会话过期，回登录页
      location.replace('/login');
      throw new Error('unauthorized');
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  /** 把秒数格式化成 3d 4h / 5h 12m / 43s */
  function humanDuration(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d > 0) return d + '天 ' + h + '小时';
    if (h > 0) return h + '小时 ' + m + '分';
    if (m > 0) return m + '分 ' + (sec % 60) + '秒';
    return sec + '秒';
  }

  function humanBytes(n) {
    n = Number(n) || 0;
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + ' ' + u[i];
  }

  /* ------------------------------------------------------------ 提示条 */

  let msgTimer = null;
  function flash(text, kind) {
    const el = $('msg');
    if (!el) return;
    el.className = 'notice ' + (kind || 'ok');
    el.textContent = text;
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => { el.className = 'notice'; el.textContent = ''; }, 3200);
  }

  /* ------------------------------------------------------------ 悬浮提示 */

  const tip = $('tip');
  function showTip(text, ev) {
    if (!tip) return;
    tip.textContent = text;
    tip.style.left = ev.clientX + 'px';
    tip.style.top = ev.clientY + 'px';
    tip.style.opacity = '1';
  }
  function hideTip() {
    if (tip) tip.style.opacity = '0';
  }

  /* ------------------------------------------------------------ 图表 */

  const charts = {};

  /**
   * 准备画布：按 devicePixelRatio 放大，逻辑坐标用 CSS 像素。
   * 返回 { ctx, w, h }。
   */
  function prepCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(120, Math.floor(rect.width));
    const h = Math.max(80, Math.floor(rect.height || canvas.height || 180));
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  /**
   * 折线图（带渐变填充 + 悬停高亮）
   * data: [{ label, v }]
   */
  function drawLine(canvas, data, color) {
    if (!canvas) return;
    const { ctx, w, h } = prepCanvas(canvas);
    const padL = 8, padR = 8, padT = 12, padB = 20;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    const fg3 = cssVar('--fg-3', 'rgba(60,60,67,.3)');
    const fg2 = cssVar('--fg-2', 'rgba(60,60,67,.6)');
    const sep = cssVar('--sep', 'rgba(60,60,67,.13)');
    color = color || cssVar('--blue', '#007aff');

    data = (data || []).filter(d => d && typeof d.v === 'number');

    if (!data.length) {
      ctx.fillStyle = fg3;
      ctx.font = '13px ' + cssVar('--font', 'sans-serif');
      ctx.textAlign = 'center';
      ctx.fillText('暂无数据', w / 2, h / 2);
      canvas._pts = [];
      return;
    }

    const max = Math.max(1, ...data.map(d => d.v));
    const n = data.length;
    const stepX = n > 1 ? plotW / (n - 1) : 0;
    const xOf = i => padL + (n > 1 ? i * stepX : plotW / 2);
    const yOf = v => padT + plotH - (v / max) * plotH;

    // 基线
    ctx.strokeStyle = sep;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT + plotH + .5);
    ctx.lineTo(w - padR, padT + plotH + .5);
    ctx.stroke();

    // 面积填充
    const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
    grad.addColorStop(0, hexA(color, .26));
    grad.addColorStop(1, hexA(color, 0));
    ctx.beginPath();
    ctx.moveTo(xOf(0), padT + plotH);
    for (let i = 0; i < n; i++) ctx.lineTo(xOf(i), yOf(data[i].v));
    ctx.lineTo(xOf(n - 1), padT + plotH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // 折线
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = xOf(i), y = yOf(data[i].v);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    // 单点时补一个圆
    if (n === 1) {
      ctx.beginPath();
      ctx.arc(xOf(0), yOf(data[0].v), 3.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }

    // x 轴首尾标签
    ctx.fillStyle = fg3;
    ctx.font = '10.5px ' + cssVar('--font', 'sans-serif');
    ctx.textAlign = 'left';
    ctx.fillText(String(data[0].label ?? ''), padL, h - 5);
    if (n > 1) {
      ctx.textAlign = 'right';
      ctx.fillText(String(data[n - 1].label ?? ''), w - padR, h - 5);
    }

    // 记录点位供悬停使用
    canvas._pts = data.map((d, i) => ({ x: xOf(i), y: yOf(d.v), label: d.label, v: d.v }));
    canvas._draw = () => drawLine(canvas, data, color);
  }

  /** 给颜色加透明度（支持 #rrggbb 和 rgb()） */
  function hexA(color, a) {
    color = String(color).trim();
    let m = /^#([0-9a-f]{6})$/i.exec(color);
    if (m) {
      const v = parseInt(m[1], 16);
      return 'rgba(' + ((v >> 16) & 255) + ',' + ((v >> 8) & 255) + ',' + (v & 255) + ',' + a + ')';
    }
    m = /^#([0-9a-f]{3})$/i.exec(color);
    if (m) {
      const s = m[1];
      return 'rgba(' + parseInt(s[0] + s[0], 16) + ',' + parseInt(s[1] + s[1], 16) + ',' + parseInt(s[2] + s[2], 16) + ',' + a + ')';
    }
    m = /^rgba?\(([^)]+)\)$/i.exec(color);
    if (m) {
      const p = m[1].split(',').map(x => x.trim());
      return 'rgba(' + p[0] + ',' + p[1] + ',' + p[2] + ',' + a + ')';
    }
    return color;
  }

  /** 水平条形图（用于分类统计，DOM 实现，便于 hover 提示） */
  function renderBars(container, items, colorOf) {
    if (!container) return;
    if (!items || !items.length) {
      container.innerHTML = '<div class="empty">暂无数据</div>';
      return;
    }
    const max = Math.max(1, ...items.map(x => x.count));
    container.innerHTML = items.map(x => {
      const pct = Math.max(2, (x.count / max) * 100);
      const cls = colorOf ? colorOf(x.category) : 'c-blue';
      return '<div class="bar-row" data-tip="' + esc(x.category) + '：' + x.count + ' 次">' +
               '<div class="bar-head"><span>' + esc(x.category) + '</span><b>' + x.count + '</b></div>' +
               '<div class="bar"><i class="' + cls + '" style="width:' + pct + '%"></i></div>' +
             '</div>';
    }).join('');

    container.querySelectorAll('.bar-row').forEach(row => {
      row.addEventListener('mousemove', e => showTip(row.dataset.tip, e));
      row.addEventListener('mouseleave', hideTip);
    });
  }

  const CAT_COLOR = {
    normal: 'c-blue',
    scan: 'c-orange',
    crawler: 'c-blue',
    blocked: 'c-red',
    bruteforce: 'c-red'
  };

  /* ------------------------------------------------------------ 数据加载 */

  let stats = null;
  let posts = [];

  async function loadStats() {
    try {
      const d = await api('/api/admin/stats');
      stats = d;

      const byCat = {};
      (d.categories || []).forEach(x => { byCat[x.category] = x.count; });

      setVal($('k-today'), d.today_total ?? 0);
      setVal($('k-scan'), byCat.scan || 0);
      setVal($('k-crawler'), byCat.crawler || 0);
      setVal($('k-blocked'), byCat.blocked || 0);
      setVal($('k-brute'), byCat.bruteforce || 0);

      // 分类条形图：概览页按总量，安全页按恶意类别
      const all = (d.categories || []).slice().sort((a, b) => b.count - a.count);
      renderBars($('bars'), all, c => CAT_COLOR[c] || 'c-blue');
      renderBars($('bars-sec'),
        all.filter(x => x.category !== 'normal'),
        c => CAT_COLOR[c] || 'c-blue');

      // 折线图
      const hourly = (d.hourly || []).map(x => ({ label: (x.h ?? '') + ':00', v: x.count ?? x.c ?? 0 }));
      const daily = (d.daily || []).map(x => ({ label: x.date ?? x.d ?? '', v: x.count ?? x.c ?? 0 }));
      drawLine($('c-hourly'), hourly, cssVar('--blue', '#007aff'));
      drawLine($('c-daily'), daily, cssVar('--purple', '#af52de'));
    } catch (e) {
      if (e.message !== 'unauthorized') console.warn('loadStats', e);
    }
  }

  async function loadSystem() {
    try {
      const d = await api('/api/admin/system');
      setVal($('k-cpu'), (d.cpu_percent ?? 0) + '%');
      setVal($('k-rss'), humanBytes((d.rss_kb ?? 0) * 1024));
      setVal($('k-db'), humanBytes(d.db_size_bytes ?? 0));
      setVal($('k-up'), humanDuration(d.uptime_secs ?? 0));
      setVal($('k-posts'), d.posts ?? 0);
      setVal($('k-sess'), d.session_count ?? 0);
      setVal($('k-gate'), (d.gate_active ?? 0) + ' / ' + (d.gate_limit ?? 0));
    } catch (e) {
      if (e.message !== 'unauthorized') console.warn('loadSystem', e);
    }
  }

  async function loadPosts() {
    try {
      posts = await api('/api/posts');
      const list = $('post-list');
      setVal($('post-count'), '(' + (posts || []).length + ')');

      if (!posts || !posts.length) {
        list.innerHTML = '<li><div class="empty">还没有文章</div></li>';
        return;
      }
      list.innerHTML = posts.map(p =>
        '<li>' +
          '<span class="title" title="' + esc(p.title) + '">' + esc(p.title) + '</span>' +
          '<span class="meta">' + esc((p.date || '').slice(0, 10)) + '</span>' +
          '<button class="btn small" data-edit="' + p.id + '">编辑</button>' +
          '<button class="btn small danger" data-del="' + p.id + '">删除</button>' +
        '</li>'
      ).join('');
    } catch (e) {
      if (e.message !== 'unauthorized') console.warn('loadPosts', e);
    }
  }

  /* ------------------------------------------------------------ 日志表格 */

  let logs = [];
  let sortKey = null;
  let sortDesc = true;

  async function loadLogs() {
    const cat = ($('f-cat') || {}).value ? $('f-cat').value.trim() : '';
    const ip = ($('f-ip') || {}).value ? $('f-ip').value.trim() : '';

    let url = '/api/admin/logs?per_page=200';
    if (cat) url += '&category=' + encodeURIComponent(cat);
    if (ip) url += '&ip=' + encodeURIComponent(ip);

    try {
      const d = await api(url);
      logs = d.logs || [];
      const total = d.total ?? logs.length;
      setVal($('log-summary'), '显示最近 ' + logs.length + ' 条，共 ' + total + ' 条记录' +
        (cat || ip ? '（已筛选）' : ''));
      renderLogs();
    } catch (e) {
      if (e.message !== 'unauthorized') flash('日志加载失败：' + e.message, 'err');
    }
  }

  function statusClass(code) {
    const n = Number(code) || 0;
    if (n >= 500) return 'code-5xx';
    if (n >= 400) return 'code-4xx';
    if (n >= 300) return 'code-3xx';
    if (n >= 200) return 'code-2xx';
    return '';
  }

  function renderLogs() {
    const body = $('log-body');
    let rows = logs.slice();

    if (sortKey) {
      const dir = sortDesc ? 1 : -1;
      rows.sort((a, b) => {
        const x = a[sortKey], y = b[sortKey];
        if (x === y) return 0;
        return (x < y ? -1 : 1) * dir;
      });
    }

    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="6"><div class="empty">没有匹配的记录</div></td></tr>';
    } else {
      body.innerHTML = rows.map(l =>
        '<tr>' +
          '<td class="mono">' + esc(l.timestamp) + '</td>' +
          '<td class="mono">' + esc(l.ip) + '</td>' +
          '<td>' + esc(l.method) + '</td>' +
          '<td class="mono" title="' + esc(l.path) + '">' + esc(l.path) + '</td>' +
          '<td class="' + statusClass(l.status_code) + '">' + esc(l.status_code) + '</td>' +
          '<td><span class="tag ' + esc(l.category) + '">' + esc(l.category) + '</span></td>' +
        '</tr>'
      ).join('');
    }

    document.querySelectorAll('#log-table th[data-sort]').forEach(th => {
      const arrow = th.querySelector('.arrow');
      if (th.dataset.sort === sortKey) {
        arrow.textContent = sortDesc ? '▼' : '▲';
      } else {
        arrow.textContent = '';
      }
    });
  }

  /* ------------------------------------------------------------ 详情弹窗 */

  const DETAIL_META = {
    scan:       { t: '扫描记录',    q: 'scan',       c: 'orange', d: '访问不存在路径（404）的请求，通常是自动化工具在探测漏洞。' },
    crawler:    { t: '爬虫记录',    q: 'crawler',    c: 'blue',   d: 'User-Agent 含 bot / crawler / spider / scanner 的请求。' },
    blocked:    { t: '并发拦截',    q: 'blocked',    c: 'red',    d: '超过并发门控上限、被返回 503 的连接。' },
    bruteforce: { t: '认证爆破',    q: 'bruteforce', c: 'red',    d: '管理接口认证失败（401）的记录。' },
    today:      { t: '今日请求',    q: '',           c: 'blue',   d: '今天进入本站的全部请求，含正常与恶意来源。' }
  };

  function openModal(title) {
    setVal($('modal-title'), title);
    $('modal').classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeModal() {
    $('modal').classList.remove('open');
    document.body.style.overflow = '';
  }

  async function openDetail(key) {
    const meta = DETAIL_META[key];
    if (!meta) return;

    const body = $('modal-body');
    body.innerHTML = '<p class="desc">' + esc(meta.d) + '</p><p style="color:var(--fg-3)">加载中…</p>';
    openModal(meta.t);

    try {
      let url = '/api/admin/logs?per_page=200';
      if (meta.q) url += '&category=' + encodeURIComponent(meta.q);
      const d = await api(url);
      const rows = d.logs || [];
      const total = d.total ?? rows.length;

      if (!rows.length) {
        body.innerHTML = '<p class="desc">' + esc(meta.d) + '</p><div class="empty">没有相关记录</div>';
        return;
      }

      // 聚合：来源 IP 与路径 TOP
      const byIp = {}, byPath = {};
      rows.forEach(l => {
        byIp[l.ip] = (byIp[l.ip] || 0) + 1;
        byPath[l.path] = (byPath[l.path] || 0) + 1;
      });
      const topIp = Object.entries(byIp).sort((a, b) => b[1] - a[1]).slice(0, 8);
      const topPath = Object.entries(byPath).sort((a, b) => b[1] - a[1]).slice(0, 8);

      const barHtml = (items) => {
        if (!items.length) return '<div class="empty">无</div>';
        const max = Math.max(1, ...items.map(x => x[1]));
        return items.map(([k, v]) =>
          '<div class="bar-row">' +
            '<div class="bar-head"><span class="mono" title="' + esc(k) + '">' +
              esc(k.length > 40 ? k.slice(0, 39) + '…' : k) + '</span><b>' + v + '</b></div>' +
            '<div class="bar"><i style="width:' + Math.max(3, v / max * 100) + '%"></i></div>' +
          '</div>'
        ).join('');
      };

      body.innerHTML =
        '<p class="desc">' + esc(meta.d) + '</p>' +
        '<div class="kpis" style="border-radius:14px;overflow:hidden;margin-bottom:18px">' +
          '<div class="kpi"><span class="v ' + meta.c + '">' + total + '</span><span class="l">总记录数</span></div>' +
          '<div class="kpi"><span class="v">' + Object.keys(byIp).length + '</span><span class="l">来源 IP 数</span></div>' +
          '<div class="kpi"><span class="v">' + Object.keys(byPath).length + '</span><span class="l">不同路径数</span></div>' +
        '</div>' +
        '<h3 style="font-size:13px;color:var(--fg-2);margin:0 0 4px">来源 IP（最近 200 条内）</h3>' +
        '<div class="bars" style="padding-left:0;padding-right:0">' + barHtml(topIp) + '</div>' +
        '<h3 style="font-size:13px;color:var(--fg-2);margin:18px 0 4px">访问路径 TOP</h3>' +
        '<div class="bars" style="padding-left:0;padding-right:0">' + barHtml(topPath) + '</div>';
    } catch (e) {
      if (e.message !== 'unauthorized') {
        body.innerHTML = '<div class="notice err">加载失败：' + esc(e.message) + '</div>';
      }
    }
  }

  /* ------------------------------------------------------------ 文章编辑 */

  function setForm(id, title, cats, tags, bodyText) {
    $('p-id').value = id || '';
    $('p-title').value = title || '';
    $('p-cats').value = cats || '';
    $('p-tags').value = tags || '';
    $('p-body').value = bodyText || '';
    setVal($('editor-title'), id ? '编辑文章' : '写新文章');
  }

  function splitCsv(s) {
    return String(s || '').split(',').map(x => x.trim()).filter(Boolean);
  }

  async function savePost() {
    const id = $('p-id').value;
    const title = $('p-title').value.trim();
    if (!title) { flash('标题不能为空', 'err'); $('p-title').focus(); return; }

    const payload = {
      title: title,
      categories: splitCsv($('p-cats').value),
      tags: splitCsv($('p-tags').value),
      content: $('p-body').value
    };

    const btn = $('p-save');
    btn.disabled = true;
    try {
      const r = await fetch(id ? '/api/posts/' + id : '/api/posts', {
        method: id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (r.status === 401) { location.replace('/login'); return; }
      const d = await r.json().catch(() => ({}));
      if (d.error) {
        flash('保存失败：' + d.error, 'err');
      } else {
        flash(id ? '已更新' : ('已发布：' + (d.slug || title)));
        setForm('', '', '', '', '');
        await loadPosts();
        await loadSystem();
      }
    } catch (e) {
      flash('保存失败：' + e.message, 'err');
    }
    btn.disabled = false;
  }

  async function delPost(id) {
    const p = (posts || []).find(x => x.id === id);
    if (!confirm('确认删除文章「' + (p ? p.title : id) + '」？此操作不可撤销。')) return;
    try {
      const r = await fetch('/api/posts/' + id, { method: 'DELETE' });
      if (r.status === 401) { location.replace('/login'); return; }
      flash('已删除');
      await loadPosts();
      await loadSystem();
    } catch (e) {
      flash('删除失败：' + e.message, 'err');
    }
  }

  /* ------------------------------------------------------------ 视图切换 */

  const VIEWS = ['dash', 'posts', 'security', 'logs'];

  function showView(name, push) {
    if (VIEWS.indexOf(name) < 0) name = 'dash';
    VIEWS.forEach(v => {
      const el = $('view-' + v);
      if (el) el.hidden = (v !== name);
    });
    document.querySelectorAll('#tabs button').forEach(b => {
      b.classList.toggle('active', b.dataset.view === name);
    });
    if (push !== false) history.replaceState(null, '', '#' + name);

    // 切回来时重画图表（隐藏状态下 canvas 尺寸为 0）
    if (name === 'dash') {
      if (charts.hourly) charts.hourly();
      if (charts.daily) charts.daily();
    }
  }

  /* ------------------------------------------------------------ 绑定事件 */

  function bind() {
    // 标签切换
    document.querySelectorAll('#tabs button').forEach(b => {
      b.addEventListener('click', () => showView(b.dataset.view));
    });

    // 退出
    const lo = $('logout');
    if (lo) lo.addEventListener('click', async () => {
      try { await fetch('/api/logout', { method: 'POST' }); } catch (_) {}
      location.replace('/login');
    });

    // 文章
    const ps = $('p-save');
    if (ps) ps.addEventListener('click', savePost);
    const pc = $('p-clear');
    if (pc) pc.addEventListener('click', () => setForm('', '', '', '', ''));

    const list = $('post-list');
    if (list) list.addEventListener('click', e => {
      const edit = e.target.closest('[data-edit]');
      const del = e.target.closest('[data-del]');
      if (edit) {
        const p = (posts || []).find(x => String(x.id) === edit.dataset.edit);
        if (p) {
          setForm(p.id, p.title, (p.categories || []).join(', '), (p.tags || []).join(', '), p.body || '');
          $('p-title').scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      } else if (del) {
        delPost(Number(del.dataset.del));
      }
    });

    // 日志筛选
    const go = $('f-go');
    if (go) go.addEventListener('click', loadLogs);
    const rs = $('f-reset');
    if (rs) rs.addEventListener('click', () => {
      $('f-cat').value = '';
      $('f-ip').value = '';
      loadLogs();
    });
    ['f-cat', 'f-ip'].forEach(id => {
      const el = $(id);
      if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') loadLogs(); });
    });

    // 日志排序
    document.querySelectorAll('#log-table th[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const k = th.dataset.sort;
        if (sortKey === k) sortDesc = !sortDesc;
        else { sortKey = k; sortDesc = true; }
        renderLogs();
      });
    });

    // 详情弹窗
    document.querySelectorAll('[data-detail]').forEach(el => {
      el.addEventListener('click', () => openDetail(el.dataset.detail));
    });
    const mc = $('modal-close');
    if (mc) mc.addEventListener('click', closeModal);
    const modal = $('modal');
    if (modal) modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

    // 窗口尺寸变化重画图表
    let rt = null;
    window.addEventListener('resize', () => {
      clearTimeout(rt);
      rt = setTimeout(() => {
        if (charts.hourly) charts.hourly();
        if (charts.daily) charts.daily();
      }, 160);
    });

    // 监听 hash 变化。
    // 没有这个的话，浏览器前进/后退、以及外部直接改 #posts 这种
    // 「同文档导航」都不会切标签——页面不会重新加载，也就不会重跑 boot()。
    window.addEventListener('hashchange', () => {
      showView((location.hash || '').replace('#', '') || 'dash', false);
    });

    // 跟随系统深色模式切换时重画（颜色取自 CSS 变量）
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (stats) {
          const all = (stats.categories || []).slice().sort((a, b) => b.count - a.count);
          renderBars($('bars'), all, c => CAT_COLOR[c] || 'c-blue');
          renderBars($('bars-sec'), all.filter(x => x.category !== 'normal'), c => CAT_COLOR[c] || 'c-blue');
          const hourly = (stats.hourly || []).map(x => ({ label: (x.h ?? '') + ':00', v: x.count ?? x.c ?? 0 }));
          const daily = (stats.daily || []).map(x => ({ label: x.date ?? x.d ?? '', v: x.count ?? x.c ?? 0 }));
          drawLine($('c-hourly'), hourly, cssVar('--blue', '#007aff'));
          drawLine($('c-daily'), daily, cssVar('--purple', '#af52de'));
        }
      });
    }
  }

  /* ------------------------------------------------------------ 启动 */

  function boot() {
    bind();

    // 图表闭包保存下来，切标签/改窗口时重画
    const origDrawLine = drawLine;
    charts.hourly = () => {
      if (!stats) return;
      const hourly = (stats.hourly || []).map(x => ({ label: (x.h ?? '') + ':00', v: x.count ?? x.c ?? 0 }));
      origDrawLine($('c-hourly'), hourly, cssVar('--blue', '#007aff'));
    };
    charts.daily = () => {
      if (!stats) return;
      const daily = (stats.daily || []).map(x => ({ label: x.date ?? x.d ?? '', v: x.count ?? x.c ?? 0 }));
      origDrawLine($('c-daily'), daily, cssVar('--purple', '#af52de'));
    };

    showView((location.hash || '').replace('#', '') || 'dash', false);

    loadStats();
    loadSystem();
    loadPosts();
    loadLogs();

    setInterval(loadStats, 10000);
    setInterval(loadSystem, 10000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
