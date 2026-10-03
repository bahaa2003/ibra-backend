'use strict';

const ARABIC_INDIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

const normalizeDigits = (value) => String(value || '')
    .replace(/[٠-٩]/g, (digit) => String(ARABIC_INDIC_DIGITS.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String(PERSIAN_DIGITS.indexOf(digit)));

/**
 * Convert a user-entered telephone number to the single representation stored
 * by Ibra. This deliberately does not infer a country code.
 */
const normalizePhone = (value) => {
    const source = normalizeDigits(value).trim();

    if (!source) {
        throw new Error('Phone number is required.');
    }

    if (!/^[0-9+ ()-]+$/.test(source)) {
        throw new Error('Phone number contains unsupported characters.');
    }

    const normalized = source.replace(/[\s()\-]/g, '');
    if (!/^\+?\d+$/.test(normalized)) {
        throw new Error('Phone number must contain at most one leading plus sign.');
    }

    const digits = normalized.startsWith('+') ? normalized.slice(1) : normalized;
    if (digits.length < 7 || digits.length > 15) {
        throw new Error('Phone number must contain between 7 and 15 digits.');
    }

    return normalized;
};

const isValidPhone = (value) => {
    try {
        normalizePhone(value);
        return true;
    } catch {
        return false;
    }
};

module.exports = { normalizePhone, isValidPhone, normalizeDigits };
