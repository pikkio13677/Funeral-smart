'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'platform.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);

test('platform console contains one syntactically valid application script', () => {
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new vm.Script(scripts[0], { filename: 'platform.html:inline-script' }));
});

test('platform console uses same-origin cookie sessions and owner-only API endpoints', () => {
  assert.match(scripts[0], /credentials:'same-origin'/);
  assert.match(scripts[0], /\/platform\/companies/);
  assert.match(scripts[0], /\/platform\/audit/);
  assert.match(scripts[0], /\/auth\/mfa\/verify-login/);
  assert.match(scripts[0], /\/auth\/mfa\/setup/);
  assert.match(scripts[0], /\/auth\/mfa\/enable/);
  assert.match(scripts[0], /\/auth\/logout/);
});

test('platform console provides company search, member details, status controls and audit history', () => {
  for (const fragment of ['companySearch', 'statusFilter', 'memberRows', 'statusActions', 'auditRows', 'reason.trim().length<10']) {
    assert.ok(html.includes(fragment), 'missing console feature: ' + fragment);
  }
});

test('platform console does not persist authentication or MFA secrets in browser storage', () => {
  assert.doesNotMatch(scripts[0], /localStorage|sessionStorage|document\.cookie/);
  assert.match(html, /autocomplete="off"/);
  assert.match(html, /noindex,nofollow/);
});

test('platform console supports verified-provider inquiry assignment and assignment history', () => {
  assert.match(scripts[0], /data-assign-inquiry/);
  assert.match(scripts[0], /\/platform\/inquiries\/.*\/assign/);
  assert.match(scripts[0], /\/assignments/);
  assert.match(scripts[0], /status==='verified'/);
  assert.match(html, /platform\.inquiry\.assigned/);
});
