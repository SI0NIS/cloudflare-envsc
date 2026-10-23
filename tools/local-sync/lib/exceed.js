// lib/exceed.js —— 小时超标判定（纯函数，无网络/IO，可单测）
//
// 数据来源（企业端 online-monitor/data/list，dateType=1 小时行）：
//   每个因子 code 对应一组字段：avg_value_<code> 实测值、outlet_standard_<code> 标准值、
//   flag_<code> 数据有效性（数据有效/--）。实测字段无“折算值”字段（已实测确认）。
//
// 判定口径（config/project.json → hourlyAlarm）：
//   compare = 'avg_value'    → 实测 vs 标准（默认，O2 低于基准时偏保守，宁可多报）
//           = 'o2_corrected' → 折算 vs 标准（需 baseO2 + o2Code）
//           = 'max'          → max(实测, 折算) vs 标准（需 baseO2 + o2Code）
//   minRatio：判定阈值倍数（1.0 = 严格大于标准）
//   requireValid：仅当 flag 为“数据有效”才判（默认 true）

const cell = (row, k) => (row && row[k] && row[k].item) ? row[k].item : null;

function num(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s === '--' || s === '/') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const rowLabel = (row) => {
  const c = cell(row, 'data_time');
  return c ? String(c.label || '') : '';
};

// 折算浓度：C折 = C实 × (21 - 基准氧) / (21 - 实测氧)
function o2Correct(value, o2, baseO2) {
  if (value == null || o2 == null || baseO2 == null) return null;
  if (!(o2 >= 0 && o2 < 21) || !(baseO2 >= 0 && baseO2 < 21)) return null;
  return value * (21 - baseO2) / (21 - o2);
}

// 评估单行单因子；返回 null 表示该因子无有效数值/标准值
function evalFactor(row, code, opt = {}) {
  const value = num((cell(row, `avg_value_${code}`) || {}).label);
  const standard = num((cell(row, `outlet_standard_${code}`) || {}).label);
  if (value == null || standard == null || standard <= 0) return null;

  const flag = (cell(row, `flag_${code}`) || {}).label || '';
  const valid = opt.requireValid === false ? true : flag === '数据有效';

  const compare = opt.compare || 'avg_value';
  let corrected = null;
  let judged = value;
  if (compare !== 'avg_value' && opt.o2Code && opt.baseO2 != null) {
    const o2 = num((cell(row, `avg_value_${opt.o2Code}`) || {}).label);
    corrected = o2Correct(value, o2, opt.baseO2);
    if (corrected != null) judged = compare === 'max' ? Math.max(value, corrected) : corrected;
  }

  const minRatio = Number.isFinite(opt.minRatio) ? opt.minRatio : 1;
  const ratio = judged / standard;
  return {
    code,
    value,
    corrected,
    judged,
    standard,
    ratio,
    flag,
    valid,
    exceeded: valid && ratio > minRatio,
  };
}

// 单点判定（推荐入口）：直接给实测值/折算值/标准值/有效性。
// 口径（2026-10-23 用户确认）：**废气用折算值**（平台有折算），**废水没有折算、用实测值**。
//   useZs=true 且 zs 有值 → 用折算；否则退回实测。
function judgePoint(value, zs, standard, flag, opt = {}) {
  const v = num(value), z = num(zs), s = num(standard);
  if (v == null || s == null || s <= 0) return null;
  const valid = opt.requireValid === false ? true : flag === '数据有效';
  const useZs = opt.useZs === true && z != null;
  const judged = useZs ? z : v;
  const minRatio = Number.isFinite(opt.minRatio) ? opt.minRatio : 1;
  const ratio = judged / s;
  return {
    value: v,
    zs: z,
    judged,
    usedZs: useZs,
    standard: s,
    ratio,
    flag: flag || '',
    valid,
    exceeded: valid && ratio > minRatio,
  };
}

// 对一行（一小时）评估多个因子；返回超标项数组
function evalRow(row, codes, opt = {}) {
  const out = [];
  for (const code of codes) {
    const r = evalFactor(row, code, opt);
    if (r && r.exceeded) out.push({ ...r, time: rowLabel(row) });
  }
  return out;
}

module.exports = { evalFactor, evalRow, judgePoint, o2Correct, num, rowLabel, cell };
