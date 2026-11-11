/* The app has no DOM test environment, so wiring errors would otherwise only
   show up in the browser. These checks assert that every element id and form
   field the machine-profile code reaches for actually exists in index.html. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8');

const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
const names = new Set([...html.matchAll(/\bname="([^"]+)"/g)].map(m => m[1]));

// Some elements are built at runtime from template strings in app.js (the
// layer panel, for one), so those ids count as defined too.
const runtimeIds = new Set([...appJs.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map(m => m[1]));

test('every element id app.js looks up exists in the markup or is built at runtime', () => {
  const missing = [];
  for (const m of appJs.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)) {
    if (!ids.has(m[1]) && !runtimeIds.has(m[1])) missing.push(m[1]);
  }
  assert.deepStrictEqual([...new Set(missing)], [], 'ids referenced but not defined');
});

test('the settings dialog carries every field openSettings reads', () => {
  const required = [
    'machineName', 'hasHoming', 'bedW', 'bedH', 'maxS', 'baud', 'offX', 'offY',
    'rapid', 'accel', 'overscan', 'frameSpeed', 'frameLaser', 'framePower',
  ];
  const missing = required.filter(n => !names.has(n));
  assert.deepStrictEqual(missing, [], 'settings fields missing from index.html');
});

test('machines.js is loaded before app.js', () => {
  const machines = html.indexOf('js/machines.js');
  const app = html.indexOf('js/app.js');
  assert.ok(machines > -1, 'machines.js has a script tag');
  assert.ok(machines < app, 'machines.js must load first so K.machines exists');
});

test('the machine picker is a select, not the old static badge', () => {
  assert.ok(/<select[^>]*id="machineTag"/.test(html), 'machineTag is a select element');
  assert.ok(!/Ortur LM2 Pro<\/span>/.test(html), 'static Ortur badge is gone');
});

test('no hardcoded Ortur machine name remains in the app code', () => {
  assert.ok(!/Ortur Laser Master 2 Pro \(GRBL/.test(appJs),
    'the G-code header name must come from the active profile');
});

test('the reconcile dialog exists with a rows container', () => {
  assert.ok(ids.has('dlgReconcile'));
  assert.ok(ids.has('reconcileRows'));
});
