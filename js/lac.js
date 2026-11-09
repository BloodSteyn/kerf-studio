/* Kerf Studio — Bambu Suite laser project (.lac) import.
   A .lac file is a ZIP archive: 2D/2dmodel.json holds the scene (groups, SVG-style paths, raster images
   with 2D transforms, Y down, millimetres); Metadata2D/project_settings.json maps objects to processes.
   Bambu power/speed values and the embedded G-code are machine-specific and are deliberately not used. */
window.Kerf = window.Kerf || {};
(function (K) {
  'use strict';
  const G = K.geom;

  // ---------- minimal ZIP reader (stored + deflate, via DecompressionStream)
  function readZip(buf) {
    const dv = new DataView(buf);
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('This .lac file is damaged (no ZIP directory found).');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    if (p === 0xffffffff) throw new Error('Very large (ZIP64) .lac files are not supported yet.');
    const dec = new TextDecoder();
    const entries = new Map();
    for (let k = 0; k < count; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('This .lac file is damaged (bad ZIP entry).');
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const off = dv.getUint32(p + 42, true);
      entries.set(dec.decode(new Uint8Array(buf, p + 46, nlen)), { method, csize, off });
      p += 46 + nlen + xlen + clen;
    }
    async function bytes(name) {
      const e = entries.get(name);
      if (!e) return null;
      const start = e.off + 30 + dv.getUint16(e.off + 26, true) + dv.getUint16(e.off + 28, true);
      const raw = new Uint8Array(buf, start, e.csize);
      if (e.method === 0) return raw;
      if (e.method !== 8) throw new Error(`Unsupported compression in ${name}`);
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    return {
      names: [...entries.keys()],
      bytes,
      async json(name) { const b = await bytes(name); return b ? JSON.parse(new TextDecoder().decode(b)) : null; },
    };
  }

  // ---------- helpers
  const mul = (m, n) => [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
  const parseT = t => {
    const v = String(t || '').trim().split(/\s+/).map(Number);
    return v.length === 6 && v.every(isFinite) ? v : [1, 0, 0, 1, 0, 0];
  };
  const rgbToHex = c => {
    const v = String(c || '').trim().split(/\s+/).map(Number);
    if (v.length < 3 || !v.slice(0, 3).every(isFinite)) return null;
    return '#' + v.slice(0, 3).map(n => Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, '0')).join('');
  };
  const DITHER = { JARVIS: 'jarvis', FLOYD: 'floyd', FLOYD_STEINBERG: 'floyd', STUCKI: 'jarvis', ATKINSON: 'floyd', GRAYSCALE: 'grayscale', THRESHOLD: 'threshold', BINARY: 'threshold' };
  const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', bmp: 'image/bmp', webp: 'image/webp', gif: 'image/gif' };

  const toDataURL = (bytes, type) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(new Blob([bytes], { type }));
  });
  const loadImg = src => new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('Could not decode an image in the project'));
    img.src = src;
  });

  // Bake a rotated / skewed / mirrored image into an axis-aligned bitmap.
  function bakeImage(img, w, h, m) {
    const corners = [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
    const b = G.polysBBox([{ pts: corners }]);
    let k = 1 / Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])); // source pixels per mm
    const maxDim = 4000;
    k = Math.min(k, maxDim / Math.max(b.maxx - b.minx, b.maxy - b.miny));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round((b.maxx - b.minx) * k));
    cv.height = Math.max(1, Math.round((b.maxy - b.miny) * k));
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.setTransform(k * m[0], k * m[1], k * m[2], k * m[3], k * (m[4] - b.minx), k * (m[5] - b.miny));
    ctx.drawImage(img, 0, 0, w, h);
    return { src: cv.toDataURL('image/png'), box: b };
  }

  /**
   * Parse a .lac ArrayBuffer. Returns world-space items (mm, Y up, design-relative):
   * { title, designer, material, items: [{ kind:'path'|'image', process, color, ... }], warnings }
   */
  async function parse(buf) {
    const zip = readZip(buf);
    const model = await zip.json('2D/2dmodel.json');
    if (!model || !Array.isArray(model.canvas_list) || !model.canvas_list.length) {
      throw new Error('No 2D laser design found in this .lac file.');
    }
    const entry = (await zip.json('2D/entry.json').catch(() => null)) || {};
    const settings = (await zip.json('Metadata2D/project_settings.json').catch(() => null)) || {};
    const warnings = [];
    const canvas = model.canvas_list[0];
    if (model.canvas_list.length > 1) warnings.push(`Only the first of ${model.canvas_list.length} canvases was imported.`);

    const objs = new Map((canvas.obj_list || []).map(o => [o.obj_id, o]));
    const procOf = new Map();
    const cs = (settings.canvas_settings || []).find(c => c.index === canvas.index) || (settings.canvas_settings || [])[0];
    for (const s of (cs && cs.object_settings) || []) procOf.set(s.obj_id, s.process_type);
    let material = '';
    try { material = cs.making_batch_list[0].material_name || ''; } catch (e) { /* none */ }

    const items = [];
    const imageJobs = [];
    const skipped = new Map();

    function leaf(o, m, top) {
      const color = rgbToHex(o.color);
      if (typeof o.path_data === 'string') {
        const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
        const polys = G.parsePath(o.path_data, 0.2 / scale).map(p => ({
          closed: p.closed || !!o.is_closed,
          pts: p.pts.map(([x, y]) => [m[0] * x + m[2] * y + m[4], -(m[1] * x + m[3] * y + m[5])]),
        }));
        if (polys.length) items.push({ kind: 'path', process: procOf.get(o.obj_id) || 'LaserLineCut', color, polylines: polys, group: top, name: o.name });
        return;
      }
      if (o.type === 'RasterImage' || o.file_name) {
        const path = '2D/Objects/' + o.file_name;
        if (!o.file_name || !zip.names.includes(path)) { warnings.push(`Image "${o.name || o.obj_id}" is missing from the file.`); return; }
        imageJobs.push({ o, m, path, color, top });
        return;
      }
      skipped.set(o.type || 'unknown', (skipped.get(o.type || 'unknown') || 0) + 1);
    }

    function walk(components, parent, top, depth) {
      if (depth > 64) return;
      for (const c of components || []) {
        const o = objs.get(c.obj_id);
        if (!o) continue;
        const m = mul(parent, parseT(c.transform));
        if (Array.isArray(o.components)) walk(o.components, m, top ?? o.obj_id, depth + 1);
        else leaf(o, m, top ?? o.obj_id);
      }
    }
    walk(canvas.components, [1, 0, 0, 1, 0, 0], null, 0);

    for (const { o, m, path, color, top } of imageJobs) {
      const ext = (path.split('.').pop() || 'png').toLowerCase();
      const src0 = await toDataURL(await zip.bytes(path), MIME[ext] || 'image/png');
      const img = await loadImg(src0);
      const w = o.width || img.naturalWidth, h = o.height || img.naturalHeight;
      const axisAligned = Math.abs(m[1]) < 1e-6 && Math.abs(m[2]) < 1e-6 && m[0] > 0 && m[3] > 0;
      let src = src0, box;
      if (axisAligned) box = { minx: m[4], miny: m[5], maxx: m[4] + w * m[0], maxy: m[5] + h * m[3] };
      else ({ src, box } = bakeImage(img, w, h, m));
      const mode = (o.image_settings && o.image_settings.img_mode) || '';
      items.push({
        kind: 'image', process: procOf.get(o.obj_id) || 'LaserImageEngrave', color, src, group: top, name: o.name,
        x: box.minx, y: -box.maxy, w: box.maxx - box.minx, h: box.maxy - box.miny,
        dither: DITHER[String(mode).toUpperCase()] || 'jarvis',
      });
    }
    for (const [t, n] of skipped) warnings.push(`${n} unsupported object(s) of type "${t}" were skipped.`);
    if (!items.length) throw new Error('This .lac file has no laser shapes or images that Kerf Studio can read.');

    return { title: entry.Title || '', designer: entry.Designer || '', license: entry.LicenseTerms || '', material, items, warnings };
  }

  K.lac = { parse, readZip };
})(window.Kerf);
