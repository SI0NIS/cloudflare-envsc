// 公开平台故障告警测试（2026-10-24 事故复盘）
// 场景：公开平台返回 412/维护页 → run() 必须发一次 Bark 告警，且当天不重复。
// 运行：node tools/pubfail-test.mjs
import worker from '../src/index.js';

const store = {};
let barkCount = 0;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('api.day.app')) { barkCount++; return new Response(JSON.stringify({ code: 200 }), { status: 200 }); }
  if (u.includes('jkzx.envsc.cn')) {
    return new Response('<html><head><title>维护公告</title></head></html>', { status: 412 });
  }
  return new Response('{}', { status: 200 });
};

const env = {
  ENVSC_KV: {
    async get(k) { return store[k] ?? null; },
    async put(k, v) { store[k] = v; },
    async delete(k) { delete store[k]; },
  },
  BARK_KEY: 'testkey',
  CNEMC_PSID: '654000000031',
};

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS ', name); }
  else { fail++; console.log('FAIL ', name, detail !== undefined ? JSON.stringify(detail) : ''); }
};

const j1 = await (await worker.fetch(new Request('https://x/'), env, { waitUntil() {} })).json();
check('① 公开平台 412 → action=failed', j1.action === 'failed', j1);
check('② 发送一次 Bark 告警', barkCount === 1 && j1.alert && j1.alert.ok, { barkCount, alert: j1.alert });
check('③ 告警写入 KV 幂等键', !!store['pubfail:' + j1.date] || Object.keys(store).some((k) => k.startsWith('pubfail:')), Object.keys(store));

const j2 = await (await worker.fetch(new Request('https://x/'), env, { waitUntil() {} })).json();
check('④ 同日第二次失败 → 不重复告警', barkCount === 1 && j2.alert && j2.alert.skipped, { barkCount, alert: j2.alert });

console.log(`\n${pass}/${pass + fail} PASS`);
process.exit(fail ? 1 : 0);
