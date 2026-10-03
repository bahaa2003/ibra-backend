'use strict';

/**
 * Escapes user supplied text before it is used as a MongoDB regular-expression
 * pattern. Search inputs are literal, case-insensitive substring searches; they
 * are never a way for API callers to provide an arbitrary regex.
 */
const escapeRegex = (value) => String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = { escapeRegex };
