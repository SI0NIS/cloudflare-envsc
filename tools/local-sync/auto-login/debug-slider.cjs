// debug-slider.cjs —— 滑块诊断：登录到出滑块，导出 canvas/按钮尺寸与缺口检测结果 + 截图
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const HERE = __dirname;
const RUNTIME = path.resolve(HERE, '..', 'runtime');
fs.mkdirSync(RUNTIME, { recursive: true });
const CONFIG = path.resolve(HERE, '..', 'local-config.json');
const CFG = fs.existsSync(CONFIG) ? JSON.parse(fs.readFileSync(CONFIG, 'utf8')) : {};
const C = CFG.cnemc || {};
const LOGIN_URL = 'http://116.178.28.170:3080/amOnline/zdjk-company-base/login';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    const info = await page.evaluate(() => {
      const cs = [...document.getElementsByTagName('canvas')].map((c, i) => {
        const r = c.getBoundingClientRect();
        return { i, w: c.width, h: c.height, cssW: Math.round(r.width), cssH: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y), cls: c.className };
      });
      const btn = document.getElementsByClassName('range-btn')[0];
      const br = btn ? btn.getBoundingClientRect() : null;
      const veil = document.getElementsByClassName('vue-puzzle-vcode')[0];
      const vr = veil ? veil.getBoundingClientRect() : null;
      // 缺口检测（与 solver 相同的算法）
      let gap = null;
      try {
        const d1 = document.getElementsByTagName('canvas')[0].getContext('2d').getImageData(0, 0, 320, 180).data;
        const d3 = document.getElementsByTagName('canvas')[1].getContext('2d').getImageData(0, 0, 320, 180).data;
        const prof = [];
        for (let x = 0; x < 320; x++) { let n = 0; for (let y = 0; y < 180; y++) { const i = (y * 320 + x) * 4; const dd = Math.abs(d1[i]-d3[i]) + Math.abs(d1[i+1]-d3[i+1]) + Math.abs(d1[i+2]-d3[i+2]); if (dd > 30) n++; } prof.push(n); }
        const runs = []; let st = -1;
        for (let k = 0; k < 320; k++) { if (prof[k] > 3 && st < 0) st = k; if ((prof[k] <= 3 || k === 319) && st >= 0) { runs.push([st, k-1]); st = -1; } }
        gap = { runs: runs.slice(0, 5), first: runs[0] };
      } catch (e) { gap = { error: String(e) }; }
      return {
        url: location.href,
        canvases: cs,
        rangeBtn: br ? { x: Math.round(br.x), y: Math.round(br.y), w: Math.round(br.width), h: Math.round(br.height) } : null,
        veil: vr ? { x: Math.round(vr.x), y: Math.round(vr.y), w: Math.round(vr.width), h: Math.round(vr.height) } : null,
        gap,
        bodyText: (document.body.innerText || '').slice(-200),
      };
    });
    console.log(JSON.stringify(info, null, 1));
    await page.screenshot({ path: path.join(RUNTIME, 'slider-full.png') });
    const veilEl = await page.$('.vue-puzzle-vcode');
    if (veilEl) { try { await veilEl.screenshot({ path: path.join(RUNTIME, 'slider-puzzle.png') }); } catch (e) { console.log('puzzle shot fail', e.message); } }
    console.log('screenshots saved');
  } catch (e) {
    console.error('ERR', e && (e.stack || e.message));
  } finally {
    await browser.close();
  }
})();
