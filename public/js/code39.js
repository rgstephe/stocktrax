// Code 39 barcode generator -> SVG. No dependencies, works offline.
// Code 39 is chosen for reliability: fixed per-character patterns, no
// code-set switching, no checksum required, and universal scanner support.
// Charset: 0-9 A-Z and - . space $ / + %  (plus * as start/stop).
(function (global) {
  const PATTERNS = {
    '0': '000110100', '1': '100100001', '2': '001100001', '3': '101100000',
    '4': '000110001', '5': '100110000', '6': '001110000', '7': '000100101',
    '8': '100100100', '9': '001100100', 'A': '100001001', 'B': '001001001',
    'C': '101001000', 'D': '000011001', 'E': '100011000', 'F': '001011000',
    'G': '000001101', 'H': '100001100', 'I': '001001100', 'J': '000011100',
    'K': '100000011', 'L': '001000011', 'M': '101000010', 'N': '000010011',
    'O': '100010010', 'P': '001010010', 'Q': '000000111', 'R': '100000110',
    'S': '001000110', 'T': '000010110', 'U': '110000001', 'V': '011000001',
    'W': '111000000', 'X': '010010001', 'Y': '110010000', 'Z': '011010000',
    '-': '010000101', '.': '110000100', ' ': '011000100', '$': '010101000',
    '/': '010100010', '+': '010001010', '%': '000101010', '*': '010010100'
  };

  // Returns true if a string can be encoded as-is.
  function canEncode(text) {
    return String(text).toUpperCase().split('').every((c) => c in PATTERNS && c !== '*');
  }

  // Build an SVG string for the given text.
  // opts: { height, narrow, showText, fontSize }
  function toSVG(text, opts) {
    opts = opts || {};
    const height = opts.height || 60;
    const narrow = opts.narrow || 2;      // px width of a narrow element
    const wide = narrow * 3;              // wide element = 3x narrow
    const showText = opts.showText !== false;
    const fontSize = opts.fontSize || 14;
    const textGap = showText ? fontSize + 6 : 0;

    const value = ('*' + String(text).toUpperCase() + '*');
    const bars = [];
    let x = 0;

    for (let ci = 0; ci < value.length; ci++) {
      const pat = PATTERNS[value[ci]];
      if (!pat) throw new Error('Cannot encode character: ' + value[ci]);
      for (let i = 0; i < 9; i++) {
        const w = pat[i] === '1' ? wide : narrow;
        if (i % 2 === 0) { // even index = bar (drawn); odd = space (gap)
          bars.push('<rect x="' + x + '" y="0" width="' + w + '" height="' + height + '"/>');
        }
        x += w;
      }
      x += narrow; // inter-character gap
    }

    const totalW = x;
    const svgH = height + textGap;
    let svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + totalW + ' ' + svgH +
      '" width="' + totalW + '" height="' + svgH + '" shape-rendering="crispEdges">';
    svg += '<rect x="0" y="0" width="' + totalW + '" height="' + svgH + '" fill="#ffffff"/>';
    svg += '<g fill="#000000">' + bars.join('') + '</g>';
    if (showText) {
      svg += '<text x="' + (totalW / 2) + '" y="' + (height + fontSize) +
        '" text-anchor="middle" font-family="monospace" font-size="' + fontSize +
        '" fill="#000000">' + String(text).toUpperCase() + '</text>';
    }
    svg += '</svg>';
    return svg;
  }

  global.Code39 = { toSVG, canEncode };
})(window);
