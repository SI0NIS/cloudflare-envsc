# envsc-daily-push · 企业在线监测异常标记每日推送

[简体中文](README.md) | [English](README.en.md)

企业污染源自动监测数据的**有效传输率**每天都会在公开平台发布，但**异常标记**（停运、人工填报、系统自动判定）散落在企业端平台的多个页面里，每天登录翻查非常繁琐。

本项目把这个过程完全自动化：**每天定时核查有效传输率，一旦出现异常监控点或异常标记，立即推送到手机（Bark / 邮件）**——不用登录任何平台，打开通知就知道当天哪些排口/机组出过什么事、发生在几点几分。

> 接手或迁移到新机器，请先读 **[docs/HANDOVER.md](docs/HANDOVER.md)**（架构、部署步骤、配置、运维命令、故障排查、验收清单）。

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
                     │    ↳ 由本机每天 14:40 抓取 → 写 KV          │
                     │    （cookie 失效时自动登录续期；            │
                     │      历史：阿里云 FC / 腾讯云 SCF，已停用）   │
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
| **双层就绪门控** | 先确认 `begin-end-time` 的最新日期 ≥ D-1，再确认该日明细至少有 1 个带传输率的监测点；任一条件未满足都返回 `not_ready`，顺延到下一整点重试 |
| **KV 去重** | 推送成功才写去重键，当天 6 次触发只推一次；未推送/失败不写，下一整点自然重试 |
| **欠推自动补推** | 公开平台维护/失败日期写入 KV `backfill:pending`；恢复后先推 D-1，再从旧到新补缺（单次默认最多 3 天），全部成功才清空 |
| **标记多源融合** | 分钟级 KV 标记**按监测点覆盖**公开版小时级标记；来源会如实标注（`kv`/`public`/`kv+public`/`relay`），便于核对 |
| **看门狗** | Worker 每天 13:05 后自检 KV 里是否有今天写入的标记；同步中断告警已于 2026-10-22 关闭（云函数停用、改本机同步），自检结果仍写入 `last-watchdog` 供排查 |

**判定与文案规则**（`buildText`，回归测试 27 例覆盖）：

- **异常监控点** = 未达标点 ∪ 停运排除点 ∪ 有实质标记的点；
- **废水豁免**：废水总排口每日可有 1 小时标样核查不参与统计（官方算法），有效率 ≥ 95.83% 视为达标；豁免期内的**自动标记不构成推送理由**，仅人工填报才触发（仍随推送展示）；
- **人工标记优先于自动标记**：自动标记时段被人工标记完全覆盖时抑制该段，仅推人工；部分重叠则都推（人工/自动是两个独立渠道，互为补充）；
- **标样核查类段豁免覆盖抑制**：与其他异常时段重叠时照常展示；
- 企业整体 100% 且无异常内容 → **仅推标题**，级别 `active`；否则标题 + 正文，级别 `timeSensitive`。

## 目录结构

```
cloudflare-envsc/
├── config/
│   ├── project.json        # 业务配置（唯一事实来源）：排除点/公司名/阈值/推送窗口
│   └── yili-hourly-map.json # 企业端小时点 ↔ 伊犁州平台固定站点映射
├── src/index.js            # Worker 主程序：取数、判定、文案、推送、看门狗
├── wrangler.toml           # Worker 配置：cron、vars、KV 绑定
├── tools/
│   ├── scf-marks-sync/     # 标记同步核心（云函数/本机共用同一份代码）
│   ├── local-sync/         # 本机兜底同步：定时入口 + 企业端自动登录续期 + 日志
│   ├── yili/               # 伊犁州平台采集适配器：登录、测点、因子、四类原始数据
│   ├── push-now.mjs        # 本地补推某一天（读取 KV 快照）
│   ├── kv-read.py          # 读取/检查 KV 内容
│   ├── buildtext-test.mjs  # 推送文案回归测试（27 例）
│   ├── merge-test.mjs      # 标记合并回归测试（28 例）
│   ├── backfill-test.mjs   # 维护期欠推补推回归测试（19 例）
│   ├── yili-hourly-fallback-test.mjs # 州平台小时兜底回归测试（21 例）
│   ├── watchdog-test.mjs   # 看门狗回归测试
│   └── dump-*.mjs          # 各数据接口裸抓诊断脚本
├── relay/                  # 企业端 HTTP → HTTPS 中继（fly.io/Render/Docker，带鉴权，可选）
└── docs/                   # 上游接口说明文档
```

## 伊犁州平台数据采集适配器

