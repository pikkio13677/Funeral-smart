'use strict';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function createEmailNotifications({ env = process.env, fetchImpl = global.fetch, logger = console } = {}) {
  async function send(to, subject, lines) {
    if (!to || !env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL) {
      logger.warn('[email] Invio saltato: configurazione Resend o destinatario assente.');
      return false;
    }

    const text = lines.join('\n');
    const html = '<div>' + lines.map(line => '<p>' + escapeHtml(line) + '</p>').join('') + '</div>';

    try {
      const response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + env.RESEND_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ from: env.RESEND_FROM_EMAIL, to: [to], subject, text, html }),
        signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) {
        logger.error('[email] Resend ha restituito HTTP ' + response.status + '.');
        return false;
      }
      return true;
    } catch (_error) {
      logger.error('[email] Richiesta a Resend non riuscita.');
      return false;
    }
  }

  function adminUrl() {
    try {
      return new URL('/admin', env.PUBLIC_APP_URL).toString();
    } catch (_error) {
      return '';
    }
  }

  async function notifyInquiry({ id, city, serviceType, contactEmail }) {
    const tasks = [];
    if (contactEmail) {
      tasks.push(send(
        contactEmail,
        'Abbiamo ricevuto la tua richiesta — FUNERAL SMART',
        [
          'Grazie per aver contattato FUNERAL SMART.',
          'Abbiamo ricevuto correttamente la tua richiesta di assistenza.',
          'La richiesta non è stata ancora inoltrata automaticamente a un’impresa.',
          'Il nostro team potrà ricontattarti usando il recapito che hai fornito.'
        ]
      ));
    }
    if (env.ADMIN_NOTIFICATION_EMAIL) {
      const lines = [
        'È arrivata una nuova richiesta tramite il sito FUNERAL SMART.',
        'Numero richiesta: ' + id,
        'Città: ' + city,
        'Servizio richiesto: ' + serviceType
      ];
      const url = adminUrl();
      if (url) lines.push('Apri l’area gestionale: ' + url);
      tasks.push(send(env.ADMIN_NOTIFICATION_EMAIL, 'Nuova richiesta ricevuta — FUNERAL SMART', lines));
    } else {
      logger.warn('[email] ADMIN_NOTIFICATION_EMAIL non configurata: avviso amministratore saltato.');
    }
    await Promise.all(tasks);
  }

  async function notifyProviderApplication({ id, businessName, city, email }) {
    if (!env.ADMIN_NOTIFICATION_EMAIL) {
      logger.warn('[email] ADMIN_NOTIFICATION_EMAIL non configurata: avviso candidatura saltato.');
      return;
    }
    const lines = [
      'È arrivata una nuova candidatura di un’impresa tramite FUNERAL SMART.',
      'Numero candidatura: ' + id,
      'Impresa: ' + businessName,
      'Città: ' + city,
      'Email di contatto: ' + email,
      'La candidatura è in attesa di verifica e non rende l’impresa pubblica.'
    ];
    const url = adminUrl();
    if (url) lines.push('Apri l’area gestionale: ' + url);
    await send(env.ADMIN_NOTIFICATION_EMAIL, 'Nuova candidatura impresa — FUNERAL SMART', lines);
  }

  return { notifyInquiry, notifyProviderApplication };
}

module.exports = createEmailNotifications;
