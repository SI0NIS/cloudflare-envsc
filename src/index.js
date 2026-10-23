/**
 * 有效传输率每日核查 · Cloudflare Worker 版（编排层）
 *
 * 2026-10-22 波次3：巨石拆分——纯逻辑/取数/推送已下沉到各模块，本文件只做编排与入口：
 *   config.js         项目业务配置（排除点/公司名/阈值/推送窗口）
 *   core/time.js      日期工具（UTC+8 D-1）
 *   core/marks.js     标记文本/区间纯函数（v2 序列化、覆盖判定、标样核查豁免）
 *   core/judge.js     有效传输率判定（异常点/废水豁免/停运排除）
 *   core/text.js      推送文案组装（buildText）
 *   io/public.js      公开平台取数（有效传输率 + 小时级公开标记）
 *   io/enterprise.js  企业端取数（分钟级人工标记，需 cookie）
 *   io/kv.js          标记 KV 读取（v2/v1 双键取新）
 *   io/push.js        推送（Bark 主 + 邮件兜底）
 *
 * 关键设计：
 *   1. 去重用 Cloudflare KV；Cron Triggers 时区明确为 UTC（北京 15–20 = UTC 07–12）。
 *   2. 企业端接口为明文 HTTP + 非标准端口，Workers 运行时实测允许直连；边缘不可达才配 MARKS_PROXY_URL。
 *   3. Workers 无 SMTP → 邮件兜底走 Resend HTTP API。
 *
 * 绑定/环境变量：
 *   ENVSC_KV  KV namespace（去重）
 *   CNEMC_PSID / CNEMC_COOKIE / MARKS_PROXY_URL / MARKS_PROXY_TOKEN
 *   BARK_KEY / RESEND_API_KEY / MAIL_FROM / MAIL_TO
 */
import { PROJECT, validateProjectConfig } from './config.js';
import { TZ_OFFSET, ymd, d1Str } from './core/time.js';
import { v2SegsText } from './core/marks.js';
import { judge } from './core/judge.js';
import { buildText } from './core/text.js';
import { fetchRate, fetchMarksPublic } from './io/public.js';
import { markText, fetchMarks } from './io/enterprise.js';
import { fetchMarksFromKV } from './io/kv.js';
import { pushBark, pushEmail } from './io/push.js';

