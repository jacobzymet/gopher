import type { BrowserWindow } from 'electron';

/** Read the server's security state directly; renderer messages cannot release the window. */
export function sessionLockReader(origin: string, request = fetch): () => Promise<boolean> {
  const endpoint = new URL(origin);
  // Browsers resolve *.localhost locally; Node's DNS resolver need not do so.
  if (endpoint.hostname === 'gopher.localhost') endpoint.hostname = '127.0.0.1';
  let cookie = '';
  return async () => {
    if (!cookie) {
      const page = await request(new URL('/', endpoint), { redirect: 'error', signal: AbortSignal.timeout(2000) });
      cookie = page.headers.get('set-cookie')?.split(';')[0] || '';
      await page.body?.cancel();
      if (!page.ok || !cookie) throw new Error('Could not verify the local session.');
    }
    const response = await request(new URL('/api/data', endpoint), {
      headers: { cookie }, redirect: 'error', signal: AbortSignal.timeout(2000),
    });
    if (response.status === 401) cookie = '';
    if (!response.ok) throw new Error('Could not verify the local encryption state.');
    const info = await response.json() as { encryption_enabled?: boolean; encryption_unlocked?: boolean };
    if (typeof info.encryption_enabled !== 'boolean' || typeof info.encryption_unlocked !== 'boolean') {
      throw new Error('Invalid local encryption state.');
    }
    return info.encryption_enabled && !info.encryption_unlocked;
  };
}

/** Prevent minimizing the locked app without changing its size or fullscreen state. */
export function windowSessionLock(window: BrowserWindow) {
  let locked = false;
  let previousMinimizable = window.isMinimizable();
  const restore = () => { if (locked && !window.isDestroyed()) window.restore(); };
  window.on('minimize', restore);
  return {
    update(next: boolean) {
      if (next === locked || window.isDestroyed()) return;
      locked = next;
      if (locked) {
        previousMinimizable = window.isMinimizable();
        window.setMinimizable(false);
        if (window.isMinimized()) window.restore();
      } else {
        window.setMinimizable(previousMinimizable);
      }
    },
    dispose() {
      locked = false;
      window.removeListener('minimize', restore);
    },
  };
}
