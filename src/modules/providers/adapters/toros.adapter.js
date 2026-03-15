'use strict';

/**
 * toros.adapter.js — TorosfonAdapter
 *
 * HTTP adapter for the **Torosfon Store** external provider.
 *
 * ─── API Overview ─────────────────────────────────────────────────────────────
 *  Base URL    : provider.baseUrl  (e.g. https://torosfon.com)
 *  Auth        : Authorization: Bearer <token>
 *
 *  GET  /api/products                    — fetch product catalogue
 *  POST /api/orders                      — place a new order
 *  GET  /api/orders/{orderId}            — check single order
 *  POST /api/orders/batch-status         — batch check  { order_ids: [1,2,3] }
 *  GET  /api/account/balance             — account balance
 *
 * ─── Status Vocabulary ────────────────────────────────────────────────────────
 *  Toros        → Internal platform canonical
 *  completed    → Completed
 *  processing   → Pending
 *  pending      → Pending
 *  failed       → Cancelled
 *  rejected     → Cancelled
 *  cancelled    → Cancelled
 *
 * ─── Normalised DTO shapes ────────────────────────────────────────────────────
 *  getProducts()  → ProviderProductDTO[]
 *  placeOrder()   → PlaceOrderResult   { success, providerOrderId, providerStatus, rawResponse, errorMessage }
 *  checkOrder()   → OrderStatusResult  { providerOrderId, providerStatus, rawResponse }
 *  checkOrders()  → OrderStatusResult[]
 *  getBalance()   → Object
 *
 * The adapter NEVER throws for placeOrder() — all failures return { success: false }.
 */

const axios = require('axios');
const { BaseProviderAdapter } = require('./base.adapter');

const DEFAULT_TIMEOUT_MS = 15_000;

// ─── Status normaliser (Toros → internal canonical) ──────────────────────────

/**
 * Map Toros-specific status strings to the canonical platform vocabulary
 * understood by statusMapper.js → ORDER_STATUS.
 *
 * @param {string} torosStatus
 * @returns {'Completed'|'Pending'|'Cancelled'}
 */
const _normaliseTorosStatus = (torosStatus) => {
    switch (String(torosStatus ?? '').toLowerCase().trim()) {
        case 'completed':
        case 'success':
        case 'done':
            return 'Completed';

        case 'processing':
        case 'pending':
        case 'in_progress':
        case 'in progress':
        case 'queued':
            return 'Pending';

        case 'failed':
        case 'rejected':
        case 'cancelled':
        case 'canceled':
        case 'error':
        default:
            return 'Cancelled';
    }
};

// ─── Axios client factory ─────────────────────────────────────────────────────

const _buildClient = (baseURL, token, timeoutMs = DEFAULT_TIMEOUT_MS) => {
    const client = axios.create({
        baseURL,
        timeout: timeoutMs,
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        },
    });

    client.interceptors.response.use(
        (res) => res,
        (err) => {
            const status = err.response?.status;
            const body = err.response?.data;
            const message = body?.message ?? body?.error ?? err.message ?? 'Unknown Toros error';
            const wrapped = new Error(`[Toros] HTTP ${status ?? 'NETWORK'}: ${message}`);
            wrapped.statusCode = status ?? null;
            wrapped.providerBody = body ?? null;
            return Promise.reject(wrapped);
        }
    );

    return client;
};

// ─── TorosfonAdapter ──────────────────────────────────────────────────────────

class TorosfonAdapter extends BaseProviderAdapter {
    /**
     * @param {Object} provider
     * @param {string} provider.baseUrl
     * @param {string} [provider.apiToken]
     * @param {string} [provider.apiKey]   — legacy alias
     * @param {Object} [options]
     * @param {number} [options.timeoutMs]
     */
    constructor(provider, options = {}) {
        super(provider, options);

        const token = this._resolveToken();
        if (!provider.baseUrl) throw new Error('[Toros] provider.baseUrl is required');
        if (!token) throw new Error('[Toros] api token (apiToken / apiKey) is required');

        this._client = _buildClient(provider.baseUrl, token, options.timeoutMs);
    }

    // ── Product Catalogue ─────────────────────────────────────────────────────

