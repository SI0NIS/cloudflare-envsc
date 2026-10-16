# envsc-daily-push · Daily Push for Enterprise Online-Monitoring Anomaly Marks

[简体中文](README.md) | [English](README.en.md)

The **effective transmission rate** of enterprise pollution-source automatic monitoring data is published daily on the public platform, but the **anomaly marks** (shutdowns, manually filed reports, system-auto-detected outages) are scattered across several pages of the enterprise-side platform — logging in and checking them every day is tedious.

This project fully automates that routine: **it checks the transmission rate on schedule every day, and the moment any abnormal monitoring point or anomaly mark shows up, it pushes straight to your phone (Bark / email)** — no need to log in to any platform; the notification alone tells you which stack/outlet had an issue, what kind, and at exactly what time.

## Push Examples

**① All compliant (100% — title only, no noise):**

```
20261007有效传输率100%
```
*(Title format: `YYYYMMDD 有效传输率/transmission rate 100%`)*

**② Abnormal monitoring points / anomaly marks (title + full body):**

```
20260928有效传输率99.86%

异常监控点（2 / 8 个）：
· 3号机组　即时 100% / 补全 98.62%
自动标记：二氧化硫/氮氧化物 校准 14:05~14:33(29min)；故障 14:41~17:28(168min)
· 总排口　即时 100% / 补全 95.83%（≤1h 标样核查，已豁免）
人工标记：化学需氧量/氨氮 标样核查-自动标样核查运行 13:21~14:06(46min)
```
*(Body format: "Abnormal monitoring points (2 / 8): · Unit 3 — realtime 100% / completion 98.62%; Auto mark: SO2/NOx calibration 14:05~14:33(29min); fault 14:41~17:28(168min); · Wastewater outlet — realtime 100% / completion 95.83% (≤1h standard-sample check, exempted); Manual mark: COD/NH3-N standard-sample check 13:21~14:06(46min)")*

**③ Monitoring point shutdown (excluded from statistics):**

```
· 3号机组（工况标记：停运，不计入有效传输率统计时段）
```
*("Unit 3 — operating-condition mark: shutdown, excluded from transmission-rate statistics")*

**④ When the mark-sync function's cookie expires, a separate Bark alert fires** (at most once per day) to remind you to refresh the session.

Push channels: **Bark as primary** (free iOS app over public HTTPS); **email as fallback** (Resend HTTP API, auto-sent when Bark fails; optional — without it only Bark is used).

## How It Works

```
                     ┌──────────────────────────────────────────┐
                     │            Data sources (3 legs)         │
                     ├──────────────────────────────────────────┤
                     │ ① Public platform jkzx.envsc.cn          │
                     │    Transmission rate (company + per-point)│
                     │    Public marks (hour-level coarse types) │
                     ├──────────────────────────────────────────┤
                     │ ② Enterprise monitoring platform         │
                     │    (reachable only from mainland China)   │
                     │    Minute-level auto marks + manual marks │
                     │    ↳ Cloud function scrapes daily 12:55   │
                     │      and writes to Cloudflare KV          │
                     │    ↳ or via HTTPS relay (optional)        │
                     ├──────────────────────────────────────────┤
                     │ ③ Direct enterprise fallback (last resort)│
                     └──────────────────────────────────────────┘
                                        │
                                        ▼
            ┌───────────────────────────────────────────────┐
            │        Cloudflare Worker (free-tier)          │
            │  cron: 15:00–20:00 CST, every hour (6 runs)   │
            │                                               │
            │  KV dedup ─► readiness gate ─► judge ─► text  │
            │                                     │         │
            │                        Bark (main) ─┤         │
            │                        Email (fb) ──┘         │
            └───────────────────────────────────────────────┘
```

Core mechanisms:

| Mechanism | Description |
|---|---|
| **Readiness gate** | Queries the platform's `begin-end-time` API first to confirm D-1 data is published; otherwise returns `not_ready` and defers to the next hourly run |
| **KV dedup** | Writes the dedup key only after a successful push, so the 6 daily runs result in exactly one push; failures don't write the key, so the next hour naturally retries |
| **Multi-source mark merging** | Minute-level KV marks **override** hour-level public marks per monitoring point; the source is truthfully recorded (`kv`/`public`/`kv+public`/`relay`) for easy auditing |
| **Watchdog** | After 13:05 CST the Worker self-checks whether today's marks landed in KV — an arrears-frozen cloud function fails silently, and the watchdog raises a Bark alert |

**Judging & message rules** (`buildText`, covered by 27 regression tests):

