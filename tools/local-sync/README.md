# local-sync —— 本机执行标记同步（云函数不可用时的兜底）

云函数（腾讯云 SCF / 阿里云 FC）不可用或欠费时，由本机计划任务在**每天 14:40** 完成：
「校验/续期企业端 cookie → 抓取 D-1 标记 → 写入 Cloudflare KV」，供 15:00 的日报推送使用。

## 组成

| 文件 | 作用 |
|---|---|
| `run_scf_local.cjs` | 主脚本：查 KV 是否已同步 → 确保 cookie 有效（无效则调 `auto-login`）→ 调 `tools/scf-marks-sync/index.js` 的 `main_handler` 抓取并写 KV → 失败发 Bark 告警（每天一次） |
| `auto-login/auto-login.cjs` | 自动登录企业端：puppeteer-core + 本机 Chrome，滑块由 canvas 差值 + 合成 pointer 事件破解；校验通过后写 `runtime/cnemc-cookie.txt` |
| `auto-login/debug-login.cjs` | 页面改版时调试用：导出输入框/按钮/滑块结构并截图 |
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
