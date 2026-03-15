'use strict';

/**
 * Database Seeder
 * ───────────────
 * Creates seed data: groups, admin user, customer user, and products.
 *
 * Usage:
 *   node src/scripts/seed.js          → seed
 *   node src/scripts/seed.js --clear  → wipe all collections
 */

require('dotenv').config();

const mongoose = require('mongoose');
const config = require('../config/config');
const { User, ROLES } = require('../modules/users/user.model');
const Group = require('../modules/groups/group.model');
const { Product } = require('../modules/products/product.model');
const { WalletTransaction } = require('../modules/wallet/walletTransaction.model');
const { Order } = require('../modules/orders/order.model');

const CLEAR_FLAG = process.argv.includes('--clear');

const seed = async () => {
    try {
        await mongoose.connect(config.db.uri);
        console.log('✅ Connected to MongoDB');

        if (CLEAR_FLAG) {
            await Promise.all([
                User.deleteMany({}),
                Group.deleteMany({}),
                Product.deleteMany({}),
                Order.deleteMany({}),
                WalletTransaction.deleteMany({}),
            ]);
            console.log('🗑️  All collections cleared.');
            process.exit(0);
        }

        // ── 1. Create Groups ───────────────────────────────────────────────────────
        // NOTE: percentage replaces the old marginPercentage field.
        // Standard (0 %) is the default / lowest tier.
        // Premium (15 %) is the highest → auto-assigned to new registrations.
        const standardGroup = await Group.findOneAndUpdate(
            { name: 'Standard' },
            { name: 'Standard', percentage: 0, isActive: true },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        const premiumGroup = await Group.findOneAndUpdate(
            { name: 'Premium' },
            { name: 'Premium', percentage: 15, isActive: true },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        console.log(`✅ Groups seeded:`);
        console.log(`   Standard (0 %)  → id: ${standardGroup._id}`);
        console.log(`   Premium  (15 %) → id: ${premiumGroup._id}`);
        console.log(`   New registrations will be auto-assigned: Premium (highest %)`);

        // ── 2. Create Admin User ───────────────────────────────────────────────────
        // Admins are assigned the Standard group (lowest markup) by convention.
        const adminExists = await User.findOne({ email: 'admin@platform.com' });
        let admin;
        if (!adminExists) {
            admin = await User.create({
                name: 'Platform Admin',
                email: 'admin@platform.com',
                password: 'Admin@1234',
                role: ROLES.ADMIN,
                groupId: standardGroup._id,
                walletBalance: 0,
                creditLimit: 0,
            });
            console.log(`✅ Admin created → email: admin@platform.com | password: Admin@1234`);
        } else {
            admin = adminExists;
            console.log(`ℹ️  Admin already exists (id: ${admin._id})`);
        }

        // ── 3. Create Customer User ────────────────────────────────────────────────
        const customerExists = await User.findOne({ email: 'customer@platform.com' });
        let customer;
        if (!customerExists) {
            customer = await User.create({
                name: 'Test Customer',
                email: 'customer@platform.com',
                password: 'Customer@1234',
                role: ROLES.CUSTOMER,
                groupId: standardGroup._id,  // Admin-overridden to Standard for testing
                walletBalance: 500,           // Pre-loaded wallet for testing
                creditLimit: 200,
            });
            console.log(`✅ Customer created → email: customer@platform.com | password: Customer@1234`);
            console.log(`   walletBalance: $500 | creditLimit: $200 | group: Standard`);
        } else {
            customer = customerExists;
            console.log(`ℹ️  Customer already exists (id: ${customer._id})`);
        }

        // ── 4. Create Sample Products ──────────────────────────────────────────────
        const products = [
            { name: 'Basic Plan - 30 Days', basePrice: 9.99, minQty: 1, maxQty: 50 },
            { name: 'Pro Plan - 30 Days', basePrice: 29.99, minQty: 1, maxQty: 20 },
            { name: 'API Credits Bundle', basePrice: 4.99, minQty: 1, maxQty: 100 },
        ];

        for (const p of products) {
            await Product.findOneAndUpdate(
                { name: p.name },
                p,
                { upsert: true, new: true }
            );
        }

        console.log(`✅ ${products.length} products seeded.`);

        // ── Summary ─────────────────────────────────────────────────────────────────
        console.log('');
        console.log('═══════════════════════════════════════════════════');
        console.log('  Seed complete. Test credentials:');
        console.log('  ADMIN    → admin@platform.com    / Admin@1234');
        console.log('  CUSTOMER → customer@platform.com / Customer@1234');
        console.log('═══════════════════════════════════════════════════');

        process.exit(0);
    } catch (error) {
        console.error('❌ Seeding failed:', error.message);
        console.error(error);
        process.exit(1);
    }
};

seed();
