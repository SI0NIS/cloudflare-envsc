// io/enterprise.js —— 企业端在线监控平台取数（分钟级人工标记，UTF-8，需会话 cookie）
const MARKS_HOST = 'http://116.178.28.170:3080';
const MARKS_PATH = '/amOnline/app/baseroute/requestRoute!list.page';
const MARKS_REFERER = 'http://116.178.28.170:3080/amOnline/zdjk-company/';

// 企业端标记：把日期里的年份去掉（09-20 13:22），结束时间只取时分（14:30）
const prettyDate = (s) => String(s || '').replace(/^\d{4}-(\d{2})-(\d{2}) /, '$1-$2 ');

function markText(rows) {
  return rows.map((x) => {
    const parts = [];
    const flag = (x.reviseFlagName || '') + (x.reviseFlagItemName ? '-' + x.reviseFlagItemName : '');
    if (flag) parts.push(flag);
    if (x.startTime && x.endTime) {
      parts.push(`${prettyDate(x.startTime)}~${prettyDate(x.endTime).slice(-5)}(${x.duration}h)`);
    }
    if (x.reason) parts.push(x.reason);
    if (x.updatedBy) {
      const t = String(x.updatedTime || '').slice(5, 16); // "09-21 09:57"
      parts.push(`${x.updatedBy} ${t}填报`);
    }
    return parts.join(' ');
  }).join('；');
}

async function fetchMarks(psId, day, cookie, env) {
  if (!cookie) {
    return { attempted: false, total: 0, byMp: new Map(), error: '未配置 CNEMC_COOKIE' };
  }
  const params = new URLSearchParams({
    method: '/sign/qy/list',
    pageNum: '1', pageSize: '100',
    dateTime: `${day},${day}`,
    type: '2', moduleCode: '', mpId: '-1', shId: '-1', psId, status: '-1',
  });
  params.set('_t', String(Date.now()));
  const proxy = env && env.MARKS_PROXY_URL ? String(env.MARKS_PROXY_URL).replace(/\/+$/, '') : null;
  const target = proxy
    ? `${proxy}${MARKS_PATH}?${params.toString()}`
    : `${MARKS_HOST}${MARKS_PATH}?${params.toString()}`;
  try {
    const headers = {
      Cookie: cookie,
      Accept: 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Referer: MARKS_REFERER,
    };
    if (proxy && env.MARKS_PROXY_TOKEN) headers['Authorization'] = `Bearer ${env.MARKS_PROXY_TOKEN}`;
    const r = await fetch(target, { headers });
    if (r.status !== 200) {
      return { attempted: true, total: 0, byMp: new Map(), error: `HTTP ${r.status}` };
    }
    const txt = new TextDecoder('utf-8').decode(await r.arrayBuffer());
    let json;
    try { json = JSON.parse(txt); } catch { return { attempted: true, total: 0, byMp: new Map(), error: '响应解析失败' }; }
    if (json.code !== 200) {
      return { attempted: true, total: 0, byMp: new Map(), error: `企业端 code ${json.code}` };
    }
    const rows = (json.data && json.data.rows) || [];
    const byMp = new Map();
    for (const x of rows) {
      const k = String(x.mpName || '').trim();
      if (!byMp.has(k)) byMp.set(k, []);
      byMp.get(k).push(x);
    }
    const byMpObj = new Map();
    for (const [k, list] of byMp) byMpObj.set(k, { manual: markText(list), auto: null });
    return { attempted: true, total: rows.length, byMp: byMpObj, error: null };
  } catch (e) {
    return { attempted: true, total: 0, byMp: new Map(), error: `请求失败 ${e.message}` };
  }
}

export { MARKS_HOST, MARKS_PATH, MARKS_REFERER, prettyDate, markText, fetchMarks };
