'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const render = fs.readFileSync('src/ui/chat/scripts/render.js', 'utf8').replace(/\r\n/g, '\n');
const helperStart = render.indexOf('function formatTokPerSec(');
const helperEnd = render.indexOf('\nfunction ingestStreamUsage(', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart);

const context = vm.createContext({});
vm.runInContext(
  render.slice(helperStart, helperEnd)
    + '\nthis.formatWorkDuration = formatWorkDuration; this.workDurationMs = workDurationMs;',
  context
);

test('formats total work time compactly', () => {
  assert.equal(context.formatWorkDuration(400), '1s');
  assert.equal(context.formatWorkDuration(59_000), '59s');
  assert.equal(context.formatWorkDuration(65_000), '1m 5s');
  assert.equal(context.formatWorkDuration(3_600_000), '1h');
  assert.equal(context.formatWorkDuration(3_660_000), '1h 1m');
});

test('measures the complete turn interval safely', () => {
  assert.equal(context.workDurationMs(1_000, 8_654), 7_654);
  assert.equal(context.workDurationMs(0, 8_654), null);
  assert.equal(context.workDurationMs(9_000, 8_654), null);
});

test('persists work time for completed and stopped responses', () => {
  const runtime = fs.readFileSync('src/ui/chat/scripts/runtime.js', 'utf8');
  assert.match(runtime, /const workStartedAt = Date\.now\(\);/);
  assert.match(runtime, /turnStartedAt: workStartedAt/);
  assert.equal((runtime.match(/message\.workDurationMs = totalWorkMs/g) || []).length, 2);
  assert.match(render, /msg-meta-duration/);
});
