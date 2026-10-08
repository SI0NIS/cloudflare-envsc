#!/usr/bin/env node
/**
 * dump-ww.mjs —— 探测废水点（mpType=4, dateType=1 小时）小时数据行里的标记字段，
 * 确认「标样核查」这类自动标记到底挂在哪个 key 上（zd_flag_ / rg_flag_ / wcgz_ …）。
 *
 * 同时列出废气点出现的所有 flag 类 key，用于确认工况参数编码（S0x/B0x）。
 *
 * 用法：node tools/dump-ww.mjs 2026-10-06
 */
import fs from 'node:fs';

const cookie = fs.readFileSync('C:/Users/Sionis/WorkBuddy/2026-09-16-21-43-51/_dm_cookie.txt', 'utf8').trim();
const date = process.argv[2] || '2026-10-06';
const psid = process.env.CNEMC_PSID || '654000000031';
const ROUTER = 'http://116.178.28.170:3080/amOnline/app/baseroute/requestRoute!list.page';
const REFERER = 'http://116.178.28.170:3080/amOnline/zdjk-company-base/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = (c) => ({
  Cookie: c, Accept: 'application/json, text/plain, */*',
  'X-Requested-With': 'XMLHttpRequest', 'User-Agent': UA, Referer: REFERER,
});
async function req(method, params) {
  const qs = new URLSearchParams({ method, ...params, _t: String(Date.now()) }).toString();
  for (let a = 0; a < 4; a++) {
    const r = await fetch(`${ROUTER}?${qs}`, { headers: H(cookie) });
    const text = await r.text();
    if (r.status === 429) { await sleep(1500 * (a + 1)); continue; }
    return { st: r.status, text };
  }
  return { st: 429, text: 'rate-limited' };
}

// 1) 监测点清单
const { text: t1 } = await req('/psbase/mpinfo/getMpInfoByPsId', { psId: psid });
const mps = (JSON.parse(t1).data || []).map((m) => ({ id: String(m.id), name: m.mpName, mpType: String(m.mpType) }));
console.log('监测点:', mps.map((m) => `${m.name}(mpType=${m.mpType})`).join(' | '));

// 2) 逐点抓数据，汇总所有 key
const BASELINE = new Set(['数据有效', '数据缺失', '通讯中断', '--']);
for (const mp of mps) {
  const dateType = mp.mpType === '4' ? '1' : '2';
  const params = {
    psId: psid, id: mp.id, mpType: mp.mpType, dateType,
    dateTime: `${date} 00:00:00,${date} 23:59:59`,
    isCity: '0', netWorkType: '1', normalKey: '0', industryType: '00', zs: '',
    pageNum: '1', pageSize: '3000', filterItem: '', filterWork: 'false', sort: '0',
    props: 'data_time,zd_workcordSc,rg_workcordSc',
  };
  const { st, text } = await req('online-monitor/data/list', params);
  if (st !== 200) { console.log(`${mp.name}: HTTP ${st}`); continue; }
  const rows = (JSON.parse(text).data || {}).rows || [];
  const keySet = new Set();
  const hits = {};   // key -> Set(label)
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      keySet.add(k);
      const it = v && v.item;
      const lb = it && it.label;
      if (!lb || lb === '--' || BASELINE.has(lb)) continue;
      const code = k.replace(/^[a-z]+_flag_/, '');
      (hits[k] = hits[k] || new Set()).add(lb);
    }
  }
  console.log(`\n===== ${mp.name} (mpType=${mp.mpType} dateType=${dateType}) 行=${rows.length} =====`);
  console.log('全部 key:', [...keySet].sort().join(', '));
  const flags = Object.entries(hits).filter(([k]) => /flag|zc|sc|check|bg/i.test(k));
  if (!flags.length) console.log('（本行无非基线标记）');
  for (const [k, set] of flags) {
    console.log(`  ${k} → ${[...set].join(' / ')}`);
  }
  await sleep(900);
}