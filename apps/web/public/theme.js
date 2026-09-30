// Applies the saved or system theme before first paint, so the page never flashes the wrong one.
try {
  var saved = localStorage.getItem('magnetar-theme')
  var dark = saved ? saved === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
  document.documentElement.setAttribute('data-theme', dark ? 'mddark' : 'mdlight')
} catch {
  document.documentElement.setAttribute('data-theme', 'mdlight')
}
