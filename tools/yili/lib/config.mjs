import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError } from './errors.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const YILI_DIR = path.resolve(HERE, '..');

export function parseBoolean(value, fallback = false) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
}

export function parseInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

function readLocalConfig(configPath) {
  if (!configPath || !fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new ConfigError(`无法读取本地配置 ${configPath}: ${error.message}`, { cause: error });
  }
}

export function loadConfig({ env = process.env, configPath } = {}) {
  const resolvedConfigPath = configPath
    ? path.resolve(configPath)
    : path.join(YILI_DIR, 'local-config.json');
  const file = readLocalConfig(resolvedConfigPath);

  const tokenCachePath = env.YILI_TOKEN_CACHE
    ? path.resolve(env.YILI_TOKEN_CACHE)
    : path.join(YILI_DIR, 'runtime', 'token.json');

  return {
    baseUrl: String(env.YILI_BASE_URL || file.baseUrl || 'https://yili.wanweitech.cn:58298').replace(/\/+$/, ''),
    username: env.YILI_USERNAME || file.username || '',
    password: env.YILI_PASSWORD || file.password || '',
    token: env.YILI_TOKEN || file.token || '',
    verifyTls: parseBoolean(env.YILI_VERIFY_TLS, parseBoolean(file.verifyTls, false)),
    maxCaptchaAttempts: parseInteger(env.YILI_CAPTCHA_ATTEMPTS, parseInteger(file.maxCaptchaAttempts, 4, { min: 1, max: 8 }), { min: 1, max: 8 }),
    defaultPageSize: parseInteger(env.YILI_PAGE_SIZE, parseInteger(file.pageSize, 2000, { min: 10, max: 5000 }), { min: 10, max: 5000 }),
    maxPages: parseInteger(env.YILI_MAX_PAGES, parseInteger(file.maxPages, 50, { min: 1, max: 500 }), { min: 1, max: 500 }),
    concurrency: parseInteger(env.YILI_CONCURRENCY, parseInteger(file.concurrency, 3, { min: 1, max: 8 }), { min: 1, max: 8 }),
    requestTimeoutMs: parseInteger(env.YILI_TIMEOUT_MS, parseInteger(file.requestTimeoutMs, 30000, { min: 1000, max: 120000 }), { min: 1000, max: 120000 }),
    tokenCachePath,
    useTokenCache: !parseBoolean(env.YILI_NO_TOKEN_CACHE, parseBoolean(file.noTokenCache, false)),
    captchaModelPath: file.captchaModelPath
      ? path.resolve(YILI_DIR, file.captchaModelPath)
      : path.join(YILI_DIR, 'captcha-model.json'),
    configPath: resolvedConfigPath,
  };
}

export function assertCredentials(config) {
  if (!config.token && (!config.username || !config.password)) {
    throw new ConfigError('缺少伊犁平台凭据：请设置 YILI_USERNAME / YILI_PASSWORD，或创建 tools/yili/local-config.json；也可用 YILI_TOKEN 复用现有会话');
  }
}

export function redactConfig(config) {
  return {
    baseUrl: config.baseUrl,
    username: config.username ? `${String(config.username).slice(0, 2)}***` : '',
    hasPassword: !!config.password,
    hasToken: !!config.token,
    verifyTls: config.verifyTls,
    maxCaptchaAttempts: config.maxCaptchaAttempts,
    defaultPageSize: config.defaultPageSize,
    maxPages: config.maxPages,
    concurrency: config.concurrency,
  };
}

export { YILI_DIR };
