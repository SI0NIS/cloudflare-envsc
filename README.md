# envsc-daily-push · 企业在线监测异常标记每日推送

[简体中文](README.md) | [English](README.en.md)

企业污染源自动监测数据的**有效传输率**每天都会在公开平台发布，但**异常标记**（停运、人工填报、系统自动判定）散落在企业端平台的多个页面里，每天登录翻查非常繁琐。

本项目把这个过程完全自动化：**每天定时核查有效传输率，一旦出现异常监控点或异常标记，立即推送到手机（Bark / 邮件）**——不用登录任何平台，打开通知就知道当天哪些排口/机组出过什么事、发生在几点几分。

## 推送效果

**① 全部达标（100%，仅标题，不打扰）：**

```
20261007有效传输率100%
```

**② 有异常监控点 / 异常标记（标题 + 完整正文）：**

```
20260928有效传输率99.86%

异常监控点（2 / 8 个）：
· 3号机组　即时 100% / 补全 98.62%
自动标记：二氧化硫/氮氧化物 校准 14:05~14:33(29min)；故障 14:41~17:28(168min)
· 总排口　即时 100% / 补全 95.83%（≤1h 标样核查，已豁免）
人工标记：化学需氧量/氨氮 标样核查-自动标样核查运行 13:21~14:06(46min)
```

**③ 监控点停运（不计入统计）：**

```
· 3号机组（工况标记：停运，不计入有效传输率统计时段）
```

**④ 标记同步云函数 cookie 失效时，单独 Bark 告警**（当天只告警一次），提醒更新会话。

推送通道：**Bark 为主**（iOS 免费 App，公网 HTTPS）；**邮件兜底**（Resend HTTP API，Bark 失败时自动补发，不配置则只发 Bark）。

## 工作原理

```
                     ┌──────────────────────────────────────────┐
                     │              数据源（三条腿）              │
                     ├──────────────────────────────────────────┤
                     │ ① 公开平台 jkzx.envsc.cn                  │
                     │    有效传输率（企业级 + 分测点）            │
                     │    公开版标记（小时级大类，如"设备维护"）    │
                     ├──────────────────────────────────────────┤
                     │ ② 企业端在线监控平台（仅境内可达）          │
                     │    分钟级自动标记 + 人工填报标记            │
                     │    ↳ 由境内云函数每天 12:55 抓取 → 写 KV    │
                     │    ↳ 或经 HTTPS 中继 relay（可选）         │
                     ├──────────────────────────────────────────┤
                     │ ③ 企业端直连兜底（①②全挂时才走）           │
                     └──────────────────────────────────────────┘
                                        │
                                        ▼
            ┌───────────────────────────────────────────────┐
            │        Cloudflare Worker（免费额度内运行）      │
            │  cron：北京时间 15:00–20:00 每整点（共 6 次）    │
            │                                               │
            │  KV 去重 ──► 数据就绪门控 ──► 判定 ──► 组装文案  │
            │                                    │          │
            │                          Bark（主）┤          │
            │                          邮件（兜底）┘          │
            └───────────────────────────────────────────────┘
```

核心机制：

| 机制 | 说明 |
|---|---|
| **就绪门控** | 先调平台的 `begin-end-time` 接口确认 D-1 数据已发布；未发布返回 `not_ready`，顺延到下一整点重试 |
| **KV 去重** | 推送成功才写去重键，当天 6 次触发只推一次；未推送/失败不写，下一整点自然重试 |
| **标记多源融合** | 分钟级 KV 标记**按监测点覆盖**公开版小时级标记；来源会如实标注（`kv`/`public`/`kv+public`/`relay`），便于核对 |
| **看门狗** | Worker 每天 13:05 后自检 KV 里是否有今天写入的标记——云函数欠费/冻结会静默失效，看门狗直接 Bark 告警 |

**判定与文案规则**（`buildText`，回归测试 27 例覆盖）：

- **异常监控点** = 未达标点 ∪ 停运排除点 ∪ 有实质标记的点；
- **废水豁免**：废水总排口每日可有 1 小时标样核查不参与统计（官方算法），有效率 ≥ 95.83% 视为达标；豁免期内的**自动标记不构成推送理由**，仅人工填报才触发（仍随推送展示）；
- **人工标记优先于自动标记**：自动标记时段被人工标记完全覆盖时抑制该段，仅推人工；部分重叠则都推（人工/自动是两个独立渠道，互为补充）；
- **标样核查类段豁免覆盖抑制**：与其他异常时段重叠时照常展示；
- 企业整体 100% 且无异常内容 → **仅推标题**，级别 `active`；否则标题 + 正文，级别 `timeSensitive`。

