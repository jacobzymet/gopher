// Diagnostics use a separate transport so capturing fetch/console never recurses.
const diagnosticFetch = window.fetch.bind(window);
let diagnosticQueue = [];
let diagnosticEntries = [];
let diagnosticTimingEntries = [];
let diagnosticGeneration = null;
let diagnosticLastId = 0;
let diagnosticPollBusy = false;
let diagnosticFlushBusy = false;
let diagnosticEpoch = 0;
let diagnosticPaused = false;
let diagnosticStatus = null;
let diagnosticDropped = 0;
let diagnosticVisibleLimit = 500;
const diagnosticDownloads = new Set();

function diagnosticsCaptureEnabled() {
  return !!settings.diagnosticsEnabled && storageReady && !diskEncryptionLocked();
}

function diagnosticSafeValue(value, seen = new WeakSet()) {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (typeof value === 'string') {
    if (value.length > 128 * 1024) return value.slice(0, 128 * 1024) + '\n[Browser value truncated]';
    return value;
  }
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => diagnosticSafeValue(item, seen));
  const result = {};
  for (const key of Object.keys(value)) {
    if (/authorization|cookie|passphrase|password|api.?key|access.?token|refresh.?token|^token$|secret/i.test(key)) result[key] = '[redacted]';
    else {
      try { result[key] = diagnosticSafeValue(value[key], seen); }
      catch { result[key] = '[Unreadable]'; }
    }
  }
  return result;
}

function diagnosticMark(event, data = {}, context = {}) {
  if (!diagnosticsCaptureEnabled()) return;
  try {
  if (diagnosticQueue.length >= 256) { diagnosticQueue.shift(); diagnosticDropped += 1; }
  diagnosticQueue.push({
    timestamp: Date.now(), level: context.level || 'debug', event,
    trace_id: context.traceId || '', conversation_id: context.convoId || '',
    elapsed_ms: Number.isFinite(context.startedAt) ? Math.max(0, Date.now() - context.startedAt) : null,
    data: diagnosticSafeValue(data),
  });
  } catch { diagnosticDropped += 1; }
}

function diagnosticStreamMark(stream, convo, event, data = {}) {
  if (stream.catchingUp && event.startsWith('browser.first_')) event = event.replace('browser.first_', 'browser.replay.first_');
  diagnosticMark(event, data, { traceId: stream.diagnosticTraceId || stream.turnId, convoId: convo.id, startedAt: stream.diagnosticStartedAt || stream.startedAt });
}

function clearDiagnosticsMemory() {
  diagnosticEpoch += 1;
  diagnosticQueue = [];
  diagnosticEntries = [];
  diagnosticTimingEntries = [];
  diagnosticGeneration = null;
  diagnosticLastId = 0;
  diagnosticStatus = null;
  diagnosticDropped = 0;
  diagnosticVisibleLimit = 500;
  diagnosticDownloads.forEach(url => URL.revokeObjectURL(url));
  diagnosticDownloads.clear();
  document.getElementById('diagnosticsFeed')?.replaceChildren();
  const timings = document.getElementById('diagnosticsTimings');
  if (timings) timings.textContent = '';
  const trace = document.getElementById('diagnosticsTrace');
  if (trace) trace.replaceChildren(new Option('All requests', ''));
}

function syncDiagnosticsCapture() {
  if (!settings.diagnosticsEnabled) diagnosticQueue = [];
  if ((settings.diagnosticsEnabled || diagnosticsPaneIsOpen()) && !diskEncryptionLocked()) void refreshDiagnostics();
}

async function flushDiagnostics() {
  if (diagnosticFlushBusy || !diagnosticsCaptureEnabled() || diagnosticGeneration == null || !diagnosticQueue.length) return;
  diagnosticFlushBusy = true;
  const epoch = diagnosticEpoch;
  const batch = [];
  let size = 0;
  while (diagnosticQueue.length && batch.length < 63) {
    const entry = diagnosticQueue[0];
    const bytes = new TextEncoder().encode(JSON.stringify(entry)).length;
    if (bytes > 512 * 1024) { diagnosticQueue.shift(); diagnosticDropped += 1; continue; }
    if (size + bytes > 512 * 1024) break;
    size += bytes;
    batch.push(diagnosticQueue.shift());
  }
  if (diagnosticDropped) batch.push({ event: 'browser.logs.dropped', level: 'warn', data: { entries: diagnosticDropped } });
  diagnosticDropped = 0;
  try {
    const response = await diagnosticFetch('/api/diagnostics', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ generation: diagnosticGeneration, entries: batch }),
      signal: AbortSignal.timeout(5000),
    });
    if (epoch !== diagnosticEpoch) return;
    if (response.status === 409) { diagnosticGeneration = null; void refreshDiagnostics(); return; }
    if (!response.ok) throw new Error('Log capture failed (' + response.status + ')');
  } catch (error) {
    if (epoch !== diagnosticEpoch || !diagnosticsCaptureEnabled()) return;
    diagnosticQueue = [...batch, ...diagnosticQueue].slice(-256);
    const status = document.getElementById('diagnosticsStatus');
    if (status) status.textContent = error.message;
  } finally { diagnosticFlushBusy = false; }
}

