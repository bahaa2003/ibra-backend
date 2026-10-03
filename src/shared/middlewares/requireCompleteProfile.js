'use strict';

const { getProfileCompletionState } = require('../utils/profileCompletion');
const { AuthenticationError, BusinessRuleError } = require('../errors/AppError');

/**
 * Customer-only guard for routes that provide normal platform functionality.
 * Authentication and account-status checks remain separate concerns.
 */
const requireCompleteProfile = (req, res, next) => {
    if (!req.user) {
        throw new AuthenticationError('Authentication required.');
    }

    const completion = getProfileCompletionState(req.user);
    if (!completion.profileCompletionRequired) return next();

    const error = new BusinessRuleError(
        'Complete your phone number before using this feature.',
        'PROFILE_COMPLETION_REQUIRED'
    );
    error.missingFields = completion.missingProfileFields;
    throw error;
};

module.exports = requireCompleteProfile;
