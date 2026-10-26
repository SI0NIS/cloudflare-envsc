import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import jpeg from 'jpeg-js';
import {
  buildLoginBody,
  decodeLoginBody,
  findStation,
  flattenStationTree,
  getDataType,
  mapLimit,
  md5,
  normalizeFactors,
  normalizeRows,
  readTokenCache,
  resolveDataRange,
  rowsToCsv,
  writeTokenCache,
  YiliClient,
} from './yili/lib/client.mjs';
import {
  evaluateExpression,
  loadCaptchaModel,
  solveCaptchaImage,
} from './yili/lib/captcha.mjs';
import { AuthError, CaptchaError, ConfigError, DataIncompleteError } from './yili/lib/errors.mjs';

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

async function expectError(name, ErrorType, worker) {
  try {
    await worker();
    check(name, false, '未抛出异常');
    return null;
  } catch (error) {
    check(name, error instanceof ErrorType, { name: error.name, message: error.message });
    return error;
  }
}

const jsonResponse = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'content-type': 'application/json' },
});

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yili-test-'));
const baseConfig = {
  baseUrl: 'https://example.test',
  token: 'token',
  username: '',
  password: '',
  useTokenCache: false,
  tokenCachePath: path.join(tempRoot, 'token.json'),
  captchaModelPath: path.resolve('tools/yili/captcha-model.json'),
  maxCaptchaAttempts: 3,
  defaultPageSize: 5000,
  maxPages: 20,
  concurrency: 3,
  requestTimeoutMs: 1000,
  verifyTls: false,
};

function makeClient({ config = {}, transport, captchaSolver, random } = {}) {
  return new YiliClient({
    config: { ...baseConfig, ...config },
    transport,
    captchaSolver,
    sleep: async () => {},
    random,
  });
}

function secondTime(index) {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString().slice(0, 19).replace('T', ' ');
}

{
  check('MD5(test) 与标准值一致', md5('test') === '098f6bcd4621d373cade4e832627b4f6');
  const body = buildLoginBody({
    username: 'demo',
    password: 'test',
    code: '8',
    uuid: 'uuid-1',
    random: () => 0,
  });
  const payload = decodeLoginBody(body);
  check('登录包装体为 4+Base64+5 位', body.startsWith('0000') && body.endsWith('00000'), body.slice(-5));
  check('登录包装体字段完整', payload.username === 'demo' && payload.code === '8' && payload.uuid === 'uuid-1', payload);
  check('登录包装体密码已 MD5', payload.password === '098f6bcd4621d373cade4e832627b4f6', payload.password);
  check('getDataType 四类映射', getDataType('realtime').cnType === '2011'
    && getDataType('minute').cnType === '2051'
    && getDataType('hour').cnType === '2061'
    && getDataType('day').cnType === '2031');
  await expectError('无效数据类型抛 ConfigError', ConfigError, async () => getDataType('unknown'));
}

{
  check('验证码加法', evaluateExpression('2+6') === 8);
  check('验证码减法可为负数', evaluateExpression('1-3') === -2);
  check('验证码乘法', evaluateExpression('9*7') === 63);
  check('验证码整除', evaluateExpression('6/3') === 2);
  await expectError('验证码除零被拒绝', CaptchaError, async () => evaluateExpression('1/0'));
  await expectError('验证码非法表达式被拒绝', CaptchaError, async () => evaluateExpression('12+3'));

  const model = loadCaptchaModel(baseConfig.captchaModelPath);
  check('验证码模型加载 200 个原型', model.prototypes.left.count === 200
    && model.prototypes.operator.count === 200
    && model.prototypes.right.count === 200, model.prototypes.left.count);
  const blank = jpeg.encode({
    width: 160,
    height: 60,
    data: Buffer.alloc(160 * 60 * 4, 255),
  }, 70).data;
  const solved = solveCaptchaImage(blank, model);
  check('合成验证码图像可解码并计算', /^[0-9][+\-*/][0-9]$/.test(solved.expression)
    && typeof solved.answer === 'string', solved);
}

{
  const cachePath = path.join(tempRoot, 'cache', 'token.json');
  writeTokenCache(cachePath, { baseUrl: 'https://example.test', username: 'demo', token: 'abc' });
  const cached = readTokenCache(cachePath, { baseUrl: 'https://example.test', username: 'demo' });
  check('token 缓存可读写', cached?.token === 'abc' && cached.username === 'demo', cached);
  check('token 缓存拒绝不同账号', readTokenCache(cachePath, { username: 'other' }) === null);
  check('token 缓存拒绝不同地址', readTokenCache(cachePath, { baseUrl: 'https://other.test' }) === null);
}

