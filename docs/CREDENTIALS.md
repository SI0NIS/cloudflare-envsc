# 凭据清单与轮换 SOP

> 本项目所有敏感凭据**不入仓库**。下表是全部凭据的存放位置、用途与轮换方法。
> 轮换后请同步更新本地/线上，避免「改了 A 忘了 B」导致静默失效。

## 1. Cloudflare 侧（推送层）

| 凭据 | 位置 | 用途 | 轮换方法 |
|---|---|---|---|
| `CLOUDFLARE_API_TOKEN`（cfat_...） | 本机脚本/部署命令（未落盘入仓） | 部署 Worker、读写 KV、GitHub 中继 | CF 控制台 → API Tokens → 重新生成，更新部署命令 |
| `BARK_KEY` | Worker secret（`wrangler secret put`）+ `tools/local-sync/local-config.json` | 手机推送 | Bark App 里重置 key，两处同步更新 |
| `RESEND_API_KEY` / `MAIL_TO` / `MAIL_FROM` | Worker secret | 邮件兜底 | Resend 后台重置，`wrangler secret put` 更新 |
| `CNEMC_COOKIE` | Worker secret（直连兜底用，边缘通常不可达） | 企业端直连兜底 | 见 §3 |
| `MARKS_PROXY_URL` / `MARKS_PROXY_TOKEN` | Worker secret（可选） | HTTPS 中继 | 中继侧重置 token 后同步 |

KV 命名空间 id、账号 id 为非敏感，在 `wrangler.toml` 与 `local-config.json` 中。

## 2. 本机侧（同步层）

| 凭据 | 位置 | 用途 | 轮换方法 |
|---|---|---|---|
| 企业端账号 `cnemc.account` / 密码 `cnemc.password` | `tools/local-sync/local-config.json` + `auto-login.cjs` | 自动登录续期 cookie | 改密码后两处同步更新 |
| `cnemc.cookie` | `local-config.json`（可选）+ `runtime/cnemc-cookie.txt`（运行时自动维护） | 企业端会话 | **自动续期**：`run_scf_local.cjs` 校验失效时调 `auto-login.cjs` 重登；平均 7–8 天过期 |
| `cloudflare.accountId / kvNamespaceId / apiToken` | `local-config.json` | 本机读写 KV | apiToken 在 CF 后台重置后更新 |
| `bark.key` | `local-config.json` | 同步失败告警 | 与 §1 的 BARK_KEY 保持一致 |

## 3. GitHub 侧（同步通道）

| 凭据 | 位置 | 用途 | 轮换方法 |
|---|---|---|---|
| GitHub fine-grained PAT（`github_pat_...`） | **仅命令行临时传 `GH_TOKEN`**，不落盘 | 推送提交到 `SI0NIS/cloudflare-envsc` | 用后到 Settings → Developer settings → Fine-grained tokens 撤销；下次推送再生成新的 |

注意：PAT 会短暂写入 Cloudflare KV 的 `ghrelay:job`（推送脚本用完即删）；请勿在 PAT 生命周期内授予多余权限（仅该仓库 `Contents: Read and write`）。

## 4. 已知到期特征

| 凭据 | 到期特征 | 处置 |
|---|---|---|
| 企业端 cookie | 约 7–8 天；失效表现为 `code=401 用户信息已过期` | 自动续期；续期失败会 Bark 告警（每天一次） |
| GitHub PAT | 用户手动撤销，或长期未用 | 每次推送前现取现用 |
| CF API Token | 手动撤销 | 部署/写 KV 时报 401 时检查 |

## 5. 兜底：凭据失效的可见性

- 本机同步失败 → `run_scf_local.cjs` 发 Bark（每天一次）+ 写 KV `local-task:status`；
- 分钟级标记缺失 → Worker 推送正文尾部显式标注「分钟级标记未同步」；
- Worker 自检结果 → KV `last-watchdog`（告警已静音，仅排查用）。
