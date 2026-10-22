// core/marks.js —— 标记文本/区间纯函数（无副作用，可单测）
// 含：marks v2 结构化段→展示文本、HH:MM 区间解析与覆盖判定、标样核查豁免判定。

// ---------- marks v2：结构化段 → 展示文本（与 v1 segsText/qyText 输出逐字节一致） ----------
// 段：{ factors:[], head, start:"HH:mm", end:"HH:mm", minutes:N }
// 时长格式与同步端 fmtDur 一致：整小时显示 "Nh"，否则 "Nmin"。
const fmtDurV2 = (n) => (n % 60 === 0 && n >= 60) ? `${n / 60}h` : `${n}min`;
const segBodyV2 = (s) => `${s.head} ${s.start}~${s.end}(${fmtDurV2(s.minutes)})`;

function v2SegsText(segs, noGroup) {
  if (!segs || !segs.length) return '';
  if (noGroup) {
    // rg 兜底路径：v1 为 windowText 平铺（每段自带因子名、；连接）
    return segs.map((s) => `${s.factors && s.factors.length ? s.factors.join('/') + ' ' : ''}${segBodyV2(s)}`).join('；');
  }
  // 连续同因子段并组（镜像 segsText/qyText）：组头 = 因子组合，组内段以 ；连接，组间以 ；\n 连接
  const groups = [];
  let cur = null;
  for (const s of segs) {
    const f = (s.factors && s.factors.length) ? s.factors.join('/') : '';
    const body = segBodyV2(s);
    if (f && cur && f === cur.factor) { cur.parts.push(body); continue; }
    if (f) { cur = { factor: f, parts: [body] }; groups.push(cur); }
    else { groups.push({ factor: '', parts: [body] }); cur = null; }
  }
  return groups.map((g) => (g.factor ? `${g.factor} ${g.parts.join('；')}` : g.parts.join('；'))).join('；\n');
}

// ---------- 设备标记：人工/自动时段覆盖判定 ----------
// 把字符串里所有 `HH:MM~HH:MM` 区间解析为 [起,止]（分钟数），支持中英文波浪号/半全角
function toMin(hhmm) {
  const p = String(hhmm).split(':');
  const h = Number(p[0]), mi = Number(p[1]);
  if (!Number.isFinite(h) || !Number.isFinite(mi)) return null;
  return h * 60 + mi;
}

function parseRanges(s) {
  const out = [];
  const re = /(\d{1,2}:\d{2})\s*[~～]\s*(\d{1,2}:\d{2})/g;
  let m;
  while ((m = re.exec(String(s || ''))) !== null) {
    const a = toMin(m[1]), b = toMin(m[2]);
    if (a != null && b != null) out.push([a, b]);
  }
  return out;
}

// 某 auto 区间是否被任一 manual 区间完全覆盖（人工优先级 > 自动）
function rangeCoveredByAny(auto, manualRanges) {
  const [as, ae] = auto;
  return manualRanges.some(([ms, me]) => as >= ms && ae <= me);
}

// 「标样核查」是独立的**核查记录**（人工比对样品的校准核查），不是设备故障/维护，
//   即便时段与人工标记的「校准」重合也要保留 —— 两者是不同性质的事实，抑制掉会丢核查记录。
//   2026-10-07 用户要求：废水标样核查为自动标记，可能与人工标记校准时段重合，此时两者都要推送。
//   2026-10-08 又要求：标样核查≤1h 不构成推送理由 → 提升为模块级，供异常点判定共用。
const isCheckSeg = (seg) => /标样核查|样品核查|比对核查/.test(seg);

export { fmtDurV2, segBodyV2, v2SegsText, toMin, parseRanges, rangeCoveredByAny, isCheckSeg };
