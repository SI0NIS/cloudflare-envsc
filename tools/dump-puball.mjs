// 探测公开平台 pollutant/list：**遍历所有监测点**，列出每个点的 code → 名称映射。
// 用途：确认工况参数（S0x/B0x）是否也都有正式名称，决定能否全部展示（2026-10-07）。
const API = 'https://jkzx.envsc.cn/transpublic-v2';
const PSID = '654000000031';
const DAY = process.argv[2] || '2026-10-06';
async function pubApi(method, path, body) {
  const url = new URL(API + path); url.searchParams.set('_t', String(Date.now()));
  const init = { method, headers: { Accept: 'application/json', Referer: 'https://jkzx.envsc.cn/transpublic-v2/2026/' } };
  if (body) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(url, init); return r.text();
}
const det = JSON.parse(await pubApi('POST', '/psinfo/psinfo/detail', { psId: PSID, dateType: 'DAY', start: `${DAY} 00:00:00`, end: `${DAY} 23:59:59` }));
const D = det.data || {};
const all = new Map(); // code -> Set(name)
for (const mp of D.transMpInfoList || []) {
  const list = JSON.parse(await pubApi('POST', '/psinfo/pollutant/list', { psId: PSID, mpId: mp.mpId, dateType: 'DAY', start: `${DAY} 00:00:00`, end: `${DAY} 23:59:59` }));
  const arr = list.data || [];
  console.log(`\n=== ${mp.mpName} (mpType=${mp.mpType}) 因子数=${arr.length} ===`);
  for (const f of arr) {
    const c = String(f.pollutantCode || '');
    console.log(`  ${c.padEnd(5)} = ${f.pollutantName}`);
    if (!all.has(c)) all.set(c, new Set());
    all.get(c).add(f.pollutantName);
  }
}
console.log('\n\n########## 全局 code -> 名称 ##########');
const PARAM = /^[SB]\d{2}$/i;
for (const [c, names] of [...all].sort()) {
  const tag = PARAM.test(c) ? ' [工况参数]' : '';
  const dup = names.size > 1 ? '  ⚠️多名称!' : '';
  console.log(`${c.padEnd(5)} = ${[...names].join(' / ')}${tag}${dup}`);
}
console.log(`\n总 code 数 = ${all.size}；工况参数 = ${[...all.keys()].filter((c) => PARAM.test(c)).length}`);
console.log(`工况参数缺名称 = ${[...all.keys()].filter((c) => PARAM.test(c) && ![...all.get(c)].filter(Boolean).length)}`);