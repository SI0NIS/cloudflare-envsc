// core/text.js —— 推送文案组装（纯函数）
import { effRate, isExcluded, isWastewaterOk } from './judge.js';
import { v2SegsText, toMin, parseRanges, rangeCoveredByAny, isCheckSeg } from './marks.js';

const pct = (v) => (v == null ? '—' : `${v}%`);

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
    //   某段自动被人工完全覆盖时抑制该段；仅当剩余自动（去日期前缀后）与人工完全相同才并成一行。
    if (m && m.v2) {
      // ===== v2 结构化路径（2026-10-22 波次2） =====
      const norm = (s) => String(s || '').replace(/\d{2}-\d{2}\s+/g, '').replace(/\s*\n\s*/g, '\n').trim();
      const manSegs = (m.v2.manual && m.v2.manual.segs) || [];
      const manRanges = manSegs.map((s) => [toMin(s.start), toMin(s.end)]).filter((r) => r[0] != null && r[1] != null);
      const man = manSegs.length ? norm(v2SegsText(manSegs, !!(m.v2.manual && m.v2.manual.noGroup))) : '';
      const autoAll = (m.v2.auto && m.v2.auto.segs) || [];
      const keptSegs = autoAll.filter((s) => {
        if (isCheckSeg(s.head)) return true;
        const a = toMin(s.start), b = toMin(s.end);
        if (a == null || b == null) return true;
        return !rangeCoveredByAny([a, b], manRanges);
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
      const manRanges = parseRanges(m.manual);
      const rawAuto = String(m.auto || '');
      const groups = rawAuto.split('\n').map((g) => g.trim()).filter(Boolean);
      const keptGroups = [];
      for (const grp of groups) {
        const segs = grp.split('；').map((s) => s.trim()).filter(Boolean);
        const kept = segs.filter((seg) => {
          if (isCheckSeg(seg)) return true;
          const rngs = parseRanges(seg);
          if (rngs.length === 0) return true;
          return !rngs.every((r) => rangeCoveredByAny(r, manRanges));
        });
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
