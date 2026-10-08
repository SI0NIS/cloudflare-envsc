#!/usr/bin/env node
// 诊断：dump data/list 单行的完整 JSON 结构，确认 zd_flag_* 各字段里是否带监测因子名。
// 用法: CNEMC_COOKIE=... node tools/dump-row.mjs 2026-10-05 3号机组 [HH:MM]
const ROUTER = 'http://116.178.28.170:3080/amOnline/app/baseroute/requestRoute!list.page';
const REFERER = 'http://116.178.28.170:3080/amOnline/zdjk-company-base/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PSID = '654000000031';
const DATE = process.argv[2], MP_NAME = process.argv[3], AT = process.argv[4];
const COOKIE = process.env.CNEMC_COOKIE || '';
async function req(method, params) {
  const qs = new URLSearchParams({ method, ...params, _t: String(Date.now()) });
  for (let a = 0; a < 4; a++) {
    const r = await fetch(`${ROUTER}?${qs}`, { headers: { Cookie: COOKIE, Accept: 'application/json, text/plain, */*', 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': UA, Referer: REFERER } });
    const text = await r.text();
    if (r.status === 429) { await new Promise((s) => setTimeout(s, 1500 * (a + 1))); continue; }
    return text;
  }
  return 'rate-limited';
}
const mps = (JSON.parse(await req('/psbase/mpinfo/getMpInfoByPsId', { psId: PSID })).data || []).map((m) => ({ id: String(m.id), name: m.mpName, mpType: String(m.mpType) }));
const mp = mps.find((m) => m.name === MP_NAME);
if (!mp) { console.log('未找到', MP_NAME); process.exit(1); }
const t = await req('online-monitor/data/list', {
  psId: PSID, id: mp.id, mpType: mp.mpType, dateType: mp.mpType === '4' ? '1' : '2',
  dateTime: `${DATE} 00:00:00,${DATE} 23:59:59`, isCity: '0', netWorkType: '1', normalKey: '0',
  industryType: '', zs: '', pageNum: '1', pageSize: '3000', filterItem: '', filterWork: 'false', sort: '0',
  props: 'data_time,zd_workcordSc,rg_workcordSc',
});
const rows = (JSON.parse(t).data || {}).rows || [];
console.log(`rows=${rows.length}`);
// 找第一行含 zd_flag_ 且非基线的
const hit = AT ? rows.find((r) => String(r.data_time?.item?.label || '').includes(AT)) : rows.find((r) => Object.keys(r).some((k) => k.startsWith('zd_flag_')));
if (!hit) { console.log('没找到含 zd_flag_ 的行'); process.exit(0); }
console.log('data_time =', hit.data_time?.item?.label);
for (const [k, v] of Object.entries(hit)) {
  if (k === 'data_time') continue;
  console.log(`${k} = ${JSON.stringify(v)}`);
}
