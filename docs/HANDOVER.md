# ENVSC 有效传输率核查系统 · 交接文档

> 版本：2026-10-26
> 代码仓库：<https://github.com/SI0NIS/cloudflare-envsc>
> 本机部署目录：`D:\Application\cloudflare-envsc`
> 适用对象：接手本项目的开发/运维人员，或另一个 AI 客户端
>
> 本文不含任何密钥。密钥位置见第 9 节；仓库内 `docs/CREDENTIALS.md` 有更细的轮换说明。

---

## 1. 系统是做什么的

每天自动完成三件事：

1. **抓标记**：从企业端自动监控平台抓取前一天的分钟级标记（人工填报 + 系统自动标记），写入 Cloudflare KV；
2. **推日报**：每天 15:00–20:00 整点，Cloudflare Worker 读取公开平台的有效传输率 + KV 里的分钟级标记，合成日报并通过 Bark 推送（成功后当天不再重复）；
3. **小时数据异常/超标告警**：本机每小时 :20 检查最近两个已完成小时，按「A 级绩效标准 + 排放标准」两层判定，超标或数据有效负值推 Bark；企业端不可用时自动改取伊犁州平台小时数据兜底。

另有一条**本机兜底**链路：每天 14:40 由 Windows 计划任务执行同步（云函数已停用），cookie 失效时自动登录续期。

---

## 2. 架构与数据流

```
┌─────────────────────────────┐
│ 企业端自动监控平台（内网）    │  http://116.178.28.170:3080
│  · 监测点/因子清单            │  /amOnline/zdjk-company-base/
│  · 分钟级标记（rg_flag/zd_flag）│
│  · 小时数据（浓度/标准/折算/pH）│
└──────────────┬──────────────┘
               │ 本机 14:40（cookie + 自动登录续期）
               ▼
┌─────────────────────────────┐
│ tools/scf-marks-sync        │  抓 D-1 标记 → 双写
│ tools/local-sync            │  marks:<date>（v1 文本）
│                             │  marks:v2:<date>（结构化）
└──────────────┬──────────────┘
               │ Cloudflare KV（账号/命名空间见第 3 节）
               ▼
┌─────────────────────────────┐        ┌──────────────────────┐
│ Cloudflare Worker `envsc`   │◀──────▶│ 公开平台 jkzx.envsc.cn │
│  cron 0 7-12 * * * (UTC)    │  取有效  │ 有效传输率/小时级标记  │
│  = 北京 15:00–20:00 整点     │  传输率  │ （数据未发布，见 10.1）│
└──────────────┬──────────────┘        └──────────────────────┘
               │ Bark（主）/ 邮件（兜底，未配 key）
               ▼
          用户手机 Bark

本机另有：
  ENVSC-Hourly-Alarm  每小时 :20  → 企业端小时数据（不可用时州平台兜底）→ 两层标准判定 → Bark
  ENVSC-SCF-Local-Sync-Logon  登录时 → 仅补缺（--if-missing）
```

---

## 3. 关键资产与标识（非密钥）

| 项 | 值 |
|---|---|
| 代码仓库 | <https://github.com/SI0NIS/cloudflare-envsc>（`main`） |
| 本机目录 | `D:\Application\cloudflare-envsc` |
| Worker 名称 | `envsc`（<https://envsc.sionis.workers.dev>） |
| Worker 定时 | `0 7-12 * * *`（UTC）= 北京 **15:00–20:00 整点** |
| Cloudflare 账号 | `df42e87e7315eea710e3b9e21a954619` |
| KV 命名空间 | `2f5ad113e1d24eb6b76ce6a95d3dc804`（绑定名 `ENVSC_KV`） |
| 企业端 | `http://116.178.28.170:3080/amOnline/zdjk-company-base/` |
| 企业 psId | `654000000031` |
| 监测点 | 总排口、生产工艺尾气排放口、环保尾气排放口、3号机组、1号2号机组 |
| 本机 Node | `D:\Application\NodeJs\node.exe`（Node 24，v24.20.0） |
| 本机 Chrome | `C:\Program Files\Google\Chrome\Application\chrome.exe` |
| 当前 Worker 版本 | `45253d58`（2026-10-25，含维护期欠推自动补推、双层就绪门控与 `not_ready` 保留队列修复） |
| 文档基线（代码） | 本地 `ab807e2`；远端 `86c7415a`（树一致）。后续提交以 `git log` 为准 |

