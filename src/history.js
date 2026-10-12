// 读取服务器上 Claude Code 自己保存的会话（~/.claude/projects/<目录>/<会话ID>.jsonl），
// 列表与解析都在服务器上用 python3 完成，只把精简后的结果传回来。

// 列出所有会话：标题、第一句话、所在目录、时间、消息条数
const LIST_SCRIPT = String.raw`
import json, os, glob, sys
root = os.path.expanduser('~/.claude/projects')
out = []
SKIP = ('<command-', '<local-command', 'Caveat:', '<system-reminder')

def text_of(content):
    if isinstance(content, str): return content
    if isinstance(content, list):
        parts = [c.get('text', '') for c in content if isinstance(c, dict) and c.get('type') == 'text']
        return '\n'.join(p for p in parts if p)
    return ''

for f in glob.glob(os.path.join(glob.escape(root), '*', '*.jsonl')):
    sid = os.path.basename(f)[:-6]
    info = {'id': sid, 'project': os.path.basename(os.path.dirname(f)), 'cwd': '', 'title': '', 'first': '',
            'prompts': 0, 'replies': 0, 'mtime': int(os.path.getmtime(f) * 1000), 'size': os.path.getsize(f)}
    side = True
    try:
        with open(f, encoding='utf-8', errors='replace') as fh:
            for line in fh:
                try: d = json.loads(line)
                except Exception: continue
                t = d.get('type')
                if t in ('summary', 'custom-title', 'ai-title'):
                    info['title'] = d.get('summary') or d.get('customTitle') or d.get('aiTitle') or d.get('title') or info['title']
                if not info['cwd'] and d.get('cwd'): info['cwd'] = d['cwd']
                if d.get('isSidechain') is False: side = False
                if t == 'user' and not d.get('isMeta') and not d.get('isSidechain'):
                    txt = text_of((d.get('message') or {}).get('content')).strip()
                    if txt and not txt.startswith(SKIP):
                        info['prompts'] += 1
                        if not info['first']: info['first'] = txt[:200]
                elif t == 'assistant' and not d.get('isSidechain'):
                    info['replies'] += 1
    except Exception:
        continue
    if side or not info['prompts']: continue
    out.append(info)
out.sort(key=lambda x: -x['mtime'])
print(json.dumps(out[:500], ensure_ascii=False))
`;

// 解析一个会话，转成客户端的消息格式
const LOAD_SCRIPT = String.raw`
import json, os, sys, glob
root = os.path.expanduser('~/.claude/projects')
sid = sys.argv[1]
files = glob.glob(os.path.join(glob.escape(root), '*', sid + '.jsonl'))
if not files: print(json.dumps({'error': 'not found'})); sys.exit(0)
f = files[0]
SKIP = ('<command-', '<local-command', 'Caveat:', '<system-reminder')
msgs = []; tools = {}; cwd = ''; title = ''

def cut(s, n):
    s = s if isinstance(s, str) else json.dumps(s, ensure_ascii=False)
    return s if len(s) <= n else s[:n] + '\n…'

def small_input(inp):
    if not isinstance(inp, dict): return {}
    return {k: (v if not isinstance(v, str) or len(v) <= 400 else v[:400] + '…') for k, v in list(inp.items())[:8] if not isinstance(v, (list, dict))}

def assistant():
    if not msgs or msgs[-1]['role'] != 'assistant':
        msgs.append({'role': 'assistant', 'blocks': [], 'ts': 0})
    return msgs[-1]

with open(f, encoding='utf-8', errors='replace') as fh:
    for line in fh:
        try: d = json.loads(line)
        except Exception: continue
        t = d.get('type')
        if t in ('summary', 'custom-title', 'ai-title'):
            title = d.get('summary') or d.get('customTitle') or d.get('aiTitle') or d.get('title') or title
        if d.get('isSidechain') or d.get('isMeta'): continue
        if not cwd and d.get('cwd'): cwd = d['cwd']
        msg = d.get('message') or {}
        content = msg.get('content')
        if t == 'user':
            if isinstance(content, list) and any(isinstance(c, dict) and c.get('type') == 'tool_result' for c in content):
                for c in content:
                    if isinstance(c, dict) and c.get('type') == 'tool_result' and c.get('tool_use_id') in tools:
                        b = tools[c['tool_use_id']]
                        r = c.get('content')
                        if isinstance(r, list): r = '\n'.join(x.get('text', '[' + x.get('type', '') + ']') for x in r if isinstance(x, dict))
                        b['preview'] = cut(r or '', 1500)
                        b['status'] = 'err' if c.get('is_error') else 'ok'
                continue
            txt = content if isinstance(content, str) else '\n'.join(c.get('text', '') for c in (content or []) if isinstance(c, dict) and c.get('type') == 'text')
            txt = (txt or '').strip()
            if not txt or txt.startswith(SKIP): continue
            msgs.append({'role': 'user', 'text': txt, 'files': [], 'ts': 0})
        elif t == 'assistant' and isinstance(content, list):
            a = assistant()
            for c in content:
                if not isinstance(c, dict): continue
                if c.get('type') == 'text' and c.get('text'):
                    if a['blocks'] and a['blocks'][-1]['type'] == 'text': a['blocks'][-1]['text'] += c['text']
                    else: a['blocks'].append({'type': 'text', 'text': c['text']})
                elif c.get('type') == 'tool_use':
                    b = {'type': 'tool', 'id': c.get('id'), 'name': c.get('name'), 'input': small_input(c.get('input')), 'status': 'ok'}
                    tools[c.get('id')] = b
                    a['blocks'].append(b)
            if d.get('uuid'):
                a['anchor'] = d['uuid']; a['anchorSid'] = sid
print(json.dumps({'id': sid, 'cwd': cwd, 'title': title, 'mtime': int(os.path.getmtime(f) * 1000), 'messages': msgs}, ensure_ascii=False))
`;

const SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function listSessions(remote) {
  const r = await remote.exec('python3 -', LIST_SCRIPT);
  if (r.code !== 0) throw new Error(/not found/.test(r.err) ? '服务器上没有 python3，无法读取会话' : (r.err || '读取失败').slice(-300));
  return JSON.parse(r.out);
}

async function loadSession(remote, sid) {
  if (!SID_RE.test(sid)) throw new Error('会话编号不合法');
  const r = await remote.exec(`python3 - ${sid}`, LOAD_SCRIPT);
  if (r.code !== 0) throw new Error((r.err || '读取失败').slice(-300));
  const j = JSON.parse(r.out);
  if (j.error) throw new Error('服务器上找不到这个会话');
  return j;
}

module.exports = { listSessions, loadSession };
