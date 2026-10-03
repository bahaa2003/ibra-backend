'use strict';

const http = require('http');
const jwt = require('jsonwebtoken');
const app = require('../app');
const config = require('../config/config');
const { Order } = require('../modules/orders/order.model');
const {
    connectTestDB,
    disconnectTestDB,
    clearCollections,
    createAdmin,
    createCustomer,
    createGroup,
    createProduct,
} = require('./testHelpers');

let server;
let baseUrl;

const request = (path, { method = 'GET', token, body } = {}) => new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(url, {
        method,
        headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
    }, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
});

const tokenFor = (user) => jwt.sign({ id: user._id, role: user.role }, config.jwt.secret, { expiresIn: '10m' });

beforeAll(async () => {
    await connectTestDB();
    await new Promise((resolve) => {
        server = app.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            baseUrl = `http://127.0.0.1:${port}`;
            resolve();
        });
    });
});

afterAll(async () => {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await disconnectTestDB();
});

beforeEach(async () => { await clearCollections(); });

describe('public product catalogue visibility', () => {
    it('returns active matching guest products with server-side category, search, and pagination filters', async () => {
        const first = await createProduct({ name: 'Guest Game Pack A', category: 'games', displayOrder: 1 });
        await createProduct({ name: 'Guest Game Pack B', category: 'games', displayOrder: 2 });
        await createProduct({ name: 'Guest Card Pack', category: 'cards', displayOrder: 3 });
        await createProduct({ name: 'Guest Game Inactive', category: 'games', isActive: false });

        const response = await request('/api/products?page=1&limit=1&search=Guest%20Game&category=games');

        expect(response.status).toBe(200);
        expect(response.body.pagination).toMatchObject({ page: 1, limit: 1, total: 2, pages: 2 });
        expect(response.body.data).toHaveLength(1);
        expect(response.body.data[0]._id).toBe(first._id.toString());
    });

    it('allowlists guest product data and never returns pricing or provider internals', async () => {
        await createProduct({
            name: 'Private Pricing Product',
            category: 'games',
            basePrice: '100',
            providerPrice: '50',
            finalPrice: '125',
            markupType: 'percentage',
            markupValue: 25,
            pricingMode: 'sync',
            manualPriceAdjustment: '5',
        });

        const response = await request('/api/products');

        expect(response.status).toBe(200);
        expect(response.body.data[0]).toEqual(expect.objectContaining({
            name: 'Private Pricing Product',
            category: 'games',
        }));
        expect(Object.keys(response.body.data[0]).sort()).toEqual([
            '_id', 'category', 'description', 'displayOrder', 'image', 'isActive', 'name',
        ]);
    });

    it('keeps customer-specific price calculation for complete and incomplete customers while allowing both to browse', async () => {
        const group = await createGroup({ percentage: 10 });
        const completeCustomer = await createCustomer({ groupId: group._id, phone: '01012345678' });
        const incompleteCustomer = await createCustomer({ groupId: group._id, phone: null });
        await createProduct({ name: 'Customer Price Product', basePrice: '100', category: 'games' });

        const completeResponse = await request('/api/products', { token: tokenFor(completeCustomer) });
        const incompleteResponse = await request('/api/products', { token: tokenFor(incompleteCustomer) });

        expect(completeResponse.status).toBe(200);
        expect(completeResponse.body.data[0].finalPrice).toBe('110');
        expect(incompleteResponse.status).toBe(200);
        expect(incompleteResponse.body.data[0].finalPrice).toBe('110');
    });

    it('continues to block an incomplete customer from placing an order', async () => {
        const group = await createGroup({ percentage: 0 });
        const customer = await createCustomer({ groupId: group._id, phone: null });
        const product = await createProduct({ name: 'Completion-Protected Product', basePrice: '10' });

        const response = await request('/api/orders', {
            method: 'POST',
            token: tokenFor(customer),
            body: { productId: product._id.toString(), quantity: 1 },
        });

        expect(response.status).toBe(422);
        expect(response.body.code).toBe('PROFILE_COMPLETION_REQUIRED');
        expect(await Order.countDocuments()).toBe(0);
    });

    it('keeps the admin list behavior, including inactive products, unchanged', async () => {
        const admin = await createAdmin();
        await createProduct({ name: 'Active Admin Product', basePrice: '100', isActive: true });
        await createProduct({ name: 'Inactive Admin Product', basePrice: '200', isActive: false });

        const response = await request('/api/products?limit=20', { token: tokenFor(admin) });

        expect(response.status).toBe(200);
        expect(response.body.pagination.total).toBe(2);
        expect(response.body.data.map((product) => product.name)).toEqual(expect.arrayContaining([
            'Active Admin Product',
            'Inactive Admin Product',
        ]));
        expect(response.body.data.find((product) => product.name === 'Inactive Admin Product').basePrice).toBe('200');
    });
});
