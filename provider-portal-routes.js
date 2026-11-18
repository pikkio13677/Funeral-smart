'use strict';

const express = require('express');
const { z } = require('zod');
const createProviderContext = require('./provider-portal-context');

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).max(10000).default(0)
}).strict();

function createProviderPortalRouter(pool, options = {}) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('A PostgreSQL-compatible pool is required.');
  }
  if (typeof options.authenticate !== 'function') {
    throw new TypeError('Authentication middleware is required.');
  }

  const router = express.Router();
  const providerContext = createProviderContext(pool);
  router.use(options.authenticate, providerContext);

  router.get('/me', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      data: {
        providerId: req.provider.providerId,
        businessName: req.provider.businessName,
        role: req.provider.role,
        status: 'verified'
      }
    });
  });

  router.get('/dashboard', async (req, res, next) => {
    try {
      const summary = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE response.id IS NULL)::int AS "newCount",
           COUNT(*) FILTER (WHERE response.status = 'accepted')::int AS "acceptedCount",
           COUNT(*) FILTER (WHERE response.status = 'rejected')::int AS "rejectedCount",
           COUNT(*)::int AS "activeCount"
         FROM inquiry_provider_assignments assignment
         JOIN inquiries inquiry ON inquiry.id = assignment.inquiry_id
         LEFT JOIN provider_inquiry_responses response
           ON response.assignment_id = assignment.id
          AND response.provider_id = assignment.provider_id
         WHERE assignment.provider_id = $1
           AND assignment.status = 'active'
           AND inquiry.status NOT IN ('closed', 'deleted')`,
        [req.provider.providerId]
      );

      const recent = await pool.query(
        `SELECT assignment.id AS "assignmentId",
                inquiry.city,
                inquiry.service_type AS "serviceType",
                inquiry.destination_country AS "destinationCountry",
                inquiry.created_at AS "receivedAt",
                assignment.assigned_at AS "assignedAt",
                response.status AS "responseStatus"
         FROM inquiry_provider_assignments assignment
         JOIN inquiries inquiry ON inquiry.id = assignment.inquiry_id
         LEFT JOIN provider_inquiry_responses response
           ON response.assignment_id = assignment.id
          AND response.provider_id = assignment.provider_id
         WHERE assignment.provider_id = $1
           AND assignment.status = 'active'
           AND inquiry.status NOT IN ('closed', 'deleted')
         ORDER BY assignment.assigned_at DESC, assignment.id DESC
         LIMIT 5`,
        [req.provider.providerId]
      );

      res.set('Cache-Control', 'no-store');
      res.json({
        data: {
          provider: {
            businessName: req.provider.businessName,
            role: req.provider.role
          },
          counts: summary.rows[0] || {
            newCount: 0, acceptedCount: 0, rejectedCount: 0, activeCount: 0
          },
          recent: recent.rows
        }
      });
    } catch (error) { next(error); }
  });

  router.get('/inquiries', async (req, res, next) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Parametri di paginazione non validi.' });
    }

    try {
      const result = await pool.query(
        `SELECT assignment.id AS "assignmentId",
                inquiry.city,
                inquiry.service_type AS "serviceType",
                inquiry.destination_country AS "destinationCountry",
                inquiry.created_at AS "receivedAt",
                assignment.assigned_at AS "assignedAt",
                response.status AS "responseStatus"
         FROM inquiry_provider_assignments assignment
         JOIN inquiries inquiry ON inquiry.id = assignment.inquiry_id
         LEFT JOIN provider_inquiry_responses response
           ON response.assignment_id = assignment.id
          AND response.provider_id = assignment.provider_id
         WHERE assignment.provider_id = $1
           AND assignment.status = 'active'
           AND inquiry.status NOT IN ('closed', 'deleted')
         ORDER BY assignment.assigned_at DESC, assignment.id DESC
         LIMIT $2 OFFSET $3`,
        [req.provider.providerId, parsed.data.limit, parsed.data.offset]
      );
      res.set('Cache-Control', 'no-store');
      res.json({
        data: result.rows,
        pagination: {
          limit: parsed.data.limit,
          offset: parsed.data.offset,
          returned: result.rows.length
        }
      });
    } catch (error) { next(error); }
  });

  return router;
}

module.exports = createProviderPortalRouter;
