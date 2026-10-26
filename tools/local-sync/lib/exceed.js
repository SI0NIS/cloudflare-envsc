// lib/exceed.js —— 小时数据异常/超标判定（纯函数，无网络/IO，可单测）
//
// 数据来源（企业端 online-monitor/data/list，dateType=1 小时行）：
//   每个因子 code 对应一组字段：avg_value_<code> 实测值、outlet_standard_<code> 标准值、
//   flag_<code> 数据有效性（数据有效/--）。因子编码由 /monitoritem/pollutant/list 提供
//   （2026-10-23 实测：非甲烷总烃=508、颗粒物=001、二氧化硫=002、氮氧化物=003、
//    化学需氧量=011、氨氮=060）。
//
// 判定口径（config/project.json → hourlyAlarm）：
//   废气：用折算值（view/list 的 avg_zs，缺失时退回实测）；废水：用实测值（平台无折算）。
//   minRatio：判定阈值倍数（1.0 = 严格大于标准）
//   requireValid：仅当 flag 为“数据有效”才判（默认 true）
//   异常负值：flag=数据有效时，主监测因子的小时值 < 0 也判异常（tier=negative）
//   两层标准：A 级绩效（更严）+ 排放标准（平台），见 judgeTiers/describeTier。

const cell = (row, k) => (row && row[k] && row[k].item) ? row[k].item : null;

function num(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s === '--' || s === '/') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function firstNegative(...values) {
  for (const value of values) {
    if (value != null && value < 0) return value;
  }
  return null;
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
  const negative = valid && (value < 0 || (corrected != null && corrected < 0));
  return {
    code,
    value,
    corrected,
    judged,
    standard,
    ratio,
    flag,
    valid,
    negative,
    tier: negative ? 'negative' : null,
    exceeded: valid && (negative || ratio > minRatio),
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
  const negative = valid && (v < 0 || (z != null && z < 0));
  return {
    value: v,
    zs: z,
    judged,
    usedZs: useZs,
    standard: s,
    ratio,
    flag: flag || '',
    valid,
    negative,
    tier: negative ? 'negative' : null,
    exceeded: valid && (negative || ratio > minRatio),
  };
}

// 解析标准值：单值（"50"）或区间（pH "6-9"）
function parseStandard(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s === '--' || s === '/') return null;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*[-~～至]\s*(\d+(?:\.\d+)?)$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (Number.isFinite(a) && Number.isFinite(b) && b >= a) return { min: a, max: b, range: true, text: s };
  }
  const n = Number(s);
  return Number.isFinite(n) ? { min: n, max: n, range: false, text: s } : null;
}

// 双层标准判定（2026-10-23）：A级绩效标准 + 排放标准
//   stdA     = 重污染天气绩效分级 A 级限值（更严，缺失则 null）
//   stdLegal = 排放标准（平台 outlet_standard 或配置表）
//   返回 exceedA / exceedLegal / negative / tier('legal'|'a'|'negative'|null)，供推送说明。
function judgeTiers(value, zs, stdA, stdLegal, flag, opt = {}) {
  const v = num(value), z = num(zs);
  const pa = parseStandard(stdA), pl = parseStandard(stdLegal);
  const valid = opt.requireValid === false ? true : flag === '数据有效';
  const negativeValue = valid ? firstNegative(v, z) : null;
  const negative = negativeValue != null;
  if (v == null || (!negative && !pa && !pl)) return null;
  const useZs = opt.useZs === true && z != null;
  const judged = useZs ? z : v;
  const minRatio = Number.isFinite(opt.minRatio) ? opt.minRatio : 1;

  const evalOne = (p) => {
    if (!p) return { ratio: null, exceeded: false };
    if (p.range) {
      if (judged < p.min) return { ratio: p.min / judged, exceeded: true };
      if (judged > p.max) return { ratio: judged / p.max, exceeded: true };
      return { ratio: 1, exceeded: false };
    }
    const ratio = judged / p.min;
    return { ratio, exceeded: ratio > minRatio };
  };
  const ea = evalOne(pa), el = evalOne(pl);
  const exceedA = !negative && valid && ea.exceeded;
  const exceedLegal = !negative && valid && el.exceeded;
  const tier = negative ? 'negative' : (exceedLegal ? 'legal' : (exceedA ? 'a' : null));
  return {
    value: v,
    zs: z,
    judged,
    usedZs: useZs,
    valid,
    negative,
    negativeValue,
    stdA: pa ? (pa.range ? pa.text : pa.min) : null,
    stdLegal: pl ? (pl.range ? pl.text : pl.min) : null,
    ratioA: negative ? null : ea.ratio,
    ratioLegal: negative ? null : el.ratio,
    exceedA,
    exceedLegal,
    tier,
    exceeded: !!(negative || exceedA || exceedLegal),
    flag: flag || '',
  };
}

