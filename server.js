    // ==================================================================
// Spin and Win — Backend Server
// ==================================================================
// Express API that serves /api/balance and /api/spin-win for the
// Telegram Mini App (index.html). Validates Telegram initData using
// the bot token (set as BOT_TOKEN environment variable — never put
// the real token directly in this file). Balances are stored in a
// local JSON file so they survive server restarts.
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
const PORT = process.env.PORT || 8080;
const BOT_TOKEN = process.env.BOT_TOKEN || ''; // set this in Render's Environment settings
const STARTING_BALANCE = 1000;
const SPIN_COST = 10;
const SPIN_PAYOUT_MULTIPLIER = 36; // straight-up roulette payout (35:1 winnings + stake back = 36x)
const BALANCES_FILE = path.join(__dirname, 'balances.json');

const WHEEL_ORDER = [
    0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10,
    5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26
];

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

app.get('/api/balance', (req, res) => {
    const initData = req.query.initData || '';
    const user = validateInitData(initData);
    if (!user) return res.status(401).json({ error: 'ልክ ያልሆነ initData' });

    res.json({ balance: getBalance(user.id) });
});

app.post('/api/spin-win', (req, res) => {
    const { initData, number } = req.body;
    const user = validateInitData(initData);
    if (!user) return res.status(401).json({ error: 'ልክ ያልሆነ initData' });

    if (typeof number !== 'number' || number < 0 || number > 36) {
        return res.status(400).json({ error: 'ልክ ያልሆነ ቁጥር' });
    }

    const balance = getBalance(user.id);
    if (balance < SPIN_COST) {
        return res.status(400).json({ error: 'በቂ ሂሳብ የለዎትም' });
    }

    // Deduct the spin cost first
    changeBalance(user.id, -SPIN_COST);

    // Spin the wheel
    const winningNumber = WHEEL_ORDER[Math.floor(Math.random() * WHEEL_ORDER.length)];
    const won = winningNumber === number;
    const amount = won ? SPIN_COST * SPIN_PAYOUT_MULTIPLIER : 0;

    if (won) {
        changeBalance(user.id, amount);
    }

    res.json({
        winning_number: winningNumber,
        won,
        amount,
        balance: getBalance(user.id),
    });
});

app.listen(PORT, () => {
    console.log(`Spin and Win API server listening on port ${PORT}`);
});
