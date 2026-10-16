// Optional native smoke check: electron scripts/smoke-desktop.cjs
const { app } = require('electron');
const { mkdtempSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawn } = require('node:child_process');
const reuseServer = process.argv.includes('--reuse-server');
const reportPath = resolve(`output/playwright/desktop-smoke${reuseServer ? '-existing' : ''}.json`);
let report;
let fixture, fixtureClosed, cleanupStarted = false;
const smokeRoot = mkdtempSync(join(tmpdir(), 'gopher-desktop-smoke-'));
app.setPath('userData', join(smokeRoot, 'electron'));
process.argv.push('--config=' + join(smokeRoot, 'config.toml'));
const timer = setTimeout(() => { console.error('Desktop startup timed out'); app.exit(1); }, 45000);
app.on('before-quit', event => {
  if (!fixture || cleanupStarted) return;
  event.preventDefault(); cleanupStarted = true;
  const timeout = setTimeout(() => { fixture.kill(); app.exit(1); }, 7000);
  fixtureClosed.then(() => { clearTimeout(timeout); app.quit(); });
  if (fixture.connected) fixture.send({ type: 'shutdown' }); else fixture.kill();
});
app.on('browser-window-created', (_event, window) => {
  window.webContents.setBackgroundThrottling(false);
  window.hide();
  window.webContents.on('render-process-gone', (_event, details) => { console.error(details); app.exit(1); });
  window.webContents.on('did-fail-load', (_event, code, description) => { console.error(code, description); app.exit(1); });
  window.webContents.once('did-finish-load', async () => {
    try {
      const status = await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{let attempts=0;const check=async()=>{try{const r=await fetch('/api/state');const data=await r.json();if(r.ok&&document.getElementById('chatShell'))return resolve({status:r.status,version:data.version});}catch{}if(++attempts>50)return reject(new Error('UI did not initialize'));setTimeout(check,100)};check()})`);
      const output = resolve(`output/playwright/desktop-smoke${reuseServer ? '-existing' : ''}.png`); mkdirSync(resolve('output/playwright'), { recursive: true });
      await window.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      require('node:fs').writeFileSync(output, (await window.webContents.capturePage()).toPNG());
      await new Promise(resolve => setTimeout(resolve, 300));
      if (reuseServer && fixture.exitCode !== null) throw new Error('The desktop stopped the externally owned server.');
      report = { capturedAt: new Date().toISOString(), ...status, url: window.webContents.getURL(), screenshot: output, reused_server: reuseServer, ...(reuseServer ? { external_server_survived: true } : {}), quit: false };
      require('node:fs').writeFileSync(reportPath, JSON.stringify(report));
      console.log('DESKTOP_READY', JSON.stringify(status), output);
      clearTimeout(timer); app.quit();
    } catch (error) { console.error(error); app.exit(1); }
  });
});
app.on('will-quit', () => {
  if (!report) { console.error('Desktop quit without opening and verifying its window.'); app.exit(1); return; }
  report.quit = true; require('node:fs').writeFileSync(reportPath, JSON.stringify(report));
});
async function start() {
  if (reuseServer) {
    const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
    fixture = spawn(environment.GOPHER_NODE_EXECUTABLE || environment.npm_node_execpath || 'node', [resolve('dist/server/index.js'), '--headless', '--config=' + join(smokeRoot, 'config.toml'), '--bind=127.0.0.1:0'], { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    fixtureClosed = new Promise(resolve => fixture.once('close', resolve));
    fixture.on('message', message => { if (message?.type === 'native-request' && fixture.connected) fixture.send({ type: 'native-response', id: message.id, value: false }); });
    const port = await new Promise((resolve, reject) => {
      let logs = '';
      fixture.stdout.on('data', data => { logs += data; const match = logs.match(/Gopher listening on http:\/\/gopher\.localhost:(\d+)/); if (match) resolve(match[1]); });
      fixture.stderr.on('data', data => { logs += data; });
      fixture.once('error', reject); fixture.once('exit', () => reject(new Error(logs || 'Headless fixture exited before startup.')));
    });
    process.argv.push('--bind=127.0.0.1:' + port);
  } else process.argv.push('--bind=127.0.0.1:0');
  require('../dist/desktop/main.cjs');
}
start().catch(error => { console.error(error); app.exit(1); });