// ---------- 主流程 ----------
async function runInner(env) {
  validateProjectConfig(); // 配置非法 → 抛错（run() 兜底落 last-result，不静默跑错）
  const day = d1Str();
  const psId = env.CNEMC_PSID || PROJECT.psId;

  // 去重（KV）
  // 2026-10-23：降级推送可升级一次——若上次推送仅公开平台小时级（marksSource=public，通常是本机同步
  // 晚于 15:00 才完成/当天同步失败），本次已拿到分钟级 KV 标记时允许再推一次完整版；
  // 升级后写 upgraded:true，后续整点不再重复。
  let done = null;
  try { done = await env.ENVSC_KV.get(day); } catch (e) { /* KV 异常不阻断 */ }
  let upgrade = false;
  if (done) {
    let prev = null;
    try { prev = JSON.parse(done); } catch (e) { prev = null; }
    if (prev && prev.marksSource === 'public' && !prev.upgraded) upgrade = true;
    else return { ok: true, action: 'skipped', date: day, reason: '当天已推送过' };
  }

  let data;
  try {
    data = await fetchRate(psId, day);
  } catch (e) {
    if (e.code === 'NOT_READY') {
      return { ok: true, action: 'not_ready', date: day, gate: e.gate, reason: e.message };
    }
    return { ok: false, action: 'failed', date: day, reason: e.message };
  }

  const j = judge(data);

  // 设备标记获取（多源融合，2026-09-23 设计）：
  //   ① B·中继（配了 MARKS_PROXY_URL 才走）→ ② A(公开) 与 B(KV) 并行、KV 按点覆盖公开
  //   → ③ 公开与 KV 全挂时企业端直连兜底。source 如实标注 relay/public/kv/kv+public。
  let marks = { attempted: false, total: 0, byMp: new Map(), error: null };
  try {
    if (env.MARKS_PROXY_URL) {
      try {
        const r = await fetchMarks(psId, day, env.CNEMC_COOKIE, env);
        if (r && r.attempted && !r.error) marks = { ...r, source: 'relay' };
      } catch (e) { /* 中继异常则继续走 A/B 融合 */ }
    }
    if (!marks.attempted) {
      const [pubRes, kvRes] = await Promise.allSettled([
        fetchMarksPublic(psId, day),
        fetchMarksFromKV(env, day),
      ]);
      const pub = pubRes.status === 'fulfilled' ? pubRes.value : null;
      const fromKv = kvRes.status === 'fulfilled' ? kvRes.value : null;
      if (pub || fromKv) {
        const merged = new Map();
        if (pub) for (const [k, v] of pub.byMp) merged.set(k, v);
        if (fromKv) for (const [k, v] of fromKv.byMp) merged.set(k, v); // KV 质量更高，覆盖同名点
        marks = {
          attempted: true,
          total: fromKv ? (fromKv.total != null ? fromKv.total : 0) : (pub ? pub.total : 0),
          byMp: merged,
          error: null,
          source: fromKv ? (pub ? 'kv+public' : 'kv') : 'public',
        };
      } else {
        marks = await fetchMarks(psId, day, env.CNEMC_COOKIE, env);
      }
    }
  } catch (e) {
    marks = { attempted: true, total: 0, byMp: new Map(), error: e.message };
  }

  const { title, body } = buildText(data, j, marks);

  // 升级重推的前提：本次确实拿到了分钟级 KV 标记；否则保持静默（不重复打扰降级通知）。
  const hasKvMarks = /kv/i.test(String(marks.source || ''));
  if (upgrade && !hasKvMarks) {
    return { ok: true, action: 'skipped', date: day, reason: '上次为降级推送，但本次仍无分钟级标记', marks: { source: marks.source || null } };
  }

  // 标记缺失可见化（2026-10-22 波次4）：有异常内容但分钟级 KV 未同步（source=public）时，
  // 在正文尾部显式提示，把「静默降级为小时级」变成可见，方便事后核对。
  let pushBody = body;
  if (String(body || '').trim() && marks.source === 'public' && !marks.error) {
    pushBody = `${body}\n（分钟级标记未同步，以上为公开平台小时级标记）`;
  }

  // 有效传输率 100%（全达标且无标记/停运内容）→ 仅推标题。body 为空时 bark/email 只发 title。
  const fullOk = !String(pushBody || '').trim();
  const finalBody = fullOk ? '' : pushBody;
  const level = j.isCase1 ? 'active' : 'timeSensitive';

  const pushed = [];
  const bark = await pushBark(env.BARK_KEY, title, finalBody, level);
  pushed.push(bark);
  if (!bark.ok) pushed.push(await pushEmail(env, title, finalBody));

  const anyOk = pushed.some((p) => p.ok);
  if (anyOk) {
    try {
      // marksSource/upgraded 用于「降级推送可升级一次」判定（2026-10-23）
      await env.ENVSC_KV.put(day, JSON.stringify({
        unitRate: j.unitRate, isCase1: j.isCase1, at: new Date().toISOString(),
        marksSource: marks.source || null, ...(upgrade ? { upgraded: true } : {}),
      }));
    } catch (e) { /* 去重写失败不影响推送结果 */ }
  }

  return {
    ok: anyOk,
    action: anyOk ? 'pushed' : 'failed',
    date: day,
    unitRate: j.unitRate,
    isCase1: j.isCase1,
    underperforming: j.underperforming,
    excluded: j.excluded,
    marks: { source: marks.source || null, attempted: marks.attempted, total: marks.total, error: marks.error },
    title,
    body,
    pushed,
  };
}

// 包装：把最近一次运行结果写进 KV，便于在 workers.dev 不可达时用命令行核对
async function run(env) {
  let r;
  try {
    r = await runInner(env);
  } catch (e) {
    // 关键：任何未捕获异常也要落到 KV，否则线上排查没有任何线索
    r = { ok: false, action: 'failed', phase: 'runInner', error: String((e && e.stack) || e) };
  }
  try {
    if (env.ENVSC_KV) {
      await env.ENVSC_KV.put('last-result', JSON.stringify({ at: new Date().toISOString(), ...r }));
    }
  } catch (e) { /* 记录失败不影响主流程 */ }
  return r;
}