---

## 4. 新客户端 30 分钟接管步骤

### 4.1 准备

1. 安装 **Node.js 24**、**Google Chrome**（自动登录依赖）；
2. 克隆仓库：

```bash
git clone https://github.com/SI0NIS/cloudflare-envsc.git D:\Application\cloudflare-envsc
cd D:\Application\cloudflare-envsc
```

3. 安装自动登录依赖（国内镜像）：

```bash
cd tools\local-sync\auto-login
npm install puppeteer-core --registry=https://registry.npmmirror.com --no-audit --no-fund
```

### 4.2 填配置（关键）

复制模板并填写：

```bash
cd D:\Application\cloudflare-envsc\tools\local-sync
copy local-config.example.json local-config.json
```

`local-config.json`（**已被 .gitignore，绝不能提交**）：

```json
{
  "cnemc": {
    "cookie": "",
    "psid": "654000000031",
    "account": "<企业端账号>",
    "password": "<企业端密码>"
  },
  "cloudflare": {
    "accountId": "df42e87e7315eea710e3b9e21a954619",
    "kvNamespaceId": "2f5ad113e1d24eb6b76ce6a95d3dc804",
    "apiToken": "<有 KV 读写权限的 API Token>"
  },
  "bark": { "key": "<Bark Key>" }
}
```

说明：
- `cnemc.cookie` 可留空，实际使用 `tools/local-sync/runtime/cnemc-cookie.txt`（脚本自动维护）；
- 首次可手动登录一次企业端，把 `jointframe.cluster.sessionid=...` 写入 `runtime/cnemc-cookie.txt`，或直接跑自动登录（见 5.3）。

### 4.3 冒烟验证（必须全部通过）

```bash
cd D:\Application\cloudflare-envsc
node tools\local-sync\run_scf_local.cjs 2026-10-24 1 --force
node tools\local-sync\hourly-alarm.cjs --date 2026-10-25 --hour 10 --dry-run --verbose
node tools\buildtext-test.mjs
```

预期：
- 同步输出 `ok=true`、`okCount=5`、`failCount=0`，日志出现 `SYNC_OK`；
- 小时告警 dry-run 能列出各点数值因子且 `missingStd=0`；
- 测试 `27/27 PASS`。

### 4.4 注册 Windows 计划任务

```powershell
$repo = "D:\Application\cloudflare-envsc"
$node = "D:\Application\NodeJs\node.exe"

# 1) 每日 14:40 正式同步（--quick 只同步 D-1）
$a1 = New-ScheduledTaskAction -Execute $node `
      -Argument "`"$repo\tools\local-sync\run_scf_local.cjs`" --quick" `
      -WorkingDirectory $repo
$t1 = New-ScheduledTaskTrigger -Daily -At "14:40:00"
$s1 = New-ScheduledTaskSettingsSet -StartWhenAvailable `
      -ExecutionTimeLimit (New-TimeSpan -Minutes 25) `
      -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "ENVSC-SCF-Local-Sync" -Action $a1 -Trigger $t1 -Settings $s1 -Force

# 2) 登录时补缺（--if-missing 只补缺，不覆盖 14:40 的结果）
$a2 = New-ScheduledTaskAction -Execute $node `
      -Argument "`"$repo\tools\local-sync\run_scf_local.cjs`" --if-missing" `
      -WorkingDirectory $repo
$t2 = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName "ENVSC-SCF-Local-Sync-Logon" -Action $a2 -Trigger $t2 -Settings $s1 -Force

# 3) 每小时 :20 超标告警
$a3 = New-ScheduledTaskAction -Execute $node `
      -Argument "`"$repo\tools\local-sync\hourly-alarm.cjs`"" `
      -WorkingDirectory $repo
