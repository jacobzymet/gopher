import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { BrowserManager, findBrowserExecutable } from '../server/tools/browser.js';

test('a crashed or closed browser page is replaced on the next browser call', { timeout: 60000 }, async context => {
  if (!await findBrowserExecutable()) { context.skip('No supported Chromium browser installed'); return; }
  const server = createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end('<title>Fixture</title><button>Go</button>'); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const manager = new BrowserManager();
  try {
    await manager.execute('chat', '', 'browser_navigate', { url });
    const sessions = (manager as unknown as { sessions: Map<string, Promise<{ page: { close(): Promise<void> } }>> }).sessions;
    await (await sessions.get('chat')!).page.close();
    const after = JSON.parse((await manager.execute('chat', '', 'browser_navigate', { url })).text) as { title: string };
    assert.equal(after.title, 'Fixture');
  } finally {
    await manager.closeAll();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
