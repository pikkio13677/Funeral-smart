'use strict';

const express = require('express');
const { z } = require('zod');

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

/**
 * Public intake is platform-scoped, not company-scoped. It must remain
 * available when tenant APIs replace the legacy company-admin API.
 */
function createPublicIntakeRouter({ pool, emailNotifications, stagingSubmissionGuard, submissionLimiter } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('A PostgreSQL-compatible pool is required.');
  if (typeof stagingSubmissionGuard !== 'function' || typeof submissionLimiter !== 'function') {
    throw new TypeError('Staging and rate-limit middleware are required.');
  }

  const router = express.Router();

  router.post('/inquiries', stagingSubmissionGuard, submissionLimiter, async (req, res, next) => {
    const parsed = inquirySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Dati non validi',
        details: parsed.error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message }))
      });
    }

    const value = parsed.data;
    try {
      const { rows } = await pool.query(
        `INSERT INTO inquiries (city, service_type, destination_country, budget_euro, notes, contact_email, contact_phone, privacy_consent, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,'received') RETURNING id, created_at AS "createdAt"`,
        [value.city, value.serviceType, value.destinationCountry || null, value.budgetEuro ?? null,
          value.notes || null, value.contactEmail || null, value.contactPhone || null]
      );
      await emailNotifications?.notifyInquiry?.({
        id: rows[0].id,
        city: value.city,
        serviceType: value.serviceType,
        contactEmail: value.contactEmail
      });
      return res.status(201).json({
        data: rows[0],
        message: 'Richiesta ricevuta. Non è ancora stata inoltrata a un’impresa.'
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/provider-applications', stagingSubmissionGuard, submissionLimiter, async (req, res, next) => {
    const parsed = providerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Dati non validi',
        details: parsed.error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message }))
      });
    }

    const value = parsed.data;
    try {
      const { rows } = await pool.query(
        `INSERT INTO provider_applications (business_name, vat_number, city, province, email, phone, website, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING id, created_at AS "createdAt"`,
        [value.businessName, value.vatNumber, value.city, value.province, value.email,
          value.phone, value.website || null]
      );
      await emailNotifications?.notifyProviderApplication?.({
        id: rows[0].id,
        businessName: value.businessName,
        city: value.city,
        email: value.email
      });
      return res.status(201).json({
        data: rows[0],
        message: 'Candidatura ricevuta: l’impresa non è ancora pubblicata né verificata.'
      });
    } catch (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Partita IVA già presente in una candidatura.' });
      }
      return next(error);
    }
  });

  return router;
}

module.exports = createPublicIntakeRouter;
