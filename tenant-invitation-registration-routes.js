'use strict';

const express = require('express');
const crypto = require('node:crypto');
const { z } = require('zod');
const hashPassword = require('./auth').hashPassword;

const registrationSchema = z.object({
  token: z.string().min(32).max(200),
  username: z.string().trim().min(3).max(60).regex(/^[a-zA-Z0-9._-]+$/),
  displayName: z.string().trim().min(2).max(160),
  password: z.string().min(12).max(200)
}).strict();

function hashToken(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function createTenantInvitationRegistrationRouter({ pool, passwordHasher = hashPassword } = {}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('A PostgreSQL pool with connect() is required.');
  }
  if (typeof passwordHasher !== 'function') {
    throw new TypeError('A password hashing function is required.');
  }

  const router = express.Router();

  // Public by design, but usable only with a high-entropy, pending invitation
  // token delivered to the invited email address. Apply a strict rate limit
  // when mounting this router under /api/v1/auth.
  router.post('/invitation/register', async (req, res, next) => {
    const parsed = registrationSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Dati di registrazione non validi.' });

    const emailTokenHash = hashToken(parsed.data.token);
    const username = parsed.data.username.trim().toLowerCase();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const invitationResult = await client.query(
        "SELECT i.id, i.company_id AS \"companyId\", i.email, i.role, i.status, i.expires_at AS \"expiresAt\", c.legal_name AS \"companyName\", c.status AS \"companyStatus\" FROM company_invitations i JOIN companies c ON c.id = i.company_id WHERE i.token_hash = $1 FOR UPDATE OF i, c",
        [emailTokenHash]
      );

      if (!invitationResult.rowCount || invitationResult.rows[0].status !== 'pending') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Invito non valido, revocato o già utilizzato.' });
      }

      const invitation = invitationResult.rows[0];
      if (new Date(invitation.expiresAt).getTime() <= Date.now()) {
        await client.query(
          "UPDATE company_invitations SET status = 'expired' WHERE id = $1 AND status = 'pending'",
          [invitation.id]
        );
        await client.query('COMMIT');
        return res.status(410).json({ error: 'Invito scaduto. Chiedi un nuovo invito all’azienda.' });
      }
      if (invitation.companyStatus !== 'active') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'L’azienda che ha inviato l’invito non è attiva.' });
      }

      const email = invitation.email.trim().toLowerCase();
      const duplicate = await client.query(
        'SELECT id FROM app_users WHERE lower(username) = $1 OR lower(email) = $2 LIMIT 1',
        [username, email]
      );
      if (duplicate.rowCount) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Username o email già associati a un account. Accedi con l’account esistente per accettare l’invito.'
        });
      }

      const passwordHash = await passwordHasher(parsed.data.password);
      const userResult = await client.query(
        "INSERT INTO app_users(username, display_name, password_hash, role, email, email_verified_at) VALUES($1, $2, $3, 'operator', $4, NOW()) RETURNING id, username",
        [username, parsed.data.displayName.trim(), passwordHash, email]
      );
      const user = userResult.rows[0];

      const membershipResult = await client.query(
        "INSERT INTO company_memberships(company_id, user_id, role, status) VALUES($1, $2, $3, 'active') RETURNING id",
        [invitation.companyId, user.id, invitation.role]
      );

      await client.query(
        "UPDATE company_invitations SET status = 'accepted', accepted_at = NOW() WHERE id = $1 AND status = 'pending'",
        [invitation.id]
      );

      await client.query(
        "INSERT INTO audit_log(user_id, username, action, resource, resource_id, company_id, membership_id) VALUES($1, $2, 'company.invitation.registered', 'company_invitation', $3, $4, $5)",
        [user.id, user.username, invitation.id, invitation.companyId, membershipResult.rows[0].id]
      );

      await client.query('COMMIT');
      return res.status(201).json({
        message: 'Account creato e invito accettato. Ora accedi con username e password.',
        data: {
          username: user.username,
          companyId: invitation.companyId,
          companyName: invitation.companyName,
          role: invitation.role
        }
      });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Username o email già utilizzati. Accedi con l’account esistente.' });
      }
      return next(error);
    } finally {
      client.release();
    }
  });

  return router;
}

module.exports = createTenantInvitationRegistrationRouter;
