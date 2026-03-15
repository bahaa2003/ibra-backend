'use strict';

const mongoose = require('mongoose');

/**
 * Deposit request status lifecycle.
 *
 *  PENDING  → APPROVED   (admin approves, wallet is credited)
 *  PENDING  → REJECTED   (admin rejects, wallet unchanged)
 *
 * Status transitions are one-way — you cannot un-approve or un-reject.
 * Further state changes (re-submission, appeals) require a new deposit request.
 */
const DEPOSIT_STATUS = Object.freeze({
    PENDING: 'PENDING',
    APPROVED: 'APPROVED',
    REJECTED: 'REJECTED',
});

const depositRequestSchema = new mongoose.Schema(
    {
        /** Customer who created this request. */
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: [true, 'userId is required'],
            index: true,
        },

        /** Current lifecycle status. */
        status: {
            type: String,
            enum: {
                values: Object.values(DEPOSIT_STATUS),
                message: `status must be one of: ${Object.values(DEPOSIT_STATUS).join(', ')}`,
            },
            default: DEPOSIT_STATUS.PENDING,
            index: true,
        },

        /**
         * Amount the customer claims to have transferred.
         * Must be a positive number. Stored as-is in the request.
         */
        amountRequested: {
            type: Number,
            required: [true, 'amountRequested is required'],
            min: [0.01, 'amountRequested must be greater than 0'],
        },

        /**
         * Amount the admin actually approves for crediting.
         * May differ from amountRequested if the admin overrides it.
         * Null until status moves to APPROVED.
         */
        amountApproved: {
            type: Number,
            default: null,
            min: [0.01, 'amountApproved must be greater than 0'],
            validate: {
                validator: function (v) {
                    // Only validate if present (null is allowed for PENDING/REJECTED)
                    return v === null || v > 0;
                },
                message: 'amountApproved must be greater than 0 when set',
            },
        },

        /**
         * URL of the transfer receipt / screenshot.
         * Required so admins can verify the payment before approving.
         */
        transferImageUrl: {
            type: String,
            required: [true, 'transferImageUrl is required'],
            trim: true,
            maxlength: [2048, 'transferImageUrl cannot exceed 2048 characters'],
        },

        /**
         * The phone/account number or identifier from which the transfer originated.
         * Required for fraud detection and reconciliation.
         */
        transferredFromNumber: {
            type: String,
            required: [true, 'transferredFromNumber is required'],
            trim: true,
            maxlength: [100, 'transferredFromNumber cannot exceed 100 characters'],
        },

        /** Admin who reviewed this request (null while PENDING). */
        reviewedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },

        /** Timestamp of the admin review decision. */
        reviewedAt: {
            type: Date,
            default: null,
        },
    },
    {
        timestamps: true,  // createdAt + updatedAt
        versionKey: false,  // no __v
    }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

/**
 * Admin dashboard: fetch all PENDING requests sorted by submission time.
 */
depositRequestSchema.index({ status: 1, createdAt: 1 });

/**
 * Customer: list their own deposit history.
 */
depositRequestSchema.index({ userId: 1, createdAt: -1 });

// ─── Virtuals ─────────────────────────────────────────────────────────────────

depositRequestSchema.virtual('isApproved').get(function () {
    return this.status === DEPOSIT_STATUS.APPROVED;
});

depositRequestSchema.virtual('isRejected').get(function () {
    return this.status === DEPOSIT_STATUS.REJECTED;
});

depositRequestSchema.virtual('isPending').get(function () {
    return this.status === DEPOSIT_STATUS.PENDING;
});

// ─── Model ────────────────────────────────────────────────────────────────────

const DepositRequest = mongoose.model('DepositRequest', depositRequestSchema);

module.exports = { DepositRequest, DEPOSIT_STATUS };
