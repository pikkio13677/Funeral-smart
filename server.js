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

const auth = require('./auth')(pool);
const routeMounts = mountApiRouters({ app, pool, auth, emailNotifications, env: process.env, rateLimit });
const multiTenantEnabled = routeMounts.multiTenantEnabled;

app.get('/api/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ status: 'ok', service: 'funeral-smart-api', database: 'connected' }); }
  catch (_e) { res.status(503).json({ status: 'degraded', service: 'funeral-smart-api', database: 'unavailable' }); }
});

app.get('/api/v1/services', async (_req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT code, label, description FROM service_types WHERE active = TRUE ORDER BY sort_order, label');
    res.json({ data: rows });
  } catch (e) { next(e); }
});

app.get('/api/v1/providers', async (req, res, next) => {
  const parsed = z.object({ city: z.string().trim().max(100).optional(), service: z.string().trim().max(80).optional() }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Filtri non validi' });
  try {
    const values = []; let where = "p.status = 'verified'";
    if (parsed.data.city) { values.push(`%${parsed.data.city}%`); where += ` AND (p.city ILIKE $${values.length} OR p.province ILIKE $${values.length})`; }
    if (parsed.data.service) { values.push(parsed.data.service); where += ` AND EXISTS (SELECT 1 FROM provider_services ps JOIN service_types st ON st.id=ps.service_type_id WHERE ps.provider_id=p.id AND st.code=$${values.length})`; }
    const { rows } = await pool.query(`SELECT p.id, p.business_name AS "businessName", p.city, p.province, p.website, p.phone, p.verification_date AS "verificationDate" FROM providers p WHERE ${where} ORDER BY p.business_name LIMIT 100`, values);
    res.json({ data: rows, count: rows.length, note: 'Sono mostrate esclusivamente imprese con stato verificato.' });
  } catch (e) { next(e); }
});

app.get('/api/v1/price-lists', async (req, res, next) => {
  const parsed = z.object({ city: z.string().trim().max(100).optional(), service: z.string().trim().max(80).optional() }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Filtri non validi' });
  try {
    const values = []; let where = "pl.published = TRUE AND p.status = 'verified'";
    if (parsed.data.city) { values.push(`%${parsed.data.city}%`); where += ` AND (p.city ILIKE $${values.length} OR p.province ILIKE $${values.length})`; }
    if (parsed.data.service) { values.push(parsed.data.service); where += ` AND st.code = $${values.length}`; }
    const { rows } = await pool.query(
      `SELECT pl.id, pl.title, pl.total_euro AS "totalEuro", pl.vat_included AS "vatIncluded",
              pl.included_items AS "includedItems", pl.excluded_items AS "excludedItems",
              pl.third_party_costs_note AS "thirdPartyCostsNote", pl.valid_from AS "validFrom", pl.valid_until AS "validUntil",
              p.id AS "providerId", p.business_name AS "businessName", p.city, p.province,
              st.code AS "serviceCode", st.label AS "serviceLabel"
       FROM price_lists pl JOIN providers p ON p.id=pl.provider_id
       JOIN service_types st ON st.id=pl.service_type_id WHERE ${where}
       AND (pl.valid_until IS NULL OR pl.valid_until >= CURRENT_DATE)
       ORDER BY p.city, p.business_name, pl.title LIMIT 200`, values
    );
    res.json({ data: rows, count: rows.length, note: 'Sono mostrati solo listini pubblicati di imprese verificate. Un prezzo nullo indica che il totale va richiesto.' });
  } catch (e) { next(e); }
});

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

// Pagina dedicata agli inviti del portale imprese: distinta dal flusso legacy aziendale.
app.get('/provider/invito/accetta', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  res.sendFile(require('path').join(__dirname, 'provider-invitation-acceptance.html'));
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
