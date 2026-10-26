'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { num, parseStandard } = require('./exceed');

const DEFAULT_MAP_FILE = path.resolve(__dirname, '..', '..', '..', 'config', 'yili-hourly-map.json');
const VALID_FLAG = '数据有效';

function requiredText(value, field) {
  const text = value == null ? '' : String(value).trim();
  if (!text) throw new Error(`伊犁小时映射缺少 ${field}`);
  return text;
}

function loadHourlyMap(mapFile = DEFAULT_MAP_FILE) {
  const resolved = path.resolve(mapFile);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (error) {
    throw new Error(`无法读取伊犁小时映射 ${resolved}: ${error.message}`, { cause: error });
  }
  if (!raw || !Array.isArray(raw.points) || !raw.points.length) {
    throw new Error(`伊犁小时映射缺少 points: ${resolved}`);
  }
  if (!raw.factorMaps || typeof raw.factorMaps !== 'object') {
    throw new Error(`伊犁小时映射缺少 factorMaps: ${resolved}`);
  }

  const points = raw.points.map((point, index) => {
    const medium = requiredText(point.medium, `points[${index}].medium`);
    const factorMap = raw.factorMaps[medium];
    if (!factorMap || typeof factorMap !== 'object' || !Object.keys(factorMap).length) {
      throw new Error(`points[${index}](${point.enterpriseName || index}) 的因子映射 ${medium} 不存在`);
    }
    const enterpriseCodes = new Set();
    for (const [yiliCode, mapped] of Object.entries(factorMap)) {
      const code = requiredText(mapped?.enterpriseCode, `${medium}.${yiliCode}.enterpriseCode`);
      requiredText(mapped?.enterpriseName, `${medium}.${yiliCode}.enterpriseName`);
      if (enterpriseCodes.has(code)) {
        throw new Error(`points[${index}](${point.enterpriseName || index}) 因子编码重复: ${code}`);
      }
      enterpriseCodes.add(code);
    }
    return {
      id: requiredText(point.enterpriseId, `points[${index}].enterpriseId`),
      name: requiredText(point.enterpriseName, `points[${index}].enterpriseName`),
      mpType: Number(point.mpType),
      isGas: medium === 'gas',
      medium,
      stationId: requiredText(point.stationId, `points[${index}].stationId`),
      stationName: requiredText(point.stationName, `points[${index}].stationName`),
      factorMap,
    };
  });

  const ids = new Set();
  const stationIds = new Set();
  for (const point of points) {
    if (!Number.isFinite(point.mpType) || point.mpType <= 0) throw new Error(`监测点 ${point.name} 的 mpType 无效`);
    if (ids.has(point.id)) throw new Error(`企业端监测点 ID 重复: ${point.id}`);
    if (stationIds.has(point.stationId)) throw new Error(`州平台站点 ID 重复: ${point.stationId}`);
    ids.add(point.id);
    stationIds.add(point.stationId);
  }

  return {
    file: resolved,
    enterprisePsId: raw.enterprisePsId == null ? null : String(raw.enterprisePsId),
    factorMaps: raw.factorMaps,
    points,
  };
}

function normalizeYiliFlag(flag) {
  const raw = flag == null ? '' : String(flag).trim().toUpperCase();
  if (raw === 'N') return VALID_FLAG;
  return raw ? `数据无效(${raw})` : '数据无效';
}

function unwrapLimitText(value) {
  if (value == null) return '';
  let text = String(value).trim();
  if (!text || text === '--' || text === '/') return '';
  if ((text.startsWith('(') && text.endsWith(')')) || (text.startsWith('（') && text.endsWith('）'))) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

function normalizeYiliLimit(valueInfo) {
  const text = unwrapLimitText(valueInfo?.limit);
  if (text) {
    const parsed = parseStandard(text);
    if (parsed) {
      if (parsed.range && parsed.min === 0 && parsed.max > 0) return parsed.max;
      return parsed.range ? `${parsed.min}-${parsed.max}` : parsed.min;
    }
  }
  const low = num(valueInfo?.lowLimit);
  const high = num(valueInfo?.highLimit);
  if (low != null && high != null && high > low) return `${low}-${high}`;
  if (high != null) return high;
  return null;
}

function normalizeYiliHourRow(row, factorMap) {
  const factors = [];
  for (const [yiliCode, mapped] of Object.entries(factorMap || {})) {
    const info = row?.values?.[yiliCode];
    if (!info) continue;
    const flag = normalizeYiliFlag(info.flag);
    const limit = normalizeYiliLimit(info);
    const value = num(info.value);
    const zs = num(info.zsValue);
    const min = num(info.metrics?.min);
    const max = num(info.metrics?.max);
    const base = {
      code: mapped.enterpriseCode,
      name: mapped.enterpriseName,
      yiliCode,
      yiliName: info.name || yiliCode,
      unit: info.unit || '',
      flag,
      rawFlag: info.flag == null ? null : String(info.flag),
      valid: flag === VALID_FLAG,
      limit,
    };
    if (mapped.range === true || mapped.range === 'true') {
      const minV = min == null ? value : min;
      const maxV = max == null ? value : max;
      if (minV == null || maxV == null) continue;
      factors.push({
        ...base,
        value: maxV,
        zs: null,
        minV,
        maxV,
        isRange: true,
      });
      continue;
    }
    if (value == null) continue;
    factors.push({
      ...base,
      value,
      zs,
      isRange: false,
    });
  }
  return factors;
}

function indexRowsByHour(rows) {
  const indexed = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const match = /^\d{4}-\d{2}-\d{2}[ T](\d{2}):(\d{2})/.exec(String(row?.dt || '').trim());
    if (!match) continue;
    indexed.set(String(Number(match[1])), row);
  }
  return indexed;
}

