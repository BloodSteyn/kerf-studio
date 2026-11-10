# Machine Profiles and Homing Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Kerf Studio drive more than one laser, starting with an Atomstack A5 whose work area does not begin at machine zero, without breaking the Ortur it currently supports.

**Architecture:** A new `js/machines.js` module owns machine identity and a coordinate transform. Profiles carry an `originOffset` — the machine coordinate of the front-left of the work area — measured from the machine rather than inferred from firmware. The offset is applied at exactly two boundaries: `Writer._xy()` when emitting G-code, and a `headPos()` helper when reading position. A `$$` query on connect reconciles the controller's real settings against the profile.

**Tech Stack:** Vanilla ES2020 browser JavaScript, no build step, no dependencies. `window.Kerf` namespace with IIFE modules. Tests run under Node 24's built-in `node --test` by shimming `globalThis.window`.

**Spec:** `docs/superpowers/specs/2026-11-10-machine-profiles-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `js/machines.js` (create) | Profile definitions, persistence, migration, coordinate transform. Pure — no DOM, no serial. |
| `tests/machines.test.js` (create) | Unit tests for the above. |
| `tests/gcode-offset.test.js` (create) | Offset behaviour and the byte-identical regression guard. |
| `tests/helpers/load.js` (create) | Shared Node shim that loads the browser IIFE modules. |
| `js/gcode.js` (modify) | Accept `offset` in options; apply in `Writer._xy()` and `frame()`. |
| `js/grbl.js` (modify) | Send `$$` on connect, collect into `this.settings`, emit `settings` event. |
| `js/app.js` (modify) | Active profile wiring, `headPos()`, picker, reconcile dialog, settings dialog. |
| `index.html` (modify) | Script tag, machine picker markup, reconcile dialog, settings dialog fields. |
| `css/app.css` (modify) | Styles for picker and reconcile dialog. |
| `docs/hardware-checklist-atomstack-a5.md` (create) | The hardware bring-up sequence. |
| `README.md` (modify) | Document multi-machine support. |

`js/app.js` is already 1441 lines and does too much. This plan does **not** restructure it — that is unrelated scope — but all new pure logic goes in `js/machines.js` rather than growing `app.js` further.

---

## Task 1: Test harness and profile model

**Files:**
- Create: `tests/helpers/load.js`
- Create: `js/machines.js`
- Create: `tests/machines.test.js`

- [ ] **Step 1: Write the module loader helper**

Create `tests/helpers/load.js`:

```js
/* Loads Kerf's browser IIFE modules under Node by shimming `window`. */
const path = require('path');

function loadKerf(...files) {
  globalThis.window = globalThis;
  globalThis.window.Kerf = {};
  const root = path.join(__dirname, '..', '..');
  for (const f of files) {
    delete require.cache[require.resolve(path.join(root, f))];
    require(path.join(root, f));
  }
  return globalThis.window.Kerf;
}

module.exports = { loadKerf };
```

- [ ] **Step 2: Write the failing test**

Create `tests/machines.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { loadKerf } = require('./helpers/load');

const K = () => loadKerf('js/machines.js');

test('ships built-in profiles for both machines', () => {
  const M = K().machines;
  const ids = M.BUILTIN.map(p => p.id);
  assert.ok(ids.includes('ortur-lm2pro'));
  assert.ok(ids.includes('atomstack-a5'));
});

test('Ortur profile has a zero origin offset', () => {
  const M = K().machines;
  const ortur = M.BUILTIN.find(p => p.id === 'ortur-lm2pro');
  assert.deepStrictEqual(ortur.originOffset, { x: 0, y: 0 });
  assert.strictEqual(ortur.bedW, 400);
  assert.strictEqual(ortur.bedH, 430);
});

test('A5 profile expects homing enabled and seeking negative', () => {
  const M = K().machines;
  const a5 = M.BUILTIN.find(p => p.id === 'atomstack-a5');
  assert.strictEqual(a5.expect[22], 1);
  assert.strictEqual(a5.expect[23], 3);
  assert.strictEqual(a5.suggest[21], 1, 'hard limits are a suggestion, never expected');
  assert.strictEqual(a5.expect[21], undefined);
});

test('normalize fills in defaults and coerces types', () => {
  const M = K().machines;
  const p = M.normalize({ id: 'x', name: 'X', bedW: '300' });
  assert.strictEqual(p.bedW, 300);
  assert.strictEqual(p.bedH, 400);
  assert.deepStrictEqual(p.originOffset, { x: 0, y: 0 });
  assert.strictEqual(p.hasHoming, true);
});

test('normalize rejects non-finite numbers rather than propagating NaN', () => {
  const M = K().machines;
  const p = M.normalize({ id: 'x', name: 'X', bedW: 'banana', maxS: NaN });
  assert.strictEqual(p.bedW, 400);
  assert.strictEqual(p.maxS, 1000);
});

test('toMachine and fromMachine are inverses', () => {
  const M = K().machines;
  const p = M.normalize({ id: 'a', name: 'A', originOffset: { x: -410, y: -400 } });
  const m = M.toMachine(p, 10, 20);
  assert.deepStrictEqual(m, { x: -400, y: -380 });
  assert.deepStrictEqual(M.fromMachine(p, m.x, m.y), { x: 10, y: 20 });
});

test('offsetFor is zero when the job starts from the current position', () => {
  const M = K().machines;
  const p = M.normalize({ id: 'a', name: 'A', originOffset: { x: -410, y: -400 } });
  assert.deepStrictEqual(M.offsetFor(p, 'absolute'), { x: -410, y: -400 });
  assert.deepStrictEqual(M.offsetFor(p, 'current'), { x: 0, y: 0 });
});

