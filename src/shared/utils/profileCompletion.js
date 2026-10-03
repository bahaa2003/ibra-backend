'use strict';

const { isValidPhone } = require('./phone');

const getProfileCompletionState = (user) => {
    if (user?.role !== 'CUSTOMER' || isValidPhone(user?.phone)) {
        return {
            profileCompletionRequired: false,
            missingProfileFields: [],
        };
    }

    return {
        profileCompletionRequired: true,
        missingProfileFields: ['phone'],
    };
};

const toSafeUserWithProfileCompletion = (user) => {
    const safeUser = user?.toSafeObject
        ? user.toSafeObject()
        : user?.toObject
            ? user.toObject()
            : { ...user };

    return {
        ...safeUser,
        phone: safeUser.phone || null,
        ...getProfileCompletionState(safeUser),
    };
};

module.exports = { getProfileCompletionState, toSafeUserWithProfileCompletion };
