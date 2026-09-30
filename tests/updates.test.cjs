const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../src/ui/chat/scripts/runtime.js'), 'utf8');
const updateCode = source.slice(source.indexOf("const updateToast ="), source.indexOf('(async () => {', source.indexOf("const updateToast =")));
const commit = '0123456789abcdef0123456789abcdef01234567';
const offer = { current: 'master@111111111111', latest: commit, update_available: true, can_install: true, commit_url: 'https://github.com/jacobzymet/gopher/commit/' + commit };

function harness(fetch = async () => ({ ok: true, json: async () => offer })) {
  const elements = {};
  const context = vm.createContext({
    settings: {}, latestState: {}, fetch,
    document: { getElementById(id) {
      const classes = new Set();
      return elements[id] ||= {
        hidden: true, disabled: false, textContent: '', dataset: {},
        classList: { add: (...names) => names.forEach((name) => classes.add(name)), remove: (...names) => names.forEach((name) => classes.delete(name)), contains: (name) => classes.has(name) },
        addEventListener() {}, setAttribute() {}, removeAttribute() {},
      };
    } },
    afterNextPaint(fn) { fn(); }, setTimeout() {}, saveSettings() {},
  });
  vm.runInContext(updateCode, context);
  return { context, elements };
}

test('commit identity and master update replace numerical release labels', () => {
  const { context, elements } = harness();
  context.renderAppUpdatePane(offer);
  assert.equal(elements.appUpdateCurrent.textContent, 'Gopher master@111111111111');
  assert.match(elements.appUpdateStatus.textContent, /Build master@0123456789ab locally with Rust/);
  assert.equal(elements.btnAppUpdateInstall.textContent, 'Build and restart');
  assert.equal(elements.btnAppUpdateNotes.href, offer.commit_url);
  context.renderAppUpdatePane({ ...offer, update_available: false });
  assert.match(elements.appUpdateStatus.textContent, /current master commit/);
  assert.equal(elements.btnAppUpdateInstall.hidden, true);
});

test('missing Rust and check errors are visible and cannot enable a build', () => {
  const { context, elements } = harness();
  context.renderAppUpdatePane({ ...offer, can_install: false, install_blocked: 'Install Rust with Cargo.' });
  assert.match(elements.appUpdateStatus.textContent, /Install Rust with Cargo/);
  assert.equal(elements.btnAppUpdateInstall.hidden, true);
  context.renderAppUpdatePane({ ...offer, can_install: false, error: 'GitHub returned HTTP 404' });
  assert.equal(elements.appUpdateStatus.textContent, 'GitHub returned HTTP 404');
  context.renderAppUpdatePane(null);
  assert.equal(elements.appUpdateStatus.textContent, 'Could not check master on GitHub.');
});

test('dismissal applies to one full commit rather than all future updates', () => {
  const { context, elements } = harness();
  context.settings.updateDismissed = commit;
  context.showUpdateToast(offer);
  assert.equal(elements.updateToast.hidden, true);
  context.showUpdateToast({ ...offer, latest: 'f'.repeat(40) });
  assert.equal(elements.updateToast.hidden, false);
  assert.equal(elements.updateToast.dataset.latest, 'f'.repeat(40));
  assert.equal(elements.btnUpdateView.textContent, 'View commit');
});

test('a failed build restores controls and reports the build error', async () => {
  let resolve;
  let calls = 0;
  const { context, elements } = harness(() => { calls++; return new Promise((done) => { resolve = done; }); });
  vm.runInContext('lastAppUpdateStatus = ' + JSON.stringify(offer), context);
  context.renderAppUpdatePane(offer);
  const pending = context.installAppUpdate();
  assert.match(elements.appUpdateStatus.textContent, /Building master@0123456789ab locally/);
  assert.equal(elements.btnAppUpdateCheck.disabled, true);
  assert.equal(elements.btnAppUpdateInstall.textContent, 'Building…');
  await context.installAppUpdate();
  assert.equal(calls, 1);
  resolve({ ok: false, json: async () => ({ error: 'The local build failed: linker missing' }) });
  await pending;
  assert.match(elements.appUpdateStatus.textContent, /linker missing/);
  assert.equal(elements.btnAppUpdateCheck.disabled, false);
  assert.equal(elements.btnAppUpdateInstall.textContent, 'Build and restart');
});

test('fresh check uses force and removes a stale update notice', async () => {
  let url;
  const { context, elements } = harness(async (requested) => { url = requested; return { ok: true, json: async () => ({ ...offer, update_available: false }) }; });
  context.showUpdateToast(offer);
  await context.checkForAppUpdate({ force: true });
  assert.equal(url, '/api/updates/check?force=1');
  assert.equal(elements.updateToast.hidden, true);
});
