/**
 * 有效传输率每日核查 · Cloudflare Worker 版
 *
 * 关键设计：
 *   1. 去重用 **Cloudflare KV**（免费额度够用）。
 *   2. Cron Triggers 时区明确为 UTC（北京 13–23 点 = UTC 05–15 点）。
 *   3. Workers 无 TCP socket → SMTP 不可用，邮件兜底改用 HTTP 邮件 API（Resend）。
 *   4. 企业端「人工标记」接口（http://116.178.28.170:3080）返回 **UTF-8 编码**，
 *      用 TextDecoder('utf-8') 解码；该接口需企业端会话 cookie（CNEMC_COOKIE secret）。
 *      ✅ 2026-09-22 实测修正：Workers 运行时**允许**明文 HTTP 子请求，也允许非标准端口（3080）——
 *      本地 workerd（与边缘同一运行时）直连该接口拿到 status 200 + 真实数据。
 *      （此前"Workers 只支持 HTTPS"的说法是错的，勿再沿用。）
 *      因此默认就是**直连**；若边缘网络路由不到该主机则优雅降级。
 *      仅在确认边缘不可达时，才改用 MARKS_PROXY_URL 走自建 HTTPS 中继。
 *
 * 绑定/环境变量：
 *   ENVSC_KV  KV namespace（去重）
 *   CNEMC_PSID     排污单位 ID（默认 654000000031）
 *   CNEMC_COOKIE   企业端会话 cookie（secret）：jointframe.cluster.sessionid=xxx
 *   MARKS_PROXY_URL   自建 HTTPS 中继地址（secret/var），如 https://marks-relay-xxx.fly.dev
 *   MARKS_PROXY_TOKEN 中继鉴权令牌（secret），须与中继的 RELAY_TOKEN 一致
 *   BARK_KEY       Bark key
 *   RESEND_API_KEY / MAIL_FROM / MAIL_TO   邮件兜底（可选，不配则只推 Bark）
 */

const API_BASE = 'https://jkzx.envsc.cn/transpublic-v2';
// 企业端「人工标记」列表接口（UTF-8 编码，需会话 cookie）。
// 默认直连明文 HTTP（已实测运行时允许）；只有确认边缘不可达时才配 MARKS_PROXY_URL 走中继。
const MARKS_HOST = 'http://116.178.28.170:3080';
const MARKS_PATH = '/amOnline/app/baseroute/requestRoute!list.page';
const MARKS_REFERER = 'http://116.178.28.170:3080/amOnline/zdjk-company/';
const COMPANY_NAME = '伊犁川宁生物技术股份有限公司';

// 不计入统计的监控点（与本机 mp-exclusions.json 保持一致）
const EXCLUSIONS = [
  { name: '3号机组', reason: '工况标记：停运，不计入有效传输率统计时段', onlyWhenZero: true },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 日期：Worker 运行环境是 UTC，必须显式按 UTC+8 计算 D-1 ----------
const TZ_OFFSET = 8 * 3600 * 1000;
function ymd(d) {
  const t = new Date(d.getTime() + TZ_OFFSET);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}
function d1Str() {
  const now = new Date();
  const t = new Date(now.getTime() + TZ_OFFSET);
  t.setUTCDate(t.getUTCDate() - 1);
  return ymd(new Date(t.getTime() - TZ_OFFSET));
}

// ---------- HTTP（公开平台） ----------
async function api(method, urlPath, { body, tries = 3, timeout = 25000 } = {}) {
  const url = new URL(API_BASE + urlPath);
  url.searchParams.set('_t', String(Date.now()));
  const init = {
    method,
    headers: {
      Accept: 'application/json, text/plain, */*',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Referer: 'https://jkzx.envsc.cn/transpublic-v2/2026/',
    },
  };
  if (body) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await fetch(url, { ...init, signal: ctrl.signal });
      const txt = await r.text();
      let json;
      try { json = JSON.parse(txt); } catch { json = { raw: txt.slice(0, 500) }; }
      if (r.status === 200) return json;
      lastErr = new Error(`HTTP ${r.status} ${urlPath}: ${txt.slice(0, 160)}`);
    } catch (e) {
      lastErr = new Error(`${urlPath} 请求异常(${e.name}): ${e.message}`);
    } finally { clearTimeout(to); }
    if (i < tries - 1) await sleep(1000 * 2 ** i);
  }
  throw lastErr;
}

