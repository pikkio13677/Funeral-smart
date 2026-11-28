'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const createMariaDbAuth = require('../provider-portal-mariadb/auth');
const { assertStagingDatabase, createApp } = require('../provider-portal-mariadb/staging-server');
const { assertBootstrapEnvironment } = require('../scripts/bootstrap-mariadb-staging-admin');

const scrypt = promisify(crypto.scrypt);

test('staging server refuses missing or mismatched database identity', () => {
  assert.throws(() => assertStagingDatabase({}), /FUNERAL_SMART_ENV/);
  assert.throws(() => assertStagingDatabase({
    FUNERAL_SMART_ENV: 'staging',
    MARIADB_DATABASE: 'funeral_production',
    MARIADB_STAGING_DATABASE: 'funeral_staging'
  }), /coincidere esattamente/);
  assert.doesNotThrow(() => assertStagingDatabase({
    FUNERAL_SMART_ENV: 'staging',
    MARIADB_DATABASE: 'funeral_staging',
    MARIADB_STAGING_DATABASE: 'funeral_staging'
  }));
});

test('staging server refuses PostgreSQL tenant feature flags', () => {
  assert.throws(() => assertStagingDatabase({
    FUNERAL_SMART_ENV: 'staging',
    MARIADB_DATABASE: 'funeral_staging',
    MARIADB_STAGING_DATABASE: 'funeral_staging',
    ENABLE_MULTI_TENANT: 'true'
  }), /flag del backend PostgreSQL/);
});

test('MariaDB authentication validates existing scrypt password hashes', async () => {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt('correct horse battery staple', salt, 64);
  const stored = 'scrypt$' + salt.toString('hex') + '$' + derived.toString('hex');
  assert.equal(await createMariaDbAuth.verifyPassword('correct horse battery staple', stored), true);
  assert.equal(await createMariaDbAuth.verifyPassword('wrong password', stored), false);
  assert.equal(await createMariaDbAuth.verifyPassword('anything', 'plain-text-password'), false);
});

test('session authentication resolves only a live session and updates last_seen', async () => {
  const calls = [];
  const database = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes('FROM app_sessions s')) {
        return [[{ id: 'user-1', username: 'demo', displayName: 'Demo', role: 'admin', active: 1 }]];
      }
      return [{ affectedRows: 1 }];
    }
  };
  const auth = createMariaDbAuth(database, { env: { NODE_ENV: 'test' } });
  const req = { cookies: { fs_session: 'opaque-session-token' } };
  const response = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  let nextCalled = false;
  await auth.authenticate(req, response, error => { if (error) throw error; nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(req.user.id, 'user-1');
  assert.equal(calls.length, 2);
  assert.match(calls[1].sql, /UPDATE app_sessions SET last_seen_at/);
});

test('unauthenticated requests do not query MariaDB', async () => {
  let queried = false;
  const auth = createMariaDbAuth({ async query() { queried = true; return [[]]; } });
  const response = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  await auth.authenticate({ cookies: {} }, response, () => assert.fail('next must not be called'));
  assert.equal(response.statusCode, 401);
  assert.equal(queried, false);
});

test('bootstrap account amministratore richiede conferma esplicita e database staging coincidente', () => {
  const base = {
    FUNERAL_SMART_ENV: 'staging',
    MARIADB_DATABASE: 'funeral_smart_staging',
    MARIADB_STAGING_DATABASE: 'funeral_smart_staging',
    STAGING_BOOTSTRAP_CONFIRM: 'CREATE_FIRST_STAGING_ADMIN',
    STAGING_BOOTSTRAP_USERNAME: 'stage.admin',
    STAGING_BOOTSTRAP_DISPLAY_NAME: 'Amministratore Staging',
    STAGING_BOOTSTRAP_PASSWORD: 'a-very-long-staging-password'
  };
  assert.doesNotThrow(() => assertBootstrapEnvironment(base));
  assert.throws(() => assertBootstrapEnvironment({ ...base, MARIADB_DATABASE: 'production' }), /database MariaDB non identificato/);
  assert.throws(() => assertBootstrapEnvironment({ ...base, STAGING_BOOTSTRAP_CONFIRM: '' }), /Conferma bootstrap mancante/);
});

test('console richieste MariaDB è servita e API piattaforma usa il controllo admin', async () => {
  const app = createApp({
    database: { async ping() { return true; }, async query() { return [[], []]; }, async withTransaction(work) { return work({ async execute() { return [[], []]; } }); } },
    auth: {
      router: require('express').Router(),
      authenticate(req, _res, next) { req.user = { id: 'user-1', username: 'admin', role: 'admin' }; next(); }
    },
    env: { NODE_ENV: 'test' }
  });
  const server = require('node:http').createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const page = await fetch(base + '/platform/richieste');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Richieste delle famiglie/);
    const api = await fetch(base + '/api/v1/platform/providers');
    assert.equal(api.status, 200);
    assert.match(api.headers.get('cache-control') || '', /no-store/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});


test('staging API consente cookie cross-origin soltanto agli origin configurati', async () => {
  const app = createApp({
    database: { async ping() { return true; }, async query() { return [[], []]; }, async withTransaction(work) { return work({ async execute() { return [[], []]; } }); } },
    auth: { router: require('express').Router(), authenticate(_req, _res, next) { next(); } },
    env: { NODE_ENV: 'production', CORS_ORIGIN: 'https://funeralsmartapp.com, https://www.funeralsmartapp.com' }
  });
  const server = require('node:http').createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = 'http://127.0.0.1:' + server.address().port + '/api/v1/provider-portal/me';
    const allowed = await fetch(url, { method: 'OPTIONS', headers: {
      Origin: 'https://funeralsmartapp.com',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'content-type'
    } });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://funeralsmartapp.com');
    assert.equal(allowed.headers.get('access-control-allow-credentials'), 'true');

    const denied = await fetch(url, { method: 'OPTIONS', headers: {
      Origin: 'https://evil.example',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'content-type'
    } });
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
  } finally { await new Promise(resolve => server.close(resolve)); }
});


test('cookie cross-site richiede produzione e SameSite=None usa Secure', () => {
  const cookieOptions = createMariaDbAuth.cookieOptions;
  assert.equal(cookieOptions({ NODE_ENV: 'production' }).sameSite, 'lax');
  const crossSite = cookieOptions({ NODE_ENV: 'production', SESSION_COOKIE_SAME_SITE: 'none' });
  assert.equal(crossSite.sameSite, 'none');
  assert.equal(crossSite.secure, true);
  assert.throws(() => cookieOptions({ NODE_ENV: 'development', SESSION_COOKIE_SAME_SITE: 'none' }), /richiede NODE_ENV=production/);
  assert.throws(() => cookieOptions({ NODE_ENV: 'production', SESSION_COOKIE_SAME_SITE: 'invalid' }), /deve essere lax/);
});
