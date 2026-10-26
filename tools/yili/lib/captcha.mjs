import fs from 'node:fs';
import jpeg from 'jpeg-js';
import { CaptchaError, ConfigError } from './errors.mjs';

const PART_ORDER = ['left', 'operator', 'right'];
const PART_ALIASES = {
  left: ['left', 'a'],
  operator: ['operator', 'op'],
  right: ['right', 'b'],
};
const BOX_ALIASES = {
  left: ['left', 'a'],
  operator: ['operator', 'op'],
  right: ['right', 'b'],
};
const DEFAULT_BOXES = {
  left: [16, 7, 46, 43],
  operator: [46, 3, 76, 47],
  right: [66, 7, 92, 43],
};
const DEFAULT_CLASSES = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '+', '-', '*', '/'];
const MODEL_CACHE = new Map();

function firstDefined(object, keys) {
  for (const key of keys) {
    if (object && object[key] !== undefined) return object[key];
  }
  return undefined;
}

function readFeatureSize(model) {
  const feature = model?.feature;
  if (!Array.isArray(feature) || feature.length !== 2) return [16, 24];
  const width = Number(feature[0]);
  const height = Number(feature[1]);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) {
    throw new ConfigError(`验证码模型 feature 无效: ${JSON.stringify(feature)}`);
  }
  return [width, height];
}

function normalizeModel(model) {
  if (!model || typeof model !== 'object') throw new ConfigError('验证码模型为空');
  if (!model.prototypes || typeof model.prototypes !== 'object') {
    throw new ConfigError('验证码模型缺少 prototypes');
  }

  const [width, height] = readFeatureSize(model);
  const classes = Array.isArray(model.classes) && model.classes.length
    ? model.classes.map(String)
    : DEFAULT_CLASSES.slice();
  const expectedSize = width * height;
  const prototypes = {};
  const boxes = {};

  for (const part of PART_ORDER) {
    const raw = firstDefined(model.prototypes, PART_ALIASES[part]);
    if (!raw || !Array.isArray(raw.labels) || typeof raw.data !== 'string') {
      throw new ConfigError(`验证码模型缺少 ${part} 原型`);
    }

    const labels = raw.labels.map((label) => {
      if (typeof label === 'number') {
        const value = classes[label];
        if (value === undefined) throw new ConfigError(`验证码模型 ${part} 标签越界: ${label}`);
        return value;
      }
      return String(label);
    });
    const data = Buffer.from(raw.data, 'base64');
    if (data.length !== labels.length * expectedSize) {
      throw new ConfigError(
        `验证码模型 ${part} 数据长度不符: ${data.length} != ${labels.length} x ${expectedSize}`,
      );
    }

    const rawBox = firstDefined(model.boxes, BOX_ALIASES[part]) || DEFAULT_BOXES[part];
    if (!Array.isArray(rawBox) || rawBox.length !== 4) {
      throw new ConfigError(`验证码模型 ${part} 字符区域无效`);
    }

    prototypes[part] = {
      labels,
      data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      count: labels.length,
    };
    boxes[part] = rawBox.map(Number);
  }

  return {
    version: model.version ?? 1,
    featureWidth: width,
    featureHeight: height,
    classes,
    boxes,
    prototypes,
  };
}

export function evaluateExpression(expression) {
  const text = String(expression ?? '').replace(/\s+/g, '');
  const match = /^([0-9])([+\-*/])([0-9])$/.exec(text);
  if (!match) throw new CaptchaError(`验证码表达式无效: ${text || '(空)'}`);

  const left = Number(match[1]);
  const operator = match[2];
  const right = Number(match[3]);
  let answer;
  if (operator === '+') answer = left + right;
  else if (operator === '-') answer = left - right;
  else if (operator === '*') answer = left * right;
  else {
    if (right === 0) throw new CaptchaError('验证码表达式除数为 0');
    answer = left / right;
  }
  if (!Number.isFinite(answer)) throw new CaptchaError(`验证码表达式无法计算: ${text}`);
  return answer;
}

export function decodeCaptchaImage(imageBuffer) {
  if (!imageBuffer || !imageBuffer.length) throw new CaptchaError('验证码图片为空');
  let decoded;
  try {
    decoded = jpeg.decode(imageBuffer, { useTArray: true, formatAsRGBA: false });
  } catch (error) {
    throw new CaptchaError(`验证码图片解码失败: ${error.message}`, { cause: error });
  }

  const width = Number(decoded.width);
  const height = Number(decoded.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) {
    throw new CaptchaError('验证码图片尺寸无效');
  }

  const channels = decoded.data.length / (width * height);
  if (channels !== 3 && channels !== 4) throw new CaptchaError('验证码图片像素格式无效');
  const scores = new Float32Array(width * height);
  for (let pixel = 0, offset = 0; pixel < scores.length; pixel++, offset += channels) {
    const red = decoded.data[offset];
    const green = decoded.data[offset + 1];
    const blue = decoded.data[offset + 2];
    scores[pixel] = Math.max(0, Math.min(255, blue - (red + green) / 2));
  }
  return { width, height, scores };
}

