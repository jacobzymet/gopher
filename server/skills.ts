import { randomBytes } from 'node:crypto';

export interface UserSkill {
  id: string; name: string; description: string; enabled: boolean; content: string;
  source_filename?: string | null; created_at: number; updated_at: number;
}
export type SkillUpsert = Partial<Pick<UserSkill, 'name' | 'description' | 'content' | 'enabled' | 'source_filename'>>;
export const MAX_SKILLS = 32;
export function isSafeSkillId(id: string): boolean { return /^sk-[a-fA-F0-9]{16}$/.test(id); }
function boundedText(value: unknown, limit: number, label: string, trim = true): string {
  if (typeof value !== 'string') throw new Error(`${label} must be text.`);
  const text = trim ? value.trim() : value;
  if (Array.from(text).length > limit) throw new Error(`${label} must be at most ${limit} characters.`);
  return text;
}
function filename(value: string | null | undefined): string | undefined {
  return value?.trim().replace(/\\/g, '/').split('/').pop()?.slice(0, 120) || undefined;
}
export function upsertSkill(input: SkillUpsert, existing?: UserSkill): UserSkill {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Skill must be an object.');
  const now = Math.floor(Date.now() / 1000);
  const skill: UserSkill = existing ? { ...existing, updated_at: now } : { id: `sk-${randomBytes(8).toString('hex')}`, name: 'Untitled skill', description: '', enabled: true, content: '', created_at: now, updated_at: now };
  if (input.name !== undefined) {
    skill.name = boundedText(input.name, 64, 'Skill name');
    if (!skill.name) throw new Error('Skill name cannot be empty.');
  }
  if (input.description !== undefined) skill.description = boundedText(input.description, 280, 'Skill description');
  if (input.content !== undefined) {
    if (typeof input.content !== 'string' || Buffer.byteLength(input.content) > 65536) throw new Error('Skill content must be text of at most 65536 bytes.');
    skill.content = input.content;
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw new Error('Skill enabled must be a boolean.');
    skill.enabled = input.enabled;
  }
  if (input.source_filename !== undefined) skill.source_filename = filename(input.source_filename);
  return skill;
}
export function parseSkillMarkdown(raw: string, sourceFilename?: string): SkillUpsert {
  if (typeof raw !== 'string') throw new Error('Skill content must be text.');
  let content = raw.trim(), name: string | undefined, description: string | undefined;
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (match) {
    content = match[2]!;
    for (const line of match[1]!.split(/\r?\n/)) {
      const entry = line.trim().match(/^(name|description):\s*(.*)$/);
      if (!entry) continue;
      const value = entry[2]!.replace(/^["']|["']$/g, '');
      if (entry[1] === 'name') name = value; else description = value;
    }
  }
  name ||= filename(sourceFilename)?.replace(/\.[^.]*$/, '').replace(/[_-]/g, ' ') || 'Imported skill';
  return { name, description: description || '', content, source_filename: filename(sourceFilename), enabled: true };
}
export function validateSkills(value: unknown): UserSkill[] {
  if (!Array.isArray(value) || value.length > MAX_SKILLS) throw new Error('Invalid skill store.');
  const ids = new Set<string>();
  return value.map(raw => {
    if (!raw || typeof raw !== 'object' || !isSafeSkillId(raw.id) || ids.has(raw.id)) throw new Error('Invalid or duplicate skill id in local store.');
    ids.add(raw.id);
    if (typeof raw.content !== 'string' || typeof raw.name !== 'string' || typeof raw.description !== 'string' || typeof raw.enabled !== 'boolean' || !Number.isFinite(raw.created_at) || !Number.isFinite(raw.updated_at)) throw new Error('Invalid skill store.');
    return { ...raw } as UserSkill;
  });
}
export function publicSkill(skill: UserSkill): UserSkill & { content_chars: number } { return { ...skill, source_filename: skill.source_filename ?? null, content_chars: Array.from(skill.content).length }; }
export function fullInstructions(skill: UserSkill): string { return `# Skill: ${skill.name}\n${skill.description.trim() ? `\n${skill.description.trim()}\n` : ''}\n${skill.content.trim()}\n`; }
export function findSkill(skills: UserSkill[], key: string): UserSkill | undefined { return skills.find(skill => skill.id === key.trim() || skill.name.toLowerCase() === key.trim().toLowerCase()); }
export function skillsCatalog(skills: UserSkill[]): string {
  return skills.length ? `User skills are available. Use the skill tool to read the full instructions when relevant.\n${skills.map(skill => `- ${skill.name} (id: ${skill.id})${skill.description.trim() ? `: ${skill.description.trim()}` : ''}`).join('\n')}` : '';
}
