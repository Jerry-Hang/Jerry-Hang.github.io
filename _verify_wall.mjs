/**
 * 验证壁纸切换是否真的生效。
 *
 * 只验证事实，不验证实现：
 *   1. 找到壁纸选择器里的按钮
 *   2. 依次点击每个按钮
 *   3. 读 #wallpaper 的 computed backgroundImage 和 body 的 backgroundImage
 *   4. 判断画面是否真的变了
 *
 * 用法：node _verify_wall.mjs [baseUrl] [outDir]
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

const PORT = 9334;
const PROFILE = process.env.TEMP + '\\_edge_wall_' + Date.now();
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
  '--user-data-dir=' + PROFILE, '--window-size=1440,1000', 'about:blank',
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
  await S.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  const evalJs = async (expr) => {
    const { result, exceptionDetails } = await S.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.text + ' ' + (exceptionDetails.exception?.description || ''));
    return result.value;
  };

  console.log('打开', BASE + '/#about');
  await S.send('Page.navigate', { url: BASE + '/#about' });
  await sleep(3500);

  // 看看壁纸选择器在不在
  const info = await evalJs(`(function(){
    var g = document.getElementById('wall-grid');
    return {
      gridFound: !!g,
      thumbs: g ? g.querySelectorAll('.wall-thumb').length : 0,
      names: g ? Array.prototype.map.call(g.querySelectorAll('.wall-thumb'), function(b){ return b.dataset.wall; }) : [],
      currentWall: (function(){ try { return localStorage.getItem('jb_wall2'); } catch(e){ return null; } })()
    };
  })()`);
  console.log('壁纸选择器:', JSON.stringify(info));

  if (!info.gridFound || info.thumbs === 0) {
    console.log('!! 没找到壁纸选择器，先把页面文本 dump 出来看看');
    const txt = await evalJs('document.body.innerText.slice(0,600)');
    console.log(txt);
    throw new Error('壁纸选择器不可用');
  }

  // 逐个点击并读取实际生效的背景
  const report = [];
  for (const id of info.names) {
    await evalJs(`(function(){
      var b = document.querySelector('.wall-thumb[data-wall="' + ${JSON.stringify(id)} + '"]');
      if (b) b.click();
      return true;
    })()`);
    await sleep(500);

    const st = await evalJs(`(function(){
      var w = document.getElementById('wallpaper');
      var cs = w ? getComputedStyle(w) : null;
      var bodyCs = getComputedStyle(document.body);
      var img = cs ? cs.backgroundImage : '(无 #wallpaper)';
      return {
        wall: ${JSON.stringify(id)},
        hasWallClass: document.body.classList.contains('has-wall'),
        wallpaperBG: (img || 'none').slice(0, 70),
        bodyBG: (bodyCs.backgroundImage || 'none').slice(0, 50),
        stored: (function(){ try { return localStorage.getItem('jb_wall2'); } catch(e){ return null; } })()
      };
    })()`);
    report.push(st);
    console.log(`  ${id.padEnd(10)} has-wall=${st.hasWallClass ? 'Y' : 'n'}  #wallpaper=${st.wallpaperBG}`);
  }

  // 结论
  const withImage = report.filter(r => r.wallpaperBG && r.wallpaperBG !== 'none');
  console.log('');
  console.log(`  能显示壁纸图的选项: ${withImage.length} / ${report.length}`);
  console.log(`  body 的 has-wall 标记随选择变化: ${new Set(report.map(r => r.hasWallClass)).size > 1 ? '是 ✓' : '否 ✗'}`);
  console.log(`  localStorage 记录: ${report.map(r => r.stored).filter((v,i,a)=>a.indexOf(v)===i).join(', ')}`);

  // 给「草地」这个横屏壁纸截图看看效果
  const banner = report.find(r => r.wall === 'banner');
  if (banner) {
    await evalJs(`document.querySelector('.wall-thumb[data-wall="banner"]').click()`);
    await sleep(900);
    const { data } = await S.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(`${OUT}\\8_壁纸_草地.png`, Buffer.from(data, 'base64'));
    console.log('  已保存 8_壁纸_草地.png');
  }

  // 回到纯色
  await evalJs(`document.querySelector('.wall-thumb[data-wall="clean"]').click()`);
  await sleep(900);
  const { data: d2 } = await S.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(`${OUT}\\9_壁纸_纯色极光.png`, Buffer.from(d2, 'base64'));
  console.log('  已保存 9_壁纸_纯色极光.png');

} catch (e) {
  console.error('失败:', e.message);
  process.exitCode = 1;
} finally {
  try { if (cdp) cdp.ws.close(); } catch {}
  browser.kill();
  await sleep(500);
}
