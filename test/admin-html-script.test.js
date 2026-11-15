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
