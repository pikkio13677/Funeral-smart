'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createEmailNotifications = require('../email-notifications');

function setup(overrides = {}) {
  const calls = [];
  const logs = [];
  const env = {
    RESEND_API_KEY: 're_test_only',
    RESEND_FROM_EMAIL: 'FUNERAL SMART <test@example.com>',
    ADMIN_NOTIFICATION_EMAIL: 'admin@example.com',
    PUBLIC_APP_URL: 'https://funeral-smart-api.onrender.com',
    ...overrides
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return { ok: true, status: 200 };
  };
  const logger = { warn: message => logs.push(message), error: message => logs.push(message) };
  return { calls, logs, notifier: createEmailNotifications({ env, fetchImpl, logger }) };
}

test('inquiry sends customer confirmation and administrator notice', async () => {
  const { calls, notifier } = setup();
  await notifier.notifyInquiry({
    id: 41, city: 'Brescia', serviceType: 'Cremazione', contactEmail: 'cliente@example.com'
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call.body.to[0]).sort(), ['admin@example.com', 'cliente@example.com']);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.match(calls.find(call => call.body.to[0] === 'admin@example.com').body.text, /Numero richiesta: 41/);
});

test('inquiry without customer email still notifies administrator', async () => {
  const { calls, notifier } = setup();
  await notifier.notifyInquiry({ id: 42, city: 'Brescia', serviceType: 'Sepoltura', contactEmail: null });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.to[0], 'admin@example.com');
});

test('provider application sends an administrator notice only', async () => {
  const { calls, notifier } = setup();
  await notifier.notifyProviderApplication({
    id: 9, businessName: 'Impresa di prova', city: 'Brescia', email: 'impresa@example.com'
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.to[0], 'admin@example.com');
  assert.match(calls[0].body.text, /in attesa di verifica/);
});

test('missing Resend configuration never throws or sends', async () => {
  const { calls, notifier } = setup({ RESEND_API_KEY: '' });
  await notifier.notifyInquiry({
    id: 43, city: 'Brescia', serviceType: 'Sepoltura', contactEmail: 'cliente@example.com'
  });
  assert.equal(calls.length, 0);
});

test('missing administrator recipient skips only administrator notices', async () => {
  const { calls, notifier } = setup({ ADMIN_NOTIFICATION_EMAIL: '' });
  await notifier.notifyInquiry({
    id: 44, city: 'Brescia', serviceType: 'Sepoltura', contactEmail: 'cliente@example.com'
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.to[0], 'cliente@example.com');
});
