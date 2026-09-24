// Isolated printing. Everything we print (labels, badge sheets, the reorder
// list, the activity log) is written into a hidden, throw-away iframe and
// printed from there, so the browser only ever sees that document, never the
// admin page behind it. This doesn't depend on page CSS, so a stale cached
// stylesheet can't cause the whole page to print.
(function (global) {
  const BASE_CSS = `
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #fff; color: #000; }
    body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 11pt; }
    svg { display: block; }
    .mono { font-family: ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace; }
  `;

  function printHtml(bodyHtml, opts) {
    opts = opts || {};
    const old = document.getElementById('__printFrame');
    if (old) old.remove();
    const frame = document.createElement('iframe');
    frame.id = '__printFrame';
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
    document.body.appendChild(frame);

    const doc = frame.contentDocument;
    doc.open();
    doc.write('<!DOCTYPE html><html><head><meta charset="utf-8"><title>' +
      escapeHtml(opts.title || '') + '</title><style>' + BASE_CSS + (opts.css || '') +
      '</style></head><body>' + bodyHtml + '</body></html>');
    doc.close();

    // Give images (e.g. the logo) a moment to decode, then print.
    const go = () => {
      try {
        frame.contentWindow.focus();
        frame.contentWindow.print();
      } finally {
        setTimeout(() => frame.remove(), 1000);
      }
    };
    const imgs = [...doc.images].filter((i) => !i.complete);
    if (!imgs.length) return setTimeout(go, 50);
    let left = imgs.length;
    const done = () => { if (--left === 0) go(); };
    imgs.forEach((i) => { i.onload = done; i.onerror = done; });
    setTimeout(() => { if (left > 0) { left = 0; go(); } }, 2000);
  }

  // ---- barcode labels ------------------------------------------------------
  // size: 'sheet' (regular printer paper) or a label size like '2.25x1.25'
  // (inches, width x height) for thermal label printers.
  const LABEL_SIZES = {
    'sheet': null,
    '2.25x1.25': [2.25, 1.25],
    '2x1': [2, 1],
    '3x1': [3, 1],
    '4x2': [4, 2],
    '4x6': [4, 6],
  };

  function labelCss(size, withName) {
    const dims = LABEL_SIZES[size];
    if (!dims) {
      // Regular paper: barcode alone near the top of the page, 3in wide.
      return `
        @page { size: letter; margin: 0.5in; }
        .lbl { width: 3in; margin: 0 auto; text-align: center; }
        .lbl svg { width: 3in; height: auto; }
        .lbl .nm { font-weight: 700; font-size: 12pt; margin-bottom: 4pt; }
      `;
    }
    const [w, h] = dims;
    const pad = 0.08;
    const nameH = withName ? Math.min(0.28, h * 0.25) : 0;
    return `
      @page { size: ${w}in ${h}in; margin: 0; }
      .lbl { width: ${w}in; height: ${h}in; padding: ${pad}in; overflow: hidden;
             display: flex; flex-direction: column; align-items: center; justify-content: center;
             page-break-after: always; break-after: page; }
      .lbl:last-child { page-break-after: auto; break-after: auto; }
      .lbl .nm { font-weight: 700; font-size: ${Math.max(7, Math.min(12, h * 9))}pt; line-height: 1.1;
                 max-height: ${nameH}in; overflow: hidden; text-align: center; margin-bottom: 2pt; }
      .lbl svg { width: ${w - pad * 2}in; max-height: ${h - pad * 2 - nameH}in; height: auto; }
    `;
  }

  function barcodeSvg(code) {
    try {
      return Code39.toSVG(code, { height: 60, narrow: 2, fontSize: 14 });
    } catch (e) {
      return '<p>Cannot render a barcode for "' + escapeHtml(code) + '".</p>';
    }
  }

  // labels: [{ code, name }]
  function printLabels(labels, opts) {
    opts = opts || {};
    const withName = !!opts.showName;
    const html = labels.map((l) =>
      '<div class="lbl">' + (withName && l.name ? '<div class="nm">' + escapeHtml(l.name) + '</div>' : '') +
      barcodeSvg(l.code) + '</div>').join('');
    printHtml(html, { title: opts.title || 'Label', css: labelCss(opts.size || 'sheet', withName) });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  global.Print = { html: printHtml, labels: printLabels, barcodeSvg, LABEL_SIZES };
})(window);
