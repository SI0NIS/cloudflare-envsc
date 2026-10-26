#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, parseInteger, redactConfig, YILI_DIR } from './lib/config.mjs';
import {
  YiliClient,
  findStation,
  getDataType,
  normalizeShowType,
  rowsToCsv,
} from './lib/client.mjs';
import { ConfigError, YiliError } from './lib/errors.mjs';

const RUNTIME_DIR = path.join(YILI_DIR, 'runtime');
const CHALLENGE_PATH = path.join(RUNTIME_DIR, 'captcha.json');
const CAPTCHA_MAX_AGE_MS = 5 * 60 * 1000;

const HELP = `伊犁州生态环境数字化监控平台数据采集

用法:
  node tools/yili/cli.mjs stations [--format json|csv] [--output 文件]
  node tools/yili/cli.mjs factors --station <名称或ID> [--type realtime|minute|hour|day]
  node tools/yili/cli.mjs query --station <名称或ID> --type <类型> --date YYYY-MM-DD
  node tools/yili/cli.mjs query --station <名称或ID> --start "YYYY-MM-DD HH:mm:ss" --end "YYYY-MM-DD HH:mm:ss"
  node tools/yili/cli.mjs captcha [--output 验证码.jpg]
  node tools/yili/cli.mjs auth

查询选项:
  --type realtime|minute|hour|day  默认 realtime
  --date YYYY-MM-DD               默认今天
  --start / --end                 自定义时间范围
  --show-type auto|RTD|ZS         默认 auto（支持则取 ZS 折算值）
  --format json|csv|xlsx          默认按 --output 扩展名推断，否则 json
  --output <文件|->               输出文件；- 表示标准输出
  --page-size <1..5000>           默认读取 YILI_PAGE_SIZE 或 2000
  --no-unique-dt                  不检查时间是否唯一
  --captcha <答案>                使用 captcha 命令保存的人工验证码

环境变量:
  YILI_USERNAME / YILI_PASSWORD / YILI_TOKEN
  YILI_BASE_URL / YILI_VERIFY_TLS / YILI_TOKEN_CACHE / YILI_PAGE_SIZE
`;

function toCamelCase(name) {
  return name.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function parseArgs(argv) {
  const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'help';
  const start = command === 'help' ? 0 : 1;
  const options = {};
  const positional = [];
  for (let i = start; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const equalIndex = token.indexOf('=');
    const rawName = equalIndex >= 0 ? token.slice(2, equalIndex) : token.slice(2);
    const name = toCamelCase(rawName);
    if (equalIndex >= 0) {
      options[name] = token.slice(equalIndex + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      options[name] = argv[++i];
    } else {
      options[name] = true;
    }
  }
  options._ = positional;
  return { command, options };
}

function writeText(text, outputPath) {
  if (!outputPath || outputPath === '-') {
    process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
    return;
  }
  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, text, 'utf8');
  process.stdout.write(`${resolved}\n`);
}

function writeBinary(buffer, outputPath) {
  if (!outputPath || outputPath === '-') throw new ConfigError('XLSX 输出必须指定 --output 文件');
  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, buffer);
  process.stdout.write(`${resolved}\n`);
}

function resolveFormat(options, fallback = 'json') {
  const explicit = options.format ? String(options.format).toLowerCase() : '';
  if (explicit) {
    if (!['json', 'csv', 'xlsx'].includes(explicit)) throw new ConfigError(`输出格式无效: ${options.format}`);
    return explicit;
  }
  const extension = path.extname(String(options.output || '')).toLowerCase();
  if (extension === '.json') return 'json';
  if (extension === '.csv') return 'csv';
  if (extension === '.xlsx') return 'xlsx';
  return fallback;
}

function jsonText(value, compact = false) {
  return JSON.stringify(value, null, compact ? 0 : 2);
}

function objectsToCsv(rows) {
  if (!rows.length) return '\n';
  const headers = Object.keys(rows[0]);
  const escape = (value) => {
    const text = value == null ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map((header) => escape(row[header])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

function parsePageSize(value, fallback) {
  const parsed = parseInteger(value, fallback, { min: 1, max: 5000 });
  if (value != null && parsed !== Number(value)) throw new ConfigError(`pageSize 必须在 1..5000: ${value}`);
  return parsed;
}

function saveChallenge(challenge, outputPath) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const imagePath = path.resolve(outputPath || path.join(RUNTIME_DIR, `captcha-${Date.now()}.jpg`));
  fs.mkdirSync(path.dirname(imagePath), { recursive: true });
  fs.writeFileSync(imagePath, challenge.imageBuffer);
  const saved = { uuid: challenge.uuid, imagePath, createdAt: new Date().toISOString() };
  fs.writeFileSync(CHALLENGE_PATH, JSON.stringify(saved), { encoding: 'utf8', mode: 0o600 });
  return saved;
}

function readChallenge() {
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(CHALLENGE_PATH, 'utf8'));
  } catch {
    throw new ConfigError('没有待用验证码，请先运行 node tools/yili/cli.mjs captcha');
  }
  const age = Date.now() - new Date(saved.createdAt).getTime();
  if (!saved.uuid || !Number.isFinite(age) || age > CAPTCHA_MAX_AGE_MS) {
    throw new ConfigError('待用验证码已过期，请重新运行 captcha 命令');
  }
  return saved;
}

