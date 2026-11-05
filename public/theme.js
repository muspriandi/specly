// Runs in <head> before first paint: applies the stored theme (or the OS setting) to avoid a flash.
(function () {
  var t = null;
  try { t = localStorage.getItem('theme'); } catch (e) { /* storage unavailable */ }
  var dark = t ? t === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.classList.toggle('dark', dark);
})();
