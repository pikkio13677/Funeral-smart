'use strict';
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const { z } = require('zod');
const emailNotifications = require('./email-notifications')();
const stagingSubmissionGuard = require('./staging-submission-guard')();
const assertTenantCutoverReady = require('./tenant-cutover-guard');
const assertTenantSchemaReady = require('./tenant-cutover-readiness');
const mountApiRouters = require('./api-route-mounts');
const createPublicIntakeRouter = require('./public-intake-routes');

// Tenant routes require a separate approval flag and a read-only database preflight before the listener opens.
assertTenantCutoverReady(process.env);

const app = express();
const port = Number(process.env.PORT || 10000);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined });

app.disable('x-powered-by');
// Render terminates TLS at its proxy; trust exactly one proxy hop for client IP rate limits.
app.set('trust proxy', 1);
app.use(helmet());
const allowedOrigins = [...new Set(['https://pikkio13677.github.io', 'https://funeral-smart-api.onrender.com', 'https://funeral-smart-web.onrender.com', 'https://funeralsmartapp.com', 'https://www.funeralsmartapp.com', ...(process.env.CORS_ORIGIN || '').split(',').map(x => x.trim()).filter(Boolean)])];
app.use(cors({ credentials: true, origin(origin, cb) {
  if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
  return cb(new Error('Origine non autorizzata'));
} }));
app.use((req, _res, next) => {
  const raw = req.headers.cookie || '';
  req.cookies = Object.fromEntries(raw.split(';').map(part => {
    const index = part.indexOf('=');
    return index < 0 ? ['', ''] : [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
  next();
});
app.use(express.json({ limit: '30kb' }));
app.use('/api/v1/', rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, standardHeaders: 'draft-7', legacyHeaders: false }));
const publicSubmissionLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false });

// Public family and provider intake is platform-scoped and remains mounted in tenant mode.
app.use('/api/v1', createPublicIntakeRouter({
  pool,
  emailNotifications,
  stagingSubmissionGuard,
  submissionLimiter: publicSubmissionLimiter
}));


if (!multiTenantEnabled) {
  app.get('/api/v1/admin/inquiries', auth.authenticate, auth.authorize, async (_req, res, next) => {
    try { const { rows } = await pool.query('SELECT id, city, service_type AS "serviceType", destination_country AS "destinationCountry", budget_euro AS "budgetEuro", notes, contact_email AS "contactEmail", contact_phone AS "contactPhone", status, created_at AS "createdAt" FROM inquiries ORDER BY created_at DESC LIMIT 200'); res.json({ data: rows }); }
    catch (e) { next(e); }
  });
  
  app.get('/api/v1/admin/provider-applications', auth.authenticate, auth.authorize, async (_req, res, next) => {
    try { const { rows } = await pool.query('SELECT id, business_name AS "businessName", vat_number AS "vatNumber", city, province, email, phone, website, status, created_at AS "createdAt" FROM provider_applications ORDER BY created_at DESC LIMIT 200'); res.json({ data: rows }); }
    catch (e) { next(e); }
  });
  
  // Area gestionale protetta: tutte le rotte richiedono ADMIN_API_KEY.
  app.use('/api/v1/admin', auth.authenticate, auth.authorize, require('./admin-routes')(pool, (_req, _res, next) => next()));
  
}

// Pagina same-origin per accettare inviti aziendali. I dati restano gestiti dalle API protette.
app.get('/invito/accetta', (_req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  res.sendFile(require('path').join(__dirname, 'invitation.html'));
});

// Console proprietario piattaforma: separata dall'area gestionale delle singole imprese.
app.get('/platform', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  res.sendFile(require('path').join(__dirname, 'platform.html'));
});

// Area gestionale web: disponibile sullo stesso servizio Render all'indirizzo /admin.
app.get('/admin', (_req, res) => {
  // La pagina gestionale usa script e stili inline: abilitarli solo su questa pagina.
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  res.sendFile(require('path').join(__dirname, 'admin.html'));
});

app.use((err, _req, res, _next) => {
  console.error(err.message);
  res.status(500).json({ error: 'Errore interno. Riprova più tardi.' });
});

async function startServer() {
  if (multiTenantEnabled) {
    const readiness = await assertTenantSchemaReady(pool);
    console.log('Tenant cutover preflight superato:', readiness);
  }
  app.listen(port, () => console.log(`FUNERAL SMART API in ascolto sulla porta ${port}`));
}

startServer().catch(async error => {
  console.error('AVVIO BLOCCATO:', error.message);
  await pool.end();
  process.exitCode = 1;
});

process.on('SIGTERM', async () => { await pool.end(); process.exit(0); });
