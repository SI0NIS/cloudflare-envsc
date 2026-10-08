#!/usr/bin/env node
// 诊断：dump 某个监测点某天 **未经 n>15 过滤** 的全部 zd_flag_ 窗口，
// 用于核对「连续标记期内不同内容应分段列出」的新规则。
// 用法: CNEMC_COOKIE=... node tools/dump-windows.mjs 2026-10-05 3号机组
const ROUTER = 'http://116.178.28.170:3080/amOnline/app/baseroute/requestRoute!list.page';
const REFERER = 'http://116.178.28.170:3080/amOnline/zdjk-company-base/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PSID = '654000000031';
const DATE = process.argv[2];
const MP_NAME = process.argv[3];
const COOKIE = process.env.CNEMC_COOKIE || '';
const pad2 = (x) => String(x).padStart(2, '0');
const fmtHM = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const BASELINE = new Set(['数据有效', '数据缺失', '通讯中断', '--']);
const toMs = (t) => { const d = new Date(String(t).replace(' ', 'T')); return isNaN(d.getTime()) ? 0 : d.getTime(); };

async function req(method, params) {
  const qs = new URLSearchParams({ method, ...params, _t: String(Date.now()) });
  for (let a = 0; a < 4; a++) {
    const r = await fetch(`${ROUTER}?${qs}`, {
      headers: { Cookie: COOKIE, Accept: 'application/json, text/plain, */*', 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': UA, Referer: REFERER },
    });
    const text = await r.text();
    if (r.status === 429) { await new Promise((s) => setTimeout(s, 1500 * (a + 1))); continue; }
    return { st: r.status, text };
  }
  return { st: 429, text: 'rate-limited' };
}

const r1 = await req('/psbase/mpinfo/getMpInfoByPsId', { psId: PSID });
const mps = (JSON.parse(r1.text).data || []).map((m) => ({ id: String(m.id), name: m.mpName, mpType: String(m.mpType) }));
const mp = mps.find((m) => m.name === MP_NAME);
if (!mp) { console.log('未找到监测点', MP_NAME, '| 现有:', mps.map((m) => m.name).join(',')); process.exit(1); }
const rowMinutes = mp.mpType === '4' ? 60 : 1;

const r2 = await req('online-monitor/data/list', {
  psId: PSID, id: mp.id, mpType: mp.mpType, dateType: mp.mpType === '4' ? '1' : '2',
  dateTime: `${DATE} 00:00:00,${DATE} 23:59:59`, isCity: '0', netWorkType: '1',
  normalKey: '0', industryType: '', zs: '', pageNum: '1', pageSize: '3000',
  filterItem: '', filterWork: 'false', sort: '0', props: 'data_time,zd_workcordSc,rg_workcordSc',
});
const rows = (JSON.parse(r2.text).data || {}).rows || [];
console.log(`${MP_NAME} mpType=${mp.mpType} rowMinutes=${rowMinutes} rows=${rows.length}\n`);

const byLabel = {};
for (const row of rows) {
  const raw = row.data_time && row.data_time.item && row.data_time.item.label;
  if (!raw) continue;
  let t = raw;
  if (rowMinutes >= 60) {
    const mm = String(raw).match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2})/);
    if (mm) t = `${mm[1]} ${String(mm[2]).padStart(2, '0')}:00:00`;
  }
  for (const [k, v] of Object.entries(row)) {
    if (!k.startsWith('zd_flag_')) continue;
    const it = v && v.item; const label = it && it.label;
    if (!label || label === '--' || BASELINE.has(label)) continue;
    const detail = (it.detail && (it.detail.r || it.detail.z)) || '';
    if (!byLabel[label]) byLabel[label] = { times: new Set(), detail };
    byLabel[label].times.add(t);
  }
}

const stepMs = rowMinutes * 60000;
const all = [];
for (const [label, info] of Object.entries(byLabel)) {
  const ts = [...info.times].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let cur = null;
  for (const t of ts) {
    const prev = cur ? cur.end : null;
    const gap = prev ? toMs(t) - toMs(prev) : 0;
    if (!cur) cur = { label, detail: info.detail, start: t, end: t, n: rowMinutes };
    else if (gap <= stepMs) { cur.end = t; cur.n = Math.round((toMs(cur.end) - toMs(cur.start)) / 60000) + rowMinutes; }
    else { all.push(cur); cur = { label, detail: info.detail, start: t, end: t, n: rowMinutes }; }
  }
  if (cur) all.push(cur);
}
all.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
console.log('原始窗口（未过滤 n>15）：');
for (const w of all) {
  const st = toMs(w.start);
  const ed = rowMinutes >= 60 ? st + w.n * 60000 : st + (w.n - 1) * 60000;
  console.log(`  ${fmtHM(new Date(st))}~${fmtHM(new Date(ed))}(${w.n}min) [${w.label}] ${w.n > 15 ? '保留' : '丢弃'}`);
}
