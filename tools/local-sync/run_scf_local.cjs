// run_scf_local.cjs —— 本机执行 ENVSC 标记同步（与云函数同一份代码）
//
// 用途：云函数不可用（欠费/故障）时，由本机计划任务每天 14:58 执行，早于 15:00 推送；
//       另注册「登录时」触发，开机发现昨天数据缺失时补跑。
// 依赖：node（本机）+ tools/scf-marks-sync/index.js + 同目录 local-config.json（密钥，gitignore）
//
// 逻辑：
//   1) 目标日默认「昨天（北京时间）」，--quick=只同步 D-1；无参数=days=2；
//   2) 跳过检查（三档）：
//      - 默认：marks:<日期>.at 是今天 且 载荷 sync 完备（failCount==0 且 okCount==监测点总数）
//        → 跳过（--force 可忽略）；at 是今天但载荷缺 sync 字段（旧格式）→ 视为可信跳过；
//      - --quick 同上（每日 14:58 正式档：数据不全就补抓）；
//      - --if-missing：只要 marks:<日期> 存在即跳过（登录补跑档：只补缺，不覆盖，
//        避免抢在 14:58 正式档前面写"半成品"导致正式档被跳过）；
//   3) 同步前 ensureCookie：校验企业端 cookie（决策落日志），无效则调 auto-login 续期；
//   4) 调 SCF 的 main_handler 抓标记写 KV；失败 Bark 告警（每天一次）；
//   5) 日志：runtime/logs/scf-local-YYYY-MM-DD.log（1MB 轮转，保留 3 份）；
//      退出码 0=成功/跳过，1=失败。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { createLogger } = require('./lib/log');

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
// 项目业务配置（config/project.json；缺失字段用默认值兜底）
function loadProjectConfig() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config', 'project.json'), 'utf8'));
    return { psId: '654000000031', ...j };
  } catch (e) { return { psId: '654000000031' }; }
}
const CFG = loadConfig();
const PROJECT = loadProjectConfig();
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
const ifMissing = args.includes('--if-missing');
const daysArg = args.find((a) => /^\d+$/.test(a));
const days = quick ? 1 : Number(daysArg || 2);
const force = args.includes('--force');
const { log } = createLogger('scf-local', LOG_DIR);

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
    const psid = CNEMC.psid || PROJECT.psid || '654000000031';
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

// cookie 指纹（日志用，只暴露前 8 位，防泄漏）
const fp = (c) => (c ? c.replace(/^jointframe\.cluster\.sessionid=/, '').slice(0, 8) + '…' : '(空)');

async function ensureCookie() {
  const cur = readCookie();
  if (await cookieValid(cur)) { log(`cookie 有效（${fp(cur)}），无需续期`); return cur; }
  log(`cookie 无效/过期（${fp(cur)}）→ 调用自动登录续期…`);
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'auto-login', 'auto-login.cjs')], {
      timeout: 240000, stdio: 'ignore',
      env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '', ALL_PROXY: '', all_proxy: '' },
    });
    log('auto-login 子进程已返回');
  } catch (e) {
    log(`自动登录执行失败：${(e.message || e).toString().slice(0, 200)}`);
  }
  const fresh = readCookie();
  if (fresh && fresh !== cur && await cookieValid(fresh)) { log(`自动登录成功，cookie 已更新（${fp(fresh)}）`); return fresh; }
  log('自动登录后 cookie 仍无效（或未被更新）');
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

// 波次4：任务状态写 KV（供 Worker/排查读取，任务自身是否正常一目了然，不再靠人肉看 LastResult）
async function kvPutStatus(obj) {
  try {
    const r = await fetch(`${KV_BASE}/${encodeURIComponent('local-task:status')}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${CFG_CF.apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(obj),
    });
    return r.ok;
  } catch (e) { return false; }
}

// 完备性判定（2026-10-22 波次1）：at 是今天 ≠ 抓全。
// 新格式载荷（带 sync）：failCount==0 且 okCount==mpsTotal(>0) 才算可信；
// 旧格式载荷（无 sync）：保持旧语义（at 是今天即可信）。
function payloadComplete(m) {
  if (!m || !m.at) return { complete: false, why: '无载荷/at' };
  const atBJ = ymd(new Date(new Date(m.at).getTime() + TZ));
  if (atBJ !== todayBJ) return { complete: false, why: `at=${m.at}（北京 ${atBJ}，非今天）` };
  const s = m.sync;
  if (!s) return { complete: true, why: '旧格式载荷（无 sync 字段），at 今天视为可信' };
  if (s.failCount > 0) return { complete: false, why: `sync.failCount=${s.failCount}（${JSON.stringify(s.perMp || {})}）` };
  if (!(s.okCount > 0) || s.okCount !== s.mpsTotal) return { complete: false, why: `sync.okCount=${s.okCount} != mpsTotal=${s.mpsTotal}` };
  return { complete: true, why: `sync 完备（okCount=${s.okCount}，${new Date(m.at).toISOString().slice(11, 19)} 写入）` };
}

(async () => {
  log(`=== 开始：目标日=${date} days=${days} 本机日期=${todayBJ}${force ? ' (--force)' : ''}${quick ? ' (--quick)' : ''}${ifMissing ? ' (--if-missing)' : ''} ===`);
  let skip = null;
  try {
    const m = await kvGet(`marks:${date}`);
    if (ifMissing) {
      if (m) skip = `marks:${date} 已存在（--if-missing 只补缺不覆盖）`;
    } else if (m) {
      const chk = payloadComplete(m);
      if (chk.complete) skip = `marks:${date} 已同步且可信：${chk.why}`;
      else log(`marks:${date} 今天写过但不可信（${chk.why}）→ 重新抓取`);
    }
  } catch (e) {
    log(`KV 预检查失败（不阻断）：${e.message}`);
  }
  if (skip && !force) {
    log(`=== 跳过（${skip}）===`);
    await kvPutStatus({ at: new Date().toISOString(), date, result: 'skip', reason: skip });
    process.exit(0);
  }
  if (skip && force) log('(--force 忽略跳过检查)');

  const cookie = await ensureCookie();
  if (!cookie) {
    await alertOnceToday('envsc 本机同步失败', `目标日 ${date}：企业端 cookie 无效且自动登录续期失败，请检查 local-config.json / 手动更新 runtime/cnemc-cookie.txt`);
    log('=== 失败（cookie 不可用）===');
    await kvPutStatus({ at: new Date().toISOString(), date, result: 'fail', reason: 'cookie 不可用（自动登录续期失败）' });
    process.exit(1);
  }

  process.env.CNEMC_COOKIE = cookie;
  process.env.CF_ACCOUNT_ID = CFG_CF.accountId;
  process.env.CF_KV_NAMESPACE_ID = CFG_CF.kvNamespaceId;
  process.env.CF_API_TOKEN = CFG_CF.apiToken;
  process.env.CNEMC_PSID = CNEMC.psid || PROJECT.psid || '654000000031';
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
    await kvPutStatus({ at: new Date().toISOString(), date, result: r.ok ? 'ok' : 'fail', written: r.written, okCount: r.okCount, failCount: r.failCount });
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    log(`FATAL: ${e && (e.stack || e.message || e)}`);
    await alertOnceToday('envsc 本机同步异常', `目标日 ${date} 执行异常：${String(e && (e.message || e)).slice(0, 200)}`);
    await kvPutStatus({ at: new Date().toISOString(), date, result: 'exception', error: String(e && (e.message || e)).slice(0, 200) });
    process.exit(1);
  }
})();