{
  const tree = {
    treeList: [{
      id: 'province', level: 1, label: '伊犁哈萨克自治州', children: [{
        id: 'city', level: 2, label: '伊宁市', children: [{
          id: 'enterprise', level: 3, label: '测试企业', children: [{
            id: 'station-1', level: 4, label: '废水总排口', type: 2, stationType: 'WATER', children: [null],
          }],
        }],
      }],
    }],
  };
  const stations = flattenStationTree(tree);
  check('树扁平化只返回点位', stations.length === 1 && stations[0].id === 'station-1', stations);
  check('树路径为纯名称', stations[0].pathText === '伊犁哈萨克自治州 / 伊宁市 / 测试企业 / 废水总排口', stations[0].pathText);
  check('树父节点正确', stations[0].parentId === 'enterprise', stations[0].parentId);
  check('点位名称模糊匹配', findStation(stations, '总排口').id === 'station-1');
  await expectError('点位无匹配时报错', ConfigError, async () => findStation(stations, '不存在'));
}

const waterFactors = normalizeFactors([{
  factorCode: 'w01001',
  factorName: 'PH值',
  factorUnit: '',
  upLowContent: '(6-9)',
  upLimit: 9,
  lowLimit: 6,
  children: [
    { factorFlag: 'RTD', factorCode: 'w01001', uploadCode: 'RTD_w01001', factorName: '浓度值' },
    { factorFlag: 'FLAG', factorCode: 'w01001', uploadCode: 'FLAG_w01001', factorName: '数据标记' },
  ],
}]);
const gasFactors = normalizeFactors([{
  factorCode: 'a21026',
  factorName: '二氧化硫',
  factorUnit: 'mg/m3',
  upLimit: 35,
  lowLimit: 0,
  children: [
    { factorFlag: 'ZSRTD', factorCode: 'a21026', uploadCode: 'ZSRTD_a21026', factorName: '折算值' },
    { factorFlag: 'RTD', factorCode: 'a21026', uploadCode: 'RTD_a21026', factorName: '浓度值' },
    { factorFlag: 'FLAG', factorCode: 'a21026', uploadCode: 'FLAG_a21026', factorName: '数据标记' },
  ],
}]);

{
  const rows = normalizeRows([{
    dt: '2026-10-25 10:00:00',
    RTD_w01001: '7.958',
    ZSRTD_w01001: '',
    FLAG_w01001: 'N',
    MANUAL_FLAG_w01001: '',
    MAX_w01001: '7.984',
    MIN_w01001: '7.909',
    AVG_w01001: '7.958',
  }], { factors: waterFactors, type: 'realtime', showType: 'RTD' });
  check('废水动态字段解析', rows[0].values.w01001.value === '7.958'
    && rows[0].values.w01001.zsValue === null
    && rows[0].values.w01001.flag === 'N', rows[0]);
  check('统计字段动态解析', rows[0].values.w01001.metrics.max === '7.984'
    && rows[0].values.w01001.metrics.avg === '7.958', rows[0].values.w01001.metrics);
  check('限值写入标准化行', rows[0].values.w01001.lowLimit === 6 && rows[0].values.w01001.highLimit === 9);

  const gasRows = normalizeRows([{
    dt: '2026-10-25 10:00:00',
    RTD_a21026: '10.1',
    ZSRTD_a21026: '12.3',
    FLAG_a21026: 'N',
  }], { factors: gasFactors, type: 'realtime', showType: 'ZS' });
  check('废气折算值作为当前值', gasRows[0].values.a21026.displayValue === '12.3'
    && gasRows[0].values.a21026.value === '10.1', gasRows[0].values.a21026);
  const inferred = normalizeRows([{ dt: '2026-10-25 10:00:00', RTD_x1: '3.2' }], { type: 'realtime' });
  check('缺少因子元数据时可推断字段', inferred[0].values.x1.value === '3.2', inferred[0]);

  const csv = rowsToCsv(rows);
  check('CSV 含数据时间与因子列', csv.includes('数据时间') && csv.includes('PH值(w01001)-当前值'), csv.split('\r\n')[0]);
}

