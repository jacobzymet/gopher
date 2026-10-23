/** Local data storage. See storage/app-storage.ts for the data folder and its encryption. */
export { AppStorage } from './storage/app-storage.js';
export { StoreError } from './storage/errors.js';
export { atomicWrite, readPrivate } from './storage/secure-files.js';
export { normalizeStore, objectValue } from './storage/documents.js';
export type {
  ChatStore, ChatProfile, ChatScope, JsonObject, StoredConversation, StoredMessage,
} from './storage/documents.js';
