'use strict';

const express = require('express');
const crypto = require('node:crypto');
const { z } = require('zod');

const citySchema = z.string().trim().min(2).max(100);
const providerSchema = z.object({
  businessName: z.string().trim().min(2).max(180),
  vatNumber: z.string().trim().min(8).max(20),
  city: citySchema,
  province: z.string().trim().max(80).optional().default(''),
  email: z.string().trim().email().max(254),
  phone: z.string().trim().max(40).optional().default(''),
  website: z.union([z.string().trim().url().max(500), z.literal('')]).optional().default(''),
  acceptsVerification: z.literal(true)
}).strict();

const inquirySchema = z.object({
  city: citySchema,
  serviceType: z.enum(['Sepoltura', 'Cremazione', 'Cremazione + Sepoltura', 'Rimpatrio internazionale', 'Non so, desidero assistenza']),
  destinationCountry: z.string().trim().max(100).optional().default(''),
  budgetEuro: z.number().int().positive().max(100000).optional(),
  notes: z.string().trim().max(1500).optional().default(''),
  contactEmail: z.string().trim().email().max(254).optional(),
  contactPhone: z.string().trim().max(40).optional(),
  privacyConsent: z.literal(true)
}).strict().refine(value => Boolean(value.contactEmail || value.contactPhone), {
  message: 'Inserire almeno un recapito per poter essere ricontattati.'
});

function createMariaDbPublicIntakeRouter(database, options = {}) {
  if (!database || typeof database.query !== 'function') throw new TypeError('A MariaDB database adapter with query() is required.');
  if (typeof options.submissionLimiter !== 'function') throw new TypeError('Public submission rate limiter is required.');
  const router = express.Router();

  router.post('/inquiries', options.submissionLimiter, async (req, res, next) => {
    const parsed = inquirySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({
      error: 'Dati non validi',
      details: parsed.error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message }))
    });
    const value = parsed.data;
    try {
      const id = crypto.randomUUID();
      await database.query(
        "INSERT INTO inquiries (id, city, service_type, destination_country, budget_euro, notes, contact_email, contact_phone, privacy_consent, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'received', UTC_TIMESTAMP(3))",
        [id, value.city, value.serviceType, value.destinationCountry || null, value.budgetEuro ?? null,
          value.notes || null, value.contactEmail || null, value.contactPhone || null]
      );
      const [rows] = await database.query(
        'SELECT id, created_at AS createdAt FROM inquiries WHERE id = ? LIMIT 1',
        [id]
      );
      return res.status(201).json({
        data: rows[0],
        message: 'Richiesta ricevuta. Non è ancora stata inoltrata a un’impresa.'
      });
    } catch (error) { return next(error); }
  });

  router.post('/provider-applications', options.submissionLimiter, async (req, res, next) => {
    const parsed = providerSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({
      error: 'Dati non validi',
      details: parsed.error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message }))
    });
    const value = parsed.data;
    try {
      const id = require('node:crypto').randomUUID();
      await database.query(
        "INSERT INTO provider_applications (id, business_name, vat_number, city, province, email, phone, website, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', UTC_TIMESTAMP(3))",
        [id, value.businessName, value.vatNumber, value.city, value.province, value.email, value.phone, value.website || null]
      );
      const [rows] = await database.query('SELECT id, created_at AS createdAt FROM provider_applications WHERE id = ? LIMIT 1', [id]);
      return res.status(201).json({
        data: rows[0],
        message: 'Candidatura ricevuta: l’impresa non è ancora pubblicata né verificata.'
      });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Partita IVA già presente in una candidatura o impresa.' });
      return next(error);
    }
  });

  return router;
}

module.exports = createMariaDbPublicIntakeRouter;
