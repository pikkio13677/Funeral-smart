'use strict';

const DEFAULT_FROM = 'FUNERAL SMART <onboarding@resend.dev>';
const RESEND_ENDPOINT = 'https://api.resend.com/emails';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function validateInvitationUrl(value) {
  let url;
  try { url = new URL(value); } catch (_) {
    throw new TypeError('Il link di invito non è valido.');
  }
  if (url.protocol !== 'https:') {
    throw new TypeError('Il link di invito deve utilizzare HTTPS.');
  }
  return url.toString();
}

function createResendInvitationSender({
  apiKey = process.env.RESEND_API_KEY,
  from = process.env.RESEND_FROM_EMAIL || DEFAULT_FROM,
  fetchImpl = globalThis.fetch
} = {}) {
  return async function sendInvitationEmail({ to, companyName, invitationUrl, expiresAt } = {}) {
    if (!apiKey) throw new Error('RESEND_API_KEY non configurata.');
    if (typeof fetchImpl !== 'function') throw new Error('Fetch non disponibile nel runtime Node.');
    if (typeof to !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      throw new TypeError('Destinatario email non valido.');
    }
    if (typeof companyName !== 'string' || !companyName.trim() || companyName.length > 180) {
      throw new TypeError('Nome azienda non valido.');
    }

    const safeUrl = validateInvitationUrl(invitationUrl);
    const expiry = new Date(expiresAt);
    if (!Number.isFinite(expiry.getTime())) throw new TypeError('Scadenza invito non valida.');

    const safeCompany = escapeHtml(companyName.trim());
    const safeLink = escapeHtml(safeUrl);
    const expiryText = expiry.toLocaleString('it-IT', {
      dateStyle: 'long',
      timeStyle: 'short',
      timeZone: 'Europe/Rome'
    });
    const subject = 'Invito a FUNERAL SMART';
    const text = [
      'Sei stato invitato a collaborare su FUNERAL SMART.',
      'Azienda: ' + companyName.trim(),
      'Accetta l’invito entro: ' + expiryText,
      'Apri questo link sicuro: ' + safeUrl,
      'Se non riconosci questa richiesta, ignora il messaggio.'
    ].join('\n');

    const html = '<div style="font-family:Arial,sans-serif;line-height:1.6;color:#202820;max-width:560px;margin:auto">' +
      '<h2>Invito a FUNERAL SMART</h2>' +
      '<p>Sei stato invitato a collaborare con <strong>' + safeCompany + '</strong>.</p>' +
      '<p>L’invito è personale e scade il <strong>' + escapeHtml(expiryText) + '</strong>.</p>' +
      '<p><a href="' + safeLink + '" style="display:inline-block;padding:12px 18px;background:#174b36;color:#fff;text-decoration:none;border-radius:6px">Accetta invito</a></p>' +
      '<p>Se il pulsante non funziona, copia questo indirizzo nel browser:<br><a href="' + safeLink + '">' + safeLink + '</a></p>' +
      '<p>Se non riconosci questa richiesta, ignora il messaggio.</p>' +
      '</div>';

    const response = await fetchImpl(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from, to: [to.trim().toLowerCase()], subject, text, html }),
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout
        ? AbortSignal.timeout(10000)
        : undefined
    });

    let payload = {};
    try { payload = await response.json(); } catch (_) {}
    if (!response.ok) {
      // Do not include the API key, request body, or provider response in logs/errors.
      throw new Error('Resend ha rifiutato l’invio (HTTP ' + response.status + ').');
    }
    if (!payload || typeof payload.id !== 'string' || !payload.id) {
      throw new Error('Resend non ha restituito un identificativo email valido.');
    }
    return { success: true, messageId: payload.id };
  };
}

module.exports = { createResendInvitationSender, escapeHtml, validateInvitationUrl };
