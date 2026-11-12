'use strict';

const express = require('express');
const crypto = require('node:crypto');
const { z } = require('zod');
const { authorizeTenant } = require('./tenant-permissions');

const inviteSchema = z.object({
  email: z.string().trim().email().max(254),
  role: z.enum(['admin', 'manager', 'operator', 'warehouse', 'accounting'])
}).strict();

const acceptSchema = z.object({ token: z.string().min(32).max(200) }).strict();
const TOKEN_TTL_HOURS = 72;

function normalizeEmail(value) {
  return value.trim().toLowerCase();
}
function hashToken(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}
function createInvitationUrl(baseUrl, token) {
  const url = new URL('/invito/accetta', baseUrl);
  url.searchParams.set('token', token);
  return url.toString();
}

function createTenantInvitationRouter({ pool, sendInvitationEmail, publicAppUrl } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('A PostgreSQL pool with query() and connect() is required.');
  }
  const router = express.Router();

  // The acceptance endpoint requires a normal authenticated identity, but no
  // active tenant: an invited user may not be a member of the company yet.
  router.post('/company/invitations/accept', async (req, res, next) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Accedi con il tuo account prima di accettare l’invito.' });
    const parsed = acceptSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Link di invito non valido.' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const invitation = await client.query(
        `SELECT id, company_id AS "companyId", email, role, status, expires_at AS "expiresAt"
         FROM company_invitations
         WHERE token_hash = $1
         FOR UPDATE`,
        [hashToken(parsed.data.token)]
      );
      if (!invitation.rowCount || invitation.rows[0].status !== 'pending') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Invito non valido, revocato o già utilizzato.' });
      }
      const invite = invitation.rows[0];
      if (new Date(invite.expiresAt).getTime() <= Date.now()) {
        await client.query(
          "UPDATE company_invitations SET status = 'expired' WHERE id = $1 AND status = 'pending'",
          [invite.id]
        );
        await client.query('COMMIT');
        return res.status(410).json({ error: 'Invito scaduto. Chiedi all’amministratore di inviarne uno nuovo.' });
      }

      const userResult = await client.query(
        'SELECT id, username, email, email_verified_at AS "emailVerifiedAt", active FROM app_users WHERE id = $1 FOR UPDATE',
        [req.user.id]
      );
      if (!userResult.rowCount || !userResult.rows[0].active) {
        await client.query('ROLLBACK');
        return res.status(401).json({ error: 'Account non attivo.' });
      }
      const user = userResult.rows[0];
      const invitedEmail = normalizeEmail(invite.email);
      if (user.email && normalizeEmail(user.email) !== invitedEmail && user.email_verified_at) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Questo account è già associato a un altro indirizzo email verificato.' });
      }

      const company = await client.query(
        "SELECT id FROM companies WHERE id = $1 AND status = 'active' FOR UPDATE",
        [invite.companyId]
      );
      if (!company.rowCount) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'L’azienda non è attiva.' });
      }

      const existing = await client.query(
        'SELECT id, status FROM company_memberships WHERE company_id = $1 AND user_id = $2 FOR UPDATE',
        [invite.companyId, req.user.id]
      );
      if (existing.rowCount) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Questo account ha già una membership per l’azienda.' });
      }

      await client.query(
        'UPDATE app_users SET email = $1, email_verified_at = COALESCE(email_verified_at, NOW()), updated_at = NOW() WHERE id = $2',
        [invitedEmail, req.user.id]
      );
      const membership = await client.query(
        `INSERT INTO company_memberships(company_id, user_id, role, status)
         VALUES($1, $2, $3, 'active') RETURNING id`,
        [invite.companyId, req.user.id, invite.role]
      );
      await client.query(
        "UPDATE company_invitations SET status = 'accepted', accepted_at = NOW() WHERE id = $1 AND status = 'pending'",
        [invite.id]
      );
      await client.query(
        `INSERT INTO audit_log(user_id, username, action, resource, resource_id, company_id, membership_id)
         VALUES($1, $2, 'company.invitation.accepted', 'company_invitation', $3, $4, $5)`,
        [req.user.id, user.username, invite.id, invite.companyId, membership.rows[0].id]
      );
      await client.query('COMMIT');
      return res.status(201).json({ message: 'Invito accettato. Ora puoi selezionare l’azienda.', data: { companyId: invite.companyId } });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Questo indirizzo email è già associato a un altro account.' });
      }
      return next(error);
    } finally {
      client.release();
    }
  });

  router.use((req, res, next) => {
    if (!req.tenant?.companyId || !req.tenant?.membershipId || !req.tenant?.role) {
      return res.status(403).json({ error: 'Contesto aziendale verificato richiesto.' });
    }
    return next();
  });

  router.post('/company/invitations', authorizeTenant('members', 'invite'), async (req, res, next) => {
    const parsed = inviteSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Indirizzo email o ruolo non validi.' });
    if (typeof sendInvitationEmail !== 'function' || !publicAppUrl) {
      return res.status(503).json({ error: 'Inviti temporaneamente non disponibili: servizio email non configurato.' });
    }

    let baseUrl;
    try {
      baseUrl = new URL(publicAppUrl);
      if (baseUrl.protocol !== 'https:') throw new Error('HTTPS required');
    } catch (_) {
      return res.status(503).json({ error: 'Indirizzo pubblico HTTPS non configurato correttamente.' });
    }

    const email = normalizeEmail(parsed.data.email);
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + TOKEN_TTL_HOURS * 60 * 60 * 1000);
    const client = await pool.connect();
    let invitationId;
    let companyName;
    try {
      await client.query('BEGIN');
      const company = await client.query(
        "SELECT legal_name AS name FROM companies WHERE id = $1 AND status = 'active' FOR UPDATE",
        [req.tenant.companyId]
      );
      if (!company.rowCount) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Azienda non attiva.' });
      }
      companyName = company.rows[0].name;
      const existing = await client.query(
        `SELECT id FROM company_memberships m
         JOIN app_users u ON u.id = m.user_id
         WHERE m.company_id = $1 AND lower(u.email) = $2
           AND m.status = 'active' LIMIT 1`,
        [req.tenant.companyId, email]
      );
      if (existing.rowCount) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Questo indirizzo appartiene già a un membro attivo dell’azienda.' });
      }
      const inserted = await client.query(
        `INSERT INTO company_invitations(company_id, email, role, token_hash, invited_by_membership_id, expires_at)
         VALUES($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [req.tenant.companyId, email, parsed.data.role, hashToken(token), req.tenant.membershipId, expiresAt]
      );
      invitationId = inserted.rows[0].id;
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      if (error.code === '23505') return res.status(409).json({ error: 'Esiste già un invito in attesa per questo indirizzo.' });
      return next(error);
    } finally {
      client.release();
    }

    try {
      await sendInvitationEmail({
        to: email,
        companyName,
        invitationUrl: createInvitationUrl(baseUrl.toString(), token),
        expiresAt
      });
      return res.status(201).json({ data: { id: invitationId, email, role: parsed.data.role, status: 'pending', expiresAt }, message: 'Invito creato e affidato al servizio email.' });
    } catch (error) {
      // Do not leave a failed delivery looking like a usable pending invitation.
      try {
        await pool.query(
          "UPDATE company_invitations SET status = 'revoked', revoked_at = NOW() WHERE id = $1 AND status = 'pending'",
          [invitationId]
        );
      } catch (_) {}
      return res.status(503).json({ error: 'Invito non consegnato: il servizio email ha restituito un errore. Puoi riprovare.' });
    }
  });

  router.get('/company/invitations', authorizeTenant('members', 'read'), async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT id, email, role, status, expires_at AS "expiresAt",
                accepted_at AS "acceptedAt", revoked_at AS "revokedAt", created_at AS "createdAt"
         FROM company_invitations
         WHERE company_id = $1
         ORDER BY created_at DESC
         LIMIT 100`,
        [req.tenant.companyId]
      );
      return res.json({ data: result.rows });
    } catch (error) { return next(error); }
  });

  router.post('/company/invitations/:invitationId/revoke', authorizeTenant('members', 'invite'), async (req, res, next) => {
    const id = z.string().uuid().safeParse(req.params.invitationId);
    if (!id.success) return res.status(400).json({ error: 'Identificativo invito non valido.' });
    try {
      const result = await pool.query(
        `UPDATE company_invitations
         SET status = 'revoked', revoked_at = NOW()
         WHERE id = $1 AND company_id = $2 AND status = 'pending'
         RETURNING id`,
        [id.data, req.tenant.companyId]
      );
      if (!result.rowCount) return res.status(404).json({ error: 'Invito pendente non trovato in questa azienda.' });
      return res.json({ message: 'Invito revocato.' });
    } catch (error) { return next(error); }
  });

  return router;
}

module.exports = createTenantInvitationRouter;
