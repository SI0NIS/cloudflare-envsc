// core/time.js —— 日期与时间工具（Worker 运行环境是 UTC，必须显式按 UTC+8 计算 D-1）
const TZ_OFFSET = 8 * 3600 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ymd(d) {
  const t = new Date(d.getTime() + TZ_OFFSET);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

function d1Str() {
  const now = new Date();
  const t = new Date(now.getTime() + TZ_OFFSET);
  t.setUTCDate(t.getUTCDate() - 1);
  return ymd(new Date(t.getTime() - TZ_OFFSET));
}

function isDay(day) {
  const s = String(day || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function addDays(day, delta) {
  if (!isDay(day) || !Number.isInteger(delta)) throw new Error(`非法日期/偏移: ${day} ${delta}`);
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// 闭区间 [start, end]；上限 10 年，避免配置错误时无限循环。
function datesBetween(start, end) {
  if (!isDay(start) || !isDay(end) || start > end) return [];
  const out = [];
  let cur = start;
  while (cur <= end && out.length < 3660) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

export { TZ_OFFSET, sleep, ymd, d1Str, isDay, addDays, datesBetween };
