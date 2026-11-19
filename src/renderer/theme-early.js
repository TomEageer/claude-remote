'use strict';
// 最先执行：数据要过一会儿才从主进程读回来，这之前先按上次用的主题上色，不然每次打开都会先闪一下默认主题
try { document.documentElement.dataset.ui = localStorage.getItem('uiStyle') === 'slate' ? 'slate' : 'classic'; } catch (_) {}
