// Runs before the page paints so a saved light/dark choice never flashes the wrong theme.
try {
  const saved = localStorage.getItem('shoresafe-theme');
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
} catch { /* storage blocked: follow the system setting */ }
