// 窗口提取/合并算法单测（2026-10-22 波次3）。
// 锁定三起线上事故对应的算法行为：
//   ① 缺 1 个采样点不断段（10-16 环保尾气 15:29~15:47 被切成 11+7min → 修复后容忍 gap≤2 步长）；
//   ② 跨 label 连续标记整链保留（10-05 3号机组 校准/故障交替）；
//   ③ 规则B：单小时累计覆盖 ≥15min 也保留（10-19 用户要求）。
// 运行：node tools/windows-test.mjs
import { _test } from './scf-marks-sync/index.js';
const { extractWindows, mergeContinuous, keepByHourCoverage } = _test;

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '\n      ' + detail : ''}`);
}

// 构造分钟级行：data_time.label = "YYYY-MM-DD HH:mm"；仅一个 zd_flag_001 字段（label 可变）
function rowsAt(date, times, labels) {
  return times.map((t, i) => ({
    data_time: { item: { label: `${date} ${t}` } },
    zd_flag_001: { item: { label: labels[i] } },
  }));
}
const mins = (from, to) => {
  const out = [];
  let [h, m] = from.split(':').map(Number);
  const [eh, em] = to.split(':').map(Number);
  const end = eh * 60 + em;
  for (let cur = h * 60 + m; cur <= end; cur++) {
    out.push(`${String(Math.floor(cur / 60)).padStart(2, '0')}:${String(cur % 60).padStart(2, '0')}`);
  }
  return out;
};

// ① 连续段提取（15 分钟校准 → 单个窗口 n=15）
{
  const rows = rowsAt('2026-10-16', mins('12:00', '12:14'), mins('12:00', '12:14').map(() => '校准'));
  const ws = extractWindows(rows, 'zd_flag_', 1);
  check('① 连续 15 分钟校准 → 单窗口 n=15', ws.length === 1 && ws[0].n === 15 && ws[0].start.endsWith('12:00'), JSON.stringify(ws[0]));
}

// ② 缺 1 个采样点不断段（10-16 根因）：15:29~15:47，中间 15:40 缺失
{
  const times = [...mins('15:29', '15:39'), ...mins('15:41', '15:47')]; // 缺 15:40
  const rows = rowsAt('2026-10-16', times, times.map(() => '日常维护'));
  const ws = extractWindows(rows, 'zd_flag_', 1);
  // 修复后：gap(15:39→15:41)=2min ≤ 2×步长 → 并成一段，n≈19
  check('② 缺 1 采样点合并为单段（n≥18，不再是 11+7 两段）',
    ws.length === 1 && ws[0].n >= 18,
    JSON.stringify(ws));
}

// ③ 缺 1 采样点后整段过 15min 门槛（mergeContinuous 保留）
{
  const times = [...mins('15:29', '15:39'), ...mins('15:41', '15:47')];
  const rows = rowsAt('2026-10-16', times, times.map(() => '日常维护'));
  const ws = extractWindows(rows, 'zd_flag_', 1);
  const kept = mergeContinuous(ws, 1, 15);
  check('③ 缺采样点段过 15min 门槛被保留', kept.length === 1, `kept=${kept.length}`);
}

// ④ 跨 label 交替的连续标记整链保留（10-05 3号机组）
{
  const win = (label, start, n) => ({ label, code: '001', detail: '', start, end: null, n, rowMinutes: 1 });
  const windows = [
    win('校准', '2026-10-05 14:43', 9),
    win('故障', '2026-10-05 14:52', 2),
    win('校准', '2026-10-05 14:54', 1),
    win('故障', '2026-10-05 14:55', 1),
    win('校准', '2026-10-05 14:56', 95),
  ];
  const kept = mergeContinuous(windows, 1, 15);
  check('④ 跨 label 连续整链保留（5 段全留）', kept.length === 5, `kept=${kept.length}`);
}

// ⑤ 短于 15min 的孤立段被丢弃
{
  const win = (label, start, n) => ({ label, code: '001', detail: '', start, end: null, n, rowMinutes: 1 });
  const kept = mergeContinuous([win('校准', '2026-10-05 14:43', 8)], 1, 15);
  check('⑤ 不足 15min 的孤立段被丢弃', kept.length === 0, `kept=${kept.length}`);
}

// ⑥ 规则B：单小时 3 段各 6 分钟（累计 18min ≥15）→ 保留
{
  const times = [...mins('12:00', '12:05'), ...mins('12:20', '12:25'), ...mins('12:40', '12:45')];
  const rows = rowsAt('2026-10-17', times, times.map(() => '校准'));
  const ws = extractWindows(rows, 'zd_flag_', 1); // 3 个独立窗口，各 6min
  const kept = keepByHourCoverage(ws, 1, 15);
  check('⑥ 规则B：单小时累计 18min 保留（3 段全留）', ws.length === 3 && kept.length === 3, `ws=${ws.length} kept=${kept.length}`);
}

// ⑦ 规则B：不足 15min 的小时段被过滤（5min+6min=11min <15）
{
  const times = [...mins('12:00', '12:04'), ...mins('12:20', '12:25')];
  const rows = rowsAt('2026-10-17', times, times.map(() => '校准'));
  const ws = extractWindows(rows, 'zd_flag_', 1);
  const kept = keepByHourCoverage(ws, 1, 15);
  check('⑦ 规则B：单小时 11min 不足门槛被过滤', kept.length === 0, `kept=${kept.length}`);
}

// ⑧ 规则B：跨小时不合并（12:55~13:10 两段各 16min，但分属两个自然小时各 5+10 → 都不足 15 被滤）
{
  const times = [...mins('12:55', '13:04')]; // 10 分钟，跨 12/13 两小时
  const rows = rowsAt('2026-10-17', times, times.map(() => '校准'));
  const ws = extractWindows(rows, 'zd_flag_', 1); // 单窗口 n=10，跨小时
  const kept = keepByHourCoverage(ws, 1, 15);
  check('⑧ 规则B：跨小时按自然小时分别计覆盖（各 5min → 滤掉）', kept.length === 0, `kept=${kept.length}`);
}

// ⑨ 同分钟多因子只计 1 次覆盖（规则B 去重）
{
  const t = mins('12:00', '12:14'); // 15 分钟
  const rows = t.map((tm) => ({
    data_time: { item: { label: `2026-10-17 ${tm}` } },
    zd_flag_001: { item: { label: '校准' } },
    zd_flag_002: { item: { label: '校准' } }, // 第二因子同分钟，不应翻倍计数
  }));
  const ws = extractWindows(rows, 'zd_flag_', 1); // 两个因子各一个 15min 窗口，但覆盖同一分钟
  const kept = keepByHourCoverage(ws, 1, 15);
  // 覆盖分钟 = 15（去重后），≥15 → 两个窗口都保留
  check('⑨ 规则B：同分钟多因子按分钟去重（覆盖 15min 保留）', kept.length === 2, `ws=${ws.length} kept=${kept.length}`);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} PASS`);
process.exit(failed.length ? 1 : 0);
