// run_scf_local.cjs —— 本机执行 ENVSC 标记同步（与腾讯云函数同一份代码）
//
// 用途：云函数不可用（欠费/故障）时，由本机计划任务每天 14:58 执行，早于 15:00 推送。
// 依赖：node（本机）+ tools/scf-marks-sync/index.js + 同目录 local-config.json（密钥，gitignore）
//
// 逻辑：
//   1) 目标日默认「昨天（北京时间）」，--quick=只同步 D-1；无参数=days=2；
//   2) 先查 KV marks:<日期>.at，若已是今天（云端或本机已同步）→ 跳过（--force 可忽略）；
//   3) 同步前 ensureCookie：校验企业端 cookie，无效则调用 auto-login 自动续期；
//   4) 调 SCF 的 main_handler 抓标记写 KV；失败 Bark 告警（每天一次）；
//   5) 日志：runtime/logs/scf-local-YYYY-MM-DD.log；退出码 0=成功/跳过，1=失败。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RUNTIME = path.join(__dirname, 'runtime');
const LOG_DIR = path.join(RUNTIME, 'logs');
const COOKIE_FILE = path.join(RUNTIME, 'cnemc-cookie.txt');
const CONFIG_FILE = path.join(__dirname, 'local-config.json');
fs.mkdirSync(LOG_DIR, { recursive: true });

// ---------- 配置（密钥外置，不随仓库分发） ----------
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) { /* ignore */ }
  return {};
}
const CFG = loadConfig();
const CNEMC = CFG.cnemc || {};
const CFG_CF = CFG.cloudflare || {};
const BARK = (CFG.bark || {}).key || process.env.BARK_KEY || '';

const TZ = 8 * 3600 * 1000;
const nowBJ = new Date(Date.now() + TZ);
const ymd = (d) => d.toISOString().slice(0, 10);
const todayBJ = ymd(nowBJ);
const yesterdayBJ = ymd(new Date(Date.now() + TZ - 86400000));

const args = process.argv.slice(2);
const dateArg = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const date = dateArg || yesterdayBJ;
const quick = args.includes('--quick');
const daysArg = args.find((a) => /^\d+$/.test(a));
const days = quick ? 1 : Number(daysArg || 2);
const force = args.includes('--force');
const logPath = path.join(LOG_DIR, `scf-local-${todayBJ}.log`);

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(logPath, line + '\n', 'utf8'); } catch (e) { /* ignore */ }
}

function readCookie() {
  try {
    if (fs.existsSync(COOKIE_FILE)) {
      const v = fs.readFileSync(COOKIE_FILE, 'utf8').trim();
      if (v) return v;
    }
  } catch (e) { /* ignore */ }
  return CNEMC.cookie || '';
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

async function cookieValid(cookie) {
  if (!cookie) return false;
  try {
    const psid = CNEMC.psid || '654000000031';
    const url = `http://116.178.28.170:3080/amOnline/app/baseroute/requestRoute!list.page?method=/psbase/mpinfo/getMpInfoByPsId&psId=${psid}&_t=${Date.now()}`;
    const r = await fetch(url, {
      headers: {
        Cookie: cookie, Accept: 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest', 'User-Agent': UA,
        Referer: 'http://116.178.28.170:3080/amOnline/zdjk-company-base/',
      },
    });
    const j = JSON.parse(await r.text());
    return j && String(j.code) === '200' && Array.isArray(j.data) && j.data.length > 0;
  } catch (e) { return false; }
}

async function ensureCookie() {
  const cur = readCookie();
  if (await cookieValid(cur)) { log('cookie 有效'); return cur; }
  log('cookie 无效/过期 → 调用自动登录续期…');
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'auto-login', 'auto-login.cjs')], {
      timeout: 240000, stdio: 'ignore',
      env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '', ALL_PROXY: '', all_proxy: '' },
    });
  } catch (e) {
    log(`自动登录执行失败：${(e.message || e).toString().slice(0, 200)}`);
  }
  const fresh = readCookie();
  if (fresh && fresh !== cur && await cookieValid(fresh)) { log('自动登录成功，cookie 已更新'); return fresh; }
  log('自动登录后 cookie 仍无效');
  return null;
}

