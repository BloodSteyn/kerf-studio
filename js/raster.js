/* Kerf Studio — image processing: grayscale, brightness/contrast, dithering, text rendering. */
window.Kerf = window.Kerf || {};
(function (K) {
  'use strict';

  const JARVIS = [[1, 0, 7], [2, 0, 5], [-2, 1, 3], [-1, 1, 5], [0, 1, 7], [1, 1, 5], [2, 1, 3], [-2, 2, 1], [-1, 2, 3], [0, 2, 5], [1, 2, 3], [2, 2, 1]];
  const FLOYD = [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]];

  function diffuse(a, w, h, kernel, div) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const old = a[i];
        const nw = old >= 0.5 ? 1 : 0;
        a[i] = nw;
        const err = old - nw;
        if (!err) continue;
        for (const [dx, dy, f] of kernel) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || xx >= w || yy >= h) continue;
          a[yy * w + xx] += (err * f) / div;
        }
      }
    }
  }

  /** Resample an image to cols × rows and return laser "darkness" values 0..1 (1 = full power). */
  function process(img, cols, rows, opt = {}) {
    const cv = document.createElement('canvas');
    cv.width = cols; cv.height = rows;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cols, rows);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, cols, rows);
    const px = ctx.getImageData(0, 0, cols, rows).data;
    const n = cols * rows;
    const a = new Float32Array(n);
    const b = (opt.brightness || 0) / 100;
    const cf = Math.tan(((Math.max(-99, Math.min(99, opt.contrast || 0)) / 100 + 1) * Math.PI) / 4);
    for (let i = 0; i < n; i++) {
      let v = (0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]) / 255;
      v = (v - 0.5) * cf + 0.5 + b;
      v = v < 0 ? 0 : v > 1 ? 1 : v;
      if (opt.invert) v = 1 - v;
      a[i] = 1 - v;
    }
    switch (opt.dither || 'jarvis') {
      case 'grayscale':
        for (let i = 0; i < n; i++) if (a[i] < 0.004) a[i] = 0;
        break;
      case 'threshold': {
        const t = (opt.threshold ?? 50) / 100;
        for (let i = 0; i < n; i++) a[i] = a[i] >= t ? 1 : 0;
        break;
      }
      case 'floyd': diffuse(a, cols, rows, FLOYD, 16); break;
      default: diffuse(a, cols, rows, JARVIS, 48); break;
    }
    return a;
  }

  /** Render text to a tightly-cropped PNG. Returns { src, w, h } with w/h in mm. */
  function textToImage(text, { font = 'Arial', size = 10, bold = false, italic = false } = {}) {
    const lines = String(text).split('\n');
    const probe = document.createElement('canvas').getContext('2d');
    let ppm = 24; // pixels per mm
    const fontStr = p => `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${size * p}px "${font}"`;
    probe.font = fontStr(ppm);
    let maxW = Math.max(1, ...lines.map(l => probe.measureText(l).width));
    const limit = 8000;
    if (maxW > limit || size * ppm * 1.3 * lines.length > limit) {
      ppm *= Math.min(limit / maxW, limit / (size * ppm * 1.3 * lines.length));
      probe.font = fontStr(ppm);
      maxW = Math.max(1, ...lines.map(l => probe.measureText(l).width));
    }
    const fpx = size * ppm, lh = fpx * 1.25, pad = Math.ceil(fpx * 0.4);
    const cv = document.createElement('canvas');
    cv.width = Math.ceil(maxW + pad * 2);
    cv.height = Math.ceil(lh * lines.length + pad * 2);
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.font = fontStr(ppm);
    ctx.fillStyle = '#000';
    ctx.textBaseline = 'alphabetic';
    lines.forEach((l, i) => ctx.fillText(l, pad, pad + i * lh + fpx));
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let x0 = cv.width, y0 = cv.height, x1 = -1, y1 = -1;
    for (let y = 0; y < cv.height; y++) {
      for (let x = 0; x < cv.width; x++) {
        if (d[(y * cv.width + x) * 4 + 3] > 8) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return null;
    const out = document.createElement('canvas');
    out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
    out.getContext('2d').drawImage(cv, -x0, -y0);
    return { src: out.toDataURL('image/png'), w: out.width / ppm, h: out.height / ppm };
  }

  /** Downscale very large images before storing them in the project. */
  function normalizeImage(img, maxDim = 3000) {
    const w = img.naturalWidth, h = img.naturalHeight;
    if (Math.max(w, h) <= maxDim) return null;
    const k = maxDim / Math.max(w, h);
    const cv = document.createElement('canvas');
    cv.width = Math.round(w * k); cv.height = Math.round(h * k);
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    return cv.toDataURL('image/png');
  }

  K.raster = { process, textToImage, normalizeImage };
})(window.Kerf);