test('calibrate captures the machine position verbatim', () => {
  const M = K().machines;
  const p = M.normalize({ id: 'a', name: 'A' });
  assert.deepStrictEqual(M.calibrate(p, [-410, -400, 0]), { x: -410, y: -400 });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test tests/`
Expected: FAIL — `Cannot find module '.../js/machines.js'`

- [ ] **Step 4: Write the implementation**

Create `js/machines.js`:

```js
/* Kerf Studio — machine profiles: what laser is plugged in, and where its work area sits.

   originOffset is the machine coordinate of the FRONT-LEFT corner of the work area.
   It is 0,0 on firmware that forces the origin at home (Ortur and most laser vendors),
   and -bedW,-bedH on stock GRBL, whose envelope runs negative from the max corner.
   It is measured from the machine, never inferred from the firmware build. */
window.Kerf = window.Kerf || {};
(function (K) {
  'use strict';

  const num = (v, d) => (Number.isFinite(+v) && v !== '' && v !== null ? +v : d);

  const BUILTIN = [
    {
      id: 'ortur-lm2pro',
      name: 'Ortur Laser Master 2 Pro',
      bedW: 400, bedH: 430, maxS: 1000, baud: 115200,
      rapid: 6000, accel: 2500,
      originOffset: { x: 0, y: 0 },
      hasHoming: true,
      expect: {}, suggest: {},
      builtin: true,
    },
    {
      id: 'atomstack-a5',
      name: 'Atomstack A5',
      bedW: 410, bedH: 400, maxS: 1000, baud: 115200,
      rapid: 6000, accel: 2500,
      originOffset: { x: 0, y: 0 },
      hasHoming: true,
      // Required for homing to work at all on a front-left endstop retrofit.
      expect: { 22: 1, 23: 3 },
      // Offered unticked: hard limits can nuisance-trip on unshielded retrofit
      // wiring, and soft limits are only safe once $130/$131 are known good.
      suggest: { 20: 1, 21: 1 },
      builtin: true,
    },
  ];

  function normalize(p) {
    const o = (p && p.originOffset) || {};
    return {
      id: String((p && p.id) || 'machine'),
      name: String((p && p.name) || 'Machine'),
      bedW: num(p && p.bedW, 400),
      bedH: num(p && p.bedH, 400),
      maxS: num(p && p.maxS, 1000),
      baud: num(p && p.baud, 115200),
      rapid: num(p && p.rapid, 6000),
      accel: num(p && p.accel, 2500),
      originOffset: { x: num(o.x, 0), y: num(o.y, 0) },
      hasHoming: !(p && p.hasHoming === false),
      expect: (p && p.expect) || {},
      suggest: (p && p.suggest) || {},
      builtin: !!(p && p.builtin),
    };
  }

  // Design space -> machine space.
  function toMachine(profile, x, y) {
    const o = profile.originOffset;
    return { x: x + o.x, y: y + o.y };
  }

  // Machine space -> design space.
  function fromMachine(profile, mx, my) {
    const o = profile.originOffset;
    return { x: mx - o.x, y: my - o.y };
  }

  // Jobs that start from the current head position are emitted relative to a
  // G92 zero set wherever the head already is, so the machine offset must not
  // be added on top -- doing so would displace the job by the width of the bed.
  function offsetFor(profile, origin) {
    return origin === 'current' ? { x: 0, y: 0 } : { ...profile.originOffset };
  }

  // The operator homes, jogs to the corner they want as design origin, and
  // clicks. Capturing MPos verbatim works on any firmware and any homing corner.
  function calibrate(profile, mpos) {
    return { x: num(mpos && mpos[0], 0), y: num(mpos && mpos[1], 0) };
  }

  K.machines = { BUILTIN, normalize, toMachine, fromMachine, offsetFor, calibrate };
})(window.Kerf);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add js/machines.js tests/
git commit -m "Add machine profile model and coordinate transform"
```

---

## Task 2: Profile persistence and migration

**Files:**
- Modify: `js/machines.js`
- Modify: `tests/machines.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/machines.test.js`:

```js
function fakeStore(initial = {}) {
  const data = { ...initial };
  return {
    data,
    get(k, d) { return k in data ? data[k] : d; },
    set(k, v) { data[k] = v; return true; },
  };
}

test('list returns built-ins when nothing is stored', () => {
  const M = K().machines;
  const list = M.list(fakeStore());
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].id, 'ortur-lm2pro');
});

test('user profiles are appended to the built-ins', () => {
  const M = K().machines;
  const s = fakeStore();
  M.save(s, { id: 'custom-1', name: 'Shop laser', bedW: 600, bedH: 600 });
  const list = M.list(s);
  assert.strictEqual(list.length, 3);
  assert.strictEqual(list[2].name, 'Shop laser');
  assert.strictEqual(list[2].bedW, 600);
  assert.strictEqual(list[2].builtin, false);
});

test('saving over a built-in id stores an override, not a duplicate', () => {
  const M = K().machines;
  const s = fakeStore();
  M.save(s, { ...M.BUILTIN[0], originOffset: { x: -5, y: -5 } });
  const list = M.list(s);
  assert.strictEqual(list.length, 2, 'still two machines');
  const ortur = list.find(p => p.id === 'ortur-lm2pro');
  assert.deepStrictEqual(ortur.originOffset, { x: -5, y: -5 });
  assert.strictEqual(ortur.builtin, true, 'stays marked built-in');
});

test('remove deletes a user profile and restores an overridden built-in', () => {
  const M = K().machines;
  const s = fakeStore();
  M.save(s, { id: 'custom-1', name: 'Shop laser' });
  M.save(s, { ...M.BUILTIN[0], bedW: 123 });
  M.remove(s, 'custom-1');
  M.remove(s, 'ortur-lm2pro');
  const list = M.list(s);
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list.find(p => p.id === 'ortur-lm2pro').bedW, 400);
});

test('active defaults to the first profile and persists', () => {
  const M = K().machines;
  const s = fakeStore();
  assert.strictEqual(M.active(s).id, 'ortur-lm2pro');
  M.setActive(s, 'atomstack-a5');
  assert.strictEqual(M.active(s).id, 'atomstack-a5');
  assert.strictEqual(s.data['kerf.machine'], 'atomstack-a5');
});

test('active falls back to the first profile if the stored id is gone', () => {
  const M = K().machines;
  const s = fakeStore({ 'kerf.machine': 'deleted-machine' });
  assert.strictEqual(M.active(s).id, 'ortur-lm2pro');
});