const isOk = (json) => json && (json.code === 200 || json.code === 'SYS000' || json.code === '200');
const num = (v) => {
  if (v == null) return null;
  if (typeof v === 'string') { v = v.trim(); if (v === '' || v === '/') return null; }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ---------- 取数（公开平台） ----------
async function freshness() {
  const json = await api('GET', '/region/begin-end-time');
  if (!isOk(json)) throw new Error('begin-end-time 失败: ' + JSON.stringify(json).slice(0, 200));
  const d = json.data || {};
  return { beginTime: d.beginTime || null, endTime: (d.endTime || '').slice(0, 10) || null };
}

async function fetchRate(psId, day) {
  const gate = await freshness();
  if (gate.endTime && gate.endTime < day) {
    const err = new Error(`数据未更新：平台最新 ${gate.endTime} < 目标 ${day}`);
    err.code = 'NOT_READY';
    err.gate = gate;
    throw err;
  }
  const json = await api('POST', '/psinfo/psinfo/detail', {
    body: { psId, dateType: 'DAY', start: `${day} 00:00:00`, end: `${day} 23:59:59` },
  });
  if (!isOk(json)) throw new Error('psDetail 失败: ' + JSON.stringify(json).slice(0, 200));

  const data = json.data || {};
  const packRow = (o) => o ? {
    type: o.type || null,
    transRate: num(o.transRate),
    effeRate: num(o.effeTransRate),
    effeTransRate: num(o.effeTransRate),
    updatedTime: o.updatedTime || o.dataTime || null,
    exemptionsReason: o.exemptionsReason || null,
  } : null;

  return {
    date: day,
    psName: data.psName || COMPANY_NAME,
    regionName: data.regionName || null,
    realtime: packRow(data.realtime),
    comple: packRow(data.comple),
    monitorPoints: (data.transMpInfoList || []).map((mp) => ({
      mpName: mp.mpName || null,
      realtime: packRow(mp.realtime),
      comple: packRow(mp.comple),
    })),
    gate,
  };
}

// ---------- 判定 ----------
const effRate = (o) => (o && o.comple && o.comple.effeTransRate != null)
  ? o.comple.effeTransRate
  : (o && o.realtime ? o.realtime.effeTransRate : null);

function isExcluded(mp) {
  for (const ex of EXCLUSIONS) {
    if (mp.mpName && mp.mpName.includes(ex.name)) {
      if (ex.onlyWhenZero) {
        const rt = mp.realtime ? mp.realtime.effeTransRate : null;
        const cp = mp.comple ? mp.comple.effeTransRate : null;
        if (rt === 0 && cp === 0) return ex;
      } else {
        return ex;
      }
    }
  }
  return null;
}

// 废水监控点（2026-09-23 新增）：据《自动监测数据有效传输率统计算法说明》——
//   废水 CODCr/NH3-N/TP/TN 每日可有 1 小时因自动标样核查不参与分母统计，
//   即缺 ≤1 小时（率 ≥ 23/24 ≈ 95.83%）时官方口径已是 100%，不该报为异常。
const WASTEWATER_MPS = ['总排口'];
const WW_RATE_FLOOR = 95.83;
function isWastewaterOk(mp) {
  if (!mp || !mp.mpName) return false;
  if (!WASTEWATER_MPS.some((n) => mp.mpName.includes(n))) return false;
  const r = effRate(mp);
  return r != null && r >= WW_RATE_FLOOR;
}

function judge(data) {
  const unitRate = effRate(data);
  const underperforming = [];
  const excluded = [];
  for (const mp of data.monitorPoints || []) {
    const ex = isExcluded(mp);
    if (ex) { excluded.push({ mpName: mp.mpName, reason: ex.reason }); continue; }
    const r = effRate(mp);
    if (r == null) continue;
    if (isWastewaterOk(mp)) continue; // 废水：≤1h 标样核查已被官方排除，视为达标
    if (r < 100) {
      underperforming.push({
        mpName: mp.mpName,
        realtime: mp.realtime ? mp.realtime.effeTransRate : null,
        comple: mp.comple ? mp.comple.effeTransRate : null,
        rate: r,
      });
    }
  }
  return { unitRate, isCase1: unitRate === 100 && underperforming.length === 0, underperforming, excluded };
}

// ---------- 文本 ----------
const pct = (v) => (v == null ? '—' : `${v}%`);

// 企业端标记：把日期里的年份去掉（09-20 13:22），结束时间只取时分（14:30）
const prettyDate = (s) => String(s || '').replace(/^\d{4}-(\d{2})-(\d{2}) /, '$1-$2 ');

function markText(rows) {
  return rows.map((x) => {
    const parts = [];
    const flag = (x.reviseFlagName || '') + (x.reviseFlagItemName ? '-' + x.reviseFlagItemName : '');
    if (flag) parts.push(flag);
    if (x.startTime && x.endTime) {
      parts.push(`${prettyDate(x.startTime)}~${prettyDate(x.endTime).slice(-5)}(${x.duration}h)`);
    }
    if (x.reason) parts.push(x.reason);
    if (x.updatedBy) {
      const t = String(x.updatedTime || '').slice(5, 16); // "09-21 09:57"
      parts.push(`${x.updatedBy} ${t}填报`);
    }
    return parts.join(' ');
  }).join('；');
}

// ---------- 人工标记抓取（企业端，UTF-8） ----------
async function fetchMarks(psId, day, cookie, env) {
  if (!cookie) {
    return { attempted: false, total: 0, byMp: new Map(), error: '未配置 CNEMC_COOKIE' };
  }
  const params = new URLSearchParams({
    method: '/sign/qy/list',
    pageNum: '1', pageSize: '100',
    dateTime: `${day},${day}`,
    type: '2', moduleCode: '', mpId: '-1', shId: '-1', psId, status: '-1',
  });
  params.set('_t', String(Date.now()));
  const proxy = env && env.MARKS_PROXY_URL ? String(env.MARKS_PROXY_URL).replace(/\/+$/, '') : null;
  const target = proxy
    ? `${proxy}${MARKS_PATH}?${params.toString()}`
    : `${MARKS_HOST}${MARKS_PATH}?${params.toString()}`;
  try {
    const headers = {
      Cookie: cookie,
      Accept: 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Referer: MARKS_REFERER,
    };
    if (proxy && env.MARKS_PROXY_TOKEN) headers['Authorization'] = `Bearer ${env.MARKS_PROXY_TOKEN}`;
    const r = await fetch(target, { headers });
    if (r.status !== 200) {
      return { attempted: true, total: 0, byMp: new Map(), error: `HTTP ${r.status}` };
    }
    const txt = new TextDecoder('utf-8').decode(await r.arrayBuffer());
    let json;
    try { json = JSON.parse(txt); } catch { return { attempted: true, total: 0, byMp: new Map(), error: '响应解析失败' }; }
    if (json.code !== 200) {
      return { attempted: true, total: 0, byMp: new Map(), error: `企业端 code ${json.code}` };
    }
    const rows = (json.data && json.data.rows) || [];
    const byMp = new Map();
    for (const x of rows) {
      const k = String(x.mpName || '').trim();
      if (!byMp.has(k)) byMp.set(k, []);
      byMp.get(k).push(x);
    }
    const byMpObj = new Map();
    for (const [k, list] of byMp) byMpObj.set(k, { manual: markText(list), auto: null });
    return { attempted: true, total: rows.length, byMp: byMpObj, error: null };
  } catch (e) {
    return { attempted: true, total: 0, byMp: new Map(), error: `请求失败 ${e.message}` };
  }
}

// ---------- 人工标记：公开平台（jkzx.envsc.cn，边缘可达，无需中继/本机） ----------
// 2026-09-22 实测：POST /psinfo/pollutant/list 会返回逐小时 invalidReasons
//    [{dataTime:"2026-09-20 13", dataStatus:"-1", invalidReason:"自动监测设备维护"}]
// 以及 noTransReasons（如 ["停运"] 工况标记）。
// 局限：只有**大类**（自动监测设备维护），拿不到细项（校准/故障/日常维护）与填报人/说明。
// 因此定位为**兜底**：KV 里有本机抓的企业端详版就优先用，没有时用公开版，至少不会「暂无法获取」。
const PUB_BASE = 'https://jkzx.envsc.cn/transpublic-v2';
const PUB_REFERER = 'https://jkzx.envsc.cn/transpublic-v2/2026/';

async function pubApi(method, urlPath, body) {
  const url = new URL(PUB_BASE + urlPath);
  url.searchParams.set('_t', String(Date.now()));
  const init = {
    method,
    headers: {
      Accept: 'application/json, text/plain, */*',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Referer: PUB_REFERER,
    },
  };
  if (body) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(url, init);
  const txt = await r.text();
  try { return JSON.parse(txt); } catch { return null; }
}

// 排除工况参数（S01 氧含量 / S02 流速 / S03 温度 / S05 湿度 / S08 压力 / B01 B02 流量），只留污染物因子
const isParamCode = (c) => /^[SB]\d{2}$/i.test(String(c || ''));
const hourMs = (s) => new Date(String(s).replace(' ', 'T') + ':00:00').getTime();

function pubSegsToText(segs) {
  return segs.map((s) => {
    const st = String(s.start).slice(5);        // "09-20 13"
    const eh = String(s.end).slice(11, 13);     // "14"
    // 单小时显示 "09-20 11(1h)"；跨小时显示 "09-20 13~14(2h)"
    return s.n > 1 ? `${s.reason} ${st}~${eh}(${s.n}h)` : `${s.reason} ${st}(${s.n}h)`;
  }).join('；');
}

async function fetchMarksPublic(psId, day) {
  const start = `${day} 00:00:00`;
  const end = `${day} 23:59:59`;
  const det = await pubApi('POST', '/psinfo/psinfo/detail', { psId, dateType: 'DAY', start, end });
  const mps = (det && det.data && det.data.transMpInfoList) || [];
  if (!mps.length) throw new Error('公开平台未返回监控点');
  const byMp = new Map();
  let total = 0;
  for (const m of mps) {
    const name = String(m.mpName || '').trim();
    if (!name) continue;
    const list = await pubApi('POST', '/psinfo/pollutant/list', { psId, mpId: m.mpId, dateType: 'DAY', start, end });
    const factors = (list && list.data) || [];
    const segs = [];
    for (const f of factors) {
      if (isParamCode(f.pollutantCode)) continue;
      const inv = ((f.realtime || {}).invalidReasons || []).filter((x) => x && x.invalidReason);
      for (const b of inv) {
        const t = String(b.dataTime || '');
        const last = segs[segs.length - 1];
        if (last && last.reason === b.invalidReason && hourMs(t) - hourMs(last.end) === 3600000) {
          last.end = t; last.n += 1;
        } else {
          segs.push({ reason: b.invalidReason, start: t, end: t, n: 1 });
        }
      }
    }
    if (segs.length) {
      // 同一小时可能被多个监测因子各标一次 → 去重，避免「…；…」重复
      const uniq = [];
      const seen = new Set();
      for (const s of segs) {
        const k = `${s.reason}|${s.start}|${s.end}|${s.n}`;
        if (seen.has(k)) continue;
        seen.add(k);
        uniq.push(s);
      }
      total += uniq.length;
      byMp.set(name, { manual: null, auto: pubSegsToText(uniq) });
    }
  }
  return { attempted: true, total, byMp, error: null, source: 'public' };
}

// ---------- 人工标记：优先读 KV（由本机 tools/marks-sync.mjs 在境内抓取后回写） ----------
// 为什么：企业端 116.178.28.170:3080 只对国内 IP 开放，Cloudflare 边缘（境外）连不上
// （境外直连超时，裸 IP 还会被 Cloudflare 以 error code 1003 拒绝）。
// 故抓取放在本机，结果落到 KV，边缘只负责读。这样零服务器、零厂商额度、长期免费。
async function fetchMarksFromKV(env, day) {
  if (!env.ENVSC_KV) return null;
  let raw = null;
  try { raw = await env.ENVSC_KV.get(`marks:${day}`); } catch (e) { return null; }
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    // 兼容旧格式（byMp 值为字符串=仅人工）与新格式（值为 {manual, auto}）
    const byMp = new Map();
    for (const [name, v] of Object.entries(obj.byMp || {})) {
      if (typeof v === 'string') byMp.set(name, { manual: v, auto: null });
      else byMp.set(name, { manual: (v && v.manual) || null, auto: (v && v.auto) || null });
    }
    return { attempted: true, total: obj.total != null ? obj.total : 0, byMp, error: null, source: 'kv' };
  } catch (e) {
    return { attempted: true, total: 0, byMp: new Map(), error: `KV 解析失败 ${e.message}` };
  }
}

