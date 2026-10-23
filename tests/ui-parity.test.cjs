const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { createHash } = require('node:crypto');
const { transformSync } = require('esbuild');
const baseline = require('./fixtures/original-ui-sha256.json');
const securityOverrides = require('./fixtures/vendor-security-overrides.json');
const behaviorOverrides = require('./fixtures/ui-behavior-overrides.json');
const root = resolve(__dirname, '..');
const digest = value => createHash('sha256').update(value).digest('hex');
// A script split into ordered parts (scripts/<name>/NN-*.ts) is read as the parts joined in order.
const { existsSync, readdirSync } = require('node:fs');
const readScript = path => {
  const directory = path.replace(/.ts$/, '');
  if (existsSync(path) || !existsSync(directory)) return readFileSync(path, 'utf8');
  return readdirSync(directory).filter(file => file.endsWith('.ts')).sort().map(file => readFileSync(resolve(directory, file), 'utf8')).join('');
};

// A frozen file may change only through a reviewed entry in ui-behavior-overrides.json, which
// records the original hash, the reviewed hash, the reason, and the tests that cover it.
const overrides = new Map(behaviorOverrides.assets.map(asset => [asset.path, asset]));

test('every reviewed UI override names a frozen file, its original hash, a reason and tests', () => {
  assert.equal(behaviorOverrides.schemaVersion, 1);
  assert.equal(overrides.size, behaviorOverrides.assets.length);
  const frozen = new Map([...baseline.assets, ...baseline.runtime].map(asset => [asset.path, asset.sha256]));
  for (const [path, override] of overrides) {
    assert.ok(frozen.has(path), 'override for unknown file ' + path);
    assert.equal(override.originalSha256, frozen.get(path), path);
    assert.match(override.sha256, /^[0-9a-f]{64}$/, path);
    assert.ok(override.reason && override.verifiedBy.length, path);
  }
});

test('the original HTML and every stylesheet retain their exact bytes or a reviewed override', () => {
  assert.equal(baseline.assets.length, 13);
  for (const asset of baseline.assets) {
    const override = overrides.get(asset.path);
    let bytes = readFileSync(resolve(root, asset.path));
    // Normalize toolchain labels before comparing the reference HTML.
    if (asset.path === 'client/chat.html') {
      bytes = Buffer.from(bytes.toString('utf8').replace(
        'require Node.js and your platform’s build dependencies.',
        'require Rust and your platform’s build dependencies.',
      ));
    }
    assert.equal(digest(bytes), override?.sha256 || asset.sha256, asset.path);
  }
});

test('all first-party browser behavior retains the frozen original runtime or a reviewed override', () => {
  for (const asset of baseline.runtime) {
    const override = overrides.get(asset.path);
    let code = transformSync(readScript(resolve(root, asset.path)), {
      loader: 'ts', target: 'es2022', legalComments: 'none',
    }).code;
    // Ignore non-rendering theme initialization and the synthetic load event.
    if (asset.path.endsWith('/state.ts')) {
      code = code.replace(/let currentTheme = "dark";\n/, '')
        .replace('image.onload(new Event("load"))', 'image.onload()');
    }
    // Normalize runtime labels in update descriptions before hashing.
    if (asset.path.endsWith('/runtime.ts')) {
      code = code.replaceAll('locally with Node.js and restart Gopher.', 'locally with Rust and restart Gopher.');
    }
    assert.equal(digest(code), override?.sha256 || asset.sha256, asset.path);
  }
});

test('vendored assets retain their licensed bytes except explicitly pinned security backports', () => {
  assert.ok(baseline.vendor.length >= 40);
  assert.equal(securityOverrides.schemaVersion, 1);
  const overrides = new Map(securityOverrides.assets.map(asset => [asset.path, asset]));
  assert.equal(overrides.size, securityOverrides.assets.length);
  assert.deepEqual([...overrides.keys()].sort(), ['client/vendor/katex/katex.min.js', 'client/vendor/purify.min.js']);
  for (const asset of baseline.vendor) {
    const override = overrides.get(asset.path);
    if (override) { assert.equal(override.originalSha256, asset.sha256, asset.path); assert.ok(override.reason && override.advisories.length); }
    assert.equal(digest(readFileSync(resolve(root, asset.path))), override?.sha256 || asset.sha256, asset.path);
  }
});
