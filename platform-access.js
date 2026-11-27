'use strict';

// Platform privileges are independent from app_users.role and tenant membership roles.
module.exports = function createPlatformAccess(pool) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('A PostgreSQL-compatible pool is required.');
  }

  const mariaDb = pool.dialect === 'mariadb';

  function requirePlatformRole(...allowedRoles) {
    const roles = [...new Set(allowedRoles)];
    if (!roles.length || roles.some(role => !['owner', 'support'].includes(role))) {
      throw new TypeError('At least one valid platform role is required.');
    }

    return async function platformAuthorization(req, res, next) {
      if (!req.user?.id) {
        return res.status(401).json({ error: 'Autenticazione richiesta.' });
      }

      try {
        const rolePredicate = mariaDb
          ? 'pa.role IN (' + roles.map((_role, index) => ' + ')'
          : 'pa.role = ANY($2::varchar[])';
        const params = mariaDb ? [req.user.id, ...roles] : [req.user.id, roles];
        const result = await pool.query(
          'SELECT pa.role, (u.totp_enabled_at IS NOT NULL) AS "mfaEnabled" ' +
          'FROM platform_access pa JOIN app_users u ON u.id = pa.user_id ' +
          'WHERE pa.user_id = $1 AND pa.status = \'active\' AND u.active = TRUE ' +
          'AND ' + rolePredicate,
          params
        );

        if (!result.rowCount) {
          return res.status(403).json({ error: 'Permessi di piattaforma insufficienti.' });
        }
        if (!result.rows[0].mfaEnabled) {
          return res.status(403).json({ error: 'Attiva la verifica in due passaggi prima di accedere alla console piattaforma.' });
        }

        // Platform roles come only from an active database grant; MFA is required
        // for both owner and support regardless of the legacy application role.
        req.platformAccess = Object.freeze({ role: result.rows[0].role });
        return next();
      } catch (error) {
        return next(error);
      }
    };
  }

  return { requirePlatformRole };
};
 + (index + 2)).join(',') + ')'
          : 'pa.role = ANY($2::varchar[])';
        const params = mariaDb ? [req.user.id, ...roles] : [req.user.id, roles];
        const result = await pool.query(
          'SELECT pa.role, (u.totp_enabled_at IS NOT NULL) AS "mfaEnabled" ' +
          'FROM platform_access pa JOIN app_users u ON u.id = pa.user_id ' +
          'WHERE pa.user_id = $1 AND pa.status = \'active\' AND u.active = TRUE ' +
          'AND ' + rolePredicate,
          params
        );

        if (!result.rowCount) {
          return res.status(403).json({ error: 'Permessi di piattaforma insufficienti.' });
        }
        if (!result.rows[0].mfaEnabled) {
          return res.status(403).json({ error: 'Attiva la verifica in due passaggi prima di accedere alla console piattaforma.' });
        }

        // Platform roles come only from an active database grant; MFA is required
        // for both owner and support regardless of the legacy application role.
        req.platformAccess = Object.freeze({ role: result.rows[0].role });
        return next();
      } catch (error) {
        return next(error);
      }
    };
  }

  return { requirePlatformRole };
};
