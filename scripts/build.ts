import { build } from 'esbuild';
import { mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { buildClient } from './build-client.js';

await mkdir('dist/server', { recursive: true });
await buildClient();
let commit = 'development';
let dirty = true;
try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* source archive */ }
try { dirty = Boolean(execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8' }).trim()); } catch { /* source archive */ }
await build({ entryPoints: ['server/index.ts'], outfile: 'dist/server/index.js', bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external', sourcemap: true, define: { GOPHER_BUILD_COMMIT: JSON.stringify(commit), GOPHER_BUILD_DIRTY: String(dirty) } });
await build({ entryPoints: ['desktop/main.ts'], outfile: 'dist/desktop/main.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'], sourcemap: true });
await cp('prompts', 'dist/prompts', { recursive: true });
await cp('client/vendor', 'dist/public/vendor', { recursive: true });
await cp('assets/browser-favicon.png', 'dist/public/browser-favicon.png');
const pkg = JSON.parse(await readFile('package.json', 'utf8')) as { version: string };
await writeFile('dist/build.json', JSON.stringify({ version: pkg.version, commit, modified: dirty, built: new Date().toISOString() }));
await writeFile('dist/package.json', JSON.stringify({ name: 'gopher', version: pkg.version, private: true, type: 'module', main: 'desktop/main.cjs' }, null, 2));
await cp('LICENSE', 'dist/LICENSE');
await cp('THIRD_PARTY_NOTICES.md', 'dist/THIRD_PARTY_NOTICES.md');
console.log(`Built Gopher ${pkg.version} (${commit.slice(0, 12)})`);