## 目录结构

```
cloudflare-envsc/
├── src/index.js            # Worker 主程序：取数、判定、文案、推送、看门狗（单文件无构建）
├── wrangler.toml           # Worker 配置：cron、vars、KV 绑定
├── tools/
│   ├── scf-marks-sync/     # 标记同步云函数（腾讯云 SCF / 阿里云 FC 一份代码通用）
│   ├── fc-deploy.py        # 云函数一键部署（阿里云 FC）
│   ├── rotate-aliyun-key.py# 阿里云 AccessKey 轮换辅助
│   ├── _aliyun_env.py      # 凭据统一加载（环境变量优先，其次 tools/.env.aliyun）
│   ├── push-now.mjs        # 本地补推某一天（读取 KV 快照）
│   ├── kv-read.py          # 读取/检查 KV 内容
│   ├── buildtext-test.mjs  # 推送文案回归测试（27 例）
│   ├── merge-test.mjs      # 标记合并回归测试（28 例）
│   ├── watchdog-test.mjs   # 看门狗回归测试
│   └── dump-*.mjs          # 各数据接口裸抓诊断脚本
├── relay/                  # 企业端 HTTP → HTTPS 中继（fly.io/Render/Docker，带鉴权）
└── docs/                   # 上游接口说明文档
```

## 部署步骤

### 0. 前置要求

