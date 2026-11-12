'use strict';

const express = require('express');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { z } = require('zod');
const scrypt = promisify(crypto.scrypt);

const ROLES = ['admin', 'manager', 'operator', 'warehouse', 'accounting'];
const ROLE_LABELS = {
  admin: 'Amministratore',
  manager: 'Responsabile',
  operator: 'Operatore',
  warehouse: 'Magazziniere',
  accounting: 'Amministrazione'
};
const SESSION_COOKIE = 'fs_session';
const SESSION_DAYS = 8;

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return 'scrypt$' + salt.toString('hex') + '$' + derived.toString('hex');
}
async function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, hashHex] = stored.split('$');
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch (_e) { return false; }
}
function cookieOptions() {
  return { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', path: '/', maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000 };
}

module.exports = function createAuth(pool) {
  const router = express.Router();

  async function audit(user, req, action, resource = null, resourceId = null) {
    await pool.query(
      'INSERT INTO audit_log(user_id, username, action, resource, resource_id, ip_address) VALUES($1,$2,$3,$4,$5,$6)',
      [user?.id || null, user?.username || null, action, resource, resourceId, req.ip || null]
    );
  }

  async function authenticate(req, res, next) {
    try {
      const token = req.cookies?.[SESSION_COOKIE] || null;
      if (token) {
        const found = await pool.query(
          `SELECT u.id,u.username,u.display_name AS "displayName",u.role,u.active
           FROM app_sessions s JOIN app_users u ON u.id=s.user_id
           WHERE s.token_hash=$1 AND s.expires_at>NOW() AND u.active=TRUE`,
          [tokenHash(token)]
        );
        if (found.rowCount) {
          req.user = found.rows[0];
          await pool.query('UPDATE app_sessions SET last_seen_at=NOW() WHERE token_hash=$1', [tokenHash(token)]);
          return next();
        }
      }

      // Compatibilità temporanea: la chiave condivisa resta valida solo finché
      // non viene creato il primo account nominativo. Poi viene disabilitata.
      const count = await pool.query('SELECT COUNT(*)::int AS total FROM app_users');
      if (count.rows[0].total === 0) {
        const supplied = req.get('x-admin-key');
        const expected = process.env.ADMIN_API_KEY;
        if (expected && safeEqual(supplied, expected)) {
          req.user = { id: null, username: 'legacy-admin', displayName: 'Accesso temporaneo', role: 'admin' };
          return next();
        }
      }
      return res.status(401).json({ error: 'Sessione non valida o scaduta. Accedi di nuovo.' });
    } catch (e) { next(e); }
  }

  function authorize(req, res, next) {
    const role = req.user?.role;
    if (role === 'admin') return next();
    const method = req.method.toUpperCase();
    const path = req.path;
    if (role === 'manager' && method === 'GET') return next();
    const allowed = {
      operator: [
        /^\/(cases|customers|tasks)(\/|$)/
      ],
      warehouse: [
        /^\/inventory(\/|$)/
      ],
      accounting: [
        /^\/invoices(\/|$)/
      ]
    };
    const permitted = (allowed[role] || []).some(pattern => pattern.test(path));
    if (permitted && ['GET', 'POST', 'PATCH'].includes(method)) return next();
    return res.status(403).json({ error: 'Non hai i permessi per questo reparto.' });
  }

  router.post('/bootstrap', async (req, res, next) => {
    const parsed = z.object({
      token: z.string().min(24).max(300),
      username: z.string().trim().min(3).max(60).regex(/^[a-zA-Z0-9._-]+$/),
      displayName: z.string().trim().min(2).max(160),
      password: z.string().min(12).max(200)
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Dati non validi. La password deve avere almeno 12 caratteri.' });
    if (!process.env.BOOTSTRAP_ADMIN_TOKEN || !safeEqual(parsed.data.token, process.env.BOOTSTRAP_ADMIN_TOKEN)) {
      return res.status(403).json({ error: 'Token iniziale non valido.' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('LOCK TABLE app_users IN EXCLUSIVE MODE');
      const count = await client.query('SELECT COUNT(*)::int AS total FROM app_users');
      if (count.rows[0].total > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Amministratore iniziale già creato. Usa il login.' });
      }
      const passwordHash = await hashPassword(parsed.data.password);
      const created = await client.query(
        "INSERT INTO app_users(username,display_name,password_hash,role) VALUES($1,$2,$3,'admin') RETURNING id,username,display_name AS \"displayName\",role",
        [parsed.data.username.toLowerCase(), parsed.data.displayName, passwordHash]
      );
      await client.query('COMMIT');
      await audit(created.rows[0], req, 'bootstrap.admin.created', 'user', created.rows[0].id);
      res.status(201).json({ data: created.rows[0], message: 'Amministratore creato. Ora accedi con username e password.' });
    } catch (e) { await client.query('ROLLBACK'); if (e.code === '23505') return res.status(409).json({ error: 'Username già utilizzato.' }); next(e); }
    finally { client.release(); }
  });

  router.post('/login', async (req, res, next) => {
    const parsed = z.object({ username: z.string().trim().min(1).max(60), password: z.string().min(1).max(200) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Inserisci username e password.' });
    try {
      const result = await pool.query('SELECT id,username,display_name AS "displayName",password_hash,role,active FROM app_users WHERE username=$1', [parsed.data.username.toLowerCase()]);
      const user = result.rows[0];
      if (!user || !user.active || !(await verifyPassword(parsed.data.password, user.password_hash))) {
        return res.status(401).json({ error: 'Credenziali non corrette.' });
      }
      const token = crypto.randomBytes(32).toString('base64url');
      await pool.query('INSERT INTO app_sessions(user_id,token_hash,expires_at) VALUES($1,$2,NOW()+($3 || \' days\')::interval)', [user.id, tokenHash(token), String(SESSION_DAYS)]);
      await pool.query('UPDATE app_users SET last_login_at=NOW() WHERE id=$1', [user.id]);
      await audit(user, req, 'auth.login');
      res.cookie(SESSION_COOKIE, token, cookieOptions());
      res.json({ data: { id: user.id, username: user.username, displayName: user.displayName, role: user.role, roleLabel: ROLE_LABELS[user.role] } });
    } catch (e) { next(e); }
  });

  router.post('/logout', authenticate, async (req, res, next) => {
    try {
      const token = req.cookies?.[SESSION_COOKIE];
      if (token) await pool.query('DELETE FROM app_sessions WHERE token_hash=$1', [tokenHash(token)]);
      await audit(req.user, req, 'auth.logout');
      res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', path: '/' });
      res.json({ message: 'Sessione terminata.' });
    } catch (e) { next(e); }
  });

  router.get('/me', authenticate, (req, res) => {
    res.json({ data: { id: req.user.id, username: req.user.username, displayName: req.user.displayName, role: req.user.role, roleLabel: ROLE_LABELS[req.user.role] || 'Accesso temporaneo' } });
  });

  router.get('/users', authenticate, async (req, res, next) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo l’amministratore può gestire gli utenti.' });
    try {
      const result = await pool.query('SELECT id,username,display_name AS "displayName",role,active,created_at AS "createdAt",last_login_at AS "lastLoginAt" FROM app_users ORDER BY created_at DESC');
      res.json({ data: result.rows, roles: ROLE_LABELS });
    } catch (e) { next(e); }
  });

  router.post('/users', authenticate, async (req, res, next) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo l’amministratore può creare utenti.' });
    const parsed = z.object({
      username: z.string().trim().min(3).max(60).regex(/^[a-zA-Z0-9._-]+$/),
      displayName: z.string().trim().min(2).max(160),
      password: z.string().min(12).max(200),
      role: z.enum(ROLES.filter(r => r !== 'admin'))
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Dati non validi. Username 3-60 caratteri e password almeno 12 caratteri.' });
    try {
      const passwordHash = await hashPassword(parsed.data.password);
      const result = await pool.query(
        'INSERT INTO app_users(username,display_name,password_hash,role) VALUES($1,$2,$3,$4) RETURNING id,username,display_name AS "displayName",role,active,created_at AS "createdAt"',
        [parsed.data.username.toLowerCase(), parsed.data.displayName, passwordHash, parsed.data.role]
      );
      await audit(req.user, req, 'user.created', 'user', result.rows[0].id);
      res.status(201).json({ data: result.rows[0] });
    } catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'Username già utilizzato.' }); next(e); }
  });

  router.patch('/users/:id/active', authenticate, async (req, res, next) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo l’amministratore può modificare gli utenti.' });
    const parsed = z.object({ active: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Stato utente non valido.' });
    if (req.params.id === req.user.id && !parsed.data.active) return res.status(400).json({ error: 'Non puoi disattivare il tuo account mentre sei collegato.' });
    try {
      const result = await pool.query('UPDATE app_users SET active=$1,updated_at=NOW() WHERE id=$2 RETURNING id,username,active', [parsed.data.active, req.params.id]);
      if (!result.rowCount) return res.status(404).json({ error: 'Utente non trovato.' });
      if (!parsed.data.active) await pool.query('DELETE FROM app_sessions WHERE user_id=$1', [req.params.id]);
      await audit(req.user, req, parsed.data.active ? 'user.activated' : 'user.deactivated', 'user', req.params.id);
      res.json({ data: result.rows[0] });
    } catch (e) { next(e); }
  });

  return { router, authenticate, authorize };
};
