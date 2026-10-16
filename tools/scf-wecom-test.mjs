#!/usr/bin/env node
/**
 * scf-wecom-test.mjs —— SCF 云函数「企微推送」单测（2026-10-16 新增）
 *
 * 覆盖：正常发送 / 无 webhook 不发送 / 非零 errcode 判失败 / 超长截断 / 网络异常。
 * 不访问真实网络：替换 globalThis.fetch 捕获请求。
 * 注意：本测试仅加载 SCF 模块的函数定义，不会执行任何云端同步逻辑。
 */
import mod from './scf-marks-sync/index.js';

const { _test } = mod;
let n = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  n++;
  if (cond) console.log(`PASS  ${name}`);
  else { fail++; console.log(`FAIL  ${name}${extra ? '  | ' + extra : ''}`); }
};

let calls = [];
let resp = { errcode: 0, errmsg: 'ok' };
globalThis.fetch = async (url, init) => {
  calls.push({ url, body: JSON.parse(init.body) });
  return new Response(JSON.stringify(resp), { status: 200 });
};

// ① 正常发送
calls = [];
let r = await _test.pushWecom('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=T', '标题', '正文');
ok(r.ok && calls.length === 1 && calls[0].body.msgtype === 'text' && calls[0].body.text.content === '标题\n正文', '① 正常发送 text 消息');

// ② 无 webhook → 不发送
calls = [];
r = await _test.pushWecom('', 't', 'b');
ok(!r.ok && calls.length === 0 && /no WECOM_WEBHOOK/.test(r.error || ''), '② 无 webhook 不发送');

// ③ 服务端 errcode≠0 → 失败
resp = { errcode: 93000, errmsg: 'invalid webhook url' };
r = await _test.pushWecom('https://x', 't', 'b');
ok(!r.ok && r.resp && r.resp.errcode === 93000, '③ 非零 errcode 判失败');

// ④ 超长内容自动截断（≤1900 字节，含省略号）
resp = { errcode: 0, errmsg: 'ok' };
calls = [];
const big = '· 测试行 1234567890\n'.repeat(300);
r = await _test.pushWecom('https://x', 'T', big);
const len = Buffer.byteLength(calls[0].body.text.content, 'utf8');
ok(r.ok && len <= 1900 && calls[0].body.text.content.endsWith('…'), `④ 超长内容自动截断（${len} 字节）`);

// ⑤ 网络异常 → 失败不抛出
globalThis.fetch = async () => { throw new Error('boom'); };
r = await _test.pushWecom('https://x', 't', 'b');
ok(!r.ok && r.error === 'boom', '⑤ 网络异常返回失败对象');

console.log(`\n${n - fail}/${n} ${fail ? 'FAILED' : 'PASS'}`);
process.exit(fail ? 1 : 0);
