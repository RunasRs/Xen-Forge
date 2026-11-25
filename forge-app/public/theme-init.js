(function () {
  var root = document.documentElement;
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function readMode() {
    try {
      var t = localStorage.getItem('theme');
      if (t === 'light' || t === 'dark') return t;
    } catch (e) {}
    return 'system';
  }

  function apply() {
    var mode = readMode();
    var theme = mode === 'system' ? (media && media.matches ? 'dark' : 'light') : mode;
    root.setAttribute('data-theme', theme);
    root.setAttribute('data-theme-mode', mode);
    document.dispatchEvent(new CustomEvent('forge-theme-change'));
  }

  function setMode(mode) {
    try {
      if (mode === 'light' || mode === 'dark') localStorage.setItem('theme', mode);
      else localStorage.removeItem('theme');
    } catch (e) {}
    apply();
  }

  apply();

  if (media) {
    var onSystemChange = function () { if (readMode() === 'system') apply(); };
    if (media.addEventListener) media.addEventListener('change', onSystemChange);
    else if (media.addListener) media.addListener(onSystemChange);
  }

  window.addEventListener('storage', function (e) {
    if (e.key === 'theme' || e.key === null) apply();
  });

  window.forgeTheme = { mode: readMode, setMode: setMode };
})();