async function ensureSession(client, options) {
  if (options.captcha) {
    if (options.captcha === true) throw new ConfigError('--captcha 后必须提供验证码答案');
    const challenge = options.captchaUuid
      ? { uuid: options.captchaUuid }
      : readChallenge();
    await client.loginWithChallenge({ uuid: challenge.uuid, code: options.captcha });
    return;
  }
  await client.ensureToken();
}

async function resolveStation(client, query) {
  const stations = await client.getStations();
  return { stations, station: findStation(stations, query) };
}

function queryOptions(options, config) {
  const pageSize = parsePageSize(options.pageSize, config.defaultPageSize);
  const maxPages = parseInteger(options.maxPages, config.maxPages, { min: 1, max: 500 });
  const concurrency = parseInteger(options.concurrency, config.concurrency, { min: 1, max: 8 });
  return {
    type: options.type || 'realtime',
    date: options.date,
    startTime: options.start,
    endTime: options.end,
    showType: normalizeShowType(options.showType || 'auto'),
    pageSize,
    maxPages,
    concurrency,
    ensureUniqueDt: options.noUniqueDt !== true,
  };
}

async function commandStations(client, options) {
  const stations = await client.getStations();
  const format = resolveFormat(options);
  if (format === 'xlsx') throw new ConfigError('stations 仅支持 json/csv');
  const output = format === 'csv'
    ? objectsToCsv(stations.map(({ id, name, pathText, type, polluteTypeCode, stationType }) => ({
      id, name, path: pathText, type, polluteTypeCode, stationType,
    })))
    : jsonText(stations);
  writeText(output, options.output);
}

async function commandFactors(client, options, config) {
  const query = options.station || options._[0];
  const { station } = await resolveStation(client, query);
  const type = options.type || 'realtime';
  const dataType = getDataType(type);
  const factors = await client.getFactors(station.id, type);
  const result = { station, dataType: dataType.key, cnType: dataType.cnType, factors };
  const format = resolveFormat(options);
  if (format === 'xlsx') throw new ConfigError('factors 仅支持 json/csv');
  const output = format === 'csv'
    ? objectsToCsv(factors.map(({ code, name, unit, lowLimit, highLimit, limitText }) => ({
      code, name, unit, lowLimit, highLimit, limit: limitText,
    })))
    : jsonText(result);
  writeText(output, options.output);
}

async function commandQuery(client, options, config, forceXlsx = false) {
  const query = options.station || options._[0];
  const { station } = await resolveStation(client, query);
  const format = forceXlsx ? 'xlsx' : resolveFormat(options);
  const common = queryOptions(options, config);
  if (format === 'xlsx') {
    const exported = await client.exportXlsx({
      station,
      ...common,
      fileName: options.fileName,
    });
    writeBinary(exported.buffer, options.output);
    return;
  }
  const result = await client.query({ station, ...common });
  if (format === 'csv') writeText(rowsToCsv(result.rows), options.output);
  else writeText(jsonText(result, options.compact === true), options.output);
}

async function commandCaptcha(client, options) {
  const challenge = await client.fetchCaptcha();
  const saved = saveChallenge(challenge, options.output);
  writeText(jsonText({
    imagePath: saved.imagePath,
    expiresInSeconds: Math.floor(CAPTCHA_MAX_AGE_MS / 1000),
    next: '查看图片后运行查询，并追加 --captcha <计算结果>',
  }));
}

async function commandAuth(client, options) {
  const user = await client.getUserInfo();
  const result = {
    userId: user?.userId ?? null,
    userName: user?.userName ?? null,
    nickName: user?.nickName ?? null,
    deptName: user?.dept?.deptName ?? null,
    roles: user?.roles?.map((role) => role.roleName).filter(Boolean) || [],
    tokenSource: client.tokenSource,
  };
  writeText(jsonText(result, options.compact === true), options.output);
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (options.help || command === 'help') {
    process.stdout.write(HELP);
    return;
  }
  const config = loadConfig();
  const client = new YiliClient({ config });

  if (command === 'config') {
    writeText(jsonText(redactConfig(config)));
    return;
  }
  if (command === 'captcha') {
    await commandCaptcha(client, options);
    return;
  }
  if (['stations', 'factors', 'query', 'export', 'auth'].includes(command)) {
    await ensureSession(client, options);
  }

  if (command === 'stations') await commandStations(client, options);
  else if (command === 'factors') await commandFactors(client, options, config);
  else if (command === 'query') await commandQuery(client, options, config);
  else if (command === 'export') await commandQuery(client, options, config, true);
  else if (command === 'auth') await commandAuth(client, options);
  else throw new ConfigError(`未知命令: ${command}\n\n${HELP}`);
}

main().catch((error) => {
  const prefix = error instanceof YiliError ? error.code : 'ERROR';
  process.stderr.write(`${prefix}: ${error.message}\n`);
  if (error instanceof YiliError && error.details) {
    process.stderr.write(`${JSON.stringify(error.details)}\n`);
  }
  if (process.env.YILI_DEBUG && error.stack) process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