const KV_BASE = `https://api.cloudflare.com/client/v4/accounts/${CFG_CF.accountId}/storage/kv/namespaces/${CFG_CF.kvNamespaceId}/values`;

async function alertOnceToday(title, body) {
  const marker = path.join(LOG_DIR, `.alerted-${todayBJ}`);
  if (fs.existsSync(marker)) { log('今日已告警过（Bark），跳过'); return; }
  if (!BARK) { log('未配置 Bark key，跳过告警'); return; }
  try {
    const r = await fetch(`https://api.day.app/${BARK}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body, level: 'timeSensitive', group: '有效传输率' }),
    });
    log(`Bark 告警已发送：HTTP ${r.status}`);
    if (r.ok) fs.writeFileSync(marker, new Date().toISOString(), 'utf8');
  } catch (e) {
    log(`Bark 告警失败：${e.message}`);
  }
}

async function kvGet(key) {
  const r = await fetch(`${KV_BASE}/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${CFG_CF.apiToken}` },
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`KV GET ${r.status}`);
  return JSON.parse(await r.text());
}

(async () => {
  log(`=== 开始：目标日=${date} days=${days} 本机日期=${todayBJ}${force ? ' (--force)' : ''} ===`);
  let already = false;
  try {
    const m = await kvGet(`marks:${date}`);
    if (m && m.at) {
      const atBJ = ymd(new Date(new Date(m.at).getTime() + TZ));
      if (atBJ === todayBJ) { already = true; log(`marks:${date} 已于今天 ${m.at} 同步过 → 跳过`); }
    }
  } catch (e) {
    log(`KV 预检查失败（不阻断）：${e.message}`);
  }
  if (already && !force) { log('=== 跳过（今日已同步，无需重复抓取）==='); process.exit(0); }
  if (already && force) log('(--force 忽略"今日已同步"检查)');

  const cookie = await ensureCookie();
  if (!cookie) {
    await alertOnceToday('envsc 本机同步失败', `目标日 ${date}：企业端 cookie 无效且自动登录续期失败，请检查 local-config.json / 手动更新 runtime/cnemc-cookie.txt`);
    log('=== 失败（cookie 不可用）===');
    process.exit(1);
  }

  process.env.CNEMC_COOKIE = cookie;
  process.env.CF_ACCOUNT_ID = CFG_CF.accountId;
  process.env.CF_KV_NAMESPACE_ID = CFG_CF.kvNamespaceId;
  process.env.CF_API_TOKEN = CFG_CF.apiToken;
  process.env.CNEMC_PSID = CNEMC.psid || '654000000031';
  process.env.DAYS = String(days);

  try {
    const mod = require(path.join(REPO_ROOT, 'tools', 'scf-marks-sync', 'index.js'));
    const r = await mod.main_handler({ date, days, silent: true }, {});
    log(`结果：ok=${r.ok} written=${JSON.stringify(r.written)} okCount=${r.okCount} failCount=${r.failCount}`);
    (r.log || []).forEach((l) => log('  ' + l));
    if (!r.ok) {
      const detail = (r.log || []).filter((l) => /ALERT|WARN|FAIL/.test(l)).slice(0, 3).join(' / ') || r.error || '未知原因';
      await alertOnceToday('envsc 本机同步失败', `目标日 ${date} 同步失败：${detail}\n请检查 runtime/cnemc-cookie.txt 与网络`);
    }
    log('=== 完成 ===');
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    log(`FATAL: ${e && (e.stack || e.message || e)}`);
    await alertOnceToday('envsc 本机同步异常', `目标日 ${date} 执行异常：${String(e && (e.message || e)).slice(0, 200)}`);
    process.exit(1);
  }
})();