$t3 = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddHours(0).AddMinutes(20) `
      -RepetitionInterval (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName "ENVSC-Hourly-Alarm" -Action $a3 -Trigger $t3 -Settings $s1 -Force
```

> 注意：一个任务的 action 只能带一套参数，所以「14:40 正式」和「登录补缺」必须是**两个任务**。

### 4.5 Worker（通常无需重建）

线上已有 `envsc`。只有需要改代码时才部署：

```bash
cd D:\Application\cloudflare-envsc
set CLOUDFLARE_API_TOKEN=<有 Workers/KV 权限的 Token>   # PowerShell: $env:CLOUDFLARE_API_TOKEN="..."
node "D:\Sionis\AppData\Roaming\npm\node_modules\wrangler\bin\wrangler.js" deploy --config "D:/Application/cloudflare-envsc/wrangler.toml"
```

> 实测坑：`--config` 用**正斜杠**更稳，反斜杠偶发进程被中断。
> 部署后可在 Cloudflare 控制台或 API 确认 Version ID；`wrangler tail envsc` 可看实时日志。

---

## 5. 目录与模块

```
cloudflare-envsc/
├── config/
│   ├── project.json          # 业务配置：psId、公司名、排除点、阈值、推送窗口、hourlyAlarm
│   └── standards.json        # 两层标准：A级 + 排放标准（见第 6 节）
├── src/                      # Cloudflare Worker（无构建，ESM）
│   ├── index.js              # 编排/入口（run、watchdog、/probe、/watchdog）
│   ├── config.js             # 读取 project.json + 启动校验
│   ├── core/{time,marks,judge,text}.js   # 纯函数
│   └── io/{public,enterprise,kv,push}.js # 取数/推送
├── tools/
│   ├── scf-marks-sync/index.js   # 标记同步核心（本机与云函数同一份）
│   ├── local-sync/
│   │   ├── run_scf_local.cjs     # 本机同步入口（cookie 校验/续期、KV 预检、告警）
│   │   ├── hourly-alarm.cjs      # 小时数据异常/超标告警
│   │   ├── lib/{log.js,exceed.js,yili-hourly-fallback.cjs} # 日志、判定、州平台兜底
│   │   ├── auto-login/           # Puppeteer 自动登录 + 滑块
│   │   ├── local-config.json     # 密钥（gitignore）
│   │   └── runtime/              # cookie、日志、factor-names.json（gitignore）
│   ├── push-now.mjs              # 手动生成/补推某天日报
│   ├── yili/                     # 伊犁州平台采集适配器 + 小时告警兜底数据源
│   │   ├── cli.mjs               # stations/factors/query/captcha/export/auth
│   │   ├── lib/{client,captcha,config,http,errors}.mjs
│   │   ├── captcha-model.json    # 200 原型验证码模型
│   │   └── runtime/              # token、验证码临时文件（gitignore）
│   ├── *-test.mjs                # 10 套回归测试（含 yili 两套）
│   └── dump-*.mjs / kv-read.py   # 诊断脚本
├── docs/{CREDENTIALS.md, HANDOVER.md}
├── .github/workflows/test.yml    # CI：push/PR 跑全部测试
└── wrangler.toml                 # Worker 配置（KV 绑定、cron、vars）
```

---

## 6. 配置说明

### 6.1 `config/project.json`

| 字段 | 用途 |
|---|---|
| `psId` | 企业端排污单位 ID（默认 `654000000031`） |
| `companyName` | 推送标题里的公司名 |
| `exclusions` | 不计入统计的监测点（如 3号机组停运时） |
| `thresholds` | 标记保留阈值：`autoMarkMinMinutes`（连续 ≥15min）、`autoMarkMinPerHour`（单小时累计 ≥15min） |
| `pushWindow` | 推送窗口（北京 15–21 点） |
| `hourlyAlarm` | 小时告警：`enabled`、`compare`、`minRatio`、`requireValid`、`maxItemsPerPush` |
| `backfill` | 维护期欠推日报：`enabled`、`startDate`（首次扫描起点）、`maxPerRun`（单次最多补几天，默认 3） |

### 6.2 `config/standards.json`（两层标准）

