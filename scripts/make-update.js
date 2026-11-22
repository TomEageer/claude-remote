// 生成「快速更新」用的文件：dist/app-<平台>.asar.gz 和 dist/app-update.json。
// 软件检查到新版本、且 Electron 版本没变时，只下载对应平台的这个包（一两 MB）放进用户数据目录（见 src/boot.js），不用下载整个安装包。
// 用法：打完包后 node scripts/make-update.js（发版时把这几个文件一起传到 GitHub Release）
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const os = require('os');
const asarLib = require('@electron/asar');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const pkg = require(path.join(root, 'package.json'));
const sources = {
  darwin: path.join(dist, 'mac-arm64', `${pkg.build.productName}.app`, 'Contents', 'Resources', 'app.asar'),
  win32: path.join(dist, 'win-unpacked', 'resources', 'app.asar'),
};
// 安装包里除了 app.asar 还有别的东西（比如 resources/bin 里的 VPN 组件）变了的时候，把这里改成这个版本号：
// 比它旧的安装包不走快速更新（快速更新只换代码，带不上这些文件），改走完整更新
const MIN_BUNDLE = '1.8.0'; // 1.8.0 起带了键盘监听组件（app.asar.unpacked 里的原生模块），快速更新带不上
const info = { version: pkg.version, electron: require('electron/package.json').version, minBundle: MIN_BUNDLE };
// Windows 的包换了名字（-v2）：1.5.21 及以前的 Windows 版用 cmd 脚本替换 app.asar，安装路径有中文时必定失败；
// 它们找不到这个名字就会改走完整安装包更新（electron-updater），能正常升上来。新版本按新名字快速更新（见 src/updater.js）
const packName = (platform) => (platform === 'win32' ? 'app-win32-v2.asar.gz' : `app-${platform}.asar.gz`);
// 安装包里的 app.asar 有一部分文件（ssh2、键盘监听组件）放在旁边的 app.asar.unpacked 目录里；
// 快速更新只下载这一个 .asar，旁边没有那个目录，新代码一启动就报「找不到 ssh2」被当成坏包退回旧版。
// 所以快速更新包重新打一遍，把这些文件也装进 asar 里（asar 里的原生 .node 由 Electron 加载时自动取出）
function repack(file) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-repack-'));
  const out = path.join(tmp, 'app.asar');
  asarLib.extractAll(file, path.join(tmp, 'src'));
  return asarLib.createPackage(path.join(tmp, 'src'), out).then(() => {
    const entries = asarLib.listPackage(out, { isPack: true }).filter((e) => e.startsWith('unpack'));
    if (entries.length) throw new Error(`快速更新包里还有 ${entries.length} 个放在 unpacked 目录的文件`);
    return waitComplete(out).then((buf) => {
      verify(file, out);
      fs.rmSync(tmp, { recursive: true, force: true });
      return buf;
    });
  });
}
// createPackage 返回时最后一个文件可能还没写进盘（1.10.0 就因此少了 write-queue.js 的内容，新代码一加载就报错退回旧版）。
// 按目录表算出包应有的总长度，等文件长到这么大再读
function expectedSize(out) {
  const b = fs.readFileSync(out);
  const hp = b.readUInt32LE(4), base = 8 + hp, hs = b.readUInt32LE(12);
  const header = JSON.parse(b.slice(16, 16 + hs).toString('utf8'));
  let end = base;
  const walk = (node) => { for (const v of Object.values(node.files || {})) { if (v.files) walk(v); else if (!v.unpacked && v.offset !== undefined) end = Math.max(end, base + Number(v.offset) + v.size); } };
  walk(header);
  return end;
}
async function waitComplete(out) {
  for (let i = 0; i < 100; i++) {
    if (fs.statSync(out).size >= expectedSize(out)) return fs.readFileSync(out);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('快速更新包没有写完整');
}
// 逐个文件和原安装包比对内容，任何一个不一致就停，不许发出去
function verify(src, out) {
  let n = 0;
  for (const e of asarLib.listPackage(src)) {
    const rel = e.replace(/^[\\/]/, '');
    const st = asarLib.statFile(src, rel);
    if (st.files || st.link) continue;
    const a = asarLib.extractFile(src, rel), b = asarLib.extractFile(out, rel);
    if (!a.equals(b)) throw new Error(`快速更新包里的 ${rel} 和安装包不一致`);
    n++;
  }
  console.log(`  • 快速更新包逐个核对 ${n} 个文件，全部一致`);
}
(async () => {
for (const [platform, file] of Object.entries(sources)) {
  if (!fs.existsSync(file)) { console.log(`跳过 ${platform}：没有找到 ${path.relative(root, file)}`); continue; }
  // 只认这次打的包：版本号必须和 package.json 一致
  const stamp = fs.statSync(file).mtimeMs;
  if (Date.now() - stamp > 6 * 3600 * 1000) { console.log(`跳过 ${platform}：${path.relative(root, file)} 是 6 小时前的旧包`); continue; }
  const asar = await repack(file);
  const gz = zlib.gzipSync(asar, { level: 9 });
  fs.writeFileSync(path.join(dist, packName(platform)), gz);
  info[platform] = { sha512: crypto.createHash('sha512').update(asar).digest('base64'), size: asar.length, gzSize: gz.length };
  console.log(`  • ${platform}: app.asar ${(asar.length / 1048576).toFixed(1)} MB → ${packName(platform)} ${(gz.length / 1048576).toFixed(1)} MB`);
}
// VPN 组件（resources/bin 里的 crvpn）也随快速更新发：改了它不用再下完整安装包。
// 软件下载后校验 sha512，放进用户数据目录，优先于安装包里自带的那个（见 src/vpn.js）
info.bin = {};
for (const key of ['mac-arm64', 'mac-x64', 'win-x64']) {
  const file = path.join(root, 'vpn', 'dist', key, key.startsWith('win') ? 'crvpn.exe' : 'crvpn');
  if (!fs.existsSync(file)) continue;
  const raw = fs.readFileSync(file);
  const gz = zlib.gzipSync(raw, { level: 9 });
  fs.writeFileSync(path.join(dist, `crvpn-${key}.gz`), gz);
  info.bin[key] = { sha512: crypto.createHash('sha512').update(raw).digest('base64'), size: raw.length };
  console.log(`  • VPN 组件 ${key}: ${(raw.length / 1048576).toFixed(1)} MB → crvpn-${key}.gz ${(gz.length / 1048576).toFixed(1)} MB`);
}
fs.writeFileSync(path.join(dist, 'app-update.json'), JSON.stringify(info, null, 2));
console.log(`  • app-update.json：版本 ${info.version}，Electron ${info.electron}`);
// 中转枢纽 crrelay（手机远程控制用）跟着软件同一个版本发：编译各平台版本和一键安装脚本，一起传到 GitHub Release
require('child_process').execFileSync('sh', [path.join(root, 'scripts', 'build-relay.sh')], { stdio: 'inherit' });

})().catch((e) => { console.error(e); process.exit(1); });
