/**
 * 阿里云 FC 入口冒烟测试（本机跑，不需要阿里云账号）
 * 验证三件事：定时触发器 event（Buffer）能解析、payload 里的 JSON 参数能传进去、HTTP 触发器鉴权正确。
 * 全部走 dry，不写 KV。
 * 用法：CNEMC_COOKIE=xxx node fc-smoke.cjs
 */
const mod = require('./scf-marks-sync/index.js');

const ok = (c, msg) => console.log(`${c ? 'PASS' : 'FAIL'}  ${msg}`);

(async () => {
  // A. 定时触发器：event 是 Buffer，payload 里放 JSON 参数
  const timerEvt = Buffer.from(JSON.stringify({
    triggerTime: '2026-09-27T04:55:00Z', triggerName: 'daily', payload: '{"date":"2026-09-26","dry":true}',
  }));
  const a = await mod.handler(timerEvt, {});
  ok(a && a.dry === true && Array.isArray(a.dates) && a.dates[0] === '2026-09-26' && a.written.length === 0,
    `定时触发器(Buffer) 解析参数 → dry=${a && a.dry} dates=${a && JSON.stringify(a.dates)}`);

  // B. 定时触发器：payload 是默认的非 JSON 串（"awesome-fc"），应忽略并按默认参数跑
  const b = await mod.handler(Buffer.from(JSON.stringify({ payload: 'awesome-fc', date: '2026-09-26', dry: true })), {});
  ok(b && b.dry === true, `payload 非 JSON 时回退默认参数 → dry=${b && b.dry}`);

  // C. HTTP 触发器：没配 ACCESS_TOKEN → 403
  const httpEvt = (q) => ({ version: 'v1', rawPath: '/', method: 'POST', headers: {}, queryParameters: q, body: '', isBase64Encoded: false });
  const c = await mod.handler(httpEvt({ k: 'x' }), {});
  ok(c && c.statusCode === 403, `HTTP 未配置 ACCESS_TOKEN → 403（实际 ${c && c.statusCode}）`);

  // D. HTTP 触发器：配了 ACCESS_TOKEN 且 ?k 正确 → 200，query 参数生效
  process.env.ACCESS_TOKEN = 'tok123';
  const d = await mod.handler(httpEvt({ k: 'tok123', date: '2026-09-26', dry: 'true' }), {});
  const dbody = d && JSON.parse(d.body);
  ok(d && d.statusCode === 200 && dbody && dbody.dry === true,
    `HTTP 带正确 token → 200，query 参数生效（dry=${dbody && dbody.dry}）`);

  // E. HTTP 触发器：token 错 → 403
  const e = await mod.handler(httpEvt({ k: 'wrong' }), {});
  ok(e && e.statusCode === 403, `HTTP token 错误 → 403（实际 ${e && e.statusCode}）`);
})();
