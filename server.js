'use strict';
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const { z } = require('zod');
const emailNotifications = require('./email-notifications')();
const { createResendInvitationSender, createResendVerificationSender } = require('./resend-email');

const app = express();
const port = Number(process.env.PORT || 10000);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined });

app.disable('x-powered-by');
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

const citySchema = z.string().trim().min(2).max(100);
const providerSchema = z.object({
  businessName: z.string().trim().min(2).max(180),
  vatNumber: z.string().trim().min(8).max(20),
  city: citySchema,
  province: z.string().trim().max(80).optional().default(''),
  email: z.string().trim().email().max(254),
  phone: z.string().trim().max(40).optional().default(''),
  website: z.string().trim().url().max(500).optional().or(z.literal('')),
  acceptsVerification: z.literal(true)
});
const inquirySchema = z.object({
  city: citySchema,
  serviceType: z.enum(['Sepoltura', 'Cremazione', 'Rimpatrio internazionale', 'Non so, desidero assistenza']),
  destinationCountry: z.string().trim().max(100).optional().default(''),
  budgetEuro: z.number().int().positive().max(100000).optional(),
  notes: z.string().trim().max(1500).optional().default(''),
  contactEmail: z.string().trim().email().max(254).optional(),
  contactPhone: z.string().trim().max(40).optional(),
  privacyConsent: z.literal(true)
}).refine(v => Boolean(v.contactEmail || v.contactPhone), { message: 'Inserire almeno un recapito per poter essere ricontattati.' });

const emailVerificationEnabled = process.env.ENABLE_EMAIL_VERIFICATION === 'true';
const auth = require('./auth')(pool, {
  sendVerificationEmail: createResendVerificationSender(),
  emailVerificationEnabled
});
app.use('/api/v1/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false }), auth.router);

const multiTenantEnabled = process.env.ENABLE_MULTI_TENANT === 'true';

async function assertMultiTenantSchemaReady() {
  if (process.env.ENABLE_EMAIL_VERIFICATION !== 'true' ||
      process.env.ENABLE_INVITATION_REGISTRATION !== 'true') {
    throw new Error('ENABLE_MULTI_TENANT richiede anche ENABLE_EMAIL_VERIFICATION e ENABLE_INVITATION_REGISTRATION.');
  }
  if (Buffer.byteLength(process.env.EMAIL_VERIFICATION_PEPPER || '', 'utf8') < 32) {
    throw new Error('EMAIL_VERIFICATION_PEPPER deve contenere almeno 32 byte.');
  }

  const requiredTables = [
    'companies', 'company_memberships', 'company_invitations',
    'email_verification_challenges'
  ];
  const missingTables = await pool.query(
    "SELECT name FROM unnest($1::text[]) AS expected(name) WHERE to_regclass('public.' || name) IS NULL",
    [requiredTables]
  );
  const requiredColumns = [
    ['app_sessions', 'active_membership_id'],
    ['app_users', 'email'], ['app_users', 'email_verified_at'],
    ['audit_log', 'company_id'], ['audit_log', 'membership_id'],
    ['customers', 'company_id'], ['funeral_cases', 'company_id'],
    ['staff', 'company_id'], ['vehicles', 'company_id'],
    ['inventory_items', 'company_id'], ['stock_movements', 'company_id'],
    ['tasks', 'company_id'], ['invoices', 'company_id'], ['payments', 'company_id']
  ];
  const missingColumns = await pool.query(
    `SELECT expected.table_name, expected.column_name
     FROM unnest($1::text[], $2::text[]) AS expected(table_name, column_name)
     WHERE NOT EXISTS (
       SELECT 1 FROM information_schema.columns actual
       WHERE actual.table_schema = 'public'
         AND actual.table_name = expected.table_name
         AND actual.column_name = expected.column_name
     )`,
    [requiredColumns.map(item => item[0]), requiredColumns.map(item => item[1])]
  );
  if (missingTables.rowCount || missingColumns.rowCount) {
    const objects = [
      ...missingTables.rows.map(row => row.name),
      ...missingColumns.rows.map(row => row.table_name + '.' + row.column_name)
    ];
    throw new Error('Migrazioni multi-azienda/verifica email mancanti: ' + objects.join(', '));
  }
}

  const unassignedData = await pool.query(`
    SELECT 'customers' AS table_name, COUNT(*)::int AS total FROM customers WHERE company_id IS NULL
    UNION ALL SELECT 'funeral_cases', COUNT(*)::int FROM funeral_cases WHERE company_id IS NULL
    UNION ALL SELECT 'staff', COUNT(*)::int FROM staff WHERE company_id IS NULL
    UNION ALL SELECT 'vehicles', COUNT(*)::int FROM vehicles WHERE company_id IS NULL
    UNION ALL SELECT 'inventory_items', COUNT(*)::int FROM inventory_items WHERE company_id IS NULL
    UNION ALL SELECT 'stock_movements', COUNT(*)::int FROM stock_movements WHERE company_id IS NULL
    UNION ALL SELECT 'tasks', COUNT(*)::int FROM tasks WHERE company_id IS NULL
    UNION ALL SELECT 'invoices', COUNT(*)::int FROM invoices WHERE company_id IS NULL
    UNION ALL SELECT 'payments', COUNT(*)::int FROM payments WHERE company_id IS NULL
  `);
  const unassigned = unassignedData.rows.filter(row => row.total > 0);
  if (unassigned.length) {
    throw new Error('Backfill aziendale incompleto: ' + unassigned.map(row => row.table_name + '=' + row.total).join(', '));
  }
  const activeTenant = await pool.query(`
    SELECT 1
    FROM companies c
    JOIN company_memberships m ON m.company_id = c.id
    JOIN app_users u ON u.id = m.user_id
    WHERE c.status = 'active' AND m.status = 'active' AND u.active = TRUE
    LIMIT 1
  `);
  if (!activeTenant.rowCount) {
    throw new Error('Nessuna azienda attiva con un membro attivo: completare il bootstrap tenant sul database di staging.');
  }
}

