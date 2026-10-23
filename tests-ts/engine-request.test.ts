import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChatRequest } from '../server/engine/request.js';

test('turn requests are validated at the boundary and unknown parameters pass through', () => {
  assert.throws(() => parseChatRequest(null), /messages must be a nonempty array/);
  assert.throws(() => parseChatRequest({ model: 'm', messages: [] }), /messages must be a nonempty array/);
  assert.throws(() => parseChatRequest({ model: 'm', messages: [{ content: 'no role' }] }), /Each message needs a role/);
  assert.throws(() => parseChatRequest({ model: ' ', messages: [{ role: 'user', content: 'x' }] }), /Choose a model/);
  assert.throws(() => parseChatRequest({ model: 'm', messages: [{ role: 'user' }], skills: 'all' }), /skills must be an object/);
  assert.throws(() => parseChatRequest({ model: 'm', messages: [{ role: 'user' }], provider_id: 7 }), /provider_id must be text/);
  const request = parseChatRequest({ model: 'm', messages: [{ role: 'user', content: 'x' }], temperature: 0.2, force_tools: ['web_search', 3] });
  assert.equal(request.temperature, 0.2);
  assert.deepEqual(request.force_tools, ['web_search']);
});