function diagnosticsPaneIsOpen() {
  return !!document.querySelector('.settings-pane[data-settings-pane="logs"].is-active')
    && !settingsModal.classList.contains('is-hidden');
}

async function refreshDiagnostics() {
  if (diagnosticPollBusy || !storageReady || diskEncryptionLocked()) return;
  diagnosticPollBusy = true;
  const epoch = diagnosticEpoch;
  try {
    const response = await diagnosticFetch('/api/diagnostics?after=' + diagnosticLastId, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Could not load logs (' + response.status + ')');
    const payload = await response.json();
    if (epoch !== diagnosticEpoch || diskEncryptionLocked()) return;
    if (diagnosticGeneration != null && (payload.generation !== diagnosticGeneration || payload.last_id < diagnosticLastId)) {
      diagnosticEntries = [];
      diagnosticQueue = [];
      diagnosticLastId = 0;
    }
    diagnosticGeneration = payload.generation;
    const entries = Array.isArray(payload.entries) ? payload.entries : [];
    diagnosticEntries.push(...entries);
    diagnosticEntries = diagnosticEntries.filter(entry => !payload.oldest_id || entry.id >= payload.oldest_id).slice(-2000);
    diagnosticLastId = payload.last_id || 0;
    diagnosticStatus = payload;
    diagnosticTimingEntries = Array.isArray(payload.timings) ? payload.timings : [];
    if (!diagnosticPaused && diagnosticsPaneIsOpen()) renderDiagnostics();
  } catch (error) {
    if (epoch !== diagnosticEpoch) return;
    const status = document.getElementById('diagnosticsStatus');
    if (status) status.textContent = error.message;
  } finally { diagnosticPollBusy = false; }
}

function renderDiagnosticTimings(entries, traceId) {
  const output = document.getElementById('diagnosticsTimings');
  if (!output) return;
  const traces = entries.filter(entry => entry.event === 'chat.request.dispatch');
  const id = traceId || traces.at(-1)?.trace_id;
  if (!id) { output.textContent = 'Enable logging, save, and send a prompt to measure the delay.'; return; }
  const trace = entries.filter(entry => entry.trace_id === id);
  const stages = [
    ['chat.request.dispatch', 'Request dispatched'], ['provider.prepare.finished', 'Provider ready'],
    ['provider.request', 'Upstream request'], ['provider.headers', 'Upstream headers'],
    ['provider.first_byte', 'Upstream first byte'], ['server.first_reasoning_token', 'Server first reasoning'],
    ['server.first_content_token', 'Server first content'], ['browser.first_reasoning_token', 'Browser first reasoning'],
    ['browser.first_content_token', 'Browser first content'],
    ['server.first_tool_token', 'Server first tool'], ['browser.first_tool_token', 'Browser first tool'],
  ];
  const times = stages.flatMap(([event, label]) => {
    const entry = trace.find(entry => entry.event === event && Number.isFinite(entry.elapsed_ms));
    if (!entry) return [];
    const origin = entry.source === 'browser' ? 'since Send' : 'since server received request';
    return [label + ': ' + Math.round(entry.elapsed_ms) + ' ms ' + origin];
  });
  const tokens = trace.filter(entry => entry.source === 'browser' && ['browser.first_reasoning_token', 'browser.first_content_token', 'browser.first_tool_token'].includes(entry.event) && Number.isFinite(entry.elapsed_ms));
  times.unshift(tokens.length
    ? 'TTFT: ' + Math.round(Math.min(...tokens.map(entry => entry.elapsed_ms))) + ' ms from Send to first reasoning/content/tool token'
    : 'TTFT: waiting for first reasoning/content/tool token');
  output.textContent = 'Request ' + id + '\n' + (times.join('\n') || 'Waiting for timing events…');
}

function renderDiagnostics() {
  const feed = document.getElementById('diagnosticsFeed');
  if (!feed) return;
  const status = document.getElementById('diagnosticsStatus');
  if (status && diagnosticStatus) status.textContent =
    (diagnosticStatus.enabled ? 'Logging on. ' : 'Logging off. ')
    + (diagnosticStatus.persisted ? 'Saved with encrypted local data. ' : 'Memory only; enable local-data encryption to save logs. ')
    + diagnosticEntries.length + ' entries. ' + (diagnosticStatus.dropped ? diagnosticStatus.dropped + ' older entries rotated. ' : '')
    + (diagnosticStatus.error || '');
  const select = document.getElementById('diagnosticsTrace');
  const current = select.value;
  const timings = [...diagnosticTimingEntries, ...diagnosticEntries];
  const traceIds = [...new Set(timings.filter(entry => entry.event === 'chat.request.dispatch').map(entry => entry.trace_id))].reverse().slice(0, 30);
  if (current && !traceIds.includes(current)) traceIds.push(current);
  select.replaceChildren(new Option('All requests', ''), ...traceIds.map(id => new Option(id, id)));
  select.value = current;
  renderDiagnosticTimings(timings, current);
  const search = document.getElementById('diagnosticsSearch').value.trim().toLowerCase();
  const level = document.getElementById('diagnosticsLevel').value;
  const entries = diagnosticEntries.filter(entry => (!level || entry.level === level) && (!current || entry.trace_id === current)
    && (!search || [entry.event, entry.source, entry.trace_id, entry.conversation_id, entry.data].join(' ').toLowerCase().includes(search)));
  const openIds = new Set([...feed.querySelectorAll('details[open]')].map(item => item.dataset.id));
  feed.replaceChildren();
  for (const entry of entries.slice(-diagnosticVisibleLimit).reverse()) {
    const item = document.createElement('details');
    item.className = 'diagnostic-entry is-' + entry.level;
    item.dataset.id = String(entry.id);
    item.open = openIds.has(String(entry.id));
    const summary = document.createElement('summary');
    const time = document.createElement('time');
    time.dateTime = new Date(entry.timestamp).toISOString();
    time.textContent = new Date(entry.timestamp).toLocaleTimeString(undefined, { hour12: false }) + '.' + String(entry.timestamp % 1000).padStart(3, '0');
    const title = document.createElement('strong');
    title.textContent = entry.event;
    const meta = document.createElement('span');
    meta.className = 'diagnostic-meta';
    meta.textContent = [entry.level, entry.source, Number.isFinite(entry.elapsed_ms) ? '+' + Math.round(entry.elapsed_ms) + ' ms' : '', entry.trace_id].filter(Boolean).join(' · ');
    summary.append(time, title, meta);
    const body = document.createElement('pre');
    const fillBody = () => {
      if (item.open && !body.textContent) body.textContent = entry.data + (entry.truncated_bytes ? '\n[Truncated ' + entry.truncated_bytes + ' bytes]' : '');
    };
    item.addEventListener('toggle', fillBody);
    fillBody();
    item.append(summary, body);
    feed.appendChild(item);
  }
  if (entries.length > diagnosticVisibleLimit) {
    const more = document.createElement('button');
    more.type = 'button'; more.className = 'btn btn-ghost';
    more.textContent = 'Show ' + Math.min(500, entries.length - diagnosticVisibleLimit) + ' earlier entries';
    more.addEventListener('click', () => { diagnosticVisibleLimit += 500; renderDiagnostics(); });
    feed.appendChild(more);
  }
  if (!entries.length) {
    const empty = document.createElement('p'); empty.className = 'diagnostics-empty';
    empty.textContent = diagnosticEntries.length ? 'No matching logs.' : 'No logs captured yet.'; feed.appendChild(empty);
  }
}

async function clearStoredDiagnostics() {
  if (!requireUnlockedData()) return;
  clearDiagnosticsMemory();
  const epoch = diagnosticEpoch;
  const response = await diagnosticFetch('/api/diagnostics', { method: 'DELETE', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Could not clear logs');
  const payload = await response.json();
  if (epoch !== diagnosticEpoch) return;
  diagnosticGeneration = payload.generation;
  diagnosticStatus = payload;
  renderDiagnostics();
}

async function exportDiagnostics() {
  if (!requireUnlockedData()) return;
  await flushDiagnostics(); await refreshDiagnostics();
  if (diskEncryptionLocked()) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, exported_at: new Date().toISOString(), ...diagnosticStatus, entries: diagnosticEntries, timings: diagnosticTimingEntries }, null, 2)], { type: 'application/json' }));
  diagnosticDownloads.add(url);
  const link = document.createElement('a'); link.href = url; link.download = 'gopher-diagnostics-' + Date.now() + '.json'; link.click();
  setTimeout(() => { URL.revokeObjectURL(url); diagnosticDownloads.delete(url); }, 1000);
}

