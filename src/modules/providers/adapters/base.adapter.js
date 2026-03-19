'use strict';

/**
 * BaseProviderAdapter
 *
 * Abstract contract every provider adapter must implement.
 *
 * Adapters are thin translators: they call the provider's HTTP API and return
 * normalised DTOs. No business logic lives here — they purely translate
 * external formats into the internal shape expected by services.
 *
 * ─── Product DTO shape ───────────────────────────────────────────────────────
 * {
 *   externalProductId : string   (required — stable identifier from provider)
 *   rawName           : string   (required)
 *   rawPrice          : number   (required, >= 0)
 *   minQty            : number   (optional, default 1)
 *   maxQty            : number   (optional, default 9999)
 *   isActive          : boolean  (optional, default true)
 *   rawPayload        : object   (optional — verbatim provider response)
 * }
 *
 * ─── PlaceOrderResult shape ───────────────────────────────────────────────────
 * {
 *   success         : boolean
 *   providerOrderId : number|string|null
 *   providerStatus  : 'Completed' | 'Pending' | 'Cancelled'
 *   rawResponse     : object
 *   errorMessage    : string|null
 * }
 *
 * ─── OrderStatusResult shape ──────────────────────────────────────────────────
 * {
 *   providerOrderId : number|string
 *   providerStatus  : 'Completed' | 'Pending' | 'Cancelled'
 *   rawResponse     : object
 * }
 */
class BaseProviderAdapter {
    /**
     * @param {Object}      provider        - Provider Mongoose document
     * @param {string}      provider.name
     * @param {string}      provider.slug
     * @param {string}      provider.baseUrl
     * @param {string|null} provider.apiToken
     * @param {string|null} provider.apiKey  - legacy alias for apiToken
     * @param {Object}      [options]        - extra options (e.g. test overrides)
     */
    constructor(provider, options = {}) {
        if (new.target === BaseProviderAdapter) {
            throw new Error('BaseProviderAdapter is abstract and cannot be instantiated directly.');
        }
        this.provider = provider;
        this.options = options;
    }

    // ─── Required: products ────────────────────────────────────────────────────

    /**
     * Fetch all products from the provider and return normalised DTOs.
     * Called by the sync engine (GET /api/AllProducts equivalent).
     *
     * @returns {Promise<ProviderProductDTO[]>}
     * @abstract
     */
    async getProducts() {
        throw new Error(`${this.constructor.name} must implement getProducts()`);
    }

    /**
     * @alias getProducts — backward-compat name used by sync.service.js
     */
    async fetchProducts() {
        return this.getProducts();
    }

    // ─── Required: order placement ─────────────────────────────────────────────

    /**
     * Place an order with the provider.
     *
     * @param {Object}          params
     * @param {string|number}   params.productId     - provider's externalProductId
     * @param {number}          params.amount        - quantity / units
     * @param {string}          [params.playerId]    - player / account ID (if required)
     * @param {string}          [params.referenceId] - our internal reference
     * @param {string|number}   [params.externalProductId] - alias for productId (compat)
     * @param {number}          [params.quantity]           - alias for amount (compat)
     *
     * @returns {Promise<PlaceOrderResult>}
     * @abstract
     */
    // eslint-disable-next-line no-unused-vars
    async placeOrder(params) {
        throw new Error(`${this.constructor.name} must implement placeOrder()`);
    }

    // ─── Required: order status ────────────────────────────────────────────────

    /**
     * Check the status of a single provider order.
     *
     * @param {number|string} orderId
     * @returns {Promise<OrderStatusResult>}
     * @abstract
     */
    // eslint-disable-next-line no-unused-vars
    async checkOrder(orderId) {
        throw new Error(`${this.constructor.name} must implement checkOrder()`);
    }

