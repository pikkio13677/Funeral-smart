'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const createPublicIntakeRouter = require('../public-intake-routes');

async function startApp({ staging = false, duplicateVat = false } = {}) {
  const calls = [];
  const notices = [];
  const pool = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (duplicateVat) {
        const error = new Error('duplicate');
        error.code = '23505';
        throw error;
      }
      return { rows: [{ id: '00000000-0000-4000-8000-000000000001', createdAt: '2026-11-18T00:00:00.000Z' }], rowCount: 1 };
    }
  };
  const app = express();
  app.use(express.json({ limit: '30kb' }));
  app.use('/api/v1', createPublicIntakeRouter({
    pool,
    emailNotifications: {
      async notifyInquiry(value) { notices.push({ type: 'inquiry', value }); },
      async notifyProviderApplication(value) { notices.push({ type: 'provider', value }); }
    },
    stagingSubmissionGuard(_req, res, next) {
      if (staging) return res.status(503).json({ error: 'Invio disabilitato in staging.' });
      return next();
    },
    submissionLimiter(_req, _res, next) { return next(); }
  }));
  app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  return {
    calls,
    notices,
    async post(path, body) {
      const response = await fetch(baseUrl + '/api/v1/' + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      return { status: response.status, body: await response.json() };
    },
    async close() {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  };
}

test('public family inquiries remain available through the platform intake router', async () => {
  const app = await startApp();
  try {
    const response = await app.post('inquiries', {
      city: 'Torino',
      serviceType: 'Sepoltura',
      contactEmail: 'family@example.invalid',
      privacyConsent: true
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.id, '00000000-0000-4000-8000-000000000001');
    assert.match(app.calls[0].sql, /INSERT INTO inquiries/);
    assert.deepEqual(app.calls[0].values.slice(0, 2), ['Torino', 'Sepoltura']);
    assert.equal(app.notices[0].type, 'inquiry');
    assert.match(response.body.message, /Non è ancora stata inoltrata/);
  } finally {
    await app.close();
  }
});

test('public family inquiries accept the combined cremation and burial service', async () => {
  const app = await startApp();
  try {
    const response = await app.post('inquiries', {
      city: 'Torino',
      serviceType: 'Cremazione + Sepoltura',
      contactPhone: '+390110000000',
      privacyConsent: true
    });
    assert.equal(response.status, 201);
    assert.deepEqual(app.calls[0].values.slice(0, 2), ['Torino', 'Cremazione + Sepoltura']);
    assert.equal(app.notices[0].value.serviceType, 'Cremazione + Sepoltura');
  } finally {
    await app.close();
  }
});

test('public provider applications remain available and are not automatically verified', async () => {
  const app = await startApp();
  try {
    const response = await app.post('provider-applications', {
      businessName: 'Impresa Esempio',
      vatNumber: 'IT12345678901',
      city: 'Torino',
      email: 'provider@example.invalid',
      acceptsVerification: true
    });
    assert.equal(response.status, 201);
    assert.match(app.calls[0].sql, /INSERT INTO provider_applications/);
    assert.equal(app.notices[0].type, 'provider');
    assert.match(response.body.message, /non è ancora pubblicata né verificata/);
  } finally {
    await app.close();
  }
});

test('public intake rejects missing privacy consent and invalid contact data without database writes', async () => {
  const app = await startApp();
  try {
    const response = await app.post('inquiries', {
      city: 'Torino',
      serviceType: 'Sepoltura',
      privacyConsent: false
    });
    assert.equal(response.status, 400);
    assert.equal(app.calls.length, 0);
    assert.equal(app.notices.length, 0);
  } finally {
    await app.close();
  }
});

test('public intake staging guard blocks submissions before database writes or notifications', async () => {
  const app = await startApp({ staging: true });
  try {
    const response = await app.post('inquiries', {
      city: 'Torino',
      serviceType: 'Sepoltura',
      contactPhone: '+390110000000',
      privacyConsent: true
    });
    assert.equal(response.status, 503);
    assert.equal(app.calls.length, 0);
    assert.equal(app.notices.length, 0);
  } finally {
    await app.close();
  }
});

test('duplicate provider VAT is returned as a conflict', async () => {
  const app = await startApp({ duplicateVat: true });
  try {
    const response = await app.post('provider-applications', {
      businessName: 'Impresa Esempio',
      vatNumber: 'IT12345678901',
      city: 'Torino',
      email: 'provider@example.invalid',
      acceptsVerification: true
    });
    assert.equal(response.status, 409);
    assert.equal(app.calls.length, 1);
  } finally {
    await app.close();
  }
});
