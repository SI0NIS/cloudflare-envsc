// mergeContinuous 单元测试（2026-10-06 新规则）
// 规则：连续标记（跨 label 不留缝）总时长 ≥15min 的整条链都保留，链内子段按时间分别列出。
// 运行：node tools/merge-test.mjs
import { _test } from './scf-marks-sync/index.js';
const { mergeContinuous, mergeSameLabelSegs, extractWindows, windowText, FACTOR_NAMES, MP_FACTOR_NAMES, PARAM_CODE, qyText, factorNameOf, factorMapOf } = _test;

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '\n      ' + detail : ''}`);
}
const W = (label, startHM, n) => ({ label, start: `2026-10-05 ${startHM}:00`, n, rowMinutes: 1 });
const fmt = (ws) => ws.map((w) => `${w.label} ${w.start.slice(11, 16)}(${w.n}m)`).join(' | ');

// ① 真实场景 10-05 3号机组：14:43~16:30 连续标记，label 交替
{
  const inWs = [
    W('校准', '14:43', 9),   // 14:43~14:51
    W('故障', '14:52', 2),   // 14:52~14:53
    W('校准', '14:54', 1),   // 14:54
    W('故障', '14:55', 1),   // 14:55
    W('校准', '14:56', 95),  // 14:56~16:30
  ];
  const out = mergeContinuous(inWs, 1, 15);
  check('① 连续期内所有 label 子段都保留（不再被 >15min 逐段过滤掉）', out.length === 5, `实际 ${out.length} 段: ${fmt(out)}`);
  check('①b 子段按时间排序', out[0].start.endsWith('14:43:00') && out[4].start.endsWith('14:56:00'));
  check('①c 交替的故障短段也在', out.some((w) => w.label === '故障' && w.n === 2) && out.some((w) => w.label === '故障' && w.n === 1));
}

// ② 整条链都不足 15min → 整条丢弃
{
  const inWs = [W('校准', '10:00', 7), W('故障', '10:07', 3)]; // 10:00~10:09 共 10min
  const out = mergeContinuous(inWs, 1, 15);
  check('② 连续总时长 <15min → 整链丢弃', out.length === 0, `实际保留 ${out.length} 段`);
}

// ③ 恰好 15min → 保留（>=15）
{
  const inWs = [W('校准', '10:00', 15)]; // 15min
  const out = mergeContinuous(inWs, 1, 15);
  check('③ 恰好 15min → 保留', out.length === 1);
}

// ④ 分离的两条链：各自独立判定
{
  const inWs = [
    W('校准', '09:00', 20),  // 09:00~09:19 合格
    W('校准', '20:00', 3),   // 20:00~20:02 不合格
  ];
  const out = mergeContinuous(inWs, 1, 15);
  check('④ 分离链独立判定（只保留长的那条）', out.length === 1 && out[0].start.endsWith('09:00:00'), `实际: ${fmt(out)}`);
}

// ⑤ 相邻不留缝（end 正好等于下一个 start）算连续
{
  const inWs = [W('校准', '08:00', 10), W('故障', '08:10', 6)]; // 08:00~08:15 共 16min
  const out = mergeContinuous(inWs, 1, 15);
  check('⑤ 首尾相接（不留缝）视为连续，整链保留', out.length === 2, `实际 ${out.length} 段: ${fmt(out)}`);
}

// ⑥ 中间空 1 分钟 → 断开：长链保留，短链独立判定后丢弃
{
  const inWs = [
    W('校准', '08:00', 20),  // 08:00~08:19 (20min，合格)
    W('故障', '08:21', 3),   // 08:21~08:23（08:20 空 1 分钟 → 断开，仅 3min → 丢弃）
  ];
  const out = mergeContinuous(inWs, 1, 15);
  check('⑥ 中间空 1 分钟 → 断开，短链丢弃', out.length === 1 && out[0].label === '校准', `实际: ${fmt(out)}`);
}

// ⑥c 恰好不留缝（短段紧接长段）→ 同一条链，短段一起保留
{
  const inWs = [
    W('校准', '08:00', 20),  // 08:00~08:19
    W('故障', '08:20', 3),   // 08:20~08:22，紧接 → 同链
  ];
  const out = mergeContinuous(inWs, 1, 15);
  check('⑥c 紧接不留缝 → 同链保留（短段不被单独判 <15min）', out.length === 2, `实际: ${fmt(out)}`);
}

// ⑦ 空输入
check('⑦ 空输入返回空', mergeContinuous([], 1, 15).length === 0);

// ⑧ 监测因子维度（2026-10-06 新规则）
// 预置真实映射（公开平台实测：001 颗粒物 / 002 二氧化硫 / 003 氮氧化物）
FACTOR_NAMES.set('001', '颗粒物');
FACTOR_NAMES.set('002', '二氧化硫');
FACTOR_NAMES.set('003', '氮氧化物');
{
  // 同 label 同时段但不同因子 → 分成两条
  const rows = [
    { data_time: { item: { label: '2026-10-05 14:45' } },
      zd_flag_002: { item: { label: '校准', detail: { z: '校准' } } },
      zd_flag_003: { item: { label: '校准', detail: { z: '校准' } } } },
  ];
  const ws = extractWindows(rows, 'zd_flag_', 1);
  check('⑧ 同label不同因子 → 分成两条窗口', ws.length === 2, `实际 ${ws.length} 条`);
  check('⑧b 窗口带上因子编号', ws.every((w) => w.code === '002' || w.code === '003'), ws.map((w) => w.code).join(','));
}
{
  // 合并同 label+时段的两个因子 → 一条，因子名用 '/' 连接
  const inWs = [
    { label: '校准', detail: '校准', code: '002', start: '2026-10-05 14:43:00', n: 9, rowMinutes: 1 },
    { label: '校准', detail: '校准', code: '003', start: '2026-10-05 14:43:00', n: 9, rowMinutes: 1 },
  ];
  const merged = mergeSameLabelSegs(inWs);
  check('⑧c 同label+时段的两因子合并为一条', merged.length === 1, `实际 ${merged.length} 条`);
  check('⑧d 合并后因子名正确', windowText(merged[0]) === '二氧化硫/氮氧化物 校准 14:43~14:51(9min)', windowText(merged[0]));
}
{
  // 单因子 → 仍带因子名
  const one = [{ label: '校准', detail: '校准', code: '002', start: '2026-10-05 09:00:00', n: 20, rowMinutes: 1 }];
  check('⑧e 单因子也带因子名', windowText(mergeSameLabelSegs(one)[0]) === '二氧化硫 校准 09:00~09:19(20min)', windowText(mergeSameLabelSegs(one)[0]));
}
{
  // 工况参数（S0x/B0x）不展示因子名
  check('⑧f 工况参数码不当作污染物因子', PARAM_CODE.test('S01') && PARAM_CODE.test('B02') && !PARAM_CODE.test('002'));
}
{
  // 未合并时保持旧格式（不带因子名前缀污染）
  const plain = { label: '故障', detail: '故障', code: '', start: '2026-10-05 14:52:00', n: 2, rowMinutes: 1 };
  check('⑧g 无因子名时沿用旧格式', windowText(plain) === '故障 14:52~14:53(2min)', windowText(plain));
}

// ⑨ 工况参数全部展示（2026-10-07 用户要求：流量/流速/温度/湿度/压力等被标记都要推送）
{
  // 各工况参数在公开平台都有正式名称
  FACTOR_NAMES.set('S01', '氧含量');
  FACTOR_NAMES.set('S02', '烟气流速');
  FACTOR_NAMES.set('S03', '烟气温度');
  FACTOR_NAMES.set('S05', '烟气湿度');
  FACTOR_NAMES.set('S08', '烟气压力');
  FACTOR_NAMES.set('B02', '流量');
  FACTOR_NAMES.set('508', '非甲烷总烃');
  for (const [c, n] of [['S01', '氧含量'], ['S02', '烟气流速'], ['S03', '烟气温度'], ['S05', '烟气湿度'], ['S08', '烟气压力'], ['B02', '流量']]) {
    check(`⑨a 工况参数 ${c} 能取名「${n}」`, factorNameOf({ code: c }) === n, factorNameOf({ code: c }));
  }
  // 同一时刻多个工况参数 + 污染物被同样标记 → 全部合并显示
  const segs = [
    { label: '校准', detail: '校准', code: '508', start: '2026-10-07 10:00:00', n: 20, rowMinutes: 1 },
    { label: '校准', detail: '校准', code: 'S01', start: '2026-10-07 10:00:00', n: 20, rowMinutes: 1 },
    { label: '校准', detail: '校准', code: 'S03', start: '2026-10-07 10:00:00', n: 20, rowMinutes: 1 },
  ];
  const m = mergeSameLabelSegs(segs);
  check('⑨b 工况参数与污染物一起合并显示',
    windowText(m[0]) === '氧含量/烟气温度/非甲烷总烃 校准 10:00~10:19(20min)', windowText(m[0]));
  // 废水 B01 平台无名称 → 不展示，也不影响其他因子
  check('⑨c 平台无名的参数不硬造名字', factorNameOf({ code: 'B01' }) === '');
}
// ⑩ 同 code 在不同监测点含义不同 → 名称必须按点隔离，不能串（2026-10-07 实测 011）
{
  MP_FACTOR_NAMES.clear();
  MP_FACTOR_NAMES.set('mp-3hao', new Map([['011', '氮氧化物'], ['003', '氮氧化物']]));
  MP_FACTOR_NAMES.set('mp-zongpaikou', new Map([['011', '氯气'], ['060', '氨氮']]));
  check('⑩a 机组侧 011 → 氮氧化物', factorNameOf({ code: '011' }, 'mp-3hao') === '氮氧化物', factorNameOf({ code: '011' }, 'mp-3hao'));
  check('⑩b 总排口侧 011 → 氯气（不串名）', factorNameOf({ code: '011' }, 'mp-zongpaikou') === '氯气', factorNameOf({ code: '011' }, 'mp-zongpaikou'));
  check('⑩c 未登记的点回退到全局表', factorMapOf('mp-不存在') === FACTOR_NAMES);
}

const failed = results.filter((x) => !x.pass).length;
console.log(`\n${results.length - failed}/${results.length} PASS`);
process.exit(failed ? 1 : 0);
