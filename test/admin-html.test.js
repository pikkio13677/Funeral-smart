'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(require('node:path').join(__dirname, '..', 'admin.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);

test('admin HTML contains one syntactically valid application script', () => {
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new vm.Script(scripts[0], { filename: 'admin.html:inline-script' }));
});

test('tenant UI stays disabled until the reviewed database cutover', () => {
  assert.match(scripts[0], /const TENANT_API_ENABLED = false/);
  assert.match(html, /id="company-context"/);
  assert.match(html, /id="tenant-toolbar"/);
});

test('tenant UI uses authenticated company selection and verified tenant membership routes', () => {
  for (const route of [
    "authRequest('/companies')",
    "authRequest('/active-company'",
    "request('/company/profile')",
    "request('/company/members')",
    "request('/company/invitations')",
    "'/company/activity?limit=100'"
  ]) {
    assert.ok(scripts[0].includes(route), 'missing tenant UI integration: ' + route);
  }
});

test('tenant task completion uses the tenant API PATCH contract', () => {
  assert.match(scripts[0], /'\/tasks\/'\+row\.id\+\(TENANT_API_ENABLED\?'':'\/status'\)/);
});


test('tenant admin UI requires MFA and provides an explicit company-scoped logout', () => {
  assert.match(scripts[0], /effectiveRole\(\)==='admin'&&!currentUser\.mfaEnabled/);
  assert.match(scripts[0], /authRequest\('\/logout'/);
  assert.match(scripts[0], /function canCreateInActiveTenant/);
});

test('read-only tenant roles do not see mutation controls in the operational tables', () => {
  assert.match(scripts[0], /function canUpdateActiveResource\(\)/);
  assert.match(scripts[0], /manager:\['cases','tasks','inventory'\],operator:\['cases','tasks'\],warehouse:\['inventory'\],accounting:\['invoices'\]/);
  assert.match(scripts[0], /manager:\[\],operator:\['cases','tasks'\],warehouse:\['inventory'\],accounting:\['invoices'\]/);
  assert.match(scripts[0], /includes\(active\)&&canUpdateActiveResource\(\)/);
  assert.equal((scripts[0].match(/canUpdateActiveResource\(\)/g) || []).length >= 3, true,
    'both action headers and row controls must use the same role guard');
});

test('legacy create controls match backend role permissions as well as tenant permissions', () => {
  assert.match(scripts[0], /: \{admin:Object\.keys\(definitions\),manager:\[\],operator:\['cases','customers','tasks'\],warehouse:\['inventory'\],accounting:\['invoices'\]\}/);
  assert.match(scripts[0], /return \(allowed\[role\]\|\|\[\]\)\.includes\(active\)/);
});
