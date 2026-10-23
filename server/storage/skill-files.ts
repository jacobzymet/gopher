import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { AAD, decryptValue, encryptValue, isEnvelope } from '../crypto.js';
import { isSafeSkillId, validateSkills, type UserSkill } from '../skills.js';
import { lockedError, StoreError } from './errors.js';
import { inspect, protectDirectory, readJson, readPrivate, removePrivate, writeJson } from './secure-files.js';
import { isObject } from './documents.js';

/**
 * Custom skills live in `chat-skills/skills.json`. Older versions used `index.json` plus one
 * Markdown file per skill; those are still read and are migrated to the single file on save.
 */

const SKILL_FILE_BYTES = 128 * 1024;

function decoder(key: Buffer | null, encrypted: boolean) {
  return (value: unknown, aad: string): unknown => {
    if (isEnvelope(value)) { if (!key) throw lockedError(); return decryptValue(key, value, aad); }
    if (encrypted) throw new StoreError('Encrypted skills were replaced with plaintext.');
    return value;
  };
}

export async function readSkillFiles(root: string, key: Buffer | null, encrypted: boolean): Promise<UserSkill[]> {
  if (encrypted && !key) throw lockedError();
  const directory = join(root, 'chat-skills');
  const decode = decoder(key, encrypted);
  const snapshot = await readJson(join(directory, 'skills.json'));
  if (snapshot !== null) return validateSkills(decode(snapshot, AAD.skills));
  const indexRaw = await readJson(join(directory, 'index.json'));
  if (indexRaw === null) return [];
  const index = decode(indexRaw, AAD.skillIndex);
  if (!isObject(index) || !Array.isArray(index.skills)) throw new StoreError('Invalid skill index.');
  const skills: unknown[] = [];
  for (const meta of index.skills as unknown[]) {
    const id = isObject(meta) ? meta.id : undefined;
    if (typeof id !== 'string' || !isSafeSkillId(id)) throw new StoreError('Invalid skill id in local store.');
    const raw = await readPrivate(join(directory, `${id}.md`), SKILL_FILE_BYTES);
    if (raw === null) throw new StoreError(`Skill content is missing: ${id}`);
    let content: unknown = raw;
    if (encrypted) {
      let envelope: unknown;
      try { envelope = JSON.parse(raw); } catch { throw new StoreError('Invalid encrypted skill content.'); }
      content = decode(envelope, `${AAD.skillContent}:${id}`);
    }
    skills.push({ ...(meta as object), content });
  }
  return validateSkills(skills);
}

export async function writeSkillFiles(root: string, skills: UserSkill[], key: Buffer | null): Promise<void> {
  validateSkills(skills);
  const directory = join(root, 'chat-skills');
  if (!(await inspect(directory))) await protectDirectory(directory);
  await writeJson(join(directory, 'skills.json'), key ? encryptValue(key, skills, AAD.skills) : skills);
  await removePrivate(join(directory, 'index.json'));
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const legacySkillFile = entry.name.endsWith('.md') && isSafeSkillId(entry.name.slice(0, -3));
    if (legacySkillFile) await removePrivate(join(directory, entry.name));
  }
}
