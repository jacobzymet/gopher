import { argon2, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * At-rest encryption: Argon2id derives a 256-bit key from the passphrase; each file is sealed with
 * AES-256-GCM under a fresh nonce and a per-file associated-data label (so files cannot be swapped).
 * Version-1 envelopes from early releases carry no associated data and still decrypt.
 */

export const AAD = {
  chats: 'gopher:v1:chats', preferences: 'gopher:v1:preferences', providers: 'gopher:v1:provider-tokens',
  skills: 'gopher:v1:skills', skillIndex: 'gopher:v1:skill-index', skillContent: 'gopher:v1:skill-content',
  diagnostics: 'gopher:diagnostics:v1', transition: 'gopher:v1:encryption-transition', verifier: 'gopher:v1:verifier',
} as const;
export interface Envelope { gopher_crypto: 1 | 2; nonce: string; ciphertext: string }
export interface EncryptionMeta {
  version: number; kdf: string; kdf_memory_kib?: number; kdf_iterations?: number; kdf_parallelism?: number;
  salt: string; verifier?: Envelope | null;
}

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const VERIFIER_TEXT = 'gopher-ok';
/** Current key derivation (64 MiB, 3 passes); the older 19 MiB, 2-pass setting is still accepted. */
const CURRENT_KDF = { memory: 65536, passes: 3 };
const LEGACY_KDF = { memory: 19456, passes: 2 };
const decryptFailed = () => new Error('Incorrect passphrase or corrupted encrypted data.');

export function isEnvelope(value: unknown): value is Envelope {
  return !!value && typeof value === 'object' && [1, 2].includes((value as Envelope).gopher_crypto);
}

function isBase64Symbol(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 43 || code === 47;
}

/**
 * Strict standard base64: whole 4-character groups, padding only as `XX==` or
 * `XXX=` in the final group. A linear scan, because a regular expression over a
 * multi-megabyte ciphertext can exhaust the stack.
 */
export function isStrictBase64(value: string): boolean {
  const length = value.length;
  if (length % 4 !== 0) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  for (let index = 0; index < length - padding; index++) if (!isBase64Symbol(value.charCodeAt(index))) return false;
  return true;
}

function base64(raw: string, name: string): Buffer {
  if (typeof raw !== 'string') throw new Error(`Invalid ${name}.`);
  const value = raw.trim();
  if (!isStrictBase64(value)) throw new Error(`Invalid ${name}.`);
  return Buffer.from(value, 'base64');
}

export function validatePassphrase(value: string): void {
  if (typeof value !== 'string' || !value.length) throw new Error('Passphrase must not be empty.');
  if (value.includes('\0')) throw new Error('Passphrase must not contain null characters.');
}

/** Accept only the Argon2id parameter sets Gopher has written, filling in defaults for old metadata. */
export function validateMeta(raw: unknown): EncryptionMeta {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid encryption metadata.');
  const meta = raw as EncryptionMeta;
  if (![1, 2].includes(meta.version) || meta.kdf !== 'argon2id') throw new Error('Unsupported encryption metadata.');
  const salt = base64(meta.salt, 'encryption salt');
  if (salt.length < 16 || salt.length > 64) throw new Error('Encryption salt has an invalid length.');
  const memory = meta.kdf_memory_kib ?? LEGACY_KDF.memory, passes = meta.kdf_iterations ?? LEGACY_KDF.passes;
  const parallelism = meta.kdf_parallelism ?? 1;
  const known = (memory === CURRENT_KDF.memory && passes === CURRENT_KDF.passes)
    || (memory === LEGACY_KDF.memory && passes === LEGACY_KDF.passes);
  if (!known || parallelism !== 1) throw new Error('Encryption metadata has unsupported Argon2 parameters.');
  return { ...meta, kdf_memory_kib: memory, kdf_iterations: passes, kdf_parallelism: parallelism };
}

export async function deriveKey(passphrase: string, raw: EncryptionMeta): Promise<Buffer> {
  validatePassphrase(passphrase);
  const meta = validateMeta(raw);
  const message = Buffer.from(passphrase);
  try {
    const parameters = {
      message, nonce: base64(meta.salt, 'salt'), memory: meta.kdf_memory_kib!, passes: meta.kdf_iterations!,
      parallelism: 1, tagLength: KEY_BYTES,
    };
    return await new Promise<Buffer>((resolve, reject) => {
      argon2('argon2id', parameters, (error, key) => (error ? reject(error) : resolve(key)));
    });
  } finally { message.fill(0); }
}

export function encryptBytes(key: Buffer, plaintext: Buffer, aad: string): Envelope {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { gopher_crypto: 2, nonce: nonce.toString('base64'), ciphertext: encrypted.toString('base64') };
}

export function decryptBytes(key: Buffer, value: unknown, aad: string): Buffer {
  if (!isEnvelope(value)) throw new Error('Invalid encrypted envelope.');
  const nonce = base64(value.nonce, 'nonce'), ciphertext = base64(value.ciphertext, 'ciphertext');
  if (nonce.length !== NONCE_BYTES || ciphertext.length < TAG_BYTES) throw new Error('Invalid encryption nonce or ciphertext length.');
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, nonce);
    if (value.gopher_crypto === 2) cipher.setAAD(Buffer.from(aad));
    cipher.setAuthTag(ciphertext.subarray(-TAG_BYTES));
    return Buffer.concat([cipher.update(ciphertext.subarray(0, -TAG_BYTES)), cipher.final()]);
  } catch { throw decryptFailed(); }
}

/** Plaintext buffers are wiped after use. */
export function encryptValue(key: Buffer, value: unknown, aad: string): Envelope {
  const plaintext = Buffer.from(JSON.stringify(value));
  try { return encryptBytes(key, plaintext, aad); } finally { plaintext.fill(0); }
}

export function decryptValue<T = unknown>(key: Buffer, value: unknown, aad: string): T {
  const plaintext = decryptBytes(key, value, aad);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)) as T; }
  finally { plaintext.fill(0); }
}

/** The verifier is a known plaintext sealed with the key; decrypting it proves the passphrase. */
export function verifyKey(key: Buffer, meta: EncryptionMeta): void {
  if (!meta.verifier) throw new Error('Encryption metadata is missing a key verifier.');
  const bytes = decryptBytes(key, meta.verifier, AAD.verifier), expected = Buffer.from(VERIFIER_TEXT);
  try { if (bytes.length !== expected.length || !timingSafeEqual(bytes, expected)) throw decryptFailed(); }
  finally { bytes.fill(0); }
}

export async function createEncryption(passphrase: string): Promise<{ key: Buffer; meta: EncryptionMeta }> {
  const meta: EncryptionMeta = {
    version: 2, kdf: 'argon2id', kdf_memory_kib: CURRENT_KDF.memory, kdf_iterations: CURRENT_KDF.passes,
    kdf_parallelism: 1, salt: randomBytes(32).toString('base64'),
  };
  const key = await deriveKey(passphrase, meta);
  meta.verifier = encryptBytes(key, Buffer.from(VERIFIER_TEXT), AAD.verifier);
  return { key, meta };
}
