/**
 * 本机试跑 SCF 同步逻辑（默认 dry：只抓不写 KV），用于排查"某天为什么没有标记"、或手工补写某天标记。
 * 用法：
 *   node scf-dry.mjs 2026-09-25            # 只抓不写，打印抓取过程
 *   node scf-dry.mjs 2026-09-26 --write    # 抓完直接写进 Cloudflare KV（幂等，与云函数结果一致）
 * 依赖环境变量：CNEMC_COOKIE（必）、CNEMC_PSID（默认 654000000031）
 *             写 KV 还需 CF_ACCOUNT_ID / CF_KV_NAMESPACE_ID / CF_API_TOKEN
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const mod = require('./scf-marks-sync/index.js');

const date = process.argv[2];
if (!date) { console.error('用法: node scf-dry.mjs YYYY-MM-DD'); process.exit(1); }

process.env.CNEMC_COOKIE = process.env.CNEMC_COOKIE || '';
process.env.CNEMC_PSID = process.env.CNEMC_PSID || '654000000031';
if (!process.env.CNEMC_COOKIE) { console.error('缺少 CNEMC_COOKIE'); process.exit(1); }

const write = process.argv.includes('--write');
if (write) {
  for (const k of ['CF_ACCOUNT_ID', 'CF_KV_NAMESPACE_ID', 'CF_API_TOKEN']) {
    if (!process.env[k]) { console.error(`--write 需要环境变量 ${k}`); process.exit(1); }
  }
}
const r = await mod.main_handler({ date, dry: !write, silent: true, days: 1 }, {});
console.log('---- RESULT ----');
console.log(JSON.stringify({ ...r, log: undefined }, null, 2));
console.log((r.log || []).join('\n'));
