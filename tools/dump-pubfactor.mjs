// 探测公开平台 pollutant/list 的返回结构，找 3号机组 的因子 code → 名称 映射
const API = 'https://jkzx.envsc.cn/transpublic-v2';
const PSID = '654000000031';
const DAY = process.argv[2] || '2026-10-05';
async function pubApi(method, path, body) {
  const url = new URL(API + path); url.searchParams.set('_t', String(Date.now()));
  const init = { method, headers: { Accept: 'application/json', Referer: 'https://jkzx.envsc.cn/transpublic-v2/2026/' } };
  if (body) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(url, init); return r.text();
}
const det = JSON.parse(await pubApi('POST', '/psinfo/psinfo/detail', { psId: PSID, dateType: 'DAY', start: `${DAY} 00:00:00`, end: `${DAY} 23:59:59` }));
const D = det.data || {};
const mp = (D.transMpInfoList || []).find((m) => m.mpName === '3号机组');
console.log('mpId =', mp?.mpId, ' mpName =', mp?.mpName, ' 字段:', Object.keys(mp || {}).join(','));
const list = JSON.parse(await pubApi('POST', '/psinfo/pollutant/list', { psId: PSID, mpId: mp.mpId, dateType: 'DAY', start: `${DAY} 00:00:00`, end: `${DAY} 23:59:59` }));
const arr = list.data || [];
console.log(`\n因子数 = ${arr.length}`);
for (const f of arr) {
  console.log(JSON.stringify({ pollutantCode: f.pollutantCode, pollutantName: f.pollutantName, name: f.name, unit: f.unit, ...Object.fromEntries(Object.entries(f).filter(([k]) => /name|Name|code|Code|label|Label/.test(k))) }).slice(0, 300));
}
