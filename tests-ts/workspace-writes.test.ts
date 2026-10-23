import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace, executeFilesystem } from '../server/tools/filesystem.js';
import { atomicCreate, atomicWrite } from '../server/tools/workspace.js';

test('creating a file never clobbers one that already exists, and leaves no temporary files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gopher-ws-'));
  try {
    const ws = await Workspace.open(directory);
    const results = await Promise.allSettled([
      executeFilesystem(ws, 'write_file', { path: 'notes.txt', content: 'first' }),
      executeFilesystem(ws, 'write_file', { path: 'notes.txt', content: 'second' }),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.match(String((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason), /already exists/);
    assert.equal(await readFile(join(directory, 'notes.txt'), 'utf8'), 'first');
    await writeFile(join(directory, 'raced.txt'), 'created by someone else');
    await assert.rejects(atomicCreate(join(directory, 'raced.txt'), 'mine'), /already exists/);
    assert.equal(await readFile(join(directory, 'raced.txt'), 'utf8'), 'created by someone else');
    await atomicWrite(join(directory, 'raced.txt'), 'replaced on purpose');
    assert.equal(await readFile(join(directory, 'raced.txt'), 'utf8'), 'replaced on purpose');
    await executeFilesystem(ws, 'write_file', { path: 'notes.txt', content: 'overwritten', overwrite: true });
    assert.equal(await readFile(join(directory, 'notes.txt'), 'utf8'), 'overwritten');
    assert.deepEqual((await readdir(directory)).filter(name => name.endsWith('.tmp')), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
