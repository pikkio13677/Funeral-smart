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
  assert.match(html, /if\(tenantActive&&active==='invoices'\)delete data\.status;/);
});

test('tenant UI permissions hide create forms and row actions for read-only roles', () => {
  const html = fs.readFileSync(require.resolve('../admin.html'), 'utf8');
  assert.match(html, /tenantActive&&!tenantCan\(active,'create'\)/);
  assert.match(html, /function hasTenantRowActions\(resource\)/);
  assert.match(html, /if\(resource==='invoices'\)return tenantCan\('invoices','issue'\)\|\|tenantCan\('invoices','pay'\)/);
  assert.match(html, /if\(hasTenantRowActions\(active\)\)/);
});

test('additional company form enforces the API field length limits', () => {
  const html = fs.readFileSync(require.resolve('../admin.html'), 'utf8');
  assert.match(html, /vatNumber:20,address:500,city:100,province:80,email:254,phone:40/);
});

test('tenant UI exposes accounting invoice actions and permitted audit views', () => {
  const html = fs.readFileSync(require.resolve('../admin.html'), 'utf8');
  assert.match(html, /accounting:\{customers:\['read'\],cases:\['read'\],invoices:\['read','create','issue','pay'\],audit:\['read'\]\}/);
  assert.match(html, /r==='accounting'\)return \['invoices','security','audit'\]/);
  assert.match(html, /r==='admin'\|\|r==='manager'\)return Object\.keys\(definitions\)\.concat\(r==='admin'\?\['company','users','security','audit'\]:\['security','audit'\]\)/);
});
