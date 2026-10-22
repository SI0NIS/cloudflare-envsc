// io/push.js —— 推送通道：Bark 主 + 邮件兜底（Resend；Workers 无 SMTP）

async function pushBark(key, title, body, level) {
  if (!key) return { channel: 'bark', ok: false, error: 'BARK_KEY 未配置' };
  try {
    const r = await fetch(`https://api.day.app/${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body, level: level || 'active', group: '有效传输率' }),
    });
    const txt = await r.text();
    let json; try { json = JSON.parse(txt); } catch { json = { raw: txt.slice(0, 200) }; }
    return { channel: 'bark', ok: json && json.code === 200, resp: json };
  } catch (e) {
    return { channel: 'bark', ok: false, error: e.message };
  }
}

async function pushEmail(env, title, body) {
  if (!env.RESEND_API_KEY || !env.MAIL_TO || !env.MAIL_FROM) {
    return { channel: 'email', ok: false, error: '邮件未配置' };
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: [env.MAIL_TO],
        subject: title,
        text: body || '',
      }),
    });
    return { channel: 'email', ok: r.status === 200 || r.status === 201, status: r.status };
  } catch (e) {
    return { channel: 'email', ok: false, error: e.message };
  }
}

export { pushBark, pushEmail };
