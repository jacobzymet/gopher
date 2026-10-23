import { join } from 'node:path';
import { MAX_SKILLS, parseSkillMarkdown, upsertSkill, type SkillUpsert, type UserSkill } from '../skills.js';
import { StoreError } from './errors.js';
import { removePrivate } from './secure-files.js';
import { StorageCore } from './core.js';

/** Custom skills and diagnostics: the smaller records kept beside chats and preferences. */
export class StorageRecords extends StorageCore {
  listSkills(): Promise<UserSkill[]> {
    return this.serial(async () => { this.requireUnlocked(); return this.skillsInternal(); });
  }

  createSkill(input: SkillUpsert): Promise<UserSkill> {
    return this.serial(async () => {
      this.requireUnlocked();
      const skills = await this.skillsInternal();
      if (skills.length >= MAX_SKILLS) throw new StoreError(`At most ${MAX_SKILLS} skills are allowed.`);
      const skill = upsertSkill(input);
      skills.push(skill);
      await this.saveSkillsInternal(skills);
      return skill;
    });
  }

  async importSkill(filename: string | undefined, content: string): Promise<UserSkill> {
    return this.createSkill(parseSkillMarkdown(content, filename));
  }

  updateSkill(id: string, input: SkillUpsert): Promise<UserSkill> {
    return this.serial(async () => {
      this.requireUnlocked();
      const skills = await this.skillsInternal();
      const index = skills.findIndex(skill => skill.id === id);
      if (index < 0) throw new StoreError(`Unknown skill id: ${id}`);
      const skill = upsertSkill(input, skills[index]);
      skills[index] = skill;
      await this.saveSkillsInternal(skills);
      return skill;
    });
  }

  deleteSkill(id: string): Promise<void> {
    return this.serial(async () => {
      this.requireUnlocked();
      const skills = await this.skillsInternal();
      const remaining = skills.filter(skill => skill.id !== id);
      if (remaining.length === skills.length) throw new StoreError(`Unknown skill id: ${id}`);
      await this.saveSkillsInternal(remaining);
    });
  }

  flushDiagnostics(): Promise<void> { return this.serial(() => this.flushDiagnosticsInternal()); }

  clearDiagnostics(): Promise<void> {
    return this.serial(async () => {
      this.requireUnlocked();
      await removePrivate(join(this.root, 'diagnostics.json'));
      this.diagnostics.clear();
      this.diagnostics.configure((await this.preferencesInternal()).diagnosticsEnabled === true);
      await this.flushDiagnosticsInternal();
    });
  }

}
