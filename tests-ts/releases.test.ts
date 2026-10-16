import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildRelease, activateRelease, atomicFile } from '../scripts/install.js';
import { UpdateService } from '../server/updates.js';

const exec = promisify(execFile);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gopher-release-'));
  const repository = join(root, "source ' workspace"); const releases = join(root, 'releases'); const bin = join(root, 'bin');
  await mkdir(join(repository, 'scripts'), { recursive: true }); await mkdir(releases);
  await writeFile(join(repository, 'package.json'), JSON.stringify({ name: 'gopher', scripts: { build: 'fixture' } }));
  await writeFile(join(repository, 'package-lock.json'), '{"lockfileVersion":3}');
  await writeFile(join(repository, 'scripts/launcher.ts'), await readFile(resolve('scripts/launcher.ts')));
  const npm = join(root, 'npm-fixture.cjs');
  await writeFile(npm, `const fs=require('node:fs');const cp=require('node:child_process');const p=require('node:path');
const mode=process.env.GOPHER_RELEASE_TEST_MODE;
if(process.argv[2]==='ci'){
 if(!process.argv.includes('--include=dev')||!process.argv.includes('--include=optional'))throw new Error('Release installation must include build tools and optional native dependencies');
 if(mode==='install-fails')process.exit(7);
 fs.mkdirSync('node_modules/electron',{recursive:true});fs.writeFileSync('node_modules/electron/install.js',"require('node:fs').writeFileSync('.runtime-installed','yes')");
 for(const name of ['node-pty','fs-ext']){
  fs.mkdirSync('node_modules/'+name,{recursive:true});
  const failure=name===(process.platform==='win32'?'node-pty':'fs-ext')&&mode==='native-addon-fails';
  fs.writeFileSync('node_modules/'+name+'/index.js',failure?"throw new Error('Native addon fixture cannot load');":"require('node:fs').appendFileSync('.native-addons-checked',"+JSON.stringify(name+'|')+");module.exports={};");
 }
}else if(process.argv[2]==='run'){
 if(mode==='build-fails')process.exit(8);
 if(!fs.existsSync('.native-addons-checked'))throw new Error('Native dependency validation must precede the build');
 fs.mkdirSync('dist/server',{recursive:true});fs.mkdirSync('dist/desktop',{recursive:true});
 const commit=cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
 fs.writeFileSync('dist/build.json',JSON.stringify({commit:mode==='wrong-identity'?'0'.repeat(40):commit}));
 fs.writeFileSync('dist/server/index.js',"console.log('fixture version')");fs.writeFileSync('dist/desktop/main.cjs','');
}`);
  const git = (...args: string[]) => exec('git', ['-C', repository, ...args], { windowsHide: true });
  await git('init', '-b', 'master', '--quiet'); await git('add', '.');
  await git('-c', 'user.name=Gopher tests', '-c', 'user.email=gopher@example.invalid', 'commit', '-qm', 'fixture');
  const commit = (await git('rev-parse', 'HEAD')).stdout.trim();
  const pointer = join(releases, 'current.json'); await writeFile(pointer, '{"checkout":"previous working release"}');
  return { root, repository, releases, bin, npm, commit, pointer, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('source installation builds the exact fetched commit and activates only verified output', async () => {
  const f = await fixture();
  try {
    const built = await buildRelease({ repository: f.repository, releasesDirectory: f.releases, npmCli: f.npm, env: { ...process.env, NODE_ENV: 'production', NPM_CONFIG_OMIT: 'dev,optional' } });
    assert.equal(built.commit, f.commit); assert.equal(await readFile(join(built.checkout, '.runtime-installed'), 'utf8'), 'yes');
    assert.equal(await readFile(join(built.checkout, '.native-addons-checked'), 'utf8'), process.platform === 'win32' ? 'node-pty|' : 'node-pty|fs-ext|');
    assert.deepEqual(JSON.parse(await readFile(f.pointer, 'utf8')), { checkout: 'previous working release' });
    await activateRelease(built, f.bin);
    assert.deepEqual(JSON.parse(await readFile(f.pointer, 'utf8')), built);
    const launched = await exec(process.execPath, [join(f.releases, 'launcher.ts'), '--version'], { windowsHide: true });
    assert.match(launched.stdout, /fixture version/);
    if (process.platform !== 'win32') assert.match((await exec(join(f.bin, 'gopher'), ['--version'])).stdout, /fixture version/);
  } finally { await f.cleanup(); }
});

for (const mode of ['install-fails', 'native-addon-fails', 'build-fails', 'wrong-identity']) test(`installation ${mode} leaves the active application untouched`, async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.pointer, 'utf8');
    const building = buildRelease({ repository: f.repository, releasesDirectory: f.releases, npmCli: f.npm, env: { ...process.env, GOPHER_RELEASE_TEST_MODE: mode } });
    if (mode === 'native-addon-fails') await assert.rejects(building, /Required native dependency (node-pty|fs-ext) could not load/);
    else await assert.rejects(building);
    assert.equal(await readFile(f.pointer, 'utf8'), before);
  } finally { await f.cleanup(); }
});

test('failed launcher activation preserves the previous release pointer', async () => {
  const f = await fixture();
  try {
    const built = await buildRelease({ repository: f.repository, releasesDirectory: f.releases, npmCli: f.npm, commit: f.commit });
    const before = await readFile(f.pointer, 'utf8'); await writeFile(f.bin, 'a file cannot become a launcher directory');
    await assert.rejects(activateRelease(built, f.bin)); assert.equal(await readFile(f.pointer, 'utf8'), before);
    await assert.rejects(buildRelease({ repository: f.repository, releasesDirectory: f.releases, npmCli: f.npm, commit: 'not-a-commit' }), /valid master commit/);
  } finally { await f.cleanup(); }
});

