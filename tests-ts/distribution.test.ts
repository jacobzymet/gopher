import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, cp, symlink, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

test('the built distribution serves every runtime asset and runs an agent without the source tree', { timeout: 25000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gopher-distribution-'));
  const deployed = join(directory, 'app'); const workspace = join(directory, 'workspace'); await mkdir(workspace);
  await cp(resolve('dist'), deployed, { recursive: true });
  await symlink(resolve('node_modules'), join(deployed, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const requests: any[] = [];
  const model = createServer(async (request, response) => {
    if (request.url === '/v1/models') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'fixture', context_length: 32768 }] })); return; }
    if (request.url === '/v1/chat/completions') {
      let body = ''; for await (const chunk of request) body += chunk;
      requests.push(JSON.parse(body)); response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'The packaged agent works.' }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`); return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const modelPort = (model.address() as { port: number }).port;
  const alias = join(directory, 'app-alias');
  await symlink(deployed, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const child = spawn(process.execPath, [join(alias, 'server/index.js'), '--headless', '--config', join(directory, 'data/config.toml'), '--bind', '127.0.0.1:0'], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let logs = ''; child.stdout?.on('data', data => { logs += data; }); child.stderr?.on('data', data => { logs += data; });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  try {
    let port = 0;
    for (let attempt = 0; attempt < 150; attempt++) { port = Number(logs.match(/gopher\.localhost:(\d+)/)?.[1]); if (port) break; if (child.exitCode !== null) throw new Error(logs); await delay(100); }
    assert.ok(port, logs); const origin = `http://127.0.0.1:${port}`;
    const bootstrap = await fetch(origin); assert.equal(bootstrap.status, 200); const html = await bootstrap.text(); assert.match(html, /id="chatShell"/);
    const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0];
    const call = (path: string, data: unknown) => fetch(origin + path, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(data) });
    for (const asset of ['/chat.js', '/chat.css', '/orb.js', '/optional-fonts.js', '/prompts.js', '/marked.min.js', '/purify.min.js', '/highlight.min.js', '/katex.min.js', '/katex.min.css', '/xterm.min.js', '/xterm-addon-fit.min.js', '/xterm.css', '/ocr/tesseract.min.js', '/ocr/worker.min.js', '/ocr/eng.traineddata.gz', '/browser-favicon.png']) {
      const response = await fetch(origin + asset); assert.equal(response.status, 200, asset); assert.ok((await response.arrayBuffer()).byteLength > 0, asset);
    }
    const added = await call('/api/providers', { name: 'packaged fixture', base: `http://127.0.0.1:${modelPort}/v1`, api_style: 'openai' });
    assert.equal(added.status, 200, await added.clone().text()); const settings = await added.json() as any;
    const provider = settings.providers.find((item: any) => item.name === 'packaged fixture'); assert.ok(provider);
    const result = await call('/api/chat/completions', { model: 'fixture', provider_id: provider.id, conversation_id: 'packaged', agent: true, messages: [{ role: 'user', content: 'Confirm that the packaged agent can read its prompt library.' }], skills: { filesystem: true, workspace_root: workspace, approval_mode: 'auto_safe' } });
    assert.equal(result.status, 200); assert.match(await result.text(), /The packaged agent works/);
    assert.ok(requests[0].tools.some((item: any) => item.function.name === 'read_file'));
    const originalCore = (await readFile(join(deployed, 'prompts/agent/core.md'), 'utf8')).trim();
    assert.ok(requests[0].messages.some((message: any) => typeof message.content === 'string' && message.content.includes(originalCore)));
    child.send({ type: 'shutdown' }); await exited; assert.equal(child.exitCode, 0, logs);
  } finally {
    if (child.exitCode === null) child.kill(); await exited;
    model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
