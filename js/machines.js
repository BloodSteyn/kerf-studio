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

  K.machines = { BUILTIN, normalize, toMachine, fromMachine, offsetFor, calibrate };
})(window.Kerf);
