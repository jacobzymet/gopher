import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { buildRelease, atomicFile, dataDirectory, type BuiltRelease, type ReleaseOptions } from '../scripts/install.js';
import { restartFrom } from './system.js';
import { record } from './diagnostics.js';

declare const GOPHER_BUILD_COMMIT: string;
declare const GOPHER_BUILD_DIRTY: boolean;
const commit = typeof GOPHER_BUILD_COMMIT === 'undefined' ? 'development' : GOPHER_BUILD_COMMIT;
const dirty = typeof GOPHER_BUILD_DIRTY === 'undefined' ? true : GOPHER_BUILD_DIRTY;
const exec = promisify(execFile);
const repository = 'https://github.com/jacobzymet/gopher';
export interface UpdateStatus {
  current: string; current_commit: string | null; latest: string | null; branch: string;
  commit_url: string; update_available: boolean; can_install: boolean; checked: boolean;
  error: string | null; install_blocked?: string;
}
export interface UpdateOptions {
  currentCommit?: string;
  modified?: boolean;
  fetch?: typeof fetch;
  verifyTools?: () => Promise<void>;
  build?: (options: ReleaseOptions) => Promise<BuiltRelease>;
  restart?: typeof restartFrom;
  schedule?: (callback: () => Promise<void>) => void;
  updatesDirectory?: string;
  releasePointer?: string;
}

export class UpdateService {
  private cache?: { at: number; value: UpdateStatus };
  private applying = false;
  constructor(private options: UpdateOptions = {}) {}
  version(): string { const value = this.options.currentCommit ?? commit; return `master@${value.slice(0, 12)}${(this.options.modified ?? dirty) ? '+modified' : ''}`; }
  async check(force = false): Promise<UpdateStatus> {
    if (!force && this.cache && Date.now() - this.cache.at < 6 * 60 * 60 * 1000) {
      return structuredClone(this.cache.value);
    }
    const current = this.options.currentCommit ?? commit;
    const status: UpdateStatus = { current: this.version(), current_commit: /^[a-f\d]{40}$/.test(current) ? current : null, latest: null, branch: 'master', commit_url: `${repository}/commits/master`, update_available: false, can_install: false, checked: true, error: null };
    const request = this.options.fetch || fetch;
    try {
      const response = await request('https://api.github.com/repos/jacobzymet/gopher/commits/master', { headers: { accept: 'application/vnd.github+json', 'user-agent': 'Gopher' }, signal: AbortSignal.timeout(12_000), redirect: 'error' });
      if (!response.ok) throw new Error(`GitHub returned ${response.status}.`);
      const payload = await response.json() as { sha?: string };
      if (!payload.sha || !/^[a-f\d]{40}$/i.test(payload.sha)) {
        throw new Error('GitHub did not return a valid master commit.');
      }
      status.latest = payload.sha.toLowerCase(); status.commit_url = `${repository}/commit/${status.latest}`;
      status.update_available = current !== status.latest || (this.options.modified ?? dirty);
      if (status.update_available) {
        const manifest = await request(`https://raw.githubusercontent.com/jacobzymet/gopher/${status.latest}/package.json`, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
        if (!manifest.ok) status.install_blocked = 'The upstream commit does not contain a compatible TypeScript application.';
        else {
          const pkg = await manifest.json() as { name?: string; scripts?: { build?: string } };
          if (pkg.name !== 'gopher' || !pkg.scripts?.build) status.install_blocked = 'The upstream application manifest is incompatible.';
          else { await (this.options.verifyTools || (async () => { await exec('git', ['--version'], { windowsHide: true }); }))(); status.can_install = true; }
        }
      }
    } catch (error) { status.error = (error as Error).message; }
    this.cache = { at: Date.now(), value: status }; return structuredClone(status);
  }
  async apply(configPath?: string, bind?: string): Promise<{ ok: boolean; restarting: boolean; commit: string }> {
    if (this.applying) throw new Error('An update is already building.');
    this.applying = true;
    try {
      const status = await this.check(true);
      if (!status.can_install || !status.latest) {
        throw new Error(status.install_blocked || status.error || 'No compatible update is available.');
      }
      const built = await (this.options.build || buildRelease)({ releasesDirectory: this.options.updatesDirectory || join(dataDirectory(), 'updates'), commit: status.latest, onOutput: text => record('update.build', { text }) });
      if (built.commit !== status.latest) throw new Error('The built commit did not match the requested update.');
      const pointer = this.options.releasePointer || process.env.GOPHER_RELEASE_POINTER;
      if (pointer) await atomicFile(pointer, JSON.stringify(built));
      const restart = async () => {
        try { await (this.options.restart || restartFrom)(built.checkout, configPath, bind); }
        catch (error) { this.applying = false; record('update.restart.error', { error: String(error) }); }
      };
      if (this.options.schedule) this.options.schedule(restart);
      else { const timer = setTimeout(() => { void restart(); }, 500); timer.unref(); }
      return { ok: true, restarting: true, commit: built.commit };
    } catch (error) { this.applying = false; throw error; }
  }
}

const updates = new UpdateService();
export function buildVersion(): string { return updates.version(); }
export function checkUpdates(force = false): Promise<UpdateStatus> { return updates.check(force); }
export function applyUpdate(configPath?: string, bind?: string) { return updates.apply(configPath, bind); }
