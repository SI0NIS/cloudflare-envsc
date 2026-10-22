// auto-login.cjs —— 企业端平台自动登录，刷新 jointframe.cluster.sessionid
//
// 依赖：puppeteer-core（本目录 node_modules 或上级）+ 本机 Chrome
// 配置：上级目录 local-config.json（gitignore，含 cnemc.account / cnemc.password）
// 流程：打开登录页 → 填账号密码 → 点「登 录」→ 滑块 solver（canvas 差值 + 合成 pointer 事件）
//       → 取 cookie → 调接口校验 → 校验通过才写 ../runtime/cnemc-cookie.txt
// 退出码：0=成功；1=失败（不改动原 cookie）
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const LS_DIR = path.resolve(HERE, '..');
const RUNTIME = path.join(LS_DIR, 'runtime');
const COOKIE_FILE = path.join(RUNTIME, 'cnemc-cookie.txt');
const CONFIG_FILE = path.join(LS_DIR, 'local-config.json');
fs.mkdirSync(RUNTIME, { recursive: true });

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) { /* ignore */ }
  return {};
}
const CFG = loadConfig();
const CNEMC = CFG.cnemc || {};
const ACCOUNT = CNEMC.account || process.env.CNEMC_ACCOUNT || '';
const PASSWORD = CNEMC.password || process.env.CNEMC_PASSWORD || '';

const BASE = 'http://116.178.28.170:3080/amOnline';
const LOGIN_URL = `${BASE}/zdjk-company-base/login`;
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const puppeteer = require('puppeteer-core');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const todayBJ = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const LOG_DIR = path.join(RUNTIME, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const logPath = path.join(LOG_DIR, `auto-login-${todayBJ}.log`);
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(logPath, line + '\n', 'utf8'); } catch (e) { /* ignore */ }
}

async function validateCookie(cookie) {
  try {
    const psid = CNEMC.psid || '654000000031';
    const url = `${BASE}/app/baseroute/requestRoute!list.page?method=/psbase/mpinfo/getMpInfoByPsId&psId=${psid}&_t=${Date.now()}`;
    const r = await fetch(url, {
      headers: { Cookie: cookie, Accept: 'application/json, text/plain, */*', 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': UA, Referer: `${BASE}/zdjk-company-base/` },
    });
    const j = JSON.parse(await r.text());
    return j && String(j.code) === '200' && Array.isArray(j.data) && j.data.length > 0;
  } catch (e) { return false; }
}

// 滑块 solver（移植自 cnemc-rate-check/scripts/solver.js，page.evaluate 直接注入）
async function solveSlider(page) {
  return page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const veil = () => document.getElementsByClassName('vue-puzzle-vcode')[0];
    function detect() {
      const cs = document.getElementsByTagName('canvas');
      if (cs.length < 3) return null;
      const d1 = cs[0].getContext('2d').getImageData(0, 0, 320, 180).data;
      const d3 = cs[1].getContext('2d').getImageData(0, 0, 320, 180).data;
      const prof = [];
      for (let x = 0; x < 320; x++) {
        let n = 0;
        for (let y = 0; y < 180; y++) {
          const i = (y * 320 + x) * 4;
          const dd = Math.abs(d1[i] - d3[i]) + Math.abs(d1[i + 1] - d3[i + 1]) + Math.abs(d1[i + 2] - d3[i + 2]);
          if (dd > 30) n++;
        }
        prof.push(n);
      }
      const runs = [];
      let st = -1;
      for (let k = 0; k < 320; k++) {
        if (prof[k] > 3 && st < 0) st = k;
        if ((prof[k] <= 3 || k === 319) && st >= 0) { runs.push([st, k - 1]); st = -1; }
      }
      const nz = prof.filter((v) => v > 0).length;
      if (runs.length === 0 || nz < 20) return null;
      return { gap: (runs[0][0] + runs[0][1]) / 2, w: runs[0][1] - runs[0][0] };
    }
    function fire(el, type, x, y) {
      const init = {
        bubbles: true, cancelable: true, composed: true, view: window, detail: 1,
        pointerId: 1, pointerType: 'mouse', isPrimary: true,
        clientX: x, clientY: y, screenX: x, screenY: y, button: 0,
        buttons: (type === 'pointerup' || type === 'mouseup') ? 0 : 1, which: 1,
      };
      const evs = [document, window];
      if (el) evs.push(el);
      for (const t of evs) {
        try { t.dispatchEvent(new PointerEvent(type, init)); } catch (e) { /* ignore */ }
        try { t.dispatchEvent(new MouseEvent(type, init)); } catch (e) { /* ignore */ }
      }
    }
    let last = 0;
    for (let round = 1; round <= 10; round++) {
      if (!veil()) return 'OK_R' + round + '_URL_' + location.href;
      // 等图像就绪：run 宽度 ≥ 25 才算有效
      let r = null;
      for (let t = 0; t < 50; t++) {
        r = detect();
        if (r && r.w >= 25) break;
        r = null;
        await sleep(400);
      }
      if (!r) { await sleep(1500); continue; }
      const btn = document.getElementsByClassName('range-btn')[0];
      if (!btn) { await sleep(1500); continue; }
      const b = btn.getBoundingClientRect();
      const sx = Math.round(b.x + b.width / 2);
      const sy = Math.round(b.y + b.height / 2);
      // 距离：缺口中心 - 滑块半宽（29.5），叠加 ±1px 随机
      const base = r.gap - 29.5;
      const dist = Math.round(base + (Math.random() * 2 - 1));
      last = dist;
      fire(btn, 'pointerdown', sx, sy); fire(btn, 'mousedown', sx, sy);
      await sleep(180 + Math.random() * 120);
      // 分段拖动：46~56 步、每步 18~38ms、带轻微纵向抖动（更像人）
      const steps = 46 + Math.floor(Math.random() * 10);
      for (let s = 1; s <= steps; s++) {
        const tt = s / steps;
        const ease = 1 - Math.pow(1 - tt, 3);
        const nx = Math.round(sx + dist * ease);
        const ny = Math.round(sy + Math.sin(tt * Math.PI) * 1.5 + (Math.random() * 1.2 - 0.6));
        fire(btn, 'pointermove', nx, ny); fire(btn, 'mousemove', nx, ny);
        await sleep(18 + Math.random() * 20);
      }
      fire(btn, 'pointerup', sx + dist, sy); fire(btn, 'mouseup', sx + dist, sy);
      await sleep(2500);
      if (!veil()) return 'OK_R' + round + '_DRAG_' + dist + '_URL_' + location.href;
      await sleep(2000);
    }
    return 'FAIL_LAST_' + last;
  });
}

