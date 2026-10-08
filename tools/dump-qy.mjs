#!/usr/bin/env node
/**
 * dump-qy.mjs —— 探测 /sign/qy/list 返回的完整字段，判断人工标记能否带上监测因子名。
 *
 * 用法：node tools/dump-qy.mjs 2026-10-03
 */
import fs from 'node:fs';

const cookieFile = process.argv[4] || 'C:/Users/Sionis/WorkBuddy/2026-09-16-21-43-51/_dm_cookie.txt';
const cookie = fs.readFileSync(cookieFile, 'utf8').trim();
const date = process.argv[2] || '2026-10-03';
const psid = process.env.CNEMC_PSID || '654000000031';
const ROUTER = 'http://116.178.28.170:3080/amOnline/app/baseroute/requestRoute!list.page';
const REFERER = 'http://116.178.28.170:3080/amOnline/zdjk-company-base/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = (c) => ({
  Cookie: c, Accept: 'application/json, text/plain, */*',
  'X-Requested-With': 'XMLHttpRequest', 'User-Agent': UA, Referer: REFERER,
});

async function req(method, params) {
  const qs = new URLSearchParams({ method, ...params, _t: String(Date.now()) }).toString();
  for (let a = 0; a < 4; a++) {
    const r = await fetch(`${ROUTER}?${qs}`, { headers: H(cookie) });
    const text = await r.text();
    if (r.status === 429) { await sleep(1500 * (a + 1)); continue; }
    return { st: r.status, text };
  }
  return { st: 429, text: 'rate-limited' };
}

for (const type of ['1', '2', '3', '4', '5']) {
  const { st, text } = await req('sign/qy/list', {
    pageNum: '1', pageSize: '200',
    dateTime: `${date},${date}`, type, moduleCode: '', mpId: '-1', shId: '-1', psId: psid, status: '-1',
  });
  if (st !== 200) { console.log(`type=${type} HTTP ${st}`); continue; }
  const j = JSON.parse(text);
  const rows = (j.data && j.data.rows) || [];
  console.log(`\n===== type=${type}  rows=${rows.length} =====`);
  if (!rows.length) continue;
  console.log('字段全集:', Object.keys(rows[0]).sort().join(', '));
  for (const x of rows.slice(0, 3)) {
    console.log('---- 样本 ----');
    for (const [k, v] of Object.entries(x)) {
      const s = String(v);
      console.log(`  ${k} = ${s.length > 120 ? s.slice(0, 120) + '…' : s}`);
    }
  }
  await sleep(400);
}