```json
{
  "a":     { "label": "A级标准", "_gas": { "001": 10, "508": 30 } },
  "legal": {
    "label": "排放标准",
    "_gas":    { "001": 30, "002": 100, "003": 100, "508": 100 },
    "3号机组":   { "002": 35, "003": 50 },
    "1号2号机组": { "002": 35, "003": 50 },
    "总排口":    { "001": "6-9", "011": 50, "060": 5 }
  }
}
```

- **A 级**：重污染天气绩效分级 A 级（颗粒物 10、非甲烷总烃 30）；
- **排放标准**：**配置值优先**，未配置的因子才用平台 `outlet_standard`；
  - 火电两机组：SO₂ 35、NOx 50（用户指定的超低排放口径；GB 13223-2011 表2 特别限值为 50/100，如需改回只改这两个数）；
  - 总排口：pH 6~9、COD 50、氨氮 5（GB 21903-2008 **表3 特别排放限值**）。
- 查找顺序：监测点名 → `_gas`（废气）→ `*`。
- 推送会明确说明超出哪层：`超A级标准 30，超 x%；未超排放标准 100` / `超排放标准 100，超 x%；A级标准 30 亦超`。

### 6.3 `wrangler.toml`

- `name = "envsc"`、`main = "src/index.js"`；
- `[[kv_namespaces]] binding = "ENVSC_KV"`；
- `[triggers] crons = ["0 7-12 * * *"]`；
- `[vars]`：`CNEMC_PSID`、`MAIL_FROM` 等（密钥不放这里，用 `wrangler secret`）。

---

## 7. 运行机制与关键约定

### 7.1 每日同步（本机 14:40）

`run_scf_local.cjs --quick`：

1. 读 KV `marks:<D-1>`，若「今天已写入 + 5 个点全成功」→ 跳过（`--force` 可忽略）；
2. 校验 cookie；无效则调用 `auto-login/auto-login.cjs`（puppeteer + Chrome + 滑块）；
3. 调 `tools/scf-marks-sync/index.js` 的 `main_handler`：
   - 因子清单优先 `GET /monitoritem/pollutant/list`（code↔名称），失败退回默认编码；
   - 抓 `rg_flag_*`（人工）/`zd_flag_*`（自动）分钟行；
   - 规则 A：连续标记 ≥15min；规则 B：单小时累计 ≥15min（含缺 1 采样点容错）；
   - **双写** `marks:<date>`（v1 文本）与 `marks:v2:<date>`（结构化）；
   - 载荷带 `sync:{okCount,failCount,mpsTotal,perMp}` 完备性信息；
4. 结果写 KV `local-task:status`；失败 Bark 告警（每天一次）；
5. 日志：`tools/local-sync/runtime/logs/scf-local-YYYY-MM-DD.log`（1MB×3 轮转）。

### 7.2 日报推送（Worker，15:00–20:00 整点）

- 目标日 = 北京时间 D-1；
- **双层就绪门控**：`begin-end-time.endTime >= 目标日`，且目标日 `transMpInfoList` 至少有一个监测点带传输率；任一不满足都返回 `not_ready`，不推送 0% 占位日报；
- 去重键 `2026-10-24` 形式的 KV key：推送成功才写；
- 若上次是「降级推送」（`marksSource=public`）且未升级，拿到分钟级标记后允许**再推一次完整版**（`upgraded:true`）；
- **欠推自动补推**：维护/412 导致某天失败时，将该日期写入 KV `backfill:pending`；平台恢复后每次整点先推 D-1，再用剩余配额从旧到新补推，单次最多 `backfill.maxPerRun` 天（默认 3），直到队列清空；
- 补推同样受日报去重键保护：已有成功记录不会重复推送；补推失败或未就绪的日期继续留在队列，下一整点重试；
- 数据源：
  - 公开平台 `psinfo/detail`（有效传输率）+ `psinfo/pollutant/list`（小时级标记，兜底）；
  - KV `marks:v2:<date>` / `marks:<date>`（按 `at` 取新，v2 优先）；
- 输出示例：

