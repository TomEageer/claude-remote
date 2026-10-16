// 在样式和页面脚本之前运行：按设置里选的外观先定好页面底色和状态栏颜色。
// 从主屏幕打开时，iPhone 在启动那一刻按「主题色」给顶部状态栏上色，之后基本不再改，
// 所以选了「浅色 / 深色」时只留一个不分系统模式的主题色，跟随系统时才留浅色、深色两个让系统挑。
(function () {
  var LIGHT = '#faf9f5', DARK = '#262624';
  function setThemeColor(theme) {
    var head = document.head;
    var old = head.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < old.length; i++) old[i].remove();
    var add = function (color, media) {
      var m = document.createElement('meta');
      m.name = 'theme-color';
      m.content = color;
      if (media) m.media = media;
      head.appendChild(m);
    };
    var root = document.documentElement;
    if (theme === 'light' || theme === 'dark') {
      root.dataset.theme = theme;
      root.style.background = theme === 'dark' ? DARK : LIGHT;
      add(theme === 'dark' ? DARK : LIGHT);
    } else {
      delete root.dataset.theme;
      root.style.background = '';
      add(LIGHT, '(prefers-color-scheme: light)');
      add(DARK, '(prefers-color-scheme: dark)');
    }
  }
  window.setThemeColor = setThemeColor;
  var prefs = {};
  try { prefs = JSON.parse(localStorage.getItem('crPrefs') || '{}') || {}; } catch (e) {}
  setThemeColor(prefs.theme || '');
})();
