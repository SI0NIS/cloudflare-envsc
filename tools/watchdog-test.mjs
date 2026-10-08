// 看门狗单元测试：用假 KV + 冻结时钟覆盖 6 种情形，全程不发真实网络请求。
// 运行：node tools/watchdog-test.mjs
const TZ = 8 * 3600 * 1000;
const ymd = (d) => new Date(d.getTime() + TZ).toISOString().slice(0, 10);

// 冻结"现在"：替换全局 Date，使 new Date() 与 Date.now() 都返回固定时刻
function freezeBeijing(hh, mm) {
  const RealDate = Date;
  const base = new Date(RealDate.now());
  const cn = new Date(base.getTime() + TZ);
  cn.setUTCHours(hh, mm, 0, 0);
  const ms = new Date(cn.getTime() - TZ).getTime();
  class FakeDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(ms); else super(...args); }
    static now() { return ms; }
  }
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  globalThis.Date = FakeDate;
  return { ms, restore: () => { globalThis.Date = RealDate; } };
}

// 拦截 fetch，避免真去打 Bark
globalThis.fetch = async () => ({
  ok: true, status: 200,
  text: async () => JSON.stringify({ code: 200, message: 'success (stub)' }),
});

const { watchdog } = await import('../src/index.js');

function fakeKV(store = {}) {
  return {
    store,
    async get(k) { return k in this.store ? this.store[k] : null; },
    async put(k, v) { this.store[k] = v; },
    async delete(k) { delete this.store[k]; },
  };
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`);
}

{
  const f = freezeBeijing(13, 0);
  const today = ymd(new Date(f.ms));
  const d1 = ymd(new Date(f.ms - 86400000));
  const kv = fakeKV();
  const r = await watchdog({ ENVSC_KV: kv, BARK_KEY: 'stub' });
  f.restore();
  check('① 13:05 之前跳过（避免误报）', r.watchdog === 'skip', r);
  check('① 未写幂等键', !kv.store[`wd:${today}`]);
  console.log(`   today=${today} d1=${d1}`);
}

{
  const f = freezeBeijing(14, 0);
  const today = ymd(new Date(f.ms));
  const kv = fakeKV();
  const r = await watchdog({ ENVSC_KV: kv, BARK_KEY: 'stub' });
  f.restore();
  check('② 缺 marks:<D-1> → 告警', r.watchdog === 'alerted', r);
  check('② 写入幂等键 wd:<today>', !!kv.store[`wd:${today}`], Object.keys(kv.store));
}

{
  const f = freezeBeijing(15, 0);
  const today = ymd(new Date(f.ms));
  const kv = fakeKV({ [`wd:${today}`]: new Date(f.ms).toISOString() });
  const r = await watchdog({ ENVSC_KV: kv, BARK_KEY: 'stub' });
  f.restore();
  check('③ 当天不重复告警', r.watchdog === 'skip' && String(r.why).includes('已告警'), r);
}

{
  const f = freezeBeijing(16, 0);
  const d1 = ymd(new Date(f.ms - 86400000));
  const kv = fakeKV({ [`marks:${d1}`]: JSON.stringify({ total: 0, byMp: {}, at: new Date(f.ms - 86400000).toISOString() }) });
  const r = await watchdog({ ENVSC_KV: kv, BARK_KEY: 'stub' });
  f.restore();
  check('④ 时间戳非今日 → 告警', r.watchdog === 'alerted', r);
}

{
  const f = freezeBeijing(17, 0);
  const d1 = ymd(new Date(f.ms - 86400000));
  const kv = fakeKV({ [`marks:${d1}`]: JSON.stringify({ total: 2, byMp: {}, at: new Date(f.ms).toISOString() }) });
  const r = await watchdog({ ENVSC_KV: kv, BARK_KEY: 'stub' });
  f.restore();
  check('⑤ 今日已落库 → ok（不告警）', r.watchdog === 'ok', r);
}

{
  const f = freezeBeijing(18, 0);
  const r = await watchdog({ BARK_KEY: 'stub' });
  f.restore();
  check('⑥ 未绑定 KV → 安全跳过', r.watchdog === 'skip', r);
}

const failed = results.filter((x) => !x.pass).length;
console.log(`\n${results.length - failed}/${results.length} PASS`);
process.exit(failed ? 1 : 0);
