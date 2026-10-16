import { argon2, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

export const AAD = { chats: 'gopher:v1:chats', preferences: 'gopher:v1:preferences', providers: 'gopher:v1:provider-tokens', skills: 'gopher:v1:skills', skillIndex: 'gopher:v1:skill-index', skillContent: 'gopher:v1:skill-content', diagnostics: 'gopher:diagnostics:v1', transition: 'gopher:v1:encryption-transition', verifier: 'gopher:v1:verifier' } as const;
export interface Envelope { gopher_crypto: 1 | 2; nonce: string; ciphertext: string }
export interface EncryptionMeta { version: number; kdf: string; kdf_memory_kib?: number; kdf_iterations?: number; kdf_parallelism?: number; salt: string; verifier?: Envelope | null }
export function isEnvelope(value: unknown): value is Envelope { return !!value && typeof value === 'object' && [1, 2].includes((value as Envelope).gopher_crypto); }
function base64(raw: string, name: string): Buffer {
  if (typeof raw !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw.trim())) throw new Error(`Invalid ${name}.`);
  return Buffer.from(raw.trim(), 'base64');
}
export function validatePassphrase(value: string): void {
  if (typeof value !== 'string' || !value.length) throw new Error('Passphrase must not be empty.');
  if (value.includes('\0')) throw new Error('Passphrase must not contain null characters.');
}
export function validateMeta(raw: unknown): EncryptionMeta {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid encryption metadata.');
  const meta = raw as EncryptionMeta;
  if (![1, 2].includes(meta.version) || meta.kdf !== 'argon2id') throw new Error('Unsupported encryption metadata.');
  const salt = base64(meta.salt, 'encryption salt');
  if (salt.length < 16 || salt.length > 64) throw new Error('Encryption salt has an invalid length.');
  const memory = meta.kdf_memory_kib ?? 19456, passes = meta.kdf_iterations ?? 2, parallelism = meta.kdf_parallelism ?? 1;
  if (!((memory === 65536 && passes === 3) || (memory === 19456 && passes === 2)) || parallelism !== 1) throw new Error('Encryption metadata has unsupported Argon2 parameters.');
  return { ...meta, kdf_memory_kib: memory, kdf_iterations: passes, kdf_parallelism: parallelism };
}
export async function deriveKey(passphrase: string, raw: EncryptionMeta): Promise<Buffer> {
  validatePassphrase(passphrase);
  const meta = validateMeta(raw);
  const message = Buffer.from(passphrase);
  try {
    return await new Promise<Buffer>((resolve, reject) => argon2('argon2id', { message, nonce: base64(meta.salt, 'salt'), memory: meta.kdf_memory_kib!, passes: meta.kdf_iterations!, parallelism: 1, tagLength: 32 }, (error, key) => error ? reject(error) : resolve(key)));
  } finally { message.fill(0); }
}
export function encryptBytes(key: Buffer, plaintext: Buffer, aad: string): Envelope {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { gopher_crypto: 2, nonce: nonce.toString('base64'), ciphertext: encrypted.toString('base64') };
}
export function decryptBytes(key: Buffer, value: unknown, aad: string): Buffer {
  if (!isEnvelope(value)) throw new Error('Invalid encrypted envelope.');
  const nonce = base64(value.nonce, 'nonce'), ciphertext = base64(value.ciphertext, 'ciphertext');
  if (nonce.length !== 12 || ciphertext.length < 16) throw new Error('Invalid encryption nonce or ciphertext length.');
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, nonce);
    if (value.gopher_crypto === 2) cipher.setAAD(Buffer.from(aad));
    cipher.setAuthTag(ciphertext.subarray(-16));
    return Buffer.concat([cipher.update(ciphertext.subarray(0, -16)), cipher.final()]);
  } catch { throw new Error('Incorrect passphrase or corrupted encrypted data.'); }
}
export function encryptValue(key: Buffer, value: unknown, aad: string): Envelope {
  const plaintext = Buffer.from(JSON.stringify(value));
  try { return encryptBytes(key, plaintext, aad); } finally { plaintext.fill(0); }
}
export function decryptValue<T = any>(key: Buffer, value: unknown, aad: string): T {
  const plaintext = decryptBytes(key, value, aad);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)) as T; } finally { plaintext.fill(0); }
}
export function verifyKey(key: Buffer, meta: EncryptionMeta): void {
  if (!meta.verifier) throw new Error('Encryption metadata is missing a key verifier.');
  const bytes = decryptBytes(key, meta.verifier, AAD.verifier), expected = Buffer.from('gopher-ok');
  try { if (bytes.length !== expected.length || !timingSafeEqual(bytes, expected)) throw new Error('Incorrect passphrase or corrupted encrypted data.'); } finally { bytes.fill(0); }
}
export async function createEncryption(passphrase: string): Promise<{ key: Buffer; meta: EncryptionMeta }> {
  const meta: EncryptionMeta = { version: 2, kdf: 'argon2id', kdf_memory_kib: 65536, kdf_iterations: 3, kdf_parallelism: 1, salt: randomBytes(32).toString('base64') };
  const key = await deriveKey(passphrase, meta);
  meta.verifier = encryptBytes(key, Buffer.from('gopher-ok'), AAD.verifier);
  return { key, meta };
}
