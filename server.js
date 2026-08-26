// ==================================================================
// Spin and Win — Backend Server
// ==================================================================
// Express API that serves /api/balance and /api/spin-win for the
// Telegram Mini App (index.html), plus /api/deposit and /api/withdraw
// routes used by bot.py. Validates Telegram initData using the bot
// token (set as BOT_TOKEN environment variable — never put the real
// token directly in this file). Balances and orders are stored in
// local JSON files so they survive server restarts.
// ==================================================================

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // serves index.html if it lives alongside this file

// -------------------- Config --------------------
const PORT = process.env.PORT || 3000; // matches bot.py's SERVER_URL = http://localhost:3000/api
const BOT_TOKEN = process.env.BOT_TOKEN || ''; // set this before starting the server
const STARTING_BALANCE = 0; // new players start at 0 — balance only grows via admin-approved deposit or a spin win
const SPIN_COST = 10;
const SPIN_PAYOUT_MULTIPLIER = 36; // straight-up roulette payout (35:1 winnings + stake back = 36x)
const BALANCES_FILE = path.join(__dirname, 'balances.json');
const ORDERS_FILE = path.join(__dirname, 'orders.json');

const WHEEL_ORDER = [
    0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10,
    5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26
];
const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
function colorFor(n) {
    if (n === 0) return 'green';
    return RED_NUMBERS.has(n) ? 'red' : 'black';
}
// Payout multiplier per bet type (applied to SPIN_COST; straight number keeps the old 36x)
const EVEN_MONEY_MULTIPLIER = 2; // red/black/odd/even/low/high pay 1:1 (get stake back + 1x)
const DOZEN_MULTIPLIER = 3;      // dozens pay 2:1 (get stake back + 2x)
const COLUMN_MULTIPLIER = 3;     // columns pay 2:1 (get stake back + 2x)

// Column membership (standard roulette layout, top-to-bottom columns)
const COLUMN_1 = new Set([1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34]);
const COLUMN_2 = new Set([2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35]);
const COLUMN_3 = new Set([3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36]);

// -------------------- Balance persistence --------------------
function loadBalances() {
    try {
        const raw = fs.readFileSync(BALANCES_FILE, 'utf8');
        return JSON.parse(raw);
    } catch (e) {
        return {};
    }
}

function saveBalances(balances) {
    fs.writeFileSync(BALANCES_FILE, JSON.stringify(balances, null, 2));
}

let balances = loadBalances();

function getBalance(userId) {
    if (!(userId in balances)) {
        balances[userId] = STARTING_BALANCE;
        saveBalances(balances);
    }
    return balances[userId];
}

function changeBalance(userId, delta) {
    const current = getBalance(userId);
    balances[userId] = current + delta;
    saveBalances(balances);
    return balances[userId];
}

// -------------------- Orders persistence (deposit/withdraw) --------------------
function loadOrders() {
    try {
        const raw = fs.readFileSync(ORDERS_FILE, 'utf8');
        return JSON.parse(raw);
    } catch (e) {
        return { nextId: 1, orders: {} };
    }
}

function saveOrders(data) {
    fs.writeFileSync(ORDERS_FILE, JSON.stringify(data, null, 2));
}

let ordersData = loadOrders();

function createOrder(type, userId, amount) {
    const orderId = String(ordersData.nextId++);
    ordersData.orders[orderId] = {
        type,
        userId,
        amount,
        status: 'pending',
        createdAt: new Date().toISOString(),
    };
    saveOrders(ordersData);
    return orderId;
}

