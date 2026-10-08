#!/usr/bin/env node
/**
 * marks-sync.mjs —— 本机抓取企业端「人工标记」并回写 Cloudflare Workers KV
 *
 * ⚠️ 状态（2026-09-24）：**已由腾讯云 SCF 云函数 `tools/scf-marks-sync/` 取代**，
 *   本机计划任务 ENVMarksSync 已禁用。本脚本仅作应急备用（需本机能连企业端 + CF）。
 *   已与云函数对齐：人工标记改用 /sign/qy/list，文本格式统一为「标记类型-详情 HH:mm~HH:mm(Nmin)」。
 *
 * 数据源（2026-09-24 起）：
 *   ① 人工标记 = `/sign/qy/list`（type=1~5 合并）→ 分钟级 startTime/endTime，**覆盖废水点**；
 *   ② 自动标记 = `online-monitor/data/list` 的 `zd_flag_*` 连续段（dateType=2 分钟，1440 行/天）；
 *   ③ 兜底：①失败时人工标记退回扫描同接口的 `rg_flag_*` 连续段。
 *   标记字段含义：zd_flag_XXX = 自动（自动监测设备维护标记）；rg_flag_XXX = 人工（人工填报的标记）。
 *   item.label 为 "--" 表示该分钟无此标记；扫描连续非 "--"（且非基线态）的分钟段即得精确起止分钟，
 *   **不含填报人 / 填报时间**（按需求剔除）。
 *   （历史说明：原 /sign/qy/list → 2026-09-22 曾改为纯分钟扫描 → 2026-09-24 因废水点无分钟数据，
 *     又回到 /sign/qy/list 作为人工标记首选，分钟扫描仅保留为自动标记与兜底。）
 *   推送时优先级：人工标记 > 自动标记；异常监测点若两者皆无，则仅推送其工况标记（如停运）。
 *
 * 为什么需要本机（2026-09-22 定论）：
 *   Cloudflare 边缘在境外，而企业端 116.178.28.170:3080 只对国内 IP 开放
 *   （境外直连超时；裸 IP 还会被 Cloudflare 以 1003 拒绝）。抓取必须发生在境内——
 *   本机就是最可靠、且长期免费的抓取端。抓完写 KV，边缘 envsc Worker 推送时直接读。
 *
 * 必填参数（后端 400 "缺少请求参数" 已逐一验证）：
 *   psId, id(监测点id), mpType, dateType, dateTime, isCity, netWorkType,
 *   normalKey, industryType('00'), zs, pageNum, pageSize, filterItem, filterWork, sort, props
 *
 * 用法：
 *   node tools/marks-sync.mjs [--date 2026-09-21] [--days 3] [--cookie <file|串>]
 *                              [--industry 00] [--mp <id>] [--dry]
 *     --date      目标日（默认 D-1）
 *     --days      往前补几天（含 --date），默认 1
 *     --cookie    cookie 文件或 cookie 串；默认 <workspace>/_dm_cookie.txt 或 $CNEMC_COOKIE
 *     --industry  industryType，默认 00（烟气/电力）
 *     --mp        只处理指定监测点 id（默认全部，调试用）
 *     --dry       只抓不写 KV，打印将要写入的内容
 *
 * 依赖：本机已登录的 wrangler（复用 OAuth，无需额外 API token）
 * 退出码：0 全部成功；2 cookie 失效；3 网络/接口错误；4 写 KV 失败
 */
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const PROJ_DIR = resolve(SELF_DIR, '..');
const CFG = join(PROJ_DIR, 'wrangler.toml');
const NODE = process.execPath;
const WRANGLER_JS = process.env.WRANGLER_JS
  || 'C:\\Users\\Sionis\\AppData\\Roaming\\npm\\node_modules\\wrangler\\bin\\wrangler.js';

const ROUTER = 'http://116.178.28.170:3080/amOnline/app/baseroute/requestRoute!list.page';
const PSID = process.env.CNEMC_PSID || '654000000031';
const REFERER = 'http://116.178.28.170:3080/amOnline/zdjk-company-base/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ---------- 参数 ----------
const argOf = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const hasFlag = (n) => process.argv.includes('--' + n);
const DRY = hasFlag('dry');
const DAYS = Math.max(1, parseInt(argOf('days', '1'), 10) || 1);
const INDUSTRY = argOf('industry', '00');
const ONLY_MP = argOf('mp', '');

