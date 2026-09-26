/**
 * 验证阅读增强功能是否真的生效。
 * 用法：node _verify_reading.mjs [baseUrl] [outDir]
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.argv[2] || 'http://127.0.0.1:8090';
const OUT = process.argv[3] || 'D:\\3D_Work\\Blog\\_预览';

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find(p => existsSync(p));
if (!EDGE) { console.error('找不到浏览器'); process.exit(1); }

const PORT = 9336;
const PROFILE = process.env.TEMP + '\\_edge_read_' + Date.now();
mkdirSync(OUT, { recursive: true });

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(msg));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('超时 ' + method)); }
      }, 30000);
    });
  }
}

/** 收集页面控制台错误 */
const consoleErrors = [];

const browser = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + PROFILE, '--window-size=1280,1000', 'about:blank',
], { stdio: 'ignore' });

let cdp = null;
try {
  let wsUrl = null;
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    try {
      const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      wsUrl = j.webSocketDebuggerUrl; if (wsUrl) break;
    } catch {}
  }
  if (!wsUrl) throw new Error('调试端口未就绪');

  cdp = new CDP(new WebSocket(wsUrl));
  await new Promise((res, rej) => {
    cdp.ws.addEventListener('open', res, { once: true });
    cdp.ws.addEventListener('error', rej, { once: true });
  });

  // 监听控制台错误
  cdp.ws.addEventListener('message', ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || 'unknown');
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
      consoleErrors.push((m.params.args || []).map(a => a.value || a.description || '').join(' '));
    }
  });

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const S = { send: (m, p = {}) => cdp.send(m, p, sessionId) };
  await S.send('Page.enable');
  await S.send('Runtime.enable');
  await S.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });

  const evalJs = async (expr) => {
    const { result, exceptionDetails } = await S.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.text + ' ' + (exceptionDetails.exception?.description || ''));
    return result.value;
  };

  /* ---------- 打开文章页（含代码块的那篇）---------- */
  const artUrl = BASE + '/blog/android-agent';
  console.log('打开', artUrl);
  await S.send('Page.navigate', { url: artUrl });
  await sleep(4000);

  // 1. 目录
  const toc = await evalJs(`(function(){
    var b = document.getElementById('r-toc');
    if (!b) return { found:false };
    var links = b.querySelectorAll('a');
    var box = b.getBoundingClientRect();
    return {
      found: true,
      hidden: b.hidden,
      count: links.length,
      first: links.length ? links[0].textContent.trim() : '',
      visible: box.height > 0 && box.width > 0,
      headText: (b.querySelector('.toc-head')||{}).textContent || ''
    };
  })()`);
  console.log('目录:', JSON.stringify(toc));

  // 2. 代码高亮
  const code = await evalJs(`(function(){
    var pres = document.querySelectorAll('#r-body pre');
    var out = { preCount: pres.length, langs: [], tokCounts: {}, copyBtns: 0 };
    pres.forEach(function(p){
      var l = p.getAttribute('data-lang'); if (l) out.langs.push(l);
      if (p.querySelector('.code-copy')) out.copyBtns++;
      p.querySelectorAll('span[class^="tok-"]').forEach(function(s){
        var c = s.className; out.tokCounts[c] = (out.tokCounts[c]||0) + 1;
      });
    });
    return out;
  })()`);
  console.log('代码块:', JSON.stringify(code));

  // 3. 标题锚点
  const anchors = await evalJs(`(function(){
    var hs = document.querySelectorAll('#r-body h2, #r-body h3');
    var withId = 0, withAnchor = 0;
    hs.forEach(function(h){ if (h.id) withId++; if (h.querySelector('.h-anchor')) withAnchor++; });
    return { headings: hs.length, withId: withId, withAnchor: withAnchor };
  })()`);
  console.log('标题锚点:', JSON.stringify(anchors));

  // 4. 进度条 + 回到顶部（先滚到中间）
  await evalJs('window.scrollTo(0, document.body.scrollHeight * 0.55)');
  await sleep(700);
  const chrome = await evalJs(`(function(){
    var b = document.getElementById('read-progress');
    var t = document.getElementById('to-top');
    return {
      progressExists: !!b,
      progressWidth: b ? b.style.width : null,
      progressOn: b ? b.classList.contains('on') : null,
      toTopExists: !!t,
      toTopOn: t ? t.classList.contains('on') : null
    };
  })()`);
  console.log('进度条/回顶:', JSON.stringify(chrome));

  // 5. 目录滚动高亮
  const active = await evalJs(`(function(){
    var a = document.querySelector('#r-toc a.active');
    return { hasActive: !!a, activeText: a ? a.textContent.trim() : null };
  })()`);
  console.log('目录高亮:', JSON.stringify(active));

  // 6. 图片灯箱（这篇可能没图，只检查绑定）
  const lb = await evalJs(`(function(){
    var l = document.getElementById('lightbox');
    var imgs = document.querySelectorAll('#r-body img');
    var bound = 0;
    imgs.forEach(function(i){ if (i.dataset.lbBound) bound++; });
    return { lightboxExists: !!l, imgCount: imgs.length, boundCount: bound };
  })()`);
  console.log('灯箱:', JSON.stringify(lb));

  // 7. 行宽（阅读舒适度）
  const width = await evalJs(`(function(){
    var b = document.getElementById('r-body');
    var cs = getComputedStyle(b);
    return { computedMaxWidth: cs.maxWidth, actualWidth: Math.round(b.getBoundingClientRect().width), fontSize: cs.fontSize, lineHeight: cs.lineHeight };
  })()`);
  console.log('正文宽度:', JSON.stringify(width));

  /* ---------- 截图 ---------- */
  await evalJs('window.scrollTo(0,0)');
  await sleep(500);
  let { data } = await S.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(`${OUT}\\R1_文章页_目录.png`, Buffer.from(data, 'base64'));
  console.log('  已保存 R1_文章页_目录.png');

  // 滚到代码块位置截图
  const scrolled = await evalJs(`(function(){
    var p = document.querySelector('#r-body pre');
    if (!p) return false;
    p.scrollIntoView({ block: 'center' });
    return true;
  })()`);
  if (scrolled) {
    await sleep(700);
    ({ data } = await S.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }));
    writeFileSync(`${OUT}\\R2_文章页_代码高亮.png`, Buffer.from(data, 'base64'));
    console.log('  已保存 R2_文章页_代码高亮.png');
  }

  // 深色模式
  await S.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await evalJs('window.scrollTo(0,0)');
  await sleep(1200);
  ({ data } = await S.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }));
  writeFileSync(`${OUT}\\R3_文章页_深色.png`, Buffer.from(data, 'base64'));
  console.log('  已保存 R3_文章页_深色.png');

  // 首页卡片
  await S.send('Emulation.setEmulatedMedia', { features: [] });
  await S.send('Page.navigate', { url: 'about:blank' });
  await sleep(200);
  await S.send('Page.navigate', { url: BASE + '/' });
  await sleep(3000);
  ({ data } = await S.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }));
  writeFileSync(`${OUT}\\R4_首页.png`, Buffer.from(data, 'base64'));
  console.log('  已保存 R4_首页.png');

  /* ---------- 控制台错误 ---------- */
  console.log('');
  if (consoleErrors.length) {
    console.log('⚠ 页面报错 ' + consoleErrors.length + ' 条:');
    consoleErrors.slice(0, 6).forEach(e => console.log('   - ' + String(e).split('\n')[0].slice(0, 160)));
  } else {
    console.log('✓ 页面无 JS 报错');
  }

} catch (e) {
  console.error('失败:', e.message);
  process.exitCode = 1;
} finally {
  try { if (cdp) cdp.ws.close(); } catch {}
  browser.kill();
  await sleep(500);
}
