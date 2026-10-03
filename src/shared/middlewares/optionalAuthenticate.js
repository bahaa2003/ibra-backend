'use strict';

const authenticate = require('./authenticate');

/**
 * Attach an authenticated user when a Bearer token is supplied, while allowing
 * genuinely anonymous requests to continue. A supplied invalid token still
 * fails closed through the normal authentication middleware.
 */
const optionalAuthenticate = (req, res, next) => {
    const authorization = String(req.headers.authorization || '').trim();
    if (!authorization) return next();
    return authenticate(req, res, next);
};

module.exports = optionalAuthenticate;
