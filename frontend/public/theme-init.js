// Runs before first paint (blocking, external file so the CSP needs no 'unsafe-inline').
// Mirrors src/theme/theme.ts: 'auto' = light from 07:00 to 18:59 local time, dark otherwise.
;(function () {
  var mode = 'auto'
  try {
    mode = localStorage.getItem('theme-mode') || 'auto'
  } catch (e) {}
  var h = new Date().getHours()
  var theme = mode === 'light' || mode === 'dark' ? mode : h >= 7 && h < 19 ? 'light' : 'dark'
  var root = document.documentElement
  root.dataset.theme = theme
  root.style.colorScheme = theme
  var meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', theme === 'light' ? '#f4f5f9' : '#0b0d14')
})()
