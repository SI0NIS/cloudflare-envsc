// buildText 回归测试：人工/自动标记推送规则（2026-09-30 定稿）。
// 规则：
//   · 人工与自动是两条独立渠道，互不覆盖时**都推送**（9-28 3号机组：人工 21:00 与自动三段不重叠 → 全显示）；
//   · 但人工优先级 > 自动：当某段「自动标记时段」被「人工标记时段」完全覆盖时，
//     该段自动标记被抑制，仅推送人工（9-29 生产工艺/环保尾气：自动段落在人工时段内 → 只推人工）。
// 运行：node tools/buildtext-test.mjs
import { buildText } from '../src/index.js';

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '\n      ' + detail : ''}`);
}

const data = {
  date: '2026-09-28',
  monitorPoints: [
    { mpName: '3号机组', realtime: { effeTransRate: 93.51 }, comple: { effeTransRate: 93.51 } },
    { mpName: '1号2号机组', realtime: { effeTransRate: 97.68 }, comple: { effeTransRate: 97.68 } },
    { mpName: '总排口', realtime: { effeTransRate: 100 }, comple: { effeTransRate: 100 } },
  ],
};
const marks = {
  attempted: true,
  total: 1,
  byMp: new Map([
    ['3号机组', {
      manual: '校准-自动监测设备处于校验 21:00~21:23(24min)',
      auto: '校准 14:05~14:33(29min)；校准 14:41~17:28(168min)；校准 19:08~20:50(103min)',
    }],
    ['1号2号机组', { manual: null, auto: '校准 12:08~12:59(52min)' }],
  ]),
  error: null,
};

const { title, body } = buildText(data, { unitRate: 97.66 }, marks);
console.log('--- 生成的正文 ---');
console.log(title);
console.log(body);
console.log('------------------\n');

// 3号机组区块
const seg3 = body.split('· 1号2号机组')[0];
check('① 双标记点：人工标记在', seg3.includes('人工标记：校准-自动监测设备处于校验 21:00~21:23(24min)'));
check('② 双标记点：自动标记也在（不再被人工顶掉）', seg3.includes('自动标记：校准 14:05~14:33(29min)'));
check('③ 自动标记的多段全部保留', seg3.includes('14:41~17:28(168min)') && seg3.includes('19:08~20:50(103min)'));

// 1号2号机组区块（只有自动）
const seg12 = body.split('· 1号2号机组')[1] || '';
check('④ 仅自动标记的点：只显示自动标记', seg12.includes('自动标记：校准 12:08~12:59(52min)') && !seg12.includes('人工标记'));

// 无标记点
check('⑤ 无标记的点（总排口）不进异常列表', !body.includes('总排口'));

// 完全相同的两条只显示一行
{
  const m2 = { byMp: new Map([['3号机组', { manual: '校准 14:05~14:33(29min)', auto: '校准 14:05~14:33(29min)' }]]) };
  const b2 = buildText(data, { unitRate: 97.66 }, m2).body;
  const cnt = (b2.match(/标记：校准 14:05~14:33\(29min\)/g) || []).length;
  check('⑥ 人工与自动完全相同时只显示一行（不重复刷屏）', cnt === 1, `出现 ${cnt} 次`);
}

// ⑦ 覆盖抑制：自动时段被人工时段完全覆盖 → 仅推人工，不推自动（9-29 真实情形）
{
  const d = { date: '2026-09-29', monitorPoints: [
    { mpName: '生产工艺尾气排放口', realtime: { effeTransRate: 95 }, comple: { effeTransRate: 95 } },
    { mpName: '环保尾气排放口', realtime: { effeTransRate: 96 }, comple: { effeTransRate: 96 } },
  ] };
  const m = { byMp: new Map([
    ['生产工艺尾气排放口', { manual: '校准-自动监测设备处于校准 13:51~14:16(26min)', auto: '校准 13:52~14:11(20min)' }],
    ['环保尾气排放口', { manual: '校准-自动监测设备处于校准 13:03~13:31(29min)', auto: '校准 13:04~13:26(23min)' }],
  ] ) };
  const b = buildText(d, { unitRate: 97 }, m).body;
  const segS = b.split('· 环保尾气排放口')[0];
  const segH = b.split('· 环保尾气排放口')[1] || '';
  check('⑦ 自动段落在人工时段内 → 仅推人工', segS.includes('人工标记：校准-自动监测设备处于校准 13:51~14:16(26min)'));
  check('⑦b 被覆盖的自动标记段被抑制（不出现 13:52~14:11）', !segS.includes('13:52~14:11') && !segS.includes('自动标记'));
  check('⑦c 另一点同样覆盖抑制', segH.includes('人工标记：校准-自动监测设备处于校准 13:03~13:31(29min)') && !segH.includes('13:04~13:26'));
}

// ⑧ 部分重叠 / 不覆盖：自动段超出人工范围 → 仍推送自动（不被误删）
{
  const d = { date: '2026-09-29', monitorPoints: [
    { mpName: '某点', realtime: { effeTransRate: 95 }, comple: { effeTransRate: 95 } },
  ] };
  // 人工 13:00~13:30，自动 13:20~14:00（部分超出）→ 自动应保留
  const m = { byMp: new Map([['某点', { manual: '校准 13:00~13:30(30min)', auto: '校准 13:20~14:00(40min)' }]]) };
  const b = buildText(d, { unitRate: 97 }, m).body;
  check('⑧ 自动段部分超出人工 → 仍推送自动（不误删）', b.includes('自动标记：校准 13:20~14:00(40min)'));
}

// ⑨ 废水点 ≤1h 标样核查被官方豁免（有效率 ≥95.83 视为达标），但**有标记仍要推送**（2026-10-07）
{
  const d = { date: '2026-09-29', monitorPoints: [
    { mpName: '总排口', realtime: { effeTransRate: 100 }, comple: { effeTransRate: 100 } },
  ] };
  const m = { byMp: new Map([['总排口', {
    manual: '化学需氧量/氨氮 校准-自动监测设备处于校准 13:21~14:06(46min)', auto: null,
  }]]) };
  const b = buildText(d, { unitRate: 100 }, m).body;
  check('⑨ 废水豁免点达标但有标记 → 仍出现在异常监控点里', b.includes('· 总排口'), b);
  check('⑨b 废水豁免点的人工标记照常推送（带因子名）',
    b.includes('人工标记：化学需氧量/氨氮 校准-自动监测设备处于校准 13:21~14:06(46min)'));
  check('⑨c 标注豁免原因，避免"100% 却异常"的困惑', b.includes('已豁免'));
}
// ⑩ 同样豁免的废水点，若**没有**标记则不出现（豁免仍然生效，不误报）
{
  const d = { date: '2026-09-29', monitorPoints: [
    { mpName: '总排口', realtime: { effeTransRate: 100 }, comple: { effeTransRate: 100 } },
  ] };
  const b = buildText(d, { unitRate: 100 }, { byMp: new Map() }).body;
  check('⑩ 废水豁免点无标记 → 不推送（豁免判定未被破坏）', b === '', JSON.stringify(b));
}
// ⑪ 人工标记同因子多段 → 因子名只列一次（与自动标记同规则，2026-10-07）
{
  const d = { date: '2026-10-05', monitorPoints: [
    { mpName: '3号机组', realtime: { effeTransRate: 97.22 }, comple: { effeTransRate: 97.22 } },
  ] };
  const m = { byMp: new Map([['3号机组', {
    manual: '二氧化硫/氮氧化物 校准 14:43~14:51(9min)；\n二氧化硫/氮氧化物 故障 14:52~14:53(2min)',
    auto: null,
  }]]) };
  const b = buildText(d, { unitRate: 97 }, m).body;
  const cnt = (b.match(/二氧化硫\/氮氧化物/g) || []).length;
  check('⑪ 人工标记多行分组正常渲染', b.includes('校准 14:43~14:51(9min)') && b.includes('故障 14:52~14:53(2min)'), b);
}

// ⑫ 废水「标样核查」是自动标记，即使时段与人工「校准」重合也要两者都推送（2026-10-07）
{
  const d = { date: '2026-10-06', monitorPoints: [
    { mpName: '总排口', realtime: { effeTransRate: 97.87 }, comple: { effeTransRate: 97.87 } },
  ] };
  const m = { byMp: new Map([['总排口', {
    manual: '化学需氧量/氨氮 校准-自动监测设备处于校准 13:27~14:23(57min)',
    auto: '化学需氧量 标样核查 13:40~13:50(11min)',
  }]]) };
  const b = buildText(d, { unitRate: 99.5 }, m).body;
  check('⑫ 标样核查与人工校准时段重合 → 人工仍推送',
    b.includes('人工标记：化学需氧量/氨氮 校准-自动监测设备处于校准 13:27~14:23(57min)'), b);
  check('⑫b 标样核查不被人工覆盖抑制（两条都在）',
    b.includes('自动标记：化学需氧量 标样核查 13:40~13:50(11min)'), b);
}
// ⑬ 非标样核查类自动标记仍按原规则被人工覆盖抑制（确认改动没有扩大豁免范围）
{
  const d = { date: '2026-10-06', monitorPoints: [
    { mpName: '某点', realtime: { effeTransRate: 95 }, comple: { effeTransRate: 95 } },
  ] };
  const m = { byMp: new Map([['某点', {
    manual: '二氧化硫 校准-自动监测设备处于校准 13:00~14:00(61min)',
    auto: '二氧化硫 校准 13:30~13:50(21min)',
  }]]) };
  const b = buildText(d, { unitRate: 97 }, m).body;
  check('⑬ 普通自动标记仍被人工覆盖抑制（未误豁免）', !b.includes('13:30~13:50'), b);
}

// ⑭ 标样核查（自动）≤1h 不构成推送理由；仅有人工标记或其他异常段时才推（2026-10-08）
{
  const d = { date: '2026-10-08', monitorPoints: [
    { mpName: '总排口', realtime: { effeTransRate: 100 }, comple: { effeTransRate: 100 } },
  ] };
  // a. 只有标样核查自动标记（无人工）→ 不进异常列表
  const b1 = buildText(d, { unitRate: 100 }, { byMp: new Map([['总排口', {
    manual: null, auto: '化学需氧量 标样核查 13:40~13:50(11min)',
  }]]) }).body;
  check('⑭a 纯标样核查自动标记 → 不推送该点', b1 === '', JSON.stringify(b1));
  // b. 有人工标记 → 推送（核查段照常显示，不被人工覆盖抑制）
  const b2 = buildText(d, { unitRate: 100 }, { byMp: new Map([['总排口', {
    manual: '化学需氧量/氨氮 校准-自动监测设备处于校准 13:27~14:23(57min)',
    auto: '化学需氧量 标样核查 13:40~13:50(11min)',
  }]]) }).body;
  check('⑭b 标样核查与人工校准重叠 → 人工与核查都推',
    b2.includes('人工标记') && b2.includes('标样核查 13:40~13:50(11min)'), b2);
  // c. 废水豁免点：核查/维护等自动标记无论什么措辞都不构成推送理由（公开平台兜底写"自动监测设备维护"）
  const b3 = buildText(d, { unitRate: 100 }, { byMp: new Map([['总排口', {
    manual: null, auto: '自动监测设备维护 11(1h)',
  }]]) }).body;
  check('⑭c 废水豁免点纯自动标记（含维护措辞）→ 不推送', b3 === '', JSON.stringify(b3));
  // d. 非废水点维持原行为：任何自动标记都构成推送理由
  const d4 = { date: '2026-10-08', monitorPoints: [
    { mpName: '3号机组', realtime: { effeTransRate: 97.22 }, comple: { effeTransRate: 97.22 } },
  ] };
  const b4 = buildText(d4, { unitRate: 97 }, { byMp: new Map([['3号机组', {
    manual: null, auto: '二氧化硫 故障 14:52~14:53(2min)',
  }]]) }).body;
  check('⑭d 非废水点纯自动标记 → 照常推送', b4.includes('故障 14:52~14:53(2min)'), b4);
}
// ⑮ 北京时间推送窗口 15:00–20:59（2026-10-08）
import { inPushWindow } from '../src/index.js';
{
  check('⑮a 14 点窗外', inPushWindow(14) === false);
  check('⑮b 15 点窗内', inPushWindow(15) === true);
  check('⑮c 20 点窗内', inPushWindow(20) === true);
  check('⑮d 21 点窗外', inPushWindow(21) === false);
  check('⑮e 0 点窗外', inPushWindow(0) === false);
}

const failed = results.filter((x) => !x.pass).length;
console.log(`\n${results.length - failed}/${results.length} PASS`);
process.exit(failed ? 1 : 0);
