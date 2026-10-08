#!/usr/bin/env node
/**
 * preview-push.mjs —— 在不触发真实推送的前提下，预览 envsc Worker 对某一天将会推送的标题+正文。
 *
 * 做法：直接复用 Worker 导出的 buildText，配以「公开平台实时数据 + KV 里已同步的标记」，
 *       按 Worker 相同的「公开铺底、KV 按点覆盖」规则合并。用于改版后核对推送文案。
 *
 * 用法：
 *   node tools/preview-push.mjs [YYYY-MM-DD]        # 默认 D-1
 * 环境变量：
 *   CF_ACC / CF_NS / CF_TOK   有则从 Cloudflare KV 读 marks:<date>（本机需能访问 api.cloudflare.com）
 *   KV_FILE                   本机连不上 CF 时，改读本地保存的 KV 快照文件
 */
import { readFileSync } from 'node:fs';
import { buildText } from '../src/index.js';

const API = 'https://jkzx.envsc.cn/transpublic-v2';
const PSID = '654000000031';
const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const DAY = process.argv[2] || ymd(new Date(Date.now() - 86400000));
const start = `${DAY} 00:00:00`, end = `${DAY} 23:59:59`;

async function pubApi(method, path, body) {
  const url = new URL(API + path); url.searchParams.set('_t', String(Date.now()));
  const init = { method, headers: { Accept: 'application/json', Referer: 'https://jkzx.envsc.cn/transpublic-v2/2026/' } };
  if (body) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(url, init); return JSON.parse(await r.text());
}
const num = (v) => { if (v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const packRow = (o) => o ? { type: o.type || null, transRate: num(o.transRate), effeRate: num(o.effeTransRate), effeTransRate: num(o.effeTransRate), updatedTime: o.updatedTime || o.dataTime || null, exemptionsReason: o.exemptionsReason || null } : null;
const effRate = (o) => (o && o.comple && o.comple.effeTransRate != null) ? o.comple.effeTransRate : (o && o.realtime ? o.realtime.effeTransRate : null);
const isParamCode = (c) => /^[SB]\d{2}$/i.test(String(c || ''));
const hourMs = (s) => new Date(String(s).replace(' ', 'T') + ':00:00').getTime();
const segsToText = (segs) => segs.map((s) => { const st = String(s.start).slice(5); const eh = String(s.end).slice(11, 13); return s.n > 1 ? `${s.reason} ${st}~${eh}(${s.n}h)` : `${s.reason} ${st}(${s.n}h)`; }).join('；');

// 取率
const det = await pubApi('POST', '/psinfo/psinfo/detail', { psId: PSID, dateType: 'DAY', start, end });
const D = (det && det.data) || {};
const data = {
  date: DAY, psName: D.psName, realtime: packRow(D.realtime), comple: packRow(D.comple),
  monitorPoints: (D.transMpInfoList || []).map((m) => ({ mpName: m.mpName, realtime: packRow(m.realtime), comple: packRow(m.comple) })),
};

// 公开兜底标记
const byPub = new Map();
for (const m of (D.transMpInfoList || [])) {
  const nm = String(m.mpName || '').trim(); if (!nm) continue;
  const list = await pubApi('POST', '/psinfo/pollutant/list', { psId: PSID, mpId: m.mpId, dateType: 'DAY', start, end });
  const segs = [];
  for (const f of ((list && list.data) || [])) {
    if (isParamCode(f.pollutantCode)) continue;
    for (const b of (((f.realtime || {}).invalidReasons) || []).filter((x) => x && x.invalidReason)) {
      const t = String(b.dataTime || ''); const last = segs[segs.length - 1];
      if (last && last.reason === b.invalidReason && hourMs(t) - hourMs(last.end) === 3600000) { last.end = t; last.n += 1; }
      else segs.push({ reason: b.invalidReason, start: t, end: t, n: 1 });
    }
  }
  if (segs.length) { const u = []; const seen = new Set(); for (const s of segs) { const k = `${s.reason}|${s.start}|${s.end}|${s.n}`; if (!seen.has(k)) { seen.add(k); u.push(s); } } byPub.set(nm, { manual: null, auto: segsToText(u) }); }
}

// KV 标记
let kvObj = null;
if (process.env.KV_FILE) {
  kvObj = JSON.parse(readFileSync(process.env.KV_FILE, 'utf8'));
} else if (process.env.CF_ACC && process.env.CF_NS && process.env.CF_TOK) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACC}/storage/kv/namespaces/${process.env.CF_NS}/values/${encodeURIComponent('marks:' + DAY)}`, { headers: { Authorization: `Bearer ${process.env.CF_TOK}` } });
  if (r.status === 200) kvObj = JSON.parse(await r.text());
}
const kv = new Map();
for (const [k, v] of Object.entries((kvObj && kvObj.byMp) || {})) kv.set(k, { manual: (v && v.manual) || null, auto: (v && v.auto) || null });

const merged = new Map();
for (const [k, v] of byPub) merged.set(k, v);
for (const [k, v] of kv) merged.set(k, v);
const source = kv.size ? (byPub.size ? 'kv+public' : 'kv') : 'public';

const { title, body } = buildText(data, { unitRate: effRate(data) }, { total: (kvObj && kvObj.total) || 0, byMp: merged, error: null, source });
console.log(`date=${DAY}  marks.source=${source}  KV命中=${kv.size}点  合并=${merged.size}点`);
console.log('--- 各监测点率 ---');
for (const mp of data.monitorPoints) console.log(`   ${mp.mpName}: ${mp.realtime && mp.realtime.effeTransRate}%`);
console.log('\n===== 将会推送 =====');
console.log('标题: ' + title);
console.log(body || '（全部达标，正文为空）');
