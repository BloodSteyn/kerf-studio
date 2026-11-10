const test = require('node:test');
const assert = require('node:assert');
const { loadKerf } = require('./helpers/load');

const load = () => loadKerf('js/geometry.js', 'js/gcode.js', 'js/machines.js');

// A closed rectangle spanning design-space X 10..40, Y 20..60.
// Objects are type 'path' with points in local space, scaled by w0/h0.
function rectProject() {
  return {
    layers: [{
      id: 'L1', name: 'Cut', mode: 'line', color: '#000', output: true,
      speed: 600, power: 50, minPower: 0, passes: 1, interval: 0.1,
    }],
    objects: [{
      id: 'o1', type: 'path', layer: 'L1',
      x: 10, y: 20, w: 30, h: 40, w0: 30, h0: 40, rot: 0,
      paths: [{ closed: true, pts: [[0, 0], [30, 0], [30, 40], [0, 40]] }],
    }],
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