// -------------------- Telegram initData validation --------------------
// See: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
function validateInitData(initData) {
    if (!BOT_TOKEN) {
        // No token configured — allow through but log a warning.
        // (Only safe for local testing; always set BOT_TOKEN in production.)
        console.warn('⚠️  BOT_TOKEN not set — skipping initData validation!');
        return parseUnsafe(initData);
    }

    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        params.delete('hash');

        const dataCheckArr = [];
        for (const [key, value] of [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
            dataCheckArr.push(`${key}=${value}`);
        }
        const dataCheckString = dataCheckArr.join('\n');

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

// -------------------- Routes --------------------
app.get('/', (req, res) => {
    res.send('Spin and Win API server is running');
});

// --- Mini app: balance via initData ---
app.get('/api/balance', (req, res) => {
    const initData = req.query.initData || '';
    const user = validateInitData(initData);
    if (!user) return res.status(401).json({ error: 'ልክ ያልሆነ initData' });

    res.json({ balance: getBalance(user.id) });
});

// --- Bot: balance by userId (used by check_balance in bot.py) ---
app.get('/api/balance/:userId', (req, res) => {
    res.json({ balance: getBalance(String(req.params.userId)) });
});

// --- Mini app: spin ---
// betType: 'number' | 'red' | 'black' | 'odd' | 'even'
// betValue: only required when betType === 'number' (0-36)
app.post('/api/spin-win', (req, res) => {
    const { initData, betType, betValue, number } = req.body;
    const user = validateInitData(initData);
    if (!user) return res.status(401).json({ error: 'ልክ ያልሆነ initData' });

    // Back-compat: old clients sent {number} only, meaning a straight-up number bet.
    const type = betType || (typeof number === 'number' ? 'number' : null);
    const value = betType === 'number' ? betValue : number;

    const VALID_TYPES = [
        'number', 'red', 'black', 'odd', 'even',
        'dozen1', 'dozen2', 'dozen3',
        'low', 'high',
        'col1', 'col2', 'col3',
    ];
    if (!VALID_TYPES.includes(type)) {
        return res.status(400).json({ error: 'ልክ ያልሆነ የውርርድ አይነት' });
    }
    if (type === 'number' && (typeof value !== 'number' || value < 0 || value > 36)) {
        return res.status(400).json({ error: 'ልክ ያልሆነ ቁጥር' });
    }

    const balance = getBalance(user.id);
    if (balance < SPIN_COST) {
        return res.status(400).json({ error: 'በቂ ሂሳብ የለዎትም' });
    }

    // Deduct the spin cost first
    changeBalance(user.id, -SPIN_COST);

    // Spin the wheel — decided here on the server, never trusted from the client
    const winningNumber = WHEEL_ORDER[Math.floor(Math.random() * WHEEL_ORDER.length)];
    const winningColor = colorFor(winningNumber);

    let won = false;
    let multiplier = 0;
    if (type === 'number') {
        won = value === winningNumber;
        multiplier = SPIN_PAYOUT_MULTIPLIER; // 36x (35:1 + stake back)
    } else if (type === 'red' || type === 'black') {
        won = winningColor === type;
        multiplier = EVEN_MONEY_MULTIPLIER;
    } else if (type === 'odd') {
        won = winningNumber !== 0 && winningNumber % 2 === 1;
        multiplier = EVEN_MONEY_MULTIPLIER;
    } else if (type === 'even') {
        won = winningNumber !== 0 && winningNumber % 2 === 0;
        multiplier = EVEN_MONEY_MULTIPLIER;
    } else if (type === 'low') {
        won = winningNumber >= 1 && winningNumber <= 18;
        multiplier = EVEN_MONEY_MULTIPLIER;
    } else if (type === 'high') {
        won = winningNumber >= 19 && winningNumber <= 36;
        multiplier = EVEN_MONEY_MULTIPLIER;
    } else if (type === 'dozen1') {
        won = winningNumber >= 1 && winningNumber <= 12;
        multiplier = DOZEN_MULTIPLIER;
    } else if (type === 'dozen2') {
        won = winningNumber >= 13 && winningNumber <= 24;
        multiplier = DOZEN_MULTIPLIER;
    } else if (type === 'dozen3') {
        won = winningNumber >= 25 && winningNumber <= 36;
        multiplier = DOZEN_MULTIPLIER;
    } else if (type === 'col1') {
        won = COLUMN_1.has(winningNumber);
        multiplier = COLUMN_MULTIPLIER;
    } else if (type === 'col2') {
        won = COLUMN_2.has(winningNumber);
        multiplier = COLUMN_MULTIPLIER;
    } else if (type === 'col3') {
        won = COLUMN_3.has(winningNumber);
        multiplier = COLUMN_MULTIPLIER;
    }

    const amount = won ? SPIN_COST * multiplier : 0;
    if (won) {
        changeBalance(user.id, amount);
    }

    res.json({
        winning_number: winningNumber,
        winning_color: winningColor,
        won,
        amount,
        balance: getBalance(user.id),
    });
});

// --- Bot: deposit request (creates a pending order, does NOT change balance) ---
app.post('/api/deposit/request', (req, res) => {
    const { userId, amount } = req.body;
    if (!userId || typeof amount !== 'number' || amount <= 0) {
        return res.status(400).json({ error: 'Invalid request' });
    }
    const orderId = createOrder('deposit', String(userId), amount);
    res.json({ orderId });
});

// --- Bot: admin confirms deposit (the ONLY place a deposit increases balance) ---
app.post('/api/deposit/confirm', (req, res) => {
    const { orderId, adminId } = req.body;
    const order = ordersData.orders[orderId];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'pending') return res.status(409).json({ error: 'Already handled' });

    order.status = 'confirmed';
    order.confirmedBy = adminId;
    saveOrders(ordersData);

    const newBalance = changeBalance(order.userId, order.amount);
    res.json({ userId: order.userId, balance: newBalance });
});

// --- Bot: admin rejects deposit (no balance change) ---
app.post('/api/deposit/reject', (req, res) => {
    const { orderId, adminId } = req.body;
    const order = ordersData.orders[orderId];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'pending') return res.status(409).json({ error: 'Already handled' });

    order.status = 'rejected';
    order.rejectedBy = adminId;
    saveOrders(ordersData);

    res.json({ userId: order.userId });
});