// ---------- 日期（本机时区，与 Worker 的 UTC+8 口径一致） ----------
function ymd(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
const END = argOf('date', '') || ymd(new Date(Date.now() - 86400000));

// ---------- cookie ----------
function loadCookie() {
  const explicit = argOf('cookie', '');
  const cands = [explicit, process.env.CNEMC_COOKIE,
    join(resolve(PROJ_DIR, '..'), '_dm_cookie.txt'),
    join(resolve(PROJ_DIR, '..'), '_cookie_nl.txt')];
  for (const c of cands) {
    if (!c) continue;
    if (/sessionid=/i.test(c) && !existsSync(c)) return c.trim();
    try { const v = readFileSync(c, 'utf8').trim(); if (v) return v; } catch { /* next */ }
  }
  return '';
}
const COOKIE = loadCookie();

// ---------- HTTP ----------
const H = () => ({
  Cookie: COOKIE, Accept: 'application/json, text/plain, */*',
  'X-Requested-With': 'XMLHttpRequest', 'User-Agent': UA, Referer: REFERER,
});

async function req(method, params) {
  const qs = new URLSearchParams({ method, ...params, _t: String(Date.now()) });
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(`${ROUTER}?${qs}`, { headers: H() });
    const text = await r.text();
    if (r.status === 429) { await new Promise((s) => setTimeout(s, 1500 * (attempt + 1))); continue; }
    return { st: r.status, text };
  }
  return { st: 429, text: 'rate-limited' };
}

// ---------- 监测点列表 ----------
async function getMps() {
  const { st, text } = await req('/psbase/mpinfo/getMpInfoByPsId', { psId: PSID });
  if (st !== 200) throw new Error(`getMpInfoByPsId HTTP ${st}`);
  const j = JSON.parse(text);
  if (j.code !== 200) throw new Error(`getMpInfoByPsId code ${j.code}`);
  return (j.data || []).map((m) => ({ id: String(m.id), name: m.mpName, mpType: String(m.mpType) }));
}

// ---------- 单监测点单日 分钟数据 ----------
async function getMinute(mp, date) {
  const base = {
    psId: PSID, id: mp.id, mpType: mp.mpType, dateType: '2',
    dateTime: `${date} 00:00:00,${date} 23:59:59`,
    isCity: '0', netWorkType: '1', normalKey: '0', industryType: INDUSTRY, zs: '',
    pageNum: '1', pageSize: '3000', filterItem: '', filterWork: 'false', sort: '0',
    props: 'data_time,zd_workcordSc,rg_workcordSc',
  };
  const { st, text } = await req('online-monitor/data/list', base);
  if (st !== 200) throw new Error(`data/list HTTP ${st}`);
  const j = JSON.parse(text);
  if (j.code !== 200) throw new Error(`data/list code ${j.code} ${j.msg || ''}`);
  return j.data.rows || [];
}

// ---------- 从分钟行里提取设备级连续标记窗口（跨因子按 label 合并） ----------
// 同一设备标记（校准/故障/日常维护…）会在每个监测因子上各出现一次，逐因子罗列会重复；
// 这里跨因子按 label 合并为"设备级"连续段，并按时长计算分钟数（n = 跨度分钟）。
// 常态/无标记项，不算"标记窗口"（避免把"数据有效"等填满正文）
const BASELINE = new Set(['数据有效', '数据缺失', '通讯中断', '--']);
function toMs(t) { const d = new Date(String(t).replace(' ', 'T')); return isNaN(d.getTime()) ? 0 : d.getTime(); }
function extractWindows(rows, prefix) {
  const byLabel = {};
  for (const row of rows) {
    const t = row.data_time && row.data_time.item && row.data_time.item.label;
    if (!t) continue;
    for (const [k, v] of Object.entries(row)) {
      if (!k.startsWith(prefix)) continue;
      const it = v && v.item;
      const label = it && it.label;
      if (!label || label === '--' || BASELINE.has(label)) continue;
      const detail = (it.detail && (it.detail.r || it.detail.z)) || '';
      if (!byLabel[label]) byLabel[label] = { times: new Set(), detail };
      byLabel[label].times.add(t);
    }
  }
  const windows = [];
  for (const [label, info] of Object.entries(byLabel)) {
    const ts = [...info.times].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    let cur = null;
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i];
      const prev = ts[i - 1];
      const gap = prev ? toMs(t) - toMs(prev) : 0;
      if (!cur) cur = { label, detail: info.detail, start: t, end: t, n: 1 };
      else if (gap <= 60000) {
        cur.end = t;
        cur.n = Math.round((toMs(cur.end) - toMs(cur.start)) / 60000) + 1;
      } else { windows.push(cur); cur = { label, detail: info.detail, start: t, end: t, n: 1 }; }
    }
    if (cur) windows.push(cur);
  }
  return windows.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

