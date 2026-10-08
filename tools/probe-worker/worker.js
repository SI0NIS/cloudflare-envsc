// 一次性探测 Worker：验证 Cloudflare 边缘（境外 IP）能否直连企业端 116.178.28.170:3080
// 若可行，标记同步就能整个搬进 Worker，不再需要任何国内云函数。
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = url.searchParams.get('u')
      || 'http://116.178.28.170:3080/amOnline/app/baseroute/requestRoute!list.page?method=/psbase/mpinfo/getMpInfoByPsId&psId=654000000031';
    const t0 = Date.now();
    try {
      const r = await fetch(target, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' }, redirect: 'manual' });
      const t = await r.text();
      return new Response(JSON.stringify({ ok: true, ms: Date.now() - t0, status: r.status, head: t.slice(0, 300) }, null, 2), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, ms: Date.now() - t0, error: String((e && e.message) || e), name: e && e.name }, null, 2), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
  },
};
