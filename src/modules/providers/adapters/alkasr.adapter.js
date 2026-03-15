'use strict';

/**
 * alkasr.adapter.js — AlkasrVipAdapter
 *
 * HTTP adapter for the **Alkasr VIP** external provider.
 *
 * ─── API Overview ─────────────────────────────────────────────────────────────
 *  Base URL    : provider.baseUrl  (e.g. https://alkasr-vip.com)
 *  Auth        : X-API-Key: <token>  header on every request
 *
 *  GET  /services                               — fetch product/service catalogue
 *  POST /order/create                           — place a new order
 *  GET  /order/status?order_id={id}             — check single order
 *  POST /order/status/bulk                      — bulk check  { order_ids: [1,2,3] }
 *  GET  /account/info                           — account info + balance
 *
 * ─── Status Vocabulary ────────────────────────────────────────────────────────
 *  Alkasr uses entirely different status vocabulary:
 *
 *  Alkasr      → Internal platform canonical
 *  accept      → Completed
 *  accepted    → Completed
 *  success     → Completed
 *  done        → Completed
 *
 *  wait        → Pending
 *  waiting     → Pending
 *  processing  → Pending
 *  pending     → Pending
 *  in_process  → Pending
 *
 *  reject      → Cancelled
 *  rejected    → Cancelled
 *  failed      → Cancelled
 *  error       → Cancelled
 *  cancelled   → Cancelled
 *  cancel      → Cancelled
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

// ─── Status normaliser (Alkasr → internal canonical) ─────────────────────────

/**
 * Map Alkasr-specific status strings to the canonical platform vocabulary
 * understood by statusMapper.js → ORDER_STATUS.
 *
 * @param {string} alkasrStatus
 * @returns {'Completed'|'Pending'|'Cancelled'}
 */
const _normaliseAlkasrStatus = (alkasrStatus) => {
    switch (String(alkasrStatus ?? '').toLowerCase().trim()) {
        case 'accept':
        case 'accepted':
        case 'success':
        case 'done':
        case 'complete':
        case 'completed':
            return 'Completed';

        case 'wait':
        case 'waiting':
        case 'processing':
        case 'pending':
        case 'in_process':
        case 'in_progress':
        case 'queued':
            return 'Pending';

        case 'reject':
        case 'rejected':
        case 'failed':
        case 'error':
        case 'cancelled':
        case 'canceled':
        case 'cancel':
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
            'api-token': token,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        },
    });

    client.interceptors.response.use(
        (res) => res,
        (err) => {
            const status = err.response?.status;
            const body = err.response?.data;
            const message = body?.message ?? body?.error ?? body?.msg ?? err.message ?? 'Unknown Alkasr error';
            const wrapped = new Error(`[AlkasrVip] HTTP ${status ?? 'NETWORK'}: ${message}`);
            wrapped.statusCode = status ?? null;
            wrapped.providerBody = body ?? null;
            return Promise.reject(wrapped);
        }
    );

    return client;
};

// ─── AlkasrVipAdapter ─────────────────────────────────────────────────────────

class AlkasrVipAdapter extends BaseProviderAdapter {
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
        if (!provider.baseUrl) throw new Error('[AlkasrVip] provider.baseUrl is required');
        if (!token) throw new Error('[AlkasrVip] api token (apiToken / apiKey) is required');

