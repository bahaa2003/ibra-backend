'use strict';

const { Product } = require('../modules/products/product.model');
const { Order, ORDER_STATUS } = require('../modules/orders/order.model');
const adminUsersService = require('../modules/admin/admin.users.service');
const adminOrdersService = require('../modules/admin/admin.orders.service');
const { listOrdersForUser } = require('../modules/orders/order.service');
const productService = require('../modules/products/product.service');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createGroup,
    createCustomer,
    createProduct,
} = require('./testHelpers');

beforeAll(async () => { await connectTestDB(); });
afterAll(async () => { await disconnectTestDB(); });
beforeEach(async () => { await clearCollections(); });

const createListedOrder = async ({ user, product, orderNumber, status = ORDER_STATUS.PENDING, executionType = 'manual', providerCode = null, playerId = 'player' }) => (
    Order.create({
        userId: user._id,
        productId: product._id,
        orderNumber,
        quantity: 1,
        unitPrice: '10',
        totalPrice: '10',
        basePriceSnapshot: '10',
        markupPercentageSnapshot: 0,
        finalPriceCharged: '10',
        groupIdSnapshot: user.groupId,
        walletDeducted: 10,
        status,
        executionType,
        providerCode,
        customerInput: { values: { playerId } },
    })
);

describe('server-side search and pagination', () => {
    it('searches users literally across name, email, and exact ObjectId with the same status/page filter', async () => {
        const group = await createGroup();
        const matching = await createCustomer({
            groupId: group._id,
            name: 'Literal [bracket] user',
            email: 'literal+user@example.test',
        });
        await createCustomer({ groupId: group._id, name: 'Literal other user' });

        const byLiteralName = await adminUsersService.listUsers({ search: '[bracket]', status: 'ACTIVE', page: 1, limit: 1 });
        expect(byLiteralName.pagination).toMatchObject({ page: 1, limit: 1, total: 1, pages: 1 });
        expect(byLiteralName.users[0]._id.toString()).toBe(matching._id.toString());

        const byId = await adminUsersService.listUsers({ search: matching._id.toString(), status: 'ACTIVE' });
        expect(byId.pagination.total).toBe(1);
        expect(byId.users[0]._id.toString()).toBe(matching._id.toString());
    });

    it('filters products before counting and pagination without exposing inactive or deleted products to storefront callers', async () => {
        const visible = await createProduct({ name: 'Game+Pack', category: 'games', isActive: true });
        await createProduct({ name: 'Game+Pack inactive', category: 'games', isActive: false });
        const deleted = await createProduct({ name: 'Game+Pack deleted', category: 'games', isActive: true });
        await Product.findByIdAndUpdate(deleted._id, { deletedAt: new Date() });

        const result = await productService.listProducts({ activeOnly: true, search: 'Game+Pack', category: 'games', page: 1, limit: 1 });
        expect(result.pagination).toMatchObject({ page: 1, limit: 1, total: 1, pages: 1 });
        expect(result.products[0]._id.toString()).toBe(visible._id.toString());
    });

    it('keeps customer ownership outside every search branch and treats special characters literally', async () => {
        const group = await createGroup();
        const owner = await createCustomer({ groupId: group._id, name: 'Owner' });
        const otherUser = await createCustomer({ groupId: group._id, name: 'Other' });
        const product = await createProduct({ name: 'Top-up [VIP]' });
        const ownOrder = await createListedOrder({ user: owner, product, orderNumber: 41001, playerId: 'id+[safe]' });
        await createListedOrder({ user: otherUser, product, orderNumber: 41002, playerId: 'id+[safe]' });

        const result = await listOrdersForUser(owner._id, {
            search: 'id+[safe]',
            from: '2026-10-01',
            to: '2026-10-01',
            page: 1,
            limit: 20,
        });
        expect(result.pagination.total).toBe(0);

        await Order.collection.updateOne(
            { _id: ownOrder._id },
            { $set: { createdAt: new Date('2026-10-01T20:00:00.000Z') } }
        );
        const onEndDate = await listOrdersForUser(owner._id, {
            search: 'id+[safe]',
            from: '2026-10-01',
            to: '2026-10-01',
            page: 1,
            limit: 20,
        });
        expect(onEndDate.pagination.total).toBe(1);
        expect(onEndDate.orders[0]._id.toString()).toBe(ownOrder._id.toString());
    });

    it('combines admin status, provider, execution type, related-customer search, and pagination in one count filter', async () => {
        const group = await createGroup();
        const matchingCustomer = await createCustomer({ groupId: group._id, name: 'Search Customer' });
        const otherCustomer = await createCustomer({ groupId: group._id, name: 'Other Customer' });
        const product = await createProduct({ name: 'Provider product' });
        const matching = await createListedOrder({
            user: matchingCustomer,
            product,
            orderNumber: 42001,
            status: ORDER_STATUS.PROCESSING,
            executionType: 'automatic',
            providerCode: 'royal-crown',
        });
        await createListedOrder({
            user: otherCustomer,
            product,
            orderNumber: 42002,
            status: ORDER_STATUS.PROCESSING,
            executionType: 'manual',
            providerCode: 'royal-crown',
        });

        const result = await adminOrdersService.listOrders({
            status: 'processing',
            providerCode: 'royal-crown',
            type: 'auto',
            search: 'Search Customer',
            page: 1,
            limit: 1,
        });
        expect(result.pagination).toMatchObject({ page: 1, limit: 1, total: 1, pages: 1 });
        expect(result.orders[0]._id.toString()).toBe(matching._id.toString());
    });
});
