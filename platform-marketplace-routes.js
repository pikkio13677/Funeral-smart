'use strict';

const express = require('express');
const { z } = require('zod');

const UUID = z.string().uuid();
const text = (max, min = 0) => z.string().trim().min(min).max(max);
const optionalText = max => z.string().trim().max(max).optional().nullable();

function createPlatformMarketplaceRouter(pool, options = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('A PostgreSQL pool with query/connect is required.');
  }
  if (typeof options.authenticate !== 'function' || typeof options.requirePlatformRole !== 'function') {
    throw new TypeError('Authentication and platform-role middleware are required.');
  }

  const router = express.Router();
  router.use(options.authenticate, options.requirePlatformRole('owner'));

  async function writeAudit(client, req, action, resource, resourceId, reason) {
    await client.query(
      'INSERT INTO platform_audit_log (actor_user_id,actor_username,action,resource,resource_id,reason,ip_address) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [req.user.id, req.user.username || null, action, resource, String(resourceId), reason, req.ip || null]
    );
  }

  router.get('/inquiries', async (req, res, next) => {
    const parsed = z.object({
      status: z.enum(['received', 'reviewed', 'assigned', 'closed', 'deleted']).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50)
    }).strict().safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: 'Filtri o paginazione richieste non validi.' });
    try {
      const result = await pool.query(
        'SELECT i.id,i.city,i.service_type AS "serviceType",i.destination_country AS "destinationCountry",i.budget_euro AS "budgetEuro",i.notes,i.contact_email AS "contactEmail",i.contact_phone AS "contactPhone",i.privacy_consent AS "privacyConsent",i.status,i.created_at AS "createdAt", ' +
        'a.id AS "assignmentId",a.provider_id AS "assignedProviderId",p.business_name AS "assignedProviderName",a.assigned_at AS "assignedAt" ' +
        'FROM inquiries i LEFT JOIN LATERAL (SELECT id,provider_id,assigned_at FROM inquiry_provider_assignments WHERE inquiry_id=i.id AND status=\'active\' ORDER BY assigned_at DESC LIMIT 1) a ON TRUE ' +
        'LEFT JOIN providers p ON p.id=a.provider_id ' +
        'WHERE (($1::varchar IS NULL AND i.status <> \'deleted\') OR i.status=$1) ORDER BY i.created_at DESC,i.id DESC LIMIT $2',
        [parsed.data.status || null, parsed.data.limit]
      );
      res.json({ data: result.rows });
    } catch (error) { next(error); }
  });

  router.get('/inquiries/:id/assignments', async (req, res, next) => {
    const id = UUID.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: 'Identificativo richiesta non valido.' });
    try {
      const result = await pool.query(
        'SELECT a.id,a.provider_id AS "providerId",p.business_name AS "providerName",a.status,a.assigned_at AS "assignedAt",a.revoked_at AS "revokedAt",a.revocation_reason AS "revocationReason",assigned.username AS "assignedBy",revoked.username AS "revokedBy" ' +
        'FROM inquiry_provider_assignments a JOIN providers p ON p.id=a.provider_id ' +
        'LEFT JOIN app_users assigned ON assigned.id=a.assigned_by_user_id LEFT JOIN app_users revoked ON revoked.id=a.revoked_by_user_id ' +
        'WHERE a.inquiry_id=$1 ORDER BY a.assigned_at DESC,a.id DESC',
        [id.data]
      );
      res.json({ data: result.rows });
    } catch (error) { next(error); }
  });

  router.post('/inquiries/:id/assign', async (req, res, next) => {
    const id = UUID.safeParse(req.params.id);
    const parsed = z.object({ providerId: UUID, reason: text(500, 10) }).strict().safeParse(req.body);
    if (!id.success || !parsed.success) return res.status(400).json({ error: 'Richiesta, impresa o motivazione non valide.' });
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const inquiry = await client.query('SELECT id,status FROM inquiries WHERE id=$1 FOR UPDATE', [id.data]);
      if (!inquiry.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Richiesta non trovata.' });
      }
      if (!['received', 'reviewed'].includes(inquiry.rows[0].status)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'La richiesta non è disponibile per una nuova assegnazione.' });
      }
      const provider = await client.query('SELECT id,status FROM providers WHERE id=$1 FOR UPDATE', [parsed.data.providerId]);
      if (!provider.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Impresa non trovata.' });
      }
      if (provider.rows[0].status !== 'verified') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'La richiesta può essere assegnata soltanto a un’impresa verificata.' });
      }
      const assignment = await client.query(
        "INSERT INTO inquiry_provider_assignments (inquiry_id,provider_id,assigned_by_user_id,status) VALUES ($1,$2,$3,'active') RETURNING id,provider_id AS \"providerId\",assigned_at AS \"assignedAt\",status",
        [id.data, parsed.data.providerId, req.user.id]
      );
      await client.query("UPDATE inquiries SET status='assigned' WHERE id=$1", [id.data]);
      await writeAudit(client, req, 'platform.inquiry.assigned', 'inquiry', id.data, parsed.data.reason);
      await client.query('COMMIT');
      res.status(201).json({ data: assignment.rows[0], message: 'Richiesta assegnata. L’assegnazione è registrata nello storico.' });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      if (error.code === '23505') return res.status(409).json({ error: 'La richiesta ha già un’impresa assegnataria attiva.' });
      next(error);
    } finally { if (client) client.release(); }
  });

  router.patch('/inquiries/:id/status', async (req, res, next) => {
    const id = UUID.safeParse(req.params.id);
    const parsed = z.object({
      status: z.enum(['reviewed', 'closed']),
      reason: text(500, 10)
    }).strict().safeParse(req.body);
    if (!id.success || !parsed.success) return res.status(400).json({ error: 'Stato o motivazione della richiesta non validi.' });
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const current = await client.query('SELECT id,status FROM inquiries WHERE id=$1 FOR UPDATE', [id.data]);
      if (!current.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Richiesta non trovata.' });
      }
      if (current.rows[0].status === 'deleted') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'La richiesta è già stata eliminata logicamente.' });
      }
      const allowedTransitions = {
        received: ['reviewed', 'closed'],
        reviewed: ['closed'],
        assigned: [],
        closed: []
      };
      if (!(allowedTransitions[current.rows[0].status] || []).includes(parsed.data.status)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Transizione di stato non consentita per questa richiesta.' });
      }
      if (parsed.data.status === 'closed' && current.rows[0].status === 'assigned') {
        const revoked = await client.query(
          "UPDATE inquiry_provider_assignments SET status='revoked',revoked_at=NOW(),revoked_by_user_id=$2,revocation_reason=$3 WHERE inquiry_id=$1 AND status='active' RETURNING id",
          [id.data, req.user.id, parsed.data.reason]
        );
        if (revoked.rowCount) {
          await writeAudit(client, req, 'platform.inquiry.assignment_revoked', 'inquiry', id.data, parsed.data.reason);
        }
      }
      const updated = await client.query(
        'UPDATE inquiries SET status=$1 WHERE id=$2 RETURNING id,status',
        [parsed.data.status, id.data]
      );
      await writeAudit(client, req, 'platform.inquiry.status_changed', 'inquiry', id.data, parsed.data.reason);
      await client.query('COMMIT');
      res.json({ data: updated.rows[0] });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      next(error);
    } finally { if (client) client.release(); }
  });

  router.get('/provider-applications', async (req, res, next) => {
    const parsed = z.object({
      status: z.enum(['pending', 'approved', 'rejected']).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50)
    }).strict().safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: 'Filtri candidature non validi.' });
    try {
      const result = await pool.query(
        'SELECT id,business_name AS "businessName",vat_number AS "vatNumber",city,province,email,phone,website,status,created_at AS "createdAt" ' +
        'FROM provider_applications WHERE ($1::varchar IS NULL OR status=$1) ORDER BY created_at DESC,id DESC LIMIT $2',
        [parsed.data.status || null, parsed.data.limit]
      );
      res.json({ data: result.rows });
    } catch (error) { next(error); }
  });

  router.post('/provider-applications/:id/approve', async (req, res, next) => {
    const id = UUID.safeParse(req.params.id);
    const parsed = z.object({ reason: text(500, 10) }).strict().safeParse(req.body);
    if (!id.success || !parsed.success) return res.status(400).json({ error: 'Identificativo o motivazione non validi.' });
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const application = await client.query(
        'SELECT id,business_name,vat_number,city,province,email,phone,website,status FROM provider_applications WHERE id=$1 FOR UPDATE',
        [id.data]
      );
      if (!application.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Candidatura non trovata.' });
      }
      const item = application.rows[0];
      if (item.status !== 'pending') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'La candidatura è già stata gestita.' });
      }
      const duplicate = await client.query('SELECT id FROM providers WHERE vat_number=$1', [item.vat_number]);
      if (duplicate.rowCount) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Esiste già un’impresa con questa partita IVA.' });
      }
      const provider = await client.query(
        "INSERT INTO providers (business_name,vat_number,city,province,email,phone,website,status) VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') " +
        'RETURNING id,business_name AS "businessName",vat_number AS "vatNumber",city,province,email,phone,website,status,verification_date AS "verificationDate"',
        [item.business_name, item.vat_number, item.city, item.province, item.email, item.phone, item.website]
      );
      await client.query("UPDATE provider_applications SET status='approved' WHERE id=$1", [id.data]);
      await writeAudit(client, req, 'platform.provider_application.approved', 'provider_application', id.data, parsed.data.reason);
      await client.query('COMMIT');
      res.status(201).json({ data: provider.rows[0], message: 'Candidatura approvata. L’impresa resta non verificata e non è pubblica.' });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      if (error.code === '23505') return res.status(409).json({ error: 'Partita IVA già registrata per un’impresa.' });
      next(error);
    } finally { if (client) client.release(); }
  });

  router.post('/provider-applications/:id/reject', async (req, res, next) => {
    const id = UUID.safeParse(req.params.id);
    const parsed = z.object({ reason: text(500, 10) }).strict().safeParse(req.body);
    if (!id.success || !parsed.success) return res.status(400).json({ error: 'Identificativo o motivazione non validi.' });
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const current = await client.query('SELECT id,status FROM provider_applications WHERE id=$1 FOR UPDATE', [id.data]);
      if (!current.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Candidatura non trovata.' });
      }
      if (current.rows[0].status !== 'pending') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'La candidatura è già stata gestita.' });
      }
      await client.query("UPDATE provider_applications SET status='rejected' WHERE id=$1", [id.data]);
      await writeAudit(client, req, 'platform.provider_application.rejected', 'provider_application', id.data, parsed.data.reason);
      await client.query('COMMIT');
      res.json({ message: 'Candidatura rifiutata. Nessuna impresa è stata pubblicata.' });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      next(error);
    } finally { if (client) client.release(); }
  });

  router.get('/providers', async (_req, res, next) => {
    try {
      const result = await pool.query(
        "SELECT id,business_name AS \"businessName\",vat_number AS \"vatNumber\",city,province,email,phone,website,status,verification_date AS \"verificationDate\",created_at AS \"createdAt\" " +
        "FROM providers ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'verified' THEN 1 ELSE 2 END,business_name LIMIT 300"
      );
      res.json({ data: result.rows });
    } catch (error) { next(error); }
  });

  router.post('/providers/:id/verify', async (req, res, next) => {
    const id = UUID.safeParse(req.params.id);
    const parsed = z.object({ documentsReviewed: z.literal(true), reason: text(500, 10) }).strict().safeParse(req.body);
    if (!id.success || !parsed.success) return res.status(400).json({ error: 'Conferma la verifica dei documenti e inserisci una motivazione.' });
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const current = await client.query('SELECT id,status FROM providers WHERE id=$1 FOR UPDATE', [id.data]);
      if (!current.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Impresa non trovata.' });
      }
      if (current.rows[0].status !== 'pending') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Solo un’impresa in attesa può essere verificata.' });
      }
      const verified = await client.query(
        "UPDATE providers SET status='verified',verification_date=NOW(),updated_at=NOW() WHERE id=$1 RETURNING id,business_name AS \"businessName\",status,verification_date AS \"verificationDate\"",
        [id.data]
      );
      await writeAudit(client, req, 'platform.provider.verified', 'provider', id.data, parsed.data.reason);
      await client.query('COMMIT');
      res.json({ data: verified.rows[0], message: 'Impresa verificata. Potrà comparire nelle ricerche pubbliche.' });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      next(error);
    } finally { if (client) client.release(); }
  });

  const priceListSchema = z.object({
    providerId: UUID,
    serviceTypeId: UUID,
    title: text(180, 1),
    totalEuro: z.number().nonnegative().max(10000000).nullable().optional(),
    vatIncluded: z.boolean().nullable().optional(),
    includedItems: z.array(text(240, 1)).max(100).optional().default([]),
    excludedItems: z.array(text(240, 1)).max(100).optional().default([]),
    thirdPartyCostsNote: optionalText(1500),
    validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional()
  }).strict().refine(value => !value.validFrom || !value.validUntil || value.validUntil >= value.validFrom, {
    message: 'La data di fine validità non può precedere quella iniziale.'
  });

  router.get('/price-lists', async (_req, res, next) => {
    try {
      const result = await pool.query(
        'SELECT pl.id,pl.provider_id AS "providerId",p.business_name AS "businessName",p.status AS "providerStatus",pl.service_type_id AS "serviceTypeId",st.label AS "serviceLabel",pl.title,pl.total_euro AS "totalEuro",pl.vat_included AS "vatIncluded",pl.included_items AS "includedItems",pl.excluded_items AS "excludedItems",pl.third_party_costs_note AS "thirdPartyCostsNote",pl.valid_from AS "validFrom",pl.valid_until AS "validUntil",pl.published,pl.created_at AS "createdAt" ' +
        'FROM price_lists pl JOIN providers p ON p.id=pl.provider_id JOIN service_types st ON st.id=pl.service_type_id ORDER BY p.business_name,pl.created_at DESC LIMIT 300'
      );
      res.json({ data: result.rows });
    } catch (error) { next(error); }
  });

  router.post('/price-lists', async (req, res, next) => {
    const parsed = priceListSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Dati listino non validi.', details: parsed.error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message })) });
    const value = parsed.data;
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const provider = await client.query('SELECT id,status FROM providers WHERE id=$1 FOR UPDATE', [value.providerId]);
      if (!provider.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Impresa non trovata.' });
      }
      if (provider.rows[0].status !== 'verified') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Puoi creare un listino solo per un’impresa verificata.' });
      }
      const service = await client.query('SELECT id FROM service_types WHERE id=$1 AND active=TRUE', [value.serviceTypeId]);
      if (!service.rowCount) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Servizio non disponibile.' });
      }
      const created = await client.query(
        'INSERT INTO price_lists (provider_id,service_type_id,title,total_euro,vat_included,included_items,excluded_items,third_party_costs_note,valid_from,valid_until,published) ' +
        'VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,FALSE) RETURNING id,provider_id AS "providerId",title,total_euro AS "totalEuro",published,valid_from AS "validFrom",valid_until AS "validUntil"',
        [value.providerId, value.serviceTypeId, value.title, value.totalEuro ?? null, value.vatIncluded ?? null, JSON.stringify(value.includedItems), JSON.stringify(value.excludedItems), value.thirdPartyCostsNote || null, value.validFrom || null, value.validUntil || null]
      );
      await writeAudit(client, req, 'platform.price_list.created', 'price_list', created.rows[0].id, 'Creato listino come bozza.');
      await client.query('COMMIT');
      res.status(201).json({ data: created.rows[0], message: 'Listino salvato come bozza: non è pubblico.' });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      next(error);
    } finally { if (client) client.release(); }
  });

  router.patch('/price-lists/:id/publication', async (req, res, next) => {
    const id = UUID.safeParse(req.params.id);
    const parsed = z.object({ published: z.boolean(), reason: text(500, 10) }).strict().safeParse(req.body);
    if (!id.success || !parsed.success) return res.status(400).json({ error: 'Aggiornamento pubblicazione non valido.' });
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const current = await client.query('SELECT pl.id,p.status AS "providerStatus" FROM price_lists pl JOIN providers p ON p.id=pl.provider_id WHERE pl.id=$1 FOR UPDATE OF pl,p', [id.data]);
      if (!current.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Listino non trovato.' });
      }
      if (parsed.data.published && current.rows[0].providerStatus !== 'verified') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Puoi pubblicare un listino solo per un’impresa verificata.' });
      }
      const updated = await client.query('UPDATE price_lists SET published=$1 WHERE id=$2 RETURNING id,published', [parsed.data.published, id.data]);
      await writeAudit(client, req, parsed.data.published ? 'platform.price_list.published' : 'platform.price_list.unpublished', 'price_list', id.data, parsed.data.reason);
      await client.query('COMMIT');
      res.json({ data: updated.rows[0], message: parsed.data.published ? 'Listino pubblicato.' : 'Listino ritirato dalla pubblicazione.' });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      next(error);
    } finally { if (client) client.release(); }
  });

  return router;
}

module.exports = createPlatformMarketplaceRouter;
