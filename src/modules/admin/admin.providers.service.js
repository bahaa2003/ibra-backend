'use strict';

/**
 * admin.providers.service.js
 *
 * Admin management of Provider documents.
 * Wraps the provider model with business rules + audit.
 */

const { Provider } = require('../providers/provider.model');
const { getProviderAdapter } = require('../providers/adapters/adapter.factory');
const { NotFoundError, BusinessRuleError } = require('../../shared/errors/AppError');
const { createAuditLog } = require('../audit/audit.service');
const { ADMIN_ACTIONS, ENTITY_TYPES, ACTOR_ROLES } = require('../audit/audit.constants');

// ─── List ──────────────────────────────────────────────────────────────────────

const listProviders = async ({ includeInactive = true } = {}) => {
    const filter = includeInactive ? {} : { isActive: true };
    return Provider.find(filter).sort({ name: 1 });
};

// ─── Get one ──────────────────────────────────────────────────────────────────

const getProviderById = async (id) => {
    const provider = await Provider.findById(id);
    if (!provider) throw new NotFoundError('Provider');
    return provider;
};

// ─── Create ───────────────────────────────────────────────────────────────────

const createProvider = async (data, adminId) => {
    const provider = await Provider.create(data);

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.PROVIDER_CREATED,
        entityType: ENTITY_TYPES.PROVIDER,
        entityId: provider._id,
        metadata: { name: provider.name, slug: provider.slug, baseUrl: provider.baseUrl },
    });

    return provider;
};

// ─── Update ───────────────────────────────────────────────────────────────────

const updateProvider = async (id, data, adminId) => {
    const provider = await Provider.findById(id);
    if (!provider) throw new NotFoundError('Provider');

    const before = provider.toObject();
    const { name, slug, baseUrl, apiToken, isActive, syncInterval, supportedFeatures } = data;

    if (name !== undefined) provider.name = name;
    if (slug !== undefined) provider.slug = slug;
    if (baseUrl !== undefined) provider.baseUrl = baseUrl;
    if (apiToken !== undefined) provider.apiToken = apiToken;
    if (isActive !== undefined) provider.isActive = isActive;
    if (syncInterval !== undefined) provider.syncInterval = syncInterval;
    if (supportedFeatures !== undefined) provider.supportedFeatures = supportedFeatures;

    await provider.save();

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.PROVIDER_UPDATED,
        entityType: ENTITY_TYPES.PROVIDER,
        entityId: provider._id,
        metadata: { before, after: provider.toObject() },
    });

    return provider;
};

// ─── Soft Delete ──────────────────────────────────────────────────────────────

const deleteProvider = async (id, adminId) => {
    const provider = await Provider.findById(id);
    if (!provider) throw new NotFoundError('Provider');
    if (provider.deletedAt) throw new BusinessRuleError('Provider is already deleted.', 'ALREADY_DELETED');

    provider.isActive = false;
    provider.deletedAt = new Date();
    await provider.save();

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.PROVIDER_DELETED,
        entityType: ENTITY_TYPES.PROVIDER,
        entityId: provider._id,
        metadata: { name: provider.name },
    });

    return provider;
};

// ─── Toggle Active ────────────────────────────────────────────────────────────

const toggleProvider = async (id, adminId) => {
    const provider = await Provider.findById(id);
    if (!provider) throw new NotFoundError('Provider');

    provider.isActive = !provider.isActive;
    await provider.save();

    createAuditLog({
        actorId: adminId,
        actorRole: ACTOR_ROLES.ADMIN,
        action: ADMIN_ACTIONS.PROVIDER_TOGGLED,
        entityType: ENTITY_TYPES.PROVIDER,
        entityId: provider._id,
        metadata: { name: provider.name, isActive: provider.isActive },
    });

    return provider;
};

// ─── Get Provider Balance ─────────────────────────────────────────────────────

const getProviderBalance = async (id) => {
    const provider = await Provider.findById(id);
    if (!provider) throw new NotFoundError('Provider');
    if (!provider.isActive) throw new BusinessRuleError('Provider is inactive.', 'PROVIDER_INACTIVE');

    const adapter = getProviderAdapter(provider);
    const balance = await adapter.getBalance();
    return { provider: provider.name, balance };
};

// ─── Get Provider Products (live from API) ─────────────────────────────────────

const getProviderLiveProducts = async (id) => {
    const provider = await Provider.findById(id);
    if (!provider) throw new NotFoundError('Provider');
    if (!provider.isActive) throw new BusinessRuleError('Provider is inactive.', 'PROVIDER_INACTIVE');

    const adapter = getProviderAdapter(provider);
    const products = await adapter.getProducts();
    return { provider: provider.name, count: products.length, products };
};

// ─── Test Provider Connection ─────────────────────────────────────────────────

/**
 * Ping the provider API to verify credentials and connectivity.
 * Uses getBalance() as a lightweight health-check call.
 * Wraps in a timeout to prevent hanging if the provider is unresponsive.
 */
const testProviderConnection = async (id) => {
    const provider = await Provider.findById(id);
    if (!provider) throw new NotFoundError('Provider');

    const adapter = getProviderAdapter(provider);
    const startTime = Date.now();

    try {
        // Use a 10-second timeout to prevent indefinite hanging
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Connection timed out after 10 seconds')), 10000)
        );
        await Promise.race([adapter.getBalance(), timeoutPromise]);

        const latency = Date.now() - startTime;
        return {
            success: true,
            provider: provider.name,
            latencyMs: latency,
            message: `Connection successful (${latency}ms)`,
            testedAt: new Date().toISOString(),
        };
    } catch (err) {
        const latency = Date.now() - startTime;
        return {
            success: false,
            provider: provider.name,
            latencyMs: latency,
            message: err.message || 'Connection failed',
            testedAt: new Date().toISOString(),
        };
    }
};

// ─── Get Single Product Price (live from provider API) ────────────────────────

/**
 * Fetch a single product's live price from the provider.
 * Calls getProducts() and filters by externalProductId.
 */
const getProductPrice = async (providerId, externalProductId) => {
    const provider = await Provider.findById(providerId);
    if (!provider) throw new NotFoundError('Provider');
    if (!provider.isActive) throw new BusinessRuleError('Provider is inactive.', 'PROVIDER_INACTIVE');

    const adapter = getProviderAdapter(provider);

    try {
        const products = await adapter.getProducts();
        const product = products.find(
            (p) => String(p.externalProductId) === String(externalProductId)
        );

        if (!product) {
            return {
                found: false,
                provider: provider.name,
                externalProductId,
                rawPrice: null,
                message: 'Product not found in provider catalog',
            };
        }

        return {
            found: true,
            provider: provider.name,
            externalProductId: product.externalProductId,
            rawName: product.rawName,
            rawPrice: product.rawPrice,
            isActive: product.isActive,
        };
    } catch (err) {
        throw new BusinessRuleError(
            `Failed to fetch price from provider: ${err.message}`,
            'PROVIDER_API_ERROR'
        );
    }
};

module.exports = {
    listProviders,
    getProviderById,
    createProvider,
    updateProvider,
    deleteProvider,
    toggleProvider,
    getProviderBalance,
    getProviderLiveProducts,
    testProviderConnection,
    getProductPrice,
};
