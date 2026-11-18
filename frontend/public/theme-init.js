// Runs before first paint (blocking, external file so the CSP needs no 'unsafe-inline').
// Mirrors src/theme/theme.js: 'auto' = light from 07:00 to 18:59 local time, dark otherwise. Also sets the skin
// (src/theme/skin.js) so the first paint already uses the right one.
;(function () {
  var mode = 'auto'
  try {
    mode = localStorage.getItem('theme-mode') || 'auto'
  } catch (e) {
    /* storage blocked (private mode): fall back to auto */
  }
  var h = new Date().getHours()
  var theme = mode === 'light' || mode === 'dark' ? mode : h >= 7 && h < 19 ? 'light' : 'dark'
  var root = document.documentElement
  root.dataset.theme = theme
  root.style.colorScheme = theme
  var skin = 'showcase'
  try {
    skin = localStorage.getItem('site-skin') === 'personal' ? 'personal' : 'showcase'
  } catch (e) {
    /* storage blocked: default skin */
  }
  root.dataset.skin = skin
  var colors = skin === 'showcase' ? ['#f5f5f7', '#000000'] : ['#f4f5f9', '#0b0d14']
  var meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', theme === 'light' ? colors[0] : colors[1])
})()
