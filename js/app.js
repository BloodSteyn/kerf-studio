/* Kerf Studio — application: state, canvas editor, panels, machine control. */
(function (K) {
  'use strict';
  const G = K.geom, R = K.raster, GC = K.gcode;
  const grbl = new K.Grbl();

  // ---------------------------------------------------------------- helpers
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const uid = () => Math.random().toString(36).slice(2, 10);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const f2 = v => (Math.round(v * 100) / 100).toFixed(2);
  const fmtTime = sec => {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
  };
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
  };

  const PALETTE = ['#2f80ed', '#eb5757', '#27ae60', '#f2994a', '#9b51e0', '#00b8d9', '#e2b93b', '#e91e63', '#8d6e63', '#607d8b', '#7cb342', '#5c6bc0'];
  const MODE_LABEL = { line: 'Line', fill: 'Fill', image: 'Image' };
  const MODE_HINT = {
    line: 'Follows vector outlines. Use for cutting and scoring.',
    fill: 'Scans back and forth to fill closed shapes. Use for solid engraving.',
    image: 'Engraves photos and bitmaps line by line.',
  };
  const PRESETS = {
    line: { speed: 600, power: 90, minPower: 0, passes: 1, interval: 0.1 },
    fill: { speed: 3000, power: 40, minPower: 0, passes: 1, interval: 0.1 },
    image: { speed: 3000, power: 50, minPower: 0, passes: 1, interval: 0.1 },
  };
  // Preferences only. Machine facts (work area, max spindle, baud, rapid,
  // acceleration) belong to the active machine profile, not here.
  const DEFAULT_SETTINGS = {
    overscan: 2.5,
    frameSpeed: 3000, frameLaser: false, framePower: 1,
    jobOrigin: 'absolute', returnHome: true, jogFeed: 3000, jogStep: 10, lockAspect: true,
  };
  const FONTS = ['Arial', 'Arial Black', 'Bahnschrift', 'Calibri', 'Cambria', 'Comic Sans MS', 'Consolas', 'Courier New',
    'Georgia', 'Impact', 'Palatino Linotype', 'Segoe Print', 'Segoe Script', 'Segoe UI', 'Times New Roman', 'Trebuchet MS', 'Verdana'];

  // ---------------------------------------------------------------- state
  const S = {
    settings: { ...DEFAULT_SETTINGS, ...store.get('kerf.settings', {}) },
    layers: [], objects: [], sel: new Set(), currentLayer: null,
    tool: 'select', preview: null, previewOn: false, previewStale: true,
  };
  const assets = new Map(); // id -> { src, img }
  const imgCache = new Map();
  const saveSettings = () => store.set('kerf.settings', S.settings);

  // ---------------------------------------------------------------- machine
  const MA = K.machines;
  MA.migrate(store);
  S.machine = MA.active(store);

  // Machine facts are read through the active profile so there is one source
  // of truth. These two are used often enough to deserve shorthands.
  const bedW = () => S.machine.bedW;
  const bedH = () => S.machine.bedH;

  // Machine position in design space. The canvas, the readout and the status
  // bar all show where the head is on the bed, not its raw machine coordinate.
  function headPos() {
    const m = grbl.status.mpos;
    return MA.fromMachine(S.machine, m[0] || 0, m[1] || 0);
  }

  function setMachine(id) {
    S.machine = MA.setActive(store, id);
    applyMachine();
  }
  function saveMachine(patch) {
    S.machine = MA.save(store, { ...S.machine, ...patch });
    applyMachine();
  }
  function applyMachine() {
    const sel = $('#machineTag');
    if (sel) {
      sel.innerHTML = MA.list(store)
        .map(p => `<option value="${esc(p.id)}"${p.id === S.machine.id ? ' selected' : ''}>${esc(p.name)}</option>`)
        .join('') + '<option value="__add">Add machine…</option><option value="__dup">Duplicate current…</option>';
    }
    const home = $('#btnHome');
    if (home) home.hidden = !S.machine.hasHoming;
    invalidatePreview();
    fitBed();
    requestDraw();
  }

  // ---------------------------------------------------------------- layers
  const layerById = id => S.layers.find(l => l.id === id);
  const currentLayer = () => layerById(S.currentLayer) || S.layers[0];
  const objById = id => S.objects.find(o => o.id === id);
  const selected = () => S.objects.filter(o => S.sel.has(o.id));

  function nextColor() {
    const used = new Set(S.layers.map(l => l.color.toLowerCase()));
    return PALETTE.find(c => !used.has(c)) || PALETTE[S.layers.length % PALETTE.length];
  }
  function addLayer(opt = {}) {
    const mode = opt.mode || 'line';
    const l = { id: uid(), name: opt.name || `Layer ${S.layers.length + 1}`, color: opt.color || nextColor(), mode, ...PRESETS[mode], output: true };
    S.layers.push(l);
    return l;
  }
  function layerForMode(mode) {
    return S.layers.find(l => l.mode === mode) || addLayer({ mode, name: MODE_LABEL[mode] });
  }
  function layerForColor(hex, allowReuse) {
    const found = S.layers.find(l => l.color.toLowerCase() === hex.toLowerCase());
    if (found) return found;
    // Reuse the untouched starter layer instead of leaving it empty.
    if (allowReuse && S.layers.length === 1 && !S.objects.some(o => o.layer === S.layers[0].id) && S.layers[0].mode === 'line') {
      S.layers[0].color = hex;
      return S.layers[0];
    }
    return addLayer({ color: hex });
  }
  function displayColor(hex) {
    const n = parseInt(hex.slice(1), 16);
    const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    const dark = document.documentElement.dataset.theme !== 'light';
    if (dark && lum < 0.18) return '#cfd4de';
    if (!dark && lum > 0.88) return '#5f6878';
    return hex;
  }

  // ---------------------------------------------------------------- history
  const history = { stack: [], idx: -1 };
  const snapshot = () => JSON.stringify({ layers: S.layers, objects: S.objects, currentLayer: S.currentLayer });
  function commit() {
    const snap = snapshot();
    if (history.stack[history.idx] === snap) return;
    history.stack = history.stack.slice(0, history.idx + 1);
    history.stack.push(snap);
    if (history.stack.length > 80) history.stack.shift();
    history.idx = history.stack.length - 1;
    invalidatePreview();
    scheduleAutosave();
    refreshPanels();
  }
  function restore(snap) {
    const d = JSON.parse(snap);
    S.layers = d.layers; S.objects = d.objects; S.currentLayer = d.currentLayer;
    S.sel = new Set([...S.sel].filter(id => objById(id)));
    invalidatePreview(); scheduleAutosave(); refreshPanels(); requestDraw();
  }
  const undo = () => { if (history.idx > 0) restore(history.stack[--history.idx]); };
  const redo = () => { if (history.idx < history.stack.length - 1) restore(history.stack[++history.idx]); };

  let autosaveTimer = 0;
  function scheduleAutosave() {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => store.set('kerf.project', projectData()), 800);
  }

  // ---------------------------------------------------------------- toasts & dialogs
  function toast(msg, type = 'info', ms = 3600) {
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    $('#toasts').appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 250); }, ms);
  }
  function openDialog(dlg) {
    return new Promise(res => {
      dlg.returnValue = '';
      dlg.addEventListener('close', () => res(dlg.returnValue === 'ok'), { once: true });
      dlg.showModal();
    });
  }
  function ask(title, body, okLabel = 'OK', danger = false) {
    $('#cfTitle').textContent = title;
    $('#cfBody').textContent = body;
    const ok = $('#cfOk');
    ok.textContent = okLabel;
    ok.className = 'btn ' + (danger ? 'danger' : 'primary');
    return openDialog($('#dlgConfirm'));
  }

  // ---------------------------------------------------------------- assets
  function loadAsset(src, id = uid()) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => { assets.set(id, { src, img }); res(id); };
      img.onerror = () => rej(new Error('Could not decode image'));
      img.src = src;
    });
  }
  function imagePreview(o) {
    const a = assets.get(o.asset);
    if (!a) return null;
    const layer = layerById(o.layer);
    const interval = (layer && layer.interval) || 0.1;
    const cols = Math.max(1, Math.min(900, Math.round(o.w / interval)));
    const rows = Math.max(1, Math.min(1400, Math.round((cols * o.h) / o.w)));
    const im = o.image;
    const key = [o.asset, im.dither, im.invert, im.brightness, im.contrast, cols, rows].join('|');
    const c = imgCache.get(o.id);
    if (c && c.key === key) return c.canvas;
    const d = R.process(a.img, cols, rows, im);
    const cv = document.createElement('canvas');
    cv.width = cols; cv.height = rows;
    const ctx2 = cv.getContext('2d');
    const id = ctx2.createImageData(cols, rows);
    for (let i = 0; i < d.length; i++) {
      const v = 255 * (1 - Math.min(1, d[i]));
      id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v;
      id.data[i * 4 + 3] = 255;
    }
    ctx2.putImageData(id, 0, 0);
    imgCache.set(o.id, { key, canvas: cv });
    return cv;
  }

  // ---------------------------------------------------------------- canvas view
  const stage = $('#stage');
  const cv = $('#canvas');
  const ctx = cv.getContext('2d');
  const view = { scale: 1, ox: 0, oy: 0, w: 0, h: 0, dpr: 1 };
  let colors = {};
  const w2s = (x, y) => [view.ox + x * view.scale, view.oy - y * view.scale];
  const s2w = (sx, sy) => [(sx - view.ox) / view.scale, (view.oy - sy) / view.scale];

  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = n => cs.getPropertyValue(n).trim();
    colors = {
      bg: v('--canvas-bg'), bed: v('--bed'), grid: v('--grid'), major: v('--grid-major'),
      ruler: v('--ruler'), accent: v('--accent'), text: v('--text'), muted: v('--muted'), border: v('--border-strong'),
    };
  }
  function resize() {
    const r = stage.getBoundingClientRect();
    view.dpr = window.devicePixelRatio || 1;
    view.w = r.width; view.h = r.height;
    cv.width = Math.round(r.width * view.dpr);
    cv.height = Math.round(r.height * view.dpr);
    requestDraw();
  }
  function fitBed() {
    const bedWv = bedW(), bedHv = bedH();
    const pad = 48;
    view.scale = Math.max(0.05, Math.min((view.w - pad * 2) / bedWv, (view.h - pad * 2) / bedHv));
    view.ox = (view.w - bedWv * view.scale) / 2 + 8;
    view.oy = (view.h + bedHv * view.scale) / 2 - 4;
    updateZoomLabel();
    requestDraw();
  }
  function zoomAt(sx, sy, factor) {
    const [wx, wy] = s2w(sx, sy);
    view.scale = clamp(view.scale * factor, 0.1, 400);
    view.ox = sx - wx * view.scale;
    view.oy = sy + wy * view.scale;
    updateZoomLabel();
    requestDraw();
  }
  function updateZoomLabel() {
    const base = Math.min((view.w - 96) / bedW(), (view.h - 96) / bedH());
    $('#zoomLabel').textContent = Math.round((view.scale / base) * 100) + '%';
  }

  let drawQueued = false;
  function requestDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => { drawQueued = false; draw(); });
  }

  function niceStep(minPx) {
    for (const s of [0.5, 1, 2, 5, 10, 20, 50, 100, 200]) if (s * view.scale >= minPx) return s;
    return 500;
  }

  function draw() {
    const bedWv = bedW(), bedHv = bedH();
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, view.w, view.h);

    // bed + grid
    const [bx, by] = w2s(0, bedHv);
    const bw = bedWv * view.scale, bh = bedHv * view.scale;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 24; ctx.shadowOffsetY = 6;
    ctx.fillStyle = colors.bed;
    ctx.fillRect(bx, by, bw, bh);
    ctx.restore();
    ctx.save();
    ctx.beginPath(); ctx.rect(bx, by, bw, bh); ctx.clip();
    const minor = niceStep(9), major = niceStep(60);
    for (const [step, col] of [[minor, colors.grid], [major, colors.major]]) {
      ctx.beginPath();
      for (let x = 0; x <= bedWv + 1e-6; x += step) { const sx = Math.round(view.ox + x * view.scale) + 0.5; ctx.moveTo(sx, by); ctx.lineTo(sx, by + bh); }
      for (let y = 0; y <= bedHv + 1e-6; y += step) { const sy = Math.round(view.oy - y * view.scale) + 0.5; ctx.moveTo(bx, sy); ctx.lineTo(bx + bw, sy); }
      ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = colors.border; ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(bx) + 0.5, Math.round(by) + 0.5, Math.round(bw), Math.round(bh));

    // rulers
    ctx.fillStyle = colors.ruler;
    ctx.font = '10px ' + getComputedStyle(document.body).getPropertyValue('--mono');
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let x = 0; x <= bedWv + 1e-6; x += major) ctx.fillText(String(x), view.ox + x * view.scale, by + bh + 6);
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let y = 0; y <= bedHv + 1e-6; y += major) ctx.fillText(String(y), bx - 6, view.oy - y * view.scale);

    // objects
    const dim = S.previewOn && S.preview && !S.preview.empty;
    for (const o of S.objects) drawObject(o, dim);
    if (dim) drawPreview();

    // selection
    drawSelection();

    // in-progress drawing / rubber band
    if (drag && drag.mode === 'draw') {
      const r = drawRect(drag);
      const [x0, y0] = w2s(r.x, r.y + r.h), [x1, y1] = w2s(r.x + r.w, r.y);
      ctx.save();
      ctx.strokeStyle = displayColor(currentLayer().color); ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (drag.tool === 'rect') ctx.rect(x0, y0, x1 - x0, y1 - y0);
      else ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = colors.text; ctx.font = '11px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText(`${f2(r.w)} × ${f2(r.h)} mm`, x1 + 8, y1 + 4);
      ctx.restore();
    }
    if (drag && drag.mode === 'rubber') {
      const x = Math.min(drag.sx, drag.cx), y = Math.min(drag.sy, drag.cy);
      ctx.save();
      ctx.fillStyle = 'rgba(78,161,255,.08)'; ctx.strokeStyle = 'rgba(78,161,255,.8)';
      ctx.setLineDash([4, 3]);
      ctx.fillRect(x, y, Math.abs(drag.cx - drag.sx), Math.abs(drag.cy - drag.sy));
      ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(drag.cx - drag.sx), Math.abs(drag.cy - drag.sy));
      ctx.restore();
    }

    // laser head
    if (grbl.connected) {
      const hp = headPos();
      const [hx, hy] = w2s(hp.x, hp.y);
      ctx.save();
      ctx.strokeStyle = '#ff3b30'; ctx.fillStyle = 'rgba(255,59,48,.18)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(hx, hy, 9, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(hx - 15, hy); ctx.lineTo(hx + 15, hy); ctx.moveTo(hx, hy - 15); ctx.lineTo(hx, hy + 15); ctx.stroke();
      ctx.restore();
    }
  }

  function drawObject(o, dim) {
    const layer = layerById(o.layer);
    if (!layer) return;
    const col = displayColor(layer.color);
    ctx.save();
    ctx.globalAlpha = (layer.output ? 1 : 0.35) * (dim ? 0.25 : 1);
    if (o.type === 'image') {
      const pc = imagePreview(o);
      const [sx, sy] = w2s(o.x, o.y + o.h);
      if (pc) {
        ctx.imageSmoothingEnabled = view.scale * (o.w / pc.width) < 2;
        ctx.drawImage(pc, sx, sy, o.w * view.scale, o.h * view.scale);
      }
      ctx.strokeStyle = col; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
      ctx.strokeRect(sx + 0.5, sy + 0.5, o.w * view.scale, o.h * view.scale);
    } else {
      ctx.beginPath();
      for (const p of G.objectPolylines(o)) {
        p.pts.forEach(([x, y], i) => { const [sx, sy] = w2s(x, y); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
        if (p.closed) ctx.closePath();
      }
      if (layer.mode !== 'line') {
        ctx.fillStyle = col;
        ctx.globalAlpha *= 0.22;
        ctx.fill('evenodd');
        ctx.globalAlpha /= 0.22;
      }
      ctx.strokeStyle = col; ctx.lineWidth = 1.4; ctx.lineJoin = 'round';
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawPreview() {
    const P = S.preview, segs = P.segs;
    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < segs.length; i += 6) {
      if (segs[i + 4] !== -1) continue;
      const [a, b] = w2s(segs[i], segs[i + 1]), [c, d] = w2s(segs[i + 2], segs[i + 3]);
      ctx.moveTo(a, b); ctx.lineTo(c, d);
    }
    ctx.setLineDash([3, 4]); ctx.strokeStyle = colors.muted; ctx.globalAlpha = 0.5; ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1;
    const groups = new Map();
    for (let i = 0; i < segs.length; i += 6) {
      const li = segs[i + 4];
      if (li < 0) continue;
      const key = li * 10 + Math.min(9, Math.floor(segs[i + 5] * 9.999));
      let p = groups.get(key);
      if (!p) { p = new Path2D(); groups.set(key, p); }
      const [a, b] = w2s(segs[i], segs[i + 1]), [c, d] = w2s(segs[i + 2], segs[i + 3]);
      p.moveTo(a, b); p.lineTo(c, d);
    }
    for (const [key, p] of groups) {
      const layer = S.layers[Math.floor(key / 10)];
      if (!layer) continue;
      const bucket = key % 10;
      ctx.strokeStyle = layer.mode === 'image' ? (document.documentElement.dataset.theme === 'light' ? '#1b1d22' : '#e9ebef') : displayColor(layer.color);
      ctx.globalAlpha = 0.25 + 0.75 * ((bucket + 0.5) / 10);
      ctx.lineWidth = layer.mode === 'line' ? 1.6 : Math.max(1, layer.interval * view.scale);
      ctx.stroke(p);
    }
    ctx.restore();
  }

  function selBBox() { const s = selected(); return s.length ? G.unionBBox(s) : null; }
  function handleWorld(b) {
    const cx = (b.minx + b.maxx) / 2, cy = (b.miny + b.maxy) / 2;
    return [[b.minx, b.maxy], [b.maxx, b.maxy], [b.maxx, b.miny], [b.minx, b.miny], [cx, b.maxy], [b.maxx, cy], [cx, b.miny], [b.minx, cy]];
  }
  const OPP = [2, 3, 0, 1, 6, 7, 4, 5];
  const HCURSOR = ['nwse-resize', 'nesw-resize', 'nwse-resize', 'nesw-resize', 'ns-resize', 'ew-resize', 'ns-resize', 'ew-resize'];

  function drawSelection() {
    const s = selected();
    if (!s.length) return;
    ctx.save();
    ctx.strokeStyle = colors.accent; ctx.lineWidth = 1;
    if (s.length > 1) {
      ctx.setLineDash([2, 3]);
      for (const o of s) {
        const c = G.objectCorners(o).map(p => w2s(p[0], p[1]));
        ctx.beginPath(); c.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath(); ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    const b = selBBox();
    const [x0, y0] = w2s(b.minx, b.maxy), [x1, y1] = w2s(b.maxx, b.miny);
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(Math.round(x0) - 3.5, Math.round(y0) - 3.5, Math.round(x1 - x0) + 7, Math.round(y1 - y0) + 7);
    ctx.setLineDash([]);
    ctx.fillStyle = colors.bed;
    for (const [hx, hy] of handleWorld(b)) {
      let [sx, sy] = w2s(hx, hy);
      sx += Math.sign(sx - (x0 + x1) / 2) * 3.5; sy += Math.sign(sy - (y0 + y1) / 2) * 3.5;
      ctx.beginPath(); ctx.rect(Math.round(sx) - 4.5, Math.round(sy) - 4.5, 9, 9); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- canvas interaction
  let drag = null;
  let spaceDown = false;

  function hitHandle(sx, sy) {
    const b = selBBox();
    if (!b) return -1;
    const [x0, y0] = w2s(b.minx, b.maxy), [x1, y1] = w2s(b.maxx, b.miny);
    const hs = handleWorld(b);
    for (let i = 0; i < 8; i++) {
      let [hx, hy] = w2s(hs[i][0], hs[i][1]);
      hx += Math.sign(hx - (x0 + x1) / 2) * 3.5; hy += Math.sign(hy - (y0 + y1) / 2) * 3.5;
      if (Math.abs(sx - hx) <= 7 && Math.abs(sy - hy) <= 7) return i;
    }
    return -1;
  }
  function hitObject(wx, wy) {
    const tol = 4 / view.scale;
    for (let i = S.objects.length - 1; i >= 0; i--) {
      const o = S.objects[i];
      if (G.hitTest(o, wx, wy, tol)) return o;
    }
    return null;
  }
  function drawRect(d) {
    let w = d.cw[0] - d.w0[0], h = d.cw[1] - d.w0[1];
    if (d.shift) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
    return { x: Math.min(d.w0[0], d.w0[0] + w), y: Math.min(d.w0[1], d.w0[1] + h), w: Math.abs(w), h: Math.abs(h) };
  }
  const evPos = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const cloneGeom = o => ({ id: o.id, x: o.x, y: o.y, w: o.w, h: o.h });

  cv.addEventListener('pointerdown', e => {
    const [sx, sy] = evPos(e);
    const w = s2w(sx, sy);
    cv.setPointerCapture(e.pointerId);
    if (e.button === 1 || (e.button === 0 && (spaceDown || S.tool === 'pan'))) {
      drag = { mode: 'pan', sx, sy, ox: view.ox, oy: view.oy };
      stage.classList.add('grabbing');
      return;
    }
    if (e.button !== 0) return;
    if (S.tool === 'rect' || S.tool === 'ellipse') {
      drag = { mode: 'draw', tool: S.tool, w0: w, cw: w, shift: e.shiftKey };
      return;
    }
    if (S.tool === 'text') { addText(w); return; }
    const h = hitHandle(sx, sy);
    if (h >= 0) {
      const b = selBBox(), hw = handleWorld(b);
      drag = { mode: 'scale', h, hw: hw[h], aw: hw[OPP[h]], orig: selected().map(cloneGeom), changed: false };
      return;
    }
    const o = hitObject(w[0], w[1]);
    if (o) {
      if (e.shiftKey) { S.sel.has(o.id) ? S.sel.delete(o.id) : S.sel.add(o.id); }
      else if (!S.sel.has(o.id)) S.sel = new Set([o.id]);
      drag = { mode: 'move', w0: w, orig: selected().map(cloneGeom), changed: false };
      refreshPanels();
    } else {
      if (!e.shiftKey) S.sel.clear();
      drag = { mode: 'rubber', sx, sy, cx: sx, cy: sy, base: new Set(S.sel) };
      refreshPanels();
    }
    requestDraw();
  });

  cv.addEventListener('pointermove', e => {
    const [sx, sy] = evPos(e);
    const w = s2w(sx, sy);
    $('#sbCursor').textContent = `X ${f2(w[0])}  Y ${f2(w[1])}`;
    if (!drag) {
      if (S.tool === 'select' && !spaceDown) {
        const h = hitHandle(sx, sy);
        cv.style.cursor = h >= 0 ? HCURSOR[h] : hitObject(w[0], w[1]) ? 'move' : '';
      } else cv.style.cursor = '';
      return;
    }
    switch (drag.mode) {
      case 'pan':
        view.ox = drag.ox + sx - drag.sx; view.oy = drag.oy + sy - drag.sy;
        break;
      case 'draw':
        drag.cw = w; drag.shift = e.shiftKey;
        break;
      case 'rubber': {
        drag.cx = sx; drag.cy = sy;
        const [ax, ay] = s2w(Math.min(drag.sx, sx), Math.max(drag.sy, sy));
        const [bx, by] = s2w(Math.max(drag.sx, sx), Math.min(drag.sy, sy));
        S.sel = new Set(drag.base);
        for (const o of S.objects) {
          const b = G.objectBBox(o);
          if (b.maxx >= ax && b.minx <= bx && b.maxy >= ay && b.miny <= by) S.sel.add(o.id);
        }
        break;
      }
      case 'move': {
        const dx = w[0] - drag.w0[0], dy = w[1] - drag.w0[1];
        for (const g of drag.orig) { const o = objById(g.id); o.x = g.x + dx; o.y = g.y + dy; }
        drag.changed = true;
        updatePropFields();
        break;
      }
      case 'scale': {
        const { h, hw, aw } = drag;
        let kx = Math.abs(hw[0] - aw[0]) > 1e-9 ? (w[0] - aw[0]) / (hw[0] - aw[0]) : 1;
        let ky = Math.abs(hw[1] - aw[1]) > 1e-9 ? (w[1] - aw[1]) / (hw[1] - aw[1]) : 1;
        if (h < 4) { if (S.settings.lockAspect !== e.shiftKey) { const k = Math.max(kx, ky); kx = ky = k; } }
        else if (h === 4 || h === 6) kx = e.shiftKey ? ky : 1;
        else ky = e.shiftKey ? kx : 1;
        kx = Math.max(kx, 0.002); ky = Math.max(ky, 0.002);
        applyScale(drag.orig, kx, ky, aw[0], aw[1]);
        drag.changed = true;
        updatePropFields();
        break;
      }
    }
    requestDraw();
  });

  function endDrag() {
    if (!drag) return;
    const d = drag;
    drag = null;
    stage.classList.remove('grabbing');
    if (d.mode === 'draw') {
      const r = drawRect(d);
      if (r.w > 0.5 && r.h > 0.5) {
        const pts = d.tool === 'rect'
          ? [[0, 0], [r.w, 0], [r.w, r.h], [0, r.h]]
          : G.ellipsePts(r.w / 2, r.h / 2, r.w / 2, r.h / 2);
        const o = { id: uid(), type: 'path', layer: currentLayer().id, rot: 0, paths: [{ closed: true, pts }], w0: r.w, h0: r.h, x: r.x, y: r.y, w: r.w, h: r.h };
        S.objects.push(o);
        S.sel = new Set([o.id]);
        commit();
      }
      setTool('select');
    } else if ((d.mode === 'move' || d.mode === 'scale') && d.changed) {
      commit();
    } else if (d.mode === 'rubber') {
      refreshPanels();
    }
    requestDraw();
  }
  cv.addEventListener('pointerup', endDrag);
  cv.addEventListener('pointercancel', endDrag);
  cv.addEventListener('pointerleave', () => { if (!drag) $('#sbCursor').textContent = '—'; });
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    const [sx, sy] = evPos(e);
    if (e.ctrlKey || !e.shiftKey) zoomAt(sx, sy, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
    else { view.ox -= e.deltaY; requestDraw(); }
  }, { passive: false });
  cv.addEventListener('dblclick', e => {
    const [sx, sy] = evPos(e);
    const w = s2w(sx, sy);
    const o = hitObject(w[0], w[1]);
    if (o && o.text) editText(o);
  });
  cv.addEventListener('auxclick', e => { if (e.button === 1) e.preventDefault(); });

  function applyScale(orig, kx, ky, ax, ay) {
    for (const g of orig) {
      const o = objById(g.id);
      const cx = g.x + g.w / 2, cy = g.y + g.h / 2;
      const ncx = ax + (cx - ax) * kx, ncy = ay + (cy - ay) * ky;
      o.w = g.w * kx; o.h = g.h * ky;
      o.x = ncx - o.w / 2; o.y = ncy - o.h / 2;
    }
  }

  // ---------------------------------------------------------------- tools & text
  function setTool(t) {
    S.tool = t;
    $$('.tool[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
    stage.className = 'stage tool-' + t;
  }

  function fillTextDialog(vals) {
    const f = $('#dlgText form');
    const sel = f.font;
    if (!sel.options.length) sel.innerHTML = FONTS.map(n => `<option style="font-family:'${n}'">${n}</option>`).join('');
    f.text.value = vals.text || '';
    f.font.value = vals.font || 'Arial';
    f.size.value = vals.size || 10;
    f.bold.checked = !!vals.bold;
    f.italic.checked = !!vals.italic;
    return f;
  }
  async function textDialog(vals, title) {
    $('#textTitle').textContent = title;
    const f = fillTextDialog(vals);
    setTimeout(() => f.text.focus(), 30);
    if (!(await openDialog($('#dlgText')))) return null;
    const t = { text: f.text.value, font: f.font.value, size: parseFloat(f.size.value) || 10, bold: f.bold.checked, italic: f.italic.checked };
    if (!t.text.trim()) return null;
    const r = R.textToImage(t.text, t);
    if (!r) { toast('Nothing to render for that text.', 'warn'); return null; }
    return { t, r };
  }
  async function addText(at) {
    const res = await textDialog({}, 'Add text');
    setTool('select');
    if (!res) return;
    const id = await loadAsset(res.r.src);
    const layer = layerForMode('fill');
    const o = {
      id: uid(), type: 'image', asset: id, layer: layer.id, rot: 0, text: res.t,
      x: at[0], y: at[1] - res.r.h, w: res.r.w, h: res.r.h,
      image: { dither: 'threshold', invert: false, brightness: 0, contrast: 0 },
    };
    S.objects.push(o);
    S.sel = new Set([o.id]);
    commit(); requestDraw();
  }
  async function editText(o) {
    const res = await textDialog(o.text, 'Edit text');
    if (!res) return;
    const id = await loadAsset(res.r.src);
    const top = o.y + o.h;
    o.asset = id; o.text = res.t; o.w = res.r.w; o.h = res.r.h; o.y = top - o.h;
    commit(); requestDraw();
  }

  // ---------------------------------------------------------------- object ops
  function moveSel(dx, dy) {
    for (const o of selected()) { o.x += dx; o.y += dy; }
  }
  function deleteSel() {
    if (!S.sel.size) return;
    S.objects = S.objects.filter(o => !S.sel.has(o.id));
    S.sel.clear();
    commit(); requestDraw();
  }
  function duplicateSel() {
    const copies = selected().map(o => ({ ...JSON.parse(JSON.stringify(o)), id: uid(), x: o.x + 5, y: o.y - 5 }));
    if (!copies.length) return;
    S.objects.push(...copies);
    S.sel = new Set(copies.map(o => o.id));
    commit(); requestDraw();
  }
  function centerSel() {
    const b = selBBox();
    if (!b) return;
    moveSel(bedW() / 2 - (b.minx + b.maxx) / 2, bedH() / 2 - (b.miny + b.maxy) / 2);
    commit(); requestDraw();
  }

  // ---------------------------------------------------------------- properties bar
  const pf = { x: $('#pX'), y: $('#pY'), w: $('#pW'), h: $('#pH'), r: $('#pR') };
  function updatePropFields() {
    const s = selected();
    const bar = $('#propbar');
    bar.classList.toggle('disabled', !s.length);
    const b = s.length ? G.unionBBox(s) : null;
    const set = (el, v) => { if (document.activeElement !== el) el.value = v; };
    set(pf.x, b ? f2(b.minx) : '');
    set(pf.y, b ? f2(b.miny) : '');
    set(pf.w, b ? f2(b.maxx - b.minx) : '');
    set(pf.h, b ? f2(b.maxy - b.miny) : '');
    const single = s.length === 1 ? s[0] : null;
    pf.r.disabled = !single || single.type === 'image';
    set(pf.r, single ? f2(single.rot || 0) : '');
    $('#pLock').classList.toggle('on', S.settings.lockAspect);
    const layerSel = $('#pLayer');
    const lids = new Set(s.map(o => o.layer));
    layerSel.value = lids.size === 1 ? [...lids][0] : '';
    const img = single && single.type === 'image' ? single : null;
    $('#imgOpts').hidden = !img;
    if (img) {
      $('#iDither').value = img.image.dither;
      $('#iBright').value = img.image.brightness;
      $('#iContrast').value = img.image.contrast;
      $('#iInvert').checked = img.image.invert;
    }
    $('#sbSel').textContent = s.length ? `${s.length} selected · ${f2(b.maxx - b.minx)} × ${f2(b.maxy - b.miny)} mm` : `${S.objects.length} object${S.objects.length === 1 ? '' : 's'}`;
    $('#emptyState').hidden = S.objects.length > 0;
  }
  function onPropChange(field) {
    const b = selBBox();
    if (!b) return;
    const v = parseFloat(pf[field].value);
    if (!isFinite(v)) { updatePropFields(); return; }
    const orig = selected().map(cloneGeom);
    const W = b.maxx - b.minx, H = b.maxy - b.miny;
    if (field === 'x') moveSel(v - b.minx, 0);
    else if (field === 'y') moveSel(0, v - b.miny);
    else if (field === 'w' && v > 0 && W > 0) { const k = v / W; applyScale(orig, k, S.settings.lockAspect ? k : 1, b.minx, b.miny); }
    else if (field === 'h' && v > 0 && H > 0) { const k = v / H; applyScale(orig, S.settings.lockAspect ? k : 1, k, b.minx, b.miny); }
    else if (field === 'r') { const o = selected()[0]; if (o && o.type !== 'image') o.rot = ((v % 360) + 360) % 360; }
    commit(); requestDraw();
  }
  for (const k of Object.keys(pf)) {
    pf[k].addEventListener('change', () => onPropChange(k));
    pf[k].addEventListener('keydown', e => { if (e.key === 'Enter') pf[k].blur(); });
  }
  $('#pLock').addEventListener('click', () => { S.settings.lockAspect = !S.settings.lockAspect; saveSettings(); updatePropFields(); });
  $('#pLayer').addEventListener('change', e => {
    const id = e.target.value;
    if (!id) return;
    for (const o of selected()) o.layer = id;
    commit(); requestDraw();
  });
  const imgField = (sel, key, parse, live) => {
    const el = $(sel);
    const apply = () => {
      const o = selected()[0];
      if (!o || o.type !== 'image') return;
      o.image[key] = parse(el);
      requestDraw();
    };
    if (live) el.addEventListener('input', apply);
    el.addEventListener('change', () => { apply(); commit(); });
  };
  imgField('#iDither', 'dither', el => el.value);
  imgField('#iBright', 'brightness', el => +el.value, true);
  imgField('#iContrast', 'contrast', el => +el.value, true);
  imgField('#iInvert', 'invert', el => el.checked);

  // ---------------------------------------------------------------- layers panel
  function renderLayerList() {
    const counts = new Map();
    for (const o of S.objects) counts.set(o.layer, (counts.get(o.layer) || 0) + 1);
    $('#layerList').innerHTML = S.layers.map(l => `
      <div class="layer ${l.id === S.currentLayer ? 'active' : ''} ${l.output ? '' : 'off'}" data-id="${l.id}">
        <label class="swatch" style="--c:${l.color}" title="Change colour"><input type="color" value="${l.color}" data-k="color"></label>
        <div class="layer-main">
          <div class="layer-name">${esc(l.name)}</div>
          <div class="layer-meta">${MODE_LABEL[l.mode]} · ${l.speed} mm/min · ${l.power}%${l.passes > 1 ? ' · ×' + l.passes : ''} · ${counts.get(l.id) || 0} obj</div>
        </div>
        <button class="icon-btn" data-k="output" title="${l.output ? 'Output on — click to skip this layer' : 'Output off — click to include'}">
          <svg class="icon"><use href="#${l.output ? 'i-eye' : 'i-eye-off'}"/></svg></button>
      </div>`).join('');
    $('#pLayer').innerHTML = '<option value="" disabled>—</option>' + S.layers.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
  }
  const rangeCtl = (f, label, unit, v, min, max, step) => `
    <div class="ctl">
      <div class="ctl-h"><span>${label}</span><span class="inline-num"><input type="number" data-f="${f}" value="${v}" min="${min}" max="${max}" step="${step}"><span class="u">${unit}</span></span></div>
      <input type="range" data-f="${f}" value="${v}" min="${min}" max="${max}" step="${step}">
    </div>`;
  const numCtl = (f, label, unit, v, min, max, step, extra = '') => `
    <div class="ctl"><div class="ctl-h"><span>${label}</span><span class="inline-num"><input type="number" data-f="${f}" value="${v}" min="${min}" max="${max}" step="${step}"><span class="u">${unit}</span></span></div>${extra}</div>`;
  function renderLayerEditor() {
    const l = currentLayer();
    const ed = $('#layerEditor');
    if (!l) { ed.innerHTML = ''; return; }
    const idx = S.layers.indexOf(l);
    ed.innerHTML = `
      <div class="card-h">
        <input class="name-input" data-f="name" value="${esc(l.name)}" aria-label="Layer name">
        <div class="row-btns">
          <button class="icon-btn" data-act="layerUp" title="Move up (runs earlier)" ${idx === 0 ? 'disabled' : ''}><svg class="icon"><use href="#i-up"/></svg></button>
          <button class="icon-btn" data-act="layerDown" title="Move down (runs later)" ${idx === S.layers.length - 1 ? 'disabled' : ''}><svg class="icon"><use href="#i-down"/></svg></button>
          <button class="icon-btn danger-h" data-act="layerDelete" title="Delete layer"><svg class="icon"><use href="#i-trash"/></svg></button>
        </div>
      </div>
      <div class="seg">${['line', 'fill', 'image'].map(m => `<button data-mode="${m}" class="${l.mode === m ? 'on' : ''}">${MODE_LABEL[m]}</button>`).join('')}</div>
      <p class="hint">${MODE_HINT[l.mode]}</p>
      ${rangeCtl('speed', 'Speed', 'mm/min', l.speed, 50, 10000, 10)}
      ${rangeCtl('power', l.mode === 'image' ? 'Max power' : 'Power', '%', l.power, 0, 100, 0.5)}
      ${l.mode === 'image' ? rangeCtl('minPower', 'Min power', '%', l.minPower, 0, 100, 0.5) : ''}
      ${numCtl('passes', 'Passes', '', l.passes, 1, 50, 1)}
      ${l.mode !== 'line' ? numCtl('interval', 'Line interval', 'mm', l.interval, 0.02, 1, 0.01, `<div class="small muted" id="dpiOut">${Math.round(25.4 / l.interval)} DPI</div>`) : ''}
      ${S.sel.size ? '<button class="btn sm" data-act="assignLayer">Move selection to this layer</button>' : ''}`;
  }
  function refreshPanels() {
    renderLayerList();
    renderLayerEditor();
    updatePropFields();
  }

  $('#layerList').addEventListener('click', e => {
    const row = e.target.closest('.layer');
    if (!row) return;
    const l = layerById(row.dataset.id);
    if (e.target.closest('[data-k="output"]')) { l.output = !l.output; commit(); requestDraw(); return; }
    if (e.target.closest('.swatch')) return;
    S.currentLayer = l.id;
    refreshPanels();
  });
  $('#layerList').addEventListener('input', e => {
    if (e.target.dataset.k !== 'color') return;
    const l = layerById(e.target.closest('.layer').dataset.id);
    l.color = e.target.value;
    e.target.parentElement.style.setProperty('--c', l.color);
    requestDraw();
  });
  $('#layerList').addEventListener('change', e => { if (e.target.dataset.k === 'color') commit(); });

  const LIMITS = { speed: [1, 20000], power: [0, 100], minPower: [0, 100], passes: [1, 100], interval: [0.01, 5] };
  $('#layerEditor').addEventListener('input', e => {
    const f = e.target.dataset.f;
    if (!f) return;
    const l = currentLayer();
    if (f === 'name') { l.name = e.target.value; renderLayerList(); updatePropFields(); return; }
    let v = parseFloat(e.target.value);
    if (!isFinite(v)) return;
    v = clamp(v, ...LIMITS[f]);
    if (f === 'passes') v = Math.round(v);
    l[f] = v;
    $$(`[data-f="${f}"]`, e.currentTarget).forEach(el => { if (el !== e.target) el.value = v; });
    if (f === 'interval') { const d = $('#dpiOut'); if (d) d.textContent = Math.round(25.4 / v) + ' DPI'; requestDraw(); }
    renderLayerList();
  });
  $('#layerEditor').addEventListener('change', e => {
    const f = e.target.dataset.f;
    if (!f) return;
    if (f !== 'name') { const l = currentLayer(); if (e.target.value !== String(l[f])) e.target.value = l[f]; }
    commit();
  });
  $('#layerEditor').addEventListener('click', e => {
    const m = e.target.closest('[data-mode]');
    if (!m) return;
    currentLayer().mode = m.dataset.mode;
    commit(); requestDraw();
  });

  // ---------------------------------------------------------------- job generation & preview
  function invalidatePreview() {
    S.previewStale = true;
    if (S.previewOn) schedulePreview();
  }
  let previewTimer = 0;
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => { buildJob(); requestDraw(); }, 250);
  }
  function jobOptions() {
    const s = S.settings;
    return {
      maxS: S.machine.maxS, rapid: S.machine.rapid, accel: S.machine.accel, overscan: s.overscan,
      origin: s.jobOrigin, returnHome: s.returnHome,
      machineName: `${S.machine.name} (GRBL 1.1)`,
      offset: MA.offsetFor(S.machine, s.jobOrigin),
      frameSpeed: s.frameSpeed, frameLaser: s.frameLaser, framePower: s.framePower,
    };
  }
  function buildJob() {
    if (!S.previewStale && S.preview) return S.preview;
    const t0 = performance.now();
    try {
      S.preview = GC.generate({ layers: S.layers, objects: S.objects }, id => assets.get(id)?.img, jobOptions());
    } catch (e) {
      console.error(e);
      toast('Could not generate G-code: ' + e.message, 'error');
      S.preview = { empty: true };
    }
    S.previewStale = false;
    S.preview.genMs = performance.now() - t0;
    renderEstimate();
    return S.preview;
  }
  function renderEstimate() {
    const P = S.preview;
    const out = $('#estOut');
    if (!P || P.empty) {
      out.className = 'est muted';
      out.textContent = 'Nothing to burn. Add objects to a layer that has output turned on.';
      $('#jobEst').textContent = '';
      return;
    }
    const b = P.bbox;
    const outside = b.minx < -0.01 || b.miny < -0.01 || b.maxx > bedW() + 0.01 || b.maxy > bedH() + 0.01;
    out.className = 'est';
    out.innerHTML = `
      <span>Estimated time</span><b>${fmtTime(P.time)}</b>
      <span>Job size</span><b>${f2(b.maxx - b.minx)} × ${f2(b.maxy - b.miny)} mm</b>
      <span>Burn distance</span><b>${(P.cutLen / 1000).toFixed(2)} m</b>
      <span>G-code lines</span><b>${P.lineCount.toLocaleString()}</b>
      ${outside && S.settings.jobOrigin === 'absolute' ? '<span style="grid-column:1/-1;color:var(--warn)">Part of the job is outside the work area.</span>' : ''}`;
    $('#jobEst').textContent = '≈ ' + fmtTime(P.time);
  }
  function togglePreview(force) {
    S.previewOn = force ?? !S.previewOn;
    $('#btnPreview').classList.toggle('on', S.previewOn);
    if (S.previewOn) {
      const P = buildJob();
      if (P.empty) toast('Nothing to preview yet.', 'warn');
    }
    requestDraw();
  }

  // ---------------------------------------------------------------- files
  function download(name, data, type) {
    const blob = data instanceof Blob ? data : new Blob([data], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function projectData() {
    const used = new Set(S.objects.filter(o => o.asset).map(o => o.asset));
    const as = {};
    for (const id of used) if (assets.has(id)) as[id] = assets.get(id).src;
    return { app: 'kerf-studio', version: 1, layers: S.layers, objects: S.objects, currentLayer: S.currentLayer, assets: as };
  }
  async function loadProject(d, quiet) {
    if (!d || !Array.isArray(d.layers) || !Array.isArray(d.objects)) throw new Error('Not a Kerf Studio project file.');
    for (const [id, src] of Object.entries(d.assets || {})) {
      try { await loadAsset(src, id); } catch (e) { /* skip broken image */ }
    }
    S.layers = d.layers.length ? d.layers : [];
    if (!S.layers.length) addLayer();
    S.objects = d.objects.filter(o => o.type !== 'image' || assets.has(o.asset));
    S.currentLayer = d.currentLayer && layerById(d.currentLayer) ? d.currentLayer : S.layers[0].id;
    S.sel.clear();
    history.stack = []; history.idx = -1;
    commit();
    requestDraw();
    if (!quiet) toast('Project opened', 'ok');
  }
  function newProject() {
    S.layers = []; S.objects = []; S.sel.clear();
    S.currentLayer = addLayer().id;
    history.stack = []; history.idx = -1;
    commit(); requestDraw();
  }
  const readFile = (file, how) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    if (how === 'url') r.readAsDataURL(file);
    else if (how === 'buffer') r.readAsArrayBuffer(file);
    else r.readAsText(file);
  });

  // Bambu Suite processes -> Kerf layers with conservative starting values.
  // Listed in burn order: engrave first, cut last.
  const LAC_PROCESS = {
    LaserImageEngrave: { mode: 'image', name: 'Engrave (image)', speed: 3000, power: 50, passes: 1 },
    LaserFillEngrave: { mode: 'fill', name: 'Engrave (fill)', speed: 3000, power: 40, passes: 1 },
    LaserLineEngrave: { mode: 'line', name: 'Score', speed: 1000, power: 30, passes: 1 },
    LaserLineCut: { mode: 'line', name: 'Cut', speed: 250, power: 100, passes: 3 },
  };
  async function placeLac(res, fileName) {
    const procOf = it => (LAC_PROCESS[it.process] ? it.process : it.kind === 'image' ? 'LaserImageEngrave' : 'LaserLineEngrave');
    // Drop the untouched starter layer so the import's layers are the only ones.
    if (!S.objects.length && S.layers.length === 1) S.layers = [];
    const layerFor = {};
    for (const proc of Object.keys(LAC_PROCESS)) {
      const its = res.items.filter(it => procOf(it) === proc);
      if (!its.length) continue;
      const p = LAC_PROCESS[proc];
      const used = new Set(S.layers.map(l => l.color.toLowerCase()));
      const fileColor = its.find(it => it.color && !used.has(it.color))?.color;
      const l = addLayer({ mode: p.mode, name: p.name, color: fileColor || nextColor() });
      Object.assign(l, { speed: p.speed, power: p.power, passes: p.passes });
      layerFor[proc] = l;
    }
    const objs = [];
    const pathGroups = new Map();
    for (const it of res.items) {
      if (it.kind !== 'path') continue;
      const key = it.group + '|' + procOf(it);
      if (!pathGroups.has(key)) pathGroups.set(key, { layer: layerFor[procOf(it)], name: it.name, polys: [] });
      pathGroups.get(key).polys.push(...it.polylines);
    }
    for (const g of pathGroups.values()) {
      objs.push({ id: uid(), type: 'path', layer: g.layer.id, rot: 0, name: g.name, ...G.fromWorld(g.polys) });
    }
    for (const it of res.items) {
      if (it.kind !== 'image') continue;
      let id = await loadAsset(it.src);
      const smaller = R.normalizeImage(assets.get(id).img);
      if (smaller) { assets.delete(id); id = await loadAsset(smaller); }
      objs.push({
        id: uid(), type: 'image', asset: id, layer: layerFor[procOf(it)].id, rot: 0, name: it.name,
        x: it.x, y: it.y, w: it.w, h: it.h,
        image: { dither: it.dither, invert: false, brightness: 0, contrast: 0 },
      });
    }
    const b = G.unionBBox(objs);
    const dx = bedW() / 2 - (b.minx + b.maxx) / 2, dy = bedH() / 2 - (b.miny + b.maxy) / 2;
    for (const o of objs) { o.x += dx; o.y += dy; }
    S.objects.push(...objs);
    S.sel = new Set(objs.map(o => o.id));
    S.currentLayer = Object.values(layerFor)[0].id;
    commit(); requestDraw();

    const label = res.title ? `"${res.title}"${res.designer ? ' by ' + res.designer : ''}` : fileName;
    toast(`Imported ${label} · ${f2(b.maxx - b.minx)} × ${f2(b.maxy - b.miny)} mm`, 'ok', 5000);
    toast(`Bambu power and speed settings were replaced with ${S.machine.name} starting values. Test on scrap first.`, 'warn', 9000);
    if (b.maxx - b.minx > bedW() || b.maxy - b.miny > bedH()) {
      toast(`The design is larger than your ${bedW()} × ${bedH()} mm work area. Rearrange pieces or burn them in batches.`, 'warn', 10000);
    }
    for (const w of res.warnings) toast(w, 'warn', 7000);
  }

  async function importFile(file) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    try {
      if (ext === 'lac') {
        toast(`Reading ${file.name}…`, 'info', 2500);
        await placeLac(await K.lac.parse(await readFile(file, 'buffer')), file.name);
      } else if (ext === 'svg' || ext === 'dxf') {
        const text = await readFile(file, 'text');
        const res = ext === 'svg' ? G.importSVG(text) : G.importDXF(text);
        placeVectors(res.groups, file.name);
        if (res.skippedText) toast(`${res.skippedText} text element(s) skipped. Convert text to paths in your design app first.`, 'warn', 6000);
      } else if (['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp'].includes(ext)) {
        let src = await readFile(file, 'url');
        let id = await loadAsset(src);
        const smaller = R.normalizeImage(assets.get(id).img);
        if (smaller) { assets.delete(id); id = await loadAsset(smaller); }
        const img = assets.get(id).img;
        const ar = img.naturalHeight / img.naturalWidth;
        let w = Math.min(120, (img.naturalWidth * 25.4) / 96), h = w * ar;
        if (h > bedH() * 0.8) { h = bedH() * 0.8; w = h / ar; }
        const layer = layerForMode('image');
        const o = {
          id: uid(), type: 'image', asset: id, layer: layer.id, rot: 0, name: file.name,
          x: (bedW() - w) / 2, y: (bedH() - h) / 2, w, h,
          image: { dither: 'jarvis', invert: false, brightness: 0, contrast: 0 },
        };
        S.objects.push(o);
        S.sel = new Set([o.id]);
        commit(); requestDraw();
        toast(`Imported ${file.name}`, 'ok');
      } else {
        toast(`Can't import .${ext} files. Use LAC, SVG, DXF, PNG or JPG.`, 'warn');
      }
    } catch (e) {
      console.error(e);
      toast(`Import failed: ${e.message}`, 'error', 6000);
    }
  }
  function placeVectors(groups, name) {
    const objs = [];
    for (const g of groups) {
      const polys = g.polylines.filter(p => p.pts.length > 1);
      if (!polys.length) continue;
      const layer = g.color ? layerForColor(g.color, !objs.length) : currentLayer();
      objs.push({ id: uid(), type: 'path', layer: layer.id, rot: 0, name, ...G.fromWorld(polys) });
    }
    if (!objs.length) { toast('No vector shapes found in that file.', 'warn'); return; }
    const b = G.unionBBox(objs);
    const dx = bedW() / 2 - (b.minx + b.maxx) / 2, dy = bedH() / 2 - (b.miny + b.maxy) / 2;
    for (const o of objs) { o.x += dx; o.y += dy; }
    S.objects.push(...objs);
    S.sel = new Set(objs.map(o => o.id));
    commit(); requestDraw();
    toast(`Imported ${name} · ${f2(b.maxx - b.minx)} × ${f2(b.maxy - b.miny)} mm`, 'ok');
  }

  $('#fileImport').addEventListener('change', async e => {
    for (const f of e.target.files) await importFile(f);
    e.target.value = '';
  });
  $('#fileOpen').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try { await loadProject(JSON.parse(await readFile(f, 'text'))); fitBed(); }
    catch (err) { toast('Could not open project: ' + err.message, 'error'); }
  });
  stage.addEventListener('dragover', e => { e.preventDefault(); stage.classList.add('dragover'); });
  stage.addEventListener('dragleave', e => { if (e.target === stage || !stage.contains(e.relatedTarget)) stage.classList.remove('dragover'); });
  stage.addEventListener('drop', async e => {
    e.preventDefault();
    stage.classList.remove('dragover');
    for (const f of e.dataTransfer.files) await importFile(f);
  });

  // ---------------------------------------------------------------- machine UI
  const STATE_LABEL = { Idle: 'Ready', Run: 'Running', Hold: 'Paused', Jog: 'Jogging', Alarm: 'Alarm', Door: 'Door open', Home: 'Homing', Check: 'Check mode', Sleep: 'Sleep', Connecting: 'Connecting…', Disconnected: 'Offline' };
  let machineQueued = false;
  function updateMachineUI() {
    if (machineQueued) return;
    machineQueued = true;
    requestAnimationFrame(() => {
      machineQueued = false;
      const st = grbl.status;
      const state = grbl.connected ? st.state : 'Disconnected';
      const label = STATE_LABEL[state] || state;
      $('#conn').dataset.state = state;
      $('#connState').textContent = label;
      $('#stateChip').dataset.state = state;
      $('#stateChip').textContent = label;
      const btn = $('#btnConnect');
      btn.classList.toggle('primary', !grbl.connected);
      btn.querySelector('span').textContent = grbl.connected ? 'Disconnect' : 'Connect';
      $$('.mc').forEach(el => { el.disabled = !grbl.connected; });
      if (grbl.connected) {
        const hp = headPos();
        $('#posX').textContent = f2(hp.x);
        $('#posY').textContent = f2(hp.y);
        $('#fsInfo').textContent = `Feed ${Math.round(st.feed)} mm/min · Power S${Math.round(st.power)}`;
        $('#sbMachine').textContent = `${label} · X ${f2(hp.x)} Y ${f2(hp.y)}`;
      } else {
        $('#posX').textContent = '—'; $('#posY').textContent = '—';
        $('#fsInfo').textContent = 'Connect your laser over USB to begin.';
        $('#sbMachine').textContent = 'Offline';
      }
      const paused = state === 'Hold';
      const pb = $('#btnPause');
      pb.querySelector('span').textContent = paused ? 'Resume' : 'Pause';
      pb.querySelector('use').setAttribute('href', paused ? '#i-play' : '#i-pause');
      requestDraw();
    });
  }

  let jobTimer = 0;
  function updateJobProgress() {
    const j = grbl.job;
    if (!j) return;
    const p = j.total ? j.acked / j.total : 0;
    const el = (performance.now() - j.start) / 1000;
    const remain = p > 0.02 ? el / p - el : (S.preview?.time || 0) - el;
    $('#progBar').style.width = (p * 100).toFixed(1) + '%';
    $('#progText').textContent = `${(p * 100).toFixed(1)}% · ${fmtTime(el)} elapsed · ~${fmtTime(remain)} left`;
    $('#sbJob').textContent = `Job ${(p * 100).toFixed(0)}%`;
  }
  function jobEnded(msg, type) {
    clearInterval(jobTimer);
    $('#sbJob').textContent = '';
    $('#progText').textContent = msg;
    if (type === 'ok') $('#progBar').style.width = '100%';
    toast(msg, type, 6000);
  }

  const logEl = $('#log');
  function log(type, text) {
    const nearBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
    const d = document.createElement('div');
    d.className = type;
    d.textContent = (type === 'tx' ? '› ' : '') + text;
    logEl.appendChild(d);
    while (logEl.childElementCount > 1000) logEl.firstChild.remove();
    if (nearBottom) logEl.scrollTop = logEl.scrollHeight;
  }

  let settingsRead = null;
  grbl.addEventListener('status', updateMachineUI);
  grbl.addEventListener('log', e => log(e.detail.type, e.detail.text));
  grbl.addEventListener('connected', () => {
    updateMachineUI();
    toast('Laser connected', 'ok');
    settingsRead = {};
    grbl.send('$$', 'silent');
    setTimeout(applyMachineSettings, 1500);
  });
  grbl.addEventListener('disconnected', updateMachineUI);
  grbl.addEventListener('alarm', e => toast(`Alarm ${e.detail.code}: ${e.detail.message}. Use Home or Unlock.`, 'error', 7000));
  grbl.addEventListener('setting', e => { if (settingsRead) settingsRead[e.detail.key] = e.detail.value; });
  grbl.addEventListener('jobStart', () => {
    $('#progBar').style.width = '0%';
    clearInterval(jobTimer);
    jobTimer = setInterval(updateJobProgress, 250);
    updateJobProgress();
  });
  grbl.addEventListener('jobDone', e => jobEnded(`Job finished in ${fmtTime(e.detail.elapsed)}`, 'ok'));
  grbl.addEventListener('jobAborted', e => jobEnded(`Job stopped: ${e.detail.reason}`, 'warn'));

  async function applyMachineSettings() {
    const r = settingsRead;
    settingsRead = null;
    if (!r || !Object.keys(r).length) return;
    const m = S.machine;
    const patch = {};
    const msgs = [];
    if (r[30] > 0 && r[30] !== m.maxS) { patch.maxS = r[30]; msgs.push(`S-max ${r[30]}`); }
    if (r[130] > 0 && r[131] > 0 && (r[130] !== m.bedW || r[131] !== m.bedH)) {
      patch.bedW = r[130]; patch.bedH = r[131];
      msgs.push(`work area ${r[130]} × ${r[131]} mm`);
    }
    if (r[110] > 0 && r[111] > 0) patch.rapid = Math.min(r[110], r[111]);
    if (r[120] > 0 && r[121] > 0) patch.accel = Math.min(r[120], r[121]);
    if (Object.keys(patch).length) saveMachine(patch);   // also refits the bed
    if (msgs.length) toast('Read from controller: ' + msgs.join(', '), 'info', 5000);
    if (r[32] === 0) toast('Laser mode is off ($32=0). Send $32=1 from the Console before burning.', 'warn', 9000);
    if (S.machine.hasHoming && r[22] === 0) {
      toast('Homing is disabled on this controller ($22=0). Home will alarm until it is enabled.', 'warn', 9000);
    }
    await reconcileSettings(r);
  }

  // Offer to bring the controller in line with the profile. Nothing is ever
  // written without a tick, and the old value is logged first so it can be
  // put back by hand.
  async function reconcileSettings(read) {
    const rows = MA.diff(S.machine, read);
    if (!rows.length) return;
    $('#reconcileRows').innerHTML = rows.map(r => `
      <label class="check recon-row">
        <input type="checkbox" name="w${r.key}"${r.required ? ' checked' : ''}>
        <span><b>$${r.key}</b> ${esc(r.name)} — machine <b>${r.machine}</b>, profile wants <b>${r.want}</b>
        ${r.required ? '<em class="req">required</em>' : ''}
        ${r.risk ? `<small class="muted">${esc(r.risk)}</small>` : ''}</span>
      </label>`).join('');
    if (!(await openDialog($('#dlgReconcile')))) return;

    const writes = rows.filter(r => {
      const el = $(`#reconcileRows [name="w${r.key}"]`);
      return el && el.checked;
    });
    for (const r of writes) {
      grbl._log('info', `Changing $${r.key} (${r.name}) from ${r.machine} to ${r.want} — previous value was ${r.machine}`);
      grbl.send(`$${r.key}=${r.want}`);
    }
    if (!writes.length) return;
    toast(`Wrote ${writes.length} setting${writes.length === 1 ? '' : 's'}. Previous values are in the console.`, 'ok', 8000);
    if (writes.some(r => r.key === 22 || r.key === 23)) {
      toast('Homing settings changed. Jog clear of the switches before you run Home.', 'warn', 10000);
    }
  }

  async function toggleConnect() {
    if (!grbl.supported) { toast('Web Serial is not available here. Use Chrome or Edge on desktop.', 'error', 6000); return; }
    if (grbl.connected) {
      if (grbl.job && !(await ask('Disconnect during a job?', 'The job will stop and the laser will be left where it is.', 'Disconnect', true))) return;
      if (grbl.job) grbl.stop();
      await grbl.disconnect();
      return;
    }
    try {
      await grbl.connect(+S.machine.baud);
    } catch (e) {
      if (e.name !== 'NotFoundError') toast('Could not open the port: ' + e.message, 'error', 6000);
      try { await grbl.disconnect(); } catch (err) { /* ignore */ }
      updateMachineUI();
    }
  }

  function requireIdle(what) {
    if (!grbl.connected) { toast('Connect the laser first.', 'warn'); return false; }
    const st = grbl.status.state;
    if (st === 'Alarm') { toast(`The machine is in alarm. Home or Unlock before you ${what}.`, 'error'); return false; }
    if (grbl.job || (st !== 'Idle' && st !== 'Jog')) { toast(`The machine is busy (${STATE_LABEL[st] || st}).`, 'warn'); return false; }
    return true;
  }

  async function startJob() {
    if (!requireIdle('start a job')) return;
    S.previewStale = true;
    const P = buildJob();
    if (P.empty) { toast('Nothing to burn. Add objects to a layer with output on.', 'warn'); return; }
    const b = P.bbox, s = S.settings;
    const outside = s.jobOrigin === 'absolute' && (b.minx < -0.01 || b.miny < -0.01 || b.maxx > bedW() + 0.01 || b.maxy > bedH() + 0.01);
    const used = S.layers.filter(l => l.output && S.objects.some(o => o.layer === l.id));
    $('#runSummary').innerHTML = `
      <span>Estimated time</span><b>${fmtTime(P.time)}</b>
      <span>Job size</span><b>${f2(b.maxx - b.minx)} × ${f2(b.maxy - b.miny)} mm</b>
      <span>Start from</span><b>${s.jobOrigin === 'current' ? 'Current laser position' : 'Absolute coordinates'}</b>
      <span>Layers</span><b>${used.map(l => `${esc(l.name)} (${l.power}%)`).join(', ')}</b>
      ${outside ? '<span style="grid-column:1/-1;color:var(--danger)">Warning: part of the job is outside the work area.</span>' : ''}`;
    if (!(await openDialog($('#dlgRun')))) return;
    if (!requireIdle('start a job')) return;
    grbl.streamJob(P.lines);
    toast('Job started', 'info');
  }

  function jobBBox() {
    const objs = S.objects.filter(o => { const l = layerById(o.layer); return l && l.output; });
    return objs.length ? G.unionBBox(objs) : null;
  }

  // ---------------------------------------------------------------- actions
  const ACTIONS = {
    new: async () => {
      if (S.objects.length && !(await ask('Start a new project?', 'Your current design will be cleared. Save it first if you need it.', 'New project', true))) return;
      newProject(); fitBed();
    },
    open: () => $('#fileOpen').click(),
    save: () => download('kerf-project.kerf.json', JSON.stringify(projectData()), 'application/json'),
    import: () => $('#fileImport').click(),
    export: () => {
      S.previewStale = true;
      const P = buildJob();
      if (P.empty) { toast('Nothing to export yet.', 'warn'); return; }
      download('kerf-job.gcode', P.lines.join('\n') + '\n', 'text/plain');
      toast(`G-code saved · ${P.lineCount.toLocaleString()} lines · ≈ ${fmtTime(P.time)}`, 'ok');
    },
    undo, redo,
    preview: () => togglePreview(),
    estimate: () => { S.previewStale = true; buildJob(); if (S.previewOn) requestDraw(); },
    connect: toggleConnect,
    settings: () => openSettings(),
    theme: () => setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'),
    zoomIn: () => zoomAt(view.w / 2, view.h / 2, 1.25),
    zoomOut: () => zoomAt(view.w / 2, view.h / 2, 0.8),
    zoomFit: fitBed,
    center: centerSel,
    duplicate: duplicateSel,
    delete: deleteSel,
    addLayer: () => { S.currentLayer = addLayer().id; commit(); },
    layerUp: () => { const i = S.layers.indexOf(currentLayer()); if (i > 0) { [S.layers[i - 1], S.layers[i]] = [S.layers[i], S.layers[i - 1]]; commit(); } },
    layerDown: () => { const i = S.layers.indexOf(currentLayer()); if (i < S.layers.length - 1) { [S.layers[i + 1], S.layers[i]] = [S.layers[i], S.layers[i + 1]]; commit(); } },
    layerDelete: async () => {
      if (S.layers.length < 2) { toast('A project needs at least one layer.', 'warn'); return; }
      const l = currentLayer();
      const n = S.objects.filter(o => o.layer === l.id).length;
      if (n && !(await ask(`Delete "${l.name}"?`, `Its ${n} object(s) will move to another layer.`, 'Delete layer', true))) return;
      S.layers = S.layers.filter(x => x !== l);
      for (const o of S.objects) if (o.layer === l.id) o.layer = S.layers[0].id;
      S.currentLayer = S.layers[0].id;
      commit(); requestDraw();
    },
    assignLayer: () => { const l = currentLayer(); for (const o of selected()) o.layer = l.id; commit(); requestDraw(); },
    home: () => { if (grbl.connected) grbl.send('$H'); },
    unlock: () => { if (grbl.connected) grbl.send('$X'); },
    goOrigin: () => {
      if (!requireIdle('move')) return;
      const o = S.machine.originOffset;   // design 0,0 in machine coordinates
      grbl.send(`G90 G0 X${GC.fmt(o.x)} Y${GC.fmt(o.y)}`);
    },
    frame: () => {
      if (!requireIdle('frame')) return;
      const b = jobBBox();
      if (!b) { toast('Nothing to frame yet.', 'warn'); return; }
      grbl.sendMany(GC.frame(b, jobOptions()));
    },
    start: startJob,
    pause: () => { if (grbl.status.state === 'Hold') grbl.resume(); else grbl.pause(); },
    stop: () => { grbl.stop(); setTimeout(() => grbl.send('M5'), 600); },
    softReset: () => grbl.realtime('\x18'),
    clearLog: () => { logEl.innerHTML = ''; },
  };
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (b && !b.disabled && ACTIONS[b.dataset.act]) { ACTIONS[b.dataset.act](b, e); return; }
    const t = e.target.closest('[data-tool]');
    if (t) { setTool(t.dataset.tool); return; }
    const tab = e.target.closest('[data-tab]');
    if (tab) {
      $$('.tab').forEach(x => x.classList.toggle('active', x === tab));
      $$('.panel').forEach(p => { p.hidden = p.dataset.panel !== tab.dataset.tab; });
      return;
    }
    const j = e.target.closest('[data-jog]');
    if (j && !j.disabled) {
      if (!grbl.connected) return;
      const [dx, dy] = j.dataset.jog.split(',').map(Number);
      grbl.jog(dx * S.settings.jogStep, dy * S.settings.jogStep, S.settings.jogFeed);
      return;
    }
    const st = e.target.closest('[data-step]');
    if (st) { S.settings.jogStep = +st.dataset.step; saveSettings(); syncMachineInputs(); return; }
    const c = e.target.closest('[data-cmd]');
    if (c && !c.disabled) grbl.send(c.dataset.cmd);
  });

  function syncMachineInputs() {
    $$('#jogSteps button').forEach(b => b.classList.toggle('on', +b.dataset.step === S.settings.jogStep));
    $('#jogFeed').value = S.settings.jogFeed;
    $('#jobOrigin').value = S.settings.jobOrigin;
    $('#returnHome').checked = S.settings.returnHome;
  }
  $('#jogFeed').addEventListener('change', e => { S.settings.jogFeed = clamp(+e.target.value || 3000, 100, 10000); saveSettings(); syncMachineInputs(); });
  $('#jobOrigin').addEventListener('change', e => { S.settings.jobOrigin = e.target.value; saveSettings(); invalidatePreview(); });
  $('#returnHome').addEventListener('change', e => { S.settings.returnHome = e.target.checked; saveSettings(); invalidatePreview(); });

  $('#machineTag').addEventListener('change', async e => {
    const v = e.target.value;
    if (v === '__add' || v === '__dup') { await addMachine(v === '__dup'); return; }
    setMachine(v);
    toast(`Switched to ${S.machine.name}`, 'info');
  });
  $('#btnCalibrateOrigin').addEventListener('click', calibrateOrigin);

  // console input with history
  const cmdHist = [];
  let cmdIdx = 0;
  $('#cmdForm').addEventListener('submit', e => {
    e.preventDefault();
    const inp = $('#cmdInput');
    const v = inp.value.trim();
    if (!v || !grbl.connected) return;
    if (v === '?' || v === '!' || v === '~') { grbl.realtime(v); log('tx', v); }
    else grbl.send(v);
    cmdHist.push(v); cmdIdx = cmdHist.length;
    inp.value = '';
  });
  $('#cmdInput').addEventListener('keydown', e => {
    if (e.key === 'ArrowUp' && cmdIdx > 0) { e.target.value = cmdHist[--cmdIdx]; e.preventDefault(); }
    if (e.key === 'ArrowDown') { cmdIdx = Math.min(cmdHist.length, cmdIdx + 1); e.target.value = cmdHist[cmdIdx] || ''; e.preventDefault(); }
  });

  // settings dialog
  // Machine facts belong to the profile; everything else is a preference.
  const MACHINE_FIELDS = ['bedW', 'bedH', 'maxS', 'baud', 'rapid', 'accel'];

  async function openSettings() {
    const f = $('#dlgSettings form'), m = S.machine;
    f.machineName.value = m.name;
    f.hasHoming.checked = m.hasHoming;
    for (const k of MACHINE_FIELDS) f[k].value = m[k];
    f.offX.value = m.originOffset.x;
    f.offY.value = m.originOffset.y;
    for (const el of f.elements) {
      if (!el.name || el.name === 'machineName' || el.name === 'hasHoming'
        || el.name === 'offX' || el.name === 'offY' || MACHINE_FIELDS.includes(el.name)) continue;
      if (el.type === 'checkbox') el.checked = !!S.settings[el.name];
      else el.value = S.settings[el.name];
    }

    if (!(await openDialog($('#dlgSettings')))) return;

    const patch = {
      name: f.machineName.value.trim() || m.name,
      hasHoming: f.hasHoming.checked,
      originOffset: { x: parseFloat(f.offX.value) || 0, y: parseFloat(f.offY.value) || 0 },
    };
    for (const k of MACHINE_FIELDS) {
      const v = parseFloat(f[k].value);
      if (isFinite(v) && v > 0) patch[k] = v;
    }
    for (const el of f.elements) {
      if (!el.name || el.name === 'machineName' || el.name === 'hasHoming'
        || el.name === 'offX' || el.name === 'offY' || MACHINE_FIELDS.includes(el.name)) continue;
      if (el.type === 'checkbox') S.settings[el.name] = el.checked;
      else { const v = parseFloat(el.value); if (isFinite(v) && v >= 0) S.settings[el.name] = v; }
    }
    S.settings.framePower = clamp(S.settings.framePower, 0, 5);
    saveSettings();
    saveMachine(patch);          // applyMachine() refits the bed and redraws
    toast('Settings saved', 'ok');
  }

  // Capturing MPos verbatim works on any firmware and any homing corner:
  // home, jog to the corner you want as design origin, then click.
  function calibrateOrigin() {
    if (!grbl.connected) { toast('Connect the laser first.', 'warn'); return; }
    const o = MA.calibrate(S.machine, grbl.status.mpos);
    const f = $('#dlgSettings form');
    f.offX.value = f2(o.x);
    f.offY.value = f2(o.y);
    toast(`Work origin set to X ${f2(o.x)} Y ${f2(o.y)}. Save to keep it.`, 'ok', 6000);
  }

  async function addMachine(duplicate) {
    const base = duplicate ? S.machine : MA.normalize({ id: '', name: '' });
    const name = prompt('Name for the new machine', duplicate ? S.machine.name + ' copy' : 'My laser');
    if (!name) { applyMachine(); return; }
    const p = MA.save(store, { ...base, id: MA.newId(store), name, builtin: false });
    setMachine(p.id);
    await openSettings();
  }

  function setTheme(t) {
    document.documentElement.dataset.theme = t;
    $('#themeIcon use').setAttribute('href', t === 'light' ? '#i-moon' : '#i-sun');
    try { localStorage.setItem('kerf.theme', t); } catch (e) { /* ignore */ }
    readColors();
    requestDraw();
  }

  // ---------------------------------------------------------------- keyboard
  document.addEventListener('keydown', e => {
    const tag = e.target.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable;
    if (document.querySelector('dialog[open]')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); ACTIONS.save(); return; }
    if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); ACTIONS.open(); return; }
    if (mod && e.key.toLowerCase() === 'i') { e.preventDefault(); ACTIONS.import(); return; }
    if (typing) return;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSel(); return; }
    if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); S.sel = new Set(S.objects.map(o => o.id)); refreshPanels(); requestDraw(); return; }
    if (mod) return;
    if (e.key === ' ') { if (!spaceDown) { spaceDown = true; stage.classList.add('panning'); } e.preventDefault(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSel(); return; }
    if (e.key === 'Escape') { S.sel.clear(); drag = null; setTool('select'); refreshPanels(); requestDraw(); return; }
    if (e.key.startsWith('Arrow') && S.sel.size) {
      e.preventDefault();
      const st = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
      const d = { ArrowLeft: [-st, 0], ArrowRight: [st, 0], ArrowUp: [0, st], ArrowDown: [0, -st] }[e.key];
      moveSel(d[0], d[1]); updatePropFields(); requestDraw();
      clearTimeout(ACTIONS._nudge); ACTIONS._nudge = setTimeout(commit, 400);
      return;
    }
    const k = e.key.toLowerCase();
    const tools = { v: 'select', r: 'rect', e: 'ellipse', t: 'text', h: 'pan' };
    if (tools[k]) setTool(tools[k]);
    else if (k === 'p') togglePreview();
    else if (k === 'f') fitBed();
  });
  document.addEventListener('keyup', e => { if (e.key === ' ') { spaceDown = false; stage.classList.remove('panning'); } });
  window.addEventListener('blur', () => { spaceDown = false; stage.classList.remove('panning'); });

  window.addEventListener('beforeunload', e => {
    if (grbl.job) { e.preventDefault(); e.returnValue = ''; }
  });
  if (grbl.supported) {
    navigator.serial.addEventListener('disconnect', e => {
      if (grbl.port === e.target || grbl.port === e.port) { toast('Laser unplugged', 'error'); grbl.disconnect(); }
    });
  }

  // ---------------------------------------------------------------- boot
  async function boot() {
    let theme = null;
    try { theme = localStorage.getItem('kerf.theme'); } catch (e) { /* ignore */ }
    if (!theme) theme = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    setTheme(theme);
    $('#serialWarn').hidden = grbl.supported;
    applyMachine();
    syncMachineInputs();
    new ResizeObserver(() => { const first = !view.w; resize(); if (first) fitBed(); }).observe(stage);
    const saved = store.get('kerf.project', null);
    if (saved && saved.layers) {
      try { await loadProject(saved, true); } catch (e) { newProject(); }
    } else newProject();
    updateMachineUI();
    requestDraw();
  }

  K.app = { S, assets, grbl, buildJob, importFile, fitBed };
  boot();
})(window.Kerf);
