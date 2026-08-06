// Applies company branding (name, logo, tagline) to any page that includes it.
// Runs on the kiosk, landing, and admin pages so a business owner's branding
// shows everywhere. Safe if the endpoint is unreachable — falls back silently.
(function () {
  fetch('/api/branding')
    .then((r) => r.json())
    .then((b) => {
      const name = (b.company_name || 'StockTrax').trim();

      // If nothing's been customized, leave the hand-designed "StockTrax"
      // wordmark (with its amber accent) exactly as authored.
      const isDefault = name === 'StockTrax' && !b.logo_data_url;

      // Browser tab title: "<Company> — <page context>"
      const suffix = (document.title.split('—')[1] || '').trim();
      document.title = suffix ? name + ' — ' + suffix : name;

      // Wordmark: logo + name, or just the name.
      if (!isDefault) document.querySelectorAll('.wordmark').forEach((el) => {
        el.innerHTML = '';
        if (b.logo_data_url) {
          const img = document.createElement('img');
          img.className = 'brand-logo';
          img.src = b.logo_data_url;
          img.alt = '';
          el.appendChild(img);
        }
        const span = document.createElement('span');
        span.className = 'brand-name';
        span.textContent = name;
        el.appendChild(span);
      });

      // Marketing tagline (landing page only; kiosk keeps its context label).
      if (b.tagline) {
        document.querySelectorAll('.tag, [data-brand-tagline]').forEach((el) => {
          el.textContent = b.tagline;
        });
      }
    })
    .catch(() => { /* keep default StockTrax branding */ });
})();