```
20261024有效传输率99.87%
异常监控点（1 / 5 个）：
· 环保尾气排放口　即时 99.3% / 补全 99.3%
自动标记：非甲烷总烃 校准 10:11~10:18(8min)
```

### 7.3 小时数据异常/超标告警（本机每小时 :20）

- 检查最近 **2 个已完成小时**（`--date/--hour` 可补跑）；
- 因子清单动态获取；废气用折算值（`view/list` 的 `avg_zs`，缺则实测），废水用实测；
- pH 用 `min_value_001` / `max_value_001` 与 6~9 区间比较；
- 主监测因子为 `数据有效` 但小时值为负 → 按数据异常推送；标题/分组为「小时数据异常」，去重 tier=`negative`；
- 企业端 cookie/监测点/某点某小时不可用时，按 `config/yili-hourly-map.json` 的固定站点 ID 改取州平台 `hour` 数据；正常时不访问州平台；
- 州平台只把 `N` 视为有效，`C/D/空` 不参与判定；废气优先 `zsValue`，pH 用 `metrics.min/max`；
- 去重键 `alarm:<date>:<hour>:<mp>:<code>:<tier>`（A 级/排放分开，先预警后升级会再推）；
- 状态写 KV `last-hourly-alarm`（checked/exceeded/exceededLegal/exceededA/negative/missingStd/sources）。

### 7.4 KV 键一览

| 键 | 用途 |
|---|---|
| `marks:<date>` / `marks:v2:<date>` | 分钟级标记（v1/v2 双写） |
| `<date>`（如 `2026-10-24`） | 日报去重 + 推送摘要（`marksSource`/`upgraded`） |
| `alarm:<date>:<hour>:<mp>:<code>:<tier>` | 小时告警去重（TTL 3 天） |
| `pubfail:<date>` | 公开平台故障告警幂等（TTL 2 天） |
| `last-result` | 最近一次 Worker 运行结果 |
| `last-hourly-alarm` | 最近一次小时告警结果 |
| `local-task:status` | 本机同步最近状态 |
| `cookieAlert:<date>` | cookie 失效告警幂等 |
| `backfill:pending` | 维护期欠推日期（JSON 数组，按日期升序；全部成功后为 `[]`） |
| `wd:<date>` | 看门狗历史幂等（告警已静音） |

---

## 8. 数据源与字段对照（重要，易踩坑）

### 8.1 企业端接口

| 用途 | 接口（经 `requestRoute!list.page?method=` 转发） |
|---|---|
| 监测点列表 | `/psbase/mpinfo/getMpInfoByPsId?psId=` |
| 排放口树 | `/psinfo/outlet/list?psId=` |
| 因子清单 | `/monitoritem/pollutant/list?mpId=&mpType=` |
| 小时数据 | `online-monitor/data/list`（`dateType=1`） |
| 折算序列 | `online-monitor/view/list` |
| 人工标记 | `/sign/qy/list`（`type=2`） |

### 8.2 因子编码（权威来自 `/monitoritem/pollutant/list`）

| 编码 | 名称 | 说明 |
|---|---|---|
| 001 | 颗粒物（废水为 pH） | |
| 002 | 二氧化硫 | |
| 003 | 氮氧化物 | |
| **508** | **非甲烷总烃** | 不是 005/010！ |
| 011 | 化学需氧量 | |
| **060** | **氨氮** | 不是 012 |
| B01/B02 | 流量 | |
| S01/S02/S03/S05/S08 | 氧含量/流速/温度/湿度/压力 | 工况参数，无标准 |

### 8.3 三个关键坑

1. **废水 mpType**：`getMpInfoByPsId` 返回总排口 `mpType=4`，但 `data/list` 必须用 **`mpType=1`**，否则只有标准值、数值全为 `--`（废水会完全漏判）。`hourly-alarm.cjs` 的 `queryMpType()` 已处理（4→1）。
2. **折算序列**：`view/list` 对 3号机组/1号2号机组有数据；两个尾气排口返回 0 行，此时用实测值（无需折算）。其 `label/prop` 是默认模板（不可靠），脚本按「实测值相等」对齐编码。
3. **pH 是区间**：标准为 `6-9`，接口给 `min_value_001`/`max_value_001`，不能用单值比较。

