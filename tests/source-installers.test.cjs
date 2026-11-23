const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh';
const commit = '0123456789abcdef0123456789abcdef01234567';
const posix = (value) => value.replaceAll('\\', '/').replace(/^([a-z]):\//i, (_, drive) => '/' + drive.toLowerCase() + '/');

function fixture(platform, options = {}) {
  const tempRoot = os.tmpdir();
  const directory = fs.mkdtempSync(path.join(tempRoot, 'gopher-installer-test-'));
  const bin = path.join(directory, 'tools');
  const install = path.join(directory, 'installed');
  fs.mkdirSync(bin);
  fs.mkdirSync(install);
  fs.writeFileSync(path.join(install, 'gopher'), 'existing app');
  function tool(name, text) { fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nset -eu\n' + text + '\n', { mode: 0o755 }); }
  tool('uname', 'echo ' + (platform === 'macos' ? 'Darwin' : 'Linux'));
  tool('curl', 'printf "%s\\n" "$MOCK_SHA"');
  tool('cc', 'exit 0');
  tool('pkg-config', options.missingDependencies ? 'exit 1' : 'exit 0');
  tool('xcode-select', options.missingDependencies ? 'exit 1' : 'exit 0');
  tool('xcrun', 'exit 0');
  tool('rustc', 'if [ "$1" = -vV ]; then echo "host: test-native-target"; else echo "rustc test"; fi');
  tool('cargo', `if [ "$1" = --version ]; then ${options.missingRust ? 'exit 1' : 'echo cargo-test; exit 0'}; fi
printf '%s\\n' "$*" > "$MOCK_CALLS"
${options.failBuild ? 'exit 9' : ''}
while [ "$#" -gt 0 ]; do if [ "$1" = --root ]; then output=$2; break; fi; shift; done
mkdir -p "$output/bin"
printf '#!/bin/sh\\necho "gopher master@0123456789ab"\\necho "Commit: %s"\\n' "${options.wrongIdentity ? 'f'.repeat(40) : '$GOPHER_BUILD_COMMIT'}" > "$output/bin/gopher"
chmod 755 "$output/bin/gopher"`);
  const result = spawnSync(shell, ['-c', 'PATH="$MOCK_TOOLS:$PATH"; export PATH; exec sh "$MOCK_SCRIPT" --dir "$GOPHER_INSTALL_DIR"'], {
    encoding: 'utf8', env: { ...process.env, MOCK_TOOLS: posix(bin), MOCK_SCRIPT: posix(path.join(root, 'install-' + platform + '.sh')), MOCK_SHA: options.badSha ? 'v1.0.0' : commit,
      MOCK_CALLS: posix(path.join(directory, 'calls')), TMPDIR: posix(directory), GOPHER_INSTALL_DIR: posix(install) },
  });
  return { result, directory, install, calls: path.join(directory, 'calls'), cleanup() {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(tempRoot));
    assert.ok(path.basename(resolved).startsWith('gopher-installer-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  } };
}

for (const platform of ['linux', 'macos']) {
  test(platform + ' installer builds the pinned master commit locally', () => {
    const f = fixture(platform);
    try {
      assert.equal(f.result.status, 0, f.result.stderr + f.result.stdout);
      const args = fs.readFileSync(f.calls, 'utf8');
      assert.match(args, /--git https:\/\/github.com\/jacobzymet\/gopher/);
      assert.ok(args.includes('--rev ' + commit));
      assert.match(args, /--locked --force --bin gopher --target test-native-target/);
      assert.match(fs.readFileSync(path.join(f.install, 'gopher'), 'utf8'), /Commit: 012345/);
    } finally { f.cleanup(); }
  });
  for (const options of [{ missingRust: true }, { missingDependencies: true }, { badSha: true }, { failBuild: true }, { wrongIdentity: true }]) {
    test(platform + ' installer preserves the app on ' + Object.keys(options)[0], () => {
      const f = fixture(platform, options);
      try {
        assert.notEqual(f.result.status, 0);
        assert.match(f.result.stderr, options.missingRust ? /Install Rust/ : options.missingDependencies ? /development files|Xcode Command Line Tools/ : options.badSha ? /valid master commit/ : options.failBuild ? /Build failed/ : /does not identify/);
        assert.equal(fs.readFileSync(path.join(f.install, 'gopher'), 'utf8'), 'existing app');
        if (!options.failBuild && !options.wrongIdentity) assert.equal(fs.existsSync(f.calls), false);
      } finally { f.cleanup(); }
    });
  }
}
