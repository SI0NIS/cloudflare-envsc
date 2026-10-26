import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  VALID_FLAG,
  createYiliHourlyFallback,
  loadHourlyMap,
  normalizeYiliFlag,
  normalizeYiliHourRow,
  normalizeYiliLimit,
} = require('./local-sync/lib/yili-hourly-fallback.cjs');
const { judgeRange, judgeTiers } = require('./local-sync/lib/exceed.js');

let pass = 0;
let fail = 0;
const check = (name, condition, detail) => {
  if (condition) {
    pass++;
    console.log('PASS ', name);
  } else {
    fail++;
    console.log('FAIL ', name, detail === undefined ? '' : JSON.stringify(detail));
  }
};

const map = loadHourlyMap();
const point = (name) => map.points.find((item) => item.name === name);

check('映射覆盖企业端 5 个监测点', map.points.length === 5,
  map.points.map((item) => item.name));
check('1# 对应 1号2号机组', point('1号2号机组')?.stationId === '650788532441214976'
  && point('1号2号机组')?.stationName === '川宁生物1#废气排放口', point('1号2号机组'));
check('2# 对应 3号机组', point('3号机组')?.stationId === '650787820260978688'
  && point('3号机组')?.stationName === '川宁生物2#废气排放口', point('3号机组'));
check('废水/废气因子映射齐全',
  map.factorMaps.water.w01001.enterpriseCode === '001'
  && map.factorMaps.water.w21003.enterpriseCode === '060'
  && map.factorMaps.water.w01018.enterpriseCode === '011'
  && map.factorMaps.gas.a34013.enterpriseCode === '001'
  && map.factorMaps.gas.a21026.enterpriseCode === '002'
  && map.factorMaps.gas.a21002.enterpriseCode === '003'
  && map.factorMaps.gas.a24088.enterpriseCode === '508', map.factorMaps);

check('州平台 N 标记映射为数据有效', normalizeYiliFlag('N') === VALID_FLAG, normalizeYiliFlag('N'));
check('州平台 C/D/空标记不视为有效',
  normalizeYiliFlag('C') !== VALID_FLAG
  && normalizeYiliFlag('D') !== VALID_FLAG
  && normalizeYiliFlag(null) !== VALID_FLAG,
  [normalizeYiliFlag('C'), normalizeYiliFlag('D'), normalizeYiliFlag(null)]);

check('pH 限值保留区间', normalizeYiliLimit({ limit: '(6-9)', lowLimit: 6, highLimit: 9 }) === '6-9');
check('从 0 起的浓度限值取上限', normalizeYiliLimit({ limit: '(0-35)', lowLimit: 0, highLimit: 35 }) === 35,
  normalizeYiliLimit({ limit: '(0-35)', lowLimit: 0, highLimit: 35 }));
check('无上限限值不误判', normalizeYiliLimit({ limit: '(≥0)', lowLimit: 0, highLimit: null }) === null);

const waterFactors = normalizeYiliHourRow({
  values: {
    w01001: {
      name: 'PH值', unit: '', value: '7.912', zsValue: null, flag: 'N',
      metrics: { min: '7.864', max: '7.939' }, limit: '(6-9)', lowLimit: 6, highLimit: 9,
    },
  },
}, point('总排口').factorMap);
const ph = waterFactors.find((item) => item.code === '001');
check('废水 pH 转为区间判定并取 min/max', ph && ph.isRange && ph.minV === 7.864 && ph.maxV === 7.939 && ph.flag === VALID_FLAG,
  ph);
check('pH 7.864~7.939 不超 6-9',
  ph && !judgeRange(ph.minV, ph.maxV, null, '6-9', ph.flag, { requireValid: true }).exceeded);

