# scf-marks-sync · 腾讯云 SCF 定时同步（长期免费版）

把原先跑在本机的 `marks-sync.mjs` 搬到**腾讯云云函数 SCF**，彻底摆脱"本机必须开机"。
写 KV 改用 **Cloudflare REST API**（不再依赖本机 wrangler）。

## 为什么是 SCF，而不是 CloudBase / 微信云托管

| 平台 | 免费性质 | 适合度 |
|---|---|---|
| **腾讯云 SCF** | **永久月度免费额度**（100 万次调用/月 + 40 万 GBs/月 + 外网出流量），每月重置、不自动扣费 | ✅ 长期免费 |
| 阿里云函数计算 FC | 同为长期月度免费额度（量级相近） | ✅ 备选 |
| 腾讯云 CloudBase 免费体验版 | **6 个月试用**（非长期） | ❌ |
| 微信云托管 | **6 个月**，且小程序发布后缩为 **15 天** | ❌ |

硬指标两条：**国内出口**（企业端 `116.178.28.170:3080` 仅国内 IP 可达）+ **长期免费** → 只有国内大厂 serverless 的永久免费额度满足。

用量估算：每天 ~10 次调用、每次几 KB → 月耗 ≈ 300 次、<1MB，占免费额度 **<0.1%**。

## 部署步骤（控制台，约 10 分钟）

### 0. 前置：建一个 Cloudflare API Token
Cloudflare 控制台 → My Profile → **API Tokens** → Create Token → 自定义：
- 权限：`Account` → `Workers KV Storage` → **Edit**
- 资源：包含你的账号
- 生成后**只显示一次**，复制保存。

### 1. 新建函数
腾讯云控制台 → **云函数 SCF** → 函数服务 → 新建：
- 创建方式：**从头开始** / 空白函数
- 运行环境：**Node.js 18**
- 函数名称：如 `envsc-marks-sync`
- 地域：任意国内地域（上海/广州等）
- **高级配置**：超时时间 **120 秒**、内存 **256MB**

### 2. 粘贴代码
把 `index.js` 全文粘进控制台的在线编辑器，保存。

### 3. 配置环境变量
函数配置 → 环境变量，逐条添加：

| Key | Value |
|---|---|
| `CNEMC_COOKIE` | `jointframe.cluster.sessionid=xxxx...`（企业端会话 cookie） |
| `CF_ACCOUNT_ID` | `df42e87e7315eea710e3b9e21a954619` |
| `CF_KV_NAMESPACE_ID` | `2f5ad113e1d24eb6b76ce6a95d3dc804` |
| `CF_API_TOKEN` | 第 0 步生成的 token |
| `CNEMC_PSID` | `654000000031`（可省略，代码有默认值） |
| `DAYS` | `2`（同步 D-1 与 D-2，可省略） |

### 4. 加定时触发器
函数 → 触发管理 → 创建触发器 → **定时触发**，添加两条：

| 名称 | Cron | 含义 |
|---|---|---|
| daily-1030 | `0 30 10 * * * *` | 北京 10:30 |
| daily-1230 | `0 30 12 * * * *` | 北京 12:30 |

> SCF 的 cron 是 **7 段**（秒 分 时 日 月 周 年）。

### 5. 先测一次
控制台「函数测试」→ 新建测试事件，内容填 `{"dry":true}`（只抓不写），执行后看返回 JSON 的 `log`。
确认能抓到数据后，再改成 `{}` 正式跑一次，然后核对 Cloudflare KV 里 `marks:<日期>` 的 `at` 是否更新。

## 校验是否生效
```bash
# 用本机 wrangler 查（也可在 Cloudflare 控制台 KV 里看）
node <wrangler.js> kv key get --binding ENVSC_KV --remote "marks:2026-09-22"
# 看 at 时间戳是否 = 刚才函数运行时间
```

## cookie 过期怎么办
企业端 cookie 会过期。SCF 里更新方式：**控制台 → 函数配置 → 环境变量 → 编辑 `CNEMC_COOKIE`**。
cookie 的寿命需实测；到期后 Worker 侧会自动降级到公开平台（不会中断推送，只是标记变粗）。

## 备注
- 本函数**不需要任何公网入口**（只有定时触发 + 出网），所以不涉及 API 网关 / 函数 URL 的费用。
- 想改回"HTTPS 中继代理"形态也可行（SCF 函数 URL / API 网关触发），但当前形态②（定时写 KV）**Worker 零改动**，更省。
