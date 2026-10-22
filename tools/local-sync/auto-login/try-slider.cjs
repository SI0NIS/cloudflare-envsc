// try-slider.cjs —— 拖动一次并截图（验证落点），可传距离算法参数
// 用法：node try-slider.cjs [distanceOverride]
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const HERE = __dirname;
const RUNTIME = path.resolve(HERE, '..', 'runtime');
const CFG = JSON.parse(fs.readFileSync(path.resolve(HERE, '..', 'local-config.json'), 'utf8'));
const C = CFG.cnemc || {};
const LOGIN_URL = 'http://116.178.28.170:3080/amOnline/zdjk-company-base/login';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OVERRIDE = process.argv[2] ? Number(process.argv[2]) : null;

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--lang=zh-CN'],
    defaultViewport: { width: 1366, height: 900 },
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3500);
    try { const b = await page.$('.el-dialog__headerbtn'); if (b) { await b.click(); await sleep(500); } } catch (e) {}
    await page.type('input[placeholder="请输入账号"]', C.account, { delay: 60 });
    await page.type('input[placeholder="请输入密码"]', C.password, { delay: 60 });
    await sleep(600);
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').replace(/\s/g, '').includes('登录') && !b.disabled);
      if (btn) btn.click();
    });
    await page.waitForSelector('.vue-puzzle-vcode', { timeout: 15000 }).catch(() => {});
    await sleep(2500);

    // 等图像就绪并计算缺口
    const r = await page.evaluate(async () => {
      const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
      for (let t = 0; t < 30; t++) {
        const cs = document.getElementsByTagName('canvas');
        if (cs.length >= 3) {
          try {
            const d1 = cs[0].getContext('2d').getImageData(0, 0, 320, 180).data;
            const d3 = cs[1].getContext('2d').getImageData(0, 0, 320, 180).data;
            const prof = [];
            for (let x = 0; x < 320; x++) { let n = 0; for (let y = 0; y < 180; y++) { const i = (y * 320 + x) * 4; const dd = Math.abs(d1[i]-d3[i]) + Math.abs(d1[i+1]-d3[i+1]) + Math.abs(d1[i+2]-d3[i+2]); if (dd > 30) n++; } prof.push(n); }
            const runs = []; let st = -1;
            for (let k = 0; k < 320; k++) { if (prof[k] > 3 && st < 0) st = k; if ((prof[k] <= 3 || k === 319) && st >= 0) { runs.push([st, k-1]); st = -1; } }
            if (runs.length) return { runs: runs.slice(0, 4), first: runs[0] };
          } catch (e) { /* retry */ }
        }
        await sleep(400);
      }
      return null;
    });
    if (!r) { console.log('未检测到缺口'); return; }
    const run = r.first;
    const dist = OVERRIDE != null ? OVERRIDE : Math.round(run[0] + (run[1] - run[0]) / 2 - 29.5);
    console.log('runs:', JSON.stringify(r.runs), '| 采用距离:', dist);
    await page.screenshot({ path: path.join(RUNTIME, 'slider-before.png') });

    // 拖动（合成事件）
    const drag = await page.evaluate(async (dist) => {
      const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
      const btn = document.getElementsByClassName('range-btn')[0];
      if (!btn) return 'no-btn';
      const b = btn.getBoundingClientRect();
      const sx = Math.round(b.x + b.width / 2);
      const sy = Math.round(b.y + b.height / 2);
      const fire = (el, type, x, y) => {
        const init = { bubbles: true, cancelable: true, composed: true, view: window, detail: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: x, clientY: y, screenX: x, screenY: y, button: 0, buttons: (type === 'pointerup' || type === 'mouseup') ? 0 : 1, which: 1 };
        for (const t of [document, window, el]) {
          try { t.dispatchEvent(new PointerEvent(type, init)); } catch (e) {}
          try { t.dispatchEvent(new MouseEvent(type, init)); } catch (e) {}
        }
      };
      fire(btn, 'pointerdown', sx, sy); fire(btn, 'mousedown', sx, sy);
      await sleep(150);
      for (let s = 1; s <= 40; s++) {
        const tt = s / 40;
        const ease = 1 - Math.pow(1 - tt, 3);
        const nx = Math.round(sx + dist * ease);
        const ny = Math.round(sy + Math.sin(tt * Math.PI) * 1.2);
        fire(btn, 'pointermove', nx, ny); fire(btn, 'mousemove', nx, ny);
        await sleep(25);
      }
      fire(btn, 'pointerup', sx + dist, sy); fire(btn, 'mouseup', sx + dist, sy);
      return 'dragged ' + dist;
    }, dist);
    console.log(drag);
    await sleep(1200);
    await page.screenshot({ path: path.join(RUNTIME, 'slider-after.png') });
    await sleep(2500);
    const still = await page.evaluate(() => !!document.getElementsByClassName('vue-puzzle-vcode')[0]);
    console.log('滑块仍存在:', still, '| url:', page.url());
    if (!still) {
      const cookies = await page.cookies();
      const c = cookies.find((x) => x.name === 'jointframe.cluster.sessionid');
      console.log('cookie:', c ? c.value.slice(0, 12) + '…' : '(无)');
    }
  } catch (e) {
    console.error('ERR', e && (e.stack || e.message));
  } finally {
    await browser.close();
  }
})();
