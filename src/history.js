// 读取服务器上 Claude Code 自己保存的会话（~/.claude/projects/<目录>/<会话ID>.jsonl），
// 列表与解析都在服务器上用 python3 完成，只把精简后的结果传回来。

// 列出会话：标题、第一句话、所在目录、时间、消息条数。
// FOLDER（脚本前面拼进来）不为空时只列这个文件夹和它下面子文件夹里的会话：
// Claude Code 按目录存（~/.claude/projects/<把路径里非字母数字换成 - >/），先按目录名筛，再用记录里的 cwd 确认
const LIST_SCRIPT = String.raw`
import json, os, glob, sys, re
root = os.path.join(os.path.expanduser(os.environ.get('CLAUDE_CONFIG_DIR') or '~/.claude'), 'projects')
folder = os.path.expanduser(FOLDER).rstrip('/') if FOLDER else ''
prefix = re.sub(r'[^a-zA-Z0-9]', '-', folder) if folder else ''
out = []
SKIP = ('<command-', '<local-command', 'Caveat:', '<system-reminder')

def text_of(content):
    if isinstance(content, str): return content
    if isinstance(content, list):
        parts = [c.get('text', '') for c in content if isinstance(c, dict) and c.get('type') == 'text']
        return '\n'.join(p for p in parts if p)
    return ''

for f in glob.glob(os.path.join(glob.escape(root), '*', '*.jsonl')):
    if prefix and not os.path.basename(os.path.dirname(f)).startswith(prefix): continue
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
                # 手动改的名字（custom-title）优先，其次自动标题（ai-title），再次摘要；同类以最后一次为准
                if t == 'custom-title' and d.get('customTitle'): info['_ct'] = d['customTitle']
                elif t == 'ai-title' and d.get('aiTitle'): info['_at'] = d['aiTitle']
                elif t == 'summary' and d.get('summary'): info['_sm'] = d['summary']
                if not info['cwd'] and d.get('cwd'): info['cwd'] = d['cwd']
                if d.get('isSidechain') is False: side = False
                if t == 'user' and not d.get('isMeta') and not d.get('isSidechain'):
                    txt = text_of((d.get('message') or {}).get('content')).strip()
                    if txt and not txt.startswith(SKIP):
                        info['prompts'] += 1
                        if not info['first']: info['first'] = re.split(r'\n+\[我(?:上传了|附上了)', txt)[0][:200] or '（附件）'
                elif t == 'assistant' and not d.get('isSidechain'):
                    info['replies'] += 1
    except Exception:
        continue
    info['title'] = info.pop('_ct', None) or info.pop('_at', None) or info.pop('_sm', None) or ''
    info.pop('_ct', None); info.pop('_at', None); info.pop('_sm', None)
    if side or not info['prompts']: continue
    if folder and info['cwd'] and info['cwd'] != folder and not info['cwd'].startswith(folder + '/'): continue
    out.append(info)
out.sort(key=lambda x: -x['mtime'])
print(json.dumps(out[:500], ensure_ascii=False))
`;

// 解析一个会话，转成客户端的消息格式
const LOAD_SCRIPT = String.raw`
import json, os, sys, glob, re
root = os.path.join(os.path.expanduser(os.environ.get('CLAUDE_CONFIG_DIR') or '~/.claude'), 'projects')
sid = sys.argv[1]
files = glob.glob(os.path.join(glob.escape(root), '*', sid + '.jsonl'))
if not files: print(json.dumps({'error': 'not found'})); sys.exit(0)
f = files[0]
SKIP = ('<command-', '<local-command', 'Caveat:', '<system-reminder')
msgs = []; tools = {}; cwd = ''; titles = {}

def cut(s, n):
    s = s if isinstance(s, str) else json.dumps(s, ensure_ascii=False)
    return s if len(s) <= n else s[:n] + '\n…'

ATTACH_RE = re.compile(r'\n*\[我(?:上传了|附上了)[^\]\n]*路径如下，请直接读取\]\n((?:- [^\n]+\n?)+)\s*$')
DIR_RE = re.compile(r'（文件夹，里面有 \d+ 个文件）$')

def split_attach(txt):
    m = ATTACH_RE.search(txt)
    if not m: return txt, []
    out = []
    for line in m.group(1).splitlines():
        path = line[2:].strip()
        is_dir = bool(DIR_RE.search(path))
        path = DIR_RE.sub('', path).strip()
        if path: out.append({'name': path.replace('\\', '/').rstrip('/').split('/')[-1], 'path': '' if is_dir else path, 'isDir': is_dir})
    body = txt[:m.start()].strip()
    return ('' if body == '请查看我上传的文件。' else body), out

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
        if t == 'custom-title' and d.get('customTitle'): titles['c'] = d['customTitle']
        elif t == 'ai-title' and d.get('aiTitle'): titles['a'] = d['aiTitle']
        elif t == 'summary' and d.get('summary'): titles['s'] = d['summary']
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
                        if isinstance(r, list): r = '\n'.join(x.get('text') or ('（这是一张图片，点右上角「预览」查看）' if x.get('type') == 'image' else '[' + x.get('type', '') + ']') for x in r if isinstance(x, dict))
                        b['preview'] = cut(r or '', 1500)
                        b['status'] = 'err' if c.get('is_error') else 'ok'
                        tur = d.get('toolUseResult')
                        if isinstance(tur, dict) and tur.get('resolvedModel'): b['model'] = tur['resolvedModel']
                continue
            txt = content if isinstance(content, str) else '\n'.join(c.get('text', '') for c in (content or []) if isinstance(c, dict) and c.get('type') == 'text')
            txt = (txt or '').strip()
            if not txt or txt.startswith(SKIP): continue
            txt, att = split_attach(txt)
            msgs.append({'role': 'user', 'text': txt, 'files': [{'name': a['name'], 'remotePath': a['path']} for a in att], 'ts': 0})
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
title = titles.get('c') or titles.get('a') or titles.get('s') or ''
print(json.dumps({'id': sid, 'cwd': cwd, 'title': title, 'mtime': int(os.path.getmtime(f) * 1000), 'messages': msgs}, ensure_ascii=False))
`;

