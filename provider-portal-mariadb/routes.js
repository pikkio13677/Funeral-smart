'use strict';

const express = require('express');
const { z } = require('zod');
const createProviderContext = require('./context');

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).max(10000).default(0)
}).strict();

function rowsOf(result) { return result[0]; }

function createMariaDbProviderPortalRouter(database, options = {}) {
  if (!database || typeof database.query !== 'function' || typeof database.withTransaction !== 'function') {
    throw new TypeError('A MariaDB database adapter with query() and withTransaction() is required.');
  }
  if (typeof options.authenticate !== 'function') {
    throw new TypeError('Authentication middleware is required.');
  }

  const router = express.Router();
  const providerContext = createProviderContext(database);
  router.use(options.authenticate, providerContext);

  router.get('/me', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ data: {
      providerId: req.provider.providerId,
      businessName: req.provider.businessName,
      role: req.provider.role,
      permissions: {
        viewInquiries: true,
        respondToInquiries: true,
        manageInvitations: req.provider.role === 'provider_admin',
        manageMembers: req.provider.role === 'provider_admin',
        manageMemberRoles: req.provider.role === 'provider_admin',
        viewActivityLog: req.provider.role === 'provider_admin',
        viewBusinessAnalytics: req.provider.role === 'provider_admin'
      },
      status: 'verified'
    } });
  });

  router.get('/dashboard', async (req, res, next) => {
    try {
      const [summaryRows] = await database.query(
        `SELECT
           SUM(CASE WHEN response.id IS NULL THEN 1 ELSE 0 END) AS newCount,
           SUM(CASE WHEN response.status = 'accepted' THEN 1 ELSE 0 END) AS acceptedCount,
           SUM(CASE WHEN response.status = 'rejected' THEN 1 ELSE 0 END) AS rejectedCount,
           COUNT(*) AS activeCount
         FROM inquiry_provider_assignments assignment
         JOIN inquiries inquiry ON inquiry.id = assignment.inquiry_id
         LEFT JOIN provider_inquiry_responses response
           ON response.assignment_id = assignment.id
          AND response.provider_id = assignment.provider_id
         WHERE assignment.provider_id = ?
           AND assignment.status = 'active'
           AND inquiry.status NOT IN ('closed', 'deleted')`,
        [req.provider.providerId]
      );
      const [recent] = await database.query(
        `SELECT assignment.id AS assignmentId,
                inquiry.city,
                inquiry.service_type AS serviceType,
                inquiry.destination_country AS destinationCountry,
                inquiry.created_at AS receivedAt,
                assignment.assigned_at AS assignedAt,
                response.status AS responseStatus
         FROM inquiry_provider_assignments assignment
         JOIN inquiries inquiry ON inquiry.id = assignment.inquiry_id
         LEFT JOIN provider_inquiry_responses response
           ON response.assignment_id = assignment.id
          AND response.provider_id = assignment.provider_id
         WHERE assignment.provider_id = ?
           AND assignment.status = 'active'
           AND inquiry.status NOT IN ('closed', 'deleted')
         ORDER BY assignment.assigned_at DESC, assignment.id DESC
         LIMIT 5`,
        [req.provider.providerId]
      );
      const counts = summaryRows[0] || {};
      res.set('Cache-Control', 'no-store').json({ data: {
        provider: { businessName: req.provider.businessName, role: req.provider.role },
        counts: {
          newCount: Number(counts.newCount || 0),
          acceptedCount: Number(counts.acceptedCount || 0),
          rejectedCount: Number(counts.rejectedCount || 0),
          activeCount: Number(counts.activeCount || 0)
        },
        recent
      } });
    } catch (error) { next(error); }
  });

  router.get('/inquiries', async (req, res, next) => {
    const parsed = paginationSchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: 'Parametri di paginazione non validi.' });
    try {
      const [rows] = await database.query(
        `SELECT assignment.id AS assignmentId,
                inquiry.city,
                inquiry.service_type AS serviceType,
                inquiry.destination_country AS destinationCountry,
                inquiry.created_at AS receivedAt,
                assignment.assigned_at AS assignedAt,
                response.status AS responseStatus
         FROM inquiry_provider_assignments assignment
         JOIN inquiries inquiry ON inquiry.id = assignment.inquiry_id
         LEFT JOIN provider_inquiry_responses response
           ON response.assignment_id = assignment.id
          AND response.provider_id = assignment.provider_id
         WHERE assignment.provider_id = ?
           AND assignment.status = 'active'
           AND inquiry.status NOT IN ('closed', 'deleted')
         ORDER BY assignment.assigned_at DESC, assignment.id DESC
         LIMIT ? OFFSET ?`,
        [req.provider.providerId, parsed.data.limit, parsed.data.offset]
      );
      res.set('Cache-Control', 'no-store').json({
        data: rows,
        pagination: { limit: parsed.data.limit, offset: parsed.data.offset, returned: rows.length }
      });
    } catch (error) { next(error); }
  });

  router.get('/inquiries/:assignmentId', async (req, res, next) => {
    const id = z.string().uuid().safeParse(req.params.assignmentId);
    if (!id.success) return res.status(400).json({ error: 'Identificativo incarico non valido.' });
    try {
      const [rows] = await database.query(
        `SELECT assignment.id AS assignmentId,
                inquiry.city,
                inquiry.service_type AS serviceType,
                inquiry.destination_country AS destinationCountry,
                inquiry.created_at AS receivedAt,
                assignment.assigned_at AS assignedAt,
                response.status AS responseStatus,
                CASE WHEN response.status = 'accepted' THEN inquiry.contact_email ELSE NULL END AS contactEmail,
                CASE WHEN response.status = 'accepted' THEN inquiry.contact_phone ELSE NULL END AS contactPhone
         FROM inquiry_provider_assignments assignment
         JOIN inquiries inquiry ON inquiry.id = assignment.inquiry_id
         LEFT JOIN provider_inquiry_responses response
           ON response.assignment_id = assignment.id
          AND response.provider_id = assignment.provider_id
         WHERE assignment.id = ?
           AND assignment.provider_id = ?
           AND assignment.status = 'active'
           AND inquiry.status NOT IN ('closed', 'deleted')
         LIMIT 1`,
        [id.data, req.provider.providerId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Incarico non trovato o non più disponibile.' });
      res.set('Cache-Control', 'no-store').json({ data: rows[0] });
    } catch (error) { next(error); }
  });

  router.post('/inquiries/:assignmentId/response', async (req, res, next) => {
    const id = z.string().uuid().safeParse(req.params.assignmentId);
    const parsed = z.object({
      status: z.enum(['accepted', 'rejected']),
      reason: z.string().trim().min(10).max(500)
    }).strict().safeParse(req.body);
    if (!id.success || !parsed.success) return res.status(400).json({ error: 'Risposta o motivazione non valide.' });

    try {
      const outcome = await database.withTransaction(async connection => {
        const [assignments] = await connection.execute(
          `SELECT assignment.id
           FROM inquiry_provider_assignments assignment
           JOIN inquiries inquiry ON inquiry.id = assignment.inquiry_id
           WHERE assignment.id = ?
             AND assignment.provider_id = ?
             AND assignment.status = 'active'
             AND inquiry.status NOT IN ('closed', 'deleted')
           FOR UPDATE`,
          [id.data, req.provider.providerId]
        );
        if (!assignments.length) return { status: 404, body: { error: 'Incarico non trovato o non più disponibile.' } };

        const [existing] = await connection.execute(
          'SELECT id FROM provider_inquiry_responses WHERE assignment_id = ? FOR UPDATE',
          [id.data]
        );
        if (existing.length) return { status: 409, body: { error: 'Hai già inviato una risposta per questo incarico.' } };

        await connection.execute(
          `INSERT INTO provider_inquiry_responses
             (id, assignment_id, provider_id, status, reason, responded_by_user_id, responded_at)
           VALUES (UUID(), ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
          [id.data, req.provider.providerId, parsed.data.status, parsed.data.reason, req.user.id]
        );
        await connection.execute(
          `INSERT INTO provider_portal_audit_log
             (provider_id, user_id, assignment_id, action, reason, created_at)
           VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
          [
            req.provider.providerId,
            req.user.id,
            id.data,
            parsed.data.status === 'accepted' ? 'inquiry.accepted' : 'inquiry.rejected',
            parsed.data.reason
          ]
        );
        const [inserted] = await connection.execute(
          `SELECT id, assignment_id AS assignmentId, status, responded_at AS respondedAt
           FROM provider_inquiry_responses WHERE assignment_id = ? AND provider_id = ? LIMIT 1`,
          [id.data, req.provider.providerId]
        );
        return { status: 201, body: {
          data: inserted[0],
          message: parsed.data.status === 'accepted' ? 'Incarico accettato.' : 'Incarico rifiutato.'
        } };
      });
      res.status(outcome.status).set('Cache-Control', 'no-store').json(outcome.body);
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'Hai già inviato una risposta per questo incarico.' });
      }
      next(error);
    }
  });

  return router;
}

module.exports = createMariaDbProviderPortalRouter;
