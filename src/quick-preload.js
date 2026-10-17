'use strict';
// 快速输入小窗口用的桥：只开放这几个
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('quick', {
  submit: (p) => ipcRenderer.send('quick:submit', p),
  hide: () => ipcRenderer.send('quick:hide'),
  resize: (h) => ipcRenderer.send('quick:resize', h),
  pathForFile: (f) => webUtils.getPathForFile(f),
  onShow: (cb) => ipcRenderer.on('quick:show', (_e, ctx) => cb(ctx)),
});
