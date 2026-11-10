/* Loads Kerf's browser IIFE modules under Node by shimming `window`. */
const path = require('path');

function loadKerf(...files) {
  globalThis.window = globalThis;
  globalThis.window.Kerf = {};
  const root = path.join(__dirname, '..', '..');
  for (const f of files) {
    const abs = path.join(root, f);
    delete require.cache[require.resolve(abs)];
    require(abs);
  }
  return globalThis.window.Kerf;
}

module.exports = { loadKerf };