// 区间型因子（pH）：用最小值/最大值与区间标准比较
function judgeRange(minV, maxV, stdA, stdLegal, flag, opt = {}) {
  const a = num(minV), b = num(maxV);
  const pa = parseStandard(stdA), pl = parseStandard(stdLegal);
  const valid = opt.requireValid === false ? true : flag === '数据有效';
  const negativeValue = valid ? firstNegative(a, b) : null;
  const negative = negativeValue != null;
  if (a == null || b == null || (!negative && !pa && !pl)) return null;
  const evalOne = (p) => {
    if (!p) return { ratio: null, exceeded: false, bound: null };
    if (p.range) {
      if (a < p.min) return { ratio: p.min / a, exceeded: true, bound: 'low' };
      if (b > p.max) return { ratio: b / p.max, exceeded: true, bound: 'high' };
      return { ratio: 1, exceeded: false, bound: null };
    }
    if (b > p.min) return { ratio: b / p.min, exceeded: true, bound: 'high' };
    return { ratio: 1, exceeded: false, bound: null };
  };
  const ea = evalOne(pa), el = evalOne(pl);
  const exceedA = !negative && valid && ea.exceeded;
  const exceedLegal = !negative && valid && el.exceeded;
  const tier = negative ? 'negative' : (exceedLegal ? 'legal' : (exceedA ? 'a' : null));
  const low = el.bound === 'low' || ea.bound === 'low';
  return {
    value: b,
    valueMin: a,
    valueMax: b,
    range: true,
    judged: low ? a : b,
    usedZs: false,
    valid,
    negative,
    negativeValue,
    stdA: pa ? (pa.range ? pa.text : pa.min) : null,
    stdLegal: pl ? (pl.range ? pl.text : pl.min) : null,
    ratioA: negative ? null : ea.ratio,
    ratioLegal: negative ? null : el.ratio,
    exceedA,
    exceedLegal,
    tier,
    exceeded: !!(negative || exceedA || exceedLegal),
    flag: flag || '',
  };
}

// 生成「超出哪个标准」的说明（供推送文案）
//   两层均超 → 先写排放标准（法定超标），并注明 A 级亦超；
//   仅超 A 级 → 写明「未超排放标准」，避免误读为法定超标。
function describeTier(it) {
  if (it.negative) return '数据有效，异常负值';
  if (it.range) {
    if (it.exceedLegal) return `超排放标准 ${it.stdLegal}`;
    return `超A级标准 ${it.stdA}`;
  }
  const pA = it.ratioA != null ? Math.round((it.ratioA - 1) * 100) : null;
  const pL = it.ratioLegal != null ? Math.round((it.ratioLegal - 1) * 100) : null;
  if (it.exceedLegal) {
    let s = `超排放标准 ${it.stdLegal}，超 ${pL}%`;
    if (it.stdA != null) s += `；A级标准 ${it.stdA} 亦超`;
    return s;
  }
  let s = `超A级标准 ${it.stdA}，超 ${pA}%`;
  s += it.stdLegal != null ? `；未超排放标准 ${it.stdLegal}` : '；平台未配置排放标准';
  return s;
}

function formatPushValue(it) {
  if (it.range) return `${it.valueMin}~${it.valueMax}`;
  if (it.negative) {
    const raw = Number(it.value.toFixed(3));
    if (it.zs == null) return `${raw}`;
    return `实测 ${raw}，折算 ${Number(it.zs.toFixed(3))}`;
  }
  const val = Number(it.judged.toFixed(3));
  const head = it.usedZs ? '折算 ' : '';
  const extra = it.usedZs ? `（实测 ${Number(it.value.toFixed(3))}）` : '';
  return `${head}${val}${extra}`;
}

function describePushTitle(items) {
  const hasDataAnomaly = (items || []).some((it) => it && (it.negative || it.exceedLegal));
  return hasDataAnomaly ? '⚠️ 小时数据异常' : '⚠️ A级预警';
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

module.exports = {
  evalFactor, evalRow, judgePoint, judgeTiers, judgeRange,
  describeTier, formatPushValue, describePushTitle, parseStandard, o2Correct, num, rowLabel, cell,
};