### 8.4 页面字段对照（截图核实）

企业端「数据监测」页：`/amOnline/zdjk-company-base/ctc__/__10__`（前端路由，直接 GET 会 404 但浏览器正常）。

| 页面列 | 接口字段 |
|---|---|
| 标干值 / 实测值 | `avg_value_<code>` |
| 标准值 | `outlet_standard_<code>` |
| 折算值 | `view/list` 的 `avg_zs` |
| 排放量 | 前端按流量×浓度计算，接口不直接给 |
| 设备标记 | `flag_<code>` |

---

## 9. 密钥与安全

| 密钥 | 位置 | 用途 |
|---|---|---|
| 企业端账号/密码 | `tools/local-sync/local-config.json` → `cnemc.account/password` | 自动登录 |
| 企业端 cookie | `tools/local-sync/runtime/cnemc-cookie.txt` | 抓标记/小时数据（约 7–8 天过期） |
| Cloudflare API Token | `local-config.json` → `cloudflare.apiToken` | KV 读写/部署 |
| Bark Key | `local-config.json` → `bark.key` | 推送 |
| GitHub Token | 仅临时环境变量 `GH_TOKEN` | 推送仓库（用完撤销） |

规则：
- `local-config.json`、`runtime/`、`node_modules/` 均已 gitignore；
- 仓库是公开的，**任何密钥都不得写进代码/文档/提交**；
- 轮换步骤见 `docs/CREDENTIALS.md`；
- 本机交接时，直接复制 `local-config.json` 与 `runtime/cnemc-cookie.txt` 即可，不要通过聊天/邮件明文传递。

---

## 10. 当前已知问题与待办（2026-10-25）

### 10.1 公开平台部分恢复，维护期数据尚未发布（阻塞日报）

- 2026-10-25 13:48 实测：`/region/begin-end-time` 已恢复 HTTP 200，但 `endTime` 仍为 **2026-10-22**；
- 10-23、10-24 的 `/psinfo/psinfo/detail` 虽返回 HTTP 200、`code=200`，但 `realtime=0`、`comple=0`、`transMpInfoList=[]`，属于**占位空数据**，不能据此生成 0% 日报；
- 维护公告 `https://www.envsc.cn/ErrPage/24yearcslError.html` 仍返回 HTTP 412；
- 影响：10-23、10-24 日报尚未推送（两天的日报去重键均不存在）；两天的分钟级标记已完整同步；
- 已处理：Worker 每天告警一次（`pubfail:<date>`），两天已持久化在 `backfill:pending`；数据未就绪时返回 `not_ready` 并**保留队列，不清空、不写日报去重键**；
- 恢复判定：目标日必须同时满足 `endTime >= 目标日` 且 `transMpInfoList` 有监测点数据；满足后 Worker 在 15:00–20:00 各整点自动从旧到新补推，单次最多 3 天，全部成功才清空队列。

### 10.2 其他

| 项 | 状态 |
|---|---|
| 10-24 标记 | 已预抓且完整（`total=0`，当天无标记）；平台数据发布后自动补推，待补 10-23、10-24 |
| v1 文本键兼容期 | 计划 2026-11-21 左右停写，仅保留 v2；Worker 已支持双键回退 |
| 腾讯云 SCF | 已欠费停用，两个触发器均停用；不要再依赖 |
| 邮件兜底 | 代码就位，缺 `RESEND_API_KEY`（未启用） |
| GitHub 推送 | 本机 `github.com` 不可达，现走 Cloudflare Worker `envsc-ghrelay` + 工作区脚本 `sync_github_worker.py`（源码在 `D:\Application\WorkBuddy\2026-10-16-10-19-34\ghrelay`，不在仓库内）；新客户端若可直连 GitHub 可直接 `git push` |
| cookie 过期 | 约 7–8 天；自动登录失败会 Bark 告警，需手动更新 `runtime/cnemc-cookie.txt` |

---

## 11. 运维手册

### 11.1 日常检查（1 分钟）

