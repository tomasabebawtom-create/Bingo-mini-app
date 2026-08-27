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

async function createOrder(type, userId, amount, extra) {
    extra = extra || {};
    if (!pool) {
        const orderId = String(memOrders.nextId++);
        memOrders.orders[orderId] = { type: type, userId: userId, amount: amount, status: 'pending', createdAt: new Date().toISOString(), phone: extra.phone };
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
        return;
    }
    const col = status === 'confirmed' ? 'confirmed_by' : 'rejected_by';
    const sql = 'UPDATE orders SET status = $2, ' + col + ' = $3 WHERE order_id = $1';
    await pool.query(sql, [orderId, status, adminId]);
}

function sortEntries(entries) {
    entries.sort(function (a, b) {
        if (a[0] < b[0]) return -1;
        if (a[0] > b[0]) return 1;
        return 0;
    });
    return entries;
}

function validateInitData(initData) {
    if (!BOT_TOKEN) { return parseUnsafe(initData); }
    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        params.delete('hash');
        const entries = sortEntries(Array.from(params.entries()));
        const parts = [];
        for (let i = 0; i < entries.length; i++) {
            parts.push(entries[i][0] + '=' + entries[i][1]);
        }
        const dataCheckString = parts.join(String.fromCharCode(10));
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
        const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
        if (computedHash !== hash) return null;
        const userJson = params.get('user');
        if (!userJson) return null;
        const user = JSON.parse(userJson);
        return { id: String(user.id), first_name: user.first_name };
    } catch (e) {
        return null;
    }
}

function parseUnsafe(initData) {
    try {
        const params = new URLSearchParams(initData);
        const userJson = params.get('user');
        if (!userJson) return null;
        const user = JSON.parse(userJson);
        return { id: String(user.id), first_name: user.first_name };
    } catch (e) {
        return null;
    }
}

const roundTickets = {};
const resolvedRounds = {};
function currentRoundId() { return Math.floor(Date.now() / 1000 / ROUND_LENGTH); }

app.get('/', function (req, res) {
    res.send('Spin and Win API server is running');
});

app.get('/api/balance', async function (req, res) {
    const initData = req.query.initData || '';
    const user = validateInitData(initData);
    if (!user) return res.status(401).json({ error: 'invalid initData' });
    res.json({ balance: await getBalance(user.id) });
});

app.get('/api/balance/:userId', async function (req, res) {
    res.json({ balance: await getBalance(String(req.params.userId)) });
});

app.post('/api/place-ticket', async function (req, res) {
    const initData = req.body.initData;
    const round = req.body.round;
    const betType = req.body.betType;
    const numbers = req.body.numbers;
    const user = validateInitData(initData);
    if (!user) return res.status(401).json({ error: 'invalid initData' });
    if (round !== currentRoundId()) return res.status(400).json({ error: 'round closed' });
    const VALID_TYPES = ['number', 'red', 'black', 'odd', 'even', 'dozen1', 'dozen2', 'dozen3', 'low', 'high'];
    if (VALID_TYPES.indexOf(betType) === -1) return res.status(400).json({ error: 'invalid bet type' });
    let stake = SPIN_COST;
    if (betType === 'number') {
        if (!Array.isArray(numbers) || numbers.length === 0) return res.status(400).json({ error: 'select a number' });
        for (let i = 0; i < numbers.length; i++) {
            const n = numbers[i];
            if (typeof n !== 'number' || n < 0 || n > 36) return res.status(400).json({ error: 'invalid number' });
        }
        stake = numbers.length * SPIN_COST;
    }
    const balance = await getBalance(user.id);
    if (balance < stake) return res.status(400).json({ error: 'insufficient balance' });
    await changeBalance(user.id, -stake);
    if (!roundTickets[round]) roundTickets[round] = {};
    const ticketId = round + '-' + user.id;
    roundTickets[round][user.id] = { betType: betType, numbers: numbers || [], stake: stake, ticketId: ticketId };
    res.json({ ticket_id: ticketId, balance: await getBalance(user.id) });
});

