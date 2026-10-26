import https from 'node:https';

const DEFAULT_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Encoding': 'identity',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

export function createHttpsTransport({ verifyTls = false, timeoutMs = 30000, agent } = {}) {
  const tlsAgent = agent || new https.Agent({
    keepAlive: true,
    rejectUnauthorized: verifyTls,
  });

  return function httpsTransport(url, { method = 'GET', headers = {}, body, signal } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('请求已取消'));
        return;
      }

      const payload = body == null ? null : (Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
      const finalHeaders = { ...DEFAULT_HEADERS, ...headers };
      if (payload) finalHeaders['Content-Length'] = String(payload.length);

      const request = https.request(new URL(url), {
        method,
        headers: finalHeaders,
        agent: tlsAgent,
        timeout: timeoutMs,
      }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve(new Response(buf.length ? buf : null, {
            status: response.statusCode || 0,
            headers: response.headers,
          }));
        });
        response.on('error', reject);
      });

      const onAbort = () => request.destroy(new Error('请求已取消'));
      signal?.addEventListener('abort', onAbort, { once: true });
      request.on('timeout', () => request.destroy(new Error(`请求超时（${timeoutMs}ms）`)));
      request.on('error', reject);
      request.on('close', () => signal?.removeEventListener('abort', onAbort));
      if (payload) request.write(payload);
      request.end();
    });
  };
}
