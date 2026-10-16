import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server/index.js';

test('a provider change during catalog loading discards stale results and queues the new endpoint', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gopher-catalog-change-'));
  let releaseOld!: () => void; const gate = new Promise<void>(resolve => { releaseOld = resolve; });
  let started!: () => void; const oldStarted = new Promise<void>(resolve => { started = resolve; });
  const upstream = createServer(async (request, response) => {
    if (!request.url?.endsWith('/models')) { response.writeHead(404).end(); return; }
    const old = request.url.startsWith('/old/');
    if (old) { started(); await gate; }
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: old ? 'old-model' : 'new-model' }] }));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = (upstream.address() as { port: number }).port;
  const app = await createApp({ configPath: join(directory, 'config.toml'), bind: '127.0.0.1:0' });
  try {
    await app.storage.saveConfig({ ...app.storage.config, providers: [{ id: 'changing', name: 'Changing provider', base: `http://127.0.0.1:${upstreamPort}/old/v1`, token: '', kind: 'custom', api_style: 'openai', allow_insecure_tls: false }], active_provider_id: 'changing' });
    await app.listen(); await oldStarted;
    const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const bootstrap = await fetch(origin); await bootstrap.body?.cancel(); const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0];
    const changed = await fetch(origin + '/api/providers/changing', { method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ base: `http://127.0.0.1:${upstreamPort}/new/v1` }) });
    assert.equal(changed.status, 200); releaseOld();
    let latest: any;
    for (let attempt = 0; attempt < 40; attempt++) {
      const response = await fetch(origin + '/api/state', { headers: { cookie } }); latest = await response.json();
      assert.equal(latest.network.remote_models.some((model: any) => model.model === 'old-model'), false);
      if (latest.network.remote_models.some((model: any) => model.model === 'new-model') && !latest.network.remote_catalog_pending) break;
      await delay(50);
    }
    assert.ok(latest.network.remote_models.some((model: any) => model.model === 'new-model'));
  } finally { releaseOld(); await app.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});
