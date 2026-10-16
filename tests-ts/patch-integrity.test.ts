import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Workspace, applyPatch } from '../server/tools/filesystem.js';

async function temporary(fn: (directory: string, ws: Workspace) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'gopher-patch-integrity-'));
  try { await fn(directory, await Workspace.open(directory)); }
  finally { await fs.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
}
const patch = (...lines: string[]) => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n');
const noNewline = '\\ No newline at end of file';

test('patch rejects invalid UTF-8 updates before committing any prepared changes, while allowing binary deletion', async () => temporary(async (directory, ws) => {
  const invalid = Buffer.concat([Buffer.from('edit me\n'), Buffer.from([255]), Buffer.from('\nkeep\n')]);
  await fs.writeFile(path.join(directory, 'bad.txt'), invalid);
  await fs.writeFile(path.join(directory, 'first.txt'), 'original\n');
  await assert.rejects(applyPatch(ws, patch('*** Update File: first.txt', '@@', '-original', '+prepared', '*** Update File: bad.txt', '@@', '-edit me', '+edited')), /not valid UTF-8/);
  assert.deepEqual(await fs.readFile(path.join(directory, 'bad.txt')), invalid);
  assert.equal(await fs.readFile(path.join(directory, 'first.txt'), 'utf8'), 'original\n');
  await applyPatch(ws, patch('*** Delete File: bad.txt'));
  await assert.rejects(fs.access(path.join(directory, 'bad.txt')), { code: 'ENOENT' });
}));

test('UTF-8 patch validation preserves an untouched byte order mark', async () => temporary(async (directory, ws) => {
  await fs.writeFile(path.join(directory, 'bom.txt'), Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from('keep\nold\n')]));
  await applyPatch(ws, patch('*** Update File: bom.txt', '@@', '-old', '+new'));
  assert.deepEqual(await fs.readFile(path.join(directory, 'bom.txt')), Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from('keep\nnew\n')]));
}));

test('a move cannot overwrite another operation prepared in the same patch', async () => temporary(async (directory, ws) => {
  await fs.writeFile(path.join(directory, 'source.txt'), 'original\n');
  await assert.rejects(applyPatch(ws, patch('*** Add File: destination.txt', '+new content', '*** Update File: source.txt', '*** Move to: destination.txt', '@@', '-original', '+moved content')), /pending change/);
  assert.equal(await fs.readFile(path.join(directory, 'source.txt'), 'utf8'), 'original\n');
  await assert.rejects(fs.access(path.join(directory, 'destination.txt')), { code: 'ENOENT' });
}));

test('numeric hunks validate both line counts and new offsets before writing', async () => temporary(async (directory, ws) => {
  await fs.writeFile(path.join(directory, 'file.txt'), 'before\n');
  await fs.writeFile(path.join(directory, 'first.txt'), 'original\n');
  for (const header of ['@@ -1,0 +1,1 @@', '@@ -1,1 +1,0 @@', '@@ -1,1 +99,1 @@']) {
    await assert.rejects(applyPatch(ws, patch('*** Update File: first.txt', '@@', '-original', '+prepared', '*** Update File: file.txt', header, '-before', '+after')), /count|offset/);
    assert.equal(await fs.readFile(path.join(directory, 'file.txt'), 'utf8'), 'before\n');
    assert.equal(await fs.readFile(path.join(directory, 'first.txt'), 'utf8'), 'original\n');
  }
  await fs.writeFile(path.join(directory, 'file.txt'), 'one\ntwo\nthree\n');
  await applyPatch(ws, patch('*** Update File: file.txt', '@@ -0,0 +1,1 @@', '+zero', '@@ -2,1 +2,0 @@', '-two'));
  assert.equal(await fs.readFile(path.join(directory, 'file.txt'), 'utf8'), 'zero\none\nthree\n');
}));

test('no-newline markers describe their preceding old, new, or context line independently', async () => temporary(async (directory, ws) => {
  const cases = [
    { original: 'a', tokens: ['-a', noNewline, '+b'], expected: 'b\n' },
    { original: 'a\n', tokens: ['-a', '+b', noNewline], expected: 'b' },
    { original: 'a', tokens: ['-a', noNewline, '+b', noNewline], expected: 'b' },
    { original: 'a', tokens: [' a', noNewline], expected: 'a' },
    { original: 'keep\r\na', tokens: ['-a', noNewline, '+b'], expected: 'keep\r\nb\r\n' },
  ];
  for (const item of cases) {
    await fs.writeFile(path.join(directory, 'file.txt'), item.original);
    await applyPatch(ws, patch('*** Update File: file.txt', '@@', ...item.tokens));
    assert.equal(await fs.readFile(path.join(directory, 'file.txt'), 'utf8'), item.expected);
  }
}));

test('invalid no-newline markers reject the entire patch without altering files', async () => temporary(async (directory, ws) => {
  await fs.writeFile(path.join(directory, 'file.txt'), 'a\nb\n');
  for (const tokens of [[noNewline, '-a', '+new'], ['-a', noNewline, '+new'], ['-a', '+new', noNewline], ['-b', '+new', noNewline, noNewline]]) {
    await assert.rejects(applyPatch(ws, patch('*** Update File: file.txt', '@@', ...tokens)), /no-newline|No-newline/);
    assert.equal(await fs.readFile(path.join(directory, 'file.txt'), 'utf8'), 'a\nb\n');
  }
}));
