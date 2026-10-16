const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { resolve, basename } = require('node:path');
const { createHash } = require('node:crypto');
const vm = require('node:vm');
const { chromium, browserLaunchOptions } = require('./helpers/app.cjs');
const root = resolve(__dirname, '..');
const digest = value => createHash('sha256').update(value).digest('hex');
const reference = require('./fixtures/original-ui-sha256.json');
const renderBaseline = require('./fixtures/vendor-render-baseline.json');

test('vendor security provenance pins official releases and every shipped asset hash', () => {
  const provenance = require('../client/vendor/security-provenance.json');
  const overrides = require('./fixtures/vendor-security-overrides.json');
  assert.equal(provenance.schemaVersion, 1); assert.equal(overrides.schemaVersion, 1);
  assert.deepEqual(provenance.packages.map(item => [item.name, item.version]), [['dompurify', '3.4.16'], ['katex', '0.16.22+gopher-security.1']]);
  for (const item of provenance.packages) {
    assert.equal(new URL(item.tarball).origin, 'https://registry.npmjs.org');
    assert.match(item.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
    for (const asset of item.assets) assert.equal(digest(readFileSync(resolve(root, asset.path))), asset.sha256, asset.path);
  }
  assert.equal(overrides.assets.length, 2);
  for (const asset of overrides.assets) {
    assert.equal(reference.vendor.find(original => original.path === asset.path)?.sha256, asset.originalSha256);
    assert.equal(digest(readFileSync(resolve(root, asset.path))), asset.sha256);
    assert.ok(asset.reason && asset.advisories.length);
  }
  assert.equal(digest(readFileSync(resolve(__dirname, 'fixtures/vendor-render-baseline.css'))), reference.vendor.find(asset => asset.path === 'client/vendor/katex/katex.min.css').sha256);
});

test('KaTeX rejects inherited trust and polluted setting metadata, including explicit trust:false', () => {
  const context = vm.createContext({});
  vm.runInContext(readFileSync(resolve(root, 'client/vendor/katex/katex.min.js'), 'utf8'), context);
  const result = vm.runInContext(`(() => {
    const tex = '\\\\href{javascript:alert(1)}{attack}';
    const unsafe = value => /href="javascript:/i.test(value);
    const result = { version: katex.version };
    result.inheritedTrust = unsafe(katex.renderToString(tex, Object.create({ trust: true })));
    Object.prototype.trust = true;
    try { result.pollutedTrust = unsafe(katex.renderToString(tex, {})); } finally { delete Object.prototype.trust; }
    Object.prototype.processor = () => true;
    try { result.pollutedProcessor = unsafe(katex.renderToString(tex, { trust: false })); } finally { delete Object.prototype.processor; }
    Object.prototype.default = true;
    try { result.pollutedDefault = unsafe(katex.renderToString(tex, {})); } finally { delete Object.prototype.default; }
    Object.prototype['\\\\backportInherited'] = tex;
    try { result.inheritedBuiltin = unsafe(katex.renderToString('\\\\backportInherited', { trust: true, throwOnError: false })); } finally { delete Object.prototype['\\\\backportInherited']; }
    katex.__defineMacro('\\\\backportScope', context => {
      context.macros.beginGroup(); context.macros.set('\\\\scopeCheck', 'temporary'); context.macros.endGroup();
      result.restoredInherited = Object.prototype.hasOwnProperty.call(context.macros.current, '\\\\scopeCheck');
      return 'x';
    });
    Object.prototype['\\\\scopeCheck'] = 'inherited';
    try { katex.renderToString('\\\\backportScope'); } finally { delete Object.prototype['\\\\scopeCheck']; }
    result.explicitTrustedLink = katex.renderToString('\\\\href{https://example.com}{safe}', { trust: true }).includes('href="https://example.com"');
    return result;
  })()`, context);
  assert.equal(result.version, '0.16.22+gopher-security.1');
  assert.equal(result.inheritedTrust, false); assert.equal(result.pollutedTrust, false); assert.equal(result.pollutedProcessor, false);
  assert.equal(result.pollutedDefault, false); assert.equal(result.inheritedBuiltin, false); assert.equal(result.restoredInherited, false);
  assert.equal(result.explicitTrustedLink, true);
});

test('KaTeX security backport rebuilds exactly from its audited readable source', async () => {
  const { rebuild } = await import('../client/vendor/katex/security/rebuild.mjs');
  assert.equal((await rebuild()).version, '0.16.22+gopher-security.1');
});

test('DOMPurify neutralizes hook-detached descendants and rejects removed rawtext roots', { skip: !chromium && 'Set GOPHER_BROWSER_TESTS=1 to run browser checks' }, async () => {
  const browser = await chromium.launch(browserLaunchOptions());
  try {
    const page = await browser.newPage(); await page.route('**/*', route => route.abort());
    await page.addScriptTag({ path: resolve(root, 'client/vendor/purify.min.js') });
    const result = await page.evaluate(() => {
      const retainedHandlers = [];
      for (const hook of ['afterSanitizeElements', 'afterSanitizeAttributes']) {
        const root = document.createElement('div'); root.innerHTML = '<section id="remove-wrapper"><img onerror="window.__vendorAttack=true"></section>';
        document.body.append(root); const image = root.querySelector('img');
        DOMPurify.addHook(hook, node => { if (node.id === 'remove-wrapper') node.remove(); });
        DOMPurify.sanitize(root, { IN_PLACE: true });
        retainedHandlers.push(image.hasAttribute('onerror')); image.dispatchEvent(new Event('error'));
        DOMPurify.removeAllHooks(); root.remove();
      }
      const style = document.createElement('style'); style.textContent = '</style><img src=x onerror="window.__vendorAttack=true">'; document.body.append(style);
      let rawtextRejected = false;
      try { DOMPurify.sanitize(style, { IN_PLACE: true }); } catch (error) { rawtextRejected = error instanceof TypeError; }
      style.remove();
      return { version: DOMPurify.version, retainedHandlers, rawtextRejected, executed: Boolean(window.__vendorAttack) };
    });
    assert.equal(result.version, '3.4.16'); assert.deepEqual(result.retainedHandlers, [false, false]);
    assert.equal(result.rawtextRejected, true); assert.equal(result.executed, false);
  } finally { await browser.close(); }
});

test('patched KaTeX preserves the measured original math corpus with matching CSS and unchanged fonts', { skip: !chromium && 'Set GOPHER_BROWSER_TESTS=1 to run browser checks', timeout: 30000 }, async () => {
  const browser = await chromium.launch(browserLaunchOptions());
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 720 }, deviceScaleFactor: 1 });
    await page.route('**/*', async route => {
      const name = basename(new URL(route.request().url()).pathname);
      if (name.endsWith('.woff2')) return route.fulfill({ body: readFileSync(resolve(root, 'client/vendor/katex/fonts', name)), contentType: 'font/woff2' });
      return route.abort();
    });
    const captures = [];
    for (const variant of ['before', 'after']) {
      await page.setContent('<html><head><base href="http://vendor.local/"></head><body></body></html>');
      await page.addStyleTag({ content: 'html,body{margin:0;background:#fff;color:#16181e}#corpus{display:grid;grid-template-columns:1fr 1fr;width:1000px;font:18px Arial}.sample{height:120px;box-sizing:border-box;display:flex;align-items:center;justify-content:center;overflow:hidden;border-bottom:1px solid #ddd}' });
      await page.addStyleTag({ path: resolve(root, variant === 'before' ? 'tests/fixtures/vendor-render-baseline.css' : 'client/vendor/katex/katex.min.css') });
      if (variant === 'after') await page.addScriptTag({ path: resolve(root, 'client/vendor/katex/katex.min.js') });
      const geometry = await page.evaluate(async ({ baseline, variant }) => {
        const host = document.createElement('div'); host.id = 'corpus'; document.body.append(host);
        for (const sample of baseline.samples) {
          const row = document.createElement('div'); row.className = 'sample';
          const html = variant === 'before' ? sample.html : katex.renderToString(sample.tex, { ...baseline.options, displayMode: sample.display });
          if (html !== sample.html) throw new Error(`Math markup changed: ${sample.name}`);
          row.innerHTML = html; host.append(row);
        }
        await document.fonts.ready;
        return [...host.children].map((row, index) => { const rect = row.querySelector('.katex').getBoundingClientRect(); return { name: baseline.samples[index].name, width: rect.width, height: rect.height }; });
      }, { baseline: renderBaseline, variant });
      const png = await page.screenshot({ fullPage: true, animations: 'disabled' }); captures.push({ geometry, png: png.toString('base64') });
    }
    const difference = await page.evaluate(async images => {
      const pixels = [];
      for (const base64 of images) {
        const image = new Image(); image.src = 'data:image/png;base64,' + base64; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext('2d'); context.drawImage(image, 0, 0); pixels.push(context.getImageData(0, 0, image.width, image.height));
      }
      let changed = 0;
      for (let index = 0; index < pixels[0].data.length; index += 4) {
        if ([0, 1, 2].some(channel => pixels[0].data[index + channel] !== pixels[1].data[index + channel])) changed++;
      }
      return { changed, total: pixels[0].width * pixels[0].height };
    }, captures.map(capture => capture.png));
    assert.equal(captures[0].geometry.length, 56);
    for (let index = 0; index < captures[0].geometry.length; index++) {
      const before = captures[0].geometry[index], after = captures[1].geometry[index];
      assert.equal(after.width, before.width, `${before.name} width`);
      assert.equal(after.height, before.height, `${before.name} height`);
    }
    assert.equal(difference.changed, 0, `Math corpus pixels changed (${difference.changed}/${difference.total})`);
    const output = resolve(root, 'output/typescript/vendor-security'); mkdirSync(output, { recursive: true });
    for (let index = 0; index < captures.length; index++) writeFileSync(resolve(output, index ? 'after.png' : 'before.png'), Buffer.from(captures[index].png, 'base64'));
    writeFileSync(resolve(output, 'render-audit.json'), JSON.stringify({ difference, geometry: captures.map(capture => capture.geometry) }, null, 2) + '\n');
  } finally { await browser.close(); }
});
