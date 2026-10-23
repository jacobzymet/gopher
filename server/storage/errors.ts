/** Storage failures. `code` tells the client why (for example `encrypted_locked`). */
export class StoreError extends Error {
  constructor(message: string, readonly code = 'store_error') {
    super(message);
    this.name = 'StoreError';
  }
}

export const lockedError = () =>
  new StoreError('Local data is encrypted. Unlock with your passphrase to continue.', 'encrypted_locked');

export const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
