import { FONT_BODY_IDS, FONT_DISPLAY_IDS, FONT_MONO_IDS, type StorageMode, type UiConfig } from '../../config.js';
import { focus, openExternal, pickWorkspace } from '../../system.js';
import { buildVersion } from '../../updates.js';
import { HttpError, sendJson } from '../protocol.js';
import { objectBody, requiredBody, requiredText, text } from '../guards.js';
import { route, type Route, type RouteContext } from '../router.js';

/** App state, data folder, storage mode, encryption and appearance. */

const STORAGE_MODES: readonly StorageMode[] = ['disk', 'browser', 'memory'];
const DEFAULT_APPEARANCE: Pick<UiConfig, 'theme' | 'font_body' | 'font_display' | 'font_mono' | 'font_scale'> = {
  theme: 'dark', font_body: 'inter', font_display: 'space-grotesk', font_mono: 'jetbrains-mono', font_scale: 'default',
};
const APPEARANCE_CHOICES: Record<keyof typeof DEFAULT_APPEARANCE, readonly string[]> = {
  theme: ['dark', 'light', 'system'], font_scale: ['compact', 'default', 'large'],
  font_body: FONT_BODY_IDS, font_display: FONT_DISPLAY_IDS, font_mono: FONT_MONO_IDS,
};

async function setStorageMode({ runtime, body: raw, response }: RouteContext): Promise<void> {
  const body = objectBody(raw);
  const requested = body.storage || (body.browser_storage ? 'browser' : 'disk');
  if (typeof requested !== 'string' || !STORAGE_MODES.includes(requested as StorageMode)) {
    throw new HttpError(400, 'Invalid storage mode.');
  }
  await runtime.storage.setStorageMode(requested as StorageMode);
  sendJson(response, runtime.storage.dataInfo());
}

async function encryption({ runtime, body: raw, path, response }: RouteContext): Promise<void> {
  const body = objectBody(raw);
  const storage = runtime.storage;
  const passphrase = text(body, 'passphrase');
  const operation = path.split('/').at(-1);
  if (operation === 'enable') {
    await runtime.revoke();
    const confirm = body.passphrase_confirm === undefined ? undefined : text(body, 'passphrase_confirm');
    await storage.enableEncryption(passphrase, confirm);
  } else if (operation === 'unlock') {
    await storage.unlock(passphrase);
    void runtime.warm(true);
  } else if (operation === 'lock') {
    await runtime.revoke();
    await storage.lock();
  } else if (operation === 'disable') {
    await runtime.revoke();
    await storage.disableEncryption(passphrase);
  } else throw new HttpError(404, 'Unknown encryption operation.');
  sendJson(response, storage.dataInfo());
}

async function appearance({ runtime, body: raw, path, response }: RouteContext): Promise<void> {
  const body = objectBody(raw);
  await runtime.updateConfig(next => {
    if (path.endsWith('/reset')) { Object.assign(next.ui, DEFAULT_APPEARANCE); return; }
    for (const key of Object.keys(DEFAULT_APPEARANCE) as Array<keyof typeof DEFAULT_APPEARANCE>) {
      const value = body[key];
      if (value === undefined) continue;
      if (typeof value !== 'string' || !APPEARANCE_CHOICES[key].includes(value)) {
        throw new HttpError(400, `Invalid ${key.replace(/_/g, ' ')}.`);
      }
      (next.ui as unknown as Record<string, string>)[key] = value;
    }
  }, false);
  sendJson(response, runtime.state());
}

export const dataRoutes: Route[] = [
  route('GET', '/api/state', ({ runtime, response }) => { void runtime.warm(); sendJson(response, runtime.state()); }),
  route('POST', '/api/focus', async ({ response }) => {
    const focused = await focus();
    sendJson(response, { app: 'gopher', instance: 'gopher', version: buildVersion(), focused });
  }),
  route('POST', '/api/open-url', async ({ body, response }) => {
    await openExternal(requiredText(objectBody(body), 'url', 'Only HTTP and HTTPS links can be opened.'));
    sendJson(response, { ok: true });
  }),
  route('POST', '/api/workspace/pick', async ({ response }) => {
    sendJson(response, { ok: true, path: await pickWorkspace() });
  }),
  route('GET', '/api/data', ({ runtime, response }) => sendJson(response, runtime.storage.dataInfo())),
  route('POST', '/api/data', setStorageMode),
  route('POST', '/api/data/open', async ({ runtime, response }) => {
    await openExternal(runtime.storage.root, true);
    sendJson(response, { ok: true });
  }),
  route('GET', '/api/data/store', async ({ runtime, response }) => {
    sendJson(response, await runtime.storage.readChats());
  }),
  route('PUT', '/api/data/store', async ({ runtime, body, response }) => {
    await runtime.storage.saveChats(requiredBody(body));
    sendJson(response, null, 204);
  }),
  route('GET', '/api/data/preferences', async ({ runtime, response }) => {
    sendJson(response, await runtime.storage.readPreferences());
  }),
  route('PUT', '/api/data/preferences', async ({ runtime, body, response }) => {
    await runtime.storage.savePreferences(requiredBody(body));
    sendJson(response, await runtime.storage.readPreferences());
  }),
  route('POST', path => path.startsWith('/api/data/encryption/'), encryption),
  route('POST', path => ['/api/ui/theme', '/api/ui/appearance', '/api/ui/appearance/reset'].includes(path), appearance),
];