```bash
cd D:\Application\cloudflare-envsc
tail -5 tools\local-sync\runtime\logs\scf-local-2026-10-25.log
tail -5 tools\local-sync\runtime\logs\hourly-alarm-2026-10-25.log
```

看 KV 最近状态：

```bash
curl "https://api.cloudflare.com/client/v4/accounts/<ACC>/storage/kv/namespaces/<NS>/values/last-result" -H "Authorization: Bearer <TOKEN>"
curl "https://api.cloudflare.com/client/v4/accounts/<ACC>/storage/kv/namespaces/<NS>/values/last-hourly-alarm" -H "Authorization: Bearer <TOKEN>"
```

### 11.2 常用命令

```bash
# 同步（只 D-1）
node tools\local-sync\run_scf_local.cjs --quick
# 强制重抓某天
node tools\local-sync\run_scf_local.cjs 2026-10-24 1 --force
# 仅刷新 cookie
node tools\local-sync\auto-login\auto-login.cjs
# 小时告警演练（指定小时，打印不推送）
node tools\local-sync\hourly-alarm.cjs --date 2026-10-25 --hour 10 --dry-run --verbose
# 强制州平台兜底演练
node tools\local-sync\hourly-alarm.cjs --date 2026-10-25 --hour 10 --dry-run --verbose --yili-only
# 补推某天日报（需 CF_ACC/CF_NS/CF_TOK + BARK_KEY）
node tools\push-now.mjs 2026-10-24
# 全量测试
for %f in (buildtext marksv2 merge windows hourly-alarm watchdog pubfail backfill yili-hourly-fallback) do node tools\%f-test.mjs
```

### 11.3 故障排查表

| 现象 | 原因 | 处理 |
|---|---|---|
| 同步 `FATAL: say is not defined` | 模块级函数误用 `say`（10-24 事故，已修） | 更新代码；确认 `loadFactorNames(..., logger)` |
| `cookie 无效且自动登录失败` | cookie 过期 + 登录页慢/滑块失败 | 手动跑 `auto-login.cjs`；仍失败则手动写 cookie |
| 同步成功但标记无因子名 | 公开平台因子名接口被拦 | 已自动回退企业端 `/monitoritem/pollutant/list`；看日志 `FACTOR_FALLBACK` |
| 废水全是 `--` | 用了 `mpType=4` | 改 `mpType=1`（`queryMpType` 已处理） |
| 日报未生成/补推积压 | 公开平台维护/412 | 看 `last-result.backfill.pendingDates`；Worker 每天告警一次，恢复后 15–20 点自动补推 |
| Worker 部署中断 | wrangler 反斜杠 config | 用正斜杠 `--config "D:/.../wrangler.toml"` |
| GitHub 推送 403 | Token 缺 Contents 或 Workflows 权限 | 补权限；`.github/workflows/*` 需 Workflows: Read and write |
| 计划任务没跑 | 电脑关机/休眠 | 任务设为 `StartWhenAvailable`，开机补跑（可能晚于 15:00） |
| 小时告警无数据 | 该小时未发布/flag 非「数据有效」 | 属正常；`missingStd` 可在 `standards.json` 补 |
| 企业端小时取数失败 | cookie/内网/接口故障 | 看日志 `FALLBACK`；脚本会自动改取州平台，`sources.yiliRows` 可见兜底行数 |

---

## 12. 验收清单（接管后逐项打勾）

- [ ] `run_scf_local.cjs --force` 输出 `ok=true / okCount=5 / failCount=0`
- [ ] KV 存在 `marks:<昨天>` 与 `marks:v2:<昨天>`，且 `sync.perMp` 5 个点全 `ok`
- [ ] `hourly-alarm.cjs --dry-run --verbose` 能列出 5 个点的数值因子，`missingStd=0`
- [ ] 三个计划任务状态 `Ready`，NextRun 分别为 14:40 / 登录时 / 每小时 :20
- [ ] Bark 测试消息能收到（`curl -X POST https://api.day.app/<key> -H "Content-Type: application/json" -d '{"title":"test","body":"ok"}'`）
- [ ] 全量测试 **217/217 PASS**（既有点位 151 + 伊犁适配器 45 + 小时兜底 21）
- [ ] `node tools/yili/cli.mjs stations` 返回 9 个监测点
- [ ] 废气实时 17275 行按 4 页取全，`dt` 唯一
- [ ] `--yili-only --dry-run --verbose` 能列出 5 个点，且 `1号2号机组/3号机组` 的 NOx/SO₂/颗粒物与企业端同小时一致
- [ ] `last-result.backfill.pendingDates` 与 KV 实际缺失日期一致，恢复后自动清空
- [ ] Worker 定时为 `0 7-12 * * *`，`last-result` 可读
- [ ] 仓库 `main` 与本地树一致（或已知差异）

