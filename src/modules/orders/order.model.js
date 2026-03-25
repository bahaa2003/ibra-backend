'use strict';

const mongoose = require('mongoose');

const ORDER_STATUS = Object.freeze({
    PENDING: 'PENDING',
    PROCESSING: 'PROCESSING',   // ← NEW: wallet deducted, awaiting provider confirmation
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED',
});

const ORDER_EXECUTION_TYPES = Object.freeze({
    MANUAL: 'manual',
    AUTOMATIC: 'automatic',    // ← NEW: goes through provider fulfillment engine
});

/** Maximum number of automatic status-poll retries before forcing FAILED. */
const MAX_RETRY_COUNT = 5;

const orderSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: [true, 'User ID is required'],
            index: true,
        },

        /**
         * Sequential, human-readable order number.
         * Auto-assigned via Counter collection at creation time.
         * Starts at 10000 and increments by 1.
         */
        orderNumber: {
            type: Number,
            unique: true,
            index: true,
        },

        productId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Product',
            required: [true, 'Product ID is required'],
        },

        quantity: {
            type: Number,
            required: [true, 'Quantity is required'],
            min: [1, 'Quantity must be at least 1'],
        },

        unitPrice: {
            // Legacy field — equals finalPriceCharged. Kept for backwards-compat.
            type: Number,
            required: [true, 'Unit price is required'],
        },

        totalPrice: {
            type: Number,
            required: [true, 'Total price is required'],
        },

        // ── Pricing Snapshots ────────────────────────────────────────────────
        // Written ONCE at creation. Immutable. Source of truth for accounting.

        /** Raw product basePrice at time of order. */
        basePriceSnapshot: {
            type: Number,
            required: [true, 'basePriceSnapshot is required'],
            min: [0, 'basePriceSnapshot cannot be negative'],
        },

        /** The group's markup percentage applied at time of order. */
        markupPercentageSnapshot: {
            type: Number,
            required: [true, 'markupPercentageSnapshot is required'],
            min: [0, 'markupPercentageSnapshot cannot be negative'],
        },

        /** Final per-unit price charged (basePrice + markup). */
        finalPriceCharged: {
            type: Number,
            required: [true, 'finalPriceCharged is required'],
            min: [0, 'finalPriceCharged cannot be negative'],
        },

        /** Snapshot of the group the user belonged to at time of order. */
        groupIdSnapshot: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Group',
            required: [true, 'groupIdSnapshot is required'],
        },

        /**
         * Net profit in USD for this order.
         * = (finalPriceCharged - basePriceSnapshot) × quantity.
         * Written once at creation time. Immutable.
         */
        profitUsd: {
            type: Number,
            default: 0,
            min: [0, 'profitUsd cannot be negative'],
        },

        // ── Financial Split Tracking ─────────────────────────────────────────

        walletDeducted: {
            type: Number,
            required: true,
            default: 0,
            min: [0, 'Wallet deducted cannot be negative'],
        },

        creditUsedAmount: {
            type: Number,
            required: true,
            default: 0,
            min: [0, 'Credit used amount cannot be negative'],
        },

        // ── Currency Snapshot ────────────────────────────────────────────────
        // Written ONCE at creation. Immutable. Ensures historical accuracy
        // even when platform exchange rates are updated later.

        /**
         * ISO 4217 currency code of the user's wallet at the time of order.
         * e.g. "USD", "SAR", "EGP"
         * Defaults to "USD" for orders created before multi-currency was added.
         */
        currency: {
            type: String,
            uppercase: true,
            trim: true,
            default: 'USD',
        },

        /**
         * The platform exchange rate used to convert USD → user currency
         * at the moment the order was created.
         * Always 1 for USD users. Immutable after creation.
         */
        rateSnapshot: {
            type: Number,
            default: 1,
            min: [0, 'rateSnapshot cannot be negative'],
        },

        /**
         * The product price in USD (before currency conversion).
         * = basePriceSnapshot × (1 + markupPercentageSnapshot/100) × quantity.
         * Used to pay providers (always USD).
         */
        usdAmount: {
            type: Number,
            default: null,
            min: [0, 'usdAmount cannot be negative'],
        },

        /**
         * The amount deducted from the user's wallet, in user currency.
         * = usdAmount × rateSnapshot.
         * This is the authoritative charge amount for wallet operations.
         */
        chargedAmount: {
            type: Number,
            default: null,
            min: [0, 'chargedAmount cannot be negative'],
        },

        // ── Order Status ─────────────────────────────────────────────────────

        status: {
            type: String,
            enum: Object.values(ORDER_STATUS),
            default: ORDER_STATUS.PENDING,
        },

        executionType: {
            type: String,
            enum: Object.values(ORDER_EXECUTION_TYPES),
            default: ORDER_EXECUTION_TYPES.MANUAL,
        },

        // ── Idempotency ──────────────────────────────────────────────────────

        idempotencyKey: {
            type: String,
            trim: true,
            default: null,
            sparse: true,
        },

        // ── Timestamps for audit ─────────────────────────────────────────────

        refundedAt: {
            type: Date,
            default: null,
        },

        failedAt: {
            type: Date,
            default: null,
        },

        // ══════════════════════════════════════════════════════════════════════
        // Provider Fulfillment Fields (new — all default null / 0 / false)
        // ══════════════════════════════════════════════════════════════════════

        /**
         * The provider's numeric order ID returned by PlaceOrder.
         * Used by CheckOrder / CheckListOrders polling.
         * Null until provider accepts the order.
         */
        providerOrderId: {
            type: mongoose.Schema.Types.Mixed,  // Number (Royal Crown) OR String (Alkasr "ID_xxx")
            default: null,
            index: true,              // cron queries PROCESSING + providerOrderId != null
        },

        /**
         * Last raw status string returned by the provider
         * ('Pending', 'Completed', 'Cancelled').
         * Mapped to ORDER_STATUS separately.
         */
        providerStatus: {
            type: String,
            default: null,
        },

        /** Complete raw JSON body returned by the last provider API call. */
        providerRawResponse: {
            type: mongoose.Schema.Types.Mixed,
            default: null,
        },

        /**
         * Number of status-check attempts made by the cron job.
         * When retryCount >= MAX_RETRY_COUNT the order is force-failed.
         */
        retryCount: {
            type: Number,
            default: 0,
            min: 0,
        },

        /** Timestamp of the most recent status poll. */
        lastCheckedAt: {
            type: Date,
            default: null,
        },

        /**
         * Idempotent refund guard.
         * Set to true BEFORE the wallet credit is applied.
         * If already true, a second refund attempt is rejected immediately.
         */
        refunded: {
            type: Boolean,
            default: false,
        },

        // ── Dynamic Order Fields ───────────────────────────────────────────────

        /**
         * Customer-supplied values for product-defined order fields.
         *
         * Stored ONCE at order creation time and never mutated afterward.
         * The snapshot ensures admin changes to product.orderFields do NOT
         * retroactively alter what was submitted or expected at order time.
         *
         * Structure:
         *   values         - key→value map of submitted field values
         *                    e.g. { player_id: "123", server: "EU" }
         *
         *   fieldsSnapshot - simplified copy of the product's active orderFields
         *                    at the moment the order was placed.
         *                    e.g. [{ key, label, type, options? }]
         *
         * Defaults to null when the product has no orderFields defined.
         */
        customerInput: {
            type: {
                /**
                 * Free-form key→value store.
                 * Keys match field.key; values are already type-coerced by
                 * the validator before being persisted here.
                 */
                values: {
                    type: mongoose.Schema.Types.Mixed,
                    default: {},
                },

                /**
                 * Immutable snapshot of the product's active orderFields at
                 * the moment of order creation.
                 * Each entry: { key, label, type, options?, placeholder? }
                 */
                fieldsSnapshot: {
                    type: [mongoose.Schema.Types.Mixed],
                    default: [],
                },
            },
            default: null,
        },
    },
    {
        timestamps: true,
    }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

orderSchema.index({ userId: 1, createdAt: -1 });
orderSchema.index({ status: 1 });
orderSchema.index({ groupIdSnapshot: 1 });

/** Idempotency enforcement — sparse because not all orders carry a key. */
orderSchema.index(
    { userId: 1, idempotencyKey: 1 },
    { unique: true, sparse: true, name: 'unique_user_idempotency_key' }
);

/**
 * Cron-job query index:
 * Efficiently find orders that are PROCESSING and have a provider order ID.
 * Also supports sorting by lastCheckedAt ASC (oldest-checked first).
 */
orderSchema.index(
    { status: 1, providerOrderId: 1, lastCheckedAt: 1 },
    { name: 'processing_orders_poll' }
);

const Order = mongoose.model('Order', orderSchema);

module.exports = { Order, ORDER_STATUS, ORDER_EXECUTION_TYPES, MAX_RETRY_COUNT };
