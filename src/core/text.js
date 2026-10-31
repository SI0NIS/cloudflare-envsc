// core/text.js —— 推送文案组装（纯函数）
import { effRate, isExcluded, isWastewaterOk } from './judge.js';
import { v2SegsText, toMin, parseRanges, isCheckSeg } from './marks.js';

const pct = (v) => (v == null ? '—' : `${v}%`);
// 人工标记只覆盖「同一因子」的自动段：时段必须完整包含，且自动段的因子需全部出现在人工段里。
// 旧数据可能没有因子名（如「校准-自动监测设备处于校准」），此时退回纯时段覆盖，保持兼容。
const ACTION_WORD = /校准|故障|维护|核查|有效|停运|异常|超标/;

function normFactors(factors) {
  const list = Array.isArray(factors) ? factors : (factors ? String(factors).split('/') : []);
  return [...new Set(list.map((f) => String(f || '').trim()).filter(Boolean))];
}

function factorsCoveredBy(autoFactors, manualFactors) {
  const auto = normFactors(autoFactors);
  const man = normFactors(manualFactors);
  if (!auto.length || !man.length) return true; // 无因子名的旧数据按原时段规则兼容
  const set = new Set(man);
  return auto.every((f) => set.has(f));
}

function textFactors(seg) {
  const first = String(seg || '').trim()
    .replace(/^\d{2,4}-\d{2}(?:-\d{2})?\s+/, '')
    .split(/\s+/)[0] || '';
  if (!first || ACTION_WORD.test(first)) return [];
  return first.split('/').map((f) => f.trim()).filter((f) => f && !ACTION_WORD.test(f));
}

// v1 文本按换行分组，组内后续段沿用组头的因子名（如「颗粒物 校准…；日常维护…」）。
function manualSegsFromText(text) {
  const out = [];
  for (const line of String(text || '').split(/\n/)) {
    let groupFactors = [];
    for (const part of line.split(/[；;]/).map((s) => s.trim()).filter(Boolean)) {
      const own = textFactors(part);
      if (own.length) groupFactors = own;
      for (const [start, end] of parseRanges(part)) out.push({ start, end, factors: groupFactors });
    }
  }
  return out;
}

function rangeCoveredByManualSegs(range, factors, manualSegs) {
  const [a, b] = range;
  if (a == null || b == null) return false;
  return manualSegs.some((m) => a >= m.start && b <= m.end && factorsCoveredBy(factors, m.factors));
}