---

## 13. 近期关键变更

| 提交 | 内容 |
|---|---|
| 本次提交（2026-10-26） | 小时告警增加数据有效负值异常：tier=`negative`，标题/分组改为「小时数据异常」；新增 7 项回归测试 |
| 上一提交（2026-10-26） | 小时告警新增伊犁州平台兜底：5 对固定站点映射、N/C/D 有效性、折算/pH 区间、小时缓存、`--yili-only` 演练；新增 21 项回归测试 |
| `d59c326` | 新增伊犁州平台采集分支：自动验证码、token 续期、9 点/四类数据、URL 分页完整性校验、JSON/CSV/XLSX；45 项适配器测试 |
| 本地未提交（2026-10-25） | 维护期欠推自动补推；双层就绪门控；`not_ready` 保留队列；Node 24（本机/CI/`engines`）；新增 19 项补推回归 |
| `ab807e2` | 修复 10-24 `say` 崩溃；企业端因子名兜底；Worker 失败每天告警；新增 pubfail 测试 |
| `673ee46` | 废水因子接入（mpType=1）；pH 区间判定；火电 SO₂ 35/NOx 50；总排口 COD 50/氨氮 5 |
| `80b03bb` | 平台排放标准核实并写入 legal 兜底层 |
| `887f9c6` | 双层标准判定；纠正非甲烷总烃=508、氨氮=060 |
| `761f17ad` | Worker 巨石拆分（core/io）+ 窗口算法单测 + 性能优化 + CI |
| `83139fc` | marks v2 结构化契约（双写 + 按 at 取新） |

---

## 14. 联系与升级

- 代码/部署问题：先看本文第 11 节与 `docs/CREDENTIALS.md`；
- 企业端账号/权限：找平台管理员（账号与密码见 `tools/local-sync/local-config.json`，勿外传）；
- 公开平台维护：关注 `https://www.envsc.cn/ErrPage/24yearcslError.html` 是否恢复；
- 紧急停用推送：暂停 `ENVSC-SCF-Local-Sync` / `ENVSC-Hourly-Alarm` 两个计划任务，或在 `local-config.json` 清空 `bark.key`。

---

## 15. 伊犁州平台适配器（2026-10-26 新增）

- 入口：`node tools/yili/cli.mjs`；说明见 `tools/yili/README.md`；
- 分支：GitHub `伊犁州生态环境数字化监控平台`；
- 已验证：自动登录、9 个监测点、四类数据；废气实时 17275 行按 4 页取全且时间唯一；
- 关键约束：`pageNum/pageSize` 必须同时放 URL query；只放请求体会固定返回 10 行；
- 凭据：`YILI_USERNAME/YILI_PASSWORD` 环境变量或 `tools/yili/local-config.json`；token 缓存 `tools/yili/runtime/token.json`，均不入库；
- 测试：`node tools/yili-test.mjs`（45 项）、`node tools/yili-hourly-fallback-test.mjs`（21 项）；
- 小时数据异常/超标兜底：`config/yili-hourly-map.json` 固定 5 对站点；1#/2# 已用 2026-10-25 10 时逐值核实为“1号2号机组/3号机组”；
- 兜底口径：仅 `N` 有效，废气优先 `zsValue`，pH 用 `metrics.min/max`，沿用企业端标准与去重键；公开平台无完整小时浓度序列，不参与该兜底判定；
- 演练：`node tools/local-sync/hourly-alarm.cjs --date 2026-10-25 --hour 10 --dry-run --verbose --yili-only`。
