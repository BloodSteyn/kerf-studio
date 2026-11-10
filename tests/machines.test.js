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
