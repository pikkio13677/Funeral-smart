'use strict';

// Standalone MariaDB staging API. This entry point never imports or opens the PostgreSQL server.
require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const createMariaDbDatabase = require('./database');
const createMariaDbAuth = require('./auth');
const createMariaDbProviderAreaRouter = require('./index');
const createMariaDbPlatformInquiryRouter = require('./platform-inquiry-routes');
const createMariaDbPublicIntakeRouter = require('./public-intake-routes');

function assertStagingDatabase(env = process.env) {
  if (env.FUNERAL_SMART_ENV !== 'staging') {
    throw new Error('Avvio bloccato: FUNERAL_SMART_ENV deve essere staging.');
  }
  if (!env.MARIADB_DATABASE || !env.MARIADB_STAGING_DATABASE ||
      env.MARIADB_DATABASE !== env.MARIADB_STAGING_DATABASE) {
    throw new Error('Avvio bloccato: MARIADB_DATABASE deve coincidere esattamente con MARIADB_STAGING_DATABASE.');
  }
  if (env.ENABLE_MULTI_TENANT === 'true' || env.ENABLE_PROVIDER_PORTAL === 'true') {
    throw new Error('Avvio bloccato: le flag del backend PostgreSQL non sono ammesse nel servizio MariaDB staging.');
  }
}

function createApp({ database, auth, env = process.env, sendInvitationEmail } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(express.json({ limit: '30kb' }));

  app.get('/api/health', async (_req, res) => {
    try {
      await database.ping();
      res.set('Cache-Control', 'no-store').json({ status: 'ok', service: 'funeral-smart-mariadb-staging', database: 'connected' });
    } catch (_) {
      res.status(503).set('Cache-Control', 'no-store').json({ status: 'degraded', service: 'funeral-smart-mariadb-staging', database: 'unavailable' });
    }
  });

  app.use((req, _res, next) => {
    const raw = req.headers.cookie || '';
    req.cookies = Object.fromEntries(raw.split(';').map(part => {
      const index = part.indexOf('=');
      if (index < 0) return ['', ''];
      const key = part.slice(0, index).trim();
      try { return [key, decodeURIComponent(part.slice(index + 1).trim())]; }
      catch (_) { return [key, '']; }
    }).filter(([key]) => key));
    next();
  });
  app.use('/api/v1/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false }), auth.router);
  const publicSubmissionLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false });
  app.use('/api/v1', createMariaDbPublicIntakeRouter(database, { submissionLimiter: publicSubmissionLimiter }));
  app.use('/api/v1/platform', createMariaDbPlatformInquiryRouter(database, { authenticate: auth.authenticate }));
  app.use('/api/v1/provider-portal', createMariaDbProviderAreaRouter(database, {
    authenticate: auth.authenticate,
    publicAppUrl: env.PUBLIC_APP_URL,
    // No real email sender is configured by this staging server.
    sendInvitationEmail
  }));


  app.get('/platform/richieste', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
    res.sendFile(require('node:path').join(__dirname, '..', 'platform-inquiries-mariadb.html'));
  });

  app.use((err, _req, res, _next) => {
    // Do not leak SQL, credentials, tokens, or stack traces to clients or logs.
    res.status(500).json({ error: 'Errore interno del servizio staging.' });
  });
  return app;
}

async function start() {
  assertStagingDatabase(process.env);
  const database = createMariaDbDatabase();
  try {
    await database.ping();
    const auth = createMariaDbAuth(database);
    const app = createApp({ database, auth });
    const port = Number(process.env.PORT || 10000);
    const server = app.listen(port, () => process.stdout.write('FUNERAL SMART MariaDB staging API pronta sulla porta ' + port + '\\n'));
    const shutdown = async () => {
      server.close(async () => {
        try { await database.close(); } finally { process.exit(0); }
      });
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  } catch (error) {
    await database.close();
    throw error;
  }
}

if (require.main === module) {
  start().catch(error => {
    process.stderr.write('Avvio staging bloccato: ' + error.message + '\\n');
    process.exitCode = 1;
  });
}

module.exports = { assertStagingDatabase, createApp, start };
