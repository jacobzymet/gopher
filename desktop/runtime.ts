import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export interface RuntimeInfo { executable: string; node: string; electron?: string }
export type RuntimeProbe = (candidate: string, environment: NodeJS.ProcessEnv) => Promise<RuntimeInfo>;

const probe: RuntimeProbe = async (candidate, environment) => {
  const { stdout } = await execute(candidate, ['-p', 'JSON.stringify({executable:process.execPath,node:process.versions.node,electron:process.versions.electron})'], {
    env: environment, windowsHide: true, timeout: 5000, maxBuffer: 4096,
  });
  return JSON.parse(stdout);
};

export async function serverRuntime(environment: NodeJS.ProcessEnv = process.env, inspect: RuntimeProbe = probe): Promise<string> {
  const env = { ...environment };
  delete env.ELECTRON_RUN_AS_NODE;
  const explicit = environment.GOPHER_NODE_EXECUTABLE;
  const candidates = explicit ? [explicit] : [...new Set([environment.npm_node_execpath, 'node'].filter(Boolean) as string[])];
  for (const candidate of candidates) {
    try {
      const runtime = await inspect(candidate, env);
      const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(runtime.node);
      if (!runtime.electron && runtime.executable && match && (Number(match[1]) > 24 || (Number(match[1]) === 24 && Number(match[2]) >= 7))) return runtime.executable;
    } catch { /* Try the next configured Node executable. */ }
  }
  throw new Error('Gopher requires Node.js 24.7 or later to run its local server. Install Node.js or set GOPHER_NODE_EXECUTABLE to its executable path.');
}
