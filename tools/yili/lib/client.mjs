import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createCaptchaSolver } from './captcha.mjs';
import {
  ApiError,
  AuthError,
  CaptchaError,
  ConfigError,
  DataIncompleteError,
  isAuthFailureCode,
} from './errors.mjs';
import { createHttpsTransport } from './http.mjs';

export const DATA_TYPES = Object.freeze({
  realtime: { cnType: '2011', label: '实时数据' },
  minute: { cnType: '2051', label: '分钟数据' },
  hour: { cnType: '2061', label: '小时数据' },
  day: { cnType: '2031', label: '日数据' },
});

export const SHOW_TYPES = Object.freeze(['auto', 'rtd', 'zs']);
const AUTH_PREFIX = '/prod-api';
const API_PREFIX = '/wry-api';
const STAT_FLAGS = ['MAX', 'MIN', 'AVG', 'COU'];
const RANDOM_CHARS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

function cleanValue(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function finiteNumberOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeChildren(node) {
  return Array.isArray(node?.children) ? node.children.filter(Boolean) : [];
}

export function md5(text) {
  return crypto.createHash('md5').update(String(text), 'utf8').digest('hex');
}

export function randomAlphaNumeric(length, random = Math.random) {
  const size = Number(length);
  if (!Number.isInteger(size) || size < 0) throw new ConfigError(`随机串长度无效: ${length}`);
  let output = '';
  for (let i = 0; i < size; i++) {
    const index = Math.floor(random() * RANDOM_CHARS.length);
    output += RANDOM_CHARS[Math.max(0, Math.min(RANDOM_CHARS.length - 1, index))];
  }
  return output;
}

export function buildLoginBody({ username, password, code, uuid, random = Math.random }) {
  if (!username) throw new AuthError('登录账号为空');
  if (!password) throw new AuthError('登录密码为空');
  if (code == null || code === '') throw new CaptchaError('验证码答案为空');
  if (!uuid) throw new CaptchaError('验证码 UUID 为空');
  const payload = {
    username: String(username),
    password: md5(password),
    code: String(code),
    uuid: String(uuid),
  };
  return randomAlphaNumeric(4, random)
    + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
    + randomAlphaNumeric(5, random);
}

export function decodeLoginBody(body) {
  const text = String(body ?? '');
  if (text.length < 10) throw new ConfigError('登录包装体过短');
  const encoded = text.slice(4, -5);
  try {
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch (error) {
    throw new ConfigError(`登录包装体解码失败: ${error.message}`, { cause: error });
  }
}

export function getDataType(type) {
  const key = String(type || '').trim().toLowerCase();
  const info = DATA_TYPES[key];
  if (!info) throw new ConfigError(`数据类型无效: ${type}；可选 realtime/minute/hour/day`);
  return { key, ...info };
}

export function normalizeShowType(value, fallback = 'auto') {
  const text = String(value || fallback).trim().toLowerCase();
  if (!SHOW_TYPES.includes(text)) throw new ConfigError(`showType 无效: ${value}；可选 auto/RTD/ZS`);
  return text;
}

function resolveShowTypeValue(value) {
  const text = String(value || '').trim().toUpperCase();
  if (text === 'RTD' || text === 'ZS') return text;
  throw new ConfigError(`showType 无效: ${value}`);
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function padDateTime(value, endOfDay) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value} ${endOfDay ? '23:59:59' : '00:00:00'}`;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value)) return `${value}:00`;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return value;
  throw new ConfigError(`时间格式无效: ${value}；应为 YYYY-MM-DD、YYYY-MM-DD HH:mm 或 YYYY-MM-DD HH:mm:ss`);
}

export function resolveDataRange({ type, date, startTime, endTime, now = new Date() } = {}) {
  const dataType = getDataType(type || 'realtime');
  const dayMode = dataType.key === 'day';
  if (date && (startTime || endTime)) throw new ConfigError('--date 不能与 --start/--end 同时使用');
  if ((startTime && !endTime) || (!startTime && endTime)) throw new ConfigError('--start 与 --end 必须同时提供');

  let start;
  let end;
  if (date) {
    const text = String(date).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new ConfigError(`日期格式无效: ${date}`);
    start = dayMode ? text : `${text} 00:00:00`;
    end = dayMode ? text : `${text} 23:59:59`;
  } else if (startTime && endTime) {
    if (dayMode) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startTime) || !/^\d{4}-\d{2}-\d{2}$/.test(endTime)) {
        throw new ConfigError('日数据模式要求 --start/--end 为 YYYY-MM-DD');
      }
      start = startTime;
      end = endTime;
    } else {
      start = padDateTime(String(startTime).trim(), false);
      end = padDateTime(String(endTime).trim(), true);
    }
  } else {
    const today = formatLocalDate(now);
    start = dayMode ? today : `${today} 00:00:00`;
    end = dayMode ? today : `${today} 23:59:59`;
  }

  if (start > end) throw new ConfigError(`起始时间晚于结束时间: ${start} > ${end}`);
  return { startTime: start, endTime: end, dataType };
}

export function readTokenCache(cachePath, { baseUrl, username } = {}) {
  if (!cachePath) return null;
  let cached;
  try {
    cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch {
    return null;
  }
  if (!cached || typeof cached.token !== 'string' || !cached.token.trim()) return null;
  if (baseUrl && cached.baseUrl && String(cached.baseUrl).replace(/\/+$/, '') !== String(baseUrl).replace(/\/+$/, '')) {
    return null;
  }
  if (username && cached.username && String(cached.username) !== String(username)) return null;
  return cached;
}

export function writeTokenCache(cachePath, { baseUrl, username, token, savedAt = new Date().toISOString() }) {
  if (!cachePath) return;
  if (!token) throw new ConfigError('拒绝缓存空 token');
  const directory = path.dirname(cachePath);
  fs.mkdirSync(directory, { recursive: true });
  const payload = { baseUrl, username, token, savedAt };
  fs.writeFileSync(cachePath, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
}

export function clearTokenCache(cachePath) {
  if (!cachePath) return;
  try {
    fs.rmSync(cachePath, { force: true });
  } catch {}
}

export function flattenStationTree(data) {
  const roots = Array.isArray(data) ? data : (data?.treeList || data?.children || []);
  const stations = [];

  function visit(node, ancestors) {
    if (!node) return;
    const children = normalizeChildren(node);
    const stationId = node.wryStationId || (Number(node.level) === 4 ? node.id : null);
    const name = cleanValue(node.label || node.name);
    const path = [...ancestors.map((item) => item.label), name].filter(Boolean);
    if (stationId) {
      stations.push({
        id: String(stationId),
        name: name || String(stationId),
        label: name,
        level: finiteNumberOrNull(node.level),
        parentId: ancestors.length ? String(ancestors.at(-1)?.id ?? '') || null : null,
        path,
        pathText: path.join(' / '),
        type: cleanValue(node.type),
        polluteTypeCode: cleanValue(node.polluteTypeCode),
        stationType: cleanValue(node.stationType),
        isMainEnter: node.isMainEnter === true || String(node.isMainEnter) === '1',
      });
    }
    const nextAncestors = [...ancestors, { id: node.id, label: name }];
    for (const child of children) visit(child, nextAncestors);
  }

  for (const root of roots) visit(root, []);
  return stations;
}

export function findStation(stations, query) {
  const text = String(query || '').trim();
  if (!text) throw new ConfigError('缺少 --station（点位名称或 ID）');
  const exact = stations.filter((station) => station.id === text || station.name === text);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new ConfigError(`点位名称不唯一: ${text}`);
  const lower = text.toLowerCase();
  const matches = stations.filter((station) => station.name.toLowerCase().includes(lower)
    || station.pathText.toLowerCase().includes(lower));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new ConfigError(`点位匹配不唯一: ${text}；候选项: ${matches.map((item) => item.name).join('、')}`);
  }
  throw new ConfigError(`未找到点位: ${text}`);
}

export function normalizeFactors(rawFactors) {
  if (!Array.isArray(rawFactors)) return [];
  return rawFactors.map((factor) => {
    const code = cleanValue(factor.factorCode);
    const children = normalizeChildren(factor).map((child) => ({
      flag: cleanValue(child.factorFlag),
      uploadCode: cleanValue(child.uploadCode),
      name: cleanValue(child.factorName),
      unit: cleanValue(child.factorUnit),
    }));
    return {
      code,
      name: cleanValue(factor.factorName) || code,
      unit: cleanValue(factor.factorUnit) || '',
      couUnit: cleanValue(factor.couUnit) || '',
      lowLimit: finiteNumberOrNull(factor.lowLimit),
      highLimit: finiteNumberOrNull(factor.upLimit),
      limitText: cleanValue(factor.upLowContent),
      isHeat: factor.isHeat === true || String(factor.isHeat) === '1',
      children,
    };
  }).filter((factor) => factor.code);
}

function inferFactorCodes(rawRows) {
  const codes = new Set();
  for (const row of rawRows) {
    for (const key of Object.keys(row || {})) {
      const match = /^(?:RTD|AVG)_(.+)$/.exec(key);
      if (match) codes.add(match[1]);
    }
  }
  return [...codes].map((code) => ({ code, name: code, unit: '', children: [] }));
}

export function normalizeRows(rawRows, { factors = [], type = 'realtime', showType = 'RTD' } = {}) {
  if (!Array.isArray(rawRows)) return [];
  const dataType = getDataType(type);
  const selectedShowType = resolveShowTypeValue(showType);
  const factorList = factors.length ? factors : inferFactorCodes(rawRows);
  const valuePrefix = dataType.key === 'realtime' ? 'RTD' : 'AVG';
  const zsPrefix = dataType.key === 'realtime' ? 'ZSRTD' : 'ZSAVG';

  return rawRows.map((raw) => {
    const values = {};
    for (const factor of factorList) {
      const code = factor.code;
      const metrics = {};
      for (const flag of STAT_FLAGS) {
        const value = cleanValue(raw[`${flag}_${code}`]);
        if (value != null) metrics[flag.toLowerCase()] = value;
      }
      const value = cleanValue(raw[`${valuePrefix}_${code}`]);
      const zsValue = cleanValue(raw[`${zsPrefix}_${code}`]);
      values[code] = {
        name: factor.name,
        unit: factor.unit,
        value,
        zsValue,
        displayValue: selectedShowType === 'ZS' && zsValue != null ? zsValue : value,
        flag: cleanValue(raw[`FLAG_${code}`]),
        manualFlag: cleanValue(raw[`MANUAL_FLAG_${code}`]),
        limit: factor.limitText || null,
        lowLimit: factor.lowLimit ?? null,
        highLimit: factor.highLimit ?? null,
        metrics,
      };
    }
    return {
      dt: cleanValue(raw.dt || raw.dataTime || raw.monitorTime),
      values,
    };
  });
}

export function rowsToCsv(rows) {
  if (!Array.isArray(rows) || !rows.length) return '数据时间\n';
  const codes = Object.keys(rows[0].values || {});
  const columns = [{ key: 'dt', label: '数据时间' }];
  for (const code of codes) {
    const info = rows[0].values[code];
    const base = `${info.name || code}(${code})`;
    columns.push({ key: `values.${code}.displayValue`, label: `${base}-当前值` });
    if (rows.some((row) => row.values?.[code]?.value != null)) {
      columns.push({ key: `values.${code}.value`, label: `${base}-实测值` });
    }
    if (rows.some((row) => row.values?.[code]?.zsValue != null)) {
      columns.push({ key: `values.${code}.zsValue`, label: `${base}-折算值` });
    }
    for (const [metric, label] of [['max', '最大值'], ['min', '最小值'], ['avg', '均值'], ['cou', '累计值']]) {
      if (rows.some((row) => row.values?.[code]?.metrics?.[metric] != null)) {
        columns.push({ key: `values.${code}.metrics.${metric}`, label: `${base}-${label}` });
      }
    }
    columns.push({ key: `values.${code}.flag`, label: `${base}-标记` });
    columns.push({ key: `values.${code}.manualFlag`, label: `${base}-人工标记` });
  }

  const get = (row, key) => key.split('.').reduce((value, part) => value?.[part], row);
  const escape = (value) => {
    const text = value == null ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const lines = [columns.map((column) => escape(column.label)).join(',')];
  for (const row of rows) lines.push(columns.map((column) => escape(get(row, column.key))).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

export function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const size = Math.max(1, Math.min(Number(limit) || 1, items.length));
  async function run() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  return Promise.all(Array.from({ length: size }, run)).then(() => results);
}

export class YiliClient {
  constructor({ config, transport, captchaSolver, sleep, now, random } = {}) {
    if (!config) throw new ConfigError('缺少 YiliClient 配置');
    this.config = config;
    this.transport = transport || createHttpsTransport({
      verifyTls: config.verifyTls,
      timeoutMs: config.requestTimeoutMs,
    });
    this.captchaSolver = captchaSolver || createCaptchaSolver({ modelPath: config.captchaModelPath });
    this.sleep = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = now || (() => new Date());
    this.random = random || Math.random;
    this.token = config.token || '';
    this.tokenSource = config.token ? 'environment' : null;
    this.user = null;
    this._loginPromise = null;
  }

  _buildUrl(apiPath, query) {
    const url = new URL(`${String(this.config.baseUrl).replace(/\/+$/, '')}${apiPath}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value != null) url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  async _sendWithRetry(url, options) {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await this.transport(url, options);
        if (response.status >= 500 && attempt < 3) {
          await this.sleep(250 * attempt);
          continue;
        }
        return response;
      } catch (error) {
        lastError = error;
        if (attempt >= 3) break;
        await this.sleep(250 * attempt);
      }
    }
    throw new ApiError(`请求失败: ${lastError?.message || '网络错误'}`, {
      kind: 'network',
      retryable: true,
      cause: lastError,
    });
  }

  _parseEnvelope(buffer, status, response) {
    const text = buffer.toString('utf8');
    if (!text.trim()) throw new ApiError(`接口返回空响应（HTTP ${status}）`, { status });
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      const contentType = response.headers.get('content-type') || '';
      throw new ApiError(`接口返回非 JSON（HTTP ${status}, ${contentType || 'unknown'}）`, {
        status,
        cause: error,
      });
    }
    if (!payload || typeof payload !== 'object') {
      throw new ApiError(`接口返回内容无效（HTTP ${status}）`, { status });
    }
    if (isAuthFailureCode(payload.code)) {
      throw new AuthError(payload.msg || '登录状态已失效', {
        status,
        details: { serverCode: payload.code },
      });
    }
    if (Number(payload.code) !== 200) {
      throw new ApiError(payload.msg || `接口返回 code=${payload.code}`, {
        status,
        retryable: status >= 500,
        details: { serverCode: payload.code },
      });
    }
    return payload;
  }

  async _requestEnvelope(apiPath, { body, token, query, method = 'POST' } = {}) {
    const headers = { Accept: 'application/json, text/plain, */*' };
    let requestBody = null;
    if (body !== undefined && body !== null) {
      headers['Content-Type'] = 'application/json';
      requestBody = typeof body === 'string' ? body : JSON.stringify(body);
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await this._sendWithRetry(this._buildUrl(apiPath, query), {
      method,
      headers,
      body: requestBody,
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (response.status === 401 || response.status === 403) {
      throw new AuthError(`接口鉴权失败（HTTP ${response.status}）`, { status: response.status });
    }
    if (response.status < 200 || response.status >= 300) {
      throw new ApiError(`接口请求失败（HTTP ${response.status}）`, {
        status: response.status,
        retryable: response.status >= 500,
      });
    }
    return this._parseEnvelope(buffer, response.status, response);
  }

  _dropToken({ clearCache = true } = {}) {
    this.token = '';
    this.tokenSource = null;
    this.user = null;
    if (clearCache && this.config.useTokenCache) clearTokenCache(this.config.tokenCachePath);
  }

  _loadCachedToken() {
    if (!this.config.useTokenCache || this.token) return;
    const cached = readTokenCache(this.config.tokenCachePath, {
      baseUrl: this.config.baseUrl,
      username: this.config.username,
    });
    if (cached) {
      this.token = cached.token.trim();
      this.tokenSource = 'cache';
    }
  }

  _reauth() {
    if (!this._loginPromise) {
      this._loginPromise = this.login().finally(() => {
        this._loginPromise = null;
      });
    }
    return this._loginPromise;
  }

  async _refreshAfterAuthFailure(failedToken) {
    if (this.token && this.token !== failedToken) return;
    if (this._loginPromise) {
      await this._loginPromise;
      return;
    }
    this._dropToken();
    await this._reauth();
  }

  async ensureToken() {
    if (this.token) return this.token;
    this._loadCachedToken();
    if (this.token) return this.token;
    if (!this.config.username || !this.config.password) {
      throw new AuthError('缺少登录凭据，无法建立伊犁平台会话');
    }
    await this._reauth();
    return this.token;
  }

  async _withAuthRetry(worker) {
    await this.ensureToken();
    const failedToken = this.token;
    try {
      return await worker(failedToken);
    } catch (error) {
      if (!(error instanceof AuthError) || !this.config.username || !this.config.password) throw error;
      await this._refreshAfterAuthFailure(failedToken);
      return worker(this.token);
    }
  }

  async fetchCaptcha() {
    const payload = await this._requestEnvelope(`${AUTH_PREFIX}/captchaImage`, { body: {} });
    if (!payload.uuid || !payload.img) throw new CaptchaError('验证码接口未返回 uuid 或图片');
    const base64 = String(payload.img).replace(/^data:image\/[^;]+;base64,/, '');
    let imageBuffer;
    try {
      imageBuffer = Buffer.from(base64, 'base64');
    } catch (error) {
      throw new CaptchaError(`验证码图片 Base64 无效: ${error.message}`, { cause: error });
    }
    if (!imageBuffer.length) throw new CaptchaError('验证码图片为空');
    return { uuid: String(payload.uuid), imageBuffer, imageBase64: base64 };
  }

  _classifyLoginFailure(error) {
    const message = String(error?.message || '登录失败');
    if (/验证码/.test(message)) {
      return new CaptchaError(message, { status: error?.status ?? null, cause: error });
    }
    if (/密码|帐号|账号|用户名|用户不存在|登录失败|登陆失败/.test(message)) {
      return new AuthError(message, { status: error?.status ?? null, cause: error });
    }
    return new AuthError(`登录失败: ${message}`, { status: error?.status ?? null, cause: error });
  }

  async _submitLogin(uuid, code) {
    const body = buildLoginBody({
      username: this.config.username,
      password: this.config.password,
      code,
      uuid,
      random: this.random,
    });
    let payload;
    try {
      payload = await this._requestEnvelope(`${AUTH_PREFIX}/login`, { body });
    } catch (error) {
      if (error instanceof CaptchaError) throw error;
      throw this._classifyLoginFailure(error);
    }
    const token = cleanValue(payload.token)?.replace(/^Bearer\s+/i, '');
    if (!token) throw new AuthError('登录接口成功响应中缺少 token');
    this.token = token;
    this.tokenSource = 'login';
    this.user = null;
    if (this.config.useTokenCache) {
      writeTokenCache(this.config.tokenCachePath, {
        baseUrl: this.config.baseUrl,
        username: this.config.username,
        token,
        savedAt: this.now().toISOString(),
      });
    }
    return token;
  }

  async login({ captchaCode, captchaUuid, maxAttempts } = {}) {
    if (!this.config.username || !this.config.password) throw new AuthError('缺少登录账号或密码');
    if ((captchaCode && !captchaUuid) || (!captchaCode && captchaUuid)) {
      throw new ConfigError('人工验证码必须同时提供验证码和 UUID');
    }
    const attempts = Math.max(1, Number(maxAttempts) || this.config.maxCaptchaAttempts || 4);
    if (captchaCode) {
      const token = await this._submitLogin(captchaUuid, captchaCode);
      return { token, attempts: 1, manual: true };
    }

    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const challenge = await this.fetchCaptcha();
      let solved;
      try {
        solved = this.captchaSolver.solve(challenge.imageBuffer);
      } catch (error) {
        if (error instanceof ConfigError || error instanceof CaptchaError) throw error;
        throw new CaptchaError(`验证码识别失败: ${error.message}`, { cause: error });
      }
      try {
        const token = await this._submitLogin(challenge.uuid, solved.answer);
        return { token, attempts: attempt, expression: solved.expression, answer: solved.answer };
      } catch (error) {
        if (!(error instanceof CaptchaError)) throw error;
        lastError = error;
        if (attempt < attempts) await this.sleep(200 * attempt);
      }
    }
    throw new CaptchaError(`验证码识别连续失败 ${attempts} 次: ${lastError?.message || '未知错误'}`, {
      cause: lastError,
    });
  }

  async loginWithChallenge({ uuid, code }) {
    const token = await this._submitLogin(uuid, code);
    return { token };
  }

  async getUserInfo() {
    const payload = await this._withAuthRetry((token) => this._requestEnvelope(`${AUTH_PREFIX}/getUserInfo`, {
      token,
    }));
    this.user = payload.user || null;
    return this.user;
  }

  async getStations() {
    const payload = await this._withAuthRetry((token) => this._requestEnvelope(
      `${API_PREFIX}/system/wryStation/leftTreeWryStation`,
      { token, body: {} },
    ));
    return flattenStationTree(payload.data);
  }

  async getFactors(stationId, type = 'realtime') {
    if (!stationId) throw new ConfigError('缺少点位 ID');
    const dataType = getDataType(type);
    const payload = await this._withAuthRetry((token) => this._requestEnvelope(
      `${API_PREFIX}/system/wryStationData/tableTitle`,
      { token, body: { stationId, cnType: dataType.cnType } },
    ));
    return normalizeFactors(payload.data);
  }

  async stationHasZs(stationId, type = 'realtime') {
    if (!stationId) throw new ConfigError('缺少点位 ID');
    const dataType = getDataType(type);
    const payload = await this._withAuthRetry((token) => this._requestEnvelope(
      `${API_PREFIX}/system/wryStationData/stationHasZs`,
      {
        token,
        body: { cnType: dataType.cnType, wryStationId: stationId, showType: 'ZS' },
      },
    ));
    return payload.data === true || String(payload.data).toLowerCase() === 'true';
  }

  async resolveShowType(stationId, type = 'realtime', requested = 'auto') {
    const normalized = normalizeShowType(requested);
    if (normalized !== 'auto') return normalized.toUpperCase();
    return (await this.stationHasZs(stationId, type)) ? 'ZS' : 'RTD';
  }

  async fetchDataPage({ stationId, type = 'realtime', showType = 'RTD', startTime, endTime, pageNum = 1, pageSize }) {
    if (!stationId) throw new ConfigError('缺少点位 ID');
    if (!startTime || !endTime) throw new ConfigError('缺少查询起始/结束时间');
    const dataType = getDataType(type);
    const page = Number(pageNum);
    const size = Number(pageSize ?? this.config.defaultPageSize);
    if (!Number.isInteger(page) || page < 1) throw new ConfigError(`页码无效: ${pageNum}`);
    if (!Number.isInteger(size) || size < 1 || size > 5000) throw new ConfigError(`pageSize 必须在 1..5000: ${pageSize}`);
    const selectedShowType = resolveShowTypeValue(showType);
    const body = {
      startTime,
      endTime,
      stationId,
      cnType: dataType.cnType,
      showType: selectedShowType,
      pageNum: page,
      pageSize: size,
    };
    const payload = await this._withAuthRetry((token) => this._requestEnvelope(
      `${API_PREFIX}/system/wryStationData/dataQuery`,
      { token, body, query: { pageNum: page, pageSize: size } },
    ));
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    const total = Number(payload.total ?? 0);
    if (!Number.isFinite(total) || total < 0 || !Number.isInteger(total)) {
      throw new DataIncompleteError(`dataQuery total 无效: ${payload.total}`, {
        details: { pageNum: page, total: payload.total },
      });
    }
    return { rows, total, pageNum: page, pageSize: size };
  }

  _assertPageComplete(pageData, total, pageSize) {
    const expected = Math.max(0, Math.min(pageSize, total - (pageData.pageNum - 1) * pageSize));
    if (pageData.rows.length !== expected) {
      throw new DataIncompleteError(
        `分页不完整：第 ${pageData.pageNum} 页应有 ${expected} 行，实际 ${pageData.rows.length} 行`,
        {
          details: {
            pageNum: pageData.pageNum,
            pageSize,
            total,
            expected,
            actual: pageData.rows.length,
          },
        },
      );
    }
  }

  async fetchAllRows({
    stationId,
    type = 'realtime',
    showType = 'RTD',
    startTime,
    endTime,
    pageSize = this.config.defaultPageSize,
    maxPages = this.config.maxPages,
    concurrency = this.config.concurrency,
    ensureUniqueDt = true,
  }) {
    const size = Number(pageSize);
    if (!Number.isInteger(size) || size < 1 || size > 5000) throw new ConfigError(`pageSize 必须在 1..5000: ${pageSize}`);
    const first = await this.fetchDataPage({
      stationId, type, showType, startTime, endTime, pageNum: 1, pageSize: size,
    });
    const total = first.total;
    const pageCount = total === 0 ? 0 : Math.ceil(total / size);
    const pageLimit = Number(maxPages);
    if (!Number.isInteger(pageLimit) || pageLimit < 1) throw new ConfigError(`maxPages 无效: ${maxPages}`);
    if (pageCount > pageLimit) {
      throw new DataIncompleteError(`数据共 ${total} 行、需 ${pageCount} 页，超过上限 ${pageLimit} 页`, {
        details: { total, pageCount, maxPages: pageLimit, pageSize: size },
      });
    }
    this._assertPageComplete(first, total, size);

    const pageNumbers = [];
    for (let page = 2; page <= pageCount; page++) pageNumbers.push(page);
    const remaining = await mapLimit(pageNumbers, concurrency, (page) => this.fetchDataPage({
      stationId, type, showType, startTime, endTime, pageNum: page, pageSize: size,
    }));
    for (const pageData of remaining) this._assertPageComplete(pageData, total, size);

    const rows = [first, ...remaining]
      .flatMap((pageData) => pageData.rows)
      .sort((left, right) => String(left.dt || '').localeCompare(String(right.dt || '')));
    if (rows.length !== total) {
      throw new DataIncompleteError(`数据行数不完整：应有 ${total} 行，实际 ${rows.length} 行`, {
        details: { total, actual: rows.length, pageCount, pageSize: size },
      });
    }
    if (ensureUniqueDt) {
      const seen = new Set();
      for (const row of rows) {
        const dt = cleanValue(row.dt);
        if (!dt) continue;
        if (seen.has(dt)) {
          throw new DataIncompleteError(`分页数据出现重复时间: ${dt}`, {
            details: { total, actual: rows.length, duplicate: dt },
          });
        }
        seen.add(dt);
      }
    }
    return { rows, total, pageCount, pageSize: size };
  }

  async query({
    station,
    stationId,
    type = 'realtime',
    date,
    startTime,
    endTime,
    showType = 'auto',
    pageSize = this.config.defaultPageSize,
    maxPages = this.config.maxPages,
    concurrency = this.config.concurrency,
    ensureUniqueDt = true,
  } = {}) {
    const id = String(stationId || station?.id || '').trim();
    if (!id) throw new ConfigError('缺少查询点位');
    const range = resolveDataRange({ type, date, startTime, endTime, now: this.now() });
    const selectedShowType = await this.resolveShowType(id, range.dataType.key, showType);
    const factors = await this.getFactors(id, range.dataType.key);
    const result = await this.fetchAllRows({
      stationId: id,
      type: range.dataType.key,
      showType: selectedShowType,
      startTime: range.startTime,
      endTime: range.endTime,
      pageSize,
      maxPages,
      concurrency,
      ensureUniqueDt,
    });
    return {
      station: station || { id, name: id },
      dataType: range.dataType.key,
      dataTypeLabel: range.dataType.label,
      cnType: range.dataType.cnType,
      startTime: range.startTime,
      endTime: range.endTime,
      showType: selectedShowType,
      pageSize: result.pageSize,
      pageCount: result.pageCount,
      total: result.total,
      factors,
      rows: normalizeRows(result.rows, {
        factors,
        type: range.dataType.key,
        showType: selectedShowType,
      }),
    };
  }

  async _requestBinary(apiPath, { body, token, query } = {}) {
    const headers = {
      Accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/octet-stream, application/json',
      'Content-Type': 'application/json',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await this._sendWithRetry(this._buildUrl(apiPath, query), {
      method: 'POST',
      headers,
      body: JSON.stringify(body ?? {}),
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (response.status === 401 || response.status === 403) {
      throw new AuthError(`接口鉴权失败（HTTP ${response.status}）`, { status: response.status });
    }
    if (response.status < 200 || response.status >= 300) {
      throw new ApiError(`导出请求失败（HTTP ${response.status}）`, { status: response.status });
    }
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('json') || buffer[0] === 0x7b) {
      const payload = this._parseEnvelope(buffer, response.status, response);
      if (typeof payload.data === 'string' && payload.data.length > 32) {
        return {
          buffer: Buffer.from(payload.data.replace(/^data:[^;]+;base64,/, ''), 'base64'),
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          filename: null,
        };
      }
      throw new ApiError('导出接口返回 JSON，但未包含文件内容');
    }
    return {
      buffer,
      contentType,
      filename: response.headers.get('content-disposition') || null,
    };
  }

  async exportXlsx({
    station,
    stationId,
    type = 'realtime',
    date,
    startTime,
    endTime,
    showType = 'auto',
    fileName,
  } = {}) {
    const id = String(stationId || station?.id || '').trim();
    if (!id) throw new ConfigError('缺少导出点位');
    const range = resolveDataRange({ type, date, startTime, endTime, now: this.now() });
    const selectedShowType = await this.resolveShowType(id, range.dataType.key, showType);
    const generatedName = `${station?.name || id}_${range.startTime.replace(/[^\d]/g, '')}_${range.dataType.label}`
      .replace(/[\\/:*?"<>|]/g, '_');
    const result = await this._withAuthRetry((token) => this._requestBinary(
      `${API_PREFIX}/system/wryStationData/dataQueryExport`,
      {
        token,
        body: {
          startTime: range.startTime,
          endTime: range.endTime,
          stationId: id,
          cnType: range.dataType.cnType,
          showType: selectedShowType,
          fileName: fileName || generatedName,
        },
      },
    ));
    return {
      ...result,
      station: station || { id, name: id },
      type: range.dataType.key,
      startTime: range.startTime,
      endTime: range.endTime,
      showType: selectedShowType,
    };
  }
}
