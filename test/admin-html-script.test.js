'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('admin page inline JavaScript parses successfully', () => {
  const html = fs.readFileSync(require.resolve('../admin.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length, 1, 'expected one inline admin script');
  assert.doesNotThrow(() => new vm.Script(scripts[0][1], { filename: 'admin.html:inline-script' }));
});

test('tenant invoice form omits server-managed invoice status', () => {
  const html = fs.readFileSync(require.resolve('../admin.html'), 'utf8');
  assert.match(html, /if\\(tenantActive&&active==='invoices'\\)delete data\\.status;/);
});
