// Reusable camera barcode scanner. Uses the browser's native BarcodeDetector.
// Designed so both the kiosk badge login and (later) item take/return can reuse it.
//
// Constraints handled gracefully:
//  - Camera needs a secure context (HTTPS or localhost). Over plain http it
//    reports that clearly instead of failing silently.
//  - BarcodeDetector isn't available in every browser (notably iOS Safari).
//    When it's missing we offer a manual code-entry fallback.
(function (global) {
  const FORMATS = ['code_39', 'code_128', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'qr_code'];

  function secureContextOk() {
    return window.isSecureContext ||
      location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  }

  function detectorSupported() {
    return 'BarcodeDetector' in window;
  }

  // Opens a fullscreen overlay, streams the camera, and calls onResult(code)
  // on the first successful decode. Returns a control object with stop().
  async function scan(onResult, opts) {
    opts = opts || {};
    const overlay = buildOverlay(opts.title || 'Scan a barcode');
    document.body.appendChild(overlay.root);
    overlay.root.classList.add('show');

    let stream = null;
    let raf = null;
    let stopped = false;

    function cleanup() {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      overlay.root.classList.remove('show');
      setTimeout(() => overlay.root.remove(), 150);
    }

    overlay.close.addEventListener('click', cleanup);
    overlay.manual.addEventListener('click', () => {
      const code = prompt('Enter the code:');
      if (code && code.trim()) { cleanup(); onResult(code.trim()); }
    });

    if (!secureContextOk()) {
      overlay.msg.textContent = 'Camera scanning needs a secure (HTTPS) connection. Ask your admin to enable HTTPS, or type the code instead.';
      overlay.manual.style.display = 'inline';
      return { stop: cleanup };
    }
    if (!detectorSupported()) {
      overlay.msg.textContent = "This browser can't scan barcodes with the camera. Try Chrome on Android, use a USB scanner, or type the code.";
      overlay.manual.style.display = 'inline';
      return { stop: cleanup };
    }

    try {
      const detector = new window.BarcodeDetector({ formats: FORMATS });
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
      overlay.video.srcObject = stream;
      await overlay.video.play();

      const tick = async () => {
        if (stopped) return;
        try {
          const codes = await detector.detect(overlay.video);
          if (codes && codes.length) {
            const value = (codes[0].rawValue || '').trim();
            if (value) { cleanup(); onResult(value); return; }
          }
        } catch (e) { /* transient decode error, keep going */ }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    } catch (err) {
      overlay.msg.textContent = err && err.name === 'NotAllowedError'
        ? 'Camera permission was blocked. Allow camera access and try again, or type the code.'
        : 'Could not start the camera. Type the code instead.';
      overlay.manual.style.display = 'inline';
    }

    return { stop: cleanup };
  }

  function buildOverlay(title) {
    const root = document.createElement('div');
    root.className = 'cam-overlay';
    root.innerHTML =
      '<div class="cam-frame"><video playsinline muted></video><div class="cam-reticle"></div></div>' +
      '<p class="cam-msg">' + escapeHtml(title) + '</p>' +
      '<div class="cam-actions">' +
        '<button class="btn cam-close">Cancel</button>' +
        '<button class="cam-manual" style="display:none;">Type the code instead</button>' +
      '</div>';
    return {
      root,
      video: root.querySelector('video'),
      msg: root.querySelector('.cam-msg'),
      close: root.querySelector('.cam-close'),
      manual: root.querySelector('.cam-manual'),
    };
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  global.Scanner = { scan, secureContextOk, detectorSupported };
})(window);
