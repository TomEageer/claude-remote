// 真实验证：第一次授权时带「总是允许」规则，第二条同类命令不应再来询问
const { spawn } = require('child_process');
const p = spawn('claude', ['-p','--output-format','stream-json','--verbose','--input-format','stream-json','--permission-prompt-tool','stdio','--permission-mode','default','--model','haiku','--setting-sources','project'], { cwd: '/tmp' });
let buf = '', asks = 0;
const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
send({ type: 'user', message: { role: 'user', content: '依次用 Bash 工具各执行一次：touch /tmp/crperm-1 和 touch /tmp/crperm-2（不要并行，一条一条来）。两条都执行完再回复"完成"。' } });
p.stdout.on('data', (c) => {
  buf += c; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.type === 'control_request' && d.request.subtype === 'can_use_tool') {
      asks++; console.log('ASK', d.request.input.command);
      const first = asks === 1;
      send({ type: 'control_response', response: { subtype: 'success', request_id: d.request_id, response: { behavior: 'allow', updatedInput: d.request.input, ...(first ? { updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch:*' }], behavior: 'allow', destination: 'session' }] } : {}) } } });
    }
    if (d.type === 'result') { console.log('RESULT asks=', asks, String(d.result).slice(0, 60)); p.kill(); }
  }
});
setTimeout(() => { console.log('TIMEOUT asks=', asks); p.kill(); }, 90000);
