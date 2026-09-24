// Applies company branding (name, logo, tagline) to any page that includes it.
// Runs on the kiosk, landing, and admin pages so a business owner's branding
// shows everywhere. Safe if the endpoint is unreachable; falls back silently.
(function () {
  fetch('/api/branding')
    .then((r) => r.json())
    .then((b) => {
      const name = (b.company_name || '').trim();
      const hasLogo = !!b.logo_data_url;

      // Browser tab needs text (a logo can't render in a tab): prefer the
      // company name, then the tagline, then fall back to Allokis.
      const titleName = name || (b.tagline || '').trim() || 'Allokis';
      const suffix = (document.title.split('·')[1] || '').trim();
      document.title = suffix ? titleName + ' · ' + suffix : titleName;

      // Leave the default Allokis logo
      // untouched only when truly unconfigured: no logo and no custom name.
      const unconfigured = (!name || name === 'Allokis' || name === 'StockTrax') && !hasLogo;
      if (unconfigured) return;

      document.querySelectorAll('.wordmark').forEach((el) => {
        el.innerHTML = '';
        if (hasLogo) {
          const img = document.createElement('img');
          img.className = 'brand-logo';
          img.src = b.logo_data_url;
          img.alt = name || 'logo';
          el.appendChild(img);
        }
        // Render text only if a name is set. Blank name + logo = logo only.
        if (name) {
          const span = document.createElement('span');
          span.className = 'brand-name';
          span.textContent = name;
          el.appendChild(span);
        }
      });

      // Marketing tagline (landing page only; kiosk keeps its context label).
      if (b.tagline) {
        document.querySelectorAll('.tag, [data-brand-tagline]').forEach((el) => {
          el.textContent = b.tagline;
        });
      }
    })
    .catch(() => { /* keep default Allokis branding */ });
})();
