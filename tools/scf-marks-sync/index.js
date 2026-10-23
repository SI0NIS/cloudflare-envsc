/**
 * 腾讯云 SCF 云函数：定时抓取企业端设备标记 → 写 Cloudflare Workers KV
 *
 * 人工标记来源（2026-09-24 关键修正）：
 *   - **首选 `/sign/qy/list`（type=1~5 合并）**：企业端「人工标记填报记录」接口，
 *     一次请求返回**全部监测点**的标记，自带分钟级 startTime/endTime，
 *     且**覆盖废水点**。实测其起止与分钟段扫描完全一致（16:58~17:30(33min) 等）。
 *     为什么必须靠它：分钟数据接口对废水点（mpType=4，如「总排口」）恒返回 0 行，
 *     只能用小时粒度 → 时间被抹成整点（18:00~20:00），与真实标记 18:22~19:13 不符。
 *     只取 status=1（有效）的标记；**不入正文**：updatedBy / updatedTime / reason。
 *   - **兜底**：数据行 `rg_flag_*` 连续段扫描（/sign/qy/list 异常时仍可用）。
 *
 * 粒度自适应（2026-09-23 关键修正）：
 *   - mpType=4（废水，如「总排口」）**只有小时数据**，必须用 dateType=1（24 行/天）；
 *     分钟接口 dateType=2 对废水点恒返回 0 行 —— 这正是"废水人工标记取不到"的根因。
 *   - 其余（废气 mpType=5）用 dateType=2（1440 行/天）。
 *   两种粒度行都带 rg_flag_*(人工) / zd_flag_*(自动) 字段：
 *     rg_flag_ 仅作兜底；zd_flag_（自动标记）按两条规则纳入：
 *       ① 连续段 ≥15min（含中间缺 1 分钟容错）；
 *       ② 单个自然小时内累计覆盖 ≥15min（不要求连续，2026-10-19 用户要求）。
 *   ⚠️ 小时行的 data_time.item.label 形如 "2026-09-22 18~19"（区间），需专门解析起点整点。
 *
 * 平台（同一份代码通用，2026-09-27 起）：
 *   - 腾讯云 SCF：入口 exports.main_handler；但免费额度**只有开通前 3 个月**，
 *     之后每月扣基础套餐费（约 ¥10/月），故已不推荐。
 *   - 阿里云函数计算 FC：入口 exports.handler（Handler 填 `index.handler`）；
 *     免费额度 100 万次调用 + 40 万 GB-s/月，**无时限**，默认可出公网 → 首选。
 *   - 华为云 FunctionGraph：同为 100 万次 + 40 万 GB-s/月，入口也用 exports.handler。
 *
 * 其他设计：
 *   - 企业端 116.178.28.170:3080 只对国内 IP 开放（且只开 3080 端口）→ 抓取必须在境内；
 *   - 只用定时触发器 + 出网 HTTPS，不需要公网入口（不涉及 API 网关费用）；
 *     可选加 HTTP 触发器实现手机随手触发（见文件末尾 exports.handler，需配 ACCESS_TOKEN）；
 *   - cookie 失效 → 直接 Bark 告警（KV 幂等，当天只推一次）；登录有滑块验证故不做自动登录。
 *
 * 运行时：Node.js 18（内置 global fetch）
 * 触发：定时触发器（北京时间 12:55，跑在 Worker 13:00 推送前）
 *       阿里云 cron 默认 UTC → 填 `0 55 4 * * *` 或 `CRON_TZ=Asia/Shanghai 0 55 12 * * *`
 * 建议配置：超时 120s、内存 256MB
 *
 * 环境变量：
 *   CNEMC_COOKIE        企业端会话 cookie（jointframe.cluster.sessionid=xxxx）
 *   CF_ACCOUNT_ID / CF_KV_NAMESPACE_ID / CF_API_TOKEN   Cloudflare KV 写入凭据
 *   BARK_KEY            Bark key（失效告警；不配则只记日志）
 *   CNEMC_PSID（默认 654000000031）/ DAYS（默认 2）/ INDUSTRY_TYPE（默认 '00'）
 *
 * 测试：{} 正常跑；{"dry":true} 只抓不写；{"silent":true} 抑制告警；{"cookie":"x"} 模拟失效。
 */

const ROUTER = 'http://116.178.28.170:3080/amOnline/app/baseroute/requestRoute!list.page';
const REFERER = 'http://116.178.28.170:3080/amOnline/zdjk-company-base/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const envOf = (e, k, d) => (e && e[k] != null && e[k] !== '') ? String(e[k]) : d;
const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

// ---------- 项目业务配置（config/project.json；单文件部署到云端时文件不存在 → 内置默认值兜底） ----------
const PROJECT_DEFAULTS = {
  psId: '654000000031',
  thresholds: { autoMarkMinMinutes: 15, autoMarkMinPerHour: 15 },
};
function loadProjectConfig() {
  try {
    const fs = require('fs');
    const path = require('path');
    const raw = fs.readFileSync(path.join(__dirname, '..', '..', 'config', 'project.json'), 'utf8');
    const j = JSON.parse(raw);
    return { ...PROJECT_DEFAULTS, ...j, thresholds: { ...PROJECT_DEFAULTS.thresholds, ...(j.thresholds || {}) } };
  } catch (e) {
    return PROJECT_DEFAULTS;
  }
}
const PROJECT = loadProjectConfig();

// ---------- Cloudflare KV（REST API） ----------
async function getKV(acc, ns, token, key) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acc}/storage/kv/namespaces/${ns}/values/${encodeURIComponent(key)}`,
    { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`KV GET ${r.status}`);
  return await r.text();
}
// 写 KV：带重试（2026-10-19 实测 SCF→api.cloudflare.com 偶发 fetch failed，重试可显著降低丢写概率）
async function putKV(acc, ns, token, key, value, ttl) {
  const q = ttl ? `?expiration_ttl=${ttl}` : '';
  const url = `https://api.cloudflare.com/client/v4/accounts/${acc}/storage/kv/namespaces/${ns}/values/${encodeURIComponent(key)}${q}`;
  let lastErr;
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, {
        method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: value,
      });
      const t = await r.text();
      if (!r.ok) throw new Error(`KV PUT ${r.status}: ${t.slice(0, 240)}`);
      return t;
    } catch (e) {
      lastErr = e;
      if (i < 3) await sleep(1200 * (i + 1)); // 1.2s / 2.4s / 3.6s 退避
    }
  }
  throw lastErr;
}

