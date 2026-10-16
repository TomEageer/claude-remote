// Windows：把应用图标写进 .exe（Mac 上打 Windows 包时 electron-builder 改不了 exe 资源，
// 不处理的话桌面快捷方式和任务栏会显示 Electron 默认图标）。用纯 JS 的 resedit，不需要 Windows 环境
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName === 'darwin') return adhocSign(ctx);
  if (ctx.electronPlatformName !== 'win32') return;
  const ResEdit = await import('resedit');
  const exe = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.exe`);
  const pe = ResEdit.NtExecutable.from(fs.readFileSync(exe), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(pe);
  const ico = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(__dirname, 'icon.ico')));
  // 沿用 exe 里原来那组图标的编号和语言，只换内容
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const id = groups.length ? groups[0].id : 1;
  const lang = groups.length ? groups[0].lang : 1033;
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, id, lang, ico.icons.map((i) => i.data));
  res.outputResource(pe);
  fs.writeFileSync(exe, Buffer.from(pe.generate()));
  console.log(`  • 已把图标写进 ${path.basename(exe)}（图标组 ${id}，${ico.icons.length} 个尺寸）`);
};

// macOS 签名（没有 Apple 开发者证书）：
// - 打包这台电脑的钥匙串里有「Claude Remote Code Signing」自签名证书时用它签：macOS 认的身份是「程序标识 + 这张证书」，
//   每次打包都不变，访问「文稿」之类文件夹授权一次以后，升级版本也不会再问
// - 没有这张证书（别人自己编译）就做临时签名（ad-hoc）：签名每次打包都变，系统会把新版本当成新软件重新问一次授权
// 不签的话打包时改过的文件让原签名失效，别人从网上下载后会被提示「已损坏」且没法打开；
// 签了之后变成「无法验证开发者」，可以在「系统设置 → 隐私与安全性」里点「仍要打开」
const SIGN_ID = 'Claude Remote Code Signing';
function hasSignId() {
  try {
    require('child_process').execFileSync('security', ['find-certificate', '-c', SIGN_ID], { stdio: 'ignore' });
    return true;
  } catch (_) { return false; }
}
function adhocSign(ctx) {
  const { execFileSync } = require('child_process');
  const app = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
  const id = hasSignId() ? SIGN_ID : '-';
  execFileSync('codesign', ['--force', '--deep', '--sign', id, app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  console.log(`  • 已给 ${path.basename(app)} 签名：${id === '-' ? '临时签名' : id}（${ctx.arch === 3 ? 'arm64' : 'x64'}）`);
}