- Node.js ≥ 18（含 npm）；
- 一个 Cloudflare 账号（免费版即可）；
- iOS 设备安装 [Bark](https://apps.apple.com/app/bark-customed-notifications/id1403753865)（推送通道）；
- 可选：[Resend](https://resend.com) 账号（邮件兜底）；
- 可选但推荐：阿里云函数计算 FC 或腾讯云 SCF 账号（分钟级标记抓取用，免费额度充足）；
- 企业端平台的会话 cookie（用于抓取分钟级标记，向平台管理方申请账号后浏览器登录取得）。

### 1. 部署 Worker（约 3 分钟）

```bash
git clone https://github.com/SI0NIS/cloudflare-envsc.git
cd cloudflare-envsc
npm install

# 创建去重/标记存储用的 KV，把返回的 id 填入 wrangler.toml 的 [[kv_namespaces]]
npx wrangler kv namespace create ENVSC_KV

# 写入敏感凭据（交互式输入，不落盘不进仓库）
npx wrangler secret put BARK_KEY            # Bark 设备 key（必填）

# 部署（同时注册 cron 定时器）
npx wrangler deploy
```

### 2.（推荐）部署标记同步云函数

没有这一步也能跑——Worker 会退化为公开平台的小时级标记；要分钟级起止时间和人工填报标记，就部署云函数：

```bash
cd tools
export ALIBABA_CLOUD_ACCESS_KEY_ID=...
export ALIBABA_CLOUD_ACCESS_KEY_SECRET=...
export ALIYUN_ACCOUNT_ID=<阿里云主账号 UID>   # FC 3.0 接入地址必须带 UID

FENV_CNEMC_COOKIE='jointframe.cluster.sessionid=xxx' \
FENV_CF_ACCOUNT_ID=<Cloudflare 账号 ID> \
FENV_CF_KV_NAMESPACE_ID=<第 1 步的 KV id> \
FENV_CF_API_TOKEN=<有 KV 写权限的 API Token> \
FENV_BARK_KEY=<同第 1 步> \
FENV_CNEMC_PSID=654000000031 FENV_DAYS=2 \
python fc-deploy.py                          # 建/更新函数 + 定时触发器（12:55）
python fc-deploy.py --invoke '{"dry":true}'  # 试跑一次（不写 KV）
```

细节与踩坑记录见 [tools/deploy-aliyun-fc.md](tools/deploy-aliyun-fc.md)。云函数只做：定时 12:55 抓取 D-1/D-2 标记 → 写 Cloudflare KV（键 `marks:<YYYY-MM-DD>`）；cookie 失效时 Bark 告警（KV 幂等，当天只告警一次）。

### 3.（可选）启用邮件兜底

```bash
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put MAIL_TO              # 收件邮箱
```

不配置不影响 Bark 推送。

### 4.（可选）部署 HTTPS 中继

企业端标记接口是**明文 HTTP** 且仅对境内 IP 开放。Cloudflare 边缘若直连不通，把 `relay/` 部署到任意有境内出口的平台（fly.io / Railway / 自有 VPS 均可），然后：

```bash
npx wrangler secret put MARKS_PROXY_URL      # 如 https://marks-relay-xxx.fly.dev
npx wrangler secret put MARKS_PROXY_TOKEN    # 与中继的 RELAY_TOKEN 一致
```

详见 [relay/README.md](relay/README.md)。

### 5. 验证

```bash
curl https://envsc.<你的子域>.workers.dev    # 手动触发一次，直接看 JSON 结果
npx wrangler tail                            # 观察定时执行的实时日志
```

返回 `action` 的含义：

| `action` | 含义 | 要处理吗 |
|---|---|---|
| `pushed` | 已取数并推送成功 | 否 |
| `skipped` | 当天已推送过（KV 去重命中） | 否，正常 |
| `not_ready` | 平台还没发布 D-1 数据 | 否，下一整点自动重试 |
| `failed` | 取数或推送失败 | 是，`wrangler tail` 看原因 |

## 配置参考

**普通变量（`wrangler.toml` `[vars]`）**

| 变量 | 说明 |
|---|---|
| `CNEMC_PSID` | 排污单位 ID（公开平台 detail 接口参数） |
| `MAIL_FROM` | Resend 发件人（默认 `onboarding@resend.dev`，仅测试可用） |

**Secrets（`wrangler secret put`，不进仓库）**

| 变量 | 必填 | 说明 |
|---|---|---|
| `BARK_KEY` | ✅ | Bark 设备 key |
| `MAIL_TO` | — | 邮件兜底收件地址 |
| `RESEND_API_KEY` | — | 邮件兜底发件 API |
| `CNEMC_COOKIE` | — | 企业端会话 cookie（中继模式 / 直连兜底时用） |
| `MARKS_PROXY_URL` | — | 中继地址（可选） |
| `MARKS_PROXY_TOKEN` | — | 中继鉴权令牌（须与中继 `RELAY_TOKEN` 一致） |

**云函数环境变量**（`FENV_*` 传给 `fc-deploy.py`）：`CNEMC_COOKIE`、`CF_ACCOUNT_ID`、`CF_KV_NAMESPACE_ID`、`CF_API_TOKEN`、`BARK_KEY`、`CNEMC_PSID`、`DAYS`（回抓天数，默认 2）。

## 定时与去重

`wrangler.toml` 中的 cron 是 **UTC 时区**：`0 7-12 * * *` = **北京时间 15:00–20:00 整点**，共 6 次。

- 平台数据通常 13:00 后陆续就绪（云函数 12:55 先抓标记），15:00 起步留 2 小时缓冲；
- 6 个触发点 = 最多 6 次重试机会（`not_ready` / 失败自动顺延）；
- 推送成功写 KV 去重键，当天不会重复打扰；全达标（仅标题）同样写去重。

## 本地开发与测试

```bash
npm run dev                        # 本地起 Worker（wrangler dev）
node tools/buildtext-test.mjs      # 推送文案规则 27 例
node tools/merge-test.mjs          # 标记合并规则 28 例
node tools/watchdog-test.mjs       # 看门狗逻辑
```

运维常用：

```bash
node tools/push-now.mjs 2026-10-07      # 用 KV 快照补推/预览某天（BARK_KEY=xxx KV_FILE=... 前缀）
"C:/.../python.exe" tools/kv-read.py --list "marks:2026-10"   # 查看 KV 键（凭据自动加载）
node tools/dump-puball.mjs              # 裸抓公开平台各接口，诊断数据源
```

换阿里云 AccessKey（云函数部署凭据）：

```bash
python tools/rotate-aliyun-key.py --set <新AK> <新SK>   # 写入 tools/.env.aliyun 并自动验证
python tools/kv-read.py --list                          # 实际链路复验
# 然后去阿里云控制台禁用旧 AccessKey
```

## 免责声明

- 本项目仅用于**企业自有账号**数据的便捷查看：所有接口调用均使用公开平台接口或自有会话凭据，不涉及逆向、绕过鉴权或抓取他人数据；
- 监测数据的权利归属原平台方，本项目只做读取与提醒，不存储、不转发数据内容（KV 中仅存标记摘要与去重键）；
- 推送内容不构成任何合规结论，正式核查请以官方平台为准。使用本项目请自行确认符合所在机构的数据使用规定。