// ---------- 看门狗：今日标记是否按时落库（自检保留，告警已静音） ----------
// 2026-10-22 起：云函数停用、改本机 14:40 同步 → 自检结果仍写 last-watchdog，但**不再推送告警**。
async function watchdog(env) {
  const kv = env.ENVSC_KV;
  if (!kv) return { watchdog: 'skip', why: 'ENVSC_KV 未绑定' };

  const now = new Date();
  const cn = new Date(now.getTime() + TZ_OFFSET); // 北京时间视图
  const hhmm = cn.getUTCHours() * 60 + cn.getUTCMinutes();
  const clock = `${String(cn.getUTCHours()).padStart(2, '0')}:${String(cn.getUTCMinutes()).padStart(2, '0')}`;
  if (hhmm < 13 * 60 + 5) return { watchdog: 'skip', why: `未到检查时刻（北京 ${clock} < 13:05）` };

  const today = ymd(now);
  const day = d1Str(); // 同步目标日 = 昨天，也就是当天推送要用的那份标记

  let alerted = null;
  try { alerted = await kv.get(`wd:${today}`); } catch (e) { /* 读取失败按未告警处理 */ }
  if (alerted) return { watchdog: 'skip', why: '今天已告警过', at: alerted, day };

  let raw = null;
  try { raw = await kv.get(`marks:${day}`); } catch (e) { raw = null; }

  let why = '';
  if (!raw) {
    why = `KV 里没有 marks:${day}（本机今天未同步）`;
  } else {
    let at = '';
    try { at = String((JSON.parse(raw) || {}).at || ''); } catch (e) { at = ''; }
    if (!at) why = `marks:${day} 缺少时间戳`;
    else {
      const atDay = ymd(new Date(at));
      if (atDay !== today) why = `marks:${day} 的时间戳是 ${at}（北京 ${atDay}，不是今天）`;
    }
  }
  if (!why) return { watchdog: 'ok', day, today, why: '今日同步已落库' };

  return { watchdog: 'muted', day, today, why, note: '同步中断告警已关闭（云函数停用，改本机同步）' };
}

// 北京时间推送窗口：默认 15:00–20:59（来源 config/project.json 的 pushWindow）
export function inPushWindow(bjHour) {
  return bjHour >= PROJECT.pushWindow.startHour && bjHour < PROJECT.pushWindow.endHour;
}

export { buildText, markText, fetchMarks, watchdog, v2SegsText };

export default {
  // 定时触发（Cron Triggers）
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      // 北京时间推送窗口硬约束（2026-10-08）：仅 15:00–20:59 允许推送日报。
      // 背景：wrangler 已把 cron 换成 UTC 7-12（北京 15-20），但旧 cron 曾幽灵触发——
      //   平台侧旧调度不可靠 → 代码层兜底，窗外直接不推不写 dedup。
      const bjHour = new Date(Date.now() + 8 * 3600e3).getUTCHours();
      if (!inPushWindow(bjHour)) {
        return { ok: true, action: 'outside_window', bjHour, reason: '北京时间不在 15:00-20:00 推送窗口' };
      }
      const r = await run(env);
      let w;
      try { w = await watchdog(env); } catch (e) { w = { watchdog: 'error', error: String((e && e.stack) || e) }; }
      try {
        if (env.ENVSC_KV) await env.ENVSC_KV.put('last-watchdog', JSON.stringify({ at: new Date().toISOString(), ...w }));
      } catch (e) { /* 忽略 */ }
      return { ...r, watchdog: w };
    })());
  },
  // 手动访问 URL 即可触发一次，便于验证
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // 边缘直连企业端探测（验证 Cloudflare 边缘能否访问 116.178.28.170:3080）
    if (url.pathname === '/probe') {
      // 鉴权：必须带 ?k=<BARK_KEY>，否则一律 404（防止被当成任意 URL 的 SSRF 代理）
      if (!env.BARK_KEY || url.searchParams.get('k') !== env.BARK_KEY) {
        return new Response('not found', { status: 404 });
      }
      const target = `http://116.178.28.170:3080/amOnline/app/baseroute/requestRoute!list.page?method=/psbase/mpinfo/getMpInfoByPsId&psId=${encodeURIComponent(PROJECT.psId)}`;
      const t0 = Date.now();
      try {
        const r = await fetch(target, {
          headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' },
          redirect: 'manual',
        });
        const txt = await r.text();
        return new Response(JSON.stringify({ ok: true, ms: Date.now() - t0, status: r.status, head: txt.slice(0, 300) }, null, 2), {
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, ms: Date.now() - t0, error: String((e && e.message) || e), name: e && e.name }, null, 2), {
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      }
    }
    // 看门狗手动触发（同样要 ?k=<BARK_KEY> 鉴权）；加 &reset=1 可清掉当天的告警幂等标记
    if (url.pathname === '/watchdog') {
      if (!env.BARK_KEY || url.searchParams.get('k') !== env.BARK_KEY) {
        return new Response('not found', { status: 404 });
      }
      if (url.searchParams.get('reset') === '1' && env.ENVSC_KV) {
        try { await env.ENVSC_KV.delete(`wd:${ymd(new Date())}`); } catch (e) { /* 忽略 */ }
      }
      const w = await watchdog(env);
      return new Response(JSON.stringify(w, null, 2), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }
    const r = await run(env);
    return new Response(JSON.stringify(r, null, 2), {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  },
};
