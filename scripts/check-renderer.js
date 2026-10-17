// 界面的脚本都是普通 <script>，共用同一个全局作用域：两个文件在顶层定义了同名的 const / let / class，
// 页面加载时后一个文件会直接报错停掉。这里把每个文件顶层的定义收集起来，查出重名。
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'src', 'renderer');
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const files = [...html.matchAll(/<script src="([^"]+\.js)"/g)].map((m) => m[1]).filter((f) => !f.startsWith('vendor/'));
const seen = new Map(); // 名字 → [{ file, kind }]
for (const f of files) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  for (const m of src.matchAll(/^(const|let|var|class|function|async function)\s+([A-Za-z_$][\w$]*)/gm)) {
    const list = seen.get(m[2]) || [];
    list.push({ file: f, kind: m[1] });
    seen.set(m[2], list);
  }
}
const bad = [...seen].filter(([, l]) => l.length > 1 && l.some((x) => /const|let|class/.test(x.kind)));
if (bad.length) {
  console.error('界面脚本里有重名的全局定义（页面加载时会报错）：');
  for (const [name, l] of bad) console.error(`  ${name}: ${l.map((x) => `${x.file}(${x.kind})`).join('、')}`);
  process.exit(1);
}
// 加密协议电脑端和手机页面共用一份：src/renderer/e2e.js 必须和 mobile/e2e.js 一模一样
if (fs.readFileSync(path.join(dir, 'e2e.js'), 'utf8') !== fs.readFileSync(path.join(__dirname, '..', 'mobile', 'e2e.js'), 'utf8')) {
  console.error('src/renderer/e2e.js 和 mobile/e2e.js 不一致：改了一份要拷贝到另一份');
  process.exit(1);
}
console.log(`界面脚本没有重名的全局定义（检查了 ${files.length} 个文件）`);
