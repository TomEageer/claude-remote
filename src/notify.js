// Webhook 通知：回复完成、出错、需要你处理时，发到配置的地址。
// 各家的 webhook 格式不一样，这里支持两种：
//   feishu：飞书群机器人（卡片消息；机器人开了「签名校验」就填密钥）
//   json：通用 JSON，字段见下面 genericBody；同时带 text / content，Slack、Discord 之类可以直接显示
const crypto = require('crypto');
const { net } = require('electron');

const KIND = {
  done: { title: 'Claude 已完成', color: 'green', status: '已完成' },
  error: { title: 'Claude 回复出错', color: 'red', status: '出错' },
  ask: { title: 'Claude 需要你处理', color: 'orange', status: '等你处理' },
  test: { title: '测试通知', color: 'blue', status: '测试' },
};

const fmtDuration = (ms) => {
  if (!ms || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} 分 ${s % 60} 秒` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
};
const fmtTime = (t) => {
  const d = new Date(t || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
// 飞书 lark_md 里会被当成格式的字符转义掉，标题里有 * _ 之类不会乱
const md = (s) => String(s || '').replace(/([*_~`\[\]<>])/g, '\\$1');

function feishuBody(e, secret) {
  const k = KIND[e.kind] || KIND.done;
  const fields = [
    ['会话', e.title || '新对话'],
    ['状态', e.statusText || k.status],
    ['服务器', e.server || ''],
    ['耗时', fmtDuration(e.durationMs)],
  ].filter(([, v]) => v).map(([n, v]) => ({ is_short: true, text: { tag: 'lark_md', content: `**${n}**\n${md(v)}` } }));
  const elements = [{ tag: 'div', fields }];
  if (e.summary) elements.push({ tag: 'hr' }, { tag: 'div', text: { tag: 'lark_md', content: md(e.summary) } });
  elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: `Claude 远程助手 · ${fmtTime(e.time)}` }] });
  const body = {
    msg_type: 'interactive',
    card: { config: { wide_screen_mode: true }, header: { template: k.color, title: { tag: 'plain_text', content: k.title } }, elements },
  };
  if (secret) {
    // 飞书签名：以「时间戳 + 换行 + 密钥」为 key，对空字符串做 HmacSHA256，再 base64
    const timestamp = String(Math.floor(Date.now() / 1000));
    body.timestamp = timestamp;
    body.sign = crypto.createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64');
  }
  return body;
}

function genericBody(e) {
  const k = KIND[e.kind] || KIND.done;
  const line = `[${k.title}] ${e.title || '新对话'}${e.server ? ` · ${e.server}` : ''}${e.durationMs ? ` · ${fmtDuration(e.durationMs)}` : ''}${e.summary ? `\n${e.summary}` : ''}`;
  return {
    app: 'Claude 远程助手',
    event: e.kind, // done | error | ask | test
    status: e.statusText || k.status,
    title: e.title || '新对话',
    server: e.server || null,
    durationMs: e.durationMs || null,
    summary: e.summary || '',
    sessionId: e.sessionId || null,
    time: new Date(e.time || Date.now()).toISOString(),
    text: line,
    content: line,
  };
}

async function sendWebhook({ kind, url, secret }, event) {
  if (!/^https?:\/\/\S+$/i.test(String(url || ''))) throw new Error('Webhook 地址要以 http:// 或 https:// 开头');
  const body = kind === 'feishu' ? feishuBody(event, String(secret || '').trim()) : genericBody(event);
  const res = await net.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) });
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`对方返回 HTTP ${res.status}${text ? '：' + text.slice(0, 160) : ''}`);
  if (kind === 'feishu') {
    // 飞书出错时 HTTP 也是 200，看返回里的 code
    let j = null;
    try { j = JSON.parse(text); } catch (_) {}
    const code = j && (j.code != null ? j.code : j.StatusCode);
    if (code) {
      const msg = j.msg || j.StatusMessage || '';
      const hint = /sign/i.test(msg) ? '（签名不对：检查密钥，或机器人没开签名校验就别填密钥）' : /keyword/i.test(msg) ? '（机器人设置了关键词：把「Claude」加进关键词）' : /ip/i.test(msg) ? '（机器人设置了 IP 白名单）' : '';
      throw new Error(`飞书返回错误 ${code}：${msg}${hint}`);
    }
  }
  return true;
}

module.exports = { sendWebhook };
