#!/usr/bin/env node
/**
 * wecom-test.mjs —— pushWecom 本地单测（2026-10-16 新增）
 *
 * 覆盖：短消息单条发送 / 超长消息按行分片且每片 ≤1900 字节 / 无 webhook 不发送 /
 *       errcode!=0 视为失败 / 请求体格式（msgtype=text）。
 * 不访问真实网络：通过替换 globalThis.fetch 捕获请求。
 */
import { pushWecom } from '../src/index.js';

let n = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  n++;
  if (cond) console.log(`PASS  ${name}`);
  else { fail++; console.log(`FAIL  ${name}${extra ? '  | ' + extra : ''}`); }
};
const utf8Len = (s) => new TextEncoder().encode(s).length;

// ---- fetch 桩：记录请求，返回可配置响应 ----
let calls = [];
let respBody = { errcode: 0, errmsg: 'ok' };
let respStatus = 200;
globalThis.fetch = async (url, init) => {
  calls.push({ url, body: JSON.parse(init.body) });
  return new Response(JSON.stringify(respBody), { status: respStatus });
};

const ENV = { WECOM_WEBHOOK: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=TEST' };

// ① 短消息 → 单条，标题+正文
calls = [];
let r = await pushWecom(ENV, '20261015有效传输率100%', '异常监控点（1 / 5 个）：\n· 1号机组　即时 98% / 补全 99%');
ok(r.ok && r.chunks === 1 && calls.length === 1, '① 短消息单条发送');
ok(calls[0].body.msgtype === 'text' && calls[0].body.text.content === '20261015有效传输率100%\n异常监控点（1 / 5 个）：\n· 1号机组　即时 98% / 补全 99%',
  '①b 请求体为 text 且标题+正文拼接正确');

// ② 仅标题（全达标场景）
calls = [];
r = await pushWecom(ENV, '20261015有效传输率100%', '');
ok(r.ok && calls[0].body.text.content === '20261015有效传输率100%', '② 无正文只发标题');

// ③ 超长消息 → 多片、每片 ≤1900 字节、顺序完整
calls = [];
const lines = [];
for (let i = 0; i < 40; i++) lines.push(`· 监控点${i}　即时 9x% / 补全 9y%；自动标记：二氧化硫 故障 14:00~15:00(60min)`);
const longBody = lines.join('\n');
r = await pushWecom(ENV, 'T', longBody);
const allByteOk = calls.every((c) => utf8Len(c.body.text.content) <= 1900);
ok(r.ok && calls.length >= 2 && calls.length <= 5, `③ 超长消息分片（${calls.length} 片）`);
ok(allByteOk, '③b 每片均 ≤1900 字节');
const joined = calls.map((c) => c.body.text.content).join('\n');
ok(joined.includes(lines[0]) && joined.includes(lines[39]) === false ? joined.includes('内容过长') : true,
  '③c 分片保留前文（如超5片则末片带截断标记）');
ok(r.chunks === calls.length, '③d 返回值与实际请求数一致');

// ④ 未配置 webhook → 不发请求
calls = [];
r = await pushWecom({}, 'T', 'b');
ok(!r.ok && r.error.includes('未配置') && calls.length === 0, '④ 未配置时不发送');

// ⑤ 服务端 errcode≠0 → 失败
calls = [];
respBody = { errcode: 93000, errmsg: 'invalid webhook url' };
r = await pushWecom(ENV, 'T', 'b');
ok(!r.ok && r.resp && r.resp.errcode === 93000, '⑤ 非零 errcode 判失败');
respBody = { errcode: 0, errmsg: 'ok' };

// ⑥ 网络异常 → 失败不抛出
calls = [];
globalThis.fetch = async () => { throw new Error('boom'); };
r = await pushWecom(ENV, 'T', 'b');
ok(!r.ok && r.error === 'boom', '⑥ 网络异常返回失败对象');

console.log(`\n${n - fail}/${n} ${fail ? 'FAILED' : 'PASS'}`);
process.exit(fail ? 1 : 0);
