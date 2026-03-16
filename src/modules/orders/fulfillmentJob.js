'use strict';

/**
 * fulfillmentJob.js
 *
 * Background cron job that polls PROCESSING orders every minute.
 *
 * Lifecycle:
 *   start()   — schedule the job (called once from server.js after DB connects)
 *   stop()    — graceful shutdown (called on SIGTERM/SIGINT)
 *   runOnce() — execute one polling cycle (also useful for admin triggers / tests)
 *
 * Design:
 *   - Uses node-cron (lightweight, no extra services required)
 *   - Jobs are serialised: if a run is still in progress when the next tick
 *     fires, the tick is skipped (_running flag)
 *   - No job is started in test environments (NODE_ENV === 'test')
 *   - Multi-provider aware: iterates all active providers, resolving the
 *     correct adapter for each via the adapter factory
 *   - Supports a providerOverride for single-provider tests
 */

const cron = require('node-cron');
const { pollProcessingOrders } = require('../orders/orderFulfillment.service');
const { getProviderAdapter } = require('../providers/adapters/adapter.factory');
const { Provider } = require('../providers/provider.model');

// ── State ─────────────────────────────────────────────────────────────────────

let _task = null;   // node-cron ScheduledTask
let _running = false;  // execution lock — prevents overlapping runs

// ── Job logic ─────────────────────────────────────────────────────────────────

/**
 * Execute one polling cycle.
 * Safe to call manually (e.g. in integration tests or admin triggers).
 *
 * When providerOverride is passed, a single poll is run against that provider.
 * In production (providerOverride = null), all active providers are iterated
 * and each gets its own adapter + poll.
 *
 * @param {Object|null} [providerOverride]  - inject a single mock provider (tests)
 * @returns {Promise<Object|Object[]|null>} - stats from pollProcessingOrders
 */
const runOnce = async (providerOverride = null) => {
    if (_running) {
        console.log('[FulfillmentJob] Skipping tick — previous run still in progress.');
        return null;
    }

    _running = true;
    const startedAt = Date.now();

    try {
        // ── Test / single-provider override ───────────────────────────────────
        if (providerOverride) {
            const stats = await pollProcessingOrders(providerOverride);
            const elapsed = Date.now() - startedAt;
            console.log(`[FulfillmentJob] Poll completed in ${elapsed}ms:`, stats);
            return stats;
        }

        // ── Production: iterate all active providers ───────────────────────────
        const activeProviders = await Provider.find({ isActive: true });

        if (activeProviders.length === 0) {
            console.log('[FulfillmentJob] No active providers — nothing to poll.');
            return null;
        }

        const allStats = [];

        for (const providerDoc of activeProviders) {
            try {
                const adapter = getProviderAdapter(providerDoc);
                const stats = await pollProcessingOrders(adapter);
                allStats.push({ providerId: providerDoc._id.toString(), ...stats });
            } catch (err) {
                console.error(
                    `[FulfillmentJob] Provider ${providerDoc.name} poll failed:`,
                    err.message
                );
                allStats.push({
                    providerId: providerDoc._id.toString(),
                    error: err.message,
                });
            }
        }

        const elapsed = Date.now() - startedAt;
        //console.log(`[FulfillmentJob] All providers polled in ${elapsed}ms:`, allStats);
        return allStats;

    } catch (err) {
        console.error('[FulfillmentJob] Unhandled error in polling cycle:', err.message);
        return null;
    } finally {
        _running = false;
    }
};

// ── Schedule ──────────────────────────────────────────────────────────────────

/**
 * Start the cron scheduler.
 * Call once from server.js after the DB connection is established.
 *
 * @param {string} [schedule='* * * * *']  - cron expression (default: every minute)
 * @param {Object} [providerOverride]       - inject single provider (tests only)
 */
const start = (schedule = '* * * * *', providerOverride = null) => {
    if (process.env.NODE_ENV === 'test') {
        console.log('[FulfillmentJob] Skipped in test environment.');
        return;
    }

    if (_task) {
        console.warn('[FulfillmentJob] Already started — ignoring duplicate start().');
        return;
    }

    console.log(`[FulfillmentJob] Scheduling fulfillment poll: '${schedule}'`);

    _task = cron.schedule(schedule, async () => {
        await runOnce(providerOverride);
    });

    console.log('[FulfillmentJob] Fulfillment cron job started.');
};

/**
 * Stop the cron scheduler.
 * Called during graceful shutdown.
 */
const stop = () => {
    if (_task) {
        _task.stop();
        _task = null;
        console.log('[FulfillmentJob] Fulfillment cron job stopped.');
    }
};

module.exports = { start, stop, runOnce };
