import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serverRuntime } from '../desktop/runtime.js';

test('the desktop server uses real system Node instead of Electron native-addon ABI', async () => {
  const actual = await serverRuntime({ ...process.env, GOPHER_NODE_EXECUTABLE: process.execPath });
  assert.equal(actual, process.execPath);
});

test('desktop runtime discovery prefers the installer and npm Node paths and clears Electron mode', async () => {
  const inspected: string[] = [];
  const inspect = async (candidate: string, env: NodeJS.ProcessEnv) => {
    inspected.push(candidate); assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
    return { executable: '/verified/node', node: '24.7.0' };
  };
  assert.equal(await serverRuntime({ GOPHER_NODE_EXECUTABLE: '/installed/node', npm_node_execpath: '/npm/node', ELECTRON_RUN_AS_NODE: '1' }, inspect), '/verified/node');
  assert.deepEqual(inspected, ['/installed/node']); inspected.length = 0;
  await serverRuntime({ npm_node_execpath: '/npm/node' }, inspect); assert.deepEqual(inspected, ['/npm/node']);
});

test('invalid explicit runtimes fail clearly and discovery rejects Electron and old Node', async () => {
  for (const invalid of [{ executable: '/electron', node: '24.20.0', electron: '44.3.0' }, { executable: '/old/node', node: '24.6.0' }]) {
    await assert.rejects(serverRuntime({ GOPHER_NODE_EXECUTABLE: invalid.executable }, async () => invalid), /requires Node.js 24.7/);
  }
  const inspected: string[] = [];
  const executable = await serverRuntime({ npm_node_execpath: '/missing/node' }, async candidate => {
    inspected.push(candidate); if (candidate !== 'node') throw new Error('Missing executable');
    return { executable: '/path/node', node: '26.1.0' };
  });
  assert.equal(executable, '/path/node'); assert.deepEqual(inspected, ['/missing/node', 'node']);
});
