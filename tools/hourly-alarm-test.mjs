// 小时数据异常判定单测（2026-10-23 落地，2026-10-26 增加有效负值）
// 覆盖：正常/超标、数据有效性过滤、标准值缺失、氧含量折算、max 模式、阈值倍数、evalRow 汇总、异常负值。
// 运行：node tools/hourly-alarm-test.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { evalFactor, evalRow, judgePoint, judgeTiers, judgeRange, describeTier, formatPushValue, describePushTitle } = require('./local-sync/lib/exceed.js');

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

// ㉕ 排放标准兜底值：平台截图核实（颗粒物 30、SO2 100、NOx 100、非甲烷总烃 100）
{
  const fs = await import('node:fs');
  const std = JSON.parse(fs.readFileSync(new URL('../config/standards.json', import.meta.url), 'utf8'));
  const L = (std.legal && std.legal._gas) || {};
  check('㉕ 排放标准兜底：001=30、002=100、003=100、508=100',
    Number(L['001']) === 30 && Number(L['002']) === 100
    && Number(L['003']) === 100 && Number(L['508']) === 100, JSON.stringify(L));
  const A = (std.a && std.a._gas) || {};
  check('㉖ A级严于排放标准（001、508 必须更小）',
    Number(A['001']) < Number(L['001']) && Number(A['508']) < Number(L['508']),
    `A=${JSON.stringify(A)} L=${JSON.stringify(L)}`);
}

// ㉗ 点位级法定限值：火电 SO2 35 / NOx 50，废水 pH 6-9 / COD 50 / 氨氮 5
{
  const fs = await import('node:fs');
  const std = JSON.parse(fs.readFileSync(new URL('../config/standards.json', import.meta.url), 'utf8'));
  const L = std.legal || {};
  check('㉗ 火电两机组：SO2=35、NOx=50',
    Number(L['3号机组']?.['002']) === 35 && Number(L['3号机组']?.['003']) === 50
    && Number(L['1号2号机组']?.['002']) === 35 && Number(L['1号2号机组']?.['003']) === 50,
    JSON.stringify({ a: L['3号机组'], b: L['1号2号机组'] }));
  check('㉘ 总排口：pH=6-9、COD=50、氨氮=5',
    String(L['总排口']?.['001']) === '6-9' && Number(L['总排口']?.['011']) === 50 && Number(L['总排口']?.['060']) === 5,
    JSON.stringify(L['总排口']));
}
// ㉙ pH 区间判定
{
  const inRange = judgeRange(8.015, 8.09, null, '6-9', '数据有效', { requireValid: true });
  check('㉙ pH 8.015~8.09 / 6-9 → 正常', inRange && !inRange.exceeded && inRange.range, JSON.stringify(inRange));
  const low = judgeRange(5.5, 6.2, null, '6-9', '数据有效', { requireValid: true });
  check('㉚ pH 5.5~6.2 / 6-9 → 超下限', low && low.exceedLegal && low.exceeded, JSON.stringify(low));
  const high = judgeRange(8.8, 9.2, null, '6-9', '数据有效', { requireValid: true });
  check('㉛ pH 8.8~9.2 / 6-9 → 超上限', high && high.exceedLegal && high.exceeded, JSON.stringify(high));
  const bad = judgeRange(8, 9, null, '6-9', '--', { requireValid: true });
  check('㉜ flag=-- → pH 不判超标', bad && !bad.exceeded, JSON.stringify(bad));
}
// ㉝ 火电 SO2 40：超配置排放标准 35（若按平台 100 则不会报）
{
  const r = judgeTiers(40, 40, null, 35, '数据有效', { useZs: true, minRatio: 1, requireValid: true });
  check('㉝ SO2 40 / 排放35 → 超标', r && r.exceedLegal && r.tier === 'legal', JSON.stringify(r));
}

// ㉞ 数据有效负值：即使低于标准也按数据异常推送
{
  const r = judgeTiers(-1.234, -1.512, 10, 30, '数据有效', { useZs: true, minRatio: 1, requireValid: true });
  check('㉞ 数据有效负值 → 异常，tier=negative',
    r && r.negative && r.exceeded && r.tier === 'negative' && !r.exceedA && !r.exceedLegal
    && r.ratioA === null && r.ratioLegal === null && /异常负值/.test(describeTier(r)),
    JSON.stringify(r));
}
// ㉟ 实测为负、折算为正，也不能被折算值掩盖负值异常
{
  const r = judgeTiers(-1, 2, 10, 30, '数据有效', { useZs: true, minRatio: 1, requireValid: true });
  check('㉟ 实测负值/折算正 → 仍判异常', r && r.negative && r.exceeded && !r.exceedLegal, JSON.stringify(r));
}
// ㊱ 无效数据中的负值不告警
{
  const r = judgeTiers(-1, -1, 10, 30, '--', { useZs: true, minRatio: 1, requireValid: true });
  check('㊱ flag=-- 负值 → 不判异常', r && !r.negative && !r.exceeded, JSON.stringify(r));
}
// ㊲ pH 区间数据出现负值 → 异常
{
  const r = judgeRange(-0.1, 7.2, null, '6-9', '数据有效', { requireValid: true });
  check('㊲ pH 区间负值 → 异常', r && r.negative && r.exceeded && r.tier === 'negative' && !r.exceedLegal, JSON.stringify(r));
}
// ㊳ 推送标题：排放超标或负值统一为小时数据异常
{
  const negative = { negative: true, exceedLegal: false };
  const legal = { negative: false, exceedLegal: true };
  const aOnly = { negative: false, exceedLegal: false };
  check('㊳ 负值/排放超标标题为小时数据异常，仅A级保留A级预警',
    describePushTitle([negative]) === '⚠️ 小时数据异常'
    && describePushTitle([legal]) === '⚠️ 小时数据异常'
    && describePushTitle([aOnly]) === '⚠️ A级预警',
    JSON.stringify({ negative: describePushTitle([negative]), legal: describePushTitle([legal]), aOnly: describePushTitle([aOnly]) }));
}
// ㊴ 推送数值格式：负值显示实测/折算，正常废气仍显示折算（实测）
{
  const negative = formatPushValue({ negative: true, range: false, value: -1.234, zs: -1.512, usedZs: true, judged: -1.512 });
  const normal = formatPushValue({ negative: false, range: false, value: 38.01, zs: 32.54, usedZs: true, judged: 32.54 });
  check('㊴ 推送数值格式', negative === '实测 -1.234，折算 -1.512' && normal === '折算 32.54（实测 38.01）', JSON.stringify({ negative, normal }));
}
// ㊵ 无标准值时，主因子负值仍可作为数据异常（标准比较不可用不应吞掉负值）
{
  const scalar = judgeTiers(-1, -1, null, null, '数据有效', { useZs: true, minRatio: 1, requireValid: true });
  const range = judgeRange(-0.1, 7.2, null, null, '数据有效', { requireValid: true });
  check('㊵ 无标准值负值 → 仍判异常',
    scalar && scalar.negative && scalar.exceeded && range && range.negative && range.exceeded,
    JSON.stringify({ scalar, range }));
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} PASS`);
process.exit(failed.length ? 1 : 0);
