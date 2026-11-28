'use strict';

const express = require('express');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { z } = require('zod');

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'fs_session';
const SESSION_DAYS = 8;

function tokenHash(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

async function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored || '').split('$');
    if (scheme !== 'scrypt' || !/^[a-f0-9]{32}$/i.test(saltHex) || !/^[a-f0-9]{128}$/i.test(hashHex)) return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch (_) {
    return false;
  }
}

function cookieOptions(env) {
  const sameSite = String(env.SESSION_COOKIE_SAME_SITE || 'lax').toLowerCase();
  if (!['lax', 'strict', 'none'].includes(sameSite)) {
    throw new Error('SESSION_COOKIE_SAME_SITE deve essere lax, strict o none.');
  }
  const secure = env.NODE_ENV === 'production';
  if (sameSite === 'none' && !secure) {
    throw new Error('SameSite=None richiede NODE_ENV=production e cookie Secure.');
  }
  return {
    httpOnly: true,
    secure,
    sameSite,
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000
  };
}

function createMariaDbAuth(database, options = {}) {
  if (!database || typeof database.query !== 'function') throw new TypeError('MariaDB database adapter is required.');
  const env = options.env || process.env;
  const router = express.Router();

  async function authenticate(req, res, next) {
    const token = req.cookies?.[COOKIE];
    if (!token || typeof token !== 'string' || token.length > 200) {
      return res.status(401).json({ error: 'Sessione non valida o scaduta. Accedi di nuovo.' });
    }
    try {
      const [rows] = await database.query(
        `SELECT u.id, u.username, u.display_name AS displayName, u.role, u.active
         FROM app_sessions s
         JOIN app_users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP(3) AND u.active = 1
         LIMIT 1`,
        [tokenHash(token)]
      );
      if (!rows.length) return res.status(401).json({ error: 'Sessione non valida o scaduta. Accedi di nuovo.' });
      req.user = rows[0];
      await database.query('UPDATE app_sessions SET last_seen_at = UTC_TIMESTAMP(3) WHERE token_hash = ?', [tokenHash(token)]);
      return next();
    } catch (error) {
      return next(error);
    }
  }

  router.post('/login', async (req, res, next) => {
    const parsed = z.object({
      username: z.string().trim().min(1).max(60),
      password: z.string().min(1).max(200)
    }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Inserisci username e password.' });
    try {
      const [rows] = await database.query(
        'SELECT id, username, display_name AS displayName, password_hash AS passwordHash, role, active FROM app_users WHERE username = ? LIMIT 1',
        [parsed.data.username.toLowerCase()]
      );
      const user = rows[0];
      if (!user || !user.active || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
        return res.status(401).json({ error: 'Credenziali non corrette.' });
      }
      const token = crypto.randomBytes(32).toString('base64url');
      await database.query(
        'INSERT INTO app_sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at) VALUES (UUID(), ?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 8 DAY), UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))',
        [user.id, tokenHash(token)]
      );
      await database.query('UPDATE app_users SET last_login_at = UTC_TIMESTAMP(3) WHERE id = ?', [user.id]);
      res.cookie(COOKIE, token, cookieOptions(env));
      return res.set('Cache-Control', 'no-store').json({
        data: { id: user.id, username: user.username, displayName: user.displayName, role: user.role }
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/logout', authenticate, async (req, res, next) => {
    try {
      const token = req.cookies[COOKIE];
      await database.query('DELETE FROM app_sessions WHERE token_hash = ?', [tokenHash(token)]);
      const { maxAge, ...clearOptions } = cookieOptions(env);\n      res.clearCookie(COOKIE, clearOptions);
      return res.set('Cache-Control', 'no-store').json({ message: 'Sessione terminata.' });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/me', authenticate, (req, res) => {
    res.set('Cache-Control', 'no-store').json({
      data: { id: req.user.id, username: req.user.username, displayName: req.user.displayName, role: req.user.role }
    });
  });

  return { router, authenticate };
}

module.exports = createMariaDbAuth;
module.exports.tokenHash = tokenHash;
module.exports.verifyPassword = verifyPassword;
