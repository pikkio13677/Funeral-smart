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
  assert.match(html, /r==='admin'\|\|r==='manager'\)return Object\.keys\(definitions\)\.concat\(tenantActive\?\[\]:\['inquiries','providerApplications'\],r==='admin'\?\['company','users','security','audit'\]:\['security','audit'\]\)/);
});

test('online inquiries are visible in a read-only authorized admin module', () => {
  const html = fs.readFileSync(require.resolve('../admin.html'), 'utf8');
  assert.match(html, /function renderInquiriesModule\(host\)/);
  assert.match(html, /request\('\/inquiries'\)/);
  assert.match(html, /Richieste di preventivo online/);
  assert.match(html, /non vengono inoltrate automaticamente alle imprese/);
  assert.match(html, /if\(active==='inquiries'\)\{renderInquiriesModule\(host\);return;\}/);
});

test('provider approval and verification controls are available only to administrators', () => {
  const html = fs.readFileSync(require.resolve('../admin.html'), 'utf8');
  assert.ok(html.includes('function renderProviderApplicationsModule(host)'));
  assert.ok(html.includes("request('/provider-applications')"));
  assert.ok(html.includes("request('/providers')"));
  assert.ok(html.includes("'/provider-applications/'+encodeURIComponent(row.id)+'/approve'"));
  assert.ok(html.includes("'/provider-applications/'+encodeURIComponent(row.id)+'/reject'"));
  assert.ok(html.includes("'/providers/'+encodeURIComponent(row.id)+'/verify'"));
  assert.ok(html.includes('documentsReviewed:true'));
  assert.ok(html.includes('Conferma verifica'));
  assert.ok(html.includes("currentUser?.role==='admin'"));
  assert.ok(html.includes('Gestione imprese funebri'));
  assert.ok(html.includes('Partita IVA'));
  assert.ok(html.includes("if(active==='providerApplications'){renderProviderApplicationsModule(host);return;}"));
  assert.ok(html.includes('Solo le imprese verificate possono apparire nelle ricerche pubbliche.'));
});

test('price list administration creates drafts and gates publication', () => {
  const html = fs.readFileSync(require.resolve('../admin.html'), 'utf8');
  const server = fs.readFileSync(require.resolve('../server.js'), 'utf8');
  assert.ok(html.includes("request('/price-lists')"));
  assert.ok(html.includes("request('/price-lists',{method:'POST'"));
  assert.ok(html.includes("'/price-lists/'+encodeURIComponent(row.id)+'/publication'"));
  assert.ok(html.includes('Salva listino come bozza'));
  assert.ok(html.includes('I nuovi listini vengono salvati come bozze.'));
  assert.ok(server.includes('SELECT id, code, label, description FROM service_types'));
});
