# local-sync —— 本机执行标记同步（云函数不可用时的兜底）

云函数（腾讯云 SCF / 阿里云 FC）不可用或欠费时，由本机计划任务在**每天 14:40** 完成：
「校验/续期企业端 cookie → 抓取 D-1 标记 → 写入 Cloudflare KV」，供 15:00 的日报推送使用。

## 组成

| 文件 | 作用 |
|---|---|
| `run_scf_local.cjs` | 主脚本：查 KV 是否已同步 → 确保 cookie 有效（无效则调 `auto-login`）→ 调 `tools/scf-marks-sync/index.js` 的 `main_handler` 抓取并写 KV → 失败发 Bark 告警（每天一次） |
| `auto-login/auto-login.cjs` | 自动登录企业端：puppeteer-core + 本机 Chrome，滑块由 canvas 差值 + 合成 pointer 事件破解；校验通过后写 `runtime/cnemc-cookie.txt` |
| `auto-login/debug-login.cjs` | 页面改版时调试用：导出输入框/按钮/滑块结构并截图 |
| `hourly-alarm.cjs` | **小时超标告警**：每整点检查最近 2 个已完成小时，按「废气折算值 / 废水实测值」与标准值比较，超标推 Bark（去重） |
| `lib/exceed.js` | 超标判定纯函数（可单测；`tools/hourly-alarm-test.mjs` 覆盖） |
| `lib/log.js` | 共享日志（1MB 轮转） |
| `local-config.example.json` | 配置模板，复制为 `local-config.json` 并填入密钥（**已被 gitignore**） |

运行时数据都在 `runtime/`（**已被 gitignore**）：`cnemc-cookie.txt`、`logs/`。

## 安装

```bash
cd tools/local-sync/auto-login
npm install puppeteer-core --registry=https://registry.npmmirror.com
cp ../local-config.example.json ../local-config.json   # 填入账号/密码/CF 凭据/Bark key
```

## 手动运行

```bash
node tools/local-sync/run_scf_local.cjs --quick                 # 只同步 D-1（定时任务用，约 30-40 秒）
node tools/local-sync/run_scf_local.cjs 2026-10-20 2 --force    # 指定日期与天数，忽略"今日已同步"检查
node tools/local-sync/auto-login/auto-login.cjs                 # 仅刷新 cookie
node tools/local-sync/hourly-alarm.cjs                          # 小时告警（最近 2 个已完成小时）
node tools/local-sync/hourly-alarm.cjs --date 2026-10-22 --hour 11 --dry-run --verbose  # 指定小时演练
```

## 小时超标告警

平台没有推送能力，只能查询。`hourly-alarm.cjs` 在本机补齐「轮询 → 判定 → 推送」：

| 项 | 说明 |
|---|---|
| 数据源 | 企业端 `online-monitor/data/list`（小时行：`avg_value_<code>` 实测、`outlet_standard_<code>` 标准、`flag_<code>` 有效性）+ `online-monitor/view/list`（`avg_zs[]` 折算序列）；因子清单取自 `/monitoritem/pollutant/list` |
| 因子编码 | 动态获取（**非甲烷总烃=508**、颗粒物=001、二氧化硫=002、氮氧化物=003、化学需氧量=011、氨氮=060），避免编码猜错导致漏判 |
| 判定口径 | **废气用折算值**（`avg_zs`，缺失时退回实测）；**废水（mpType=4）用实测值**（平台无折算）；仅 `flag=数据有效` 参与；严格大于标准 |
| 两层标准 | `a` = 重污染天气绩效分级 A 级（颗粒物 10、非甲烷总烃 30）；`legal` = 排放标准（**配置值优先**，未配置的因子用平台 `outlet_standard`）。火电两机组 SO₂ 35、NOx 50（GB 13223-2011 超低排放口径）；总排口 pH 6~9、COD 50、氨氮 5（GB 21903-2008 表3 特别排放限值） |
| 文案 | 仅超 A 级：`超A级标准 30，超 x%；未超排放标准 100`（标题「A级预警」）；两层均超：`超排放标准 100，超 x%；A级标准 30 亦超`（标题「小时超标」） |
| 覆盖时段 | 默认最近 2 个已完成小时（数据晚到可在下一小时补上），也可 `--date/--hour` 指定 |
| 去重 | KV `alarm:<日期>:<小时>:<监测点>:<因子>:<层级>`（TTL 3 天） |
| 推送 | Bark，`group=小时超标`、`level=timeSensitive`；一次运行合并为一条 |
| 状态 | KV `last-hourly-alarm`（checked/exceeded/exceededLegal/exceededA/pushed/missingStd） |
| 配置 | `config/project.json` → `hourlyAlarm`：`enabled` / `compare=auto` / `minRatio` / `requireValid` / `maxItemsPerPush` |

