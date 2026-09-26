/**
 * 模拟真实用户登录后台：打开 /login、填表、点按钮，看会发生什么。
 * 用法：node _verify_login.mjs [baseUrl] [outDir] [user] [pass]
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.argv[2] || 'http://127.0.0.1:8091';
const OUT = process.argv[3] || 'D:\\3D_Work\\Blog\\_预览';
const USER = process.argv[4] || 'admin';
const PASS = process.argv[5] || 'huang100417';

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find(p => existsSync(p));
if (!EDGE) { console.error('找不到 Edge'); process.exit(1); }

const PORT = 9340;
const PROFILE = process.env.TEMP + '\\_edge_login_' + Date.now();
mkdirSync(OUT, { recursive: true });

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.p = new Map(); this.events = [];
    ws.addEventListener('message', e => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.id && this.p.has(m.id)) {
        const { resolve, reject } = this.p.get(m.id);
        this.p.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.method) {
        this.events.push(m);
      }
    });
  }
  send(method, params = {}, sid) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sid) msg.sessionId = sid;
    return new Promise((res, rej) => {
      this.p.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify(msg));
      setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error('timeout ' + method)); } }, 25000);
    });
  }
}

const browser = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + PROFILE, '--window-size=1100,860', 'about:blank',
], { stdio: 'ignore' });

let cdp = null;
try {
  let wsUrl = null;
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    try { const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); wsUrl = j.webSocketDebuggerUrl; if (wsUrl) break; } catch {}
  }
  if (!wsUrl) throw new Error('调试端口未就绪');
  cdp = new CDP(new WebSocket(wsUrl));
  await new Promise((r, j) => { cdp.ws.addEventListener('open', r, { once: true }); cdp.ws.addEventListener('error', j, { once: true }); });

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const S = { send: (m, p = {}) => cdp.send(m, p, sessionId) };
  await S.send('Page.enable'); await S.send('Runtime.enable'); await S.send('Network.enable');
  await S.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 860, deviceScaleFactor: 1, mobile: false });

  const ev = async (expr) => {
    const { result, exceptionDetails } = await S.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (exceptionDetails) throw new Error(exceptionDetails.text + ' ' + (exceptionDetails.exception?.description || ''));
    return result.value;
  };

  console.log('打开登录页', BASE + '/login');
  await S.send('Page.navigate', { url: BASE + '/login' });
  await sleep(2500);

  const page = await ev(`(function(){
    var f = document.getElementById('f');
    return {
      url: location.href,
      title: document.title,
      formFound: !!f,
      userInput: !!document.getElementById('u'),
      passInput: !!document.getElementById('p'),
      passType: (document.getElementById('p')||{}).type,
      submitBtnText: (document.getElementById('go')||{}).textContent,
      errVisible: (function(){ var e=document.getElementById('err'); return e ? e.classList.contains('show') : null })(),
      cssLoaded: (function(){
        // 看公共样式有没有生效：card 背景应该是白/深色，不是透明
        var c = document.querySelector('.login-card');
        return c ? getComputedStyle(c).borderRadius : null;
      })()
    };
  })()`);
  console.log('登录页状态:', JSON.stringify(page, null, 2));

  // 截图登录页
  let { data } = await S.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(`${OUT}\\L1_登录页.png`, Buffer.from(data, 'base64'));
  console.log('  已保存 L1_登录页.png');

  if (!page.formFound) throw new Error('页面上没有找到登录表单 #f');

  // 填表（用原生 setter + input 事件，模拟真实输入）
  await ev(`(function(){
    function setVal(el, v){
      var proto = el.tagName === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    setVal(document.getElementById('u'), ${JSON.stringify(USER)});
    setVal(document.getElementById('p'), ${JSON.stringify(PASS)});
    return { u: document.getElementById('u').value, p: document.getElementById('p').value.length };
  })()`);
  console.log('已填入账号密码');

  // 记录网络请求
  const before = cdp.events.length;

  // 点登录
  await ev(`document.getElementById('go').click()`);
  await sleep(3000);

  // 看跳到哪了
  const after = await ev(`(function(){
    return {
      url: location.href,
      title: document.title,
      bodyTextStart: document.body.innerText.slice(0, 200),
      hasAdminKpis: !!document.getElementById('k-today'),
      hasTabs: !!document.getElementById('tabs'),
      errText: (function(){ var e=document.getElementById('err'); return e && e.classList.contains('show') ? e.textContent : null })(),
      toast: (function(){ var t=document.querySelector('.toast,.notice'); return t ? t.textContent : null })()
    };
  })()`);
  console.log('');
  console.log('点击登录后:', JSON.stringify(after, null, 2));

  // 打印相关网络事件
  const netEvents = cdp.events.slice(before).filter(e => e.method === 'Network.responseReceived' || e.method === 'Runtime.exceptionThrown');
  console.log('');
  console.log('网络与异常:');
  netEvents.slice(0, 12).forEach(e => {
    if (e.method === 'Network.responseReceived') {
      const r = e.params.response;
      console.log(`   ${r.status} ${r.url.replace(BASE, '')}`);
    } else {
      console.log('   EXCEPTION: ' + (e.params?.exceptionDetails?.exception?.description || '').split('\n')[0]);
    }
  });

  await sleep(500);
  ({ data } = await S.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }));
  writeFileSync(`${OUT}\\L2_登录后.png`, Buffer.from(data, 'base64'));
  console.log('  已保存 L2_登录后.png');

  const ok = after.hasAdminKpis || after.hasTabs;
  console.log('');
  console.log(ok ? '✓ 登录成功，已进入后台' : '✗ 登录后没有进入后台');

} catch (e) {
  console.error('失败:', e.message);
  process.exitCode = 1;
} finally {
  try { if (cdp) cdp.ws.close(); } catch {}
  browser.kill();
  await sleep(400);
}
