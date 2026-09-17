// Run without compiling the app: node --test tests/tool-activity.test.cjs
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const root = join(__dirname, '..');
const render = readFileSync(join(root, 'src/ui/chat/scripts/render.js'), 'utf8').replace(/\r\n/g, '\n');
const runtime = readFileSync(join(root, 'src/ui/chat/scripts/runtime.js'), 'utf8').replace(/\r\n/g, '\n');

// Exercise the shipped functions, without bootstrapping the rest of the UI.
function declaration(source, name) {
  const match = source.match(new RegExp('^function ' + name + '\\([\\s\\S]*?^\\}$', 'm'));
  assert.ok(match, 'missing function ' + name);
  return match[0];
}

function harness(timeline = []) {
  const context = vm.createContext({
    stream: { timeline },
    convo: {},
    typer: { shown: '' },
    scheduleJustSettledClear() {},
    paintStreamIntoView() {},
    escapeHtml: (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    THINK_CHEVRON: '',
  });
  for (const name of [
    'agentStepRailHtml', 'wrapTimelineStep', 'skillLabel', 'toolBodyFromArgs',
    'skillLiveVerb', 'liveToolStatusLabel', 'liveToolStatusText', 'skillToolIcon', 'formatToolElapsed', 'toolDurationMs',
    'skillDetailLabel', 'agentStepResultHtml', 'agentStepHtml',
  ]) vm.runInContext(declaration(render, name), context);
  vm.runInContext(declaration(render, 'stampTimelinePart'), context);
  vm.runInContext(declaration(runtime, 'timelineSignature'), context);
  vm.runInContext(declaration(runtime, 'timelineOrderSignature'), context);
  vm.runInContext(declaration(runtime, 'setStreamThinkingLabel'), context);

  const eventStart = runtime.indexOf('  const onAgentEvent = (payload) => {');
  const eventEnd = runtime.indexOf('  if (stream.catchingUp)', eventStart);
  assert.ok(eventStart >= 0 && eventEnd > eventStart);
  vm.runInContext(runtime.slice(eventStart, eventEnd) + '\nthis.onAgentEvent = onAgentEvent;', context);

  const persistStart = runtime.indexOf('  const persistedParts = stream.timeline.length');
  const persistEnd = runtime.indexOf('  if (viewing && dom)', persistStart);
  assert.ok(persistStart >= 0 && persistEnd > persistStart);
  vm.runInContext('function persist() {\n' + runtime.slice(persistStart, persistEnd) + '\nreturn persistedParts;\n}', context);
  return context;
}

function sealedHarness() {
  const context = vm.createContext({});
  for (const name of [
    'trailingLiveToolIndex',
    'stampTimelinePart',
    'insertTimelinePartBeforeTrailingLiveTools',
    'sealedTimelineMergeTarget',
    'ensureSealedTimelineThink',
    'ensureSealedTimelineText',
  ]) vm.runInContext(declaration(render, name), context);
  return context;
}

test('failed edits remain failed through SSE, persistence, and rendering', () => {
  const context = harness([{ type: 'tool', id: 'edit', name: 'str_replace', live: true, startedAt: Date.now() }]);
  context.onAgentEvent({ phase: 'tool_result', id: 'edit', name: 'str_replace', ok: false, result: 'old_string was not found' });
  assert.equal(context.stream.timeline[0].ok, false);
  assert.equal(context.stream.timeline[0].live, false);
  const persisted = JSON.parse(JSON.stringify(context.persist()))[0];
  assert.equal(persisted.ok, false);
  const html = context.agentStepHtml(persisted);
  assert.match(html, /class="agent-step is-failed"/);
  assert.match(html, />Failed<\/span>/);
  assert.doesNotMatch(html, /is-done|is-just-done/);
});

test('terminal failures without a preceding live card retain their id and status', () => {
  const context = harness();
  context.onAgentEvent({ phase: 'tool_result', id: 'terminal', name: 'run_terminal', ok: false, result: 'exit: 7' });
  assert.equal(context.stream.timeline[0].id, 'terminal');
  assert.equal(context.stream.timeline[0].ok, false);
  assert.match(context.agentStepHtml(context.persist()[0]), /is-failed/);
});

test('denied calls stay denied after the chat is saved', () => {
  const context = harness();
  context.onAgentEvent({ phase: 'tool_result', id: 'write', name: 'write_file', ok: false, result: 'The user denied this tool call.' });
  const persisted = context.persist()[0];
  assert.equal(persisted.approval, 'denied');
  assert.match(context.agentStepHtml(persisted), />Denied<\/span>/);
});

test('successful calls clear stale failure notes and render a success marker', () => {
  const context = harness([{ type: 'tool', id: 'read', name: 'read_file', live: true, ok: false, note: 'Tool failed' }]);
  context.onAgentEvent({ phase: 'tool_result', id: 'read', name: 'read_file', ok: true, result: 'content' });
  const part = context.persist()[0];
  assert.equal(part.ok, true);
  assert.equal(part.note, undefined);
  assert.match(context.agentStepHtml(part), /class="agent-step is-done"/);
  assert.doesNotMatch(context.agentStepHtml(part), /is-failed|>Failed<\/span>/);
});

test('failure status invalidates the activity rendering signature', () => {
  const context = harness();
  const part = { type: 'tool', name: 'run_terminal', result: 'output', live: false };
  assert.notEqual(context.timelineSignature([{ ...part, ok: true }]), context.timelineSignature([{ ...part, ok: false }]));
});

test('reasoning snapshots never merge backward across a completed tool', () => {
  const context = sealedHarness();
  const stream = {
    timeline: [
      { type: 'think', content: 'Before the approval.' },
      { type: 'tool', id: 'write', live: false },
    ],
  };
  context.ensureSealedTimelineThink(stream, 'After the approval.');
  assert.equal(stream.timeline[0].content, 'Before the approval.');
  assert.equal(stream.timeline[1].id, 'write');
  assert.equal(stream.timeline[2].type, 'think');
  assert.equal(stream.timeline[2].content, 'After the approval.');
});

test('a same-round snapshot can still complete reasoning before live approval cards', () => {
  const context = sealedHarness();
  const stream = {
    timeline: [
      { type: 'think', content: 'Checking' },
      { type: 'tool', id: 'write', live: true, approval: 'pending' },
    ],
  };
  context.ensureSealedTimelineThink(stream, 'Checking the file first');
  assert.equal(stream.timeline.length, 2);
  assert.equal(stream.timeline[0].content, 'Checking the file first');
  assert.equal(stream.timeline[1].id, 'write');
});

test('late same-round reasoning lands before trailing live tools, not after', () => {
  const context = sealedHarness();
  const stream = {
    timeline: [
      { type: 'tool', id: 'a', name: 'web_search', live: true },
      { type: 'tool', id: 'b', name: 'web_search', live: true },
    ],
  };
  context.ensureSealedTimelineThink(stream, 'Looking these up');
  assert.equal(stream.timeline[0].type, 'think');
  assert.equal(stream.timeline[0].content, 'Looking these up');
  assert.equal(stream.timeline[1].id, 'a');
  assert.equal(stream.timeline[2].id, 'b');
});

test('commitStreamBuffer seals think before already-announced live tools', () => {
  const context = vm.createContext({
    isThinkingOpen: () => false,
    applyMemoryUpdateProtocol: (text) => ({ cleaned: text }),
    parseThinkSegments: (text) => [{ type: 'think', content: text }],
  });
  for (const name of [
    'trailingLiveToolIndex',
    'stampTimelinePart',
    'insertTimelinePartBeforeTrailingLiveTools',
    'commitStreamBuffer',
  ]) vm.runInContext(declaration(render, name), context);
  const stream = {
    timeline: [
      { type: 'tool', id: 'a', live: true },
      { type: 'tool', id: 'b', live: true },
    ],
    partial: 'x',
  };
  const typer = {
    target: 'Searching in parallel',
    clear() { this.target = ''; },
  };
  context.commitStreamBuffer(stream, typer);
  assert.equal(stream.timeline[0].type, 'think');
  assert.equal(stream.timeline[0].content, 'Searching in parallel');
  assert.equal(stream.timeline[1].id, 'a');
  assert.equal(stream.timeline[2].id, 'b');
});

test('timeline order signature stays stable when a live tool completes', () => {
  const context = harness();
  const live = [
    { type: 'tool', id: 's1', name: 'web_search', live: true, startedAt: 1 },
    { type: 'tool', id: 's2', name: 'web_search', live: true, startedAt: 2 },
  ];
  const after = [
    { ...live[0] },
    { ...live[1], live: false, result: 'done', ok: true },
  ];
  assert.equal(context.timelineOrderSignature(live), context.timelineOrderSignature(after));
  assert.notEqual(context.timelineSignature(live), context.timelineSignature(after));
});

test('parallel same-name results settle the matching live card, not the first', () => {
  const context = harness([
    { type: 'tool', id: 's1', name: 'web_search', live: true },
    { type: 'tool', id: 's2', name: 'web_search', live: true },
  ]);
  context.onAgentEvent({ phase: 'tool_result', id: 's2', name: 'web_search', ok: true, result: 'second' });
  assert.equal(context.stream.timeline[0].live, true);
  assert.equal(context.stream.timeline[0].result, undefined);
  assert.equal(context.stream.timeline[1].live, false);
  assert.equal(context.stream.timeline[1].result, 'second');
});

test('live tools and legacy saved cards remain compatible', () => {
  const context = harness();
  assert.match(context.agentStepHtml({ name: 'read_file', live: true }), /class="agent-step is-live"/);
  assert.match(context.agentStepHtml({ name: 'read_file', live: false }), /class="agent-step is-done"/);
});

test('yielded commands persist as running, never as successful completion', () => {
  const context = harness();
  context.onAgentEvent({ phase: 'tool_result', id: 'start', name: 'run_terminal', ok: true, running: true, command_session_id: 'cmd_1', result: 'exit: running' });
  const part = context.persist()[0];
  assert.equal(part.running, true);
  assert.equal(part.commandSessionId, 'cmd_1');
  const html = context.agentStepHtml(part);
  assert.match(html, /is-running/);
  assert.match(html, />Running<\/span>/);
  assert.doesNotMatch(html, /is-done|is-just-done|is-failed/);
  assert.notEqual(context.timelineSignature([part]), context.timelineSignature([{ ...part, running: false }]));
});

test('a final poll settles only earlier cards belonging to the same session', () => {
  const context = harness([
    { type: 'tool', id: 'a', name: 'run_terminal', commandSessionId: 'cmd_1', running: true, live: false, ok: true },
    { type: 'tool', id: 'b', name: 'run_terminal', commandSessionId: 'cmd_2', running: true, live: false, ok: true },
  ]);
  context.onAgentEvent({ phase: 'tool_result', id: 'poll', name: 'wait_terminal', command_session_id: 'cmd_1', running: false, ok: false, result: 'exit: 7' });
  const parts = context.persist();
  assert.equal(parts[0].running, false);
  assert.equal(parts[0].ok, false);
  assert.equal(parts[1].running, true);
  assert.match(context.agentStepHtml(parts[0]), /is-failed/);
  assert.match(context.agentStepHtml(parts[2]), /is-failed/);
});

test('patch approval renders the complete patch and completed previews disclose truncation', () => {
  const context = harness();
  const patch = '*** Begin Patch\n*** Add File: a.txt\n+' + 'x'.repeat(21000) + '\n+REVIEW_THIS_TAIL\n*** End Patch';
  assert.equal(context.toolBodyFromArgs('apply_patch', { patch }), patch);
  const pending = context.agentStepHtml({ name: 'apply_patch', args: { patch }, live: true, approval: 'pending' });
  assert.match(pending, /Apply patch/);
  assert.match(pending, /REVIEW_THIS_TAIL/);
  assert.doesNotMatch(pending, /Preview truncated/);
  assert.match(context.agentStepHtml({ name: 'apply_patch', args: { patch }, live: false }), /Preview truncated/);
  assert.equal(context.skillLabel('read_tool_history'), 'Read tool history');
});
