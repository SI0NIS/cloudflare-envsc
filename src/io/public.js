// io/public.js —— 公开平台 jkzx.envsc.cn 取数（有效传输率 + 小时级公开标记）
import { COMPANY_NAME } from '../config.js';
import { sleep } from '../core/time.js';

const API_BASE = 'https://jkzx.envsc.cn/transpublic-v2';

// ---------- HTTP（公开平台，带重试/超时/指数退避） ----------
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

// ---------- 取数（有效传输率） ----------
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

  const monitorPoints = (data.transMpInfoList || []).map((mp) => ({
    mpName: mp.mpName || null,
    realtime: packRow(mp.realtime),
    comple: packRow(mp.comple),
  }));
  const hasRate = monitorPoints.some((mp) => [mp.realtime, mp.comple].some((row) =>
    row && [row.effeTransRate, row.effeRate, row.transRate].some((v) => v != null)));
  if (!monitorPoints.length || !hasRate) {
    const err = new Error(`数据未就绪：平台最新 ${gate.endTime || '未知'}，但 ${day} 明细尚无监测点传输率`);
    err.code = 'NOT_READY';
    err.gate = gate;
    throw err;
  }

  return {
    date: day,
    psName: data.psName || COMPANY_NAME,
    regionName: data.regionName || null,
    realtime: packRow(data.realtime),
    comple: packRow(data.comple),
    monitorPoints,
    gate,
  };
}

// ---------- 人工标记：公开平台兜底（小时级大类，无需中继/本机） ----------
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

export { API_BASE, api, isOk, num, freshness, fetchRate, pubApi, isParamCode, hourMs, pubSegsToText, fetchMarksPublic };