function createYiliHourlyFallback({
  mapFile = DEFAULT_MAP_FILE,
  map,
  log = () => {},
  client,
  configLoader,
  ClientClass,
  env = process.env,
  configPath,
} = {}) {
  const loadedMap = map ? map : loadHourlyMap(mapFile);
  const pointById = new Map(loadedMap.points.map((point) => [point.id, point]));
  const pointByName = new Map(loadedMap.points.map((point) => [point.name, point]));
  const dayCache = new Map();
  let clientPromise = client ? Promise.resolve(client) : null;
  let modulesPromise = null;

  async function loadModules() {
    if (!modulesPromise) {
      const configUrl = pathToFileURL(path.resolve(__dirname, '..', '..', 'yili', 'lib', 'config.mjs')).href;
      const clientUrl = pathToFileURL(path.resolve(__dirname, '..', '..', 'yili', 'lib', 'client.mjs')).href;
      modulesPromise = Promise.all([import(configUrl), import(clientUrl)]).then(([configModule, clientModule]) => ({
        loadConfig: configModule.loadConfig,
        YiliClient: clientModule.YiliClient,
      }));
    }
    return modulesPromise;
  }

  async function getClient() {
    if (!clientPromise) {
      clientPromise = (async () => {
        let loadConfig = configLoader;
        let YiliClient = ClientClass;
        if (!loadConfig || !YiliClient) {
          const modules = await loadModules();
          loadConfig = loadConfig || modules.loadConfig;
          YiliClient = YiliClient || modules.YiliClient;
        }
        const config = loadConfig({ env, configPath });
        return new YiliClient({ config });
      })();
    }
    return clientPromise;
  }

  function findPoint(target) {
    if (!target) return null;
    if (typeof target === 'string') return pointById.get(target) || pointByName.get(target) || null;
    if (target.id != null && pointById.has(String(target.id))) return pointById.get(String(target.id));
    if (target.name != null && pointByName.has(String(target.name))) return pointByName.get(String(target.name));
    return null;
  }

  async function getDay(point, date) {
    const cacheKey = `${point.stationId}|${date}`;
    if (!dayCache.has(cacheKey)) {
      const pending = (async () => {
        const yiliClient = await getClient();
        const result = await yiliClient.query({
          station: { id: point.stationId, name: point.stationName },
          stationId: point.stationId,
          type: 'hour',
          date,
          showType: 'auto',
        });
        return {
          rowsByHour: indexRowsByHour(result?.rows),
          showType: result?.showType || null,
          total: result?.total ?? null,
        };
      })();
      dayCache.set(cacheKey, pending);
    }
    return dayCache.get(cacheKey);
  }

  async function getHour(target, hourKey) {
    const point = findPoint(target);
    if (!point) return { status: 'unmapped', point: null };
    const date = hourKey && hourKey.date;
    const hour = Number(hourKey && hourKey.hour);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) || !Number.isInteger(hour) || hour < 0 || hour > 23) {
      return { status: 'error', point, error: { code: 'INVALID_HOUR', message: '目标小时参数无效' } };
    }
    try {
      const day = await getDay(point, date);
      const row = day.rowsByHour.get(String(hour));
      if (!row) return { status: 'missing', point, showType: day.showType };
      const factors = normalizeYiliHourRow(row, point.factorMap);
      return {
        status: factors.length ? 'ok' : 'empty',
        point,
        factors,
        dt: row.dt,
        showType: day.showType,
      };
    } catch (error) {
      const detail = {
        code: error?.code || error?.name || 'ERROR',
        message: String(error?.message || error),
      };
      log(`WARN 州平台 ${date} ${hour}时 ${point.name} 取数失败：${detail.code} ${detail.message}`);
      return { status: 'error', point, error: detail };
    }
  }

  return {
    map: loadedMap,
    points: loadedMap.points,
    findPoint,
    getHour,
  };
}

module.exports = {
  DEFAULT_MAP_FILE,
  VALID_FLAG,
  createYiliHourlyFallback,
  indexRowsByHour,
  loadHourlyMap,
  normalizeYiliFlag,
  normalizeYiliHourRow,
  normalizeYiliLimit,
  unwrapLimitText,
};
