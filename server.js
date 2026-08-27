// ==================================================================
// Spin and Win — Backend Server (PostgreSQL version)
// ==================================================================
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const STARTING_BALANCE = 0;
const SPIN_COST = 10;
const SPIN_PAYOUT_MULTIPLIER = 36;
const ROUND_LENGTH = 30;

const WHEEL_ORDER = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
function colorFor(n) { if (n === 0) return 'green'; return RED_NUMBERS.has(n) ? 'red' : 'black'; }
const EVEN_MONEY_MULTIPLIER = 2;
const DOZEN_MULTIPLIER = 3;
const COLUMN_MULTIPLIER = 3;
const COLUMN_1 = new Set([1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34]);
const COLUMN_2 = new Set([2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35]);
const COLUMN_3 = new Set([3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36]);

if (!DATABASE_URL) { console.warn('DATABASE_URL not set'); }
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } }) : null;
const memBalances = {};
const memOrders = { nextId: 1, orders: {} };

async function initDb() {
    if (!pool) return;
    await pool.query('CREATE TABLE IF NOT EXISTS balances (user_id TEXT PRIMARY KEY, balance NUMERIC NOT NULL DEFAULT 0)');
    await pool.query('CREATE TABLE IF NOT EXISTS orders (order_id SERIAL PRIMARY KEY, type TEXT NOT NULL, user_id TEXT NOT NULL, amount NUMERIC NOT NULL, status TEXT NOT NULL DEFAULT \'pending\', phone TEXT, confirmed_by TEXT, rejected_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    console.log('Database tables ready');
}

async function getBalance(userId) {
    if (!pool) { if (!(userId in memBalances)) memBalances[userId] = STARTING_BALANCE; return memBalances[userId]; }
    const result = await pool.query('SELECT balance FROM balances WHERE user_id = $1', [userId]);
    if (result.rows.length === 0) {
        await pool.query('INSERT INTO balances (user_id, balance) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING', [userId, STARTING_BALANCE]);
        return STARTING_BALANCE;
    }
    return Number(result.rows[0].balance);
}

async function changeBalance(userId, delta) {
    if (!pool) { const current = await getBalance(userId); memBalances[userId] = current + delta; return memBalances[userId]; }
    await getBalance(userId);
    const result = await pool.query('UPDATE balances SET balance = balance + $2 WHERE user_id = $1 RETURNING balance', [userId, delta]);
    return Number(result.rows[0].balance);
}

async function createOrder(type, userId, amount, extra = {}) {
    if (!pool) {
        const orderId = String(memOrders.nextId++);
        memOrders.orders[orderId] = { type, userId, amount, status: 'pending', createdAt: new Date().toISOString(), ...extra };
        return orderId;
    }
    const result = await pool.query('INSERT INTO orders (type, user_id, amount, phone) VALUES ($1, $2, $3, $4) RETURNING order_id', [type, userId, amount, extra.phone || null]);
    return String(result.rows[0].order_id);
}

async function getOrder(orderId) {
    if (!pool) return memOrders.orders[orderId];
    const result = await pool.query('SELECT * FROM orders WHERE order_id = $1', [orderId]);
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return { type: row.type, userId: row.user_id, amount: Number(row.amount), status: row.status, phone: row.phone };
}

async function markOrder(orderId, status, adminId) {
    if (!pool) {
        const order = memOrders.orders[orderId];
        if (!order) return;
        order.status = status;
        if (status === 'confirmed') order.confirmedBy = adminId;
        if (status === 'rejected') order.rejectedBy = adminId;
        return;
    }
    const col = status === 'confirmed' ? 'confirmed_by' : 'rejected_by';
    await pool.query('UPDATE orders SET status = $2, ' + col + ' = $3 WHERE order_id = $1', [orderId, status, adminId]);
}

function validateInitData(initData) {
    if (!BOT_TOKEN) { console.warn('BOT_TOKEN not set'); return parseUnsafe(initData); }
    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        params.delete('hash');
        const entries = [...params.entries()];
        entries.sort(function(a, b) { return a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0); });
        const dataCheckArr = entries.map(function(pair) { return pair[0] + '=' + pair[1]; });
        const dataCheckString = dataCheckArr.join('\n');
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
        const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
        if (computedHash !== hash) return null;
        const userJson = params.get('user');
        if (!userJson) return null;
        const user = JSON.parse(userJson);
        return { id: String(user.id), first_name: user.first_name };
    } catch (e) { return null; }
}

function parseUnsafe(initData) {
    try {
        const params = new URLSearchParams(initData);
        const userJson = params.get('user');
        if (!userJson) return null;
        const user = JSON.parse(userJson);
        return { id: String(user.id), first_name: user.first_name };
    } catch (e) { return null; }
}

const roundTickets = {};
const resolvedRounds = {};
function currentRoundId() { return Math.floor(Date.now() / 1000 / ROUND_LENGTH); }
