'use strict';
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const { z } = require('zod');

const app = express();
const port = Number(process.env.PORT || 10000);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined });

app.disable('x-powered-by');
app.use(helmet());
const allowedOrigins = (process.env.CORS_ORIGIN || '').split(',').map(x => x.trim()).filter(Boolean);
app.use(cors({ origin(origin, cb) {
  if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return cb(null, true);
  return cb(new Error('Origine non autorizzata'));
} }));
app.use(express.json({ limit: '30kb' }));
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, standardHeaders: 'draft-7', legacyHeaders: false }));

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

function adminOnly(req, res, next) {
  const key = req.get('x-admin-key');
  if (!process.env.ADMIN_API_KEY || !key || key !== process.env.ADMIN_API_KEY) return res.status(401).json({ error: 'Non autorizzato' });
  next();
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
    res.status(201).json({ data: rows[0], message: 'Candidatura ricevuta: l’impresa non è ancora pubblicata né verificata.' });
  } catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'Partita IVA già presente in una candidatura.' }); next(e); }
});

app.get('/api/v1/admin/inquiries', adminOnly, async (_req, res, next) => {
  try { const { rows } = await pool.query('SELECT id, city, service_type AS "serviceType", destination_country AS "destinationCountry", budget_euro AS "budgetEuro", notes, contact_email AS "contactEmail", contact_phone AS "contactPhone", status, created_at AS "createdAt" FROM inquiries ORDER BY created_at DESC LIMIT 200'); res.json({ data: rows }); }
  catch (e) { next(e); }
});

app.get('/api/v1/admin/provider-applications', adminOnly, async (_req, res, next) => {
  try { const { rows } = await pool.query('SELECT id, business_name AS "businessName", vat_number AS "vatNumber", city, province, email, phone, website, status, created_at AS "createdAt" FROM provider_applications ORDER BY created_at DESC LIMIT 200'); res.json({ data: rows }); }
  catch (e) { next(e); }
});

app.use((err, _req, res, _next) => {
  console.error(err.message);
  res.status(500).json({ error: 'Errore interno. Riprova più tardi.' });
});

app.listen(port, () => console.log(`FUNERAL SMART API in ascolto sulla porta ${port}`));
process.on('SIGTERM', async () => { await pool.end(); process.exit(0); });
