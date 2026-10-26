# 伊犁州生态环境数字化监控平台采集适配器

本目录是 `cloudflare-envsc` 的独立数据采集分支，用于访问伊犁哈萨克自治州州级监测平台（万维盈创）的监测点、因子和原始数据。适配器不会修改现有 Worker、日报推送或分钟标记同步逻辑。

平台入口：<https://yili.wanweitech.cn:58298>

## 能力

- 自动获取测点树，当前账号下已验证 9 个川宁生物监测点；
- 查询实时、分钟、小时、日四类原始数据；
- 自动读取因子元数据、单位、上下限和动态上送字段；
- 自动识别四位算术验证码，失败后刷新重试，最多 4 次；
- 本地缓存 token，失效后自动重登一次；
- 按 `pageNum/pageSize` 分页取全，并校验总行数、缺页和重复时间；
- JSON、CSV 输出，或调用平台原生 XLSX 导出。

## 安装与凭据

需要 Node.js 24+：

```powershell
cd D:\Application\cloudflare-envsc
npm install
Copy-Item tools\yili\local-config.example.json tools\yili\local-config.json
```

编辑 `tools/yili/local-config.json`，或改用环境变量：

```powershell
$env:YILI_USERNAME = '<账号>'
$env:YILI_PASSWORD = '<密码>'
node tools/yili/cli.mjs auth
```

`local-config.json`、`runtime/`、`exports/` 均已被 `.gitignore` 忽略。token 缓存在 `tools/yili/runtime/token.json`，不要复制或提交。

平台证书链无法被 Node 默认信任，示例配置默认设置 `verifyTls=false`。只有在受控网络中使用该设置；如后续平台修复证书，应改为 `true`。

## 常用命令

```powershell
# 登录并查看当前用户
node tools/yili/cli.mjs auth

# 9 个监测点
node tools/yili/cli.mjs stations
node tools/yili/cli.mjs stations --format csv --output tools\yili\exports\stations.csv

# 因子清单
node tools/yili/cli.mjs factors --station 川宁生物废水总排口 --type realtime

# 四类数据；默认查今天
node tools/yili/cli.mjs query --station 川宁生物废水总排口 --type realtime --date 2026-10-25
node tools/yili/cli.mjs query --station 川宁生物废水总排口 --type minute --date 2026-10-25
node tools/yili/cli.mjs query --station 川宁生物废水总排口 --type hour --date 2026-10-25
node tools/yili/cli.mjs query --station 川宁生物废水总排口 --type day --date 2026-10-25

# 自定义时间与输出格式
node tools/yili/cli.mjs query --station 川宁生物2#废气排放口 --type hour `
  --start "2026-10-25 08:00" --end "2026-10-25 12:00" `
  --format csv --output tools\yili\exports\gas-hour.csv

# 平台原生 XLSX 导出
node tools/yili/cli.mjs export --station 川宁生物废水总排口 --type hour `
  --date 2026-10-25 --output tools\yili\exports\water-hour.xlsx
```

`--show-type auto|RTD|ZS` 控制显示口径。`auto` 会先调用 `stationHasZs`：支持折算值时返回 `ZS`，否则返回 `RTD`。标准化行同时保留实测值 `value` 与折算值 `zsValue`。

## 数据类型与字段

| `--type` | `cnType` | 主要字段 |
|---|---|---|
| `realtime` | `2011` | `RTD_<code>` / `ZSRTD_<code>` |
| `minute` | `2051` | `AVG_/MAX_/MIN_/COU_<code>` 与 `ZS...` |
| `hour` | `2061` | 同上 |
| `day` | `2031` | 同上 |

每行还包含 `FLAG_<code>`、`MANUAL_FLAG_<code>` 和 `dt`。CLI 会把动态列转换为 `rows[].values[因子编码]`，并附带因子名、单位、上下限、实测值、折算值、标记与统计值。

## 验证码

默认自动识别。模型 `captcha-model.json` 由 200 个人工标注的四位算术验证码原型构成，约 309 KB；只提交模型，不提交样本图片。

必要时可走人工兜底：

```powershell
node tools/yili/cli.mjs captcha --output tools\yili\runtime\captcha.jpg
# 打开图片，算出结果后复用同一 UUID 登录
node tools/yili/cli.mjs auth --captcha 8
```

待用验证码保存在 `runtime/captcha.json`，有效期 5 分钟。验证码错误会刷新后重试；账号或密码错误不会循环刷新。

## 分页约束

`dataQuery` 的 `pageNum` 和 `pageSize` 必须同时放在 URL query，仅放请求体时服务端固定返回 10 行。适配器会同时放入 query 与请求体。`pageSize` 上限实测为 5000；例如废气实时一天约 17275 行，需要 4 页。

取全后会执行三项校验：

1. 每页行数符合 `total` 计算值；
2. 合并行数等于 `total`；
3. 时间 `dt` 不重复。

任一失败都会抛出 `DATA_INCOMPLETE`，避免静默生成残缺导出。

## 测试

```powershell
node tools/yili-test.mjs
```

测试覆盖登录包装、验证码算术、token 缓存、树扁平化、水/气动态字段、5000 条分页、缺页/重复时间检测、验证码重试和 token 过期重登。

## 已知限制

- 州平台接口和证书可能变化；请求失败会返回 `API_ERROR`、`AUTH_ERROR` 或 `DATA_INCOMPLETE` 等分类错误；
- 自动验证码识别不是 100%，但单次失败会刷新重试；
- 实时数据仍在增长时，跨页查询可能遇到总数变化；历史日期查询稳定；
- 当前适配器只读取数据，不写入平台。
