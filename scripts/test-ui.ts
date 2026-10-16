import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
const files = (await readdir('tests')).filter(name => name.endsWith('.test.cjs')).map(name => `tests/${name}`);
const child = spawn(process.execPath, ['--test', ...files.sort()], { stdio: 'inherit', windowsHide: true });
child.once('error', error => { console.error(error); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