- **Abnormal point** = under-threshold ∪ shutdown-excluded ∪ has substantive marks;
- **Wastewater exemption**: per the official algorithm, wastewater outlets may exclude up to 1 hour/day for standard-sample checks — a rate ≥ 95.83% counts as compliant; **auto marks inside the exempt window don't trigger a push** (only manual filings do; auto marks are still displayed);
- **Manual marks take precedence over auto marks**: an auto-mark segment fully covered by a manual segment is suppressed; partial overlaps keep both (the two channels are independent and complementary);
- **Standard-sample-check segments are exempt from coverage suppression**: they still display when overlapping other anomaly windows;
- Company rate at 100% with no anomalies → **title-only push** at `active` level; otherwise title + body at `timeSensitive` level.

## Repository Layout

```
cloudflare-envsc/
├── src/index.js            # Worker main: fetch, judge, compose, push, watchdog (single file, no build step)
├── wrangler.toml           # Worker config: cron, vars, KV binding
├── tools/
│   ├── scf-marks-sync/     # Mark-sync cloud function (one codebase for Tencent SCF / Alibaba FC)
│   ├── fc-deploy.py        # One-command function deploy (Alibaba FC)
│   ├── rotate-aliyun-key.py# Alibaba Cloud AccessKey rotation helper
│   ├── _aliyun_env.py      # Unified credential loading (env vars first, then tools/.env.aliyun)
│   ├── push-now.mjs        # Local re-push / preview for a given date (reads KV snapshot)
│   ├── kv-read.py          # Read/inspect KV contents
│   ├── buildtext-test.mjs  # Message-format regression tests (27 cases)
│   ├── merge-test.mjs      # Mark-merging regression tests (28 cases)
│   ├── watchdog-test.mjs   # Watchdog regression tests
│   └── dump-*.mjs          # Raw-API diagnostic scripts for each data source
├── relay/                  # Enterprise HTTP → HTTPS relay (fly.io/Render/Docker, authenticated)
└── docs/                   # Upstream API documentation
```

## Deployment

### 0. Prerequisites

