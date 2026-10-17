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
      const rssKb = d.rss_kb ?? 0;
      setVal($('k-rss'), humanBytes(rssKb * 1024));
      setVal($('k-db'), humanBytes(d.db_size_bytes ?? 0));
      setVal($('k-posts'), d.posts ?? 0);
      setVal($('k-sess'), d.session_count ?? 0);
      setVal($('k-gate'), (d.gate_active ?? 0) + ' / ' + (d.gate_limit ?? 0));
      setVal($('k-likes'), d.total_likes ?? 0);
      setVal($('k-devs'), d.trusted_devices ?? 0);

      // CGroup 内存熔断阻尼监控（硬限 512MB，限流点 384MB，恢复点 256MB）
      const rssMb = (rssKb / 1024).toFixed(1);
      setVal($('mem-cur'), rssMb + ' MB / 512 MB');
      const memPct = Math.min(100, Math.max(4, (rssKb / (512 * 1024)) * 100));
      const memBar = $('mem-bar');
      const memStatus = $('k-mem-status');
      if (memBar) {
        memBar.style.width = memPct + '%';
        if (rssKb >= 384 * 1024) {
          memBar.style.background = 'var(--red, #ff3b30)';
          if (memStatus) {
            memStatus.textContent = '阻尼限流中（已超 384MB）';
            memStatus.style.color = 'var(--red, #ff3b30)';
          }
        } else if (rssKb >= 256 * 1024) {
          memBar.style.background = 'var(--orange, #ff9500)';
          if (memStatus) {
            memStatus.textContent = '平稳监控（高于 256MB）';
            memStatus.style.color = 'var(--orange, #ff9500)';
          }
        } else {
          memBar.style.background = 'var(--blue, #007aff)';
          if (memStatus) {
            memStatus.textContent = '满血极速模式（正常）';
            memStatus.style.color = 'var(--green, #34c759)';
          }
        }
      }
    } catch (e) {
      if (e.message !== 'unauthorized') console.warn('loadSystem', e);
    }
  }

  /* ------------------------------------------------------------ 可信设备 */

  let devices = [];

  async function loadDevices() {
    try {
      const d = await api('/api/admin/devices');
      devices = d.devices || [];
      setVal($('dev-count'), '(' + devices.length + ')');
      renderDevices();
    } catch (e) {
      if (e.message !== 'unauthorized') console.warn('loadDevices', e);
    }
  }

  function renderDevices() {
    const body = $('dev-body');
    if (!body) return;
    if (!devices.length) {
      body.innerHTML = '<tr><td colspan="6"><div class="empty">暂无授权的可信设备</div></td></tr>';
      return;
    }
    body.innerHTML = devices.map(d =>
      '<tr>' +
        '<td><b>' + esc(d.name) + '</b></td>' +
        '<td class="mono" style="font-size:12px">' + esc(d.device_id) + '</td>' +
        '<td class="mono" style="font-size:12px">' + esc(d.created_at) + '</td>' +
        '<td class="mono" style="font-size:12px">' + esc(d.last_seen) + '</td>' +
        '<td>' + (d.is_active ? '<span class="tag normal">已信任</span>' : '<span class="tag bruteforce">已吊销</span>') + '</td>' +
        '<td>' + (d.is_active ? '<button class="btn small danger" data-revoke="' + esc(d.device_id) + '">吊销信任</button>' : '<span style="color:var(--fg-3);font-size:12px">已停用</span>') + '</td>' +
      '</tr>'
    ).join('');
  }

  async function revokeDevice(deviceId) {
    if (!confirm('确定要吊销此设备的受信任权限吗？吊销后该设备将无法通过远程访问博客后台。')) return;
    try {
      await api('/api/admin/revoke-device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: deviceId })
      });
      flash('已成功吊销设备信任权限', 'ok');
      await loadDevices();
      await loadSystem();
    } catch (e) {
      flash('吊销失败：' + e.message, 'err');
    }
  }

  async function generatePairCode() {
    const input = $('dev-name-input');
    const name = input ? input.value.trim() || '移动端设备' : '移动端设备';
    const btn = $('btn-gen-pair');
    if (btn) btn.disabled = true;
    try {
      const d = await api('/api/admin/pair-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, ttl_secs: 900 })
      });
      const resBox = $('pair-result');
      const urlText = $('pair-url-text');
      if (resBox && urlText) {
        urlText.textContent = d.url;
        resBox.style.display = 'block';
      }
      flash('临时配对链接已生成，15分钟内有效', 'ok');
    } catch (e) {
      flash('生成配对码失败：' + e.message, 'err');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /* ------------------------------------------------------------ 拦截与封禁 IP */

  let bannedIps = [];

  async function loadBanned() {
    try {
      const d = await api('/api/admin/banned');
      bannedIps = d.banned || [];
      setVal($('banned-count'), '(' + bannedIps.length + ')');
      renderBanned();
    } catch (e) {
      if (e.message !== 'unauthorized') console.warn('loadBanned', e);
    }
  }

  function renderBanned() {
    const body = $('banned-body');
    if (!body) return;
    if (!bannedIps.length) {
      body.innerHTML = '<tr><td colspan="4"><div class="empty">当前无处于封禁状态的 IP</div></td></tr>';
      return;
    }
    body.innerHTML = bannedIps.map(b =>
      '<tr>' +
        '<td class="mono"><b>' + esc(b.ip) + '</b></td>' +
        '<td>' + b.remaining_secs + ' 秒</td>' +
        '<td><span class="tag bruteforce">自动熔断拦截</span></td>' +
        '<td><button class="btn small" data-unban="' + esc(b.ip) + '">立即解封</button></td>' +
      '</tr>'
    ).join('');
  }

  async function unbanIp(ip) {
    try {
      await api('/api/admin/unban', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: ip })
      });
      flash('已解除对 IP ' + ip + ' 的封禁', 'ok');
      await loadBanned();
    } catch (e) {
      flash('解封失败：' + e.message, 'err');
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

  const VIEWS = ['dash', 'posts', 'devices', 'security', 'logs'];

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

    // 切回来时重画图表或刷新数据
    if (name === 'dash') {
      if (charts.hourly) charts.hourly();
      if (charts.daily) charts.daily();
    } else if (name === 'devices') {
      loadDevices();
    } else if (name === 'security') {
      loadBanned();
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

    // 设备配对与吊销
    const btnPair = $('btn-gen-pair');
    if (btnPair) btnPair.addEventListener('click', generatePairCode);

    const btnCopyPair = $('btn-copy-pair-url');
    if (btnCopyPair) {
      btnCopyPair.addEventListener('click', () => {
        const text = ($('pair-url-text') || {}).textContent || '';
        if (!text) return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(() => flash('已复制配对链接到剪贴板', 'ok')).catch(() => flash('复制失败，请手动选择', 'err'));
        } else {
          flash('已生成配对链接：' + text, 'ok');
        }
      });
    }

    const devTable = $('dev-table');
    if (devTable) {
      devTable.addEventListener('click', e => {
        const rev = e.target.closest('[data-revoke]');
        if (rev) revokeDevice(rev.dataset.revoke);
      });
    }

    // IP 解封
    const bannedTable = $('banned-table');
    if (bannedTable) {
      bannedTable.addEventListener('click', e => {
        const unb = e.target.closest('[data-unban]');
        if (unb) unbanIp(unb.dataset.unban);
      });
    }

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

    // 监听 hash 变化
    window.addEventListener('hashchange', () => {
      showView((location.hash || '').replace('#', '') || 'dash', false);
    });

    // 跟随系统深色模式切换时重画
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
    loadDevices();
    loadBanned();
    loadLogs();

    setInterval(loadStats, 10000);
    setInterval(loadSystem, 10000);
    setInterval(loadBanned, 10000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
