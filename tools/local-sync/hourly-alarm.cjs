// hourly-alarm.cjs —— 小时超标自动告警（本机运行，企业端小时数据）
//
// 背景：平台只提供查询接口（无推送）。本脚本补上「轮询 → 阈值判定 → 推送」的最后一公里：
//   1) 取企业端「小时行」（online-monitor/data/list，dateType=1），每行含各因子
//      avg_value_<code>（实测）、outlet_standard_<code>（标准值）、flag_<code>（数据有效性）；
//   2) 判定：见 lib/exceed.js（compare=avg_value|o2_corrected|max，minRatio，requireValid）；
//   3) 去重：KV `alarm:<date>:<hour>:<mp>:<code>`（TTL 3 天），同一小时同一因子只告警一次；
//   4) 推送：Bark（一次运行合并一条）；无超标则不打扰；
//   5) 状态：KV `last-hourly-alarm`（供排查）。
//
// 用法：
//   node hourly-alarm.cjs                    # 默认：检查最近 2 个已完成小时
//   node hourly-alarm.cjs --date 2026-10-22 --hour 15   # 指定小时（补跑/验证）
//   node hourly-alarm.cjs --dry-run          # 只打印不推送、不写去重
//
// 依赖：local-config.json（cnemc.cookie/psid、cloudflare、bark）
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { createLogger } = require('./lib/log');
const { judgePoint, num, cell } = require('./lib/exceed');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RUNTIME = path.join(__dirname, 'runtime');
const CONFIG_FILE = path.join(__dirname, 'local-config.json');
const COOKIE_FILE = path.join(RUNTIME, 'cnemc-cookie.txt');
const NAMES_FILE = path.join(RUNTIME, 'factor-names.json');
const { log } = createLogger('hourly-alarm', path.join(RUNTIME, 'logs'));

