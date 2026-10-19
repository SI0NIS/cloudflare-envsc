var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
var API_BASE = "https://jkzx.envsc.cn/transpublic-v2";
var MARKS_HOST = "http://116.178.28.170:3080";
var MARKS_PATH = "/amOnline/app/baseroute/requestRoute!list.page";
var MARKS_REFERER = "http://116.178.28.170:3080/amOnline/zdjk-company/";
var COMPANY_NAME = "\u4F0A\u7281\u5DDD\u5B81\u751F\u7269\u6280\u672F\u80A1\u4EFD\u6709\u9650\u516C\u53F8";
var EXCLUSIONS = [
  { name: "3\u53F7\u673A\u7EC4", reason: "\u5DE5\u51B5\u6807\u8BB0\uFF1A\u505C\u8FD0\uFF0C\u4E0D\u8BA1\u5165\u6709\u6548\u4F20\u8F93\u7387\u7EDF\u8BA1\u65F6\u6BB5", onlyWhenZero: true }
];
var sleep = /* @__PURE__ */ __name((ms) => new Promise((r) => setTimeout(r, ms)), "sleep");
var TZ_OFFSET = 8 * 3600 * 1e3;
function ymd(d) {
  const t = new Date(d.getTime() + TZ_OFFSET);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}
__name(ymd, "ymd");
function d1Str() {
  const now = /* @__PURE__ */ new Date();
  const t = new Date(now.getTime() + TZ_OFFSET);
  t.setUTCDate(t.getUTCDate() - 1);
  return ymd(new Date(t.getTime() - TZ_OFFSET));
}
__name(d1Str, "d1Str");
async function api(method, urlPath, { body, tries = 3, timeout = 25e3 } = {}) {
  const url = new URL(API_BASE + urlPath);
  url.searchParams.set("_t", String(Date.now()));
  const init = {
    method,
    headers: {
      Accept: "application/json, text/plain, */*",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Referer: "https://jkzx.envsc.cn/transpublic-v2/2026/"
    }
  };
  if (body) {
    init.body = JSON.stringify(body);
    init.headers["Content-Type"] = "application/json";
  }
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await fetch(url, { ...init, signal: ctrl.signal });
      const txt = await r.text();
      let json;
      try {
        json = JSON.parse(txt);
      } catch {
        json = { raw: txt.slice(0, 500) };
      }
      if (r.status === 200) return json;
      lastErr = new Error(`HTTP ${r.status} ${urlPath}: ${txt.slice(0, 160)}`);
    } catch (e) {
      lastErr = new Error(`${urlPath} \u8BF7\u6C42\u5F02\u5E38(${e.name}): ${e.message}`);
    } finally {
      clearTimeout(to);
    }
    if (i < tries - 1) await sleep(1e3 * 2 ** i);
  }
  throw lastErr;
}
__name(api, "api");
var isOk = /* @__PURE__ */ __name((json) => json && (json.code === 200 || json.code === "SYS000" || json.code === "200"), "isOk");
var num = /* @__PURE__ */ __name((v) => {
  if (v == null) return null;
  if (typeof v === "string") {
    v = v.trim();
    if (v === "" || v === "/") return null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}, "num");
async function freshness() {
  const json = await api("GET", "/region/begin-end-time");
  if (!isOk(json)) throw new Error("begin-end-time \u5931\u8D25: " + JSON.stringify(json).slice(0, 200));
  const d = json.data || {};
  return { beginTime: d.beginTime || null, endTime: (d.endTime || "").slice(0, 10) || null };
}
__name(freshness, "freshness");
async function fetchRate(psId, day) {
  const gate = await freshness();
  if (gate.endTime && gate.endTime < day) {
    const err = new Error(`\u6570\u636E\u672A\u66F4\u65B0\uFF1A\u5E73\u53F0\u6700\u65B0 ${gate.endTime} < \u76EE\u6807 ${day}`);
    err.code = "NOT_READY";
    err.gate = gate;
    throw err;
  }
  const json = await api("POST", "/psinfo/psinfo/detail", {
    body: { psId, dateType: "DAY", start: `${day} 00:00:00`, end: `${day} 23:59:59` }
  });
  if (!isOk(json)) throw new Error("psDetail \u5931\u8D25: " + JSON.stringify(json).slice(0, 200));
  const data = json.data || {};
  const packRow = /* @__PURE__ */ __name((o) => o ? {
    type: o.type || null,
    transRate: num(o.transRate),
    effeRate: num(o.effeTransRate),
    effeTransRate: num(o.effeTransRate),
    updatedTime: o.updatedTime || o.dataTime || null,
    exemptionsReason: o.exemptionsReason || null
  } : null, "packRow");
  return {
    date: day,
    psName: data.psName || COMPANY_NAME,
    regionName: data.regionName || null,
    realtime: packRow(data.realtime),
    comple: packRow(data.comple),
    monitorPoints: (data.transMpInfoList || []).map((mp) => ({
      mpName: mp.mpName || null,
      realtime: packRow(mp.realtime),
      comple: packRow(mp.comple)
    })),
    gate
  };
}
__name(fetchRate, "fetchRate");
var effRate = /* @__PURE__ */ __name((o) => o && o.comple && o.comple.effeTransRate != null ? o.comple.effeTransRate : o && o.realtime ? o.realtime.effeTransRate : null, "effRate");
function isExcluded(mp) {
  for (const ex of EXCLUSIONS) {
    if (mp.mpName && mp.mpName.includes(ex.name)) {
      if (ex.onlyWhenZero) {
        const rt = mp.realtime ? mp.realtime.effeTransRate : null;
        const cp = mp.comple ? mp.comple.effeTransRate : null;
        if (rt === 0 && cp === 0) return ex;
      } else {
        return ex;
      }
    }
  }
  return null;
}
__name(isExcluded, "isExcluded");
var WASTEWATER_MPS = ["\u603B\u6392\u53E3"];
var WW_RATE_FLOOR = 95.83;
function isWastewaterOk(mp) {
  if (!mp || !mp.mpName) return false;
  if (!WASTEWATER_MPS.some((n) => mp.mpName.includes(n))) return false;
  const r = effRate(mp);
  return r != null && r >= WW_RATE_FLOOR;
}
__name(isWastewaterOk, "isWastewaterOk");
function judge(data) {
  const unitRate = effRate(data);
  const underperforming = [];
  const excluded = [];
  for (const mp of data.monitorPoints || []) {
    const ex = isExcluded(mp);
    if (ex) {
      excluded.push({ mpName: mp.mpName, reason: ex.reason });
      continue;
    }
    const r = effRate(mp);
    if (r == null) continue;
    if (isWastewaterOk(mp)) continue;
    if (r < 100) {
      underperforming.push({
        mpName: mp.mpName,
        realtime: mp.realtime ? mp.realtime.effeTransRate : null,
        comple: mp.comple ? mp.comple.effeTransRate : null,
        rate: r
      });
    }
  }
  return { unitRate, isCase1: unitRate === 100 && underperforming.length === 0, underperforming, excluded };
}
__name(judge, "judge");
var pct = /* @__PURE__ */ __name((v) => v == null ? "\u2014" : `${v}%`, "pct");
var prettyDate = /* @__PURE__ */ __name((s) => String(s || "").replace(/^\d{4}-(\d{2})-(\d{2}) /, "$1-$2 "), "prettyDate");
function markText(rows) {
  return rows.map((x) => {
    const parts = [];
    const flag = (x.reviseFlagName || "") + (x.reviseFlagItemName ? "-" + x.reviseFlagItemName : "");
    if (flag) parts.push(flag);
    if (x.startTime && x.endTime) {
      parts.push(`${prettyDate(x.startTime)}~${prettyDate(x.endTime).slice(-5)}(${x.duration}h)`);
    }
    if (x.reason) parts.push(x.reason);
    if (x.updatedBy) {
      const t = String(x.updatedTime || "").slice(5, 16);
      parts.push(`${x.updatedBy} ${t}\u586B\u62A5`);
    }
    return parts.join(" ");
  }).join("\uFF1B");
}
__name(markText, "markText");
async function fetchMarks(psId, day, cookie, env) {
  if (!cookie) {
    return { attempted: false, total: 0, byMp: /* @__PURE__ */ new Map(), error: "\u672A\u914D\u7F6E CNEMC_COOKIE" };
  }
  const params = new URLSearchParams({
    method: "/sign/qy/list",
    pageNum: "1",
    pageSize: "100",
    dateTime: `${day},${day}`,
    type: "2",
    moduleCode: "",
    mpId: "-1",
    shId: "-1",
    psId,
    status: "-1"
  });
  params.set("_t", String(Date.now()));
  const proxy = env && env.MARKS_PROXY_URL ? String(env.MARKS_PROXY_URL).replace(/\/+$/, "") : null;
  const target = proxy ? `${proxy}${MARKS_PATH}?${params.toString()}` : `${MARKS_HOST}${MARKS_PATH}?${params.toString()}`;
  try {
    const headers = {
      Cookie: cookie,
      Accept: "application/json, text/plain, */*",
      "X-Requested-With": "XMLHttpRequest",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Referer: MARKS_REFERER
    };
    if (proxy && env.MARKS_PROXY_TOKEN) headers["Authorization"] = `Bearer ${env.MARKS_PROXY_TOKEN}`;
    const r = await fetch(target, { headers });
    if (r.status !== 200) {
      return { attempted: true, total: 0, byMp: /* @__PURE__ */ new Map(), error: `HTTP ${r.status}` };
    }
    const txt = new TextDecoder("utf-8").decode(await r.arrayBuffer());
    let json;
    try {
      json = JSON.parse(txt);
    } catch {
      return { attempted: true, total: 0, byMp: /* @__PURE__ */ new Map(), error: "\u54CD\u5E94\u89E3\u6790\u5931\u8D25" };
    }
    if (json.code !== 200) {
      return { attempted: true, total: 0, byMp: /* @__PURE__ */ new Map(), error: `\u4F01\u4E1A\u7AEF code ${json.code}` };
    }
    const rows = json.data && json.data.rows || [];
    const byMp = /* @__PURE__ */ new Map();
    for (const x of rows) {
      const k = String(x.mpName || "").trim();
      if (!byMp.has(k)) byMp.set(k, []);
      byMp.get(k).push(x);
    }
    const byMpObj = /* @__PURE__ */ new Map();
    for (const [k, list] of byMp) byMpObj.set(k, { manual: markText(list), auto: null });
    return { attempted: true, total: rows.length, byMp: byMpObj, error: null };
  } catch (e) {
    return { attempted: true, total: 0, byMp: /* @__PURE__ */ new Map(), error: `\u8BF7\u6C42\u5931\u8D25 ${e.message}` };
  }
}
__name(fetchMarks, "fetchMarks");
var PUB_BASE = "https://jkzx.envsc.cn/transpublic-v2";
var PUB_REFERER = "https://jkzx.envsc.cn/transpublic-v2/2026/";
async function pubApi(method, urlPath, body) {
  const url = new URL(PUB_BASE + urlPath);
  url.searchParams.set("_t", String(Date.now()));
  const init = {
    method,
    headers: {
      Accept: "application/json, text/plain, */*",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Referer: PUB_REFERER
    }
  };
  if (body) {
    init.body = JSON.stringify(body);
    init.headers["Content-Type"] = "application/json";
  }
  const r = await fetch(url, init);
  const txt = await r.text();
  try {
    return JSON.parse(txt);
  } catch {
    return null;
  }
}
__name(pubApi, "pubApi");
var isParamCode = /* @__PURE__ */ __name((c) => /^[SB]\d{2}$/i.test(String(c || "")), "isParamCode");
var hourMs = /* @__PURE__ */ __name((s) => (/* @__PURE__ */ new Date(String(s).replace(" ", "T") + ":00:00")).getTime(), "hourMs");
function pubSegsToText(segs) {
  return segs.map((s) => {
    const st = String(s.start).slice(5);
    const eh = String(s.end).slice(11, 13);
    return s.n > 1 ? `${s.reason} ${st}~${eh}(${s.n}h)` : `${s.reason} ${st}(${s.n}h)`;
  }).join("\uFF1B");
}
__name(pubSegsToText, "pubSegsToText");
async function fetchMarksPublic(psId, day) {
  const start = `${day} 00:00:00`;
  const end = `${day} 23:59:59`;
  const det = await pubApi("POST", "/psinfo/psinfo/detail", { psId, dateType: "DAY", start, end });
  const mps = det && det.data && det.data.transMpInfoList || [];
  if (!mps.length) throw new Error("\u516C\u5F00\u5E73\u53F0\u672A\u8FD4\u56DE\u76D1\u63A7\u70B9");
  const byMp = /* @__PURE__ */ new Map();
  let total = 0;
  for (const m of mps) {
    const name = String(m.mpName || "").trim();
    if (!name) continue;
    const list = await pubApi("POST", "/psinfo/pollutant/list", { psId, mpId: m.mpId, dateType: "DAY", start, end });
    const factors = list && list.data || [];
    const segs = [];
    for (const f of factors) {
      if (isParamCode(f.pollutantCode)) continue;
      const inv = ((f.realtime || {}).invalidReasons || []).filter((x) => x && x.invalidReason);
      for (const b of inv) {
        const t = String(b.dataTime || "");
        const last = segs[segs.length - 1];
        if (last && last.reason === b.invalidReason && hourMs(t) - hourMs(last.end) === 36e5) {
          last.end = t;
          last.n += 1;
        } else {
          segs.push({ reason: b.invalidReason, start: t, end: t, n: 1 });
        }
      }
    }
    if (segs.length) {
      const uniq = [];
      const seen = /* @__PURE__ */ new Set();
      for (const s of segs) {
        const k = `${s.reason}|${s.start}|${s.end}|${s.n}`;
        if (seen.has(k)) continue;
        seen.add(k);
        uniq.push(s);
      }
      total += uniq.length;
      byMp.set(name, { manual: null, auto: pubSegsToText(uniq) });
    }
  }
  return { attempted: true, total, byMp, error: null, source: "public" };
}
__name(fetchMarksPublic, "fetchMarksPublic");
async function fetchMarksFromKV(env, day) {
  if (!env.ENVSC_KV) return null;
  let raw = null;
  try {
    raw = await env.ENVSC_KV.get(`marks:${day}`);
  } catch (e) {
    return null;
  }
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    const byMp = /* @__PURE__ */ new Map();
    for (const [name, v] of Object.entries(obj.byMp || {})) {
      if (typeof v === "string") byMp.set(name, { manual: v, auto: null });
      else byMp.set(name, { manual: v && v.manual || null, auto: v && v.auto || null });
    }
    return { attempted: true, total: obj.total != null ? obj.total : 0, byMp, error: null, source: "kv" };
  } catch (e) {
    return { attempted: true, total: 0, byMp: /* @__PURE__ */ new Map(), error: `KV \u89E3\u6790\u5931\u8D25 ${e.message}` };
  }
}
__name(fetchMarksFromKV, "fetchMarksFromKV");
function toMin(hhmm) {
  const p = String(hhmm).split(":");
  const h = Number(p[0]), mi = Number(p[1]);
  if (!Number.isFinite(h) || !Number.isFinite(mi)) return null;
  return h * 60 + mi;
}
__name(toMin, "toMin");
function parseRanges(s) {
  const out = [];
  const re = /(\d{1,2}:\d{2})\s*[~～]\s*(\d{1,2}:\d{2})/g;
  let m;
  while ((m = re.exec(String(s || ""))) !== null) {
    const a = toMin(m[1]), b = toMin(m[2]);
    if (a != null && b != null) out.push([a, b]);
  }
  return out;
}
__name(parseRanges, "parseRanges");
function rangeCoveredByAny(auto, manualRanges) {
  const [as, ae] = auto;
  return manualRanges.some(([ms, me]) => as >= ms && ae <= me);
}
__name(rangeCoveredByAny, "rangeCoveredByAny");
var isCheckSeg = /* @__PURE__ */ __name((seg) => /标样核查|样品核查|比对核查/.test(seg), "isCheckSeg");
function buildText(data, j, marks) {
  const compact = data.date.replace(/-/g, "");
  const title = `${compact}\u6709\u6548\u4F20\u8F93\u7387${pct(j.unitRate)}`;
  const abnormal = [];
  for (const mp of data.monitorPoints || []) {
    const ex = isExcluded(mp);
    const r = effRate(mp);
    const under = r != null && r < 100 && !isWastewaterOk(mp);
    const key0 = String(mp.mpName || "").trim();
    const m0 = marks && marks.byMp && marks.byMp.get(key0);
    const hasManual = !!(m0 && String(m0.manual || "").trim());
    const autoSegs = String(m0 && m0.auto || "").split(/[\n；]/).map((s) => s.trim()).filter(Boolean);
    const wwExempt = isWastewaterOk(mp);
    const marked = wwExempt ? hasManual : hasManual || autoSegs.length > 0;
    if (!under && !ex && !marked) continue;
    abnormal.push({ mp, ex, under, marked });
  }
  if (abnormal.length === 0) return { title, body: "" };
  const total = (data.monitorPoints || []).length;
  const lines = [];
  lines.push(`\u5F02\u5E38\u76D1\u63A7\u70B9\uFF08${abnormal.length} / ${total} \u4E2A\uFF09\uFF1A`);
  for (const a of abnormal) {
    const mp = a.mp;
    if (a.ex) {
      lines.push(`\xB7 ${mp.mpName}\uFF08${a.ex.reason}\uFF09`);
    } else if (a.marked && !a.under) {
      const rt = mp.realtime ? mp.realtime.effeTransRate : null;
      const cp = mp.comple ? mp.comple.effeTransRate : null;
      lines.push(`\xB7 ${mp.mpName}\u3000\u5373\u65F6 ${pct(rt)} / \u8865\u5168 ${pct(cp)}\uFF08\u22641h \u6807\u6837\u6838\u67E5\uFF0C\u5DF2\u8C41\u514D\uFF09`);
    } else {
      const rt = mp.realtime ? mp.realtime.effeTransRate : null;
      const cp = mp.comple ? mp.comple.effeTransRate : null;
      lines.push(`\xB7 ${mp.mpName}\u3000\u5373\u65F6 ${pct(rt)} / \u8865\u5168 ${pct(cp)}`);
    }
    const key = String(mp.mpName || "").trim();
    const m = marks && marks.byMp && marks.byMp.get(key);
    if (m) {
      const norm = /* @__PURE__ */ __name((s) => String(s || "").replace(/\d{2}-\d{2}\s+/g, "").replace(/\s*\n\s*/g, "\n").trim(), "norm");
      const man = norm(m.manual);
      const manRanges = parseRanges(m.manual);
      const rawAuto = String(m.auto || "");
      const groups = rawAuto.split("\n").map((g) => g.trim()).filter(Boolean);
      const keptGroups = [];
      for (const grp of groups) {
        const segs = grp.split("\uFF1B").map((s) => s.trim()).filter(Boolean);
        const kept = segs.filter((seg) => {
          if (isCheckSeg(seg)) return true;
          const rngs = parseRanges(seg);
          if (rngs.length === 0) return true;
          return !rngs.every((r) => rangeCoveredByAny(r, manRanges));
        });
        if (kept.length) keptGroups.push(kept.join("\uFF1B"));
      }
      if (man) {
        if (man.includes("\n")) lines.push(`\u4EBA\u5DE5\u6807\u8BB0\uFF1A
${man}`);
        else lines.push(`\u4EBA\u5DE5\u6807\u8BB0\uFF1A${man}`);
      }
      if (keptGroups.length) {
        const keptText = norm(keptGroups.join("\n"));
        if (keptText && norm(keptText.replace(/\n/g, "\uFF1B")) !== man) {
          if (keptText.includes("\n")) lines.push(`\u81EA\u52A8\u6807\u8BB0\uFF1A
${keptText}`);
          else lines.push(`\u81EA\u52A8\u6807\u8BB0\uFF1A${keptText}`);
        }
      }
    }
  }
  let body = lines.join("\n");
  if (marks && marks.error) body += `
\uFF08\u4EBA\u5DE5\u6807\u8BB0\u6682\u65E0\u6CD5\u83B7\u53D6\uFF1A${marks.error}\uFF09`;
  return { title, body };
}
__name(buildText, "buildText");
async function pushBark(key, title, body, level) {
  if (!key) return { channel: "bark", ok: false, error: "BARK_KEY \u672A\u914D\u7F6E" };
  try {
    const r = await fetch(`https://api.day.app/${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, body, level: level || "active", group: "\u6709\u6548\u4F20\u8F93\u7387" })
    });
    const txt = await r.text();
    let json;
    try {
      json = JSON.parse(txt);
    } catch {
      json = { raw: txt.slice(0, 200) };
    }
    return { channel: "bark", ok: json && json.code === 200, resp: json };
  } catch (e) {
    return { channel: "bark", ok: false, error: e.message };
  }
}
__name(pushBark, "pushBark");
async function pushEmail(env, title, body) {
  if (!env.RESEND_API_KEY || !env.MAIL_TO || !env.MAIL_FROM) {
    return { channel: "email", ok: false, error: "\u90AE\u4EF6\u672A\u914D\u7F6E" };
  }
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: [env.MAIL_TO],
        subject: title,
        text: body || ""
      })
    });
    return { channel: "email", ok: r.status === 200 || r.status === 201, status: r.status };
  } catch (e) {
    return { channel: "email", ok: false, error: e.message };
  }
}
__name(pushEmail, "pushEmail");
async function runInner(env) {
  const day = d1Str();
  const psId = env.CNEMC_PSID || "654000000031";
  let done = null;
  try {
    done = await env.ENVSC_KV.get(day);
  } catch (e) {
  }
  if (done) return { ok: true, action: "skipped", date: day, reason: "\u5F53\u5929\u5DF2\u63A8\u9001\u8FC7" };
  let data;
  try {
    data = await fetchRate(psId, day);
  } catch (e) {
    if (e.code === "NOT_READY") {
      return { ok: true, action: "not_ready", date: day, gate: e.gate, reason: e.message };
    }
    return { ok: false, action: "failed", date: day, reason: e.message };
  }
  const j = judge(data);
  let marks = { attempted: false, total: 0, byMp: /* @__PURE__ */ new Map(), error: null };
  try {
    if (env.MARKS_PROXY_URL) {
      try {
        const r = await fetchMarks(psId, day, env.CNEMC_COOKIE, env);
        if (r && r.attempted && !r.error) marks = { ...r, source: "relay" };
      } catch (e) {
      }
    }
    if (!marks.attempted) {
      const [pubRes, kvRes] = await Promise.allSettled([
        fetchMarksPublic(psId, day),
        fetchMarksFromKV(env, day)
      ]);
      const pub = pubRes.status === "fulfilled" ? pubRes.value : null;
      const fromKv = kvRes.status === "fulfilled" ? kvRes.value : null;
      if (pub || fromKv) {
        const merged = /* @__PURE__ */ new Map();
        if (pub) for (const [k, v] of pub.byMp) merged.set(k, v);
        if (fromKv) for (const [k, v] of fromKv.byMp) merged.set(k, v);
        marks = {
          attempted: true,
          // total 仅在存在人工标记时用于推送后缀；KV total=人工条数，纯公开时不展示（hasMarks=false）
          total: fromKv ? fromKv.total != null ? fromKv.total : 0 : pub ? pub.total : 0,
          byMp: merged,
          error: null,
          source: fromKv ? pub ? "kv+public" : "kv" : "public"
        };
      } else {
        marks = await fetchMarks(psId, day, env.CNEMC_COOKIE, env);
      }
    }
  } catch (e) {
    marks = { attempted: true, total: 0, byMp: /* @__PURE__ */ new Map(), error: e.message };
  }
  const { title, body } = buildText(data, j, marks);
  const fullOk = !String(body || "").trim();
  const pushBody = fullOk ? "" : body;
  const level = j.isCase1 ? "active" : "timeSensitive";
  const pushed = [];
  const bark = await pushBark(env.BARK_KEY, title, pushBody, level);
  pushed.push(bark);
  if (!bark.ok) pushed.push(await pushEmail(env, title, pushBody));
  const anyOk = pushed.some((p) => p.ok);
  if (anyOk) {
    try {
      await env.ENVSC_KV.put(day, JSON.stringify({ unitRate: j.unitRate, isCase1: j.isCase1, at: (/* @__PURE__ */ new Date()).toISOString() }));
    } catch (e) {
    }
  }
  return {
    ok: anyOk,
    action: anyOk ? "pushed" : "failed",
    date: day,
    unitRate: j.unitRate,
    isCase1: j.isCase1,
    underperforming: j.underperforming,
    excluded: j.excluded,
    marks: { source: marks.source || null, attempted: marks.attempted, total: marks.total, error: marks.error },
    title,
    body,
    pushed
  };
}
__name(runInner, "runInner");
async function run(env) {
  let r;
  try {
    r = await runInner(env);
  } catch (e) {
    r = { ok: false, action: "failed", phase: "runInner", error: String(e && e.stack || e) };
  }
  try {
    if (env.ENVSC_KV) {
      await env.ENVSC_KV.put("last-result", JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), ...r }));
    }
  } catch (e) {
  }
  return r;
}
__name(run, "run");
async function watchdog(env) {
  const kv = env.ENVSC_KV;
  if (!kv) return { watchdog: "skip", why: "ENVSC_KV \u672A\u7ED1\u5B9A" };
  const now = /* @__PURE__ */ new Date();
  const cn = new Date(now.getTime() + TZ_OFFSET);
  const hhmm = cn.getUTCHours() * 60 + cn.getUTCMinutes();
  const clock = `${String(cn.getUTCHours()).padStart(2, "0")}:${String(cn.getUTCMinutes()).padStart(2, "0")}`;
  if (hhmm < 13 * 60 + 5) return { watchdog: "skip", why: `\u672A\u5230\u68C0\u67E5\u65F6\u523B\uFF08\u5317\u4EAC ${clock} < 13:05\uFF09` };
  const today = ymd(now);
  const day = d1Str();
  let alerted = null;
  try {
    alerted = await kv.get(`wd:${today}`);
  } catch (e) {
  }
  if (alerted) return { watchdog: "skip", why: "\u4ECA\u5929\u5DF2\u544A\u8B66\u8FC7", at: alerted, day };
  let raw = null;
  try {
    raw = await kv.get(`marks:${day}`);
  } catch (e) {
    raw = null;
  }
  let why = "";
  if (!raw) {
    why = `KV \u91CC\u6CA1\u6709 marks:${day}\uFF08\u4E91\u51FD\u6570\u4ECA\u5929\u6CA1\u5199\u5165\uFF09`;
  } else {
    let at = "";
    try {
      at = String((JSON.parse(raw) || {}).at || "");
    } catch (e) {
      at = "";
    }
    if (!at) why = `marks:${day} \u7F3A\u5C11\u65F6\u95F4\u6233`;
    else {
      const atDay = ymd(new Date(at));
      if (atDay !== today) why = `marks:${day} \u7684\u65F6\u95F4\u6233\u662F ${at}\uFF08\u5317\u4EAC ${atDay}\uFF0C\u4E0D\u662F\u4ECA\u5929\uFF09`;
    }
  }
  if (!why) return { watchdog: "ok", day, today, why: "\u4ECA\u65E5\u540C\u6B65\u5DF2\u843D\u5E93" };
  const title = `\u26A0\uFE0F \u540C\u6B65\u4E2D\u65AD ${day.replace(/-/g, "")}`;
  const body = `${why}\u3002\u5E38\u89C1\u539F\u56E0\uFF1A\u2460 \u963F\u91CC\u4E91\u6B20\u8D39\u51BB\u7ED3\uFF08403 in debt\uFF0C\u6B20 2 \u5206\u94B1\u4E5F\u505C\uFF09\uFF1B\u2461 \u4F01\u4E1A\u7AEF cookie \u5931\u6548\uFF1B\u2462 \u51FD\u6570\u5F02\u5E38\u3002\u8BF7\u67E5\u963F\u91CC\u4E91\u8D26\u6237\u4F59\u989D + \u51FD\u6570 envsc-marks-sync\u3002`;
  let bark = { channel: "bark", ok: false, error: "BARK_KEY \u672A\u914D\u7F6E" };
  if (env.BARK_KEY) bark = await pushBark(env.BARK_KEY, title, body, "timeSensitive");
  try {
    await kv.put(`wd:${today}`, now.toISOString());
  } catch (e) {
  }
  return { watchdog: "alerted", day, today, why, bark };
}
__name(watchdog, "watchdog");
function inPushWindow(bjHour) {
  return bjHour >= 15 && bjHour < 21;
}
__name(inPushWindow, "inPushWindow");
var index_default = {
  // 定时触发（Cron Triggers）
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const bjHour = new Date(Date.now() + 8 * 36e5).getUTCHours();
      if (!inPushWindow(bjHour)) {
        return { ok: true, action: "outside_window", bjHour, reason: "\u5317\u4EAC\u65F6\u95F4\u4E0D\u5728 15:00-20:00 \u63A8\u9001\u7A97\u53E3" };
      }
      const r = await run(env);
      let w;
      try {
        w = await watchdog(env);
      } catch (e) {
        w = { watchdog: "error", error: String(e && e.stack || e) };
      }
      try {
        if (env.ENVSC_KV) await env.ENVSC_KV.put("last-watchdog", JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), ...w }));
      } catch (e) {
      }
      return { ...r, watchdog: w };
    })());
  },
  // 手动访问 URL 即可触发一次，便于验证
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/probe") {
      if (!env.BARK_KEY || url.searchParams.get("k") !== env.BARK_KEY) {
        return new Response("not found", { status: 404 });
      }
      const target = "http://116.178.28.170:3080/amOnline/app/baseroute/requestRoute!list.page?method=/psbase/mpinfo/getMpInfoByPsId&psId=654000000031";
      const t0 = Date.now();
      try {
        const r2 = await fetch(target, {
          headers: { "User-Agent": "Mozilla/5.0", Accept: "*/*" },
          redirect: "manual"
        });
        const txt = await r2.text();
        return new Response(JSON.stringify({ ok: true, ms: Date.now() - t0, status: r2.status, head: txt.slice(0, 300) }, null, 2), {
          headers: { "Content-Type": "application/json; charset=utf-8" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, ms: Date.now() - t0, error: String(e && e.message || e), name: e && e.name }, null, 2), {
          headers: { "Content-Type": "application/json; charset=utf-8" }
        });
      }
    }
    if (url.pathname === "/watchdog") {
      if (!env.BARK_KEY || url.searchParams.get("k") !== env.BARK_KEY) {
        return new Response("not found", { status: 404 });
      }
      if (url.searchParams.get("reset") === "1" && env.ENVSC_KV) {
        try {
          await env.ENVSC_KV.delete(`wd:${ymd(/* @__PURE__ */ new Date())}`);
        } catch (e) {
        }
      }
      const w = await watchdog(env);
      return new Response(JSON.stringify(w, null, 2), {
        headers: { "Content-Type": "application/json; charset=utf-8" }
      });
    }
    const r = await run(env);
    return new Response(JSON.stringify(r, null, 2), {
      headers: { "Content-Type": "application/json; charset=utf-8" }
    });
  }
};
export {
  buildText,
  index_default as default,
  fetchMarks,
  inPushWindow,
  markText,
  watchdog
};
//# sourceMappingURL=index.js.map
