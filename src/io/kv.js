// io/kv.js —— 标记从 Cloudflare KV 读取（本机/云函数在境内抓取后回写）
//
// marks v2（2026-10-22 波次2）：同步端双写 `marks:v2:<date>`（结构化）与 `marks:<date>`（v1 文本）。
// 取数规则：两键都读，**按 at 取较新者**（at 相同优先 v2）——单键写失败时自动回退到另一键，
// 不会产生「新 v1 + 旧 v2」错配。
async function fetchMarksFromKV(env, day) {
  if (!env.ENVSC_KV) return null;
  let rawV1 = null, rawV2 = null;
  try { [rawV1, rawV2] = await Promise.all([env.ENVSC_KV.get(`marks:${day}`), env.ENVSC_KV.get(`marks:v2:${day}`)]); }
  catch (e) { return null; }
  if (!rawV1 && !rawV2) return null;

  const parseV1 = (raw) => {
    const obj = JSON.parse(raw);
    const byMp = new Map();
    for (const [name, v] of Object.entries(obj.byMp || {})) {
      if (typeof v === 'string') byMp.set(name, { manual: v, auto: null });
      else byMp.set(name, { manual: (v && v.manual) || null, auto: (v && v.auto) || null });
    }
    return { attempted: true, total: obj.total != null ? obj.total : 0, byMp, error: null, source: 'kv', at: obj.at || null };
  };
  const parseV2 = (raw) => {
    const obj = JSON.parse(raw);
    const byMp = new Map();
    for (const [name, p] of Object.entries(obj.points || {})) {
      byMp.set(name, { v2: { manual: p.manual || null, auto: (p.auto && Array.isArray(p.auto.segs)) ? p.auto : { segs: [] } } });
    }
    return { attempted: true, total: obj.total != null ? obj.total : 0, byMp, error: null, source: 'kv', v2: true, at: obj.at || null };
  };

  let v1 = null, v2 = null, perr = null;
  if (rawV2) { try { v2 = parseV2(rawV2); } catch (e) { perr = e; } }
  if (rawV1) { try { v1 = parseV1(rawV1); } catch (e) { perr = perr || e; } }
  if (v1 && v2) return (Date.parse(v2.at || 0) >= Date.parse(v1.at || 0)) ? v2 : v1;
  if (v2) return v2;
  if (v1) return v1;
  return { attempted: true, total: 0, byMp: new Map(), error: `KV 解析失败 ${perr && perr.message}` };
}

export { fetchMarksFromKV };
