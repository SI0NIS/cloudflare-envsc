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

export { TZ_OFFSET, sleep, ymd, d1Str };
