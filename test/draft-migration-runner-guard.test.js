'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { assertLocalDatabase } = require('../scripts/backfill-single-company');

test('draft database guard accepts only loopback PostgreSQL URLs outside production', () => {
  const url = assertLocalDatabase('postgres://test:test@127.0.0.1:5432/funeral_test');
  assert.equal(url.hostname, '127.0.0.1');
});

test('draft database guard rejects remote PostgreSQL hosts', () => {
  assert.throws(
    () => assertLocalDatabase('postgres://test:test@db.example.test:5432/funeral_test'),
    /Refusing a remote database host/
  );
});

test('draft database guard refuses production mode even for localhost', () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.throws(
      () => assertLocalDatabase('postgres://test:test@127.0.0.1:5432/funeral_test'),
      /Refusing to run in production/
    );
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test('draft migration runner rejects a remote DATABASE_URL before attempting a connection', () => {
  const runner = path.join(__dirname, '..', 'scripts', 'check-draft-migrations.js');
  const result = spawnSync(process.execPath, [runner], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://test:test@db.example.test:5432/funeral_test'
    }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing a remote database host/);
  assert.doesNotMatch(result.stderr, /ECONNREFUSED|ENOTFOUND|ETIMEDOUT/);
});