// 找能用的 Python：Linux / macOS 一般是 python3；Windows 上可能是 python 或 py（python3 可能只是应用商店的占位程序）
const PY = 'for __p in python3 python py; do "$__p" -c "import sys" >/dev/null 2>&1 && break; __p=; done; [ -n "$__p" ] || { echo "python3: command not found" >&2; exit 127; }; "$__p"';

const SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// folder：只看这个文件夹（含子文件夹）；路径作为 Python 字符串拼进脚本（JSON 字符串就是合法的 Python 字符串），不经过 shell
async function listSessions(remote, folder) {
  const r = await remote.exec(`${PY} -`, `FOLDER = ${JSON.stringify(String(folder || ''))}\n` + LIST_SCRIPT);
  if (r.code !== 0) throw new Error(/not found|xcode-select|developer tools/i.test(r.err) ? '服务器上没有 python3，无法读取会话（Mac 上可以运行 xcode-select --install 安装）' : (r.err || '读取失败').slice(-300));
  return JSON.parse(r.out);
}

// 用过 Claude Code 的文件夹：每个项目只读最新几个会话文件的开头找出 cwd，不解析整份记录（会话多时也很快）
const FOLDERS_SCRIPT = String.raw`
import json, os, glob
root = os.path.join(os.path.expanduser(os.environ.get('CLAUDE_CONFIG_DIR') or '~/.claude'), 'projects')
out = []
for d in glob.glob(os.path.join(glob.escape(root), '*')):
    files = glob.glob(os.path.join(glob.escape(d), '*.jsonl'))
    if not files: continue
    files.sort(key=os.path.getmtime, reverse=True)
    cwd = ''
    for f in files[:3]:
        try:
            with open(f, encoding='utf-8', errors='replace') as fh:
                for i, line in enumerate(fh):
                    if i > 300: break
                    if '"cwd"' not in line: continue
                    try: cwd = json.loads(line).get('cwd') or ''
                    except Exception: cwd = ''
                    if cwd: break
        except Exception: pass
        if cwd: break
    if not cwd or not os.path.isdir(cwd): continue
    if cwd.startswith(('/tmp', '/private/', '/var/folders')): continue
    out.append({'cwd': cwd, 'sessions': len(files), 'mtime': int(os.path.getmtime(files[0]) * 1000)})
out.sort(key=lambda x: -x['mtime'])
print(json.dumps(out[:30], ensure_ascii=False))
`;

async function listFolders(remote) {
  const r = await remote.exec(`${PY} -`, FOLDERS_SCRIPT);
  if (r.code !== 0) return [];
  try { return JSON.parse(r.out); } catch (_) { return []; }
}

async function loadSession(remote, sid) {
  if (!SID_RE.test(sid)) throw new Error('会话编号不合法');
  const r = await remote.exec(`${PY} - ${sid}`, LOAD_SCRIPT);
  if (r.code !== 0) throw new Error((r.err || '读取失败').slice(-300));
  const j = JSON.parse(r.out);
  if (j.error) throw new Error('服务器上找不到这个会话');
  return j;
}

module.exports = { listFolders, listSessions, loadSession, PY };