if (multiTenantEnabled) {
  const createTenantContext = require('./tenant-context');
  const tenantContext = createTenantContext(pool, auth.tokenHash);
  const companyContext = require('./company-context-routes')(pool, auth.authenticate, auth.tokenHash);
  const invitationRoutes = require('./tenant-invitation-routes')({
    pool,
    authenticate: auth.authenticate,
    tenantContext,
    sendInvitationEmail: createResendInvitationSender(),
    publicAppUrl: process.env.PUBLIC_APP_URL
  });

  // Company selection and invitation acceptance must be available before a tenant is selected.
  app.use('/api/v1', companyContext);
  app.use('/api/v1', invitationRoutes);

  // Every business module is protected by a database-derived active tenant context.
  app.use('/api/v1', auth.authenticate, tenantContext,
    require('./tenant-dashboard-routes')(pool),
    require('./tenant-customers-cases-routes')(pool),
    require('./tenant-staff-vehicles-routes')(pool),
    require('./tenant-inventory-tasks-routes')(pool),
    require('./tenant-invoices-payments-routes')(pool),
    require('./tenant-company-admin-routes')(pool),
    require('./tenant-audit-routes')(pool)
  );
}


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

app.post('/api/v1/inquiries', async (req, res, next) => {
  const parsed = inquirySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dati non validi', details: parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })) });
  const v = parsed.data;
  try {
    const { rows } = await pool.query(
      `INSERT INTO inquiries (city, service_type, destination_country, budget_euro, notes, contact_email, contact_phone, privacy_consent, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'received') RETURNING id, created_at AS "createdAt"`,
      [v.city, v.serviceType, v.destinationCountry || null, v.budgetEuro || null, v.notes || null, v.contactEmail || null, v.contactPhone || null, true]
    );
    await emailNotifications.notifyInquiry({
      id: rows[0].id,
      city: v.city,
      serviceType: v.serviceType,
      contactEmail: v.contactEmail
    });
    res.status(201).json({ data: rows[0], message: 'Richiesta ricevuta. Non è ancora stata inoltrata a un’impresa.' });
  } catch (e) { next(e); }
});

app.post('/api/v1/provider-applications', async (req, res, next) => {
  const parsed = providerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dati non validi', details: parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })) });
  const v = parsed.data;
  try {
    const { rows } = await pool.query(
      `INSERT INTO provider_applications (business_name, vat_number, city, province, email, phone, website, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING id, created_at AS "createdAt"`,
      [v.businessName, v.vatNumber, v.city, v.province, v.email, v.phone, v.website || null]
    );
    await emailNotifications.notifyProviderApplication({
      id: rows[0].id,
      businessName: v.businessName,
      city: v.city,
      email: v.email
    });
    res.status(201).json({ data: rows[0], message: 'Candidatura ricevuta: l’impresa non è ancora pubblicata né verificata.' });
  } catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'Partita IVA già presente in una candidatura.' }); next(e); }
});

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
  if (multiTenantEnabled) await assertMultiTenantSchemaReady();
  app.listen(port, () => console.log(`FUNERAL SMART API in ascolto sulla porta ${port}`));
}
startServer().catch(error => {
  console.error('[startup] Avvio non riuscito:', error.message);
  process.exitCode = 1;
});
process.on('SIGTERM', async () => { await pool.end(); process.exit(0); });