- Node.js ≥ 18 (with npm);
- A Cloudflare account (free tier is enough);
- [Bark](https://apps.apple.com/app/bark-customed-notifications/id1403753865) installed on an iOS device (push channel);
- Optional: a [Resend](https://resend.com) account (email fallback);
- Optional but recommended: an Alibaba Cloud Function Compute (FC) or Tencent Cloud SCF account for minute-level mark scraping (generous free tiers);
- A session cookie for the enterprise platform (obtained by logging in via browser with an account granted by the platform operator; used to scrape minute-level marks).

### 1. Deploy the Worker (~3 minutes)

```bash
git clone https://github.com/SI0NIS/cloudflare-envsc.git
cd cloudflare-envsc
npm install

# Create the KV namespace for dedup/mark storage, then paste the returned id
# into the [[kv_namespaces]] section of wrangler.toml
npx wrangler kv namespace create ENVSC_KV

# Store secrets (interactive input; never written to disk or the repo)
npx wrangler secret put BARK_KEY            # Bark device key (required)

# Deploy (also registers the cron trigger)
npx wrangler deploy
```

### 2. (Recommended) Deploy the mark-sync cloud function

Everything works without this step — the Worker degrades to the public platform's hour-level marks. For minute-level start/end times and manual filings, deploy the cloud function:

```bash
cd tools
export ALIBABA_CLOUD_ACCESS_KEY_ID=...
export ALIBABA_CLOUD_ACCESS_KEY_SECRET=...
export ALIYUN_ACCOUNT_ID=<Alibaba main-account UID>   # FC 3.0 endpoints require the UID

FENV_CNEMC_COOKIE='jointframe.cluster.sessionid=xxx' \
FENV_CF_ACCOUNT_ID=<Cloudflare account ID> \
FENV_CF_KV_NAMESPACE_ID=<KV id from step 1> \
FENV_CF_API_TOKEN=<API token with KV write permission> \
FENV_BARK_KEY=<same as step 1> \
FENV_CNEMC_PSID=654000000031 FENV_DAYS=2 \
python fc-deploy.py                          # create/update the function + 12:55 trigger
python fc-deploy.py --invoke '{"dry":true}'  # dry run (doesn't write KV)
```

See [tools/deploy-aliyun-fc.md](tools/deploy-aliyun-fc.md) for details and pitfalls. The function does one thing: at 12:55 daily it scrapes D-1/D-2 marks and writes them to Cloudflare KV (keys `marks:<YYYY-MM-DD>`); on cookie expiry it raises a Bark alert (KV-idempotent, at most once per day).

### 3. (Optional) Enable the email fallback

```bash
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put MAIL_TO              # recipient address
```

Without these, Bark still works normally.

### 4. (Optional) Deploy the HTTPS relay

The enterprise mark API is **plain HTTP** and reachable only from mainland-China IPs. If the Cloudflare edge can't reach it directly, deploy `relay/` to any platform with a mainland egress (fly.io / Railway / your own VPS all work), then:

```bash
npx wrangler secret put MARKS_PROXY_URL      # e.g. https://marks-relay-xxx.fly.dev
npx wrangler secret put MARKS_PROXY_TOKEN    # must match the relay's RELAY_TOKEN
```

See [relay/README.md](relay/README.md).

### 5. Verify

```bash
curl https://envsc.<your-subdomain>.workers.dev   # manual one-shot trigger; prints JSON
npx wrangler tail                                 # live logs of scheduled runs
```

Meaning of the returned `action`:

| `action` | Meaning | Action needed? |
|---|---|---|
| `pushed` | Fetched and pushed successfully | No |
| `skipped` | Already pushed today (KV dedup hit) | No, normal |
| `not_ready` | Platform hasn't published D-1 data yet | No, auto-retries next hour |
| `failed` | Fetch or push failed | Yes — check `wrangler tail` |

## Configuration Reference

**Plain variables (`[vars]` in `wrangler.toml`)**

| Variable | Description |
|---|---|
| `CNEMC_PSID` | Pollution-source ID (parameter of the public detail API) |
| `MAIL_FROM` | Resend sender (default `onboarding@resend.dev`, testing only) |

**Secrets (`wrangler secret put`, never in the repo)**

| Variable | Required | Description |
|---|---|---|
| `BARK_KEY` | ✅ | Bark device key |
| `MAIL_TO` | — | Email-fallback recipient |
| `RESEND_API_KEY` | — | Email-fallback sending API |
| `CNEMC_COOKIE` | — | Enterprise session cookie (relay mode / direct fallback) |
| `MARKS_PROXY_URL` | — | Relay URL (optional) |
| `MARKS_PROXY_TOKEN` | — | Relay auth token (must equal the relay's `RELAY_TOKEN`) |

**Cloud-function environment variables** (passed to `fc-deploy.py` as `FENV_*`): `CNEMC_COOKIE`, `CF_ACCOUNT_ID`, `CF_KV_NAMESPACE_ID`, `CF_API_TOKEN`, `BARK_KEY`, `CNEMC_PSID`, `DAYS` (look-back days, default 2).

## Schedule & Dedup

The cron in `wrangler.toml` is in **UTC**: `0 7-12 * * *` = **15:00–20:00 CST on the hour**, 6 runs a day.

- Platform data usually becomes ready after ~13:00 CST (the cloud function scrapes marks at 12:55 first); starting at 15:00 leaves a 2-hour buffer;
- 6 trigger points = up to 6 retries (`not_ready` / failures defer automatically);
- A successful push writes the KV dedup key, so you're disturbed at most once a day; title-only (all-compliant) days write it too.

## Local Development & Testing

```bash
npm run dev                        # run the Worker locally (wrangler dev)
node tools/buildtext-test.mjs      # message-format rules, 27 cases
node tools/merge-test.mjs          # mark-merging rules, 28 cases
node tools/watchdog-test.mjs       # watchdog logic
```

Common operations:

```bash
node tools/push-now.mjs 2026-10-07      # re-push/preview a date from its KV snapshot
                                        # (prefix with BARK_KEY=xxx KV_FILE=...)
"C:/.../python.exe" tools/kv-read.py --list "marks:2026-10"   # inspect KV keys (auto-loads credentials)
node tools/dump-puball.mjs              # raw-scrape the public APIs to diagnose sources
```

Rotating the Alibaba Cloud AccessKey (used for function deployment):

```bash
python tools/rotate-aliyun-key.py --set <new-AK> <new-SK>   # writes tools/.env.aliyun and verifies
python tools/kv-read.py --list                              # end-to-end re-check
# then disable the old AccessKey in the Alibaba console
```

## Disclaimer

- This project is for conveniently viewing data from **your own enterprise account**: all API calls use the public platform or your own session credentials — no reverse engineering, no auth bypass, no scraping of third-party data;
- Monitoring data belongs to the original platform; this project only reads and reminds — it stores nothing beyond mark summaries and dedup keys in KV;
- Push content is not a compliance conclusion; official checks should rely on the official platform. Make sure your use complies with your organization's data-use policies.
