# 迁移到阿里云函数计算 FC（长期免费）

> **状态：已部署并验证通过（2026-09-27）**
> 函数 `envsc-marks-sync` 跑在华东 1（杭州），定时任务 12:55（北京时间）已生效。
> 云端实测：企业端抓取 10/10 成功、写 Cloudflare KV 成功（`marks:2026-09-26` 两条标记）。

代码文件：`tools/scf-marks-sync/index.js`（已改成一份通吃腾讯云与阿里云，无需另建副本）。
本机已用 `tools/fc-smoke.cjs` 冒烟验证通过（5/5 PASS）。

## 一键部署（已完成，重跑/改代码时用）

```bash
cd cloudflare-envsc/tools
export ALIBABA_CLOUD_ACCESS_KEY_ID=...
export ALIBABA_CLOUD_ACCESS_KEY_SECRET=...
export ALIYUN_ACCOUNT_ID=1355617125073513        # FC 3.0 接入地址必须带 UID
FENV_CNEMC_COOKIE='jointframe.cluster.sessionid=xxx' \
FENV_CF_ACCOUNT_ID=... FENV_CF_KV_NAMESPACE_ID=... FENV_CF_API_TOKEN=... \
FENV_BARK_KEY=... FENV_CNEMC_PSID=654000000031 FENV_DAYS=2 \
python fc-deploy.py                               # 建/更新函数 + 建定时触发器
python fc-deploy.py --invoke '{"dry":true}'       # 试跑（不写 KV），看抓取日志
```

踩过的坑：
- endpoint 必须写成 `<UID>.<region>.fc.aliyuncs.com`；写成 `fc.<region>.aliyuncs.com` 会报
  `InvalidVersion`（那是 FC 2.0 的地址）。UID 可用 STS `GetCallerIdentity` 取（无需额外授权）。
- SDK 默认**读超时只有 10 秒**，本函数要跑 20~40 秒，管理接口也偶尔超 —— 全部调用都要传
  `RuntimeOptions(read_timeout=...)`，脚本里已统一成 `RT`。

## 为什么迁

腾讯云 SCF 免费额度只覆盖**开通前 3 个月**，第 4 个月起每月扣基础套餐费（约 ¥10/月）。
阿里云 FC 的免费额度（100 万次调用 + 40 万 GB-s/月）写在产品页的"每月免费额度"里，**没有时限条款**。
本函数每天 1 次、约 20s × 256MB ≈ 5 GB-s，一个月约 150 GB-s —— 距 40 万额度差三个数量级。

## 1. 创建函数

阿里云 FC 控制台 → 函数管理 → 创建函数 → **事件函数**：

| 配置项 | 填什么 |
|---|---|
| 地域 | 华东 1（杭州）或华东 2（上海），任选 |
| 运行环境 | Node.js 18 |
| 代码上传 | 直接把 `index.js` 全文粘进在线编辑器（无第三方依赖，只用内置 `fetch`） |
| 请求处理程序 | `index.handler` |
| 内存规格 | 256 MB |
| 执行超时 | 120 秒 |

## 2. 环境变量

在函数配置 → 环境变量里逐条加（敏感项建议用"加密环境变量"）：

| 变量 | 值 |
|---|---|
| `CNEMC_COOKIE` | `jointframe.cluster.sessionid=xxxx`（企业端会话，**会过期**，失效时 Bark 会告警） |
| `CF_ACCOUNT_ID` | `df42e87e7315eea710e3b9e21a954619` |
| `CF_KV_NAMESPACE_ID` | `2f5ad113e1d24eb6b76ce6a95d3dc804` |
| `CF_API_TOKEN` | Cloudflare API Token（需 KV 的读写权限） |
| `BARK_KEY` | Bark 设备 key（敏感，不入库） |
| `CNEMC_PSID` | `654000000031` |
| `DAYS` | `2`（同步昨天和前天两天） |
| `ACCESS_TOKEN` | 可选；只有想加 HTTP 触发器（手机随手触发）时才需要，自己起一个随机串 |

## 3. 定时触发器

函数详情 → 触发器 → 创建触发器 → **定时触发器** → 触发方式选"自定义" → CRON 表达式填：

```
CRON_TZ=Asia/Shanghai 0 55 12 * * *
```

> 阿里云的 cron 是 6 段（秒 分 时 日 月 周），默认按 UTC 跑。
> 不写 `CRON_TZ` 就得填 UTC 时间 `0 55 4 * * *`，两者等价，选一个。
> 12:55 是刻意早于 Worker 13:00 的推送时点。

「触发消息」留空即可；需要临时改参数时可填 JSON，例如 `{"days":1}` 或 `{"dry":true}`（只抓不写，用来验证）。

## 4. 验证

函数详情 → 代码 → 测试函数，event 填：

```json
{"date":"2026-09-26","dry":true}
```

看返回与日志应出现 `SYNC_WARN`/`[dry] marks:...` 之类的行，且 `failCount` 为 0。
确认没问题后把 `dry` 去掉再测一次，日志里应出现 `SYNC_OK date=... -> KV marks:...`。

## 5. （可选）HTTP 触发器：手机随手触发

给函数再加一个 **HTTP 触发器**，会拿到一个公网 URL。用法：

```
POST https://<你的URL>/?k=<ACCESS_TOKEN>
body: {"date":"2026-09-26"}
```

或者浏览器直接打开 `https://<URL>/?k=<ACCESS_TOKEN>&days=1`（query 参数同样生效）。

鉴权规则写在代码里：**没配 `ACCESS_TOKEN` 时一律返回 403**，配了之后 `?k=` 必须对得上。
常用动作：`{"clearDedup":"2026-09-26"}`（强制重推某天）、`{"setDedup":"2026-09-26"}`（按住不推）、
`{"triggerWorker":"https://..."}`（让函数代调 Worker）。

## 6. 收尾

- 腾讯云 SCF 侧：确认阿里云跑稳几天后再禁用定时触发器（函数保留，当应急备份）。
- 用量自查：阿里云费用中心里盯一眼"函数调用次数"和"资源使用量"，确认在免费额度内。
  公网出流量走 CDT（每月 20GB 免费额度），本函数每天几十 KB，可忽略。

## 维护提醒

cookie 会过期（企业端会话），过期时当天会收到一条 Bark 告警"envsc 同步告警：cookie 已失效"，
此时需要重新登录企业端抓 cookie，更新到环境变量 `CNEMC_COOKIE`。登录有滑块验证，代码里不做自动登录。
