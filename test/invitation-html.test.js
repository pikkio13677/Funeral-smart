'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const rootPage = fs.readFileSync(path.join(__dirname, '..', 'invitation.html'), 'utf8');
const publicPage = fs.readFileSync(path.join(__dirname, '..', 'public', 'invito', 'accetta', 'index.html'), 'utf8');

function scripts(html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
}

test('invitation acceptance page has syntactically valid inline JavaScript', () => {
  const inline = scripts(rootPage);
  assert.equal(inline.length, 1);
  assert.doesNotThrow(() => new vm.Script(inline[0], { filename: 'invitation.html:inline-script' }));
});

test('public invitation URL redirects to the same-origin API page without exposing the token', () => {
  const inline = scripts(publicPage);
  assert.equal(inline.length, 1);
  assert.doesNotThrow(() => new vm.Script(inline[0], { filename: 'public/invito/accetta/index.html:inline-script' }));
  assert.match(inline[0], /FUNERAL_SMART_API_URL/);
  assert.match(inline[0], /encodeURIComponent\(token\)/);
  assert.match(inline[0], /\/invito\/accetta\?token=/);
});

test('invite onboarding supports existing accounts, MFA and invitation-only registration', () => {
  const inline = scripts(rootPage)[0];
  assert.match(inline, /\/api\/v1\/auth\/login/);
  assert.match(inline, /\/api\/v1\/auth\/mfa\/verify-login/);
  assert.match(inline, /\/api\/v1\/auth\/invitation\/register/);
  assert.match(inline, /\/api\/v1\/admin\/company\/invitations\/accept/);
  assert.match(inline, /\/admin/);
});
