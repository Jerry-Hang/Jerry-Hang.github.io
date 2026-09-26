/**
 * 给博客前台截图，用于评估视觉现状。
 * 用法：node _shot_site.mjs [baseUrl] [outDir]
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

const PORT = 9335;
const PROFILE = process.env.TEMP + '\\_edge_site_' + Date.now();
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

const browser = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + PROFILE, '--window-size=1440,1100', 'about:blank',
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
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const S = { send: (m, p = {}) => cdp.send(m, p, sessionId) };
  await S.send('Page.enable');
  await S.send('Runtime.enable');

  async function shot(name, url, w, h, wait, dark) {
    await S.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await S.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }],
    });
    await S.send('Page.navigate', { url: 'about:blank' });
    await sleep(200);
    await S.send('Page.navigate', { url });
    await sleep(wait || 2500);
    const { data } = await S.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(`${OUT}\\${name}.png`, Buffer.from(data, 'base64'));
    console.log('  已保存', name + '.png');
  }

  // 主页（首页是文章列表）
  await shot('S1_前台_首页', `${BASE}/`, 1440, 1000, 3500, false);
  await shot('S2_前台_首页_深色', `${BASE}/`, 1440, 1000, 3000, true);
  // 文章详情
  await shot('S3_前台_文章页', `${BASE}/blog/about-me`, 1440, 1100, 3000, false);
  // 关于页（壁纸选择器在这）
  await shot('S4_前台_关于页', `${BASE}/#about`, 1440, 1100, 3500, false);

  // 打印一下页面里实际用的字体和主色，便于判断设计现状
  const design = await S.send('Runtime.evaluate', {
    expression: `(function(){
      var cs = getComputedStyle(document.body);
      var root = getComputedStyle(document.documentElement);
      var vars = ['--accent','--bg','--card','--text','--font'];
      var out = { font: cs.fontFamily.slice(0,60), bodyBg: cs.backgroundColor };
      vars.forEach(function(v){ out[v] = root.getPropertyValue(v).trim(); });
      out.cardCount = document.querySelectorAll('.home-card,.pill,.about-card').length;
      out.hasBackdrop = Array.prototype.some.call(
        document.querySelectorAll('.pill,.home-card,.menubar'),
        function(e){ var s = getComputedStyle(e); return (s.backdropFilter||s.webkitBackdropFilter||'none') !== 'none'; });
      return out;
    })()`,
    returnByValue: true,
  }, sessionId);
  console.log('');
  console.log('页面设计要素:', JSON.stringify(design.result.value, null, 2));

} catch (e) {
  console.error('失败:', e.message);
  process.exitCode = 1;
} finally {
  try { if (cdp) cdp.ws.close(); } catch {}
  browser.kill();
  await sleep(500);
}