> 标准表查找顺序：监测点名 → `_gas`（废气通用）→ `*`；`ENVSC_STANDARDS_FILE` 可指定临时表用于演练。

### 字段与页面核对（2026-10-23）

- 页面：`http://116.178.28.170:3080/amOnline/zdjk-company-base/ctc__/__10__`（“数据监测”，
  前端路由；直接用 curl GET 该路由会返回 404，但页面在浏览器内由 SPA 正常渲染）。
- 页面列 ↔ 接口字段：**标干值** = `avg_value_<code>`、**标准值** = `outlet_standard_<code>`、
  **设备标记** = `flag_<code>`；排放量为前端按流量×浓度计算，接口不直接提供。
- 实测对照（2026-10-23 15~16 环保尾气排放口）：页面标干值 **3.291**、标准值 **100**，
  接口 `avg_value_508=3.291`、`outlet_standard_508=100`，逐位一致 → **非甲烷总烃 `code=508`**。
- 因子编码以 `/monitoritem/pollutant/list?mpId=&mpType=` 为准；`005/010` 不是非甲烷总烃
  （005 恒 0.011、010≈0.35，且长期 `flag=故障`），不要再用它们判定 NMHC。
- 平台排放标准核实（2026-10-23）：1号2号机组 10-23 17 时 颗粒物 **30**、二氧化硫 **100**、
  氮氧化物 **100**；环保尾气 15 时 非甲烷总烃 **100**——与接口 `outlet_standard_<code>` 逐一对应。
  按用户指定的法定限值，火电两机组 SO₂ **35**、NOx **50** 已写入 `legal`（配置覆盖平台值）。
- 废水：总排口对应 getMpInfo 返回的 **mpType=4**，但 `data/list` 必须用 **mpType=1** 查询，
  否则只有标准值、数值全为 `--`（2026-10-23 实测）；pH 用 `min_value_001` / `max_value_001` 判定。
  限值按 GB 21903-2008 表3 特别排放限值：pH **6~9**、COD **50**、氨氮 **5**（与截图一致）。

> 说明：`view/list` 的 `label`/`prop` 字段用的是平台默认模板（不可靠），脚本按「实测值相等」把折算序列对齐到因子编码；
> 平台未配置标准值的因子（`outlet_standard` 为空）无法判定，会被跳过（对应平台「未设上下限」情形）。

### Windows 计划任务（每小时 :20）

```powershell
$action  = New-ScheduledTaskAction -Execute "<node.exe 绝对路径>" `
           -Argument '"<仓库路径>\tools\local-sync\hourly-alarm.cjs"' `
           -WorkingDirectory "<仓库路径>"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddHours(0).AddMinutes(20) `
           -RepetitionInterval (New-TimeSpan -Hours 1)
$set     = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
           -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "ENVSC-Hourly-Alarm" -Action $action -Trigger $trigger -Settings $set -Force
```

## Windows 计划任务（每天 14:40）

```powershell
$action  = New-ScheduledTaskAction -Execute "<node.exe 绝对路径>" `
           -Argument '"<仓库路径>\tools\local-sync\run_scf_local.cjs" --quick' `
           -WorkingDirectory "<仓库路径>"
$trigger = New-ScheduledTaskTrigger -Daily -At "14:40"
$set     = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 15) `
           -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "ENVSC-SCF-Local-Sync" -Action $action -Trigger $trigger -Settings $set -Force
```

## 说明与注意

- **幂等**：先读 KV `marks:<日期>.at`，若已是今天则跳过，避免与云端重复抓取；
- **cookie 续期**：`auto-login` 只在 cookie 失效时触发（约 7~8 天一次），每次耗时约 40 秒；
- **失败告警**：同步或续期失败会发 Bark（每天最多一条），不会静默；
- 本机需开机；若 14:40 未开机，任务会在开机后补跑（可能晚于 15:00 推送）；
- 企业端改版可能导致自动登录失效：先跑 `auto-login/debug-login.cjs` 看页面结构，再调整选择器；
- 账号密码只存在于 `local-config.json`（本机），不要提交到仓库。