const ROUTER = 'http://116.178.28.170:3080/amOnline/app/baseroute/requestRoute!list.page';
const REFERER = 'http://116.178.28.170:3080/amOnline/zdjk-company-base/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// ---------- 配置 ----------
function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
const CFG = loadJson(CONFIG_FILE, {});
const PROJECT = loadJson(path.join(REPO_ROOT, 'config', 'project.json'), {});
// 标准限值兜底表（平台未返回 outlet_standard 时使用）
const STD_OVERRIDE = loadJson(path.join(REPO_ROOT, 'config', 'standards.json'), {});
function stdOverride(mpName, code) {
  const byMp = STD_OVERRIDE[mpName] || {};
  const v = byMp[code] != null ? byMp[code] : (STD_OVERRIDE['*'] || {})[code];
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
const ALARM = Object.assign({
  enabled: true,
  compare: 'auto',
  baseO2: null,
  o2Code: 'S01',
  minRatio: 1.0,
  requireValid: true,
  maxItemsPerPush: 10,
}, PROJECT.hourlyAlarm || {});
const CNEMC = CFG.cnemc || {};
const CF = CFG.cloudflare || {};
const BARK = (CFG.bark || {}).key || process.env.BARK_KEY || '';
const PSID = CNEMC.psid || PROJECT.psId || '654000000031';

// 因子编码 → 名称（优先 runtime 缓存，按 mpId 索引；缓存由每日同步写入）
const FALLBACK_NAMES = {
  '001': '颗粒物', '002': '二氧化硫', '003': '氮氧化物',
  S01: '氧含量', S02: '流速', S03: '温度', S05: '湿度', S08: '压力', B01: '流量', B02: '流量',
};
const NAMES = loadJson(NAMES_FILE, {});
function factorName(mpId, code) {
  const m = NAMES[mpId];
  if (m && m[code]) return m[code];
  return FALLBACK_NAMES[code] || code;
}

const TZ = 8 * 3600 * 1000;
const ymd = (ms) => new Date(ms + TZ).toISOString().slice(0, 10);
const nowMs = Date.now();

// ---------- 参数 ----------
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose');
const dateArg = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const hourIdx = args.indexOf('--hour');
const hourArg = hourIdx >= 0 ? Number(args[hourIdx + 1]) : null;

// 目标小时（北京时间整点，毫秒）
function targetHours() {
  if (dateArg && Number.isInteger(hourArg) && hourArg >= 0 && hourArg <= 23) {
    const t = new Date(`${dateArg}T${String(hourArg).padStart(2, '0')}:00:00+08:00`).getTime();
    return [t];
  }
  // 最近 2 个已完成小时（当前小时的上一小时、上上小时）
  const curHourStart = Math.floor((nowMs + TZ) / 3600000) * 3600000 - TZ;
  return [curHourStart - 3600000, curHourStart - 7200000];
}

// ---------- 企业端 ----------
function readCookie() {
  try {
    const v = fs.existsSync(COOKIE_FILE) ? fs.readFileSync(COOKIE_FILE, 'utf8').trim() : '';
    if (v) return v;
  } catch (e) { /* ignore */ }
  return CNEMC.cookie || '';
}
const fp = (c) => (c ? c.replace(/^jointframe\.cluster\.sessionid=/, '').slice(0, 8) + '…' : '(空)');

async function cookieValid(cookie) {
  if (!cookie) return false;
  try {
    const r = await fetch(`${ROUTER}?method=/psbase/mpinfo/getMpInfoByPsId&psId=${PSID}&_t=${Date.now()}`, {
      headers: { Cookie: cookie, Accept: 'application/json, text/plain, */*', 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': UA, Referer: REFERER },
    });
    const j = JSON.parse(await r.text());
    return j && String(j.code) === '200' && Array.isArray(j.data) && j.data.length > 0;
  } catch (e) { return false; }
}

async function ensureCookie() {
  const cur = readCookie();
  if (await cookieValid(cur)) return cur;
  log(`cookie 无效（${fp(cur)}）→ 自动登录续期…`);
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'auto-login', 'auto-login.cjs')], {
      timeout: 600000, stdio: 'ignore',
      env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '', ALL_PROXY: '', all_proxy: '' },
    });
  } catch (e) { log(`自动登录失败：${String(e.message || e).slice(0, 160)}`); }
  const fresh = readCookie();
  if (fresh && await cookieValid(fresh)) { log(`续期成功（${fp(fresh)}）`); return fresh; }
  log('续期后 cookie 仍无效');
  return null;
}

