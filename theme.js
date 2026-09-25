// Runs before the page draws, so a chosen theme never flashes the other one.
// The choice is kept per browser; without one, the system's setting applies.
try {
  const theme = localStorage.getItem('markedTheme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {}
