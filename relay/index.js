/**
 * marks-relay —— 企业端「人工标记」HTTP 接口的**私有 HTTPS 中继**。
 *
 * 为什么需要它：Cloudflare Workers 的 fetch 只支持 HTTPS，而企业端接口
 *（http://116.178.28.170:3080）只提供明文 HTTP。本中继把该接口包成一个
 * 带鉴权的 HTTPS 端点，供 Worker 调用，从而让自动推送能带上「人工标记」。
 *
 * 安全设计（关键，避免变成开放代理 / SSRF）：
 *   1. 上游 host/port 硬编码为 116.178.28.170:3080，绝不接受任意目标。
 *   2. 只允许转发路径前缀 `/amOnline/`（企业端业务路径）。
 *   3. 必须携带 `Authorization: Bearer <RELAY_TOKEN>`，否则 403。
 *   4. 企业端会话 cookie 由调用方（Worker）在 `Cookie` 头传入并原样转发，
 *      中继本身不存放企业凭据。
 *
 * 部署：平台（fly.io / Railway / 自有 VPS）负责 TLS 终止，本进程只监听
 * 明文 HTTP（PORT）。若需本进程自带 TLS，可设 RELAY_TLS_KEY/RELAY_TLS_CERT。
 */

import http from 'node:http';
import fs from 'node:fs';

const UPSTREAM_HOST = '116.178.28.170';
const UPSTREAM_PORT = 3080;
const ALLOW_PREFIX = '/amOnline/';
const TOKEN = process.env.RELAY_TOKEN || '';
const PORT = Number(process.env.PORT || 3000);

const server = http.createServer((req, res) => {
  // 健康检查：无需鉴权、不转发
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }

  // 1) 鉴权
  const auth = req.headers['authorization'] || '';
  if (!TOKEN || auth !== `Bearer ${TOKEN}`) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return;
  }

  // 2) 路径白名单（SSRF 防护）
  const u = new URL(req.url, 'http://localhost');
  if (!u.pathname.startsWith(ALLOW_PREFIX)) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('bad path');
    return;
  }

  // 3) 收集请求体（GET 通常为空，兼容 POST）
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = chunks.length ? Buffer.concat(chunks) : null;
    const options = {
      host: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      path: u.pathname + u.search,
      method: req.method,
      timeout: 25000,
      headers: {
        Cookie: req.headers['cookie'] || '',
        Accept: 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: `http://${UPSTREAM_HOST}:${UPSTREAM_PORT}/amOnline/zdjk-company/`,
      },
    };
    const p = http.request(options, (up) => {
      const upChunks = [];
      up.on('data', (c) => upChunks.push(c));
      up.on('end', () => {
        res.writeHead(up.statusCode || 502, {
          'Content-Type': 'application/json; charset=utf-8',
        });
        res.end(Buffer.concat(upChunks));
      });
    });
    p.on('error', (e) => {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    });
    p.setTimeout(25000, () => p.destroy(new Error('upstream timeout')));
    if (body) p.write(body);
    p.end();
  });
});

const tlsKey = process.env.RELAY_TLS_KEY;
const tlsCert = process.env.RELAY_TLS_CERT;
if (tlsKey && tlsCert && fs.existsSync(tlsKey) && fs.existsSync(tlsCert)) {
  const https = await import('node:https');
  https
    .createServer(
      { key: fs.readFileSync(tlsKey), cert: fs.readFileSync(tlsCert) },
      server
    )
    .listen(PORT, () => console.log(`marks-relay (HTTPS) listening on :${PORT}`));
} else {
  server.listen(PORT, () => console.log(`marks-relay listening on :${PORT}`));
}
