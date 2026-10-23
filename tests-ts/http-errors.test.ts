import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorReply, HttpError } from '../server/http/protocol.js';
import { StoreError } from '../server/storage.js';

test('errors map to statuses by type instead of by message text', () => {
  assert.deepEqual(errorReply(new HttpError(409, 'Busy', 'busy')), { status: 409, error: 'Busy', code: 'busy', closeConnection: false });
  const locked = errorReply(new StoreError('Local data is encrypted. Unlock with your passphrase to continue.', 'encrypted_locked'));
  assert.equal(locked.status, 423); assert.equal(locked.code, 'encrypted_locked');
  assert.equal(errorReply(new StoreError('Invalid JSON file: x')).status, 400);
  // The old heuristic turned any message containing "locked" (even "blocked") into 423.
  assert.equal(errorReply(new Error('Private addresses are blocked')).status, 400);
  assert.equal(errorReply(Object.assign(new Error('A response is already in progress.'), { status: 409 })).status, 409);
  const network = errorReply(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED', address: '127.0.0.1', port: 9 }) }));
  assert.equal(network.status, 502); assert.equal(network.error, 'Connection refused at 127.0.0.1:9. Is the model server running?');
  assert.equal(errorReply(Object.assign(new TypeError('Invalid URL'), { code: 'ERR_INVALID_URL' })).status, 400);
  const bug = errorReply(new TypeError("Cannot read properties of undefined (reading 'x')"));
  assert.equal(bug.status, 500); assert.doesNotMatch(bug.error, /Cannot read/);
});
