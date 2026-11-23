'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('composer labels the empty capability state', () => {
  const controls = fs.readFileSync('src/ui/chat/scripts/controls.js', 'utf8');
  const styles = fs.readFileSync('src/ui/chat/styles/composer.css', 'utf8');

  assert.match(controls, /!settings\.agentMode && !researchOn && composerMentionIds\.size === 0/);
  assert.match(controls, /empty\.textContent = 'No agent capabilities enabled'/);
  assert.match(styles, /\.composer-capabilities-empty\s*\{/);
});