const H = (cookie) => ({ Cookie: cookie, Accept: 'application/json, text/plain, */*', 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': UA, Referer: REFERER });

async function getMps(cookie) {
  const r = await fetch(`${ROUTER}?method=/psbase/mpinfo/getMpInfoByPsId&psId=${PSID}&_t=${Date.now()}`, { headers: H(cookie) });
  const j = JSON.parse(await r.text());
  if (String(j.code) !== '200') throw new Error(`getMps code=${j.code}`);
  return (j.data || []).map((m) => ({ id: m.id, name: m.mpName, mpType: m.mpType }));
}

async function getHourRows(cookie, mp, day) {
  const qs = new URLSearchParams({
    method: 'online-monitor/data/list', psId: PSID, id: mp.id, mpType: mp.mpType,
    dateType: '1', dateTime: `${day} 00:00:00,${day} 23:59:59`,
    isCity: '0', netWorkType: '1', normalKey: '0', industryType: '00', zs: '',
    pageNum: '1', pageSize: '200', filterItem: '', filterWork: 'false', sort: '0',
    // 自动带上所有 avg_value_* / outlet_standard_* / flag_*（按因子编码）
    props: buildProps(), _t: String(Date.now()),
  });
  const r = await fetch(`${ROUTER}?${qs}`, { headers: H(cookie) });
  const j = JSON.parse(await r.text());
  if (String(j.code) !== '200') throw new Error(`data/list code=${j.code}`);
  return (j.data && j.data.rows) || [];
}

// 由已知因子编码生成 props（含全部常见 code；接口对未知字段返回 "--"，无副作用）
const CODES = ['001', '002', '003', '004', '005', '011', '012', 'S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'B01', 'B02'];
function buildProps() {
  const parts = ['data_time'];
  for (const c of CODES) parts.push(`avg_value_${c}`, `outlet_standard_${c}`, `flag_${c}`);
  return parts.join(',');
}

// 图表序列接口：按因子返回 24 个小时点（dateType=1）的实测/折算数组。
// 2026-10-23 实测确认：avg_value[] 实测、avg_zs[] 折算（废气有、废水无）；
// 该接口的 label/prop 字段用的是默认模板（不可靠），故用「实测值匹配」把行对齐到 factor code。
async function getViewRows(cookie, mp, day) {
  const qs = new URLSearchParams({
    method: '/online-monitor/view/list', psId: PSID, id: mp.id, mpType: String(mp.mpType),
    dateType: '1', dateTime: `${day} 00:00:00,${day} 23:59:59`,
    isCity: '0', netWorkType: '1', normalKey: '0', industryType: '00', zs: '',
    pageNum: '1', pageSize: '300', filterItem: '', filterWork: 'false', sort: '0', _t: String(Date.now()),
  });
  const r = await fetch(`${ROUTER}?${qs}`, { headers: H(cookie) });
  const j = JSON.parse(await r.text());
  if (String(j.code) !== '200') throw new Error(`view/list code=${j.code}`);
  return (j.data && j.data.rows) || [];
}

// ---------- KV ----------
const KV_BASE = `https://api.cloudflare.com/client/v4/accounts/${CF.accountId}/storage/kv/namespaces/${CF.kvNamespaceId}/values`;
async function kvGet(key) {
  const r = await fetch(`${KV_BASE}/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${CF.apiToken}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`KV GET ${r.status}`);
  return r.text();
}
async function kvPut(key, value, ttl) {
  const q = ttl ? `?expiration_ttl=${ttl}` : '';
  let lastErr;
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(`${KV_BASE}/${encodeURIComponent(key)}${q}`, {
        method: 'PUT', headers: { Authorization: `Bearer ${CF.apiToken}`, 'Content-Type': 'application/json' }, body: value,
      });
      if (r.ok) return true;
      lastErr = new Error(`KV PUT ${r.status}`);
    } catch (e) { lastErr = e; }
    await new Promise((res) => setTimeout(res, 500 * 2 ** i));
  }
  throw lastErr;
}

// ---------- 推送 ----------
async function pushBark(title, body) {
  if (!BARK) return { ok: false, error: '未配置 Bark key' };
  try {
    const r = await fetch(`https://api.day.app/${BARK}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body, level: 'timeSensitive', group: '小时超标' }),
    });
    const j = JSON.parse(await r.text());
    return { ok: j && j.code === 200, resp: j };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}

// ---------- 主流程 ----------
(async () => {
  const hours = targetHours();
  const hourKeys = hours.map((t) => ({ ms: t, date: ymd(t), hour: Number(new Date(t + TZ).toISOString().slice(11, 13)) }));
  log(`=== 开始（${dryRun ? 'dry-run' : '正式'}）：目标 ${hourKeys.map((h) => `${h.date} ${h.hour}时`).join('、')} | compare=${ALARM.compare} minRatio=${ALARM.minRatio} ===`);

  if (!ALARM.enabled) { log('hourlyAlarm.enabled=false → 跳过'); process.exit(0); }

  const cookie = await ensureCookie();
  if (!cookie) {
    log('=== 失败（cookie 不可用，每日同步会另行告警）===');
    if (!dryRun && CF.apiToken) {
      try { await kvPut('last-hourly-alarm', JSON.stringify({ at: new Date().toISOString(), ok: false, error: 'cookie 不可用' })); } catch (e) { /* ignore */ }
    }
    process.exit(1);
  }

  let mps;
  try { mps = await getMps(cookie); }
  catch (e) {
    log(`=== 失败（取监测点）：${e.message} ===`);
    process.exit(1);
  }

  // 按日期取小时行（每个日期只取一次/点）
  const dates = [...new Set(hourKeys.map((h) => h.date))];
  const hitByHour = new Map(); // "date hour" -> [{mp, code, ...}]
  const missingStd = new Set(); // 有数值但无标准值（无法判定）的因子
  let checkedFactors = 0;
  for (const day of dates) {
    for (const mp of mps) {
      let rows;
      try { rows = await getHourRows(cookie, mp, day); }
      catch (e) { log(`WARN ${day} ${mp.name} 取数失败：${e.message}`); continue; }
      const isGas = String(mp.mpType) !== '4'; // mpType=4 为废水（无折算）；其余按废气
      let viewRows = null;
      if (isGas) {
        try { viewRows = await getViewRows(cookie, mp, day); }
        catch (e) { log(`WARN ${day} ${mp.name} 折算序列取数失败：${e.message}（退回实测）`); }
      }
      for (const hk of hourKeys.filter((x) => x.date === day)) {
        const prefix = `${day} ${String(hk.hour).padStart(2, '0')}`;
        const row = rows.find((r) => String((r.data_time && r.data_time.item && r.data_time.item.label) || '').startsWith(prefix));
        if (!row) continue;
        // ① 实测/标准/有效性（按因子编码，来自 data/list，逐字段可靠；标准缺失时用 standards.json 兜底）
        const perCode = {};
        for (const code of CODES) {
          const v = num((cell(row, `avg_value_${code}`) || {}).label);
          if (v == null) continue;
          const sPlatform = num((cell(row, `outlet_standard_${code}`) || {}).label);
          const f = (cell(row, `flag_${code}`) || {}).label || '';
          const sOverride = sPlatform == null ? stdOverride(mp.name, code) : null;
          const s = sPlatform != null ? sPlatform : sOverride;
          if (s == null) {
            // 工况参数（S0x/B0x）本身没有限值，不计入"缺标准"
            if (!/^[SB]\d{2}$/i.test(code)) missingStd.add(`${mp.name}/${code}`);
            continue;
          }
          perCode[code] = { value: v, standard: s, flag: f, stdSource: sPlatform != null ? 'platform' : 'override' };
        }
        // ② 废气折算：view/list 的 avg_zs[hour]（数组下标 = 小时）；用实测值匹配到因子编码
        const zsByCode = {};
        if (viewRows && viewRows.length) {
          for (const vr of viewRows) {
            const series = Array.isArray(vr.avg_value) ? vr.avg_value : [];
            const zsArr = Array.isArray(vr.avg_zs) ? vr.avg_zs : [];
            const hv = num(series[hk.hour]);
            const hz = num(zsArr[hk.hour]);
            if (hv == null || hz == null) continue;
            const hit = Object.entries(perCode).find(([, x]) => Math.abs(x.value - hv) < 1e-6);
            if (hit) zsByCode[hit[0]] = hz;
          }
        }
        // ③ 判定：废气用折算（有则用）、废水用实测
        for (const [code, pc] of Object.entries(perCode)) {
          const ev = judgePoint(pc.value, zsByCode[code], pc.standard, pc.flag, {
            requireValid: ALARM.requireValid,
            minRatio: ALARM.minRatio,
            useZs: isGas && ALARM.compare !== 'avg_value',
          });
          if (!ev) continue;
          checkedFactors++;
          if (verbose) {
            log(`  [eval] ${hk.date} ${hk.hour}时 ${mp.name} ${code} 实测=${ev.value} 折算=${ev.zs == null ? '-' : ev.zs} 判定值=${Number(ev.judged.toFixed(3))} 标准=${ev.standard}(${pc.stdSource}) ratio=${ev.ratio.toFixed(3)} flag=${ev.flag} valid=${ev.valid} usedZs=${ev.usedZs}`);
          }
          if (!ev.exceeded) continue;
          const key = `${hk.date} ${hk.hour}`;
          if (!hitByHour.has(key)) hitByHour.set(key, []);
          hitByHour.get(key).push({ mp: mp.name, code, name: factorName(mp.id, code), ...ev, hourKey: key, isGas });
        }
      }
    }
  }

  const all = [...hitByHour.entries()].flatMap(([hourKey, items]) => items.map((it) => ({ ...it, hourKey })));
  log(`检索完成：数值因子 ${checkedFactors} 个，超标命中 ${all.length} 条`);
  if (missingStd.size) log(`缺少标准值（无法判定）${missingStd.size} 项：${[...missingStd].slice(0, 20).join('、')}${missingStd.size > 20 ? ' …' : ''}（可在 config/standards.json 补充）`);

  // 去重
  const fresh = [];
  for (const it of all) {
    const key = `alarm:${it.hourKey.replace(' ', ':')}:${it.mp}:${it.code}`;
    if (dryRun) { fresh.push({ ...it, dedupKey: key }); continue; }
    let seen = null;
    try { seen = await kvGet(key); } catch (e) { /* 读失败按未告警处理 */ }
    if (seen) { log(`DEDUP ${key}`); continue; }
    fresh.push({ ...it, dedupKey: key });
  }

  if (!fresh.length) {
    log('=== 完成（无新增超标）===');
    if (!dryRun && CF.apiToken) {
      try { await kvPut('last-hourly-alarm', JSON.stringify({ at: new Date().toISOString(), ok: true, checked: checkedFactors, exceeded: all.length, pushed: 0, missingStd: missingStd.size, missingSample: [...missingStd].slice(0, 20) })); } catch (e) { /* ignore */ }
    }
    process.exit(0);
  }

  // 组装文案
  const maxItems = Number.isFinite(ALARM.maxItemsPerPush) ? ALARM.maxItemsPerPush : 10;
  const shown = fresh.slice(0, maxItems);
  const lines = shown.map((it) => {
    const ratioPct = Math.round((it.ratio - 1) * 100);
    const val = Number(it.judged.toFixed(3));
    const head = it.usedZs ? '折算 ' : '';
    const extra = it.usedZs ? `（实测 ${Number(it.value.toFixed(3))}）` : '';
    return `· ${it.hourKey.slice(5)}时 ${it.mp} ${it.name} ${head}${val}${extra}（标准 ${it.standard}，超 ${ratioPct}%）`;
  });
  if (fresh.length > shown.length) lines.push(`…另有 ${fresh.length - shown.length} 条未展示`);
  const body = lines.join('\n');
  const title = `⚠️ 小时超标 ${fresh[0].hourKey.slice(0, 10)}`;

  for (const it of shown) log(`EXCEED ${it.hourKey} ${it.mp} ${it.name}=${it.judged} 标准=${it.standard} ratio=${it.ratio.toFixed(2)} flag=${it.flag}`);

  if (dryRun) {
    console.log(`\n[DRY-RUN] ${title}\n${body}\n`);
    log('=== 完成（dry-run，未推送/未写去重）===');
    process.exit(0);
  }

  const r = await pushBark(title, body);
  log(`Bark: ${JSON.stringify(r).slice(0, 200)}`);
  if (r.ok) {
    for (const it of shown) {
      try { await kvPut(it.dedupKey, new Date().toISOString(), 3 * 86400); } catch (e) { log(`WARN 写去重失败 ${it.dedupKey}: ${e.message}`); }
    }
  }
  if (CF.apiToken) {
    try {
      await kvPut('last-hourly-alarm', JSON.stringify({
        at: new Date().toISOString(), ok: r.ok, checked: checkedFactors,
        exceeded: all.length, pushed: r.ok ? shown.length : 0, title,
        missingStd: missingStd.size, missingSample: [...missingStd].slice(0, 20),
      }));
    } catch (e) { /* ignore */ }
  }
  log('=== 完成 ===');
  process.exit(r.ok ? 0 : 1);
})().catch((e) => {
  log(`FATAL: ${e && (e.stack || e.message || e)}`);
  process.exit(1);
});