export function extractCaptchaFeature(image, box, width = 16, height = 24) {
  if (!image?.scores || !image.width || !image.height) throw new CaptchaError('验证码图像未解码');
  if (!Array.isArray(box) || box.length !== 4) throw new CaptchaError('验证码字符区域无效');
  const [x0, y0, x1, y1] = box.map(Number);
  const boxWidth = x1 - x0;
  const boxHeight = y1 - y0;
  if (!(boxWidth > 0 && boxHeight > 0)) throw new CaptchaError('验证码字符区域尺寸无效');

  const values = new Float32Array(width * height);
  let index = 0;
  for (let outputY = 0; outputY < height; outputY++) {
    const sourceY = y0 + ((outputY + 0.5) * boxHeight) / height - 0.5;
    const clampedY = Math.max(0, Math.min(image.height - 2, sourceY));
    const y = Math.floor(clampedY);
    const fy = clampedY - y;
    for (let outputX = 0; outputX < width; outputX++) {
      const sourceX = x0 + ((outputX + 0.5) * boxWidth) / width - 0.5;
      const clampedX = Math.max(0, Math.min(image.width - 2, sourceX));
      const x = Math.floor(clampedX);
      const fx = clampedX - x;
      const p00 = image.scores[y * image.width + x];
      const p10 = image.scores[y * image.width + x + 1];
      const p01 = image.scores[(y + 1) * image.width + x];
      const p11 = image.scores[(y + 1) * image.width + x + 1];
      values[index++] = (p00 * (1 - fx) + p10 * fx) * (1 - fy)
        + (p01 * (1 - fx) + p11 * fx) * fy;
    }
  }

  let norm = 0;
  for (const value of values) norm += value * value;
  norm = Math.sqrt(norm);
  const feature = new Uint8Array(values.length);
  if (norm > 0) {
    for (let i = 0; i < values.length; i++) {
      feature[i] = Math.max(0, Math.min(255, Math.round((values[i] / norm) * 255)));
    }
  }
  return feature;
}

function classifyFeature(feature, prototype, featureSize) {
  const { labels, data, count } = prototype;
  let bestIndex = -1;
  let bestDistance = Infinity;
  let secondDistance = Infinity;
  for (let sample = 0; sample < count; sample++) {
    const offset = sample * featureSize;
    let distance = 0;
    for (let i = 0; i < featureSize; i++) {
      const delta = feature[i] - data[offset + i];
      distance += delta * delta;
    }
    if (distance < bestDistance) {
      secondDistance = bestDistance;
      bestDistance = distance;
      bestIndex = sample;
    } else if (distance < secondDistance) {
      secondDistance = distance;
    }
  }
  if (bestIndex < 0) throw new CaptchaError('验证码原型为空');

  const confidence = Number.isFinite(secondDistance) && secondDistance > 0
    ? Math.max(0, Math.min(1, (secondDistance - bestDistance) / secondDistance))
    : 1;
  return { char: labels[bestIndex], distance: bestDistance, confidence };
}

export function solveCaptchaImage(imageBuffer, model) {
  const normalized = model?.prototypes?.left?.data instanceof Uint8Array ? model : normalizeModel(model);
  const image = decodeCaptchaImage(imageBuffer);
  const featureSize = normalized.featureWidth * normalized.featureHeight;
  const parts = {};

  for (const part of PART_ORDER) {
    const feature = extractCaptchaFeature(
      image,
      normalized.boxes[part],
      normalized.featureWidth,
      normalized.featureHeight,
    );
    parts[part] = classifyFeature(feature, normalized.prototypes[part], featureSize);
  }

  const expression = parts.left.char + parts.operator.char + parts.right.char;
  const answer = evaluateExpression(expression);
  return {
    expression,
    answer: String(answer),
    parts,
  };
}

export function loadCaptchaModel(modelPath) {
  let stat;
  try {
    stat = fs.statSync(modelPath);
  } catch (error) {
    throw new ConfigError(`找不到验证码模型: ${modelPath}`, { cause: error });
  }
  const cacheKey = `${modelPath}:${stat.size}:${stat.mtimeMs}`;
  if (MODEL_CACHE.has(cacheKey)) return MODEL_CACHE.get(cacheKey);

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
  } catch (error) {
    throw new ConfigError(`无法读取验证码模型 ${modelPath}: ${error.message}`, { cause: error });
  }
  const model = normalizeModel(parsed);
  MODEL_CACHE.set(cacheKey, model);
  return model;
}

export function createCaptchaSolver({ modelPath, model } = {}) {
  let loaded = model ? normalizeModel(model) : null;
  return {
    solve(imageBuffer) {
      if (!loaded) {
        if (!modelPath) throw new ConfigError('未配置验证码模型路径');
        loaded = loadCaptchaModel(modelPath);
      }
      return solveCaptchaImage(imageBuffer, loaded);
    },
  };
}

export { DEFAULT_BOXES, DEFAULT_CLASSES, PART_ORDER };
