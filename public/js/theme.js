// Kiosk theme: each device remembers its own choice (localStorage). If a device
// hasn't chosen, it uses the admin's default from /api/branding. Toggle flips
// and persists the local choice.
(function (global) {
  const KEY = 'allokis_theme';
  const OLD_KEY = 'stocktrax_theme'; // pre-rename key, read once so devices keep their choice
  let adminDefault = 'dark';

  function apply(theme) {
    document.body.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
    const btn = document.getElementById('themeToggle');
    if (btn) btn.textContent = theme === 'light' ? '🌙' : '☀️';
  }

  function current() {
    try {
      return localStorage.getItem(KEY) || localStorage.getItem(OLD_KEY) || adminDefault;
    } catch (e) { return adminDefault; }
  }

  function toggle() {
    const next = current() === 'light' ? 'dark' : 'light';
    try { localStorage.setItem(KEY, next); } catch (e) { /* ignore */ }
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
