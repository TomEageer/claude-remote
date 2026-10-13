// Windows：把应用图标写进 .exe（Mac 上打 Windows 包时 electron-builder 改不了 exe 资源，
// 不处理的话桌面快捷方式和任务栏会显示 Electron 默认图标）。用纯 JS 的 resedit，不需要 Windows 环境
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(ctx) {
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
