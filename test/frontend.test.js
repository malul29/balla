const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// One page, one big script: a duplicate `const` or a typo anywhere stops every tab from working.
test('the app page script parses (no syntax errors or duplicate declarations)', () => {
  for (const file of ['index.html', 'login.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(file === 'login.html' || scripts.length > 0, 'index.html has an inline script');
    for (const code of scripts) assert.doesNotThrow(() => new vm.Script(code, { filename: file }), file);
  }
});
