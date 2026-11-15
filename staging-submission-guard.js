'use strict';

function createStagingSubmissionGuard({ env = process.env } = {}) {
  return function stagingSubmissionGuard(_req, res, next) {
    if (env.STAGING_MODE === 'true') {
      return res.status(503).json({
        error: 'Invio disabilitato nell’ambiente di prova. Nessun dato è stato registrato.'
      });
    }
    return next();
  };
}

module.exports = createStagingSubmissionGuard;