// ---------- 设备标记：人工/自动时段覆盖判定 ----------
// 把字符串里所有 `HH:MM~HH:MM` 区间解析为 [起,止]（分钟数），支持中英文波浪号/半全角
function toMin(hhmm) {
  const p = String(hhmm).split(':');
  const h = Number(p[0]), mi = Number(p[1]);
  if (!Number.isFinite(h) || !Number.isFinite(mi)) return null;
  return h * 60 + mi;
}
function parseRanges(s) {
  const out = [];
  const re = /(\d{1,2}:\d{2})\s*[~～]\s*(\d{1,2}:\d{2})/g;
  let m;
  while ((m = re.exec(String(s || ''))) !== null) {
    const a = toMin(m[1]), b = toMin(m[2]);
    if (a != null && b != null) out.push([a, b]);
  }
  return out;
}
// 某 auto 区间是否被任一 manual 区间完全覆盖（人工优先级 > 自动）
function rangeCoveredByAny(auto, manualRanges) {
  const [as, ae] = auto;
  return manualRanges.some(([ms, me]) => as >= ms && ae <= me);
}

// 「标样核查」是独立的**核查记录**（人工比对样品的校准核查），不是设备故障/维护，
//   即便时段与人工标记的「校准」重合也要保留 —— 两者是不同性质的事实，抑制掉会丢核查记录。
//   2026-10-07 用户要求：废水标样核查为自动标记，可能与人工标记校准时段重合，此时两者都要推送。
//   2026-10-08 又要求：标样核查≤1h 不构成推送理由 → 提升为模块级，供异常点判定共用。
const isCheckSeg = (seg) => /标样核查|样品核查|比对核查/.test(seg);

