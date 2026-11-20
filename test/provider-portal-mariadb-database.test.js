'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createMariaDbDatabase = require('../provider-portal-mariadb/database');

const env = {
  MARIADB_HOST: '127.0.0.1',
  MARIADB_USER: 'funeral_test',
  MARIADB_PASSWORD: 'not-a-real-secret',
  MARIADB_DATABASE: 'funeral_sandbox'
};

function fakeDriver() {
  const calls = [];
  const connection = {
    async beginTransaction() { calls.push('begin'); },
    async commit() { calls.push('commit'); },
    async rollback() { calls.push('rollback'); },
    release() { calls.push('release'); }
  };
  const pool = {
    async execute(sql, values) { calls.push(['execute', sql, values]); return [[{ ok: 1 }], []]; },
    async query(sql) { calls.push(['query', sql]); return [[{ ok: 1 }], []]; },
    async getConnection() { calls.push('getConnection'); return connection; },
    async end() { calls.push('end'); }
  };
  return { calls, driver: { createPool(config) { calls.push(['createPool', config]); return pool; } } };
}

test('rifiuta configurazione MariaDB incompleta senza creare il pool', () => {
  assert.throws(() => createMariaDbDatabase({ env: {}, mysql: { createPool() { throw new Error('non deve essere chiamato'); } } }), /MARIADB_HOST/);
});

test('crea il pool con opzioni sicure e delega query parametrizzate', async () => {
  const fake = fakeDriver();
  const db = createMariaDbDatabase({ env, mysql: fake.driver });
  const config = fake.calls.find(call => Array.isArray(call) && call[0] === 'createPool')[1];
  assert.equal(config.database, 'funeral_sandbox');
  assert.equal(config.timezone, 'Z');
  assert.equal(config.charset, 'utf8mb4');
  await db.query('SELECT ?', [7]);
  assert.deepEqual(fake.calls.at(-1), ['execute', 'SELECT ?', [7]]);
  await db.close();
});

test('conferma la transazione e rilascia sempre la connessione', async () => {
  const fake = fakeDriver();
  const db = createMariaDbDatabase({ env, mysql: fake.driver });
  const value = await db.withTransaction(async connection => {
    assert.ok(connection);
    return 'ok';
  });
  assert.equal(value, 'ok');
  assert.deepEqual(fake.calls.slice(-4), ['getConnection', 'begin', 'commit', 'release']);
});

test('annulla la transazione se il lavoro fallisce e conserva l’errore originale', async () => {
  const fake = fakeDriver();
  const db = createMariaDbDatabase({ env, mysql: fake.driver });
  await assert.rejects(db.withTransaction(async () => { throw new Error('test failure'); }), /test failure/);
  assert.deepEqual(fake.calls.slice(-4), ['getConnection', 'begin', 'rollback', 'release']);
});
