// 维护期欠推日报：故障登记 → 平台恢复 → 按旧→新补推 → 幂等清空。
// 运行：node tools/backfill-test.mjs
import { runCycle } from '../src/index.js';

const TEST_DAY = '2026-10-24';
let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS ', name); }
  else { fail++; console.log('FAIL ', name, detail !== undefined ? JSON.stringify(detail) : ''); }
};

const makeEnv = (store) => ({
  ENVSC_KV: {
    async get(k) { return store[k] ?? null; },
    async put(k, v) { store[k] = String(v); },
    async delete(k) { delete store[k]; },
  },
  BARK_KEY: 'testkey',
  CNEMC_PSID: '654000000031',
});

let platformUp = false;
let platformEnd = TEST_DAY;
let platformDetailEmpty = false;
let barkTitles = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes('api.day.app')) {
    const body = JSON.parse(init.body || '{}');
    barkTitles.push(body.title);
    return new Response(JSON.stringify({ code: 200, message: 'success' }), { status: 200 });
  }
  if (u.includes('jkzx.envsc.cn')) {
    if (!platformUp) return new Response(JSON.stringify({ code: 412, message: 'maintenance' }), { status: 200 });
    if (u.includes('/region/begin-end-time')) {
      return new Response(JSON.stringify({ code: 200, data: { beginTime: '2023-01-01 00:00:00', endTime: platformEnd } }), { status: 200 });
    }
    if (u.includes('/psinfo/psinfo/detail')) {
      if (platformDetailEmpty) {
        return new Response(JSON.stringify({
          code: 200,
          data: { psName: '测试企业', realtime: {}, comple: {}, transMpInfoList: [] },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        code: 200,
        data: {
          psName: '测试企业',
          realtime: { effeTransRate: 100 },
          comple: { effeTransRate: 100 },
          transMpInfoList: [{ mpId: 'm1', mpName: '总排口', realtime: { effeTransRate: 100 }, comple: { effeTransRate: 100 } }],
        },
      }), { status: 200 });
    }
    if (u.includes('/psinfo/pollutant/list')) {
      return new Response(JSON.stringify({ code: 200, data: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: 200, data: [] }), { status: 200 });
  }
  throw new Error(`unexpected fetch: ${u}`);
};

// ① 平台故障：登记 10-23、10-24，两个日期都保留在 KV 欠推列表
{
  const store = {};
  const env = makeEnv(store);
  platformUp = false;
  barkTitles = [];
  const r = await runCycle(env, { day: TEST_DAY });
  check('① 平台故障 → action=failed', r.ok === false && r.action === 'failed', r);
  check('② 自动登记维护期两个欠推日期', r.backfill.pendingAfter === 2 && r.backfill.pendingDates.join(',') === '2026-10-23,2026-10-24', r.backfill);
  check('③ 欠推列表写入 KV', store['backfill:pending'] === '["2026-10-23","2026-10-24"]', store['backfill:pending']);

  // ② 平台接口已恢复，但最终数据日仍停在 10-22：not_ready 必须保留两个欠推日期
  platformUp = true;
  platformEnd = '2026-10-22';
  const r1b = await runCycle(env, { day: TEST_DAY });
  check('③ 数据未就绪 → action=not_ready', r1b.ok === true && r1b.action === 'not_ready', r1b);
  check('④ 未就绪不清空欠推队列', r1b.backfill.pendingDates.join(',') === '2026-10-23,2026-10-24' && store['backfill:pending'] === '["2026-10-23","2026-10-24"]', r1b.backfill);
  check('⑤ 未就绪不写日报去重键', !store['2026-10-23'] && !store['2026-10-24'], Object.keys(store).sort());

  // ③ 日期已推进但明细仍为空：同样必须 not_ready，不能补推 0%
  platformEnd = TEST_DAY;
  platformDetailEmpty = true;
  const r1c = await runCycle(env, { day: TEST_DAY });
  check('③b 日期已推进但明细无监测点 → not_ready', r1c.ok === true && r1c.action === 'not_ready', r1c);
  check('④b 明细为空仍保留欠推队列', r1c.backfill.pendingDates.join(',') === '2026-10-23,2026-10-24' && store['backfill:pending'] === '["2026-10-23","2026-10-24"]', r1c.backfill);
  check('⑤b 明细为空不写日报去重键', !store['2026-10-23'] && !store['2026-10-24'], Object.keys(store).sort());

  // ④ 平台数据恢复：先推 D-1，再补 10-23，各一条 Bark，成功后清空队列
  platformDetailEmpty = false;
  platformUp = true;
  const r2 = await runCycle(env, { day: TEST_DAY });
  check('⑥ 恢复后补推成功', r2.ok === true && r2.backfill.pushedDates.slice().sort().join(',') === '2026-10-23,2026-10-24', r2);
  check('⑦ 两个日报去重键均已写入', !!store['2026-10-23'] && !!store['2026-10-24'], Object.keys(store).sort());
  check('⑧ 欠推队列已清空', r2.backfill.pendingAfter === 0 && store['backfill:pending'] === '[]', { pending: r2.backfill, kv: store['backfill:pending'] });
  check('⑨ 每个欠推日各推送一次', barkTitles.length === 2 && barkTitles.some((t) => t.includes('20261023')) && barkTitles.some((t) => t.includes('20261024')), barkTitles);

  // ③ 再次运行：命中去重，不重复打扰
  const n = barkTitles.length;
  const r3 = await runCycle(env, { day: TEST_DAY });
  check('⑩ 已补推日期再次运行 → skipped 且不再发 Bark', r3.action === 'skipped' && barkTitles.length === n, { action: r3.action, barkTitles });
}

// ④ 单次最多补 3 天；剩余日期留到下一整点
{
  const store = { 'backfill:pending': JSON.stringify(['2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24']) };
  const env = makeEnv(store);
  platformUp = true;
  barkTitles = [];
  const r = await runCycle(env, { day: TEST_DAY });
  check('⑪ 单次最多处理 3 个日期', r.backfill.attemptedDates.length === 3 && r.backfill.pushedDates.length === 3, r.backfill);
  check('⑫ 未处理的旧日期继续留在队列', r.backfill.pendingDates.join(',') === '2026-10-23', r.backfill.pendingDates);
  check('⑬ 限流时 Bark 也只发 3 条', barkTitles.length === 3, barkTitles);
}

// ⑤ 首次扫描时已有去重键的日期不补推
{
  const store = { '2026-10-23': JSON.stringify({ at: '2026-10-24T00:00:00.000Z' }) };
  const env = makeEnv(store);
  platformUp = true;
  barkTitles = [];
  const r = await runCycle(env, { day: TEST_DAY });
  check('⑭ 已有去重键的日期不重复推送', r.backfill.pushedDates.join(',') === '2026-10-24', r.backfill);
  check('⑮ 已有去重键的日期不进入欠推队列', r.backfill.pendingAfter === 0 && !r.backfill.pendingDates.includes('2026-10-23'), r.backfill.pendingDates);
}

console.log(`\n${pass}/${pass + fail} PASS`);
process.exit(fail ? 1 : 0);
