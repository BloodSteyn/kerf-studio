/* Kerf Studio — G-code generation for GRBL 1.1 lasers in laser mode ($32=1). */
window.Kerf = window.Kerf || {};
(function (K) {
  'use strict';
  const G = K.geom;

  const fmt = v => {
    const s = (Math.round(v * 1000) / 1000).toFixed(3).replace(/\.?0+$/, '');
    return s === '-0' || s === '' ? '0' : s;
  };

  class Writer {
    constructor(o) {
      this.lines = [];
      this.segs = [];          // flat: x0,y0,x1,y1,layerIndex(-1 rapid),intensity
      this.x = 0; this.y = 0; this.known = false;
      this.lx = null; this.ly = null; this.f = null; this.s = null;
      this.time = 0; this.cutLen = 0;
      this.ox = o.ox; this.oy = o.oy;
      this.rapidF = o.rapid; this.accel = o.accel; this.maxS = o.maxS;
      this.dx = 0; this.dy = 0;
    }
    emit(l) { this.lines.push(l); }
    _xy(x, y) {
      const fx = fmt(x - this.ox), fy = fmt(y - this.oy);
      let s = '';
      if (fx !== this.lx) s += ' X' + fx;
      if (fy !== this.ly) s += ' Y' + fy;
      this.lx = fx; this.ly = fy;
      return s;
    }
    _account(x, y, feed) {
      if (!this.known) { this.x = x; this.y = y; this.known = true; return 0; }
      const dx = x - this.x, dy = y - this.y, d = Math.hypot(dx, dy);
      if (d < 1e-9) return 0;
      const ux = dx / d, uy = dy / d;
      if (ux * this.dx + uy * this.dy < 0.866) this.time += feed / 60 / this.accel; // direction change penalty
      this.dx = ux; this.dy = uy;
      this.time += (d / feed) * 60;
      return d;
    }
    rapid(x, y) {
      const x0 = this.x, y0 = this.y, k = this.known;
      const xy = this._xy(x, y);
      if (!xy) return;
      this.emit('G0' + xy);
      this._account(x, y, this.rapidF);
      if (k) this.segs.push(x0, y0, x, y, -1, 0);
      this.x = x; this.y = y;
    }
    cut(x, y, s, f, li) {
      const x0 = this.x, y0 = this.y;
      const xy = this._xy(x, y);
      if (!xy) return;
      let l = 'G1' + xy;
      if (s !== this.s) { l += ' S' + s; this.s = s; }
      if (f !== this.f) { l += ' F' + f; this.f = f; }
      this.emit(l);
      const d = this._account(x, y, f);
      if (s > 0) { this.cutLen += d; this.segs.push(x0, y0, x, y, li, s / this.maxS); }
      this.x = x; this.y = y;
    }
  }

  function closedPts(p) {
    const pts = p.pts.slice();
    if (p.closed) {
      const f = pts[0], l = pts[pts.length - 1];
      if (Math.hypot(f[0] - l[0], f[1] - l[1]) > 1e-6) pts.push(f);
    }
    return pts;
  }

  // Greedy nearest-neighbour ordering; open paths may be reversed.
  function orderPolylines(polys, sx, sy) {
    const left = polys.map(p => closedPts(p));
    const out = [];
    let x = sx, y = sy;
    while (left.length) {
      let best = 0, bd = Infinity, rev = false;
      for (let i = 0; i < left.length; i++) {
        const p = left[i], a = p[0], b = p[p.length - 1];
        const da = (a[0] - x) ** 2 + (a[1] - y) ** 2;
        if (da < bd) { bd = da; best = i; rev = false; }
        const db = (b[0] - x) ** 2 + (b[1] - y) ** 2;
        if (db < bd) { bd = db; best = i; rev = true; }
      }
      let p = left.splice(best, 1)[0];
      if (rev) p = p.slice().reverse();
      out.push(p);
      const e = p[p.length - 1];
      x = e[0]; y = e[1];
    }
    return out;
  }

  function emitLines(w, polys, layer, li, sVal) {
    for (const pts of orderPolylines(polys, w.x, w.y)) {
      w.rapid(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) w.cut(pts[i][0], pts[i][1], sVal, layer.speed, li);
    }
  }

  function emitFill(w, polys, layer, li, sVal, overscan, rowCounter) {
    const edges = [];
    let miny = Infinity, maxy = -Infinity;
    for (const p of polys) {
      const pts = closedPts({ pts: p.pts, closed: true });
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i], b = pts[i + 1];
        if (a[1] === b[1]) continue;
        edges.push(a[0], a[1], b[0], b[1]);
        miny = Math.min(miny, a[1], b[1]); maxy = Math.max(maxy, a[1], b[1]);
      }
    }
    if (!edges.length) return;
    const step = layer.interval;
    const xs = [];
    for (let y = maxy - step / 2; y > miny; y -= step) {
      xs.length = 0;
      for (let i = 0; i < edges.length; i += 4) {
        const y1 = edges[i + 1], y2 = edges[i + 3];
        if ((y1 <= y && y < y2) || (y2 <= y && y < y1)) {
          const x1 = edges[i], x2 = edges[i + 2];
          xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
        }
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      const segs = [];
      for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > 1e-6) segs.push([xs[i], xs[i + 1]]);
      if (!segs.length) continue;
      const dir = rowCounter.n++ % 2 === 0 ? 1 : -1;
      if (dir < 0) { segs.reverse(); for (const s of segs) s.reverse(); }
      w.rapid(segs[0][0] - dir * overscan, y);
      for (const [a, b] of segs) {
        w.cut(a, y, 0, layer.speed, li);
        w.cut(b, y, sVal, layer.speed, li);
      }
      w.cut(segs[segs.length - 1][1] + dir * overscan, y, 0, layer.speed, li);
    }
  }

  function emitImage(w, o, img, layer, li, maxS, overscan, rowCounter) {
    const step = layer.interval;
    const cols = Math.max(1, Math.min(10000, Math.round(o.w / step)));
    const rows = Math.max(1, Math.min(10000, Math.round(o.h / step)));
    const data = K.raster.process(img, cols, rows, o.image);
    const pw = o.w / cols, ph = o.h / rows;
    const sMax = Math.round((layer.power / 100) * maxS);
    const sMin = layer.mode === 'image' && o.image.dither === 'grayscale' ? Math.round((layer.minPower / 100) * maxS) : sMax;
    const sOf = d => (d <= 0 ? 0 : Math.round(sMin + (sMax - sMin) * Math.min(1, d)));
    for (let r = 0; r < rows; r++) {
      const base = r * cols;
      let first = -1, last = -1;
      for (let i = 0; i < cols; i++) if (data[base + i] > 0) { if (first < 0) first = i; last = i; }
      if (first < 0) continue;
      const y = o.y + o.h - (r + 0.5) * ph;
      const dir = rowCounter.n++ % 2 === 0 ? 1 : -1;
      if (dir > 0) {
        const xs = o.x + first * pw;
        w.rapid(xs - overscan, y);
        w.cut(xs, y, 0, layer.speed, li);
        let i = first;
        while (i <= last) {
          const s = sOf(data[base + i]);
          let j = i;
          while (j + 1 <= last && sOf(data[base + j + 1]) === s) j++;
          w.cut(o.x + (j + 1) * pw, y, s, layer.speed, li);
          i = j + 1;
        }
        w.cut(o.x + (last + 1) * pw + overscan, y, 0, layer.speed, li);
      } else {
        const xs = o.x + (last + 1) * pw;
        w.rapid(xs + overscan, y);
        w.cut(xs, y, 0, layer.speed, li);
        let i = last;
        while (i >= first) {
          const s = sOf(data[base + i]);
          let j = i;
          while (j - 1 >= first && sOf(data[base + j - 1]) === s) j--;
          w.cut(o.x + j * pw, y, s, layer.speed, li);
          i = j - 1;
        }
        w.cut(o.x + first * pw - overscan, y, 0, layer.speed, li);
      }
    }
  }

  /**
   * project: { layers, objects }; getImage(assetId) -> HTMLImageElement
   * opt: { maxS, rapid, accel, overscan, origin: 'absolute'|'current', returnHome, machineName }
   */
  function generate(project, getImage, opt) {
    const layerIdx = new Map(project.layers.map((l, i) => [l.id, i]));
    const outLayers = project.layers.filter(l => l.output);
    const objs = project.objects.filter(o => {
      const l = project.layers[layerIdx.get(o.layer)];
      return l && l.output && (o.type !== 'image' || getImage(o.asset));
    });
    if (!objs.length) return { empty: true };
    const bbox = G.unionBBox(objs);
    const current = opt.origin === 'current';
    const ox = current ? bbox.minx : 0, oy = current ? bbox.miny : 0;
    const w = new Writer({ ox, oy, rapid: opt.rapid || 6000, accel: opt.accel || 2500, maxS: opt.maxS || 1000 });
    const maxS = opt.maxS || 1000;
    const overscan = Math.max(0, opt.overscan ?? 2.5);

    w.emit('; Kerf Studio');
    w.emit(`; Machine: ${opt.machineName || 'GRBL laser'}`);
    w.emit(`; Job size: ${fmt(bbox.maxx - bbox.minx)} x ${fmt(bbox.maxy - bbox.miny)} mm`);
    w.emit(`; Start from: ${current ? 'current position' : 'absolute coordinates'}`);
    w.emit('G21');
    w.emit('G90');
    w.emit(current ? 'G92 X0 Y0' : 'G92.1');
    w.emit('M4 S0');
    if (current) { w.lx = '0'; w.ly = '0'; w.x = ox; w.y = oy; w.known = true; }

    for (const layer of outLayers) {
      const li = layerIdx.get(layer.id);
      const items = objs.filter(o => o.layer === layer.id);
      if (!items.length) continue;
      const sVal = Math.round((layer.power / 100) * maxS);
      const passes = Math.max(1, Math.round(layer.passes || 1));
      for (let pass = 1; pass <= passes; pass++) {
        w.emit(`; Layer "${layer.name}" (${layer.mode}) pass ${pass}/${passes}: ${layer.speed} mm/min, ${layer.power}%`);
        const rowCounter = { n: 0 };
        if (layer.mode === 'line') {
          const polys = [];
          for (const o of items) {
            if (o.type === 'image') emitImage(w, o, getImage(o.asset), layer, li, maxS, overscan, rowCounter);
            else polys.push(...G.objectPolylines(o));
          }
          if (polys.length) emitLines(w, polys, layer, li, sVal);
        } else {
          for (const o of items) {
            if (o.type === 'image') emitImage(w, o, getImage(o.asset), layer, li, maxS, overscan, rowCounter);
            else emitFill(w, G.objectPolylines(o), layer, li, sVal, overscan, rowCounter);
          }
        }
      }
    }

    w.emit('M5 S0');
    if (opt.returnHome) w.rapid(ox, oy);
    if (current) w.emit('G92.1');
    w.emit('; end');

    const jobBox = { ...bbox };
    return {
      lines: w.lines, segs: w.segs, time: w.time, cutLen: w.cutLen,
      bbox: jobBox, lineCount: w.lines.filter(l => l[0] !== ';').length,
    };
  }

  /** G-code that traces the job's bounding box. */
  function frame(b, opt) {
    const F = opt.frameSpeed || 3000;
    const laser = opt.frameLaser ? [`M3 S${Math.round(((opt.framePower || 1) / 100) * (opt.maxS || 1000))}`] : ['M5 S0'];
    const w = b.maxx - b.minx, h = b.maxy - b.miny;
    if (opt.origin === 'current') {
      return ['G21', 'G91', ...laser, `G1 X${fmt(w)} F${F}`, `G1 Y${fmt(h)}`, `G1 X${fmt(-w)}`, `G1 Y${fmt(-h)}`, 'M5 S0', 'G90'];
    }
    return ['G21', 'G90', 'M5 S0', `G0 X${fmt(b.minx)} Y${fmt(b.miny)}`, ...laser,
      `G1 X${fmt(b.maxx)} F${F}`, `G1 Y${fmt(b.maxy)}`, `G1 X${fmt(b.minx)}`, `G1 Y${fmt(b.miny)}`, 'M5 S0'];
  }

  K.gcode = { generate, frame, fmt };
})(window.Kerf);
