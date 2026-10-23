import { StoreError } from './errors.js';

/**
 * The chat store and preferences are owned by the browser client. The server checks their outer
 * shape, never rewrites unknown fields, and accepts every historical layout:
 * - a bare array of conversations (legacy),
 * - version 2: `{ projects, conversations, bots }`,
 * - version 3: `{ profiles: [{ id, projects, conversations, bots }], activeProfileId }`.
 */

export type JsonObject = { [key: string]: unknown };

export interface StoredMessage { role?: unknown; content?: unknown; [key: string]: unknown }
export interface StoredConversation {
  id?: unknown; title?: unknown; projectId?: unknown; incognito?: unknown; updatedAt?: unknown;
  messages?: StoredMessage[]; [key: string]: unknown;
}
export interface ChatScope {
  projects: unknown[]; conversations: StoredConversation[]; bots: unknown[]; [key: string]: unknown;
}
export interface ChatProfile extends ChatScope { id?: unknown }
/** Version 2 keeps one scope at the top level; version 3 keeps scopes in `profiles`. */
export interface ChatStore {
  version: number; projects?: unknown[]; conversations?: StoredConversation[]; bots?: unknown[];
  profiles?: ChatProfile[]; activeProfileId?: unknown; [key: string]: unknown;
}

export const isObject = (value: unknown): value is JsonObject =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function normalizeScope(container: JsonObject): void {
  for (const name of ['projects', 'conversations', 'bots']) {
    if (container[name] === undefined) container[name] = [];
    if (!Array.isArray(container[name])) {
      throw new StoreError('Store must include projects, conversations, and bots arrays.');
    }
  }
}

/** Validate and copy a chat store, filling in missing arrays and the version. */
export function normalizeStore(raw: unknown): ChatStore {
  let value: JsonObject;
  if (Array.isArray(raw)) value = { version: 2, projects: [], conversations: raw, bots: [] };
  else if (isObject(raw)) value = structuredClone(raw);
  else throw new StoreError('Store must be a JSON object or a legacy conversations array.');
  if ('profiles' in value) {
    if (!Array.isArray(value.profiles)) throw new StoreError('Profiles must be a JSON array.');
    for (const profile of value.profiles) {
      if (!isObject(profile)) throw new StoreError('Each profile must be a JSON object.');
      normalizeScope(profile);
    }
    value.version = 3;
  } else {
    normalizeScope(value);
    value.version ??= 2;
  }
  return value as ChatStore;
}

export function objectValue(value: unknown): JsonObject {
  if (!isObject(value)) throw new StoreError('Preferences must be a JSON object.');
  return value;
}
