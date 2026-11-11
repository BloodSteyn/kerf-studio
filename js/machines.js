/* Kerf Studio — machine profiles: what laser is plugged in, and where its work area sits.

   originOffset is the machine coordinate of the FRONT-LEFT corner of the work area.
   It is 0,0 on firmware that forces the origin at home (Ortur and most laser vendors),
   and -bedW,-bedH on stock GRBL, whose envelope runs negative from the max corner.
   It is measured from the machine, never inferred from the firmware build. */
window.Kerf = window.Kerf || {};
(function (K) {
  'use strict';

  const num = (v, d) => (v !== '' && v !== null && Number.isFinite(+v) ? +v : d);

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

  // ------------------------------------------------- controller reconcile
  const SETTING_NAMES = {
    20: 'Soft limits', 21: 'Hard limits', 22: 'Homing cycle', 23: 'Homing direction mask',
    24: 'Homing feed', 25: 'Homing seek', 26: 'Homing debounce', 27: 'Homing pull-off',
    30: 'Max spindle value', 31: 'Min spindle value', 32: 'Laser mode',
    130: 'X max travel', 131: 'Y max travel',
  };

  const RISK = {
    21: 'Hard limits will halt a job if the switch wiring picks up interference from the stepper cables.',
    20: 'Soft limits only protect you if the work area values are accurate.',
  };

  // Steps-per-mm is calibration, not configuration. Rewriting it silently
  // destroys dimensional accuracy, so it is never offered.
  const NEVER_WRITE = new Set([100, 101, 102]);

  function diff(profile, machineSettings) {
    const rows = [];
    const seen = new Set();
    const add = (key, want, required) => {
      const k = +key;
      if (NEVER_WRITE.has(k) || seen.has(k)) return;
      const machine = machineSettings[k];
      if (machine === undefined || machine === want) return;
      seen.add(k);
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

  // ---------------------------------------------------------------- storage
  const KEY_PROFILES = 'kerf.machines';
  const KEY_ACTIVE = 'kerf.machine';
  const KEY_LEGACY = 'kerf.settings';
  const KEY_MIGRATED = 'kerf.machinesMigrated';

  // Fields a stored override may carry. Everything else (expect, suggest,
  // builtin) always comes from code, so shipping a corrected default still
  // reaches users who have edited the profile.
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
      if (p && !BUILTIN.some(b => b.id === p.id)) out.push(normalize({ ...p, builtin: false }));
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

  // One-time adoption of the pre-profiles settings blob into the Ortur
  // profile, so an existing install sees no change. Machine facts move across;
  // preferences stay where they are.
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

  K.machines = {
    BUILTIN, normalize, toMachine, fromMachine, offsetFor, calibrate,
    list, get, save, remove, active, setActive, migrate, newId,
    diff, SETTING_NAMES,
  };
})(window.Kerf);