// --- Bot: withdraw request (deducts immediately, registers a pending payout) ---
app.post('/api/withdraw/request', (req, res) => {
    const { userId, amount } = req.body;
    if (!userId || typeof amount !== 'number' || amount <= 0) {
        return res.status(400).json({ error: 'Invalid request' });
    }
    const currentBalance = getBalance(String(userId));
    if (currentBalance < amount) {
        return res.status(400).json({ error: 'በቂ ቀሪ ሂሳብ የለዎትም' });
    }
    changeBalance(String(userId), -amount);
    const orderId = createOrder('withdraw', String(userId), amount);
    res.json({ orderId, balance: getBalance(String(userId)) });
});

app.listen(PORT, () => {
    console.log(`Spin and Win API server listening on port ${PORT}`);
});

// --- Bot: admin confirms withdraw (money already sent via Telebirr) ---
app.post('/api/withdraw/confirm', (req, res) => {
    const { orderId, adminId } = req.body;
    const order = ordersData.orders[orderId];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'pending') return res.status(409).json({ error: 'Already handled' });

    order.status = 'confirmed';
    order.confirmedBy = adminId;
    saveOrders(ordersData);

    res.json({ userId: order.userId, balance: getBalance(String(order.userId)) });
});

// --- Bot: admin rejects withdraw (refund the deducted balance) ---
app.post('/api/withdraw/reject', (req, res) => {
    const { orderId, adminId } = req.body;
    const order = ordersData.orders[orderId];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'pending') return res.status(409).json({ error: 'Already handled' });

    changeBalance(String(order.userId), order.amount);
    order.status = 'rejected';
    order.rejectedBy = adminId;
    saveOrders(ordersData);

    res.json({ userId: order.userId, balance: getBalance(String(order.userId)) });
});
