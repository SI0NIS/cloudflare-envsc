// marks v2 结构化契约回归测试（2026-10-22 波次2）。
// 目标：v2 结构化载荷经 buildText 产出的推送文本，与等价 v1 文本载荷**逐字节一致**；
// 同时锁定 v2SegsText 的分组/平铺/时长格式化规则。
// 运行：node tools/marksv2-test.mjs
import { buildText, v2SegsText } from '../src/index.js';

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '\n      ' + detail : ''}`);
}

// v2 段快捷构造：{factors, head, start, end, minutes}
const seg = (factors, head, start, end, minutes) => ({ factors, head, start, end, minutes });

// ---------- 场景夹具（与 buildtext-test.mjs 的 v1 夹具等价） ----------
const data = {
  date: '2026-09-28',
  monitorPoints: [
    { mpName: '3号机组', realtime: { effeTransRate: 93.51 }, comple: { effeTransRate: 93.51 } },
    { mpName: '1号2号机组', realtime: { effeTransRate: 97.68 }, comple: { effeTransRate: 97.68 } },
    { mpName: '总排口', realtime: { effeTransRate: 100 }, comple: { effeTransRate: 100 } },
  ],
};

// ① v1 等价：manual '校准-自动监测设备处于校验 21:00~21:23(24min)'（无因子名）
//           auto   '校准 14:05~14:33(29min)；校准 14:41~17:28(168min)；校准 19:08~20:50(103min)'
const marksV2 = {
  attempted: true, total: 1, error: null,
  byMp: new Map([
    ['3号机组', { v2: {
      manual: { segs: [seg([], '校准-自动监测设备处于校验', '21:00', '21:23', 24)] },
      auto: { segs: [
        seg([], '校准', '14:05', '14:33', 29),
        seg([], '校准', '14:41', '17:28', 168),
        seg([], '校准', '19:08', '20:50', 103),
      ] },
    } }],
    ['1号2号机组', { v2: { manual: null, auto: { segs: [seg([], '校准', '12:08', '12:59', 52)] } } }],
  ]),
};

const { title, body } = buildText(data, { unitRate: 97.66 }, marksV2);
const seg3 = body.split('· 1号2号机组')[0];
const seg12 = body.split('· 1号2号机组')[1] || '';

check('① v2 人工标记文本与 v1 一致', seg3.includes('人工标记：校准-自动监测设备处于校验 21:00~21:23(24min)'), seg3);
check('② v2 自动标记三段全部保留（无因子名 → 平铺成独立组）',
  seg3.includes('校准 14:05~14:33(29min)') && seg3.includes('校准 14:41~17:28(168min)') && seg3.includes('校准 19:08~20:50(103min)'), seg3);
check('③ 仅自动标记的点只显示自动', seg12.includes('自动标记：校准 12:08~12:59(52min)') && !seg12.includes('人工标记'), seg12);
check('④ 无标记点（总排口）不进异常列表', !body.includes('总排口'));

// ⑤ 人工与自动完全相同 → 只显示一行
{
  const m = { byMp: new Map([['3号机组', { v2: {
    manual: { segs: [seg([], '校准', '14:05', '14:33', 29)] },
    auto: { segs: [seg([], '校准', '14:05', '14:33', 29)] },
  } }]]) };
  const b = buildText(data, { unitRate: 97.66 }, m).body;
  const cnt = (b.match(/标记：校准 14:05~14:33\(29min\)/g) || []).length;
  check('⑤ 人工与自动完全相同时只显示一行', cnt === 1, `出现 ${cnt} 次`);
}

// ⑥ 覆盖抑制：自动段被人工段完全覆盖 → 仅推人工（9-29 真实情形）
{
  const d = { date: '2026-09-29', monitorPoints: [
    { mpName: '生产工艺尾气排放口', realtime: { effeTransRate: 95 }, comple: { effeTransRate: 95 } },
  ] };
  const m = { byMp: new Map([['生产工艺尾气排放口', { v2: {
    manual: { segs: [seg(['二氧化硫'], '校准-自动监测设备处于校准', '13:51', '14:16', 26)] },
    auto: { segs: [seg(['二氧化硫'], '校准', '13:52', '14:11', 20)] },
  } }]]) };
  const b = buildText(d, { unitRate: 95 }, m).body;
  check('⑥ 覆盖抑制：自动段被人工覆盖后不显示', b.includes('人工标记：') && !b.includes('自动标记'), b);
}

// ⑦ 部分重叠 → 人工与自动都显示
{
  const d = { date: '2026-09-29', monitorPoints: [{ mpName: '3号机组', realtime: { effeTransRate: 95 }, comple: { effeTransRate: 95 } }] };
  const m = { byMp: new Map([['3号机组', { v2: {
    manual: { segs: [seg([], '校准-校验', '13:00', '14:00', 61)] },
    auto: { segs: [seg([], '故障', '13:30', '15:10', 101)] },
  } }]]) };
  const b = buildText(d, { unitRate: 95 }, m).body;
  check('⑦ 部分重叠：人工与自动都显示', b.includes('人工标记：校准-校验 13:00~14:00(61min)') && b.includes('自动标记：故障 13:30~15:10(101min)'), b);
}

// ⑧ 标样核查豁免：被人工覆盖的标样核查段仍显示
{
  const d = { date: '2026-10-08', monitorPoints: [{ mpName: '总排口', realtime: { effeTransRate: 100 }, comple: { effeTransRate: 100 } }] };
  const m = { byMp: new Map([['总排口', { v2: {
    manual: { segs: [seg(['化学需氧量'], '校准-自动监测设备处于校准', '13:00', '14:00', 61)] },
    auto: { segs: [seg(['化学需氧量'], '标样核查', '13:10', '13:50', 41)] },
  } }]]) };
  const b = buildText(d, { unitRate: 100 }, m).body;
  check('⑧ 标样核查段豁免覆盖抑制', b.includes('标样核查 13:10~13:50(41min)'), b);
}

// ⑨ 多因子组 + 同组连续段合并展示（组头因子只出现一次）
{
  const d = { date: '2026-10-21', monitorPoints: [{ mpName: '3号机组', realtime: { effeTransRate: 100 }, comple: { effeTransRate: 100 } }] };
  const m = { byMp: new Map([['3号机组', { v2: {
    manual: null,
    auto: { segs: [
      seg(['颗粒物'], '校准', '01:42', '01:48', 7),
      seg(['颗粒物'], '日常维护', '01:50', '01:56', 7),
      seg(['二氧化硫', '氮氧化物'], '日常维护', '02:10', '02:20', 11),
    ] },
  } }]]) };
  const b = buildText(d, { unitRate: 100 }, m).body;
  check('⑨a 同因子连续段并入一组（组头一次）', b.includes('颗粒物 校准 01:42~01:48(7min)；日常维护 01:50~01:56(7min)'), b);
  check('⑨b 不同因子成新组并换行展示', b.includes('；\n二氧化硫/氮氧化物 日常维护 02:10~02:20(11min)'), b);
}

// ⑩ noGroup 平铺（rg 兜底镜像 v1 windowText 平铺）
{
  const d = { date: '2026-10-21', monitorPoints: [{ mpName: '3号机组', realtime: { effeTransRate: 99 }, comple: { effeTransRate: 99 } }] };
  const m = { byMp: new Map([['3号机组', { v2: {
    manual: { noGroup: true, segs: [
      seg(['颗粒物'], '校准-自动监测设备处于校准', '12:00', '12:05', 6),
      seg(['颗粒物'], '校准-自动监测设备处于校准', '12:10', '12:15', 6),
    ] },
    auto: { segs: [] },
  } }]]) };
  const b = buildText(d, { unitRate: 99 }, m).body;
  check('⑩ noGroup：每段自带因子名、；连接不换行',
    b.includes('颗粒物 校准-自动监测设备处于校准 12:00~12:05(6min)；颗粒物 校准-自动监测设备处于校准 12:10~12:15(6min)') && !b.includes('；\n'), b);
}

// ⑪ 整小时格式化（60min → 1h；120min → 2h）
{
  const t = v2SegsText([seg([], '故障', '12:00', '12:59', 60), seg([], '故障', '13:00', '14:59', 120)]);
  check('⑪ 时长格式化 60min→1h / 120min→2h', t.includes('(1h)') && t.includes('(2h)'), t);
}

// ⑫ 废水豁免点：仅自动标记不构成推送理由（不进异常列表）；有人工标记则进
{
  const d = { date: '2026-10-08', monitorPoints: [{ mpName: '总排口', realtime: { effeTransRate: 99 }, comple: { effeTransRate: 99 } }] };
  const mAutoOnly = { byMp: new Map([['总排口', { v2: { manual: null, auto: { segs: [seg(['化学需氧量'], '标样核查', '13:10', '13:50', 41)] } } }]]) };
  const b1 = buildText(d, { unitRate: 99 }, mAutoOnly).body;
  check('⑫a 废水点仅自动标记 → 不进异常列表', !b1.includes('总排口'), b1);
  const mWithManual = { byMp: new Map([['总排口', { v2: { manual: { segs: [seg(['化学需氧量'], '标样核查-自动标样核查运行', '13:21', '14:06', 46)] }, auto: { segs: [] } } }]]) };
  const b2 = buildText(d, { unitRate: 99 }, mWithManual).body;
  check('⑫b 废水点有人工标记 → 进列表且带豁免标注', b2.includes('总排口') && b2.includes('（≤1h 标样核查，已豁免）'), b2);
}

// ⑬ v2SegsText 分组规则直测：交错因子不并组
{
  const t = v2SegsText([
    seg(['A'], '校准', '01:00', '01:10', 11),
    seg(['B'], '校准', '02:00', '02:10', 11),
    seg(['A'], '校准', '03:00', '03:10', 11),
  ]);
  check('⑬ 交错因子各自成组（A、B、A 三组）', t === 'A 校准 01:00~01:10(11min)；\nB 校准 02:00~02:10(11min)；\nA 校准 03:00~03:10(11min)', t);
}

// ⑭ 人工标记只覆盖同因子：10.27 1号2号机组 v2/v1 输出必须一致且不吞流量等异常段
{
  const d = { date: '2026-10-27', monitorPoints: [
    { mpName: '1号2号机组', realtime: { effeTransRate: 98.14 }, comple: { effeTransRate: 98.14 } },
  ] };
  const all = ['二氧化硫', '氧含量', '氮氧化物', '流量', '颗粒物'];
  const v2 = { byMp: new Map([['1号2号机组', { v2: {
    manual: { segs: [seg(['颗粒物'], '数据有效', '11:00', '11:59', 60)] },
    auto: { segs: [
      seg(all, '日常维护', '10:55', '10:59', 5),
      seg(all, '校准', '11:00', '11:04', 5),
      seg(all, '日常维护', '11:05', '11:07', 3),
      seg(['氧含量', '氮氧化物', '流量', '颗粒物'], '校准', '11:08', '11:48', 41),
      seg(['二氧化硫'], '校准', '11:08', '11:12', 5),
      seg(['二氧化硫'], '故障', '11:13', '11:29', 17),
      seg(['二氧化硫'], '校准', '11:30', '11:48', 19),
      seg(['二氧化硫'], '故障', '11:36', '11:36', 1),
      seg(all, '故障', '11:50', '11:50', 1),
      seg(all, '校准', '11:51', '12:00', 10),
    ] },
  } }]]) };
  const v1 = { byMp: new Map([['1号2号机组', {
    manual: '颗粒物 数据有效 11:00~11:59(1h)',
    auto: '二氧化硫/氧含量/氮氧化物/流量/颗粒物 日常维护 10:55~10:59(5min)；校准 11:00~11:04(5min)；日常维护 11:05~11:07(3min)；\n氧含量/氮氧化物/流量/颗粒物 校准 11:08~11:48(41min)；\n二氧化硫 校准 11:08~11:12(5min)；故障 11:13~11:29(17min)；校准 11:30~11:48(19min)；故障 11:36~11:36(1min)；\n二氧化硫/氧含量/氮氧化物/流量/颗粒物 故障 11:50~11:50(1min)；校准 11:51~12:00(10min)',
  }]]) };
  const b2 = buildText(d, { unitRate: 98.15 }, v2).body;
  const b1 = buildText(d, { unitRate: 98.15 }, v1).body;
  const canon = (t) => t.replace(/；\n/g, '\n'); // v2 分组分隔符比 v1 多一个分号
  check('⑭a v2 与 v1 的 10.27 文案内容一致', canon(b2) === canon(b1), `v2:\n${b2}\nv1:\n${b1}`);
  check('⑭b 不同因子首组校准段保留',
    b2.includes('二氧化硫/氧含量/氮氧化物/流量/颗粒物 日常维护 10:55~10:59(5min)；校准 11:00~11:04(5min)；日常维护 11:05~11:07(3min)'), b2);
  check('⑭c 氧含量/NOx/流量/颗粒物 41 分钟校准段保留',
    b2.includes('氧含量/氮氧化物/流量/颗粒物 校准 11:08~11:48(41min)'), b2);
  check('⑭d 11:50 故障与 11:51 校准保留',
    b2.includes('二氧化硫/氧含量/氮氧化物/流量/颗粒物 故障 11:50~11:50(1min)；校准 11:51~12:00(10min)'), b2);
}
// ⑮ 纯颗粒物自动段仍受同因子人工标记抑制
{
  const d = { date: '2026-10-27', monitorPoints: [
    { mpName: '1号2号机组', realtime: { effeTransRate: 98.14 }, comple: { effeTransRate: 98.14 } },
  ] };
  const m = { byMp: new Map([['1号2号机组', { v2: {
    manual: { segs: [seg(['颗粒物'], '数据有效', '11:00', '11:59', 60)] },
    auto: { segs: [seg(['颗粒物'], '校准', '11:10', '11:20', 11)] },
  } }]]) };
  const b = buildText(d, { unitRate: 98.15 }, m).body;
  check('⑮ 纯颗粒物自动段被同因子人工覆盖', !b.includes('自动标记') && !b.includes('11:10~11:20'), b);
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} PASS`);
process.exit(failed.length ? 1 : 0);
