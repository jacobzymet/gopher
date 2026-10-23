import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../server/engine.js';
import type { Providers, ProviderEvent } from '../server/providers.js';
import { needsApproval } from '../server/tools/definitions.js';

test('approval policies distinguish safe tools, mutations, and explicit full auto-approval', () => {
  for (const name of ['read_file', 'web_search', 'fetch_url', 'browser_click', 'activate_skill']) {
    assert.equal(needsApproval(name, 'auto_safe'), false, name);
    assert.equal(needsApproval(name, 'manual'), true, name);
    assert.equal(needsApproval(name, 'auto_all'), false, name);
    assert.equal(needsApproval(name, 'invalid'), true, name);
  }
  for (const name of ['write_file', 'str_replace', 'delete_file', 'apply_patch', 'run_terminal']) {
    assert.equal(needsApproval(name, 'auto_safe'), true, name);
    assert.equal(needsApproval(name, 'manual'), true, name);
    assert.equal(needsApproval(name, 'auto_all'), false, name);
    assert.equal(needsApproval(name, 'invalid'), true, name);
  }
});

async function runTools(mode?: string, enabled = true) {
  const provider = { id: 'fixture', name: 'Fixture', base: 'http://localhost/v1', token: '',
    api_style: 'openai', kind: 'custom', allow_insecure_tls: false };
  let round = 0;
  const providers = {
    get: () => provider, catalog: async () => [],
    complete: async function* (): AsyncIterable<ProviderEvent> {
      if (round++ === 0) {
        for (const [index, name] of ['read_file', 'write_file', 'delete_file', 'run_terminal'].entries()) {
          yield { type: 'tool', index, id: `call_${index}`, name, arguments: '{}' };
        }
      } else yield { type: 'text', text: 'Done' };
    },
  } as unknown as Providers;
  const executed: string[] = [], approvals: string[] = [];
  const engine = new Engine({ providers, executeTool: async (_context, call) => {
    executed.push(call.name);
    return { ok: true, text: 'ok' };
  } });
  let output = '';
  try {
    for await (const frame of engine.start({ model: 'model', agent: true,
      skills: { filesystem: enabled, terminal: enabled, workspace_root: process.cwd(),
        ...(mode === undefined ? {} : { approval_mode: mode }) },
      messages: [{ role: 'user', content: 'Use tools' }] })) {
      output += frame;
      if (!frame.startsWith('event: agent')) continue;
      const event = JSON.parse(frame.split('data: ')[1]);
      if (event.phase === 'tool_approval') {
        approvals.push(event.name);
        engine.approve(event.id, false);
      }
    }
    return { executed, approvals, output };
  } finally { await engine.cancelAll(); }
}

test('approve-all runs enabled mutations and commands without approval prompts', { timeout: 5000 }, async () => {
  const result = await runTools('auto_all');
  assert.deepEqual(result.executed, ['read_file', 'write_file', 'delete_file', 'run_terminal']);
  assert.deepEqual(result.approvals, []);
  assert.match(result.output, /Done/);
});

test('an unset policy defaults to safe auto-approval and still pauses mutations', { timeout: 5000 }, async () => {
  const result = await runTools();
  assert.deepEqual(result.executed, ['read_file']);
  assert.deepEqual(result.approvals, ['write_file', 'delete_file', 'run_terminal']);
});

test('approve-all cannot enable disabled capabilities', { timeout: 5000 }, async () => {
  const result = await runTools('auto_all', false);
  assert.deepEqual(result.executed, []);
  assert.match(result.output, /unavailable or disabled/);
});
