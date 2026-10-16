const { chromium, browserLaunchOptions, mockAppUpdates } = require('./helpers/app.cjs');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createServer } = require('node:http');

test('browser update fixture isolates live offers without masking other app requests', {
  skip: !chromium, timeout: 20000,
}, async () => {
  const upstream = [];
  const server = createServer((request, response) => {
    upstream.push({ method: request.method, path: request.url });
    if (request.url === '/') {
      response.setHeader('content-type', 'text/html');
      return response.end('<!doctype html><title>Browser isolation fixture</title>');
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ update_available: true, latest: 'f'.repeat(40), method: request.method }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch(browserLaunchOptions());
    const page = await browser.newPage();
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await mockAppUpdates(page, origin);
    await page.goto(origin);
    const result = await page.evaluate(async () => {
      const get = async path => (await fetch(path)).json();
      return {
        normal: await get('/api/state'),
        cached: await get('/api/updates/check'),
        fresh: await get('/api/updates/check?force=1'),
        post: await (await fetch('/api/updates/check', { method: 'POST' })).json(),
        otherPath: await get('/api/updates/check-other'),
        externalBlocked: await fetch('https://external.invalid/api/updates/check').then(() => false, () => true),
      };
    });
    assert.equal(result.cached.update_available, false);
    assert.deepEqual(result.fresh, result.cached);
    assert.equal(result.cached.latest, result.cached.current_commit);
    assert.equal(result.normal.update_available, true);
    assert.equal(result.post.method, 'POST');
    assert.equal(result.otherPath.update_available, true);
    assert.equal(result.externalBlocked, true);
    assert.deepEqual(upstream.filter(request => request.path.startsWith('/api/')), [
      { method: 'GET', path: '/api/state' },
      { method: 'POST', path: '/api/updates/check' },
      { method: 'GET', path: '/api/updates/check-other' },
    ]);
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
