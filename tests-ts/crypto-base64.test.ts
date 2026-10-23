import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { AAD, decryptValue, encryptValue, isStrictBase64 } from '../server/crypto.js';

// The validator this replaced; it overflowed the stack on large ciphertexts.
const original = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

test('strict base64 validation accepts exactly what the original expression accepted', () => {
  const alphabet = 'AZaz09+/=-_ \n!';
  const cases = ['', 'AAAA', 'AA==', 'AAA=', 'A===', '====', 'AA=A', 'AAAA====', 'AAAAAA==', 'AAAAAAA=', 'A', 'AAA'];
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
  for (let round = 0; round < 20_000; round++) {
    const length = next() % 13;
    cases.push(Array.from({ length }, () => alphabet[next() % alphabet.length]).join(''));
  }
  for (const value of cases) assert.equal(isStrictBase64(value), original.test(value), JSON.stringify(value));
});

test('a ciphertext larger than 32 MB validates and decrypts without exhausting the stack', () => {
  const key = randomBytes(32);
  try {
    const value = { text: 'x'.repeat(24 * 1024 * 1024) };
    const envelope = encryptValue(key, value, AAD.chats);
    assert.ok(envelope.ciphertext.length > 32 * 1024 * 1024);
    assert.equal(decryptValue<typeof value>(key, envelope, AAD.chats).text.length, value.text.length);
  } finally { key.fill(0); }
});
