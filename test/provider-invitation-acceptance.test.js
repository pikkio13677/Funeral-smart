'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const page = fs.readFileSync(path.join(__dirname, '..', 'provider-invitation-acceptance.html'), 'utf8');
const inlineScripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);

test('provider invitation acceptance page has valid inline JavaScript', () => {
  assert.equal(inlineScripts.length, 1);
  assert.doesNotThrow(() => new vm.Script(inlineScripts[0], { filename: 'provider-invitation-acceptance.html' }));
});

test('page uses the existing same-origin login and MFA session endpoints', () => {
  const script = inlineScripts[0];
  assert.match(script, /\/auth\/me/);
  assert.match(script, /\/auth\/login/);
  assert.match(script, /\/auth\/mfa\/verify-login/);
  assert.match(script, /credentials:\s*'same-origin'/);
});

test('page accepts provider invitations only through the dedicated provider endpoint', () => {
  const script = inlineScripts[0];
  assert.match(script, /\/provider-portal\/invitations\/accept/);
  assert.match(script, /body:\{token:invitationToken\}/);
  assert.match(script, /replaceState/);
  assert.match(script, /no-store/);
});

test('page does not create accounts, access the legacy admin area, or expose invitation tokens in links', () => {
  const script = inlineScripts[0];
  assert.doesNotMatch(script, /invitation\/register|company\/invitations\/accept|location\.assign\(['"]\/admin/);
  assert.match(page, /name="referrer" content="no-referrer"/);
  assert.match(page, /noindex,nofollow,noarchive/);
});
