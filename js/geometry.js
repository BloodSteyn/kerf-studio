/* Kerf Studio — geometry helpers, SVG and DXF import.
   All world coordinates are millimetres, origin front-left, Y up (machine space). */
window.Kerf = window.Kerf || {};
(function (K) {
  'use strict';

  const SEG_MM = 0.2;            // curve flattening segment length
  const D2R = Math.PI / 180;
  const round4 = v => Math.round(v * 1e4) / 1e4;

  // 2D affine matrix [a,b,c,d,e,f]: x' = a*x + c*y + e, y' = b*x + d*y + f
  const mat = {
    id: () => [1, 0, 0, 1, 0, 0],
    mul: (m, n) => [
      m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
      m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
    ],
    apply: (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]],
  };

  function ellipsePts(cx, cy, rx, ry, seg = SEG_MM) {
    const n = Math.min(720, Math.max(24, Math.ceil((2 * Math.PI * Math.max(rx, ry)) / seg)));
    const pts = [];
    for (let k = 0; k < n; k++) {
      const t = (k / n) * 2 * Math.PI;
      pts.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
    }
    return pts;
  }

  // ---------- SVG path data parser (flattens curves and arcs into polylines)
  function parsePath(d, segLen) {
    const out = [];
    const re = /[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/y;
    const n = d.length;
    let i = 0, cmd = '', pc = '', cur = null;
    let x = 0, y = 0, sx = 0, sy = 0, cx = 0, cy = 0;

    const skip = () => { while (i < n && ' ,\n\r\t'.includes(d[i])) i++; };
    const num = () => {
      skip(); re.lastIndex = i;
      const m = re.exec(d);
      if (!m) throw 0;
      i = re.lastIndex;
      return parseFloat(m[0]);
    };
    const flag = () => {
      skip();
      const c = d[i];
      if (c === '0' || c === '1') { i++; return c === '1'; }
      throw 0;
    };
    const start = (px, py) => { cur = { pts: [[px, py]], closed: false }; out.push(cur); };
    const lineTo = (px, py) => { if (!cur) start(x, y); cur.pts.push([px, py]); };
    const cubic = (x1, y1, x2, y2, x3, y3) => {
      const len = Math.hypot(x1 - x, y1 - y) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2);
      const steps = Math.min(200, Math.max(2, Math.ceil(len / segLen)));
      for (let k = 1; k <= steps; k++) {
        const t = k / steps, mt = 1 - t;
        const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, e = t * t * t;
        lineTo(a * x + b * x1 + c * x2 + e * x3, a * y + b * y1 + c * y2 + e * y3);
      }
    };
    const quad = (x1, y1, x2, y2) => {
      const len = Math.hypot(x1 - x, y1 - y) + Math.hypot(x2 - x1, y2 - y1);
      const steps = Math.min(200, Math.max(2, Math.ceil(len / segLen)));
      for (let k = 1; k <= steps; k++) {
        const t = k / steps, mt = 1 - t;
        lineTo(mt * mt * x + 2 * mt * t * x1 + t * t * x2, mt * mt * y + 2 * mt * t * y1 + t * t * y2);
      }
    };
    const arc = (rx, ry, phiDeg, fa, fs, x2, y2) => {
      const x1 = x, y1 = y;
      if (!rx || !ry) { lineTo(x2, y2); return; }
      rx = Math.abs(rx); ry = Math.abs(ry);
      const phi = phiDeg * D2R, cs = Math.cos(phi), sn = Math.sin(phi);
      const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
      const x1p = cs * dx + sn * dy, y1p = -sn * dx + cs * dy;
      const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
      if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
      const nu = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
      const de = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
      let coef = de === 0 ? 0 : Math.sqrt(Math.max(0, nu / de));
      if (fa === fs) coef = -coef;
      const cxp = (coef * rx * y1p) / ry, cyp = (-coef * ry * x1p) / rx;
      const ccx = cs * cxp - sn * cyp + (x1 + x2) / 2;
      const ccy = sn * cxp + cs * cyp + (y1 + y2) / 2;
      const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
      const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
      let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
      if (!fs && dt > 0) dt -= 2 * Math.PI;
      else if (fs && dt < 0) dt += 2 * Math.PI;
      const steps = Math.min(360, Math.max(4, Math.ceil((Math.abs(dt) * Math.max(rx, ry)) / segLen)));
      for (let k = 1; k <= steps; k++) {
        const t = t1 + (dt * k) / steps;
        const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
        lineTo(cs * ex - sn * ey + ccx, sn * ex + cs * ey + ccy);
      }
    };

    try {
      for (;;) {
        skip();
        if (i >= n) break;
        const ch = d[i];
        if (/[A-Za-z]/.test(ch)) { cmd = ch; i++; }
        else if (!cmd) break;
        const rel = cmd !== cmd.toUpperCase();
        const C = cmd.toUpperCase();
        switch (C) {
          case 'M': {
            let nx = num(), ny = num();
            if (rel) { nx += x; ny += y; }
            x = sx = nx; y = sy = ny; start(x, y);
            cmd = rel ? 'l' : 'L';
            break;
          }
          case 'L': { let nx = num(), ny = num(); if (rel) { nx += x; ny += y; } lineTo(nx, ny); x = nx; y = ny; break; }
          case 'H': { let nx = num(); if (rel) nx += x; lineTo(nx, y); x = nx; break; }
          case 'V': { let ny = num(); if (rel) ny += y; lineTo(x, ny); y = ny; break; }
          case 'C': {
            const a = [num(), num(), num(), num(), num(), num()];
            if (rel) for (let k = 0; k < 6; k++) a[k] += k % 2 ? y : x;
            cubic(a[0], a[1], a[2], a[3], a[4], a[5]);
            cx = a[2]; cy = a[3]; x = a[4]; y = a[5];
            break;
          }
          case 'S': {
            const a = [num(), num(), num(), num()];
            if (rel) for (let k = 0; k < 4; k++) a[k] += k % 2 ? y : x;
            let x1 = x, y1 = y;
            if (pc === 'C' || pc === 'S') { x1 = 2 * x - cx; y1 = 2 * y - cy; }
            cubic(x1, y1, a[0], a[1], a[2], a[3]);
            cx = a[0]; cy = a[1]; x = a[2]; y = a[3];
            break;
          }
          case 'Q': {
            const a = [num(), num(), num(), num()];
            if (rel) for (let k = 0; k < 4; k++) a[k] += k % 2 ? y : x;
            quad(a[0], a[1], a[2], a[3]);
            cx = a[0]; cy = a[1]; x = a[2]; y = a[3];
            break;
          }
          case 'T': {
            let nx = num(), ny = num();
            if (rel) { nx += x; ny += y; }
            let x1 = x, y1 = y;
            if (pc === 'Q' || pc === 'T') { x1 = 2 * x - cx; y1 = 2 * y - cy; }
            quad(x1, y1, nx, ny);
            cx = x1; cy = y1; x = nx; y = ny;
            break;
          }
          case 'A': {
            const rx = num(), ry = num(), phi = num(), fa = flag(), fs = flag();
            let nx = num(), ny = num();
            if (rel) { nx += x; ny += y; }
            arc(rx, ry, phi, fa, fs, nx, ny);
            x = nx; y = ny;
            break;
          }
          case 'Z': {
            if (cur) cur.closed = true;
            cur = null; x = sx; y = sy;
            cmd = ''; // stray numbers after Z are invalid
            break;
          }
          default: throw 0;
        }
        pc = C;
      }
    } catch (e) { /* stop at the first malformed token, keep what parsed */ }
    return out.filter(p => p.pts.length > 1);
  }

  function polysBBox(polys) {
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const p of polys) for (const [x, y] of p.pts) {
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
    }
    return { minx, miny, maxx, maxy };
  }

  // Build a path object's geometry (normalised to its own bbox) from world-space polylines.
  function fromWorld(polys) {
    const b = polysBBox(polys);
    const paths = polys.map(p => ({
      closed: !!p.closed,
      pts: p.pts.map(([x, y]) => [round4(x - b.minx), round4(y - b.miny)]),
    }));
    const w0 = b.maxx - b.minx, h0 = b.maxy - b.miny;
    return { paths, w0, h0, x: b.minx, y: b.miny, w: w0, h: h0 };
  }

  function objectXform(o) {
    const sx = o.w0 > 1e-9 ? o.w / o.w0 : 1, sy = o.h0 > 1e-9 ? o.h / o.h0 : 1;
    const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
    const r = (o.rot || 0) * D2R, c = Math.cos(r), s = Math.sin(r);
    return (px, py) => {
      const x = o.x + px * sx - cx, y = o.y + py * sy - cy;
      return [cx + x * c - y * s, cy + x * s + y * c];
    };
  }

  function objectPolylines(o) {
    if (o.type !== 'path') return [];
    const f = objectXform(o);
    return o.paths.map(p => ({ closed: p.closed, pts: p.pts.map(q => f(q[0], q[1])) }));
  }

  function objectCorners(o) {
    const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
    const r = (o.rot || 0) * D2R, c = Math.cos(r), s = Math.sin(r);
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => {
      const x = (u * o.w) / 2, y = (v * o.h) / 2;
      return [cx + x * c - y * s, cy + x * s + y * c];
    });
  }

  function objectBBox(o) {
    if (!o.rot) return { minx: o.x, miny: o.y, maxx: o.x + o.w, maxy: o.y + o.h };
    return polysBBox([{ pts: objectCorners(o) }]);
  }

  function unionBBox(objs) {
    let b = null;
    for (const o of objs) {
      const q = objectBBox(o);
      if (!b) b = { ...q };
      else {
        b.minx = Math.min(b.minx, q.minx); b.miny = Math.min(b.miny, q.miny);
        b.maxx = Math.max(b.maxx, q.maxx); b.maxy = Math.max(b.maxy, q.maxy);
      }
    }
    return b;
  }

  function hitTest(o, wx, wy, tol) {
    const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
    const r = (o.rot || 0) * D2R, c = Math.cos(r), s = Math.sin(r);
    const dx = wx - cx, dy = wy - cy;
    const lx = dx * c + dy * s, ly = -dx * s + dy * c;
    return Math.abs(lx) <= o.w / 2 + tol && Math.abs(ly) <= o.h / 2 + tol;
  }

  // ---------- SVG import
  function lenToMM(str) {
    if (!str) return null;
    const m = /^\s*([-+]?[\d.]+(?:e[-+]?\d+)?)\s*([a-z%]*)\s*$/i.exec(str);
    if (!m) return null;
    const f = { '': 25.4 / 96, px: 25.4 / 96, mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6 }[m[2].toLowerCase()];
    return f === undefined ? null : parseFloat(m[1]) * f;
  }

  function cssColorToHex(c) {
    if (!c || c === 'none' || c.startsWith('url')) return null;
    const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/.exec(c);
    if (!m) return null;
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return null;
    return '#' + [m[1], m[2], m[3]].map(v => (+v).toString(16).padStart(2, '0')).join('');
  }

  function elementMatrix(el, root) {
    let m = mat.id();
    for (let e = el; e && e !== root; e = e.parentNode) {
      const tl = e.transform && e.transform.baseVal;
      if (tl && tl.numberOfItems) {
        const t = tl.consolidate().matrix;
        m = mat.mul([t.a, t.b, t.c, t.d, t.e, t.f], m);
      }
    }
    return m;
  }

  function importSVG(text) {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const src = doc.documentElement;
    if (!src || src.nodeName.toLowerCase() !== 'svg' || doc.getElementsByTagName('parsererror').length) {
      throw new Error('This is not a valid SVG file.');
    }
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-100000px;top:0;width:1px;height:1px;overflow:hidden;pointer-events:none';
    const root = document.importNode(src, true);
    host.appendChild(root);
    document.body.appendChild(host);
    try {
      const wmm = lenToMM(root.getAttribute('width'));
      const hmm = lenToMM(root.getAttribute('height'));
      const vb = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
      let vbx = 0, vby = 0, sx = 25.4 / 96, sy = 25.4 / 96;
      if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
        vbx = vb[0]; vby = vb[1];
        if (wmm) sx = wmm / vb[2];
        sy = hmm ? hmm / vb[3] : sx;
        if (!wmm && hmm) sx = sy;
      } else {
        const wn = parseFloat(root.getAttribute('width')), hn = parseFloat(root.getAttribute('height'));
        if (wmm && wn) sx = wmm / wn;
        if (hmm && hn) sy = hmm / hn;
      }
      const segLen = SEG_MM / Math.max(sx, sy);
      const A = (el, k) => parseFloat(el.getAttribute(k)) || 0;
      const groups = new Map();
      const els = root.querySelectorAll('path,rect,circle,ellipse,line,polyline,polygon');
      for (const el of els) {
        if (el.closest('defs,clipPath,mask,pattern,marker,symbol')) continue;
        if (el.checkVisibility && !el.checkVisibility()) continue;
        let polys = [];
        switch (el.nodeName.toLowerCase()) {
          case 'path': polys = parsePath(el.getAttribute('d') || '', segLen); break;
          case 'rect': {
            const x = A(el, 'x'), y = A(el, 'y'), w = A(el, 'width'), h = A(el, 'height');
            if (w <= 0 || h <= 0) break;
            let rx = A(el, 'rx'), ry = A(el, 'ry');
            if (rx && !ry) ry = rx; if (ry && !rx) rx = ry;
            rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
            if (rx > 0) {
              const d = `M${x + rx},${y}H${x + w - rx}A${rx},${ry} 0 0 1 ${x + w},${y + ry}V${y + h - ry}` +
                `A${rx},${ry} 0 0 1 ${x + w - rx},${y + h}H${x + rx}A${rx},${ry} 0 0 1 ${x},${y + h - ry}` +
                `V${y + ry}A${rx},${ry} 0 0 1 ${x + rx},${y}Z`;
              polys = parsePath(d, segLen);
            } else {
              polys = [{ pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], closed: true }];
            }
            break;
          }
          case 'circle': { const r = A(el, 'r'); if (r > 0) polys = [{ pts: ellipsePts(A(el, 'cx'), A(el, 'cy'), r, r, segLen), closed: true }]; break; }
          case 'ellipse': { const rx = A(el, 'rx'), ry = A(el, 'ry'); if (rx > 0 && ry > 0) polys = [{ pts: ellipsePts(A(el, 'cx'), A(el, 'cy'), rx, ry, segLen), closed: true }]; break; }
          case 'line': polys = [{ pts: [[A(el, 'x1'), A(el, 'y1')], [A(el, 'x2'), A(el, 'y2')]], closed: false }]; break;
          case 'polyline':
          case 'polygon': {
            const nums = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number).filter(v => !isNaN(v));
            const pts = [];
            for (let k = 0; k + 1 < nums.length; k += 2) pts.push([nums[k], nums[k + 1]]);
            if (pts.length > 1) polys = [{ pts, closed: el.nodeName.toLowerCase() === 'polygon' }];
            break;
          }
        }
        if (!polys.length) continue;
        const m = elementMatrix(el, root);
        const cs = getComputedStyle(el);
        const color = cssColorToHex(cs.stroke) || cssColorToHex(cs.fill) || '#000000';
        if (!groups.has(color)) groups.set(color, []);
        const bucket = groups.get(color);
        for (const p of polys) {
          bucket.push({
            closed: p.closed,
            pts: p.pts.map(([px, py]) => {
              const [tx, ty] = mat.apply(m, px, py);
              return [(tx - vbx) * sx, -(ty - vby) * sy];
            }),
          });
        }
      }
      return {
        groups: [...groups].map(([color, polylines]) => ({ color, polylines })),
        skippedText: root.querySelectorAll('text').length,
      };
    } finally {
      host.remove();
    }
  }

  // ---------- DXF import (LINE, CIRCLE, ARC, LWPOLYLINE, POLYLINE, ELLIPSE, SPLINE)
  function bulgePoly(verts, closed) {
    const pts = [];
    const n = verts.length;
    if (!n) return null;
    pts.push([verts[0].x, verts[0].y]);
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = verts[i], b = verts[(i + 1) % n];
      if (!a.b) { pts.push([b.x, b.y]); continue; }
      const th = 4 * Math.atan(a.b);
      const dx = b.x - a.x, dy = b.y - a.y, c = Math.hypot(dx, dy);
      if (c < 1e-9) continue;
      const r = c / (2 * Math.sin(th / 2));
      const h = r * Math.cos(th / 2);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const ccx = mx + (-dy / c) * h, ccy = my + (dx / c) * h;
      const R = Math.hypot(a.x - ccx, a.y - ccy);
      const a1 = Math.atan2(a.y - ccy, a.x - ccx);
      const steps = Math.max(4, Math.ceil((Math.abs(th) * R) / SEG_MM));
      for (let k = 1; k <= steps; k++) {
        const t = a1 + (th * k) / steps;
        pts.push([ccx + R * Math.cos(t), ccy + R * Math.sin(t)]);
      }
    }
    if (closed && pts.length > 2) {
      const f = pts[0], l = pts[pts.length - 1];
      if (Math.hypot(f[0] - l[0], f[1] - l[1]) < 1e-6) pts.pop();
    }
    return pts.length > 1 ? { pts, closed } : null;
  }

  function bspline(ctrl, knots, deg, samples) {
    const out = [];
    const t0 = knots[deg], t1 = knots[ctrl.length];
    for (let s = 0; s <= samples; s++) {
      const t = t0 + ((t1 - t0) * s) / samples;
      let k = deg;
      while (k < ctrl.length - 1 && t >= knots[k + 1]) k++;
      const d = [];
      for (let j = 0; j <= deg; j++) d[j] = ctrl[k - deg + j].slice();
      for (let r = 1; r <= deg; r++) {
        for (let j = deg; j >= r; j--) {
          const i = k - deg + j;
          const den = knots[i + deg - r + 1] - knots[i];
          const a = den ? (t - knots[i]) / den : 0;
          d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1]];
        }
      }
      out.push(d[deg]);
    }
    return out;
  }

  function importDXF(text) {
    const lines = text.split(/\r?\n/);
    const pairs = [];
    for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([parseInt(lines[i].trim(), 10), lines[i + 1].trim()]);
    let scale = 1;
    for (let i = 0; i < pairs.length - 1; i++) {
      if (pairs[i][0] === 9 && pairs[i][1] === '$INSUNITS') {
        scale = { 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000 }[parseInt(pairs[i + 1][1], 10)] || 1;
        break;
      }
    }
    let i = pairs.findIndex(p => p[0] === 2 && p[1] === 'ENTITIES');
    if (i < 0) throw new Error('No ENTITIES section found in this DXF file.');
    const ents = [];
    let cur = null;
    for (i++; i < pairs.length; i++) {
      const [c, v] = pairs[i];
      if (c === 0) {
        if (cur) ents.push(cur);
        if (v === 'ENDSEC') { cur = null; break; }
        cur = { type: v, codes: [] };
      } else if (cur) cur.codes.push([c, v]);
    }
    const polys = [];
    const push = p => { if (p && p.pts.length > 1) polys.push(p); };
    for (let k = 0; k < ents.length; k++) {
      const e = ents[k];
      const has = code => e.codes.some(p => p[0] === code);
      const g = (code, def = 0) => { const f = e.codes.find(p => p[0] === code); return f ? parseFloat(f[1]) : def; };
      switch (e.type) {
        case 'LINE': push({ pts: [[g(10), g(20)], [g(11), g(21)]], closed: false }); break;
        case 'CIRCLE': push({ pts: ellipsePts(g(10), g(20), g(40), g(40)), closed: true }); break;
        case 'ARC': {
          const cx = g(10), cy = g(20), r = g(40), a1 = g(50) * D2R;
          let sweep = g(51) * D2R - a1;
          while (sweep <= 0) sweep += 2 * Math.PI;
          const steps = Math.max(4, Math.ceil((sweep * r) / SEG_MM));
          const pts = [];
          for (let s = 0; s <= steps; s++) { const t = a1 + (sweep * s) / steps; pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]); }
          push({ pts, closed: false });
          break;
        }
        case 'LWPOLYLINE': {
          const verts = []; let v = null;
          for (const [c, val] of e.codes) {
            if (c === 10) { v = { x: parseFloat(val), y: 0, b: 0 }; verts.push(v); }
            else if (c === 20 && v) v.y = parseFloat(val);
            else if (c === 42 && v) v.b = parseFloat(val);
          }
          push(bulgePoly(verts, (g(70) & 1) === 1));
          break;
        }
        case 'POLYLINE': {
          const closed = (g(70) & 1) === 1;
          const verts = [];
          while (k + 1 < ents.length && ents[k + 1].type === 'VERTEX') {
            const ve = ents[++k];
            const gv = code => { const f = ve.codes.find(p => p[0] === code); return f ? parseFloat(f[1]) : 0; };
            verts.push({ x: gv(10), y: gv(20), b: gv(42) });
          }
          if (ents[k + 1] && ents[k + 1].type === 'SEQEND') k++;
          push(bulgePoly(verts, closed));
          break;
        }
        case 'ELLIPSE': {
          const cx = g(10), cy = g(20), mx = g(11), my = g(21), ratio = g(40, 1);
          const t1 = g(41, 0), t2 = has(42) ? g(42) : 2 * Math.PI;
          const a = Math.hypot(mx, my), b = a * ratio, rot = Math.atan2(my, mx);
          let sweep = t2 - t1; while (sweep <= 0) sweep += 2 * Math.PI;
          const steps = Math.max(24, Math.ceil((sweep * a) / SEG_MM));
          const full = Math.abs(sweep - 2 * Math.PI) < 1e-6;
          const pts = [];
          for (let s = 0; s < (full ? steps : steps + 1); s++) {
            const t = t1 + (sweep * s) / steps;
            const ex = a * Math.cos(t), ey = b * Math.sin(t);
            pts.push([cx + ex * Math.cos(rot) - ey * Math.sin(rot), cy + ex * Math.sin(rot) + ey * Math.cos(rot)]);
          }
          push({ pts, closed: full });
          break;
        }
        case 'SPLINE': {
          const deg = g(71, 3);
          const knots = e.codes.filter(p => p[0] === 40).map(p => parseFloat(p[1]));
          const collect = (cx, cy) => {
            const pts = []; let p = null;
            for (const [c, val] of e.codes) {
              if (c === cx) { p = [parseFloat(val), 0]; pts.push(p); }
              else if (c === cy && p) p[1] = parseFloat(val);
            }
            return pts;
          };
          const ctrl = collect(10, 20), fit = collect(11, 21);
          let pts;
          if (ctrl.length > deg && knots.length === ctrl.length + deg + 1) pts = bspline(ctrl, knots, deg, Math.max(16, ctrl.length * 12));
          else pts = fit.length > 1 ? fit : ctrl;
          push({ pts, closed: (g(70) & 1) === 1 });
          break;
        }
      }
    }
    if (scale !== 1) for (const p of polys) p.pts = p.pts.map(([x, y]) => [x * scale, y * scale]);
    return { groups: polys.length ? [{ color: null, polylines: polys }] : [], skippedText: 0 };
  }

  K.geom = {
    ellipsePts, parsePath, polysBBox, fromWorld, objectXform, objectPolylines,
    objectCorners, objectBBox, unionBBox, hitTest, importSVG, importDXF,
  };
})(window.Kerf);