function buildText(data, j, marks) {
  const compact = data.date.replace(/-/g, '');
  const title = `${compact}有效传输率${pct(j.unitRate)}`;

  // 异常监控点 = 未达标 ∪ 排除(停运) ∪ 有实质标记的点
  // 注意：废水 ≤1h 标样核查被官方豁免（isWastewaterOk），有效率判为达标、不计「未达标」。
  //   标记方面（2026-10-08 细化）：**纯标样核查自动标记不构成推送理由**（≤1h 豁免，不算异常）；
  //   仅当存在①人工标记，或②非标样核查的异常自动段（故障/日常维护等）时才推送；
  //   标样核查段与其他异常时段重叠时随推送一并展示（isCheckSeg 已豁免覆盖抑制）。
  const abnormal = [];
  for (const mp of data.monitorPoints || []) {
    const ex = isExcluded(mp);
    const r = effRate(mp);
    const under = (r != null && r < 100) && !isWastewaterOk(mp); // 废水 ≤1h 标样核查不计异常
    const key0 = String(mp.mpName || '').trim();
    const m0 = marks && marks.byMp && marks.byMp.get(key0);
    // v2 结构化（2026-10-22 波次2）与 v1 文本并存：判定口径完全一致（有人工段/有自动段即 marked）
    const hasManual = m0 && m0.v2
      ? !!((m0.v2.manual && m0.v2.manual.segs && m0.v2.manual.segs.length))
      : !!(m0 && String(m0.manual || '').trim());
    // auto 可能多组多段（\n 分组、；分段）；v2 则为结构化 segs
    const autoSegs = m0 && m0.v2
      ? ((m0.v2.auto && m0.v2.auto.segs) || [])
      : String((m0 && m0.auto) || '').split(/[\n；]/).map((s) => s.trim()).filter(Boolean);
    // 废水豁免点（有效率 ≥95.83，≤1h 标样核查区间）：**自动标记不构成推送理由**——
    //   标样核查/设备维护都发生在豁免期内，属官方豁免范畴（2026-10-08 用户要求）；
    //   仅人工标记（运维主动填报）触发推送。自动标记照样随推送展示。
    //   注：不能按文本匹配"标样核查"判定——公开平台兜底来源写的是"自动监测设备维护 N(1h)"，
    //   与 SCF 分钟级的"标样核查"措辞不同，按点豁免状态判定才可靠。
    // 非废水点 / 废水真异常点：维持原行为——任何标记都构成推送理由。
    const wwExempt = isWastewaterOk(mp);
    const marked = wwExempt ? hasManual : (hasManual || autoSegs.length > 0);
    if (!under && !ex && !marked) continue;
    abnormal.push({ mp, ex, under, marked });
  }
  if (abnormal.length === 0) return { title, body: '' }; // 情况1：全部达标且无停运点

  const total = (data.monitorPoints || []).length;
  const lines = [];
  lines.push(`异常监控点（${abnormal.length} / ${total} 个）：`);

  for (const a of abnormal) {
    const mp = a.mp;
    if (a.ex) {
      lines.push(`· ${mp.mpName}（${a.ex.reason}）`);
    } else if (a.marked && !a.under) {
      // 达标但有标记：
      //   废水 ≤1h 标样核查被官方豁免 → 标注"已豁免"，避免"100% 却异常"的困惑；
      //   其余点（如 2026-10-19 规则B 纳入的"单小时 ≥15min 校准/维护"点）不加豁免标注，避免误导。
      const rt = mp.realtime ? mp.realtime.effeTransRate : null;
      const cp = mp.comple ? mp.comple.effeTransRate : null;
      const wwNote = isWastewaterOk(mp) ? '（≤1h 标样核查，已豁免）' : '';
      lines.push(`· ${mp.mpName}　即时 ${pct(rt)} / 补全 ${pct(cp)}${wwNote}`);
    } else {
      const rt = mp.realtime ? mp.realtime.effeTransRate : null;
      const cp = mp.comple ? mp.comple.effeTransRate : null;
      lines.push(`· ${mp.mpName}　即时 ${pct(rt)} / 补全 ${pct(cp)}`);
    }
    const key = String(mp.mpName || '').trim();
    const m = marks && marks.byMp && marks.byMp.get(key);
    // 人工标记与自动标记是**两个互相独立的渠道**：同时存在且互不覆盖时都推送；人工优先级 > 自动，
    //   但只抑制「同一因子且时段被人工完整覆盖」的自动段；因子不同或部分重叠都保留。
    //   仅当剩余自动（去日期前缀后）与人工完全相同才并成一行。
    if (m && m.v2) {
      // ===== v2 结构化路径（2026-10-22 波次2） =====
      const norm = (s) => String(s || '').replace(/\d{2}-\d{2}\s+/g, '').replace(/\s*\n\s*/g, '\n').trim();
      const manSegs = (m.v2.manual && m.v2.manual.segs) || [];
      const manRanges = manSegs.map((s) => ({
        start: toMin(s.start), end: toMin(s.end), factors: s.factors || [],
      })).filter((s) => s.start != null && s.end != null);
      const man = manSegs.length ? norm(v2SegsText(manSegs, !!(m.v2.manual && m.v2.manual.noGroup))) : '';
      const autoAll = (m.v2.auto && m.v2.auto.segs) || [];
      const keptSegs = autoAll.filter((s) => {
        if (isCheckSeg(s.head)) return true;
        const a = toMin(s.start), b = toMin(s.end);
        if (a == null || b == null) return true;
        return !rangeCoveredByManualSegs([a, b], s.factors, manRanges);
      });
      const keptText = keptSegs.length ? norm(v2SegsText(keptSegs, false)) : '';
      if (man) {
        if (man.includes('\n')) lines.push(`人工标记：\n${man}`);
        else lines.push(`人工标记：${man}`);
      }
      if (keptText && norm(keptText.replace(/\n/g, '；')) !== man) {
        if (keptText.includes('\n')) lines.push(`自动标记：\n${keptText}`);
        else lines.push(`自动标记：${keptText}`);
      }
    } else if (m) {
      const norm = (s) => String(s || '').replace(/\d{2}-\d{2}\s+/g, '').replace(/\s*\n\s*/g, '\n').trim();
      const man = norm(m.manual);
      const manRanges = manualSegsFromText(m.manual);
      const rawAuto = String(m.auto || '');
      const groups = rawAuto.split('\n').map((g) => g.trim()).filter(Boolean);
      const keptGroups = [];
      for (const grp of groups) {
        const segs = grp.split('；').map((s) => s.trim()).filter(Boolean);
        const kept = [];
        let groupFactors = []; // 组内后续段沿用组头因子名（v1 文案的省略写法）
        for (const seg of segs) {
          const own = textFactors(seg);
          if (own.length) groupFactors = own;
          if (isCheckSeg(seg)) { kept.push(seg); continue; }
          const rngs = parseRanges(seg);
          if (rngs.length === 0) { kept.push(seg); continue; }
          if (!rngs.every((r) => rangeCoveredByManualSegs(r, groupFactors, manRanges))) kept.push(seg);
        }
        if (kept.length) keptGroups.push(kept.join('；'));
      }
      if (man) {
        if (man.includes('\n')) lines.push(`人工标记：\n${man}`);
        else lines.push(`人工标记：${man}`);
      }
      if (keptGroups.length) {
        const keptText = norm(keptGroups.join('\n'));
        if (keptText && norm(keptText.replace(/\n/g, '；')) !== man) {
          if (keptText.includes('\n')) lines.push(`自动标记：\n${keptText}`);
          else lines.push(`自动标记：${keptText}`);
        }
      }
    }
    // 若该点既无人工也无自动设备标记，则不显示任何设备标记行：
    // 其工况标记（如停运）已由上方的 excluded 行体现，无需补"无记录"行。
  }

  let body = lines.join('\n');
  if (marks && marks.error) body += `\n（人工标记暂无法获取：${marks.error}）`;
  return { title, body };
}

export { pct, buildText };
