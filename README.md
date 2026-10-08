# 有效传输率每日核查 · Cloudflare Worker 版

## 为什么要换到 Cloudflare

CloudBase 那边卡住的根因不是操作问题，而是**环境不匹配**：

- 「集合 collection」是**文档型数据库（NoSQL）**的概念，你的环境是 **SQL 型数据库**，只有数据表；
- 更关键：`@cloudbase/node-sdk` **只支持文档型数据库**（源码里完全没有 MySQL 支持），
  所以 `createCollection` 必然失败、查询必报 `RESOURCE_NOT_FOUND`，去重做不了。

Cloudflare 恰好两个问题一起解决：

| 问题 | Cloudflare 的解法 |
|---|---|
| 去重存储 | **Workers KV**，免费额度充足，键值读写即可，无需建库建表 |
| cron 时区不明 | Cron Triggers **明确按 UTC**，不用猜 |
| 代码依赖 | 纯 `fetch`，无第三方运行时依赖 |

## 当前进度

- ✅ wrangler CLI 已装：**4.135.0**（全局，位于 `AppData\Roaming\npm`，已在 PATH）
- ✅ Worker 代码已写好：`src/index.js`
- ⏳ **待你操作**：登录 Cloudflare（见下）
- ⏳ 登录后由我继续：创建 KV → 填 id → 写密钥 → 部署

## 你需要做的一步

在你**自己的终端**（不是这里，需要浏览器交互）执行：

```powershell
wrangler login
```

浏览器会打开 Cloudflare 授权页，确认即可。凭据会写入本机的 `~/.wrangler`，
**同一台机器上我后续调用 wrangler 会直接用这个登录态**，不需要你把密钥给我。

> 若你更习惯用 API Token：也可在 Cloudflare 控制台生成 API Token 后
> `setx CLOUDFLARE_API_TOKEN <token>`，效果相同。

## 登录后的部署流程（我来做）

```powershell
cd C:\Users\Sionis\WorkBuddy\2026-09-16-21-43-51\cloudflare-envsc

# 1) 创建去重用的 KV namespace，把返回的 id 填进 wrangler.toml 的 REPLACE_WITH_KV_ID
wrangler kv:namespace create ENVSC_KV

# 2) 写入密钥（Bark）
wrangler secret put BARK_KEY          # 你的 Bark 设备 key（api.day.app 推送时使用，勿提交到仓库）

# 3) 部署（会同时注册 cron 触发器）
wrangler deploy
```

部署后访问 `https://envsc.<你的子域>.workers.dev` 即可手动触发一次，直接看到 JSON 结果。

## 定时规则（重要）

`wrangler.toml` 里写的是：

```toml
[triggers]
crons = ["0 7-11 * * *"]
```

Cron Triggers 是 **5 字段**且**时区为 UTC**：
**UTC 07–11 点整 = 北京时间 15:00–19:00 整点** —— 与你要求的时段一致。
有了 KV 去重，每小时触发也不会重复推送（当天推过就跳过）。

## 推送通道

| 通道 | 说明 |
|---|---|
| Bark（主） | 公网 HTTPS，实测可用 |
| 邮件（兜底） | ⚠️ **Workers 没有 TCP socket，SMTP 用不了**。改用 HTTP 邮件 API（Resend）。<br>需要 `RESEND_API_KEY`（免费额度足够）；不配也不会报错，只是只发 Bark |

若要启用邮件兜底：注册 Resend → 拿 API key →

```powershell
wrangler secret put RESEND_API_KEY
```

## 返回结果含义

| `action` | 含义 | 要处理吗 |
|---|---|---|
| `pushed` | 已取数并推送成功 | 否 |
| `skipped` | 当天已推送过（KV 去重命中） | 否，正常 |
| `not_ready` | 平台还没发布到 D-1 | 否，等下一触发点 |
| `failed` | 取数或推送失败 | 是，需排查 |

## 与 CloudBase 版的取舍

- 快照图仍为**结构化文本**（云端无 Chrome），与之前一致
- 不再使用 WorkBuddy 内置助理 iLink（凭据只在本机），Bark 为主通道
- CloudBase 那个环境可以留着不用，也可以删掉