for (const name of ['debug', 'log', 'info', 'warn', 'error', 'trace']) {
  const original = console[name].bind(console);
  console[name] = (...args) => {
    original(...args);
    diagnosticMark('console.' + name, { arguments: args }, { level: name === 'log' ? 'info' : name });
  };
}
window.addEventListener('error', event => diagnosticMark('browser.error', { message: event.message, file: event.filename, line: event.lineno, error: event.error }, { level: 'error' }));
window.addEventListener('unhandledrejection', event => diagnosticMark('browser.unhandledrejection', { reason: event.reason }, { level: 'error' }));

window.fetch = async (input, init) => {
  if (!diagnosticsCaptureEnabled()) return diagnosticFetch(input, init);
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/diagnostics')) return diagnosticFetch(input, init);
  const started = performance.now();
  const captureEpoch = diagnosticEpoch;
  let payload;
  if (url.pathname === '/api/chat/completions' && typeof init?.body === 'string') {
    try { payload = JSON.parse(init.body); } catch {}
  }
  const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
  const traceId = payload?.turn_id || headers.get('x-gopher-request-id') || ('request-' + crypto.randomUUID());
  const context = { traceId, convoId: payload?.conversation_id || '' };
  headers.set('x-gopher-request-id', traceId);
  if (context.convoId) headers.set('x-gopher-conversation-id', context.convoId);
  diagnosticMark('fetch.request', { method: init?.method || 'GET', path: url.pathname, ...(payload ? { body: payload } : {}) }, context);
  try {
    const response = await diagnosticFetch(input, { ...init, headers });
    if (captureEpoch !== diagnosticEpoch) return response;
    diagnosticMark('fetch.headers', { path: url.pathname, status: response.status, duration_ms: performance.now() - started }, context);
    if (response.headers.get('content-type')?.includes('application/json') && !url.pathname.startsWith('/api/data/') && !url.pathname.startsWith('/api/subscription/')) {
      void response.clone().text().then(text => {
        if (captureEpoch !== diagnosticEpoch) return;
        let body; try { body = JSON.parse(text); } catch { body = text; }
        diagnosticMark('fetch.response', { path: url.pathname, body, duration_ms: performance.now() - started }, context);
      }).catch(() => {});
    }
    return response;
  } catch (error) {
    if (captureEpoch === diagnosticEpoch) diagnosticMark('fetch.error', { path: url.pathname, duration_ms: performance.now() - started, error }, { ...context, level: 'error' });
    throw error;
  }
};

['diagnosticsSearch', 'diagnosticsLevel', 'diagnosticsTrace'].forEach(id => document.getElementById(id)?.addEventListener('input', renderDiagnostics));
document.getElementById('btnDiagnosticsPause')?.addEventListener('click', event => {
  diagnosticPaused = !diagnosticPaused; event.currentTarget.textContent = diagnosticPaused ? 'Resume view' : 'Pause view';
  if (!diagnosticPaused) { renderDiagnostics(); void refreshDiagnostics(); }
});
document.getElementById('btnDiagnosticsClear')?.addEventListener('click', () => clearStoredDiagnostics().catch(error => showAttachHint(error.message)));
document.getElementById('btnDiagnosticsExport')?.addEventListener('click', () => exportDiagnostics().catch(error => showAttachHint(error.message)));
setInterval(() => { if (diagnosticsCaptureEnabled()) void flushDiagnostics(); }, 500);
setInterval(() => { if ((diagnosticsCaptureEnabled() || diagnosticsPaneIsOpen()) && !diagnosticPaused) void refreshDiagnostics(); }, 1000);
window.addEventListener('pagehide', () => { if (diagnosticsCaptureEnabled()) void flushDiagnostics(); });
