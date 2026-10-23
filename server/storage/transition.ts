import { AAD, validateMeta, type EncryptionMeta } from '../crypto.js';
import type { UserSkill } from '../skills.js';
import { StoreError } from './errors.js';
import { isObject, type ChatStore, type JsonObject } from './documents.js';

/**
 * Enabling or disabling encryption rewrites several files. The complete new state is first
 * written, encrypted and authenticated, to `encryption-transition.json`; after a crash the next
 * unlock (or the same operation) replays it, so a half-finished change is never left behind.
 */

export interface Snapshot {
  chats: ChatStore; preferences: JsonObject; provider_tokens: unknown; skills: UserSkill[]; diagnostics?: unknown;
}
export type TransitionOperation = 'enable' | 'disable';
export interface Transition {
  version: number; transaction_id: string; operation: TransitionOperation; meta: EncryptionMeta; payload: unknown;
}
export interface TransitionPayload { transaction_id: string; operation: TransitionOperation; snapshot: Snapshot }

export const transitionAad = (record: Transition) => `${AAD.transition}:${record.operation}:${record.transaction_id}`;

export function parseTransition(raw: unknown): Transition {
  const valid = isObject(raw) && raw.version === 1 && typeof raw.transaction_id === 'string'
    && /^[A-Za-z0-9_-]{1,128}$/.test(raw.transaction_id) && (raw.operation === 'enable' || raw.operation === 'disable');
  if (!valid) throw new StoreError('Invalid encryption transition.');
  return { ...(raw as unknown as Transition), meta: validateMeta(raw.meta) };
}

/** The decrypted journal must name the same transaction as its authenticated envelope. */
export function parseTransitionPayload(raw: unknown, record: Transition): TransitionPayload {
  const valid = isObject(raw) && raw.transaction_id === record.transaction_id && raw.operation === record.operation
    && isObject(raw.snapshot);
  if (!valid) throw new StoreError('Encryption transition identity mismatch.');
  return raw as unknown as TransitionPayload;
}