test('Windows activation retires legacy executables into distinct recoverable backups', { skip: process.platform !== 'win32' }, async () => {
  const f = await fixture();
  try {
    const built = await buildRelease({ repository: f.repository, releasesDirectory: f.releases, npmCli: f.npm, commit: f.commit });
    await mkdir(f.bin);
    for (const content of ['first legacy executable', 'second legacy executable']) {
      await writeFile(join(f.bin, 'gopher.exe'), content);
      await activateRelease(built, f.bin);
      await assert.rejects(readFile(join(f.bin, 'gopher.exe')), { code: 'ENOENT' });
      assert.match(await readFile(join(f.bin, 'gopher.cmd'), 'utf8'), /launcher\.ts/);
    }
    const backups = (await readdir(f.bin)).filter(name => name.startsWith('gopher-legacy-'));
    assert.equal(backups.length, 2);
    assert.deepEqual((await Promise.all(backups.map(name => readFile(join(f.bin, name, 'gopher.exe'), 'utf8')))).sort(), ['first legacy executable', 'second legacy executable']);
    assert.deepEqual(JSON.parse(await readFile(f.pointer, 'utf8')), built);
  } finally { await f.cleanup(); }
});

test('failed Windows pointer commit restores the legacy executable and retains its backup', { skip: process.platform !== 'win32' }, async () => {
  const f = await fixture();
  try {
    const built = await buildRelease({ repository: f.repository, releasesDirectory: f.releases, npmCli: f.npm, commit: f.commit });
    const before = await readFile(f.pointer, 'utf8');
    await mkdir(f.bin); await writeFile(join(f.bin, 'gopher.exe'), 'previous executable');
    await chmod(f.pointer, 0o444);
    try { await assert.rejects(activateRelease(built, f.bin)); }
    finally { await chmod(f.pointer, 0o600); }
    assert.equal(await readFile(f.pointer, 'utf8'), before);
    assert.equal(await readFile(join(f.bin, 'gopher.exe'), 'utf8'), 'previous executable');
    assert.match(await readFile(join(f.bin, 'gopher.cmd'), 'utf8'), /launcher\.ts/);
    const backups = (await readdir(f.bin)).filter(name => name.startsWith('gopher-legacy-'));
    assert.equal(backups.length, 1);
    assert.equal(await readFile(join(f.bin, backups[0], 'gopher.exe'), 'utf8'), 'previous executable');
  } finally { await f.cleanup(); }
});

const sha = 'a'.repeat(40);
function responses(manifest: unknown = { name: 'gopher', scripts: { build: 'tsx scripts/build.ts' } }): typeof fetch {
  return (async (url: string | URL | Request) => new Response(JSON.stringify(String(url).includes('/commits/master') ? { sha } : manifest), { headers: { 'content-type': 'application/json' } })) as typeof fetch;
}

test('update discovery caches checks, rejects invalid manifests and preserves build identity', async () => {
  let calls = 0; const upstream = responses();
  const service = new UpdateService({ currentCommit: sha, modified: false, fetch: (async (...args: Parameters<typeof fetch>) => { calls++; return upstream(...args); }) as typeof fetch });
  assert.equal((await service.check()).update_available, false); await service.check(); assert.equal(calls, 1);
  assert.equal((await new UpdateService({ currentCommit: sha, modified: true, fetch: responses(), verifyTools: async () => {} }).check()).can_install, true);
  const invalid = await new UpdateService({ currentCommit: 'b'.repeat(40), fetch: responses({ name: 'other' }) }).check();
  assert.equal(invalid.can_install, false); assert.match(invalid.install_blocked!, /incompatible/);
  const malformed = await new UpdateService({ fetch: (async () => new Response('{"sha":"broken"}')) as typeof fetch }).check();
  assert.match(malformed.error!, /valid master commit/);
});

test('updates switch the managed release atomically and retain custom config and bind on restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gopher-update-')); const pointer = join(root, 'current.json');
  await atomicFile(pointer, '{"checkout":"previous"}'); const scheduled: Array<() => Promise<void>> = []; let restarted: unknown[] = [];
  try {
    const service = new UpdateService({ currentCommit: 'b'.repeat(40), modified: false, fetch: responses(), verifyTools: async () => {}, releasePointer: pointer, build: async input => { assert.equal(input.commit, sha); return { checkout: join(root, 'verified'), commit: sha }; }, schedule: callback => scheduled.push(callback), restart: async (...args) => { restarted = args; } });
    assert.deepEqual(await service.apply('custom config.toml', '127.0.0.1:4000'), { ok: true, restarting: true, commit: sha });
    assert.deepEqual(JSON.parse(await readFile(pointer, 'utf8')), { checkout: join(root, 'verified'), commit: sha });
    assert.equal(scheduled.length, 1); await assert.rejects(service.apply(), /already building/);
    await scheduled[0](); assert.deepEqual(restarted, [join(root, 'verified'), 'custom config.toml', '127.0.0.1:4000']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('failed update builds never activate a partial release or schedule a restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gopher-update-failed-')); const pointer = join(root, 'current.json');
  await atomicFile(pointer, '{"checkout":"previous"}'); let scheduled = false;
  try {
    const service = new UpdateService({ fetch: responses(), verifyTools: async () => {}, releasePointer: pointer, build: async () => { throw new Error('build failed'); }, schedule: () => { scheduled = true; } });
    await assert.rejects(service.apply(), /build failed/); assert.equal(scheduled, false);
    assert.deepEqual(JSON.parse(await readFile(pointer, 'utf8')), { checkout: 'previous' });
    await assert.rejects(service.apply(), /build failed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