// ---------- 推送正文（新格式） ----------
function buildText(data, j, marks) {
  const compact = data.date.replace(/-/g, '');
  const title = `${compact}有效传输率${pct(j.unitRate)}`;

  // 异常监控点 = 未达标 ∪ 排除(停运) ∪ 有实质标记的点
  // 注意：废水 ≤1h 标样核查被官方豁免（isWastewaterOk），有效率判为达标、不计「未达标」。
  //   标记方面（2026-10-08 细化）：**纯标样核查自动标记不构成推送理由**（≤1h 豁免，不算异常）；
  //   仅当存在①人工标记，或②非标样核查的异常自动段（故障/日常维护等）时才推送；
  //   标样核查段与其他异常时段重叠时随推送一并展示（isCheckSeg 已豁免覆盖抑制）。
  const abnormal = [];
  for (const mp of data.monitorPoints || []) {
    const ex = isExcluded(mp);
    const r = effRate(mp);
    const under = (r != null && r < 100) && !isWastewaterOk(mp); // 废水 ≤1h 标样核查不计异常
    const key0 = String(mp.mpName || '').trim();
    const m0 = marks && marks.byMp && marks.byMp.get(key0);
    const hasManual = !!(m0 && String(m0.manual || '').trim());
    // auto 可能多组多段（\n 分组、；分段）
    const autoSegs = String((m0 && m0.auto) || '').split(/[\n；]/).map((s) => s.trim()).filter(Boolean);
    // 废水豁免点（有效率 ≥95.83，≤1h 标样核查区间）：**自动标记不构成推送理由**——
    //   标样核查/设备维护都发生在豁免期内，属官方豁免范畴（2026-10-08 用户要求）；
    //   仅人工标记（运维主动填报）触发推送。自动标记照样随推送展示。
    //   注：不能按文本匹配"标样核查"判定——公开平台兜底来源写的是"自动监测设备维护 N(1h)"，
    //   与 SCF 分钟级的"标样核查"措辞不同，按点豁免状态判定才可靠。
    // 非废水点 / 废水真异常点：维持原行为——任何标记都构成推送理由。
    const wwExempt = isWastewaterOk(mp);
    const marked = wwExempt ? hasManual : (hasManual || autoSegs.length > 0);
    if (!under && !ex && !marked) continue;
    abnormal.push({ mp, ex, under, marked });
  }
  if (abnormal.length === 0) return { title, body: '' }; // 情况1：全部达标且无停运点

  const total = (data.monitorPoints || []).length;
  const lines = [];
  // 注意：样例里 `#停运也计入异常` 是给用户的注解，不进推送正文
  lines.push(`异常监控点（${abnormal.length} / ${total} 个）：`);

  for (const a of abnormal) {
    const mp = a.mp;
    if (a.ex) {
      lines.push(`· ${mp.mpName}（${a.ex.reason}）`);
    } else if (a.marked && !a.under) {
      // 达标但有标记（废水 ≤1h 标样核查被官方豁免）：标注豁免，避免"100% 却异常"的困惑
      const rt = mp.realtime ? mp.realtime.effeTransRate : null;
      const cp = mp.comple ? mp.comple.effeTransRate : null;
      lines.push(`· ${mp.mpName}　即时 ${pct(rt)} / 补全 ${pct(cp)}（≤1h 标样核查，已豁免）`);
    } else {
      const rt = mp.realtime ? mp.realtime.effeTransRate : null;
      const cp = mp.comple ? mp.comple.effeTransRate : null;
      lines.push(`· ${mp.mpName}　即时 ${pct(rt)} / 补全 ${pct(cp)}`);
    }
    const key = String(mp.mpName || '').trim();
    const m = marks && marks.byMp && marks.byMp.get(key);
    // 人工标记与自动标记是**两个互相独立的渠道**：
    //   人工 = 运维在企业端 /sign/qy/list 手工填报（带原因、带填报人）
    //   自动 = 系统按数据断传时长自动判定（>15min 的 zd_flag_ 段）
    // 两者时间段常常不重叠（如 9-28 3号机组：人工 21:00~21:23，自动 14:05~14:33 等三段），
    // 互为补充而不是互相替代 —— **同时存在且互不覆盖时要都推送**。
    // 但人工优先级 > 自动：当某段「自动标记时段」被「人工标记时段」完全覆盖时，
    // 该段自动标记被抑制，仅推送人工标记（2026-09-30 改；9-29 生产工艺/环保尾气即为该情形）。
    // 仅当剩余自动标记去掉日期前缀后与人工完全相同才并成一行，避免刷屏。
    if (m) {
      const norm = (s) => String(s || '').replace(/\d{2}-\d{2}\s+/g, '').replace(/\s*\n\s*/g, '\n').trim();
      const man = norm(m.manual);
      const manRanges = parseRanges(m.manual);
      // 自动标记文本结构（2026-10-06 精简规则）：
      //   以 \n 分「因子组」，组内以 ； 分「时段段」。每段形如
      //     '二氧化硫/氮氧化物 校准 14:43~14:51(9min)；故障 14:52~14:53(2min)'
      //     '颗粒物 日常维护 15:25~15:30(6min)；校准 15:52~15:57(6min)'
      //   旧格式（无 \n）也兼容：整条当作一个组。
      const rawAuto = String(m.auto || '');
      const groups = rawAuto.split('\n').map((g) => g.trim()).filter(Boolean);
      const keptGroups = [];
      for (const grp of groups) {
        // 组内每段独立做覆盖判定；因子名只在段首，续段没有因子名也要能取出时段
        const segs = grp.split('；').map((s) => s.trim()).filter(Boolean);
        const kept = segs.filter((seg) => {
          if (isCheckSeg(seg)) return true;   // 标样核查豁免覆盖抑制
          const rngs = parseRanges(seg);
          if (rngs.length === 0) return true; // 解析不出时间就不误删，保留
          // 仅当该段「每个」区间都被某个人工区间覆盖时才整段抑制
          return !rngs.every((r) => rangeCoveredByAny(r, manRanges));
        });
        if (kept.length) keptGroups.push(kept.join('；'));
      }
      // 人工标记文本结构（2026-10-07）：与自动标记同构 —— 以 \n 分「因子组」，组内以 ； 分时段段。
      //   '二氧化硫/氮氧化物 校准-… 21:00~21:23(24min)'
      //   '化学需氧量/氨氮 校准-… 13:21~14:06(46min)'
      if (man) {
        // 多组时换行展示，与自动标记的观感一致
        if (man.includes('\n')) lines.push(`人工标记：\n${man}`);
        else lines.push(`人工标记：${man}`);
      }
      if (keptGroups.length) {
        const keptText = norm(keptGroups.join('\n'));
        if (keptText && norm(keptText.replace(/\n/g, '；')) !== man) {
          // 多组时换行展示，一眼看出每个因子的时段分布
          if (keptText.includes('\n')) lines.push(`自动标记：\n${keptText}`);
          else lines.push(`自动标记：${keptText}`);
        }
      }
    }
    // 若该点既无人工也无自动设备标记，则不显示任何设备标记行：
    // 其工况标记（如停运）已由上方的 excluded 行体现，无需补"无记录"行。
  }

  let body = lines.join('\n');
  // 按需求已移除"当日公司仅此 N 条常规监测因子人工标记"后缀
  if (marks && marks.error) body += `\n（人工标记暂无法获取：${marks.error}）`;
  return { title, body };
}