// 单次登录尝试：goto → 填账号密码 → 点登录 → 过滑块 → 取 cookie 并校验
async function attemptOnce(page) {
  log('打开登录页…');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3500);
  try {
    const closeBtn = await page.$('.el-dialog__headerbtn');
    if (closeBtn) { await closeBtn.click(); await sleep(500); }
  } catch (e) { /* ignore */ }
  log('填写账号密码…');
  await page.type('input[placeholder="请输入账号"]', ACCOUNT, { delay: 60 });
  await page.type('input[placeholder="请输入密码"]', PASSWORD, { delay: 60 });
  await sleep(600);
  // 按钮文字是「登 录」（含空格），需去掉空白再匹配
  const clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').replace(/\s/g, '').includes('登录') && !b.disabled);
    if (btn) { btn.click(); return true; }
    return false;
  });
  log(`登录按钮点击：${clicked}`);
  if (!clicked) {
    try { await page.focus('input[type="password"]'); await page.keyboard.press('Enter'); log('回车兜底已触发'); } catch (e) { /* ignore */ }
  }
  await page.waitForSelector('.vue-puzzle-vcode', { timeout: 15000 }).catch(() => log('未等到 .vue-puzzle-vcode（继续尝试）'));
  await sleep(1500);
  const res = await solveSlider(page);
  log(`滑块结果：${res}`);
  await sleep(2500);
  const cookies = await page.cookies();
  const c = cookies.find((x) => x.name === 'jointframe.cluster.sessionid');
  if (!c) throw new Error(`未取到 sessionid（现有 cookie: ${cookies.map((x) => x.name).join(',') || '空'}）`);
  const cookieStr = `jointframe.cluster.sessionid=${c.value}`;
  return cookieStr;
}

(async () => {
  log('=== 自动登录开始 ===');
  if (!ACCOUNT || !PASSWORD) {
    log('缺少账号/密码（local-config.json 的 cnemc.account / cnemc.password）');
    process.exitCode = 1;
    return;
  }
  let browser = null;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--lang=zh-CN'],
      defaultViewport: { width: 1366, height: 900 },
    });
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    let lastErr = null;
    for (let cycle = 1; cycle <= 3; cycle++) {
      log(`--- 登录尝试 ${cycle}/3 ---`);
      try {
        const cookieStr = await attemptOnce(page);
        const ok = await validateCookie(cookieStr);
        log(`新 cookie 校验：${ok ? '有效 ✅' : '无效 ❌'}（${cookieStr.slice(0, 40)}…）`);
        if (!ok) throw new Error('新 cookie 校验失败');
        fs.writeFileSync(COOKIE_FILE, cookieStr, 'utf8');
        log(`已写入 ${COOKIE_FILE}`);
        log('=== 成功 ===');
        process.exitCode = 0;
        return;
      } catch (e) {
        lastErr = e;
        log(`尝试 ${cycle} 失败：${(e && (e.message || e) || '').toString().slice(0, 200)}`);
        await sleep(5000);
      }
    }
    throw lastErr || new Error('全部尝试失败');
  } catch (e) {
    log(`失败：${e && (e.stack || e.message || e)}`);
    process.exitCode = 1;
  } finally {
    if (browser) { try { await browser.close(); } catch (e) { /* ignore */ } }
  }
})();
