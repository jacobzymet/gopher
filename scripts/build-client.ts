import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { transform } from 'esbuild';

/**
 * A controller's source: `scripts/<name>.ts`, or the parts in `scripts/<name>/` joined in file-name
 * order. Parts are cut at top-level statements, so joining them reproduces one script exactly.
 */
export async function readControllerSource(name: string, root = 'client/chat/scripts'): Promise<string> {
  const directory = join(root, name);
  const isDirectory = await stat(directory).then(info => info.isDirectory(), () => false);
  if (!isDirectory) return readFile(join(root, `${name}.ts`), 'utf8');
  const parts = (await readdir(directory)).filter(file => file.endsWith('.ts')).sort();
  return (await Promise.all(parts.map(file => readFile(join(directory, file), 'utf8')))).join('');
}

/** Controller order is part of the application's shared browser scope. */
export const CLIENT_CONTROLLERS = [
  'state', 'diagnostics', 'input', 'controls', 'render', 'providers',
  'bots', 'workspace', 'runtime', 'terminal',
] as const;
export const CLIENT_STYLES = [
  'base', 'conversation', 'content', 'composer', 'activity', 'projects',
  'notifications', 'profiles', 'bots', 'terminal', 'diagnostics', 'workspace',
] as const;

export async function buildClient(outputDirectory = resolve('dist/public')): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  const scripts = await Promise.all(CLIENT_CONTROLLERS.map(name => readControllerSource(name)));
  const result = await transform(scripts.join('\n;\n'), {
    loader: 'ts', target: 'es2022', sourcefile: 'client/chat.ts',
    sourcemap: 'inline', legalComments: 'inline',
  });
  await writeFile(resolve(outputDirectory, 'chat.js'), result.code);
  const styles = await Promise.all(CLIENT_STYLES.map((name) => readFile(`client/chat/styles/${name}.css`, 'utf8')));
  await writeFile(resolve(outputDirectory, 'chat.css'), styles.join(''));
  await writeFile(resolve(outputDirectory, 'chat.html'), await readFile('client/chat.html'));
  for (const name of ['orb', 'optional-fonts']) {
    const source = await readFile(`client/${name}.ts`, 'utf8');
    const asset = await transform(source, { loader: 'ts', target: 'es2022', legalComments: 'inline' });
    await writeFile(resolve(outputDirectory, `${name}.js`), asset.code);
  }
}