test('legacy settings migrate into the Ortur profile exactly once', () => {
  const M = K().machines;
  const s = fakeStore({ 'kerf.settings': { bedW: 390, bedH: 420, maxS: 255, jogFeed: 2000 } });
  M.migrate(s);
  const ortur = M.active(s);
  assert.strictEqual(ortur.id, 'ortur-lm2pro');
  assert.strictEqual(ortur.bedW, 390, 'adopted the stored work area');
  assert.strictEqual(ortur.maxS, 255);
  assert.strictEqual(s.data['kerf.settings'].jogFeed, 2000, 'preferences left alone');

  // A second run must not clobber a profile the user has since edited.
  M.save(s, { ...ortur, bedW: 377 });
  M.migrate(s);
  assert.strictEqual(M.active(s).bedW, 377);
});

test('migrate is a no-op with no legacy settings', () => {
  const M = K().machines;
  const s = fakeStore();
  M.migrate(s);
  assert.strictEqual(M.active(s).bedW, 400);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/`
Expected: FAIL — `M.list is not a function`

- [ ] **Step 3: Implement persistence**

In `js/machines.js`, add before the `K.machines = ...` line:

```js
  const KEY_PROFILES = 'kerf.machines';
  const KEY_ACTIVE = 'kerf.machine';
  const KEY_LEGACY = 'kerf.settings';
  const KEY_MIGRATED = 'kerf.machinesMigrated';

  // Fields a stored override may carry. Anything else (expect, suggest, builtin)
  // always comes from code, so shipping a corrected default reaches existing users.
  const OVERRIDE_FIELDS = ['name', 'bedW', 'bedH', 'maxS', 'baud', 'rapid', 'accel', 'originOffset', 'hasHoming'];

  function stored(store) {
    const v = store.get(KEY_PROFILES, []);
    return Array.isArray(v) ? v : [];
  }

  function list(store) {
    const saved = stored(store);
    const out = BUILTIN.map(b => {
      const o = saved.find(p => p && p.id === b.id);
      if (!o) return normalize(b);
      const merged = { ...b };
      for (const f of OVERRIDE_FIELDS) if (f in o) merged[f] = o[f];
      return normalize(merged);
    });
    for (const p of saved) {
      if (!BUILTIN.some(b => b.id === p.id)) out.push(normalize({ ...p, builtin: false }));
    }
    return out;
  }

  function get(store, id) {
    return list(store).find(p => p.id === id) || null;
  }

  function save(store, profile) {
    const p = normalize(profile);
    const saved = stored(store).filter(x => x && x.id !== p.id);
    const row = { id: p.id };
    for (const f of OVERRIDE_FIELDS) row[f] = p[f];
    saved.push(row);
    store.set(KEY_PROFILES, saved);
    return p;
  }

  function remove(store, id) {
    store.set(KEY_PROFILES, stored(store).filter(x => x && x.id !== id));
    if (store.get(KEY_ACTIVE, null) === id && !BUILTIN.some(b => b.id === id)) {
      store.set(KEY_ACTIVE, BUILTIN[0].id);
    }
  }

  function active(store) {
    const all = list(store);
    return all.find(p => p.id === store.get(KEY_ACTIVE, null)) || all[0];
  }

  function setActive(store, id) {
    store.set(KEY_ACTIVE, id);
    return active(store);
  }

  // One-time adoption of the pre-profiles settings blob into the Ortur profile,
  // so an existing install sees no change. Machine facts move; preferences stay.
  function migrate(store) {
    if (store.get(KEY_MIGRATED, false)) return;
    store.set(KEY_MIGRATED, true);
    const legacy = store.get(KEY_LEGACY, null);
    if (!legacy || typeof legacy !== 'object') return;
    const base = BUILTIN[0];
    const merged = { ...base };
    for (const f of ['bedW', 'bedH', 'maxS', 'baud', 'rapid', 'accel']) {
      if (legacy[f] !== undefined) merged[f] = legacy[f];
    }
    save(store, merged);
    if (store.get(KEY_ACTIVE, null) === null) store.set(KEY_ACTIVE, base.id);
  }

  function newId(store) {
    const taken = new Set(list(store).map(p => p.id));
    let n = 1;
    while (taken.has('custom-' + n)) n++;
    return 'custom-' + n;
  }
```

Then change the export line to:

```js
  K.machines = {
    BUILTIN, normalize, toMachine, fromMachine, offsetFor, calibrate,
    list, get, save, remove, active, setActive, migrate, newId,
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/`
Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git add js/machines.js tests/machines.test.js
git commit -m "Add machine profile persistence and legacy settings migration"
```

---

## Task 3: Apply the offset in G-code generation

**Files:**
- Modify: `js/gcode.js`
- Create: `tests/gcode-offset.test.js`

The `Writer` already subtracts a per-job origin in `_xy()` to support "start from current position". The machine offset folds into that same subtraction. A separate mechanism would be a second place to get it wrong.

- [ ] **Step 1: Write the failing tests**

Create `tests/gcode-offset.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { loadKerf } = require('./helpers/load');

const load = () => loadKerf('js/geometry.js', 'js/gcode.js', 'js/machines.js');

function rectProject() {
  return {
    layers: [{ id: 'L1', name: 'Cut', mode: 'line', color: '#000', output: true,
               speed: 600, power: 50, minPower: 0, passes: 1, interval: 0.1 }],
    objects: [{ id: 'o1', type: 'rect', layer: 'L1', x: 10, y: 20, w: 30, h: 40, rot: 0 }],
  };
}

const baseOpt = {
  maxS: 1000, rapid: 6000, accel: 2500, overscan: 2.5,
  origin: 'absolute', returnHome: true, machineName: 'Test',
};

test('zero offset emits exactly what it did before offsets existed', () => {
  const K = load();
  const withNone = K.gcode.generate(rectProject(), () => null, baseOpt);
  const withZero = K.gcode.generate(rectProject(), () => null, { ...baseOpt, offset: { x: 0, y: 0 } });
  assert.strictEqual(withZero.lines.join('\n'), withNone.lines.join('\n'));
});

test('a negative offset shifts every absolute coordinate', () => {
  const K = load();
  const shifted = K.gcode.generate(rectProject(), () => null, {
    ...baseOpt, offset: { x: -410, y: -400 },
  });
  const moves = shifted.lines.filter(l => /^G[01]/.test(l));
  assert.ok(moves.length > 0, 'produced some moves');
  for (const line of moves) {
    const mx = /X(-?[\d.]+)/.exec(line);
    const my = /Y(-?[\d.]+)/.exec(line);
    if (mx) assert.ok(+mx[1] < 0, `X should be negative, got ${line}`);
    if (my) assert.ok(+my[1] < 0, `Y should be negative, got ${line}`);
  }
  // Rect spans X 10..40 in design space, so X -400..-370 in machine space.
  assert.ok(shifted.lines.some(l => /X-400\b/.test(l)), 'left edge landed at -400');
  assert.ok(shifted.lines.some(l => /X-370\b/.test(l)), 'right edge landed at -370');
});

test('offset is ignored when the job starts from the current position', () => {
  const K = load();
  const a = K.gcode.generate(rectProject(), () => null, { ...baseOpt, origin: 'current' });
  const b = K.gcode.generate(rectProject(), () => null, {
    ...baseOpt, origin: 'current', offset: { x: -410, y: -400 },
  });
  assert.strictEqual(b.lines.join('\n'), a.lines.join('\n'),
    'relative jobs must not be shifted by the machine offset');
});

test('frame offsets absolute moves but leaves relative ones alone', () => {
  const K = load();
  const b = { minx: 10, miny: 20, maxx: 40, maxy: 60 };
  const abs = K.gcode.frame(b, { ...baseOpt, offset: { x: -410, y: -400 } });
  assert.ok(abs.some(l => /G0 X-400 Y-380/.test(l)), 'absolute frame starts at the offset corner');

  const rel = K.gcode.frame(b, { ...baseOpt, origin: 'current', offset: { x: -410, y: -400 } });
  assert.ok(rel.includes('G91'), 'relative frame still relative');
  assert.ok(rel.some(l => /X30\b/.test(l)), 'relative frame uses plain width');
  assert.ok(!rel.some(l => /-40[0-9]/.test(l)), 'relative frame carries no machine coordinates');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/gcode-offset.test.js`
Expected: FAIL on the negative-offset test — coordinates are still positive.

- [ ] **Step 3: Thread the offset through the Writer**

In `js/gcode.js`, in the `Writer` constructor (around line 20), after `this.ox = o.ox; this.oy = o.oy;` add:

```js
      this.mx = (o.offset && o.offset.x) || 0;   // machine origin offset
      this.my = (o.offset && o.offset.y) || 0;
```

Change `_xy()` to add the machine offset to the already-subtracted job origin:

```js
    _xy(x, y) {
      const fx = fmt(x - this.ox + this.mx), fy = fmt(y - this.oy + this.my);
      let s = '';
      if (fx !== this.lx) s += ' X' + fx;
      if (fy !== this.ly) s += ' Y' + fy;
      this.lx = fx; this.ly = fy;
      return s;
    }
```

- [ ] **Step 4: Pass the offset into the Writer from `generate()`**

In `generate()`, the `Writer` is constructed around line 205. The offset must be suppressed in `current` mode. Replace the construction:

```js
    const offset = current ? { x: 0, y: 0 } : { x: (opt.offset && opt.offset.x) || 0, y: (opt.offset && opt.offset.y) || 0 };
    const w = new Writer({ ox, oy, offset, rapid: opt.rapid || 6000, accel: opt.accel || 2500, maxS: opt.maxS || 1000 });
```

In the same function, the `current` branch seeds the writer's last-emitted strings:

```js
    if (current) { w.lx = '0'; w.ly = '0'; w.x = ox; w.y = oy; w.known = true; }
```

That stays correct, because `offset` is zero in that branch.

- [ ] **Step 5: Offset the absolute branch of `frame()`**

Replace `frame()` (around line 257):

```js
  function frame(b, opt) {
    const F = opt.frameSpeed || 3000;
    const laser = opt.frameLaser ? [`M3 S${Math.round(((opt.framePower || 1) / 100) * (opt.maxS || 1000))}`] : ['M5 S0'];
    const w = b.maxx - b.minx, h = b.maxy - b.miny;
    if (opt.origin === 'current') {
      // Relative: no machine offset applies.
      return ['G21', 'G91', ...laser, `G1 X${fmt(w)} F${F}`, `G1 Y${fmt(h)}`, `G1 X${fmt(-w)}`, `G1 Y${fmt(-h)}`, 'M5 S0', 'G90'];
    }
    const ox = (opt.offset && opt.offset.x) || 0, oy = (opt.offset && opt.offset.y) || 0;
    const x0 = fmt(b.minx + ox), x1 = fmt(b.maxx + ox);
    const y0 = fmt(b.miny + oy), y1 = fmt(b.maxy + oy);
    return ['G21', 'G90', 'M5 S0', `G0 X${x0} Y${y0}`, ...laser,
      `G1 X${x1} F${F}`, `G1 Y${y1}`, `G1 X${x0}`, `G1 Y${y0}`, 'M5 S0'];
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/`
Expected: PASS, 20 tests. The byte-identical test is the one that proves the Ortur is untouched.

- [ ] **Step 7: Commit**

```bash
git add js/gcode.js tests/gcode-offset.test.js
git commit -m "Apply machine origin offset when emitting G-code"
```

---

## Task 4: Wire the active profile into the app

**Files:**
- Modify: `index.html:319-324` (script tag)
- Modify: `js/app.js`

- [ ] **Step 1: Load the module**

In `index.html`, add before the `geometry.js` tag so `K.machines` exists when `app.js` runs:

```html
<script src="js/machines.js"></script>
```

- [ ] **Step 2: Replace the settings model with profile plus preferences**

In `js/app.js`, `DEFAULT_SETTINGS` (line 37) currently mixes machine facts with preferences. Narrow it to preferences only:

```js
  const DEFAULT_SETTINGS = {
    overscan: 2.5,
    frameSpeed: 3000, frameLaser: false, framePower: 1,
    jobOrigin: 'absolute', returnHome: true, jogFeed: 3000, jogStep: 10, lockAspect: true,
  };
```

Below the `S` declaration (line 44), add the profile state and a compatibility accessor:

```js
  const MA = K.machines;
  MA.migrate(store);
  S.machine = MA.active(store);

  // Machine facts read through the active profile. Keeping the old `S.settings.bedW`
  // call sites working would mean two sources of truth, so they move here instead.
  const bedW = () => S.machine.bedW;
  const bedH = () => S.machine.bedH;

  function setMachine(id) {
    S.machine = MA.setActive(store, id);
    applyMachine();
  }
  function saveMachine(patch) {
    S.machine = MA.save(store, { ...S.machine, ...patch });
    applyMachine();
  }
  function applyMachine() {
    $('#machineTag').textContent = S.machine.name;
    $('#btnHome').hidden = !S.machine.hasHoming;
    invalidatePreview();
    fitBed();
    requestDraw();
  }
```

- [ ] **Step 3: Replace every `S.settings.bedW` / `S.settings.bedH` reference**

These are at lines 207, 224, 241, 664, 880, 992, 1002, 1003, 1027, 1031, 1056. Replace `S.settings.bedW` with `bedW()` and `S.settings.bedH` with `bedH()` throughout. For the destructuring sites (207, 241) use:

```js
    const bedWv = bedW(), bedHv = bedH();
```

and rename the local uses accordingly, or simpler, keep the destructure shape:

```js
    const { bedW: bedWv, bedH: bedHv } = S.machine;
```

Verify none remain:

```bash
grep -n "settings.bedW\|settings.bedH\|settings.maxS\|settings.baud\|settings.rapid\|settings.accel" js/app.js
```

Expected: no output.

- [ ] **Step 4: Feed the profile into `jobOptions()`**

Replace `jobOptions()` (line 847):

```js
  function jobOptions() {
    const s = S.settings, m = S.machine;
    return {
      maxS: m.maxS, rapid: m.rapid, accel: m.accel, overscan: s.overscan,
      origin: s.jobOrigin, returnHome: s.returnHome,
      machineName: `${m.name} (GRBL 1.1)`,
      offset: MA.offsetFor(m, s.jobOrigin),
      frameSpeed: s.frameSpeed, frameLaser: s.frameLaser, framePower: s.framePower,
    };
  }
```

- [ ] **Step 5: Add `headPos()` and use it for every position readout**

Add near the other helpers:

```js
  // Machine position in design space. The canvas, readout and status bar all
  // show where the head is on the bed, not its raw machine coordinate.
  function headPos() {
    const m = grbl.status.mpos;
    return MA.fromMachine(S.machine, m[0] || 0, m[1] || 0);
  }
```

At line 309 (canvas head marker) replace:

```js
      const p = headPos();
      const [hx, hy] = w2s(p.x, p.y);
```

At lines 1103-1106 replace:

```js
        const p = headPos();
        $('#posX').textContent = f2(p.x);
        $('#posY').textContent = f2(p.y);
        ...
        $('#sbMachine').textContent = `${label} · X ${f2(p.x)} Y ${f2(p.y)}`;
```

- [ ] **Step 6: Offset `goOrigin` and use the profile baud on connect**

In `ACTIONS`, replace `goOrigin`:

```js
    goOrigin: () => {
      if (!requireIdle('move')) return;
      const o = S.machine.originOffset;
      grbl.send(`G90 G0 X${GC.fmt(o.x)} Y${GC.fmt(o.y)}`);
    },
```

In `toggleConnect()` replace `await grbl.connect(+S.settings.baud);` with:

```js
      await grbl.connect(+S.machine.baud);
```

- [ ] **Step 7: Make the Bambu import presets per-profile**

At line 1001 the toast names Ortur. Replace the hardcoded string:

```js
    toast(`Bambu power and speed settings were replaced with ${S.machine.name} starting values. Test on scrap first.`, 'warn', 9000);
```

And at line 946, change the comment to read `// Bambu Suite processes -> Kerf layers with conservative starting values for the active machine.`

- [ ] **Step 8: Verify in the browser**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File Start-KerfStudio.ps1`
Open `http://localhost:8787`. Expected: app loads with no console errors, the badge reads `Ortur Laser Master 2 Pro`, the bed is 400×430, and drawing a rectangle then exporting G-code produces the same coordinates as before.

- [ ] **Step 9: Commit**

```bash
git add index.html js/app.js
git commit -m "Read machine facts from the active profile"
```

---

## Task 5: Machine picker UI

**Files:**
- Modify: `index.html:60`
- Modify: `js/app.js`
- Modify: `css/app.css`

- [ ] **Step 1: Replace the static badge**

In `index.html`, replace line 60:

```html
      <select class="machine-tag" id="machineTag" title="Active machine"></select>
```

- [ ] **Step 2: Populate and wire it**

In `js/app.js`, replace the `applyMachine()` body written in Task 4 with one that also rebuilds the list:

```js
  function applyMachine() {
    const sel = $('#machineTag');
    const all = MA.list(store);
    sel.innerHTML = all.map(p => `<option value="${esc(p.id)}"${p.id === S.machine.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')
      + '<option value="__add">Add machine…</option><option value="__dup">Duplicate current…</option>';
    $('#btnHome').hidden = !S.machine.hasHoming;
    invalidatePreview();
    fitBed();
    requestDraw();
  }

  $('#machineTag').addEventListener('change', async e => {
    const v = e.target.value;
    if (v === '__add' || v === '__dup') {
      const base = v === '__dup' ? S.machine : MA.normalize({ id: '', name: '' });
      const name = prompt('Name for the new machine', v === '__dup' ? S.machine.name + ' copy' : 'My laser');
      if (!name) { applyMachine(); return; }
      const p = MA.save(store, { ...base, id: MA.newId(store), name, builtin: false });
      setMachine(p.id);
      openSettings();
      return;
    }
    setMachine(v);
    toast(`Switched to ${S.machine.name}`, 'info');
  });
```

- [ ] **Step 3: Style the select to match the old badge**

In `css/app.css`, find the `.machine-tag` rule and add:

```css
.machine-tag {
  appearance: none;
  border: 1px solid var(--line);
  background: var(--panel);
  color: inherit;
  font: inherit;
  padding: 2px 8px;
  border-radius: 6px;
  cursor: pointer;
}
```

- [ ] **Step 4: Verify in the browser**

Reload `http://localhost:8787`. Expected: the picker lists both machines. Selecting **Atomstack A5** redraws the bed to 410×400 and the status bar updates. Reloading the page keeps the A5 selected.

- [ ] **Step 5: Commit**

```bash
git add index.html js/app.js css/app.css
git commit -m "Add machine picker to the header"
```

---

## Task 6: Query controller settings on connect

**Files:**
- Modify: `js/grbl.js`
- Create: `tests/grbl-settings.test.js`

`grbl.js:180` already emits a `setting` event per `$N=v` line. Nothing sends `$$` or keeps the result.

- [ ] **Step 1: Write the failing test**

Create `tests/grbl-settings.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { loadKerf } = require('./helpers/load');

function makeGrbl() {
  globalThis.navigator = globalThis.navigator || {};
  const K = loadKerf('js/geometry.js', 'js/gcode.js', 'js/grbl.js');
  const g = new K.Grbl();
  g.connected = true;
  g.sent = [];
  g._write = str => { g.sent.push(str); return Promise.resolve(); };
  return g;
}

test('a $$ dump is collected into a settings map', () => {
  const g = makeGrbl();
  g.send('$$');
  ['$0=10', '$22=1', '$23=3', '$130=410.000', '$131=400.000'].forEach(l => g._onLine(l));
  g._onLine('ok');
  assert.strictEqual(g.settings[22], 1);
  assert.strictEqual(g.settings[23], 3);
  assert.strictEqual(g.settings[130], 410);
});

test('malformed setting lines are ignored rather than stored as NaN', () => {
  const g = makeGrbl();
  g.send('$$');
  ['$0=10', '$notanumber', '$12=', 'random text'].forEach(l => g._onLine(l));
  g._onLine('ok');
  assert.strictEqual(g.settings[0], 10);
  assert.ok(!Object.values(g.settings).some(Number.isNaN), 'no NaN stored');
});

test('querySettings resolves with the map once ok arrives', async () => {
  const g = makeGrbl();
  const p = g.querySettings();
  assert.ok(g.sent.some(s => s.startsWith('$$')), 'sent the dump request');
  ['$22=1', '$23=3'].forEach(l => g._onLine(l));
  g._onLine('ok');
  const map = await p;
  assert.strictEqual(map[23], 3);
});

test('querySettings rejects if the controller never answers', async () => {
  const g = makeGrbl();
  await assert.rejects(() => g.querySettings(50), /timed out/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/grbl-settings.test.js`
Expected: FAIL — `g.settings` is undefined.

- [ ] **Step 3: Store the settings**

In `js/grbl.js`, in the constructor after `this.status = {...}` add:

```js
      this.settings = {};          // $N -> number, filled by querySettings()
```

In `_onLine()`, replace the `$N=` branch:

```js
      const m = /^\$(\d+)=([-\d.]+)\s*$/.exec(line);
      if (m) {
        const key = +m[1], value = parseFloat(m[2]);
        if (Number.isFinite(value)) {
          this.settings[key] = value;
          this._emit('setting', { key, value });
        }
      }
      this._log('rx', line);
```

- [ ] **Step 4: Add `querySettings()`**

Add to the `Grbl` class, beside the other high-level methods:

```js
    // Ask the controller for its full $ dump. Resolves with the settings map.
    querySettings(timeoutMs = 3000) {
      if (!this.connected) return Promise.reject(new Error('Not connected'));
      this.settings = {};
      return new Promise((resolve, reject) => {
        const done = () => { this.removeEventListener('log', onLog); clearTimeout(timer); };
        const timer = setTimeout(() => { done(); reject(new Error('$$ query timed out')); }, timeoutMs);
        const onLog = e => {
          if (e.detail.type === 'ok' || e.detail.text === 'ok') { done(); resolve(this.settings); }
        };
        this.addEventListener('log', onLog);
        this.send('$$', 'user');
      });
    }
```

Note the existing `_onLine()` logs `ok` only when `it.src === 'user'`, which is why `$$` is sent with the `user` source.

- [ ] **Step 5: Query on connect**

In `connect()`, after `this._emit('connected');` add:

```js
      try {
        await this.querySettings();
        this._emit('settings', this.settings);
      } catch (e) {
        this._log('warn', 'Controller did not answer $$ — settings not read');
      }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/`
Expected: PASS, 24 tests.

- [ ] **Step 7: Commit**

```bash
git add js/grbl.js tests/grbl-settings.test.js
git commit -m "Read the controller settings dump on connect"
```

---

## Task 7: Reconcile dialog

**Files:**
- Modify: `index.html` (new dialog)
- Modify: `js/app.js`
- Modify: `js/machines.js`
- Modify: `tests/machines.test.js`

- [ ] **Step 1: Write the failing test for the diff**

Append to `tests/machines.test.js`:

```js
test('diff reports expected mismatches as required and suggestions as optional', () => {
  const M = K().machines;
  const a5 = M.BUILTIN.find(p => p.id === 'atomstack-a5');
  const rows = M.diff(a5, { 22: 0, 23: 0, 20: 0, 21: 0, 130: 410 });
  const byKey = Object.fromEntries(rows.map(r => [r.key, r]));
  assert.strictEqual(byKey[22].required, true);
  assert.strictEqual(byKey[22].machine, 0);
  assert.strictEqual(byKey[22].want, 1);
  assert.strictEqual(byKey[21].required, false);
  assert.ok(byKey[21].risk, 'hard limits carry a stated risk');
});

test('diff omits values that already match', () => {
  const M = K().machines;
  const a5 = M.BUILTIN.find(p => p.id === 'atomstack-a5');
  const rows = M.diff(a5, { 22: 1, 23: 3, 20: 1, 21: 1 });
  assert.strictEqual(rows.length, 0);
});

test('diff never proposes writing steps-per-mm', () => {
  const M = K().machines;
  const p = M.normalize({ id: 'x', name: 'X', expect: { 100: 80, 22: 1 } });
  const rows = M.diff(p, { 100: 79.5, 22: 0 });
  assert.ok(!rows.some(r => r.key === 100), 'calibration values are excluded');
  assert.ok(rows.some(r => r.key === 22));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/machines.test.js`
Expected: FAIL — `M.diff is not a function`

- [ ] **Step 3: Implement `diff()`**

In `js/machines.js` add:

```js
  // GRBL settings, named so the reconcile dialog can explain itself.
  const SETTING_NAMES = {
    20: 'Soft limits', 21: 'Hard limits', 22: 'Homing cycle', 23: 'Homing direction mask',
    24: 'Homing feed', 25: 'Homing seek', 26: 'Homing debounce', 27: 'Homing pull-off',
    30: 'Max spindle value', 31: 'Min spindle value', 32: 'Laser mode',
    130: 'X max travel', 131: 'Y max travel',
  };

  const RISK = {
    21: 'Hard limits will halt a job if the switch wiring picks up interference from the stepper cables.',
    20: 'Soft limits only protect you if the work area values below are accurate.',
  };

  // Steps-per-mm is calibration, not configuration. Rewriting it silently
  // destroys dimensional accuracy, so it is never offered.
  const NEVER_WRITE = new Set([100, 101, 102]);

  function diff(profile, machineSettings) {
    const rows = [];
    const add = (key, want, required) => {
      const k = +key;
      if (NEVER_WRITE.has(k)) return;
      const machine = machineSettings[k];
      if (machine === undefined || machine === want) return;
      rows.push({
        key: k, want, machine, required,
        name: SETTING_NAMES[k] || ('$' + k),
        risk: RISK[k] || null,
      });
    };
    for (const k of Object.keys(profile.expect || {})) add(k, profile.expect[k], true);
    for (const k of Object.keys(profile.suggest || {})) add(k, profile.suggest[k], false);
    return rows;
  }
```

Add `diff` and `SETTING_NAMES` to the `K.machines` export object.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/`
Expected: PASS, 27 tests.

- [ ] **Step 5: Add the dialog markup**

In `index.html`, beside the other dialogs, add:

```html
<dialog id="dlgReconcile" class="dlg">
  <form method="dialog">
    <h2>Controller settings differ</h2>
    <p class="muted small">Values your machine reports that do not match this profile. Nothing is written unless you tick it. The old value is logged to the console first so you can put it back.</p>
    <div id="reconcileRows" class="recon-rows"></div>
    <div class="dlg-actions">
      <button class="btn ghost" value="cancel">Leave machine as it is</button>
      <button class="btn primary" value="ok">Write ticked values</button>
    </div>
  </form>
</dialog>
```

- [ ] **Step 6: Wire it to the `settings` event**

In `js/app.js` add:

```js
  grbl.addEventListener('settings', async () => {
    const m = S.machine, got = grbl.settings;

    // Adopt the machine's real geometry and laser scale. This is what the
    // settings dialog has always claimed happens on connect.
    const patch = {};
    if (Number.isFinite(got[130])) patch.bedW = got[130];
    if (Number.isFinite(got[131])) patch.bedH = got[131];
    if (Number.isFinite(got[30])) patch.maxS = got[30];
    if (Object.keys(patch).length) {
      saveMachine(patch);
      toast(`Work area read from the controller: ${f2(bedW())} × ${f2(bedH())} mm`, 'info', 5000);
    }

    if (m.hasHoming && got[22] === 0) {
      toast('Homing is disabled on this controller ($22=0). The Home button will alarm until it is enabled.', 'warn', 9000);
    }

    const rows = MA.diff(S.machine, got);
    if (!rows.length) return;
    $('#reconcileRows').innerHTML = rows.map(r => `
      <label class="check recon-row">
        <input type="checkbox" name="w${r.key}" value="${r.want}"${r.required ? ' checked' : ''}>
        <span><b>$${r.key}</b> ${esc(r.name)} — machine <b>${r.machine}</b>, profile wants <b>${r.want}</b>
        ${r.required ? '<em class="req">required</em>' : ''}
        ${r.risk ? `<small class="muted">${esc(r.risk)}</small>` : ''}</span>
      </label>`).join('');
    if (!(await openDialog($('#dlgReconcile')))) return;

    const writes = rows.filter(r => $(`#reconcileRows [name="w${r.key}"]`).checked);
    for (const r of writes) {
      grbl._log('info', `Changing $${r.key} (${r.name}) from ${r.machine} to ${r.want} — previous value ${r.machine}`);
      grbl.send(`$${r.key}=${r.want}`);
    }
    if (writes.length) {
      toast(`Wrote ${writes.length} setting${writes.length === 1 ? '' : 's'}. Previous values are in the console.`, 'ok', 8000);
      if (writes.some(r => r.key === 22 || r.key === 23)) {
        toast('Homing settings changed. Jog clear of the switches, then run Home.', 'warn', 10000);
      }
    }
  });
```

- [ ] **Step 7: Style the rows**

In `css/app.css` add:

```css
.recon-rows { display: grid; gap: 10px; margin: 12px 0; }
.recon-row small { display: block; margin-top: 2px; }
.recon-row .req { color: var(--danger); font-style: normal; font-size: 11px; margin-left: 6px; }
```

- [ ] **Step 8: Commit**

```bash
git add index.html js/app.js js/machines.js css/app.css tests/machines.test.js
git commit -m "Reconcile controller settings against the active profile on connect"
```

---

## Task 8: Settings dialog — profile fields and origin calibration

**Files:**
- Modify: `index.html` (`#dlgSettings`)
- Modify: `js/app.js` (`openSettings`)

- [ ] **Step 1: Replace the dialog's machine fields**

In `index.html`, replace the intro paragraph and the first four fields of `#dlgSettings`:

```html
    <p class="muted small">These describe the machine itself and are saved with the selected profile. Values marked $ are read from the controller when you connect.</p>
    <div class="grid2">
      <label><span>Machine name</span><input type="text" name="name" required></label>
      <label class="check"><input type="checkbox" name="hasHoming"> This machine has homing switches</label>
      <label><span>Work area width ($130)</span><div class="inline-num"><input type="number" name="bedW" min="10" step="1"><span class="u">mm</span></div></label>
      <label><span>Work area height ($131)</span><div class="inline-num"><input type="number" name="bedH" min="10" step="1"><span class="u">mm</span></div></label>
      <label><span>Max spindle value ($30)</span><input type="number" name="maxS" min="1" step="1"></label>
      <label><span>Baud rate</span><select name="baud"><option>115200</option><option>250000</option><option>57600</option><option>9600</option></select></label>
      <label><span>Work origin X</span><div class="inline-num"><input type="number" name="offX" step="0.001"><span class="u">mm</span></div></label>
      <label><span>Work origin Y</span><div class="inline-num"><input type="number" name="offY" step="0.001"><span class="u">mm</span></div></label>
    </div>
    <p class="muted small">Work origin is the machine coordinate of the front-left of your bed. It is 0,0 on most laser firmware. If your machine homes to negative coordinates, home it, jog to the front-left corner, then use the button below.</p>
    <div class="dlg-actions" style="justify-content:flex-start">
      <button type="button" class="btn ghost" id="btnCalibrateOrigin">Set work origin to current position</button>
    </div>
```

Keep the remaining preference fields (rapid, accel, overscan, frame) as they are.

- [ ] **Step 2: Split `openSettings()` between profile and preferences**

In `js/app.js`, find `openSettings()` and replace its load/save with:

```js
  async function openSettings() {
    const f = $('#dlgSettings form'), m = S.machine, s = S.settings;
    f.name.value = m.name;
    f.hasHoming.checked = m.hasHoming;
    f.bedW.value = m.bedW; f.bedH.value = m.bedH;
    f.maxS.value = m.maxS; f.baud.value = m.baud;
    f.offX.value = m.originOffset.x; f.offY.value = m.originOffset.y;
    f.rapid.value = s.rapid ?? m.rapid; f.accel.value = s.accel ?? m.accel;
    f.overscan.value = s.overscan;
    f.frameSpeed.value = s.frameSpeed;
    f.frameLaser.checked = s.frameLaser;
    f.framePower.value = s.framePower;

    if (!(await openDialog($('#dlgSettings')))) return;

    saveMachine({
      name: f.name.value.trim() || m.name,
      hasHoming: f.hasHoming.checked,
      bedW: +f.bedW.value, bedH: +f.bedH.value,
      maxS: +f.maxS.value, baud: +f.baud.value,
      rapid: +f.rapid.value, accel: +f.accel.value,
      originOffset: { x: +f.offX.value || 0, y: +f.offY.value || 0 },
    });
    Object.assign(S.settings, {
      overscan: +f.overscan.value,
      frameSpeed: +f.frameSpeed.value,
      frameLaser: f.frameLaser.checked,
      framePower: +f.framePower.value,
    });
    saveSettings();
    invalidatePreview();
    requestDraw();
  }
```

- [ ] **Step 3: Wire the calibrate button**

Add in `js/app.js`:

```js
  $('#btnCalibrateOrigin').addEventListener('click', () => {
    if (!grbl.connected) { toast('Connect the laser first.', 'warn'); return; }
    const o = MA.calibrate(S.machine, grbl.status.mpos);
    const f = $('#dlgSettings form');
    f.offX.value = f2(o.x);
    f.offY.value = f2(o.y);
    toast(`Work origin set to X ${f2(o.x)} Y ${f2(o.y)}. Save to keep it.`, 'ok', 6000);
  });
```

- [ ] **Step 4: Verify in the browser**

Reload. Expected: the dialog shows the active machine's name, editing it renames the entry in the picker, and the work-origin fields round-trip through a save and reload.

- [ ] **Step 5: Commit**

```bash
git add index.html js/app.js
git commit -m "Add profile fields and work-origin calibration to settings"
```

---

## Task 9: Hardware checklist and README

**Files:**
- Create: `docs/hardware-checklist-atomstack-a5.md`
- Modify: `README.md`

- [ ] **Step 1: Write the checklist**

Create `docs/hardware-checklist-atomstack-a5.md` containing, in order: capture the `$$` dump and save it to a file; write `$23=3`; confirm readback; jog both axes clear of the switches; run `$H` with a hand on the power switch; read `?` and record `MPos`; decide which firmware convention applies from that reading; calibrate the work origin; jog to each bed corner and check the readout against the frame rulers; frame a job at zero power; only then cut scrap. Each step states what a correct result looks like and what to do if it is wrong.

- [ ] **Step 2: Update the README**

In `README.md`, change the opening line from naming the Ortur alone to describing multi-machine support, and add a short **Machines** section explaining the picker, the work origin, and that the `$$` reconcile never writes without confirmation.

- [ ] **Step 3: Commit**

```bash
git add docs/ README.md
git commit -m "Document multi-machine support and A5 bring-up"
```

---

## Self-Review

**Spec coverage.** Profile model → Task 1. Persistence and migration → Task 2. Coordinate transform at the emit boundary → Task 3. Read boundary (`headPos`) → Task 4 Step 5. `goOrigin`, `machineName`, Bambu presets, bounds check → Task 4. Picker UI → Task 5. `$$` query → Task 6. Reconcile dialog with the safety rules → Task 7. Settings fields and calibration → Task 8. Hardware test sequence → Task 9. The byte-identical Ortur regression guard is Task 3 Step 1.

**Known gap, deliberate.** The A5 profile ships `bedW: 410, bedH: 400` as a provisional guess. Task 7's adopt-on-connect replaces both with `$130`/`$131` the first time the machine is plugged in, so the guess is corrected automatically rather than being a value anyone has to trust.

**Type consistency.** `originOffset` is `{x, y}` everywhere. `offsetFor(profile, origin)` and `calibrate(profile, mpos)` keep profile-first argument order, matching `toMachine`/`fromMachine`. `diff()` rows use `{key, want, machine, required, name, risk}` in both the test and the dialog renderer. `saveMachine(patch)` is defined in Task 4 and used in Tasks 7 and 8.
