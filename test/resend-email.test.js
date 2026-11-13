'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createResendInvitationSender, escapeHtml, validateInvitationUrl } = require('../resend-email');

const input = {
  to: 'COLLEGA@example.com',
  companyName: 'Impresa & Figli',
  invitationUrl: 'https://funeralsmart.example/invito/accetta?token=abc123',
  expiresAt: '2026-11-20T12:00:00.000Z'
};

test('escapes HTML content', () => {
  assert.equal(escapeHtml('<script>"&\''),
    '&lt;script&gt;&quot;&amp;&#39;');
});

test('accepts only HTTPS invitation links', () => {
  assert.equal(validateInvitationUrl(input.invitationUrl), input.invitationUrl);
  assert.throws(() => validateInvitationUrl('http://example.com/invite'), /HTTPS/);
});

test('sends a server-side Resend request and returns its message id', async () => {
  let request;
  const send = createResendInvitationSender({
    apiKey: 'test-secret',
    from: 'FUNERAL SMART <onboarding@resend.dev>',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, json: async () => ({ id: 'email_test_123' }) };
    }
  });

  const result = await send(input);
  assert.deepEqual(result, { success: true, messageId: 'email_test_123' });
  assert.equal(request.url, 'https://api.resend.com/emails');
  assert.equal(request.options.headers.Authorization, 'Bearer test-secret');
  const body = JSON.parse(request.options.body);
  assert.deepEqual(body.to, ['collega@example.com']);
  assert.match(body.text, /Impresa & Figli/);
  assert.match(body.html, /Impresa &amp; Figli/);
});

test('does not send when the API key is missing', async () => {
  const send = createResendInvitationSender({ apiKey: '', fetchImpl: async () => {
    throw new Error('fetch should not run');
  } });
  await assert.rejects(send(input), /RESEND_API_KEY/);
});

test('does not report success when Resend rejects the request', async () => {
  const send = createResendInvitationSender({
    apiKey: 'test-secret',
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ message: 'private provider detail' }) })
  });
  await assert.rejects(send(input), /HTTP 403/);
});

test('rejects invalid recipients, links, and expiry dates', async () => {
  const send = createResendInvitationSender({ apiKey: 'test-secret', fetchImpl: async () => {
    throw new Error('fetch should not run');
  } });
  await assert.rejects(send({ ...input, to: 'not-an-email' }), /Destinatario/);
  await assert.rejects(send({ ...input, invitationUrl: 'javascript:alert(1)' }), /HTTPS/);
  await assert.rejects(send({ ...input, expiresAt: 'not-a-date' }), /Scadenza/);
});