// ---------- 人工标记：/sign/qy/list（填报记录接口，2026-09-24 启用） ----------
// 为什么用它：分钟数据接口对废水点（mpType=4，如「总排口」）恒返回 0 行，
//   只能用小时粒度 → 时间被抹成整点（18:00~20:00），与真实标记 18:22~19:13 不符。
//   /sign/qy/list（type=1~5 合并）一次请求返回**全部监测点**的人工填报记录，
//   自带分钟级 startTime/endTime 且**覆盖废水点**；实测起止与分钟段扫描完全一致。
//   按需剔除 updatedBy / updatedTime / reason（填报人、填报时间、说明）不进正文。
async function getQyMarks(date) {
  const byMp = new Map(); const seen = new Set();
  let okAny = false, got = 0, lastErr = null;
  for (const type of ['1', '2', '3', '4', '5']) {
    let rows = null;
    try {
      const { st, text } = await req('/sign/qy/list', {
        pageNum: '1', pageSize: '200',
        dateTime: `${date},${date}`, type, moduleCode: '', mpId: '-1', shId: '-1', psId: PSID, status: '-1',
      });
      if (st !== 200) throw new Error(`HTTP ${st}`);
      const j = JSON.parse(text);
      if (j.code !== 200) throw new Error(`code ${j.code} ${j.msg || ''}`);
      rows = (j.data && j.data.rows) || [];
      okAny = true;
    } catch (e) { lastErr = e; await new Promise((s) => setTimeout(s, 300)); continue; }
    for (const x of rows) {
      if (String(x.status == null ? '' : x.status) !== '1') continue; // 只取有效标记
      const name = String(x.mpName || '').trim();
      const label = String(x.reviseFlagName || '').trim();
      const start = String(x.startTime || '').trim();
      const end = String(x.endTime || '').trim();
      if (!name || !label || !start || !end) continue;
      const key = `${name}|${label}|${start}|${end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!byMp.has(name)) byMp.set(name, []);
      byMp.get(name).push({ label, detail: String(x.reviseFlagItemName || '').trim(), start, end });
      got++;
    }
    await new Promise((s) => setTimeout(s, 300));
  }
  if (!okAny) throw new Error(lastErr ? String(lastErr.message || lastErr) : 'all types failed');
  for (const list of byMp.values()) list.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return { byMp, got };
}

// ---------- 文本（与云函数 scf-marks-sync 完全一致：标记类型-详情、只留时分） ----------
const pad2 = (x) => String(x).padStart(2, '0');
const fmtHM = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const fmtDur = (n) => (n % 60 === 0 && n >= 60) ? `${n / 60}h` : `${n}min`;
// detail 中若重复 label 前缀（如 "校准 - 自动监测设备处于校准"）则剥掉，输出「校准-自动监测设备处于校准」
function markHead(label, detail) {
  let d = detail || '';
  const p = `${label} - `;
  if (d.startsWith(p)) d = d.slice(p.length);
  if (d === label) d = '';
  return d ? `${label}-${d}` : label;
}
function windowText(w) {
  return `${markHead(w.label, w.detail)} ${fmtHM(new Date(toMs(w.start)))}~${fmtHM(new Date(toMs(w.end)))}(${fmtDur(w.n)})`;
}
// 填报记录渲染（时长为含首尾的分钟数，与分钟段口径一致）
function qyText(list) {
  return list.map((w) => {
    const n = Math.max(1, Math.round((toMs(w.end) - toMs(w.start)) / 60000) + 1);
    return `${markHead(w.label, w.detail)} ${fmtHM(new Date(toMs(w.start)))}~${fmtHM(new Date(toMs(w.end)))}(${fmtDur(n)})`;
  }).join('；');
}

// ---------- 写 KV ----------
function putKV(key, obj) {
  const dir = mkdtempSync(join(tmpdir(), 'marks-sync-'));
  const file = join(dir, 'value.json');
  writeFileSync(file, JSON.stringify(obj), 'utf8');
  // ⚠️ 必须带 --remote：wrangler 4 的 kv key 命令默认操作**本地**存储，
  //    不加就写进 .wrangler/state，边缘 Worker 根本读不到（曾导致"SYNC_OK 但线上无数据"）
  execFileSync(NODE, [WRANGLER_JS, 'kv', 'key', 'put', key, '--binding', 'ENVSC_KV', '--config', CFG, '--remote', '--path', file], {
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

// ---------- 主流程 ----------
(async () => {
  if (!COOKIE) {
    console.log('SYNC_FAIL no-cookie：找不到企业端会话 cookie');
    process.exit(2);
  }
  let mps;
  try { mps = await getMps(); } catch (e) { console.log('SYNC_FAIL 取监测点失败：' + e.message); process.exit(3); }
  if (ONLY_MP) mps = mps.filter((m) => m.id === ONLY_MP);
  if (!mps.length) { console.log('SYNC_FAIL 无监测点'); process.exit(3); }

  const dates = [];
  for (let i = 0; i < DAYS; i++) {
    dates.push(ymd(new Date(new Date(END + 'T00:00:00').getTime() - i * 86400000)));
  }

  let failed = false;
  for (const date of dates) {
    const byMp = {};
    let total = 0;
    // 人工标记首选来源：填报记录接口（分钟级精确起止，含废水点）
    let qyMap = new Map();
    try {
      const qy = await getQyMarks(date);
      qyMap = qy.byMp;
      console.log(`[${date}] sign/qy/list 命中 ${qyMap.size} 个监测点 / ${qy.got} 条人工标记`);
    } catch (e) {
      console.log(`SYNC_WARN ${date} sign/qy/list 失败：${e.message}（人工标记回退到分钟行扫描）`);
    }
    for (const mp of mps) {
      let rows;
      try { rows = await getMinute(mp, date); }
      catch (e) {
        console.log(`SYNC_WARN ${date} ${mp.name} 抓取失败：${e.message}`);
        failed = true; await new Promise((s) => setTimeout(s, 1000)); continue;
      }
      // 设备标记：人工 优先，自动(zd_flag_) 兜底；分钟级起止，不含填报人/填报时间
      // 自动标记仅在持续 >15 分钟时才影响"整点有效数据≥45min"判定（HJ 75-2017），
      // 故过滤掉 ≤15 分钟的自动窗口，避免把无影响的例行维护/短校准刷屏。
      const rg = extractWindows(rows, 'rg_flag_');
      const zd = extractWindows(rows, 'zd_flag_').filter((w) => w.n > 15);
      const qyList = qyMap.get(mp.name) || null;
      // 人工标记：填报记录（精确）> 分钟行 rg_flag_ 扫描（兜底）
      const manualText = (qyList && qyList.length) ? qyText(qyList)
        : (rg.length ? rg.map(windowText).join('；') : null);
      const autoText = zd.length ? zd.map(windowText).join('；') : null;
      const manualN = (qyList && qyList.length) ? qyList.length : rg.length;
      if (manualText || autoText) {
        byMp[mp.name] = { manual: manualText, auto: autoText };
        total += manualN; // 人工标记条数
      }
      // 打印（调试用，复用 windowText/qyText 保证与落库格式一致）
      console.log(`[${date}] ${mp.name} 分钟行=${rows.length} 人工=${manualN}${qyList && qyList.length ? '(qy)' : ''} 自动=${zd.length}`);
      if (manualText) console.log(`    人工: ${manualText}`);
      zd.forEach((w) => console.log(`    自动: ${windowText(w)}`));
      await new Promise((s) => setTimeout(s, 800)); // 避免 429
    }
    const payload = { total, byMp, at: new Date().toISOString() };
    if (DRY) {
      console.log(`[dry] date=${date} key=marks:${date} payload=${JSON.stringify(payload)}`);
      continue;
    }
    try {
      putKV(`marks:${date}`, payload);
      console.log(`SYNC_OK date=${date} total=${total} 监测点=${Object.keys(byMp).length} -> KV marks:${date}`);
    } catch (e) {
      console.log(`SYNC_FAIL date=${date} 写 KV 失败：${(e && e.stderr) || (e && e.message) || e}`);
      failed = true;
    }
  }
  process.exit(failed ? 3 : 0);
})();
