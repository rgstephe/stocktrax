// Kiosk theme: each device remembers its own choice (localStorage). If a device
// hasn't chosen, it uses the admin's default from /api/branding. Toggle flips
// and persists the local choice.
(function (global) {
  const KEY = 'stocktrax_theme';
  let adminDefault = 'dark';

  function apply(theme) {
    document.body.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
    const btn = document.getElementById('themeToggle');
    if (btn) btn.textContent = theme === 'light' ? '🌙' : '☀️';
  }

  function current() {
    return localStorage.getItem(KEY) || adminDefault;
  }

  function toggle() {
    const next = current() === 'light' ? 'dark' : 'light';
    localStorage.setItem(KEY, next);
    apply(next);
  }

  // Fetch the admin default, then apply the resolved theme.
  async function init() {
    try {
      const b = await (await fetch('/api/branding')).json();
      if (b && (b.theme_default === 'light' || b.theme_default === 'dark')) adminDefault = b.theme_default;
    } catch (e) { /* keep dark */ }
    apply(current());
    const btn = document.getElementById('themeToggle');
    if (btn) btn.addEventListener('click', toggle);
  }

  global.Theme = { init, toggle, current };
})(window);
