'use strict';

const PRODUCTION_ORIGINS = Object.freeze([
  'https://pikkio13677.github.io',
  'https://funeral-smart-api.onrender.com',
  'https://funeral-smart-web.onrender.com',
  'https://funeralsmartapp.com',
  'https://www.funeralsmartapp.com'
]);

function getAllowedOrigins(env = process.env) {
  const configuredOrigins = (env.CORS_ORIGIN || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

  if (env.STAGING_MODE === 'true') {
    const productionOrigins = configuredOrigins.filter(origin => PRODUCTION_ORIGINS.includes(origin));
    if (productionOrigins.length) {
      throw new Error('Staging CORS cannot allow production origins: ' + productionOrigins.join(', '));
    }
    return [...new Set(configuredOrigins)];
  }

  return [...new Set([...PRODUCTION_ORIGINS, ...configuredOrigins])];
}

module.exports = getAllowedOrigins;
module.exports.PRODUCTION_ORIGINS = PRODUCTION_ORIGINS;