    /**
     * Check the status of multiple provider orders in one request.
     * More efficient than calling checkOrder() N times.
     *
     * @param {Array<number|string>} orderIds
     * @returns {Promise<OrderStatusResult[]>}
     * @abstract
     */
    // eslint-disable-next-line no-unused-vars
    async checkOrders(orderIds) {
        throw new Error(`${this.constructor.name} must implement checkOrders()`);
    }

    /**
     * @alias checkOrders — used by pollProcessingOrders
     */
    async checkOrdersBatch(orderIds) {
        return this.checkOrders(orderIds);
    }

    // ─── Required: account ────────────────────────────────────────────────────

    /**
     * Fetch provider account info / balance.
     *
     * @returns {Promise<Object>}
     * @abstract
     */
    async getBalance() {
        throw new Error(`${this.constructor.name} must implement getBalance()`);
    }

    /**
     * @alias getBalance — used by royalCrownProvider.js naming convention
     */
    async getMyInfo() {
        return this.getBalance();
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    /**
     * Validate and normalise a raw provider product into the DTO shape.
     * Adapters should call this before returning from getProducts().
     *
     * @param {Object} dto
     * @returns {Object} validated, normalised DTO
     */
    _validateDTO(dto) {
        if (!dto.externalProductId) throw new Error('DTO missing externalProductId');
        if (!dto.rawName) throw new Error('DTO missing rawName');
        if (typeof dto.rawPrice !== 'number' || dto.rawPrice < 0) {
            throw new Error(`DTO rawPrice must be a non-negative number, got: ${dto.rawPrice}`);
        }
        return {
            externalProductId: String(dto.externalProductId),
            rawName: String(dto.rawName),
            rawPrice: parseFloat(dto.rawPrice.toFixed(4)),
            minQty: dto.minQty ?? 1,
            maxQty: dto.maxQty ?? 9999,
            isActive: dto.isActive ?? true,
            rawPayload: dto.rawPayload ?? dto,
        };
    }

    /**
     * Resolve the effective API token from provider document.
     * Prefers apiToken, falls back to apiKey (legacy field).
     *
     * @returns {string|null}
     */
    _resolveToken() {
        return this.provider.apiToken
            || this.provider.apiKey
            || this.provider.effectiveToken
            || null;
    }

    /**
     * Convert a provider-specific status string to the unified platform status.
     *
     * @param {string} providerStatus
     * @returns {'COMPLETED'|'PENDING'|'FAILED'}
     */
    toUnifiedStatus(providerStatus) {
        return toUnifiedStatus(providerStatus);
    }
}

// ─── Unified Status Constants ────────────────────────────────────────────────

const UNIFIED_STATUS = Object.freeze({
    COMPLETED: 'COMPLETED',
    PENDING: 'PENDING',
    FAILED: 'FAILED',
});

/**
 * Map any provider-specific status string to the unified status enum.
 * Handles Royal Crown / Torosfon ('Completed', 'Pending', 'Cancelled')
 * and Alkasr ('accept', 'wait', 'reject', 'OK', etc.)
 *
 * @param {string} raw
 * @returns {'COMPLETED'|'PENDING'|'FAILED'}
 */
const toUnifiedStatus = (raw) => {
    switch (String(raw ?? '').toLowerCase().trim()) {
        case 'completed':
        case 'complete':
        case 'done':
        case 'success':
        case 'accept':
        case 'accepted':
        case 'ok':
            return UNIFIED_STATUS.COMPLETED;

        case 'pending':
        case 'processing':
        case 'in_progress':
        case 'in progress':
        case 'queued':
        case 'wait':
        case 'waiting':
        case 'in_process':
            return UNIFIED_STATUS.PENDING;

        case 'cancelled':
        case 'canceled':
        case 'cancel':
        case 'failed':
        case 'error':
        case 'reject':
        case 'rejected':
        default:
            return UNIFIED_STATUS.FAILED;
    }
};

module.exports = { BaseProviderAdapter, UNIFIED_STATUS, toUnifiedStatus };
