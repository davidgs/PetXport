// Runs before the page is drawn, so there is no flash of the wrong theme.
// Keep in step with src/lib/theme.ts.
(function () {
  var choice = null;
  try {
    choice = localStorage.getItem('petxport-theme');
  } catch (e) {}
  var dark = choice === 'dark' || (choice !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  if (dark) {
    document.documentElement.classList.add('dark');
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', '#0b1220');
  }
})();
