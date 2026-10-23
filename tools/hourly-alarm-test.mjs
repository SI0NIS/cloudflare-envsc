// 小时超标判定单测（2026-10-23 落地）
// 覆盖：正常/超标、数据有效性过滤、标准值缺失、氧含量折算、max 模式、阈值倍数、evalRow 汇总。
// 运行：node tools/hourly-alarm-test.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { evalFactor, evalRow, judgePoint, judgeTiers, describeTier } = require('./local-sync/lib/exceed.js');

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '\n      ' + detail : ''}`);
}

// 构造企业端小时行（与真实返回同构）
function row(values = {}, stds = {}, flags = {}, time = '2026-10-22 11~12') {
  const r = { data_time: { item: { label: time } } };
  for (const [c, v] of Object.entries(values)) r[`avg_value_${c}`] = { item: { label: String(v) } };
  for (const [c, v] of Object.entries(stds)) r[`outlet_standard_${c}`] = { item: { label: String(v) } };
  for (const [c, v] of Object.entries(flags)) r[`flag_${c}`] = { item: { label: v } };
  return r;
}
const opts = { compare: 'avg_value', minRatio: 1, requireValid: true, o2Code: 'S01', baseO2: null };

// ① 低于标准 → 不超标
{
  const r = evalFactor(row({ '001': 2.657 }, { '001': 30 }, { '001': '数据有效' }), '001', opts);
  check('① 实测 2.657 / 标准 30 → 不超标', r && !r.exceeded && Math.abs(r.ratio - 0.0886) < 0.001, JSON.stringify(r));
}
// ② 超过标准 → 超标
{
  const r = evalFactor(row({ '002': 120 }, { '002': 100 }, { '002': '数据有效' }), '002', opts);
  check('② 实测 120 / 标准 100 → 超标，ratio=1.2', r && r.exceeded && r.ratio === 1.2, JSON.stringify(r));
}
// ③ 数据无效（flag=--）→ 按 requireValid 过滤
{
  const r = evalFactor(row({ '002': 120 }, { '002': 100 }, { '002': '--' }), '002', opts);
  check('③ flag=-- 且 requireValid → 不判超标', r && !r.exceeded && r.valid === false, JSON.stringify(r));
  const r2 = evalFactor(row({ '002': 120 }, { '002': 100 }, { '002': '--' }), '002', { ...opts, requireValid: false });
  check('③b requireValid=false → 仍判超标', r2 && r2.exceeded, JSON.stringify(r2));
}
// ④ 标准值缺失/为 0 → 返回 null（不误报）
{
  const a = evalFactor(row({ '001': 50 }, {}, {}), '001', opts);
  const b = evalFactor(row({ '001': 50 }, { '001': 0 }, {}), '001', opts);
  const c = evalFactor(row({ '001': '--' }, { '001': 30 }, {}), '001', opts);
  check('④ 缺标准/标准=0/值为-- → null', a === null && b === null && c === null, JSON.stringify([a, b, c]));
}
// ⑤ 氧含量折算：100 × (21-6)/(21-10) = 136.36
{
  const r = evalFactor(
    row({ '003': 100, S01: 10 }, { '003': 120 }, { '003': '数据有效' }),
    '003', { ...opts, compare: 'o2_corrected', baseO2: 6 },
  );
  check('⑤ 折算 136.36 > 120 → 超标（折算参与判定）',
    r && r.exceeded && Math.abs(r.corrected - 136.36) < 0.01 && Math.abs(r.judged - 136.36) < 0.01,
    JSON.stringify(r));
}
// ⑥ max 模式：实测 100、折算 136.36，标准 120 → 用 136.36
{
  const r = evalFactor(
    row({ '003': 100, S01: 10 }, { '003': 120 }, { '003': '数据有效' }),
    '003', { ...opts, compare: 'max', baseO2: 6 },
  );
  check('⑥ max 模式取较大值 136.36', r && r.exceeded && Math.abs(r.judged - 136.36) < 0.01, JSON.stringify(r));
}
// ⑦ minRatio：超 5% 但阈值 1.1 → 不告警
{
  const r = evalFactor(row({ '001': 105 }, { '001': 100 }, { '001': '数据有效' }), '001', { ...opts, minRatio: 1.1 });
  check('⑦ minRatio=1.1 时 1.05 不告警', r && !r.exceeded, JSON.stringify(r));
}
// ⑧ evalRow：只返回超标项，并带时间
{
  const r = row({ '001': 40, '002': 50, '003': 200 }, { '001': 30, '002': 100, '003': 100 }, { '001': '数据有效', '002': '数据有效', '003': '数据有效' });
  const out = evalRow(r, ['001', '002', '003'], opts);
  check('⑧ evalRow 只返回超标项（001、003），带 time',
    out.length === 2 && out.map((x) => x.code).sort().join(',') === '001,003' && out[0].time === '2026-10-22 11~12',
    JSON.stringify(out.map((x) => ({ code: x.code, ratio: x.ratio }))));
}
// ⑨ 边界：恰好等于标准 → 不算超标（严格大于）
{
  const r = evalFactor(row({ '001': 30 }, { '001': 30 }, { '001': '数据有效' }), '001', opts);
  check('⑨ 恰好等于标准 → 不超标', r && !r.exceeded && r.ratio === 1, JSON.stringify(r));
}
// ⑩ O2 缺失/异常时折算退回实测
{
  const r = evalFactor(row({ '003': 130 }, { '003': 100 }, { '003': '数据有效' }), '003', { ...opts, compare: 'o2_corrected', baseO2: 6 });
  check('⑩ 无 O2 数据 → 折算退回实测（130 > 100 仍超标）', r && r.exceeded && r.corrected === null && r.judged === 130, JSON.stringify(r));
}

// ⑪ judgePoint：废气用折算值（2026-10-23 用户确认口径）
{
  const r = judgePoint(100, 130, 120, '数据有效', { useZs: true, minRatio: 1, requireValid: true });
  check('⑪ 废气：实测 100 / 折算 130 / 标准 120 → 按折算判超标', r && r.exceeded && r.usedZs && r.judged === 130, JSON.stringify(r));
}
// ⑫ 废水（无折算）：用实测
{
  const r = judgePoint(100, null, 120, '数据有效', { useZs: true, minRatio: 1, requireValid: true });
  check('⑫ 废水/无折算：退回实测 100 < 120 → 不超标', r && !r.exceeded && !r.usedZs && r.judged === 100, JSON.stringify(r));
}
// ⑬ 废气但折算缺失 → 退回实测
{
  const r = judgePoint(130, null, 120, '数据有效', { useZs: true, minRatio: 1, requireValid: true });
  check('⑬ 废气折算缺失 → 实测 130 > 120 仍超标', r && r.exceeded && !r.usedZs, JSON.stringify(r));
}
// ⑭ 数据无效 → 不判
{
  const r = judgePoint(200, 300, 120, '--', { useZs: true, minRatio: 1, requireValid: true });
  check('⑭ flag=-- 且 requireValid → 不判超标', r && !r.exceeded && r.valid === false, JSON.stringify(r));
}

// ⑮ 双层标准：A 级严、排放标准宽（2026-10-23 用户要求说明超出哪个标准）
{
  // 颗粒物折算 12：A级 10 超、排放 30 未超 → 只算 A 级预警
  const r = judgeTiers(12, 12, 10, 30, '数据有效', { useZs: true, minRatio: 1, requireValid: true });
  check('⑮ 12 / A级10 / 排放30 → 仅超A级（tier=a）', r && r.exceedA && !r.exceedLegal && r.tier === 'a', JSON.stringify(r));
}
{
  // 非甲烷总烃折算 35：A级 30 超、排放 100 未超
  const r = judgeTiers(35, 35, 30, 100, '数据有效', { useZs: true, minRatio: 1, requireValid: true });
  check('⑯ 35 / A级30 / 排放100 → 仅超A级', r && r.exceedA && !r.exceedLegal && r.tier === 'a'
    && Math.abs(r.ratioLegal - 0.35) < 1e-9, JSON.stringify(r));
}
{
  // 折算 120：两层都超 → tier=legal
  const r = judgeTiers(120, 120, 30, 100, '数据有效', { useZs: true, minRatio: 1, requireValid: true });
  check('⑰ 120 / A级30 / 排放100 → 两层均超（tier=legal）', r && r.exceedA && r.exceedLegal && r.tier === 'legal', JSON.stringify(r));
}
{
  // 只有 A 级标准（平台未配置排放标准）
  const r = judgeTiers(35, 35, 30, null, '数据有效', { useZs: true, minRatio: 1, requireValid: true });
  check('⑱ 平台无排放标准 → 仍按A级判定（stdLegal=null）', r && r.exceedA && r.stdLegal === null && r.tier === 'a', JSON.stringify(r));
}
{
  // 只有排放标准（该因子无 A 级值）
  const r = judgeTiers(120, 120, null, 100, '数据有效', { useZs: true, minRatio: 1, requireValid: true });
  check('⑲ 仅排放标准 → 超排放（tier=legal）', r && !r.exceedA && r.exceedLegal && r.tier === 'legal', JSON.stringify(r));
}
{
  // 数据无效：两层都不判
  const r = judgeTiers(120, 120, 30, 100, '--', { useZs: true, minRatio: 1, requireValid: true });
  check('⑳ flag=-- 且 requireValid → 两层都不判超标', r && !r.exceedA && !r.exceedLegal && !r.exceeded, JSON.stringify(r));
}

// ㉑ 配置表：A 级颗粒物 10、非甲烷总烃 508=30（编码来自 /monitoritem/pollutant/list）
{
  const fs = await import('node:fs');
  const std = JSON.parse(fs.readFileSync(new URL('../config/standards.json', import.meta.url), 'utf8'));
  const gasA = (std.a && std.a._gas) || {};
  check('㉑ standards.json：A级 001=10、508=30（双层结构）',
    Number(gasA['001']) === 10 && Number(gasA['508']) === 30 && !!std.legal,
    JSON.stringify({ a: gasA, legal: !!std.legal }));
}

// ㉒ 文案：仅超 A 级 → 明确「未超排放标准」
{
  const r = judgeTiers(35, 35, 30, 100, '数据有效', { useZs: true, minRatio: 1, requireValid: true });
  const t = describeTier(r);
  check('㉒ 仅超A级文案：超A级标准 30…未超排放标准 100',
    /超A级标准 30/.test(t) && /未超排放标准 100/.test(t), t);
}
// ㉓ 文案：两层均超 → 先写排放标准（法定超标），注明 A 级亦超
{
  const r = judgeTiers(120, 120, 30, 100, '数据有效', { useZs: true, minRatio: 1, requireValid: true });
  const t = describeTier(r);
  check('㉓ 两层均超文案：超排放标准 100…A级标准 30 亦超',
    /超排放标准 100/.test(t) && /A级标准 30 亦超/.test(t), t);
}
// ㉔ 平台未配置排放标准 → 文案注明
{
  const r = judgeTiers(35, 35, 30, null, '数据有效', { useZs: true, minRatio: 1, requireValid: true });
  check('㉔ 无排放标准文案：平台未配置排放标准', /平台未配置排放标准/.test(describeTier(r)), describeTier(r));
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} PASS`);
process.exit(failed.length ? 1 : 0);