`tools/yili/` 提供州平台采集适配器，支持自动验证码登录、9 个监测点、实时/分钟/小时/日数据、5000 条分页完整性校验及 JSON/CSV/XLSX 输出。小时超标告警在企业端不可用时会按固定映射自动改取州平台数据；日报链路保持不变。凭据与 token 只落在本地忽略目录，不进入仓库。

```powershell
node tools/yili/cli.mjs stations
node tools/yili/cli.mjs query --station 川宁生物废水总排口 --type hour --date 2026-10-25
```

完整用法见 [tools/yili/README.md](tools/yili/README.md)。

## 部署步骤

### 0. 前置要求

- Node.js ≥ 24（含 npm）；
- 一个 Cloudflare 账号（免费版即可）；
- iOS 设备安装 [Bark](https://apps.apple.com/app/bark-customed-notifications/id1403753865)（推送通道）；
- 可选：[Resend](https://resend.com) 账号（邮件兜底）；
- 本机（Windows）一台，能访问企业端平台（分钟级标记抓取用；历史方案为云函数，已停用）；
- 企业端平台的账号密码（用于抓取分钟级标记 + 自动登录续期，向平台管理方申请）。

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

### 2.（推荐）配置本机标记同步

没有这一步也能跑——Worker 会退化为公开平台的小时级标记；要分钟级起止时间和人工填报标记，就在一台能访问企业端的本机上部署同步脚本（详见 [tools/local-sync/README.md](tools/local-sync/README.md)）：

```bash
cd tools/local-sync
cp local-config.example.json local-config.json   # 填入企业端账号、Cloudflare KV 凭据、Bark key
npm --prefix auto-login install puppeteer-core   # 自动登录续期依赖
node run_scf_local.cjs 2026-10-21 2 --force      # 手动试跑一次
```

然后注册 Windows 计划任务（每天 **14:40** 正式同步，早于 15:00 推送；另加「登录时」触发用于开机补缺）：

```powershell
# 任务1：每天 14:40 正式同步（--quick 按完备性判定，数据不全自动补抓）
$a = New-ScheduledTaskAction -Execute "node.exe" -Argument '"<repo>\tools\local-sync\run_scf_local.cjs" --quick' -WorkingDirectory "<repo>"
$t1 = New-ScheduledTaskTrigger -Daily -At "14:40:00"
Register-ScheduledTask -TaskName "ENVSC-SCF-Local-Sync" -Action $a -Trigger $t1 -Force
# 任务2：登录时补缺口（--if-missing 只补缺，不覆盖正式档的结果）
$a2 = New-ScheduledTaskAction -Execute "node.exe" -Argument '"<repo>\tools\local-sync\run_scf_local.cjs" --if-missing' -WorkingDirectory "<repo>"
$t2 = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName "ENVSC-SCF-Local-Sync-Logon" -Action $a2 -Trigger $t2 -Force
```

同步逻辑：先校验 cookie（无效则 puppeteer 自动登录续期）→ 抓 D-1 各监测点标记 → 写 KV `marks:<YYYY-MM-DD>`（载荷带 `sync` 完备性信息）；失败 Bark 告警（每天一次）。云函数时代的环境变量方式（`CNEMC_COOKIE`/`CF_ACCOUNT_ID`/…）在本机由 `local-config.json` 取代。

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
| `backfilled` | D-1 已推过，本次补推了历史欠推日期 | 否，正常 |
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

**本机同步配置**（`tools/local-sync/local-config.json`，不入仓库）：`cnemc.account/password`（企业端账号，自动登录续期用）、`cnemc.cookie`（可选，初始会话）、`cloudflare.accountId/kvNamespaceId/apiToken`（KV 读写）、`bark.key`（失败告警）。

**欠推补推配置**（`config/project.json` → `backfill`）：`enabled` 开关、`startDate` 首次扫描起点、`maxPerRun` 单次最多补几天（默认 3）。状态在 KV `backfill:pending`，全部补完自动变为 `[]`。

## 定时与去重

`wrangler.toml` 中的 cron 是 **UTC 时区**：`0 7-12 * * *` = **北京时间 15:00–20:00 整点**，共 6 次。

- 平台数据通常 13:00 后陆续就绪（本机 14:40 先抓标记，且载荷带完备性检查——不全会自动补抓），15:00 起步留缓冲；
- 6 个触发点 = 最多 6 次重试机会（`not_ready` / 失败自动顺延）；
- 推送成功写 KV 去重键，当天不会重复打扰；全达标（仅标题）同样写去重。
- 维护/失败日期进入欠推队列；平台恢复后先推 D-1，再用单次剩余配额从旧到新补推，补完清空队列。

## 小时超标告警（2026-10-23 新增）

平台只提供查询接口、没有推送能力。本机脚本补齐「轮询 → 阈值判定 → 推送」：

| 项 | 说明 |
|---|---|
| 触发 | Windows 计划任务 `ENVSC-Hourly-Alarm`，每小时 **:20** 运行 `tools/local-sync/hourly-alarm.cjs` |
| 覆盖时段 | 最近 **2 个已完成小时**（数据晚到可在下一小时补上）；也支持 `--date/--hour` 指定 |
| 数据源 | 优先企业端 `online-monitor/data/list`（小时行的实测值/标准值/有效性）+ `online-monitor/view/list`（折算值序列）；因子清单取自 `/monitoritem/pollutant/list` |
| 兜底 | 企业端 cookie/监测点/某点某小时不可用时，按 `config/yili-hourly-map.json` 改取伊犁州平台小时数据；正常时不访问州平台，去重键不变 |
| 因子编码 | 由企业端接口动态获取（**非甲烷总烃=508、颗粒物=001、二氧化硫=002、氮氧化物=003、化学需氧量=011、氨氮=060**），不再硬编码猜测 |
| 判定口径 | **废气用折算值**、**废水用实测值**（废水无折算）；废水 pH 用 `min_value`/`max_value` 区间判定；仅「数据有效」参与；严格大于标准（`minRatio` 可调） |
| 两层标准 | **A 级绩效**（`config/standards.json` → `a`）与**排放标准**（配置值优先，未配置时用平台 `outlet_standard`）。A 级：颗粒物 **10**、非甲烷总烃 **30**；排放标准：3号机组/1号2号机组 SO₂ **35**、NOx **50**（GB 13223-2011 超低排放口径），颗粒物 30、非甲烷总烃 100；总排口 pH **6~9**、COD **50**、氨氮 **5**（GB 21903-2008 表3 特别排放限值） |
| 文案区分 | 仅超 A 级 → `超A级标准 30，超 x%；未超排放标准 100`（标题「A级预警」）；两层均超 → `超排放标准 100，超 x%；A级标准 30 亦超`（标题「小时超标」） |
| 去重 | KV `alarm:<日期>:<小时>:<监测点>:<因子>:<层级>`（TTL 3 天）；A 级预警升级为排放超标时会再推一次 |
| 推送 | Bark（`group=小时超标`，`level=timeSensitive`），一次运行合并一条 |
| 状态 | KV `last-hourly-alarm`（checked / exceeded / exceededLegal / exceededA / pushed / missingStd / sources） |
| 配置 | `config/project.json` → `hourlyAlarm`；两层限值 → `config/standards.json` |

手动演练：

```bash
node tools/local-sync/hourly-alarm.cjs --date 2026-10-22 --hour 11 --dry-run --verbose
node tools/local-sync/hourly-alarm.cjs --date 2026-10-25 --hour 10 --dry-run --verbose --yili-only
```

> 页面列与接口字段的对照（标干值=`avg_value_<code>`、标准值=`outlet_standard_<code>`，
> 以及“非甲烷总烃=508”的核实过程）见 [tools/local-sync/README.md](tools/local-sync/README.md#字段与页面核对2026-10-23)。
> 公开平台没有可直接进行小时浓度阈值判定的完整序列；小时超标兜底顺序为企业端 → 伊犁州平台。

## 本地开发与测试

```bash
npm run dev                        # 本地起 Worker（wrangler dev）
node tools/buildtext-test.mjs      # 推送文案规则 27 例
node tools/merge-test.mjs          # 标记合并规则 28 例
node tools/backfill-test.mjs       # 欠推登记/双层就绪门控/恢复补推/限流/去重 19 例
node tools/watchdog-test.mjs       # 看门狗逻辑
node tools/yili-hourly-fallback-test.mjs # 州平台站点/因子映射与小时兜底 21 例
```

运维常用：

```bash
node tools/push-now.mjs 2026-10-07      # 用 KV 快照补推/预览某天（BARK_KEY=xxx KV_FILE=... 前缀）
"C:/.../python.exe" tools/kv-read.py --list "marks:2026-10"   # 查看 KV 键（凭据自动加载）
node tools/dump-puball.mjs              # 裸抓公开平台各接口，诊断数据源
node tools/local-sync/run_scf_local.cjs --quick    # 本机立即同步 D-1（先查完备性）
```

## 免责声明

- 本项目仅用于**企业自有账号**数据的便捷查看：所有接口调用均使用公开平台接口或自有会话凭据，不涉及逆向、绕过鉴权或抓取他人数据；
- 监测数据的权利归属原平台方，本项目只做读取与提醒，不存储、不转发数据内容（KV 中仅存标记摘要与去重键）；
- 推送内容不构成任何合规结论，正式核查请以官方平台为准。使用本项目请自行确认符合所在机构的数据使用规定。
