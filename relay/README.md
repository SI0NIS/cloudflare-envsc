# marks-relay · 企业端人工标记 HTTPS 中继

Cloudflare Workers 的 `fetch` 只支持 HTTPS，而企业端「人工标记」接口
（`http://116.178.28.170:3080`）只有明文 HTTP。本中继把该接口包成一个
**带鉴权**的 HTTPS 端点，供 `envsc` Worker 调用，从而实现自动推送带上
「人工标记」。

> 安全：上游 host 硬编码、路径白名单 `/amOnline/`、必须 `Bearer` 令牌，绝非开放代理。

---

## 1. 部署（三选一，平台负责 TLS，进程只监听明文 HTTP）

### A. fly.io（推荐，免费额度、自动 HTTPS、稳定 URL）
```bash
cd relay
fly launch --no-deploy -n marks-relay-yourname   # 按提示，或复用本目录 fly.toml
fly secrets set RELAY_TOKEN=$(openssl rand -hex 32) -a marks-relay-yourname
fly deploy
# 记下分配的 HTTPS 地址，形如 https://marks-relay-yourname.fly.dev
```

### B. Railway / Render
- 连仓库，构建命令留空（或 `npm install`），启动命令 `node index.js`。
- 在平台环境变量里设 `PORT`（平台会给）和 `RELAY_TOKEN`。
- 平台自动签发 `*.railway.app` / `*.onrender.com` 的 HTTPS 证书。

### C. 自有 VPS + Docker
```bash
docker build -t marks-relay ./relay
docker run -d -p 3000:3000 -e RELAY_TOKEN=<强随机串> --restart unless-stopped marks-relay
# 前面用 Nginx/Caddy 反代并配 Let's Encrypt 证书，对外暴露 HTTPS
```

---

## 2. 给 Worker 配置中继（关键）

在 `cloudflare-envsc` 目录执行（值与上面 `RELAY_TOKEN` 必须一致）：

```bash
wrangler secret put MARKS_PROXY_URL   # 输入 https://<你的中继地址>
wrangler secret put MARKS_PROXY_TOKEN # 输入与 RELAY_TOKEN 相同的串
wrangler deploy --config wrangler.toml
```

`src/index.js` 的 `fetchMarks` 会自动：
- 若设置了 `MARKS_PROXY_URL` → 请求 `<中继>/amOnline/app/baseroute/requestRoute!list.page?...`
  并在头部带 `Authorization: Bearer <MARKS_PROXY_TOKEN>`，同时转发企业 `Cookie`；
- 若未设置 → 退回直连（边缘必失败，走优雅降级）。

---

## 3. 本地自检

```bash
RELAY_TOKEN=test123 PORT=3100 node index.js
# 另开终端：
curl -H "Authorization: Bearer test123" \
     -H "Cookie: jointframe.cluster.sessionid=<你的cookie>" \
     "http://localhost:3100/amOnline/app/baseroute/requestRoute!list.page?method=/sign/qy/list&pageNum=1&pageSize=100"
# 应返回企业端 JSON（含 data.rows）
```

健康检查：`GET /healthz` 返回 `ok`（无需令牌）。
