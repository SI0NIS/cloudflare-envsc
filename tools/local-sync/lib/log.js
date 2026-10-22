// lib/log.js —— local-sync 共享日志：带大小轮转的逐行追加日志
// 规则：单文件超过 MAX_BYTES 时轮转为 <name>.1/.2/.3（保留 3 份历史），写满最旧丢弃。
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 1024 * 1024; // 1MB
const KEEP = 3;

function rotateIfNeeded(file) {
  try {
    if (!fs.existsSync(file)) return;
    const st = fs.statSync(file);
    if (st.size < MAX_BYTES) return;
    // .2 -> .3, .1 -> .2, 当前 -> .1
    for (let i = KEEP - 1; i >= 1; i--) {
      const from = `${file}.${i}`, to = `${file}.${i + 1}`;
      if (fs.existsSync(from)) {
        if (i + 1 > KEEP) fs.unlinkSync(from);
        else fs.renameSync(from, to);
      }
    }
    fs.renameSync(file, `${file}.1`);
  } catch (e) { /* 轮转失败不阻断日志写入 */ }
}

// createLogger('scf-local') → { log, file }，文件名 scf-local-YYYY-MM-DD.log，写前自动轮转。
function createLogger(name, logDir) {
  const dir = logDir || path.join(__dirname, '..', 'runtime', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const day = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const file = path.join(dir, `${name}-${day}.log`);
  rotateIfNeeded(file);
  function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    try { fs.appendFileSync(file, line + '\n', 'utf8'); } catch (e) { /* ignore */ }
  }
  return { log, file };
}

module.exports = { createLogger, rotateIfNeeded, MAX_BYTES };
