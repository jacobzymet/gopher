import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync, version as esbuildVersion } from 'esbuild';

const manifestPath = new URL('./backport.json', import.meta.url);
const sourcePath = new URL('./katex.patched.js', import.meta.url);
const outputPath = new URL('../katex.min.js', import.meta.url);
const digest = value => createHash('sha256').update(value).digest('hex');

export function applyBackport(original, manifest) {
  assert.equal(digest(original), manifest.inputSha256, 'Unexpected upstream source bytes');
  let source = original;
  for (const patch of manifest.patches) {
    assert.equal(source.split(patch.before).length, 2, `Patch must match exactly once: ${patch.path}`);
    source = source.replace(patch.before, patch.after);
  }
  assert.equal(digest(source), manifest.patchedSha256, 'Patched source hash mismatch');
  return source;
}

export async function rebuild({ archive, fetchUpstream = false, write = false } = {}) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(esbuildVersion, manifest.esbuildVersion, 'Use the pinned npm lockfile to reproduce this build');
  assert.equal(digest(await readFile(new URL('./upstream-security.patch', import.meta.url))), manifest.upstreamPatchSha256);
  const checkedInSource = await readFile(sourcePath, 'utf8');
  assert.equal(digest(checkedInSource), manifest.patchedSha256);
  if (archive || fetchUpstream) {
    let bytes;
    if (archive) bytes = await readFile(archive);
    else {
      const response = await fetch(manifest.upstreamRelease.tarball);
      assert.ok(response.ok, `Upstream archive request failed: ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
    }
    assert.equal('sha512-' + createHash('sha512').update(bytes).digest('base64'), manifest.upstreamRelease.integrity, 'Upstream npm archive integrity mismatch');
    const extracted = spawnSync('tar', ['-xzOf', '-', manifest.sourceEntry], { input: bytes, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    if (extracted.error) throw extracted.error;
    assert.equal(extracted.status, 0, String(extracted.stderr));
    assert.equal(applyBackport(extracted.stdout.toString('utf8'), manifest), checkedInSource);
  }
  const output = transformSync(checkedInSource, { loader: 'js', target: manifest.target, minify: true, legalComments: 'none', banner: manifest.banner }).code;
  assert.equal(digest(output), manifest.outputSha256, 'Rebuilt output hash mismatch');
  if (write) await writeFile(outputPath, output);
  else assert.equal(await readFile(outputPath, 'utf8'), output, 'Vendored output does not match the reproducible build');
  return { version: manifest.version, sha256: manifest.outputSha256 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), archiveAt = args.indexOf('--archive');
  const result = await rebuild({ archive: archiveAt < 0 ? undefined : args[archiveAt + 1], fetchUpstream: args.includes('--fetch-upstream'), write: args.includes('--write') });
  console.log(`${result.version}: ${result.sha256}`);
}