app.get('/api/round-result', async function (req, res) {
    const initData = req.query.initData || '';
    const round = parseInt(req.query.round, 10);
    const ticketId = req.query.ticket_id;
    const user = validateInitData(initData);
    if (!user) return res.status(401).json({ error: 'invalid initData' });
    if (!resolvedRounds[round]) {
        const winningNumber = WHEEL_ORDER[Math.floor(Math.random() * WHEEL_ORDER.length)];
        resolvedRounds[round] = { winning_number: winningNumber, winning_color: colorFor(winningNumber) };
    }
    const winning_number = resolvedRounds[round].winning_number;
    const winning_color = resolvedRounds[round].winning_color;
    let won = false;
    let amount = 0;
    const ticket = roundTickets[round] && roundTickets[round][user.id];
    if (ticket && ticket.ticketId === ticketId) {
        if (ticket.betType === 'number') {
            if (ticket.numbers.indexOf(winning_number) !== -1) { won = true; amount = SPIN_COST * SPIN_PAYOUT_MULTIPLIER; }
        } else if (ticket.betType === 'red' || ticket.betType === 'black') {
            won = winning_color === ticket.betType;
            amount = won ? ticket.stake * EVEN_MONEY_MULTIPLIER : 0;
        } else if (ticket.betType === 'odd') {
            won = winning_number !== 0 && winning_number % 2 === 1;
            amount = won ? ticket.stake * EVEN_MONEY_MULTIPLIER : 0;
        } else if (ticket.betType === 'even') {
            won = winning_number !== 0 && winning_number % 2 === 0;
            amount = won ? ticket.stake * EVEN_MONEY_MULTIPLIER : 0;
        } else if (ticket.betType === 'low') {
            won = winning_number >= 1 && winning_number <= 18;
            amount = won ? ticket.stake * EVEN_MONEY_MULTIPLIER : 0;
        } else if (ticket.betType === 'high') {
            won = winning_number >= 19 && winning_number <= 36;
            amount = won ? ticket.stake * EVEN_MONEY_MULTIPLIER : 0;
        } else if (ticket.betType === 'dozen1') {
            won = winning_number >= 1 && winning_number <= 12;
            amount = won ? ticket.stake * DOZEN_MULTIPLIER : 0;
        } else if (ticket.betType === 'dozen2') {
            won = winning_number >= 13 && winning_number <= 24;
            amount = won ? ticket.stake * DOZEN_MULTIPLIER : 0;
        } else if (ticket.betType === 'dozen3') {
            won = winning_number >= 25 && winning_number <= 36;
            amount = won ? ticket.stake * DOZEN_MULTIPLIER : 0;
        }
        if (won && amount > 0) { await changeBalance(user.id, amount); }
    }
    res.json({ winning_number: winning_number, winning_color: winning_color, won: won, amount: amount, balance: await getBalance(user.id) });
});

app.post('/api/deposit/request', async function (req, res) {
    const userId = req.body.userId;
    const amount = req.body.amount;
    if (!userId || typeof amount !== 'number' || amount <= 0) return res.status(400).json({ error: 'Invalid request' });
    const orderId = await createOrder('deposit', String(userId), amount);
    res.json({ orderId: orderId });
});

app.post('/api/deposit/confirm', async function (req, res) {
    const orderId = req.body.orderId;
    const adminId = req.body.adminId;
    const order = await getOrder(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'pending') return res.status(409).json({ error: 'Already handled' });
    await markOrder(orderId, 'confirmed', adminId);
    const newBalance = await changeBalance(order.userId, order.amount);
    res.json({ userId: order.userId, balance: newBalance });
});

app.post('/api/deposit/reject', async function (req, res) {
    const orderId = req.body.orderId;
    const adminId = req.body.adminId;
    const order = await getOrder(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'pending') return res.status(409).json({ error: 'Already handled' });
    await markOrder(orderId, 'rejected', adminId);
    res.json({ userId: orderId });
});

app.post('/api/withdraw/request', async function (req, res) {
    const userId = req.body.userId;
    const amount = req.body.amount;
    const phone = req.body.phone;
    if (!userId || typeof amount !== 'number' || amount <= 0) return res.status(400).json({ error: 'Invalid request' });
    if (!phone || typeof phone !== 'string' || !phone.trim()) return res.status(400).json({ error: 'Phone number required' });
    const currentBalance = await getBalance(String(userId));
    if (currentBalance < amount) return res.status(400).json({ error: 'insufficient balance' });
    await changeBalance(String(userId), -amount);
    const orderId = await createOrder('withdraw', String(userId), amount, { phone: phone.trim() });
    res.json({ orderId: orderId, balance: await getBalance(String(userId)) });
});

app.post('/api/withdraw/confirm', async function (req, res) {
    const orderId = req.body.orderId;
    const adminId = req.body.adminId;
    const order = await getOrder(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'pending') return res.status(409).json({ error: 'Already handled' });
    await markOrder(orderId, 'confirmed', adminId);
    res.json({ userId: order.userId, balance: await getBalance(String(order.userId)) });
});

app.post('/api/withdraw/reject', async function (req, res) {
    const orderId = req.body.orderId;
    const adminId = req.body.adminId;
    const order = await getOrder(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'pending') return res.status(409).json({ error: 'Already handled' });
    await changeBalance(String(order.userId), order.amount);
    await markOrder(orderId, 'rejected', adminId);
    res.json({ userId: order.userId, balance: await getBalance(String(order.userId)) });
});

initDb().then(function () {
    app.listen(PORT, function () {
        console.log('Server listening on port ' + PORT);
    });
}).catch(function (err) {
    console.error('Failed to initialize database:', err);
    process.exit(1);
});