// ---------- Bark 告警 ----------
async function pushBark(key, title, body) {
  if (!key) return { ok: false, error: 'no BARK_KEY' };
  try {
    const r = await fetch(`https://api.day.app/${key}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body, level: 'timeSensitive', group: '有效传输率' }),
    });
    const t = await r.text();
    let j = {}; try { j = JSON.parse(t); } catch { j = { raw: t.slice(0, 120) }; }
    return { ok: j.code === 200, resp: j };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}

// ---------- 企业端请求 ----------
const H = (cookie) => ({
  Cookie: cookie, Accept: 'application/json, text/plain, */*',
  'X-Requested-With': 'XMLHttpRequest', 'User-Agent': UA, Referer: REFERER,
});
async function req(cookie, method, params) {
  const qs = new URLSearchParams({ method, ...params, _t: String(Date.now()) });
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(`${ROUTER}?${qs}`, { headers: H(cookie) });
    const text = await r.text();
    if (r.status === 429) { await sleep(1500 * (attempt + 1)); continue; }
    return { st: r.status, text };
  }
  return { st: 429, text: 'rate-limited' };
}
async function getMps(cookie, psid) {
  const { st, text } = await req(cookie, '/psbase/mpinfo/getMpInfoByPsId', { psId: psid });
  if (st !== 200) throw new Error(`getMpInfoByPsId HTTP ${st}`);
  const j = JSON.parse(text);
  if (j.code !== 200) throw new Error(`getMpInfoByPsId code ${j.code}`);
  return (j.data || []).map((m) => ({ id: String(m.id), name: m.mpName, mpType: String(m.mpType) }));
}
// 废水(mpType=4) → dateType=1 小时；其余 → dateType=2 分钟
const dateTypeOf = (mp) => (mp.mpType === '4' ? '1' : '2');
const rowMinutesOf = (mp) => (mp.mpType === '4' ? 60 : 1);

async function getRows(cookie, psid, industry, mp, date) {
  const base = {
    psId: psid, id: mp.id, mpType: mp.mpType, dateType: dateTypeOf(mp),
    dateTime: `${date} 00:00:00,${date} 23:59:59`,
    isCity: '0', netWorkType: '1', normalKey: '0', industryType: industry, zs: '',
    pageNum: '1', pageSize: '3000', filterItem: '', filterWork: 'false', sort: '0',
    props: 'data_time,zd_workcordSc,rg_workcordSc',
  };
  const { st, text } = await req(cookie, 'online-monitor/data/list', base);
  if (st !== 200) throw new Error(`data/list HTTP ${st}`);
  const j = JSON.parse(text);
  if (j.code !== 200) throw new Error(`data/list code ${j.code} ${j.msg || ''}`);
  return (j.data && j.data.rows) || [];
}

// ---------- 提取设备级连续标记窗口（跨因子按 label 合并） ----------
// 小时行 label 形如 "2026-09-22 18~19"（区间），取起点整点
function rowStart(label, rowMinutes) {
  const t = String(label || '');
  if (rowMinutes >= 60) {
    const m = t.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2})/);
    if (m) return `${m[1]} ${String(m[2]).padStart(2, '0')}:00:00`;
  }
  return t;
}
const BASELINE = new Set(['数据有效', '数据缺失', '通讯中断', '--']);
function toMs(t) { const d = new Date(String(t).replace(' ', 'T')); return isNaN(d.getTime()) ? 0 : d.getTime(); }

function extractWindows(rows, prefix, rowMinutes) {
  const stepMs = rowMinutes * 60000;
  // key = `${label}|${factorCode}`：**按监测因子分别成段**（2026-10-06 新规则），
  // 否则同一时段的二氧化硫/氮氧化物会被并成一条，看不出是哪个因子被标记。
  const byLabel = {};
  for (const row of rows) {
    const raw = row.data_time && row.data_time.item && row.data_time.item.label;
    if (!raw) continue;
    const t = rowStart(raw, rowMinutes);
    for (const [k, v] of Object.entries(row)) {
      if (!k.startsWith(prefix)) continue;
      const it = v && v.item;
      const label = it && it.label;
      if (!label || label === '--' || BASELINE.has(label)) continue;
      const detail = (it.detail && (it.detail.r || it.detail.z)) || '';
      const code = k.slice(prefix.length); // 'zd_flag_002' -> '002'
      const key = `${label}|${code}`;
      if (!byLabel[key]) byLabel[key] = { times: new Set(), detail, label, code };
      byLabel[key].times.add(t);
    }
  }
  const windows = [];
  for (const info of Object.values(byLabel)) {
    const { label, code, detail } = info;
    const ts = [...info.times].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    let cur = null;
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i], prev = ts[i - 1];
      const gap = prev ? toMs(t) - toMs(prev) : 0;
      // 容忍中间缺 1 个采样点（gap ≤ 2 个步长）：平台偶发缺分钟会把一段连续标记切断，
      // 严格按 1 步长判定会让"15:29~15:47"这种真实约 19 分钟的段被拆成 11min+7min 而整段被 15min 门槛丢掉
      // （2026-10-16 环保尾气排放口实例）。
      if (!cur) cur = { label, detail, code, start: t, end: t, n: rowMinutes, rowMinutes };
      else if (gap <= stepMs * 2) { cur.end = t; cur.n = Math.round((toMs(cur.end) - toMs(cur.start)) / 60000) + rowMinutes; }
      else { windows.push(cur); cur = { label, detail, code, start: t, end: t, n: rowMinutes, rowMinutes }; }
    }
    if (cur) windows.push(cur);
  }
  return windows.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

// ---------- 连续标记段合并（2026-10-06 新规则） ----------
// 背景：`extractWindows` 按 label 分组，HJ 75-2017 的「>15min」又是对**每个 label 段**
//   单独判定的，于是「一段连续标记期内不同内容交替」时，短段会被全部丢弃。
//   实测 2026-10-05 3号机组：14:43~16:30 连续自动标记，其中
//     14:43~14:51(9min)校准 / 14:52~14:53(2min)故障 / 14:54(1min)校准 /
//     14:55(1min)故障 / 14:56~16:30(95min)校准
//   逐段判定只有最后一段 >15min 被保留，前四段（含 14:43 起的 9min 校准）全部丢失。
// 新规则：**连续性按「有没有标记」判定（跨 label 合并不留缝）**，
//   连续标记总时长 ≥15min 的整段都保留，段内各 label 的子段按时间分别列出。
function mergeContinuous(windows, rowMinutes, minMinutes) {
  if (!windows.length) return [];
  const stepMs = rowMinutes * 60000;
  const minMs = (minMinutes || 15) * 60000;
  // 每个窗口的"占用区间" = [start, start + n*step]，跨 label 首尾相接即视为连续
  const items = windows.map((w) => ({ w, s: toMs(w.start), e: toMs(w.start) + w.n * stepMs }));
  items.sort((a, b) => a.s - b.s);

  // ① 先按"有标记即连续"合并成若干条连续标记链
  const chains = [];
  let cur = null;
  for (const it of items) {
    if (!cur) { cur = { s: it.s, e: it.e, parts: [it] }; continue; }
    if (it.s <= cur.e) { cur.e = Math.max(cur.e, it.e); cur.parts.push(it); } // 相接/重叠 → 同一条链
    else { chains.push(cur); cur = { s: it.s, e: it.e, parts: [it] }; }
  }
  if (cur) chains.push(cur);

  // ② 连续标记总时长 ≥15min 的链条整条保留；链内子段按时间排序输出
  const out = [];
  for (const ch of chains) {
    if (ch.e - ch.s < minMs) continue; // 整条链都不足 15min → 丢弃
    ch.parts.sort((a, b) => a.s - b.s);
    for (const p of ch.parts) out.push(p.w);
  }
  return out;
}

// ---------- 监测因子名（2026-10-06 新规则） ----------
// zd_flag_<code> 里的 <code> 就是企业端的 pollutantCode（001 颗粒物 / 002 二氧化硫 /
// 003 氮氧化物 / S01 氧含量 …）。企业端 data/list 只给编号不给名称，
// 而公开平台 /psinfo/pollutant/list 同时给 code + name → 用它建映射。
//
// ⚠️ **同一 code 在不同监测点含义不同**（2026-10-07 实测）：`011` 在 3号机组是「氮氧化物」类，
// 在总排口是「氯气」；若用一张全局 Map 会被后加载的点覆盖、导致串名。
// 因此改为**按监测点隔离**：MP_FACTOR_NAMES[mpId] = Map(code → name)。
const MP_FACTOR_NAMES = new Map();       // mpId -> Map(code -> name)
const FACTOR_LOADED = new Map();         // mpId -> true（本实例内已取到非空因子名，后续日期不再重复抓取，2026-10-22 波次4）
const PARAM_CODE = /^[SB]\d{2}$/i;       // 工况参数编码（流量/流速/温度/湿度/压力/氧含量…）
const FACTOR_NAMES = new Map();          // 兼容旧测试：最近一次加载的点
// 拉取某监测点某天的「因子编号 → 名称」表（公开平台；必须带 date，当天无数据时接口返回空 list）
async function fetchFactorNamesOfDay(mpId, day) {
  const url = new URL('https://jkzx.envsc.cn/transpublic-v2/psinfo/pollutant/list');
  url.searchParams.set('_t', String(Date.now()));
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Referer: 'https://jkzx.envsc.cn/transpublic-v2/2026/' },
    body: JSON.stringify({
      psId: envOf(process.env, 'CNEMC_PSID', PROJECT.psId), mpId, dateType: 'DAY',
      start: `${day} 00:00:00`, end: `${day} 23:59:59`,
    }),
  });
  const list = (JSON.parse(await r.text()).data) || [];
  const map = new Map();
  for (const f of list) {
    const code = String(f.pollutantCode || '');
    // 污染物与工况参数一视同仁：只要平台给了名称就收录（2026-10-07 用户要求工况参数也推送）。
    // 平台返回 null 名称的（如废水 B01）跳过 —— 无名可显示。
    if (code && f.pollutantName) map.set(code, f.pollutantName);
  }
  return map;
}

// 2026-10-19：平台 D-1 的因子列表约 13:06 才更新，而同步在 12:55 跑 → 目标日可能为空，
// 导致推送缺因子名。因子编号→名称 与日期无关，故目标日为空时依次回退前一/二天。
async function loadFactorNames(mpId, dateStr) {
  const key = String(mpId);
  // 波次4：因子编号→名称与日期无关，同一实例内已取到非空结果就不再重复抓取（days=2 时省一半请求）。
  if (FACTOR_LOADED.get(key)) {
    const cached = MP_FACTOR_NAMES.get(key);
    if (cached && cached.size) {
      FACTOR_NAMES.clear();
      for (const [k, v] of cached) FACTOR_NAMES.set(k, v);
      return cached.size;
    }
  }
  let map = new Map();
  try {
    const day = dateStr || ymd(new Date());
    const base = new Date(`${day}T00:00:00`);
    const days = [day];
    for (let i = 1; i <= 2; i++) days.push(ymd(new Date(base.getTime() - i * 86400000)));
    for (const d of days) {
      try {
        const m = await fetchFactorNamesOfDay(mpId, d);
        if (m.size) { map = m; break; }
      } catch (e) { /* 换下一天重试 */ }
      await sleep(150);
    }
    if (!map.size) {
      const prev = MP_FACTOR_NAMES.get(key); // 同一实例内先前取到的非空结果优先保留
      if (prev && prev.size) map = prev;
    }
    MP_FACTOR_NAMES.set(key, map);
    if (map.size) {
      FACTOR_LOADED.set(key, true);
      FACTOR_NAMES.clear();
      for (const [k, v] of map) FACTOR_NAMES.set(k, v);
    } else {
      say(`FACTOR_WARN ${mpId} 连续 3 天均未取到因子名（标记将不带因子名）`);
    }
  } catch (e) {
    say(`FACTOR_WARN 因子名获取失败：${e.message}（标记将不带因子名）`);
  }
  return map.size;
}
// 取某监测点的 code→name 表（回退到全局表，保持单测与旧调用可用）
function factorMapOf(mpId) {
  return MP_FACTOR_NAMES.get(String(mpId)) || FACTOR_NAMES;
}
// 标记前缀：因子名。工况参数（流量/流速/温度/湿度/压力/氧含量）同样展示（2026-10-07）
function factorNameOf(w, mpId) {
  const code = String(w.code || '');
  if (!code) return '';
  return factorMapOf(mpId).get(code) || FACTOR_NAMES.get(code) || '';
}

// ---------- 文本（精简版） ----------
const pad2 = (x) => String(x).padStart(2, '0');
const fmtHM = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const fmtDur = (n) => (n % 60 === 0 && n >= 60) ? `${n / 60}h` : `${n}min`;

// 时段文本："14:43~14:51(9min)"
// 分钟级：结束显示"最后一个被标记的分钟"；小时级：显示覆盖区间的结束整点
function spanText(w) {
  const st = toMs(w.start);
  const rm = w.rowMinutes || 1;
  const ed = rm >= 60 ? st + w.n * 60000 : st + (w.n - 1) * 60000;
  return `${fmtHM(new Date(st))}~${fmtHM(new Date(ed))}(${fmtDur(w.n)})`;
}

function windowText(w, mpId) {
  const span = spanText(w);
  // 已合并的段：label = 因子名组合，markLabel = 原标记类型 → "二氧化硫/氮氧化物 校准 14:43~14:51(9min)"
  if (w.markLabel) return `${w.label} ${w.markLabel} ${span}`;
  // 未合并的段：沿用旧格式（标记类型-详情 时段）
  let d = w.detail || '';
  const p = w.label + ' - ';
  if (d.startsWith(p)) d = d.slice(p.length); else if (d === w.label) d = '';
  const head = d ? `${w.label}-${d}` : w.label;
  // 单因子时也带因子名（2026-10-06 新规则）
  const fn = factorNameOf(w, mpId);
  return `${fn ? fn + ' ' : ''}${head} ${span}`; // 只留时分，不带 MM-DD（推送标题已含日期）
}

// 同一时刻多个因子被**同样标记**时（二氧化硫/氮氧化物常同步），
//   合并成一条，因子名用 '/' 连接：'二氧化硫/氮氧化物 校准 14:43~14:51(9min)'，避免刷屏。
// 实现：把因子名塞进 label，并清空 code，使 windowText 不再重复加前缀。
function mergeSameLabelSegs(windows, mpId) {
  const byKey = new Map();
  for (const w of windows) {
    const key = `${w.label}|${toMs(w.start)}|${w.n}`;
    if (byKey.has(key)) byKey.get(key).factors.add(factorNameOf(w, mpId));
    else byKey.set(key, { ...w, factors: new Set([factorNameOf(w, mpId)]) });
  }
  return [...byKey.values()].map((g) => {
    const names = [...g.factors].filter(Boolean).sort();
    // 有因子名 → label 存因子名组合、markLabel 存原标记类型；无因子名 → 保持原样
    if (!names.length) return { ...g, markLabel: '' };
    return { ...g, label: names.join('/'), markLabel: g.label, code: '' };
  });
}

// 同因子只列一次名，其后各段只写「标记类型 时段」（2026-10-06 精简规则）：
//   二氧化硫/氮氧化物 校准 14:43~14:51(9min)；故障 14:52~14:53(2min)；校准 14:56~16:30(95min)；
//   颗粒物 日常维护 15:25~15:30(6min)；校准 15:52~15:57(6min)
// 不同因子用 '；' 分组，组内因子名只在首段出现，后续段直接跟 '；'。
function segsText(segs, mpId) {
  const groups = [];   // [{factor, parts:[文本]}]
  let cur = null;
  for (const s of segs) {
    const f = s.markLabel ? s.label : '';   // 有因子名才有"组"的概念
    const body = s.markLabel ? `${s.markLabel} ${spanText(s)}` : windowText(s, mpId);
    if (f && f !== cur?.factor) { cur = { factor: f, parts: [body] }; groups.push(cur); }
    else if (f && cur) { cur.parts.push(body); }   // 同组后续段：不重复因子名
    else { groups.push({ factor: '', parts: [body] }); cur = null; }  // 无因子名：各自独立
  }
  return groups.map((g) => (g.factor ? `${g.factor} ${g.parts.join('；')}` : g.parts.join('；'))).join('；\n');
}

// ---------- 人工标记：/sign/qy/list（填报记录接口，2026-09-24 启用） ----------
// 为什么用它：分钟数据接口对废水点（mpType=4，如「总排口」）恒返回 0 行，
//   只能用小时粒度 → 时间被抹成整点（18:00~20:00），与真实标记 18:22~19:13 不符。
//   /sign/qy/list（type=2）一次请求返回**全部监测点**的人工填报记录，自带
//   startTime/endTime（分钟级，且覆盖废水点）、reviseFlagName + reviseFlagItemName、
//   reason（说明）。经 2026-09-22 实测：其起止与我们分钟段扫描结果完全一致
//   （如 16:58~17:30(33min)、12:35~16:17(223min)），故作为人工标记的**首选来源**，
//   分钟数据扫描退化为兜底（接口异常时仍可用）。
//   按需剔除 updatedBy / updatedTime（填报人、填报时间）不进推送正文。
async function getQyMarks(cookie, psid, date) {
  const TYPES = ['1', '2', '3', '4', '5']; // 实测数据都在 type=2（自动监测设备维护），其余类别沿用同参数一并查，避免漏标
  const byMp = new Map();
  const seen = new Set();
  let okAny = false, lastErr = null, got = 0;
  for (const type of TYPES) {
    let rows = null;
    try {
      const { st, text } = await req(cookie, '/sign/qy/list', {
        pageNum: '1', pageSize: '200',
        dateTime: `${date},${date}`, type, moduleCode: '', mpId: '-1', shId: '-1', psId: psid, status: '-1',
      });
      if (st !== 200) throw new Error(`HTTP ${st}`);
      const j = JSON.parse(text);
      if (j.code !== 200) throw new Error(`code ${j.code} ${j.msg || ''}`);
      rows = (j.data && j.data.rows) || [];
      okAny = true;
    } catch (e) { lastErr = e; await sleep(300); continue; }
    for (const x of rows) {
      if (String(x.status == null ? '' : x.status) !== '1') continue; // 只取有效标记
      const name = String(x.mpName || '').trim();
      const label = String(x.reviseFlagName || '').trim();
      const start = String(x.startTime || '').trim();
      const end = String(x.endTime || '').trim();
      if (!name || !label || !start || !end) continue;
      const key = `${name}|${label}|${start}|${end}`;
      if (seen.has(key)) continue; // 不同 type 间去重
      seen.add(key);
      if (!byMp.has(name)) byMp.set(name, []);
      // monitorCodeList="002,003" / monitorName="二氧化硫,氮氧化物" —— 人工标记的监测因子（2026-10-07）
      // 两者按同序一一对应。工况参数（流量/流速/温度/湿度/压力/氧含量）与污染物**一视同仁**，
      // 只要 monitorName 有名字就展示（2026-10-07 用户要求）；无名（如废水 B01）自然被 filter 掉。
      const names = String(x.monitorName || '').split(',').map((s) => s.trim()).filter(Boolean);
      byMp.get(name).push({ label, detail: String(x.reviseFlagItemName || '').trim(), start, end, factors: names });
      got++;
    }
    await sleep(300);
  }
  if (!okAny) throw new Error(lastErr ? String(lastErr.message || lastErr) : 'all types failed');
  return { byMp, got };
}

// 用填报记录渲染人工标记文本（口径与分钟段一致：时长为含首尾的分钟数）
// 2026-10-07：前缀监测因子名；同一因子的多段只在首段列名，其后只写「标记类型-详情 时段」（与自动标记同规则）
function qyText(list) {
  const groups = [];
  let cur = null;
  for (const w of list) {
    const n = Math.max(1, Math.round((toMs(w.end) - toMs(w.start)) / 60000) + 1);
    const head = w.detail && w.detail !== w.label ? `${w.label}-${w.detail}` : w.label;
    const span = `${fmtHM(new Date(toMs(w.start)))}~${fmtHM(new Date(toMs(w.end)))}(${fmtDur(n)})`;
    const f = (w.factors && w.factors.length) ? w.factors.join('/') : '';
    const body = `${head} ${span}`;
    if (f && f !== cur?.factor) { cur = { factor: f, parts: [body] }; groups.push(cur); }
    else if (f && cur) { cur.parts.push(body); }
    else { groups.push({ factor: '', parts: [body] }); cur = null; }
  }
  return groups.map((g) => (g.factor ? `${g.factor} ${g.parts.join('；')}` : g.parts.join('；'))).join('；\n');
}

// ---------- 事件归一化（一份代码同时支持腾讯云 SCF / 阿里云 FC） ----------
// 阿里云 FC 的 event 是 Buffer；定时触发器 event 形如 { triggerTime, triggerName, payload }，
// 控制台「触发消息」填的 JSON 串会原样落在 payload 里（默认填的是 "awesome-fc"）。
function normalize(e) {
  let v = e;
  if (Buffer.isBuffer(v)) v = v.toString('utf8');
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return {};
    try { v = JSON.parse(s); } catch { return {}; }
  }
  return (v && typeof v === 'object') ? v : {};
}
function payloadEvent(raw) {
  if (raw && typeof raw.payload === 'string') {
    const s = raw.payload.trim();
    if (s.startsWith('{')) { try { return JSON.parse(s); } catch { return {}; } }
  }
  return raw || {};
}

// ---------- 主入口 ----------
// 导出内部函数供单测使用（不改变云端行为）
// 规则B（2026-10-19 用户要求）：不要求连续——单个自然小时内标记累计 ≥15min 也保留，
// 即"占该小时数据 ≥15 分钟"的分钟级标记同样进推送（例如一小时里 3 段各 6 分钟的校准）。
// 说明：同一分钟被多个因子同时标记只计 1 次（按"分钟覆盖"去重，避免多因子重复计数抬高覆盖）。
function keepByHourCoverage(windows, rowMinutes, minPerHour) {
  const min = minPerHour || 15;
  const stepMs = rowMinutes * 60000;
  const byHour = new Map(); // 小时起点 -> { minutes:Set<采样时刻>, wins:Set<窗口> }
  for (const w of windows) {
    const s = toMs(w.start);
    const n = w.n || rowMinutes;
    for (let i = 0; i < n; i += rowMinutes) {
      const t = s + i * stepMs;
      const h = Math.floor(t / 3600000) * 3600000;
      if (!byHour.has(h)) byHour.set(h, { minutes: new Set(), wins: new Set() });
      const rec = byHour.get(h);
      rec.minutes.add(t);
      rec.wins.add(w);
    }
  }
  const keep = new Set();
  for (const [, rec] of byHour) {
    if (rec.minutes.size >= min) for (const w of rec.wins) keep.add(w);
  }
  return [...keep];
}

exports._test = { mergeContinuous, mergeSameLabelSegs, extractWindows, windowText, segsText, FACTOR_NAMES, MP_FACTOR_NAMES, PARAM_CODE, qyText, factorNameOf, factorMapOf, keepByHourCoverage, autoSegV2, qySegV2, manualRgSegV2, segSpan };

// ---------- marks v2 结构化载荷（2026-10-22 波次2：KV 文本协议 → 结构化契约） ----------
// 段结构：{ factors:[], head, start:"HH:mm", end:"HH:mm", minutes:N }
//   head 为最终展示文本头（label / label-detail / markLabel 规则在此一次定型），
//   start/end/minutes 为最终展示值（与 v1 spanText/qyText 输出逐字节一致）。
// 消费方（Worker）只做：结构化区间覆盖抑制 + 分组序列化，不再解析文本。
function segSpan(w) { // 与 spanText 相同的时间计算，输出结构化三元组
  const rm = w.rowMinutes || 1;
  const st = toMs(w.start);
  const ed = rm >= 60 ? st + w.n * 60000 : st + (w.n - 1) * 60000;
  return { start: fmtHM(new Date(st)), end: fmtHM(new Date(ed)), minutes: w.n };
}
function autoSegV2(w) {
  const span = segSpan(w);
  if (w.markLabel) return { factors: w.label.split('/'), head: w.markLabel, ...span };
  let d = w.detail || '';
  const p = w.label + ' - ';
  if (d.startsWith(p)) d = d.slice(p.length); else if (d === w.label) d = '';
  return { factors: [], head: d ? `${w.label}-${d}` : w.label, ...span };
}
function qySegV2(w) {
  const n = Math.max(1, Math.round((toMs(w.end) - toMs(w.start)) / 60000) + 1);
  const head = w.detail && w.detail !== w.label ? `${w.label}-${w.detail}` : w.label;
  return { factors: (w.factors || []).slice(), head, start: fmtHM(new Date(toMs(w.start))), end: fmtHM(new Date(toMs(w.end))), minutes: n };
}
function manualRgSegV2(w, mpId) { // rg 兜底：与 windowText 同款头部
  const span = segSpan(w);
  let d = w.detail || '';
  const p = w.label + ' - ';
  if (d.startsWith(p)) d = d.slice(p.length); else if (d === w.label) d = '';
  const fn = factorNameOf(w, mpId);
  return { factors: fn ? [fn] : [], head: d ? `${w.label}-${d}` : w.label, ...span };
}

exports.main_handler = async (event, context) => {
  const ev = event || {};
  const cookie = envOf(ev, 'cookie', process.env.CNEMC_COOKIE || '');
  const psid = envOf(ev, 'psid', process.env.CNEMC_PSID || PROJECT.psId);
  const industry = envOf(ev, 'industry', process.env.INDUSTRY_TYPE || '00');
  const days = Math.max(1, parseInt(envOf(ev, 'days', process.env.DAYS || '2'), 10) || 2);
  const dry = !!ev.dry, silent = !!ev.silent;
  const acc = process.env.CF_ACCOUNT_ID, ns = process.env.CF_KV_NAMESPACE_ID, token = process.env.CF_API_TOKEN, bark = process.env.BARK_KEY;

  const log = []; const say = (s) => { console.log(s); log.push(s); };
  const date0 = ev.date || ymd(new Date(Date.now() - 86400000));

  const canKV = !!(acc && ns && token);
  const alertKey = `cookieAlert:${date0}`;
  const alertOnce = async (title, body) => {
    say(`ALERT ${title} | ${body}`);
    if (silent) { say('[silent] 已抑制推送'); return 'silent'; }
    if (canKV) { try { if (await getKV(acc, ns, token, alertKey)) { say('[dedup] 当天已告警过，跳过推送'); return 'dedup'; } } catch { /* ignore */ } }
    const r = await pushBark(bark, title, body);
    say(`Bark push: ${JSON.stringify(r)}`);
    if (canKV) { try { await putKV(acc, ns, token, alertKey, new Date().toISOString(), 86400); } catch { /* ignore */ } }
    return r;
  };

  // ---------- 维护动作（手动运维用，不依赖企业端 cookie） ----------
  // {"clearDedup":"2026-09-22"}  删除 Worker 去重键（用于强制重推某天）
  // {"setDedup":"2026-09-22"}    写回去重键（用于「按住」推送，避免整点 cron 抢先）
  // {"triggerWorker":"https://..."}  让云函数代为调用 Worker（本机到 CF 不通时用）
  if (ev.clearDedup || ev.setDedup || ev.triggerWorker || ev.dumpRows) {
    const out = {};
    const valUrl = (k) => `https://api.cloudflare.com/client/v4/accounts/${acc}/storage/kv/namespaces/${ns}/values/${encodeURIComponent(k)}`;
    if (ev.clearDedup && canKV) {
      try {
        const r = await fetch(valUrl(ev.clearDedup), { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
        out.cleared = { key: ev.clearDedup, status: r.status };
        say(`CLEAR_DEDUP ${ev.clearDedup} -> ${r.status}`);
      } catch (e) { out.cleared = { key: ev.clearDedup, error: String(e.message || e) }; }
    }
    if (ev.setDedup && canKV) {
      try {
        const body = JSON.stringify({ unitRate: null, isCase1: null, at: new Date().toISOString(), held: true });
        const r = await fetch(valUrl(ev.setDedup), { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body });
        out.setDedup = { key: ev.setDedup, status: r.status };
        say(`SET_DEDUP ${ev.setDedup} -> ${r.status}`);
      } catch (e) { out.setDedup = { key: ev.setDedup, error: String(e.message || e) }; }
    }
    if (ev.triggerWorker) {
      try {
        const r = await fetch(ev.triggerWorker);
        const t = await r.text();
        out.worker = { status: r.status, body: t.slice(0, 2000) };
        say(`TRIGGER_WORKER -> ${r.status}`);
      } catch (e) { out.worker = { error: String(e.message || e) }; }
    }
    // {"dumpRows":"2026-10-16","mp":"3号机组"}  诊断：抓原始标记字段（只读，不写 KV、不告警）
    // 排查"某天标记突然变空"用：看 /sign/qy/list 各 type 的条数与状态、行数据里 flag 字段是否存在。
    if (ev.dumpRows) {
      const dateD = String(ev.dumpRows);
      const dump = { date: dateD, qy: {}, rows: {} };
      // ① 人工标记原始响应（type 1~5，status=-1 不筛；看返回条数与每条 status 值）
      for (const type of ['1', '2', '3', '4', '5']) {
        try {
          const { st, text } = await req(cookie, '/sign/qy/list', {
            pageNum: '1', pageSize: '200', dateTime: `${dateD},${dateD}`, type,
            moduleCode: '', mpId: '-1', shId: '-1', psId: psid, status: '-1',
          });
          let count = null, sample = text.slice(0, 200);
          try {
            const j2 = JSON.parse(text);
            const rows2 = (j2.data && j2.data.rows) || [];
            count = rows2.length;
            sample = rows2.slice(0, 2).map((x) => ({
              mpName: x.mpName, reviseFlagName: x.reviseFlagName, startTime: x.startTime,
              endTime: x.endTime, status: x.status, monitorName: x.monitorName,
            }));
          } catch (e2) { /* 保留原文 */ }
          dump.qy[type] = { st, count, sample };
        } catch (e2) { dump.qy[type] = { error: String(e2.message || e2) }; }
        await sleep(200);
      }
      // ② 行数据：生产同款 props 抓一次，看 flag 字段与样本
      try {
        const mps2 = await getMps(cookie, psid);
        const want = String(ev.mp || '3号机组');
        const mp2 = mps2.find((m) => String(m.name).indexOf(want) >= 0) || mps2.find((m) => m.mpType === '5');
        if (!mp2) throw new Error('no matching mp');
        const qs = new URLSearchParams({
          method: 'online-monitor/data/list', psId: psid, id: mp2.id, mpType: mp2.mpType,
          dateType: String(dateTypeOf(mp2)), dateTime: `${dateD} 00:00:00,${dateD} 23:59:59`,
          isCity: '0', netWorkType: '1', normalKey: '0', industryType: industry, zs: '',
          pageNum: '1', pageSize: '3000', filterItem: '', filterWork: 'false', sort: '0',
          props: 'data_time,zd_workcordSc,rg_workcordSc', _t: String(Date.now()),
        });
        const r2 = await fetch(`${ROUTER}?${qs}`, { headers: H(cookie) });
        const t2 = await r2.text();
        try {
          const j2 = JSON.parse(t2);
          const rows2 = (j2.data && j2.data.rows) || [];
          const keys = new Set();
          let flagged = null;
          const labelStats = {}; // 每个 zd/rg_flag 字段上出现过的 label 及次数
          const minutes = {};    // 每个字段的非"数据有效"分钟明细（时间|标签，最多 200 条）
          const samples = [];    // 含非基线标记的整行样本（最多 2 行，看 workcord 等复合字段）
          for (const row of rows2) {
            const tt = (row.data_time && row.data_time.item && row.data_time.item.label) || '';
            let interesting = false;
            for (const [k, v] of Object.entries(row)) {
              if (!/^(zd|rg)_flag_/.test(k)) continue;
              const lb = v && v.item && v.item.label;
              if (!lb) continue;
              labelStats[k] = labelStats[k] || {};
              labelStats[k][lb] = (labelStats[k][lb] || 0) + 1;
              if (lb === '数据有效' || lb === '--') continue;
              minutes[k] = minutes[k] || [];
              if (minutes[k].length < 200) minutes[k].push(`${tt}|${lb}`);
              interesting = true;
            }
            if (interesting && samples.length < 2) samples.push(row);
            for (const [k, v] of Object.entries(row)) {
              if (!/flag/i.test(k) && !/workcord/i.test(k)) continue;
              keys.add(k);
              const lb = v && v.item && v.item.label;
              if (!flagged && lb && lb !== '--') flagged = { key: k, item: v.item, dataTime: row.data_time && row.data_time.item && row.data_time.item.label };
            }
          }
          dump.rows = {
            mp: mp2.name, mpType: mp2.mpType, rowCount: rows2.length,
            fieldKeys: [...keys].slice(0, 20),
            labelStats,
            minutes,
            samples,
            sampleFlagged: flagged,
          };
        } catch (e2) { dump.rows = { status: r2.status, bodyHead: t2.slice(0, 300) }; }
      } catch (e2) { dump.rows = { error: String(e2.message || e2) }; }
      say(`DUMP_ROWS ${dateD} done`);
      return { ok: true, dump, log };
    }
    return { ok: true, ...out, log };
  }

  if (!cookie) {
    await alertOnce('envsc 同步告警', 'SCF 未配置企业端 cookie（CNEMC_COOKIE），标记同步已停止。');
    return { ok: false, error: 'no-cookie' };
  }
  if (!dry && !canKV) return { ok: false, error: 'no-cf-cred' };

  let mps;
  try { mps = await getMps(cookie, psid); }
  catch (e) {
    await alertOnce('envsc 同步告警：cookie 可能已失效', `企业端接口不可用（${String(e.message || e)}）。请更新 SCF 环境变量 CNEMC_COOKIE。`);
    return { ok: false, error: 'getMps', detail: String(e.message || e), alerted: true, log };
  }
  if (!mps.length) {
    await alertOnce('envsc 同步告警：cookie 可能已失效', '企业端返回 0 个监测点，通常是会话失效。请更新 SCF 环境变量 CNEMC_COOKIE。');
    return { ok: false, error: 'no-mp', alerted: true, log };
  }

  const dates = [];
  for (let i = 0; i < days; i++) dates.push(ymd(new Date(new Date(date0 + 'T00:00:00').getTime() - i * 86400000)));

  let okCount = 0, failCount = 0;
  const written = [];
  const perMp = {}; // 每个监测点当次抓取状态（供消费方做完备性检查）
  for (const date of dates) {
    const byMp = {}; let total = 0;
    const pointsV2 = {}; // marks v2 结构化载荷（与 byMp 同条件写入）
    // 监测因子编号 → 名称（公开平台；**必须带 date**，当天无数据时接口返回空 list）
    FACTOR_NAMES.clear();
    for (const m of mps) { if (m.id) await loadFactorNames(m.id, date); }
    say(`[${date}] FACTOR_NAMES 载入 ${FACTOR_NAMES.size} 个污染物因子名`);
    // 人工标记首选来源：填报记录接口（分钟级精确起止，含废水点）
    let qyMap = new Map();
    try {
      const qy = await getQyMarks(cookie, psid, date);
      qyMap = qy.byMp;
      for (const list of qyMap.values()) list.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
      say(`[${date}] sign/qy/list 命中 ${qyMap.size} 个监测点 / ${qy.got} 条人工标记`);
    } catch (e) {
      say(`SYNC_WARN ${date} sign/qy/list 失败：${e.message}（人工标记回退到数据行扫描）`);
    }
    // 波次4：并发 2 路抓取（原串行 + sleep(800)/点，5 点约 40~60s → 并发后 ~20s，为 14:40→15:00 窗口留余量）
    const processMp = async (mp) => {
      const logs = [];
      const rm = rowMinutesOf(mp);
      try {
        const rows = await getRows(cookie, psid, industry, mp, date);
        const rg = extractWindows(rows, 'rg_flag_', rm);
        // 自动标记：规则A = 连续标记总时长 ≥阈值（整链保留，含缺 1 分钟容错）；
        //             规则B = 单个自然小时内累计覆盖 ≥阈值也保留（不要求连续，2026-10-19 用户要求）
        // 阈值来自 config/project.json（云端单文件部署时回退默认 15）。
        const zdAll = extractWindows(rows, 'zd_flag_', rm);
        const zdKept = mergeContinuous(zdAll, rm, PROJECT.thresholds.autoMarkMinMinutes);
        const zdHour = keepByHourCoverage(zdAll, rm, PROJECT.thresholds.autoMarkMinPerHour);
        const zd = [...new Set([...zdKept, ...zdHour])].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
        const qyList = qyMap.get(mp.name) || null;
        // 人工标记：填报记录（精确）> 数据行 rg_flag_ 扫描（兜底）
        const manualText = (qyList && qyList.length) ? qyText(qyList)
          : (rg.length ? rg.map((w) => windowText(w, mp.id)).join('；') : null);
        const zdMerged = zd.length ? mergeSameLabelSegs(zd, mp.id) : [];
        const autoText = zdMerged.length ? segsText(zdMerged, mp.id) : null;
        const manualN = (qyList && qyList.length) ? qyList.length : rg.length;
        // v2 结构化段（与上面的 v1 文本同一数据源、同一格式规则）
        const manualV2 = (qyList && qyList.length) ? { segs: qyList.map(qySegV2) }
          : (rg.length ? { noGroup: true, segs: rg.map((w) => manualRgSegV2(w, mp.id)) } : null);
        const autoV2segs = zdMerged.map(autoSegV2);
        logs.push(`[${date}] ${mp.name}(mpType=${mp.mpType},${rm >= 60 ? '小时' : '分钟'}) 行=${rows.length} 人工=${manualN}${qyList && qyList.length ? '(qy)' : ''} 自动=${zd.length}`);
        if (manualText) logs.push(`    人工: ${manualText}`);
        zdMerged.forEach((w) => logs.push(`    自动: ${windowText(w, mp.id)}`));
        return { name: mp.name, ok: true, logs, manualText, autoText, manualV2, autoV2segs, manualN };
      } catch (e) {
        logs.push(`SYNC_WARN ${date} ${mp.name} 抓取失败：${e.message}`);
        return { name: mp.name, ok: false, logs };
      }
    };
    const CONCURRENCY = 2;
    for (let i = 0; i < mps.length; i += CONCURRENCY) {
      const batch = mps.slice(i, i + CONCURRENCY);
      const rs = await Promise.all(batch.map(processMp));
      for (const r of rs) {
        if (r.ok) { okCount++; perMp[r.name] = 'ok'; }
        else { failCount++; perMp[r.name] = 'fail'; }
        r.logs.forEach((l) => say(l));
        if (r.ok && (r.manualText || r.autoText)) {
          byMp[r.name] = { manual: r.manualText, auto: r.autoText };
          total += r.manualN;
          pointsV2[r.name] = { manual: r.manualV2, auto: { segs: r.autoV2segs } };
        }
      }
    }
    // sync 字段：本次同步的完备性信息（2026-10-22 波次1）——消费方（本机 --quick / Worker）
    // 据此判断「这份标记能不能信」：at 是今天 ≠ 抓全；须同时 okCount==监测点总数 且 failCount==0。
    const payload = { total, byMp, at: new Date().toISOString(), sync: { okCount, failCount, mpsTotal: mps.length, perMp: { ...perMp } } };
    // v2 结构化载荷（2026-10-22 波次2）：points 与 byMp 内容等价、格式结构化。
    // 过渡期 v1/v2 双写；Worker 按 at 取较新者（相同则优先 v2）。v1 停写计划在 30 天兼容期后。
    const payloadV2 = { version: 2, total, points: pointsV2, at: payload.at, sync: payload.sync };
    if (dry) { say(`[dry] marks:${date} = ${JSON.stringify(payload)}`); say(`[dry] marks:v2:${date} = ${JSON.stringify(payloadV2)}`); continue; }
    // 先写 v2 再写 v1：若 v2 写成功而 v1 失败，Worker 的 at 比较会自然选用较新的 v1（旧）而不用旧 v2，
    // 反之亦然——两个键互为备份，单键失败不产生「新 v1 + 旧 v2」的错配。
    try {
      await putKV(acc, ns, token, `marks:v2:${date}`, JSON.stringify(payloadV2));
      say(`SYNC_OK date=${date} (v2) 监测点=${Object.keys(pointsV2).length} -> KV marks:v2:${date}`);
    } catch (e) { say(`SYNC_WARN date=${date} 写 v2 失败：${e.message}（v1 仍会写入，Worker 自动回退）`); }
    try {
      await putKV(acc, ns, token, `marks:${date}`, JSON.stringify(payload));
      written.push(date);
      say(`SYNC_OK date=${date} total=${total} 监测点=${Object.keys(byMp).length} -> KV marks:${date}`);
    } catch (e) { say(`SYNC_FAIL date=${date} 写 KV 失败：${e.message}`); }
  }

  if (okCount === 0 && failCount > 0) {
    await alertOnce('envsc 同步告警：cookie 已失效', `本次 ${failCount} 个监测点全部抓取失败。请更新云函数环境变量 CNEMC_COOKIE。`);
    return { ok: false, error: 'all-fetch-failed', alerted: true, written, log };
  }
  return { ok: failCount === 0, dates, written, okCount, failCount, dry, log };
};

// ---------- 阿里云函数计算入口：Handler 填 index.handler ----------
// 同时支持两种触发方式：
//   1) 定时触发器：event = { triggerTime, triggerName, payload }，
//      「触发消息」留空或填 JSON（如 {"days":2}）即可传参。
//   2) HTTP 触发器：请求会被包装成 { rawPath, method, body, queryParameters, isBase64Encoded }，
//      鉴权走 ?k=<ACCESS_TOKEN>（未配置 ACCESS_TOKEN 时一律拒绝，避免 URL 裸奔）。
exports.handler = async (event, context) => {
  const raw = normalize(event);
  const json = (statusCode, obj) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(obj, null, 2),
  });

  if (raw && (raw.rawPath !== undefined || raw.requestContext)) {
    const token = process.env.ACCESS_TOKEN || '';
    const q = raw.queryParameters || {};
    let bodyStr = raw.body || '';
    if (raw.isBase64Encoded) { try { bodyStr = Buffer.from(bodyStr, 'base64').toString('utf8'); } catch { bodyStr = ''; } }
    let ev = {};
    try { ev = JSON.parse(bodyStr); } catch { ev = {}; }
    if (!ev || typeof ev !== 'object') ev = {};
    for (const [k, v] of Object.entries(q)) ev[k] = (v === 'true') ? true : (v === 'false') ? false : v;
    if (!token || ev.k !== token) return json(403, { ok: false, error: 'forbidden: 需要 ?k=<ACCESS_TOKEN>' });
    delete ev.k;
    const r = await exports.main_handler(ev, context);
    return json(200, r);
  }

  return await exports.main_handler(payloadEvent(raw), context);
};
