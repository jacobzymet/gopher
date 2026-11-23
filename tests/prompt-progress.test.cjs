// Run without compiling the app: node --test tests/prompt-progress.test.cjs
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const runtime = fs.readFileSync('src/ui/chat/scripts/runtime.js', 'utf8');
const start = runtime.indexOf('function promptProgressLabel(');
const end = runtime.indexOf('\nfunction syncStreamSpeakerChrome', start);
assert.ok(start >= 0 && end > start);

const context = vm.createContext({});
vm.runInContext(runtime.slice(start, end) + '\nthis.promptProgressLabel = promptProgressLabel;', context);

test('prompt progress reports percentage, tokens, and cache', () => {
  assert.equal(
    context.promptProgressLabel({ total: 2048, processed: 1024, cache: 512 }),
    'Processing prompt · 50% · 1,024/2,048 tokens · 512 cached'
  );
});

test('prompt progress clamps values and rejects malformed frames', () => {
  assert.equal(context.promptProgressLabel({ total: 10, processed: 12, cache: 0 }), 'Processing prompt · 100% · 10/10 tokens');
  assert.equal(context.promptProgressLabel({ total: 0, processed: 0 }), '');
  assert.equal(context.promptProgressLabel({ total: 10, processed: 'nope' }), '');
  assert.equal(context.promptProgressLabel(null), '');
});