{
  const range = resolveDataRange({ type: 'hour', date: '2026-10-25' });
  check('小时数据按自然日展开', range.startTime === '2026-10-25 00:00:00'
    && range.endTime === '2026-10-25 23:59:59' && range.dataType.cnType === '2061', range);
  const dayRange = resolveDataRange({ type: 'day', date: '2026-10-25' });
  check('日数据保持纯日期', dayRange.startTime === '2026-10-25' && dayRange.endTime === '2026-10-25', dayRange);
  const custom = resolveDataRange({
    type: 'minute',
    startTime: '2026-10-25 08:00',
    endTime: '2026-10-25 09:00',
  });
  check('自定义时间自动补秒', custom.startTime === '2026-10-25 08:00:00'
    && custom.endTime === '2026-10-25 09:00:00', custom);
  await expectError('日期与自定义时间互斥', ConfigError, async () => resolveDataRange({
    type: 'hour', date: '2026-10-25', startTime: '2026-10-25 00:00:00', endTime: '2026-10-25 23:59:59',
  }));

  const mapped = await mapLimit([1, 2, 3, 4], 2, async (value) => value * 2);
  check('mapLimit 保持结果顺序', mapped.join(',') === '2,4,6,8', mapped);
}

{
  const allRows = Array.from({ length: 12001 }, (_, index) => ({ dt: secondTime(index), RTD_x: String(index) }));
  const requests = [];
  const transport = async (url, init) => {
    const parsed = new URL(url);
    const pageSize = Number(parsed.searchParams.get('pageSize'));
    const pageNum = Number(parsed.searchParams.get('pageNum'));
    const body = JSON.parse(init.body);
    requests.push({ pageNum, pageSize, bodyPageNum: body.pageNum, bodyPageSize: body.pageSize });
    const start = (pageNum - 1) * pageSize;
    return jsonResponse({ code: 200, total: String(allRows.length), rows: allRows.slice(start, start + pageSize) });
  };
  const client = makeClient({ transport });
  const result = await client.fetchAllRows({
    stationId: 'station-1',
    type: 'realtime',
    showType: 'RTD',
    startTime: '2026-01-01 00:00:00',
    endTime: '2026-01-01 23:59:59',
    pageSize: 5000,
  });
  check('5000 条分页取全 12001 行', result.total === 12001 && result.rows.length === 12001 && result.pageCount === 3,
    { total: result.total, rows: result.rows.length, pages: result.pageCount });
  check('pageNum/pageSize 同时进入 URL query', requests.every((request) => request.pageSize === 5000
    && request.pageNum >= 1) && requests.length === 3, requests);
  check('pageNum/pageSize 同时保留在请求体', requests.every((request) => request.bodyPageNum === request.pageNum
    && request.bodyPageSize === 5000), requests);
  check('返回行按时间升序', result.rows[0].dt === secondTime(0) && result.rows.at(-1).dt === secondTime(12000));
}

{
  const transport = async (url) => {
    const parsed = new URL(url);
    const pageNum = Number(parsed.searchParams.get('pageNum'));
    const pageSize = Number(parsed.searchParams.get('pageSize'));
    const total = 4;
    const rows = pageNum === 1
      ? [{ dt: secondTime(0) }, { dt: secondTime(1) }]
      : [{ dt: secondTime(2) }];
    return jsonResponse({ code: 200, total, rows: rows.slice(0, pageSize) });
  };
  const client = makeClient({ transport });
  await expectError('末页缺行触发 DataIncompleteError', DataIncompleteError, async () => client.fetchAllRows({
    stationId: 'station-1', type: 'realtime', showType: 'RTD',
    startTime: '2026-01-01 00:00:00', endTime: '2026-01-01 23:59:59', pageSize: 2,
  }));
}

{
  const transport = async (url) => {
    const parsed = new URL(url);
    const pageNum = Number(parsed.searchParams.get('pageNum'));
    const rows = pageNum === 1
      ? [{ dt: secondTime(0) }, { dt: secondTime(1) }]
      : [{ dt: secondTime(1) }, { dt: secondTime(2) }];
    return jsonResponse({ code: 200, total: 4, rows });
  };
  const client = makeClient({ transport });
  await expectError('跨页重复时间触发 DataIncompleteError', DataIncompleteError, async () => client.fetchAllRows({
    stationId: 'station-1', type: 'realtime', showType: 'RTD',
    startTime: '2026-01-01 00:00:00', endTime: '2026-01-01 23:59:59', pageSize: 2,
  }));
}