        this._client = _buildClient(provider.baseUrl, token, options.timeoutMs);
    }

    // ── Product Catalogue ─────────────────────────────────────────────────────

    /**
     * GET /services
     *
     * Alkasr may return:
     *   { services: [...] }  or  { data: [...] }  or  plain array
     *
     * Each item: { service_id, service_name, cost_per_unit, min, max, is_active }
     *
     * @returns {Promise<ProviderProductDTO[]>}
     */
 async getProducts() {
    const { data } = await this._client.get('/products');
    const list = Array.isArray(data)
        ? data
        : (data.services ?? data.data ?? data.items ?? []);

    return list.map((item) => this._validateDTO({
        externalProductId: String(
            item.service_id ?? item.id ?? item.product_id ?? item.code
        ),
        rawName: String(
            item.service_name ?? item.name ?? item.title ?? 'Unknown'
        ),
        rawPrice: parseFloat(
            item.cost_per_unit ?? item.price ?? item.rate ?? item.cost ?? 0
        ),
        minQty: parseInt(item.qty_values?.min ?? item.min ?? item.min_quantity ?? item.minimum ?? 1, 10),
        
        maxQty: parseInt(item.qty_values?.max ?? item.max ?? item.max_quantity ?? item.maximum ?? 9999, 10),
        
        isActive: item.is_active !== false
            && item.active !== false
            && item.available !== false
            && item.status !== 'inactive',
        rawPayload: item,
    }));
}

    // ── Order Placement ───────────────────────────────────────────────────────

    /**
     * POST /order/create
     *
     * Request body:
     *   {
     *     service_id:  <string|number>,
     *     qty:         <number>,
     *     uid:         <string>,        // player / account ID (optional)
     *     ref:         <string>,        // our internal reference (optional)
     *   }
     *
     * Response:
     *   {
     *     order_id: <number>,
     *     status:   'wait' | 'accept' | 'reject',
     *     ...
     *   }
     *
     * placeOrder() NEVER throws — all failures surface as { success: false }.
     *
     * @param {Object}        params
     * @param {string|number} params.productId         — provider's externalProductId
     * @param {number}        params.amount             — quantity
     * @param {string}        [params.playerId]         — player / uid on provider side
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
                service_id: productId,
                qty: amount,
                ...(playerId && { uid: playerId }),
                ...(referenceId && { ref: referenceId }),
            };

            const { data } = await this._client.post('/order/create', body);

            // Explicit API-level rejection
            if (data.success === false || _normaliseAlkasrStatus(data.status) === 'Cancelled') {
                return {
                    success: false,
                    providerOrderId: null,
                    providerStatus: 'Cancelled',
                    rawResponse: data,
                    errorMessage: data.message ?? data.msg ?? data.error ?? 'AlkasrVip rejected the order',
                };
            }

            const providerOrderId = data.order_id ?? data.id ?? data.orderId ?? null;
            if (!providerOrderId) {
                return {
                    success: false,
                    providerOrderId: null,
                    providerStatus: 'Cancelled',
                    rawResponse: data,
                    errorMessage: 'AlkasrVip returned no order id',
                };
            }

            return {
                success: true,
                providerOrderId: parseInt(String(providerOrderId), 10),
                providerStatus: _normaliseAlkasrStatus(data.status),
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
     * GET /order/status?order_id={id}
     *
     * Response: { order_id, status, ... }
     *
     * @param {number|string} orderId
     * @returns {Promise<OrderStatusResult>}
     */
    async checkOrder(orderId) {
        const { data } = await this._client.get('/order/status', {
            params: { order_id: orderId },
        });

        return {
            providerOrderId: parseInt(String(data.order_id ?? orderId), 10),
            providerStatus: _normaliseAlkasrStatus(data.status),
            rawResponse: data,
        };
    }

    /**
     * POST /order/status/bulk
     *
     * Request body: { order_ids: [1, 2, 3] }
     *
     * Response:
     *   { orders: [{ order_id, status, ... }, ...] }
     *     OR
     *   plain array
     *
     * @param {Array<number|string>} orderIds
     * @returns {Promise<OrderStatusResult[]>}
     */
    async checkOrders(orderIds) {
        if (!orderIds?.length) return [];

        const { data } = await this._client.post('/order/status/bulk', {
            order_ids: orderIds,
        });

        const list = Array.isArray(data) ? data : (data.orders ?? data.data ?? []);
        return list.map((item) => ({
            providerOrderId: parseInt(String(item.order_id ?? item.id), 10),
            providerStatus: _normaliseAlkasrStatus(item.status),
            rawResponse: item,
        }));
    }

    // ── Account / Balance ─────────────────────────────────────────────────────

    /**
     * GET /account/info
     *
     * @returns {Promise<Object>}
     */
    async getBalance() {
        const { data } = await this._client.get('/account/info');
        return data;
    }
}

module.exports = { AlkasrVipAdapter };