    /**
     * GET /api/products
     *
     * Toros may return:
     *   { data: [...] }  or  { products: [...] }  or  plain array
     *
     * Each item: { id, name, price, min_order, max_order, active }
     *
     * @returns {Promise<ProviderProductDTO[]>}
     */
    async getProducts() {
        const { data } = await this._client.get('/api/AllProducts');
        const list = Array.isArray(data)
            ? data
            : (data.data ?? data.products ?? data.items ?? []);

        return list.map((item) => this._validateDTO({
            externalProductId: String(item.id ?? item.product_id ?? item.code),
            rawName: String(item.name ?? item.title ?? item.label ?? 'Unknown'),
            rawPrice: parseFloat(item.price ?? item.cost ?? item.rate ?? 0),
            minQty: parseInt(item.min_order ?? item.min ?? item.minimum ?? 1, 10),
            maxQty: parseInt(item.max_order ?? item.max ?? item.maximum ?? 9999, 10),
            isActive: item.active !== false && item.status !== 'inactive',
            rawPayload: item,
        }));
    }

    // ── Order Placement ───────────────────────────────────────────────────────

    /**
     * POST /api/orders
     *
     * Request body:
     *   {
     *     product_id:   <string|number>,
     *     quantity:     <number>,
     *     player_id:    <string>,        // optional
     *     reference_id: <string>,        // optional — our internal order reference
     *   }
     *
     * Response:
     *   { id, status, product_id, quantity, created_at, ... }
     *
     * placeOrder() NEVER throws — all failures surface as { success: false }.
     *
     * @param {Object}        params
     * @param {string|number} params.productId         — provider's externalProductId
     * @param {number}        params.amount             — quantity
     * @param {string}        [params.playerId]
     * @param {string}        [params.referenceId]
     * @param {string|number} [params.externalProductId] — alias (compat)
     * @param {number}        [params.quantity]           — alias (compat)
     * @returns {Promise<PlaceOrderResult>}
     */
    async placeOrder(params) {
        const productId = params.productId ?? params.externalProductId;
        const amount = params.amount ?? params.quantity;
        const playerId = params.playerId ?? '';
        const referenceId = params.referenceId ?? '';

        try {
            const body = {
                product_id: productId,
                quantity: amount,
                ...(playerId && { player_id: playerId }),
                ...(referenceId && { reference_id: referenceId }),
            };

            const { data } = await this._client.post('/api/orders', body);

            // Explicit API-level rejection
            if (data.success === false || data.status === 'error') {
                return {
                    success: false,
                    providerOrderId: null,
                    providerStatus: 'Cancelled',
                    rawResponse: data,
                    errorMessage: data.message ?? data.error ?? 'Toros rejected the order',
                };
            }

            const providerOrderId = data.id ?? data.order_id ?? data.orderId ?? null;
            if (!providerOrderId) {
                return {
                    success: false,
                    providerOrderId: null,
                    providerStatus: 'Cancelled',
                    rawResponse: data,
                    errorMessage: 'Toros returned no order id',
                };
            }

            return {
                success: true,
                providerOrderId: parseInt(String(providerOrderId), 10),
                providerStatus: _normaliseTorosStatus(data.status),
                rawResponse: data,
                errorMessage: null,
            };

        } catch (err) {
            return {
                success: false,
                providerOrderId: null,
                providerStatus: 'Cancelled',
                rawResponse: err.providerBody ?? { message: err.message },
                errorMessage: err.message,
            };
        }
    }

    // ── Order Status ──────────────────────────────────────────────────────────

    /**
     * GET /api/orders/{orderId}
     *
     * Response: { id, status, ... }
     *
     * @param {number|string} orderId
     * @returns {Promise<OrderStatusResult>}
     */
    async checkOrder(orderId) {
        const { data } = await this._client.get(`/api/orders/${encodeURIComponent(orderId)}`);
        return {
            providerOrderId: parseInt(String(data.id ?? orderId), 10),
            providerStatus: _normaliseTorosStatus(data.status),
            rawResponse: data,
        };
    }

    /**
     * POST /api/orders/batch-status
     *
     * Request body: { order_ids: [1, 2, 3] }
     *
     * Response:
     *   [{ id, status, ... }, ...]
     *     OR
     *   { orders: [{ id, status, ... }, ...] }
     *
     * @param {Array<number|string>} orderIds
     * @returns {Promise<OrderStatusResult[]>}
     */
    async checkOrders(orderIds) {
        if (!orderIds?.length) return [];

        const { data } = await this._client.post('/api/orders/batch-status', {
            order_ids: orderIds,
        });

        const list = Array.isArray(data) ? data : (data.orders ?? data.data ?? []);
        return list.map((item) => ({
            providerOrderId: parseInt(String(item.id ?? item.order_id), 10),
            providerStatus: _normaliseTorosStatus(item.status),
            rawResponse: item,
        }));
    }

    // ── Account / Balance ─────────────────────────────────────────────────────

    /**
     * GET /api/account/balance
     *
     * @returns {Promise<Object>}
     */
    async getBalance() {
        const { data } = await this._client.get('/api/account/balance');
        return data;
    }
}

module.exports = { TorosfonAdapter };