const gasFactors = normalizeYiliHourRow({
  values: {
    a34013: { name: '烟尘', unit: 'mg/m³', value: '2.485', zsValue: '2.274', flag: 'N', limit: '(0-10)', lowLimit: 0, highLimit: 10 },
    a21026: { name: '二氧化硫', unit: 'mg/m³', value: '19.548', zsValue: '17.894', flag: 'N', limit: '(0-35)', lowLimit: 0, highLimit: 35 },
    a21002: { name: '氮氧化物', unit: 'mg/m³', value: '38.452', zsValue: '35.198', flag: 'N', limit: '(0-50)', lowLimit: 0, highLimit: 50 },
    a24088: { name: '非甲烷总烃', unit: 'mg/m³', value: '35', zsValue: '36', flag: 'D', limit: '(0-100)', lowLimit: 0, highLimit: 100 },
  },
}, point('3号机组').factorMap);
const dust = gasFactors.find((item) => item.code === '001');
const so2 = gasFactors.find((item) => item.code === '002');
const nox = gasFactors.find((item) => item.code === '003');
const nmhc = gasFactors.find((item) => item.code === '508');
check('废气因子编码映射正确',
  dust?.yiliCode === 'a34013' && so2?.yiliCode === 'a21026'
  && nox?.yiliCode === 'a21002' && nmhc?.yiliCode === 'a24088', gasFactors);
check('废气保留实测与折算值', so2?.value === 19.548 && so2?.zs === 17.894, so2);
check('废气判定优先用折算值',
  judgeTiers(40, 45, null, 35, VALID_FLAG, { useZs: true, minRatio: 1, requireValid: true }).usedZs === true);
check('州平台 D 标记不触发超标',
  judgeTiers(nmhc.value, nmhc.zs, null, 100, nmhc.flag, { useZs: true, minRatio: 1, requireValid: true }).exceeded === false,
  nmhc);

let queryCalls = 0;
const fakeClient = {
  async query(args) {
    queryCalls++;
    return {
      showType: 'ZS',
      total: 2,
      rows: [
        {
          dt: '2026-10-25 10:00:00',
          values: {
            a21026: { name: '二氧化硫', unit: 'mg/m³', value: '40', zsValue: '45', flag: 'N', metrics: { max: '42', min: '38' }, limit: '(0-35)', lowLimit: 0, highLimit: 35 },
          },
        },
        {
          dt: '2026-10-25 11:00:00',
          values: {
            a21026: { name: '二氧化硫', unit: 'mg/m³', value: '10', zsValue: '9', flag: 'N', metrics: { max: '11', min: '9' }, limit: '(0-35)', lowLimit: 0, highLimit: 35 },
          },
        },
      ],
    };
  },
};
const fallback = createYiliHourlyFallback({ map, client: fakeClient, log: () => {} });
const first = await fallback.getHour('1号2号机组', { date: '2026-10-25', hour: 10 });
const second = await fallback.getHour({ id: '65400000003175' }, { date: '2026-10-25', hour: 10 });
check('兜底按目标小时返回州平台因子', first.status === 'ok'
  && first.point.stationName === '川宁生物1#废气排放口'
  && first.factors[0].code === '002' && first.factors[0].zs === 45, first);
check('单日查询结果缓存，不重复请求', queryCalls === 1 && second.status === 'ok', { queryCalls, secondStatus: second.status });
const missing = await fallback.getHour('1号2号机组', { date: '2026-10-25', hour: 12 });
check('州平台缺少该小时时返回 missing', missing.status === 'missing' && queryCalls === 1, missing);
check('未配置映射的企业点返回 unmapped', (await fallback.getHour('不存在', { date: '2026-10-25', hour: 10 })).status === 'unmapped');

const failing = createYiliHourlyFallback({
  map,
  client: { async query() { throw Object.assign(new Error('boom'), { code: 'API_ERROR' }); } },
  log: () => {},
});
const failed = await failing.getHour('总排口', { date: '2026-10-25', hour: 10 });
check('州平台接口失败返回分类错误，不抛穿主流程',
  failed.status === 'error' && failed.error.code === 'API_ERROR' && /boom/.test(failed.error.message), failed);

const standards = JSON.parse(fs.readFileSync(new URL('../config/standards.json', import.meta.url), 'utf8'));
const so2Evidence = judgeTiers(40, 45, null, standards.legal['1号2号机组']['002'], VALID_FLAG, {
  useZs: true, minRatio: 1, requireValid: true,
});
check('兜底沿用 1号2号机组 SO2 35 法定限值', so2Evidence.exceedLegal === true && so2Evidence.judged === 45,
  so2Evidence);

console.log(`\n${pass}/${pass + fail} PASS`);
process.exit(fail ? 1 : 0);