{
  let loginPayload = null;
  let freshCalls = 0;
  const transport = async (url, init) => {
    if (url.includes('/prod-api/captchaImage')) {
      return jsonResponse({ code: 200, uuid: 'captcha-uuid', img: Buffer.from('jpeg').toString('base64') });
    }
    if (url.includes('/prod-api/login')) {
      loginPayload = decodeLoginBody(init.body);
      return jsonResponse({ code: 200, token: 'fresh-token' });
    }
    if (url.includes('/tableTitle')) {
      if (init.headers.Authorization === 'Bearer expired-token') return jsonResponse({ code: 401, msg: '登录状态已失效' });
      if (init.headers.Authorization === 'Bearer fresh-token') freshCalls++;
      return jsonResponse({ code: 200, data: [] });
    }
    throw new Error(`unexpected url ${url}`);
  };
  const client = makeClient({
    config: { token: 'expired-token', username: 'demo', password: 'secret' },
    transport,
    captchaSolver: { solve: () => ({ expression: '2+6', answer: '8' }) },
  });
  const factors = await client.getFactors('station-1', 'realtime');
  check('业务接口 401 后自动重登并重试', Array.isArray(factors) && freshCalls === 1 && client.token === 'fresh-token', {
    freshCalls, tokenSource: client.tokenSource,
  });
  check('重登使用验证码答案与 UUID', loginPayload?.code === '8'
    && loginPayload?.uuid === 'captcha-uuid'
    && loginPayload?.password === md5('secret'), loginPayload);
}

{
  let captchaFetches = 0;
  let loginCount = 0;
  let freshCalls = 0;
  const transport = async (url, init) => {
    if (url.includes('/captchaImage')) {
      captchaFetches++;
      return jsonResponse({ code: 200, uuid: 'captcha-uuid', img: Buffer.from('jpeg').toString('base64') });
    }
    if (url.includes('/prod-api/login')) {
      loginCount++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return jsonResponse({ code: 200, token: 'fresh-token' });
    }
    if (url.includes('/tableTitle')) {
      if (init.headers.Authorization === 'Bearer expired-token') return jsonResponse({ code: 401, msg: '登录状态已失效' });
      freshCalls++;
      return jsonResponse({ code: 200, data: [] });
    }
    throw new Error(`unexpected url ${url}`);
  };
  const client = makeClient({
    config: { token: 'expired-token', username: 'demo', password: 'secret' },
    transport,
    captchaSolver: { solve: () => ({ expression: '2+6', answer: '8' }) },
  });
  const results = await Promise.all([
    client.getFactors('station-1', 'realtime'),
    client.getFactors('station-2', 'realtime'),
  ]);
  check('并发 401 只触发一次重登', results.every(Array.isArray) && captchaFetches === 1
    && loginCount === 1 && freshCalls === 2, { captchaFetches, loginCount, freshCalls });
}

{
  let captchaFetches = 0;
  let loginAttempts = 0;
  const transport = async (url) => {
    if (url.includes('/captchaImage')) {
      captchaFetches++;
      return jsonResponse({ code: 200, uuid: `uuid-${captchaFetches}`, img: Buffer.from('jpeg').toString('base64') });
    }
    if (url.includes('/prod-api/login')) {
      loginAttempts++;
      if (loginAttempts === 1) return jsonResponse({ code: 500, msg: '验证码错误' });
      return jsonResponse({ code: 200, token: `token-${loginAttempts}` });
    }
    throw new Error(`unexpected url ${url}`);
  };
  const client = makeClient({
    config: { token: '', username: 'demo', password: 'secret' },
    transport,
    captchaSolver: { solve: () => ({ expression: '2+6', answer: '8' }) },
  });
  const result = await client.login();
  check('验证码错误后刷新重试成功', result.token === 'token-2' && captchaFetches === 2
    && loginAttempts === 2, { captchaFetches, loginAttempts, result });
}

{
  let captchaFetches = 0;
  let loginAttempts = 0;
  const transport = async (url) => {
    if (url.includes('/captchaImage')) {
      captchaFetches++;
      return jsonResponse({ code: 200, uuid: 'uuid', img: Buffer.from('jpeg').toString('base64') });
    }
    if (url.includes('/prod-api/login')) {
      loginAttempts++;
      return jsonResponse({ code: 500, msg: '用户名或密码错误' });
    }
    throw new Error(`unexpected url ${url}`);
  };
  const client = makeClient({
    config: { token: '', username: 'demo', password: 'wrong' },
    transport,
    captchaSolver: { solve: () => ({ expression: '2+6', answer: '8' }) },
  });
  await expectError('账号密码错误不循环刷新验证码', AuthError, async () => client.login());
  check('账号密码错误只提交一次登录', captchaFetches === 1 && loginAttempts === 1, { captchaFetches, loginAttempts });
}

fs.rmSync(tempRoot, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} PASS`);
if (fail) process.exitCode = 1;