// ---------- 推送：Bark ----------
async function pushBark(key, title, body, level) {
  if (!key) return { channel: 'bark', ok: false, error: 'BARK_KEY 未配置' };
  try {
    const r = await fetch(`https://api.day.app/${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body, level: level || 'active', group: '有效传输率' }),
    });
    const txt = await r.text();
    let json; try { json = JSON.parse(txt); } catch { json = { raw: txt.slice(0, 200) }; }
    return { channel: 'bark', ok: json && json.code === 200, resp: json };
  } catch (e) {
    return { channel: 'bark', ok: false, error: e.message };
  }
}

// ---------- 推送：邮件兜底（Resend HTTP API；Workers 无 SMTP） ----------
async function pushEmail(env, title, body) {
  if (!env.RESEND_API_KEY || !env.MAIL_TO || !env.MAIL_FROM) {
    return { channel: 'email', ok: false, error: '邮件未配置' };
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: [env.MAIL_TO],
        subject: title,
        text: body || '',
      }),
    });
    return { channel: 'email', ok: r.status === 200 || r.status === 201, status: r.status };
  } catch (e) {
    return { channel: 'email', ok: false, error: e.message };
  }
}

// ---------- 主流程 ----------
async function runInner(env) {
  const day = d1Str();
  const psId = env.CNEMC_PSID || '654000000031';

  // 去重（KV）
  let done = null;
  try { done = await env.ENVSC_KV.get(day); } catch (e) { /* KV 异常不阻断 */ }
  if (done) return { ok: true, action: 'skipped', date: day, reason: '当天已推送过' };

  let data;
  try {
    data = await fetchRate(psId, day);
  } catch (e) {
    if (e.code === 'NOT_READY') {
      return { ok: true, action: 'not_ready', date: day, gate: e.gate, reason: e.message };
    }
    return { ok: false, action: 'failed', date: day, reason: e.message };
  }

  const j = judge(data);

  // 设备标记获取（A+B 并行设计，2026-09-23）：
  //   B·中继 = 配置了 MARKS_PROXY_URL 才启用：边缘可达的 HTTPS 中继（国内云函数），
  //            分钟级 + 人工标记 + 校准/故障细分，质量最高 → 一旦配上就最优先，无需再改代码；
  //   A 基线 = 公开平台（边缘可达，任何情况下都尝试，保证"完全不依赖本机也有标记"，
  //            但只有小时级大类，如 自动监测设备维护/流量无效）；
  //   B·KV   = 本机 marks-sync 或未来中继写入的 KV（分钟级起止 + 人工标记，质量更高，
  //            **按监测点覆盖**公开版同名条目——两条腿互为增强与保底）；
  //   兜底   = 企业端直连（仅公开与 KV 全挂时才走到，边缘通常不可达）。
  //   返回的 source 会如实标注 'relay' / 'public' / 'kv' / 'kv+public'，便于核对走了哪条腿。
  let marks = { attempted: false, total: 0, byMp: new Map(), error: null };
  try {
    // ① B·中继（配了才走；中继可用即以其为准，哪怕当日无标记）
    if (env.MARKS_PROXY_URL) {
      try {
        const r = await fetchMarks(psId, day, env.CNEMC_COOKIE, env);
        if (r && r.attempted && !r.error) marks = { ...r, source: 'relay' };
      } catch (e) { /* 中继异常则继续走 A/B 融合 */ }
    }
    if (!marks.attempted) {
      // ② A(公开) 与 B(KV) 并行取数，KV 按点覆盖公开
      const [pubRes, kvRes] = await Promise.allSettled([
        fetchMarksPublic(psId, day),
        fetchMarksFromKV(env, day),
      ]);
      const pub = pubRes.status === 'fulfilled' ? pubRes.value : null;
      const fromKv = kvRes.status === 'fulfilled' ? kvRes.value : null;
      if (pub || fromKv) {
        const merged = new Map();
        if (pub) for (const [k, v] of pub.byMp) merged.set(k, v);
        if (fromKv) for (const [k, v] of fromKv.byMp) merged.set(k, v); // KV 质量更高，覆盖同名点
        marks = {
          attempted: true,
          // total 仅在存在人工标记时用于推送后缀；KV total=人工条数，纯公开时不展示（hasMarks=false）
          total: fromKv ? (fromKv.total != null ? fromKv.total : 0) : (pub ? pub.total : 0),
          byMp: merged,
          error: null,
          source: fromKv ? (pub ? 'kv+public' : 'kv') : 'public',
        };
      } else {
        // ③ 公开与 KV 都拿不到 → 企业端直连兜底
        marks = await fetchMarks(psId, day, env.CNEMC_COOKIE, env);
      }
    }
  } catch (e) {
    marks = { attempted: true, total: 0, byMp: new Map(), error: e.message };
  }

  const { title, body } = buildText(data, j, marks);

  // 有效传输率 100%（全达标且无标记/停运内容）→ **仅推送标题，不带正文**（2026-10-08 用户要求）。
  // body 为空时 bark/email 只发 title；dedup 照常写入，当天后续整点不再重复推。
  const fullOk = !String(body || '').trim();
  const pushBody = fullOk ? '' : body;
  const level = j.isCase1 ? 'active' : 'timeSensitive';

  const pushed = [];
  const bark = await pushBark(env.BARK_KEY, title, pushBody, level);
  pushed.push(bark);
  if (!bark.ok) pushed.push(await pushEmail(env, title, pushBody));

  const anyOk = pushed.some((p) => p.ok);
  if (anyOk) {
    try {
      await env.ENVSC_KV.put(day, JSON.stringify({ unitRate: j.unitRate, isCase1: j.isCase1, at: new Date().toISOString() }));
    } catch (e) { /* 去重写失败不影响推送结果 */ }
  }

  return {
    ok: anyOk,
    action: anyOk ? 'pushed' : 'failed',
    date: day,
    unitRate: j.unitRate,
    isCase1: j.isCase1,
    underperforming: j.underperforming,
    excluded: j.excluded,
    marks: { source: marks.source || null, attempted: marks.attempted, total: marks.total, error: marks.error },
    title,
    body,
    pushed,
  };
}

// 包装：把最近一次运行结果写进 KV，便于在 workers.dev 不可达时用命令行核对
async function run(env) {
  let r;
  try {
    r = await runInner(env);
  } catch (e) {
    // 关键：任何未捕获异常也要落到 KV，否则线上排查没有任何线索
    r = { ok: false, action: 'failed', phase: 'runInner', error: String((e && e.stack) || e) };
  }
  try {
    if (env.ENVSC_KV) {
      await env.ENVSC_KV.put('last-result', JSON.stringify({ at: new Date().toISOString(), ...r }));
    }
  } catch (e) { /* 记录失败不影响主流程 */ }
  return r;
}

// ---------- 看门狗：阿里云函数今日是否按时落库 ----------
// 背景：阿里云欠费会**立即**冻结函数（403 "Current user is in debt"），12:55 的定时同步会
// 静默失效——不报错、不推送，第二天才发现标记全丢。而费用中心的「可用额度预警」没有公开
// OpenAPI（SDK 里只有给分销子账号用的 SetResellerUserAlarmThreshold），代设不了。
// 于是用 Cloudflare 自己的 Cron 做反向自检：只看 KV 里有没有「今天写入的 marks:<D-1>」，
// 完全不依赖阿里云任何权限。云函数挂了 →  Bark 告警。
async function watchdog(env) {
  const kv = env.ENVSC_KV;
  if (!kv) return { watchdog: 'skip', why: 'ENVSC_KV 未绑定' };

  const now = new Date();
  const cn = new Date(now.getTime() + TZ_OFFSET); // 北京时间视图
  const hhmm = cn.getUTCHours() * 60 + cn.getUTCMinutes();
  const clock = `${String(cn.getUTCHours()).padStart(2, '0')}:${String(cn.getUTCMinutes()).padStart(2, '0')}`;
  // 云函数 12:55 才跑，13:05 之前检查必然误报
  if (hhmm < 13 * 60 + 5) return { watchdog: 'skip', why: `未到检查时刻（北京 ${clock} < 13:05）` };

  const today = ymd(now);
  const day = d1Str(); // 同步目标日 = 昨天，也就是当天推送要用的那份标记

  let alerted = null;
  try { alerted = await kv.get(`wd:${today}`); } catch (e) { /* 读取失败按未告警处理 */ }
  if (alerted) return { watchdog: 'skip', why: '今天已告警过', at: alerted, day };

  let raw = null;
  try { raw = await kv.get(`marks:${day}`); } catch (e) { raw = null; }

  let why = '';
  if (!raw) {
    why = `KV 里没有 marks:${day}（云函数今天没写入）`;
  } else {
    let at = '';
    try { at = String((JSON.parse(raw) || {}).at || ''); } catch (e) { at = ''; }
    if (!at) why = `marks:${day} 缺少时间戳`;
    else {
      const atDay = ymd(new Date(at)); // at 是 UTC ISO，ymd() 会换算成北京日期
      if (atDay !== today) why = `marks:${day} 的时间戳是 ${at}（北京 ${atDay}，不是今天）`;
    }
  }
  if (!why) return { watchdog: 'ok', day, today, why: '今日同步已落库' };

  const title = `⚠️ 同步中断 ${day.replace(/-/g, '')}`;
  const body = `${why}。常见原因：① 阿里云欠费冻结（403 in debt，欠 2 分钱也停）；`
    + '② 企业端 cookie 失效；③ 函数异常。请查阿里云账户余额 + 函数 envsc-marks-sync。';
  let bark = { channel: 'bark', ok: false, error: 'BARK_KEY 未配置' };
  if (env.BARK_KEY) bark = await pushBark(env.BARK_KEY, title, body, 'timeSensitive');
  try { await kv.put(`wd:${today}`, now.toISOString()); } catch (e) { /* 幂等标记失败不影响告警本身 */ }
  return { watchdog: 'alerted', day, today, why, bark };
}

export { buildText, markText, fetchMarks, watchdog };

// 北京时间推送窗口：15:00–20:59（2026-10-08 用户要求；scheduled 与测试共用）
export function inPushWindow(bjHour) {
  return bjHour >= 15 && bjHour < 21;
}

export default {
  // 定时触发（Cron Triggers）
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      // 北京时间推送窗口硬约束（2026-10-08）：仅 15:00–20:59 允许推送日报。
      // 背景：wrangler 已把 cron 换成 UTC 7-12（北京 15-20），且 API /schedules 确认只有一条，
      //   但**旧 cron（0 5-15）的 UTC 05/06 点仍在幽灵触发**（GraphQL analytics 实证）——
      //   Cloudflare 平台侧旧调度未下线，API 层不可靠 → 代码层兜底，窗外直接不推不写 dedup。
      const bjHour = new Date(Date.now() + 8 * 3600e3).getUTCHours();
      if (!inPushWindow(bjHour)) {
        return { ok: true, action: 'outside_window', bjHour, reason: '北京时间不在 15:00-20:00 推送窗口' };
      }
      const r = await run(env);
      // 主流程跑完再做自检；看门狗自身任何异常都不能影响当日推送
      let w;
      try { w = await watchdog(env); } catch (e) { w = { watchdog: 'error', error: String((e && e.stack) || e) }; }
      try {
        if (env.ENVSC_KV) await env.ENVSC_KV.put('last-watchdog', JSON.stringify({ at: new Date().toISOString(), ...w }));
      } catch (e) { /* 忽略 */ }
      return { ...r, watchdog: w };
    })());
  },
  // 手动访问 URL 即可触发一次，便于验证
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // 边缘直连企业端探测（验证 Cloudflare 边缘能否访问 116.178.28.170:3080）
    if (url.pathname === '/probe') {
      // 鉴权：必须带 ?k=<BARK_KEY>，否则一律 404（防止被当成任意 URL 的 SSRF 代理）
      if (!env.BARK_KEY || url.searchParams.get('k') !== env.BARK_KEY) {
        return new Response('not found', { status: 404 });
      }
      const target = 'http://116.178.28.170:3080/amOnline/app/baseroute/requestRoute!list.page?method=/psbase/mpinfo/getMpInfoByPsId&psId=654000000031';
      const t0 = Date.now();
      try {
        const r = await fetch(target, {
          headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' },
          redirect: 'manual',
        });
        const txt = await r.text();
        return new Response(JSON.stringify({ ok: true, ms: Date.now() - t0, status: r.status, head: txt.slice(0, 300) }, null, 2), {
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, ms: Date.now() - t0, error: String((e && e.message) || e), name: e && e.name }, null, 2), {
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      }
    }
    // 看门狗手动触发（同样要 ?k=<BARK_KEY> 鉴权）；加 &reset=1 可清掉当天的告警幂等标记
    if (url.pathname === '/watchdog') {
      if (!env.BARK_KEY || url.searchParams.get('k') !== env.BARK_KEY) {
        return new Response('not found', { status: 404 });
      }
      if (url.searchParams.get('reset') === '1' && env.ENVSC_KV) {
        try { await env.ENVSC_KV.delete(`wd:${ymd(new Date())}`); } catch (e) { /* 忽略 */ }
      }
      const w = await watchdog(env);
      return new Response(JSON.stringify(w, null, 2), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }
    const r = await run(env);
    return new Response(JSON.stringify(r, null, 2), {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  },
};
