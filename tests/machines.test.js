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

  M.save(s, { ...ortur, bedW: 377 });
  M.migrate(s);
  assert.strictEqual(M.active(s).bedW, 377, 'second run must not clobber later edits');
});

test('migrate is a no-op with no legacy settings', () => {
  const M = K().machines;
  const s = fakeStore();
  M.migrate(s);
  assert.strictEqual(M.active(s).bedW, 400);
});

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
  assert.strictEqual(M.diff(a5, { 22: 1, 23: 3, 20: 1, 21: 1 }).length, 0);
});

test('diff omits values the controller did not report', () => {
  const M = K().machines;
  const a5 = M.BUILTIN.find(p => p.id === 'atomstack-a5');
  assert.strictEqual(M.diff(a5, {}).length, 0);
});

test('diff never proposes writing steps-per-mm', () => {
  const M = K().machines;
  const p = M.normalize({ id: 'x', name: 'X', expect: { 100: 80, 22: 1 } });
  const rows = M.diff(p, { 100: 79.5, 22: 0 });
  assert.ok(!rows.some(r => r.key === 100), 'calibration values are excluded');
  assert.ok(rows.some(r => r.key === 22));
});
