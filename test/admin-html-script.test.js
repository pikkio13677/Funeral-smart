'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

test('published management UI matches the reviewed root admin page', () => {
  const rootPage = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
  const publishedPage = fs.readFileSync(path.join(root, 'public', 'admin.html'), 'utf8');
  assert.equal(publishedPage, rootPage);
});

test('published management page inline JavaScript parses successfully', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'admin.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length > 0, 'expected an inline management UI script');
  for (const match of scripts) new vm.Script(match[1]);
});

test('email verification UI calls only the authenticated verification endpoints', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'admin.html'), 'utf8');
  assert.match(html, /\/email\/verification\/request/);
  assert.match(html, /\/email\/verification\/confirm/);
  assert.match(html, /currentUser\.emailVerificationEnabled/);
});

test('management UI supports explicit tenant company selection and tenant-scoped API routing', () => {
  const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
  assert.match(html, /id="tenant-selector"/);
  assert.match(html, /\/api\/v1\/companies/);
  assert.match(html, /\/active-company/);
  assert.match(html, /tenantMode\?api\+'\/api\/v1'/);
  assert.match(html, /tenantRole/);
  assert.match(html, /\/company\/activity\?limit=100/);
  assert.match(html, /request\(tenantMode\?'\/tasks\/'\+row\.id/);
  assert.match(html, /if\(active==='users'&&!tenantMode\)/);
  assert.match(html, /tenantRole==='admin'\|\|currentUser\?\.role==='admin'\).*return \['security'\]/);
  assert.match(html, /tenantCan\('tasks','read'\)\?Promise\.resolve\(\{data:\[\]\}\):request\('\/tasks'\)/);

});
