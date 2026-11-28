'use strict';

const express = require('express');
const { z } = require('zod');

const UUID = z.string().uuid();
const reasonSchema = z.string().trim().min(10).max(500);

function createMariaDbPlatformInquiryRouter(database, options = {}) {
  if (!database || typeof database.query !== 'function' || typeof database.withTransaction !== 'function') {
    throw new TypeError('A MariaDB database adapter with query() and withTransaction() is required.');
  }
  if (typeof options.authenticate !== 'function') throw new TypeError('Authentication middleware is required.');

  const router = express.Router();
  router.use(options.authenticate, (req, res, next) => {
    if (!['admin', 'platform_owner'].includes(req.user?.role)) {
      return res.status(403).json({ error: 'Accesso riservato agli amministratori della piattaforma.' });
    }
    next();
  });

  async function audit(connection, req, action, resourceId) {
    await connection.execute(
      'INSERT INTO audit_log (user_id, username, action, resource, resource_id, ip_address, created_at) VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))',
      [req.user.id, req.user.username || null, action, 'inquiry', resourceId, req.ip || null]
    );
  }

  router.get('/inquiries', async (req, res, next) => {
    const parsed = z.object({
      status: z.enum(['received', 'reviewed', 'assigned', 'closed', 'deleted']).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50)
    }).strict().safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: 'Filtri o paginazione richieste non validi.' });
    try {
      const [rows] = await database.query(
        'SELECT i.id, i.city, i.service_type AS serviceType, i.destination_country AS destinationCountry, i.budget_euro AS budgetEuro, i.notes, i.contact_email AS contactEmail, i.contact_phone AS contactPhone, i.privacy_consent AS privacyConsent, i.status, i.created_at AS createdAt, a.id AS assignmentId, a.provider_id AS assignedProviderId, p.business_name AS assignedProviderName, a.assigned_at AS assignedAt FROM inquiries i LEFT JOIN inquiry_provider_assignments a ON a.active_inquiry_id = i.id LEFT JOIN providers p ON p.id = a.provider_id WHERE ((? IS NULL AND i.status <> \'deleted\') OR i.status = ?) ORDER BY i.created_at DESC, i.id DESC LIMIT ?',
        [parsed.data.status || null, parsed.data.status || null, parsed.data.limit]
      );
      res.set('Cache-Control', 'no-store').json({ data: rows });
    } catch (error) { next(error); }
  });

  router.get('/providers', async (_req, res, next) => {
    try {
      const [rows] = await database.query(
        "SELECT id, business_name AS businessName, city, province FROM providers WHERE status = 'verified' ORDER BY business_name LIMIT 300"
      );
      res.set('Cache-Control', 'no-store').json({ data: rows });
    } catch (error) { next(error); }
  });

  router.get('/inquiries/:id/assignments', async (req, res, next) => {
    const id = UUID.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: 'Identificativo richiesta non valido.' });
    try {
      const [rows] = await database.query(
        'SELECT a.id, a.provider_id AS providerId, p.business_name AS providerName, a.status, a.assigned_at AS assignedAt, a.revoked_at AS revokedAt, a.revocation_reason AS revocationReason, assigned.username AS assignedBy, revoked.username AS revokedBy FROM inquiry_provider_assignments a JOIN providers p ON p.id = a.provider_id LEFT JOIN app_users assigned ON assigned.id = a.assigned_by_user_id LEFT JOIN app_users revoked ON revoked.id = a.revoked_by_user_id WHERE a.inquiry_id = ? ORDER BY a.assigned_at DESC, a.id DESC',
        [id.data]
      );
      res.set('Cache-Control', 'no-store').json({ data: rows });
    } catch (error) { next(error); }
  });

  router.post('/inquiries/:id/assign', async (req, res, next) => {
    const id = UUID.safeParse(req.params.id);
    const parsed = z.object({ providerId: UUID, reason: reasonSchema }).strict().safeParse(req.body);
    if (!id.success || !parsed.success) return res.status(400).json({ error: 'Richiesta, impresa o motivazione non valide.' });
    try {
      const outcome = await database.withTransaction(async connection => {
        const [inquiries] = await connection.execute('SELECT id, status FROM inquiries WHERE id = ? FOR UPDATE', [id.data]);
        if (!inquiries.length) return { status: 404, body: { error: 'Richiesta non trovata.' } };
        if (!['received', 'reviewed', 'assigned'].includes(inquiries[0].status)) {
          return { status: 409, body: { error: 'La richiesta non è disponibile per una nuova assegnazione.' } };
        }
        const [active] = await connection.execute(
          "SELECT id FROM inquiry_provider_assignments WHERE inquiry_id = ? AND status = 'active' FOR UPDATE",
          [id.data]
        );
        if (active.length) return { status: 409, body: { error: 'La richiesta ha già un’impresa assegnataria attiva.' } };
        const [providers] = await connection.execute("SELECT id FROM providers WHERE id = ? AND status = 'verified' FOR UPDATE", [parsed.data.providerId]);
        if (!providers.length) return { status: 409, body: { error: 'La richiesta può essere assegnata soltanto a un’impresa verificata.' } };
        await connection.execute(
          "INSERT INTO inquiry_provider_assignments (id, inquiry_id, provider_id, assigned_by_user_id, assigned_at, status, active_inquiry_id) VALUES (UUID(), ?, ?, ?, UTC_TIMESTAMP(3), 'active', ?)",
          [id.data, parsed.data.providerId, req.user.id, id.data]
        );
        await connection.execute("UPDATE inquiries SET status = 'assigned' WHERE id = ?", [id.data]);
        await audit(connection, req, 'platform.inquiry.assigned', id.data);
        const [created] = await connection.execute(
          "SELECT id, provider_id AS providerId, assigned_at AS assignedAt, status FROM inquiry_provider_assignments WHERE inquiry_id = ? AND active_inquiry_id = ? LIMIT 1",
          [id.data, id.data]
        );
        return { status: 201, body: { data: created[0], message: 'Richiesta assegnata e registrata nello storico.' } };
      });
      return res.status(outcome.status).set('Cache-Control', 'no-store').json(outcome.body);
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'La richiesta ha già un’impresa assegnataria attiva.' });
      return next(error);
    }
  });

  router.patch('/inquiries/:id/status', async (req, res, next) => {
    const id = UUID.safeParse(req.params.id);
    const parsed = z.object({ status: z.enum(['reviewed', 'closed']), reason: reasonSchema }).strict().safeParse(req.body);
    if (!id.success || !parsed.success) return res.status(400).json({ error: 'Stato o motivazione della richiesta non validi.' });
    try {
      const outcome = await database.withTransaction(async connection => {
        const [current] = await connection.execute('SELECT id, status FROM inquiries WHERE id = ? FOR UPDATE', [id.data]);
        if (!current.length) return { status: 404, body: { error: 'Richiesta non trovata.' } };
        const allowed = { received: ['reviewed', 'closed'], reviewed: ['closed'], assigned: ['closed'], closed: [] };
        if (!(allowed[current[0].status] || []).includes(parsed.data.status)) {
          return { status: 409, body: { error: 'Transizione di stato non consentita per questa richiesta.' } };
        }
        if (parsed.data.status === 'closed' && current[0].status === 'assigned') {
          const [revoked] = await connection.execute(
            "UPDATE inquiry_provider_assignments SET status = 'revoked', revoked_at = UTC_TIMESTAMP(3), revoked_by_user_id = ?, revocation_reason = ?, active_inquiry_id = NULL WHERE inquiry_id = ? AND status = 'active'",
            [req.user.id, parsed.data.reason, id.data]
          );
          if (revoked.affectedRows) await audit(connection, req, 'platform.inquiry.assignment_revoked', id.data);
        }
        await connection.execute('UPDATE inquiries SET status = ? WHERE id = ?', [parsed.data.status, id.data]);
        await audit(connection, req, 'platform.inquiry.status_changed', id.data);
        return { status: 200, body: { data: { id: id.data, status: parsed.data.status } } };
      });
      return res.status(outcome.status).set('Cache-Control', 'no-store').json(outcome.body);
    } catch (error) { return next(error); }
  });

  return router;
}

module.exports = createMariaDbPlatformInquiryRouter;
