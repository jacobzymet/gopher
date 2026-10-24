const { existsSync, readFileSync, readdirSync } = require('node:fs');
const { resolve } = require('node:path');
const ts = require('typescript');

const root = resolve(__dirname, '../..');
const styleOrder = ['base', 'conversation', 'content', 'composer', 'activity', 'projects', 'notifications', 'profiles', 'bots', 'terminal', 'diagnostics', 'workspace', 'processes'];
const compiledScripts = new Map();

/** A script, or the parts of a split script (<name>/NN-*.ts) joined in order, as the build does. */
function readScriptSource(filename) {
  const directory = filename.replace(/.ts$/, '');
  if (existsSync(filename) || !existsSync(directory)) return readFileSync(filename, 'utf8');
  return readdirSync(directory).filter(file => file.endsWith('.ts')).sort().map(file => readFileSync(resolve(directory, file), 'utf8')).join('');
}

/** Compile controller source for the VM regression harness. */
function readUiScript(name) {
  const relative = name.includes('/') ? name : `chat/scripts/${name}`;
  const filename = resolve(root, 'client', relative.replace(/\.(?:js|ts)$/, '') + '.ts');
  const source = readScriptSource(filename);
  const cached = compiledScripts.get(filename);
  if (cached?.source === source) return cached.output;
  const output = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None },
  }).outputText.replace(/\r\n/g, '\n');
  compiledScripts.set(filename, { source, output });
  return output;
}

function readUiAsset(name) {
  return readFileSync(resolve(root, 'client', name), 'utf8');
}

function readUiStyles() {
  return styleOrder.map(name => readUiAsset(`chat/styles/${name}.css`)).join('');
}

module.exports = { root, styleOrder, readUiScript, readUiAsset, readUiStyles };
