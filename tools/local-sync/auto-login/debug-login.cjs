// debug-login.cjs —— 登录页结构调试（页面改版时用）：导出输入框/按钮/滑块信息 + 截图
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const HERE = __dirname;
const RUNTIME = path.resolve(HERE, '..', 'runtime');
fs.mkdirSync(RUNTIME, { recursive: true });
const LOGIN_URL = 'http://116.178.28.170:3080/amOnline/zdjk-company-base/login';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--lang=zh-CN'],
    defaultViewport: { width: 1366, height: 900 },
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 }).catch((e) => console.log('goto warn:', e.message));
    await sleep(5000);
    const info = await page.evaluate(() => {
      const inputs = [...document.querySelectorAll('input')].map((i) => ({ type: i.type, placeholder: i.placeholder, cls: i.className, visible: !!(i.offsetWidth || i.offsetHeight) }));
      const buttons = [...document.querySelectorAll('button')].map((b) => ({ text: (b.textContent || '').trim().slice(0, 20), cls: b.className, disabled: b.disabled, visible: !!(b.offsetWidth || b.offsetHeight) }));
      const canvases = document.getElementsByTagName('canvas').length;
      const puzzle = !!document.getElementsByClassName('vue-puzzle-vcode')[0];
      return { url: location.href, title: document.title, inputs, buttons, canvases, puzzle, bodyText: (document.body.innerText || '').slice(0, 500) };
    });
    console.log(JSON.stringify(info, null, 1));
    await page.screenshot({ path: path.join(RUNTIME, 'login-page.png'), fullPage: false });
    console.log('screenshot saved:', path.join(RUNTIME, 'login-page.png'));
  } catch (e) {
    console.error('ERR', e && (e.stack || e.message));
  } finally {
    await browser.close();
  }
})();
