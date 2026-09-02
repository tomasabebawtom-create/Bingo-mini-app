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
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

/* =========================================================
   GAME CONFIG
   MUST MATCH FRONTEND
   ========================================================= */

const STARTING_BALANCE = 0;

const STAKE_OPTIONS = [5, 10, 20, 30, 40, 50];

const MAX_NUMBERS = 3;

const BET_LENGTH = 40;
const SPIN_LENGTH = 10;
const ROUND_LENGTH = BET_LENGTH + SPIN_LENGTH;

const HISTORY_MAX = 10;

const SPIN_PAYOUT_MULTIPLIER = 36;
const EVEN_MONEY_MULTIPLIER = 2;
const DOZEN_MULTIPLIER = 3;

/* =========================================================
   WHEEL
   MUST MATCH FRONTEND EXACTLY
   ========================================================= */

const WHEEL_ORDER = [
    0, 32, 15, 19, 4, 21, 2, 25, 17, 34,
    6, 27, 13, 36, 11, 30, 8, 23, 10, 5,
    24, 16, 33, 1, 20, 14, 31, 9, 22, 18,
    29, 7, 28, 12, 35, 3, 26
];

const RED_NUMBERS = new Set([
    1, 3, 5, 7, 9,
    12, 14, 16, 18, 19,
    21, 23, 25, 27, 30,
    32, 34, 36
]);

function colorFor(number) {
    if (number === 0) return 'green';
    return RED_NUMBERS.has(number) ? 'red' : 'black';
}

/* =========================================================
   DATABASE
   ========================================================= */

if (!DATABASE_URL) {
    console.warn('WARNING: DATABASE_URL is not set. Using memory storage.');
}

const pool = DATABASE_URL
    ? new Pool({
        connectionString: DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    })
    : null;

/* =========================================================
   MEMORY FALLBACK
   ========================================================= */

const memBalances = {};

const memOrders = {
    nextId: 1,
    orders: {}
};

const memTickets = {};

const memResolvedRounds = {};

/* =========================================================
   POSTGRES INITIALIZATION
   ========================================================= */

async function initDb() {
    if (!pool) return;

    await pool.query(`
        CREATE TABLE IF NOT EXISTS balances (
            user_id TEXT PRIMARY KEY,
            balance NUMERIC NOT NULL DEFAULT 0
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS orders (
            order_id SERIAL PRIMARY KEY,
            type TEXT NOT NULL,
            user_id TEXT NOT NULL,
            amount NUMERIC NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            phone TEXT,
            confirmed_by TEXT,
            rejected_by TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS game_rounds (
            round_id BIGINT PRIMARY KEY,
            winning_number INTEGER NOT NULL,
            winning_color TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS tickets (
            ticket_id TEXT PRIMARY KEY,
            round_id BIGINT NOT NULL,
            user_id TEXT NOT NULL,
            bet_type TEXT NOT NULL,
            numbers INTEGER[] NOT NULL DEFAULT '{}',
            stake NUMERIC NOT NULL,
            per_number_stake NUMERIC NOT NULL,
            settled BOOLEAN NOT NULL DEFAULT FALSE,
            won BOOLEAN NOT NULL DEFAULT FALSE,
            paid_amount NUMERIC NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_tickets_round
        ON tickets(round_id)
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_tickets_user
        ON tickets(user_id)
    `);

    console.log('Database tables ready');
}

/* =========================================================
   BALANCE FUNCTIONS
   ========================================================= */

async function getBalance(userId) {
    userId = String(userId);

    if (!pool) {
        if (!(userId in memBalances)) {
            memBalances[userId] = STARTING_BALANCE;
        }

        return Number(memBalances[userId]);
    }

    const result = await pool.query(
        'SELECT balance FROM balances WHERE user_id = $1',
        [userId]
    );

    if (result.rows.length === 0) {
        await pool.query(
            `
            INSERT INTO balances (user_id, balance)
            VALUES ($1, $2)
            ON CONFLICT (user_id) DO NOTHING
            `,
            [userId, STARTING_BALANCE]
        );

        return STARTING_BALANCE;
    }

    return Number(result.rows[0].balance);
}

async function changeBalance(userId, delta) {
    userId = String(userId);
    delta = Number(delta);

    if (!Number.isFinite(delta)) {
        throw new Error('Invalid balance delta');
    }

    if (!pool) {
        const current = await getBalance(userId);
        const next = current + delta;

        if (next < 0) {
            throw new Error('Negative balance is not allowed');
        }

        memBalances[userId] = next;

        return next;
    }

    await getBalance(userId);

    const result = await pool.query(
        `
        UPDATE balances
        SET balance = balance + $2
        WHERE user_id = $1
          AND balance + $2 >= 0
        RETURNING balance
        `,
        [userId, delta]
    );

    if (result.rows.length === 0) {
        throw new Error('Balance update failed');
    }

    return Number(result.rows[0].balance);
}

async function deductIfSufficient(userId, amount) {
    userId = String(userId);
    amount = Number(amount);

    if (!Number.isFinite(amount) || amount <= 0) {
        return {
            ok: false,
            balance: await getBalance(userId)
        };
    }

    if (!pool) {
        const current = await getBalance(userId);

        if (current < amount) {
            return {
                ok: false,
                balance: current
            };
        }

        memBalances[userId] = current - amount;

        return {
            ok: true,
            balance: memBalances[userId]
        };
    }

    await getBalance(userId);

    const result = await pool.query(
        `
        UPDATE balances
        SET balance = balance - $2
        WHERE user_id = $1
          AND balance >= $2
        RETURNING balance
        `,
        [userId, amount]
    );

    if (result.rows.length === 0) {
        const current = await getBalance(userId);

        return {
            ok: false,
            balance: current
        };
    }

    return {
        ok: true,
        balance: Number(result.rows[0].balance)
    };
}

/* =========================================================
   ORDER FUNCTIONS
   ========================================================= */

async function createOrder(type, userId, amount, extra) {
    extra = extra || {};

    userId = String(userId);
    amount = Number(amount);

    if (!pool) {
        const orderId = String(memOrders.nextId++);

        memOrders.orders[orderId] = {
            type,
            userId,
            amount,
            status: 'pending',
            createdAt: new Date().toISOString(),
            phone: extra.phone || null
        };

        return orderId;
    }

    const result = await pool.query(
        `
        INSERT INTO orders
        (type, user_id, amount, phone)
        VALUES ($1, $2, $3, $4)
        RETURNING order_id
        `,
        [
            type,
            userId,
            amount,
            extra.phone || null
        ]
    );

    return String(result.rows[0].order_id);
}

async function getOrder(orderId) {
    orderId = String(orderId);

    if (!pool) {
        return memOrders.orders[orderId] || null;
    }

    const result = await pool.query(
        'SELECT * FROM orders WHERE order_id = $1',
        [orderId]
    );

    if (result.rows.length === 0) {
        return null;
    }

    const row = result.rows[0];

    return {
        orderId: String(row.order_id),
        type: row.type,
        userId: row.user_id,
        amount: Number(row.amount),
        status: row.status,
        phone: row.phone
    };
}

async function markOrder(orderId, status, adminId) {
    orderId = String(orderId);

    if (!pool) {
        const order = memOrders.orders[orderId];

        if (!order) return;

        order.status = status;

        if (status === 'confirmed') {
            order.confirmedBy = adminId;
        } else if (status === 'rejected') {
            order.rejectedBy = adminId;
        }

        return;
    }

    const column =
        status === 'confirmed'
            ? 'confirmed_by'
            : 'rejected_by';

    const sql = `
        UPDATE orders
        SET status = $2,
            ${column} = $3
        WHERE order_id = $1
    `;

    await pool.query(sql, [
        orderId,
        status,
        adminId
    ]);
}

/* =========================================================
   ADMIN STATS
   ========================================================= */

async function getAllBalances() {
    if (!pool) {
        return Object.keys(memBalances).map(function (userId) {
            return {
                userId,
                balance: Number(memBalances[userId])
            };
        });
    }

    const result = await pool.query(
        `
        SELECT user_id, balance
        FROM balances
        ORDER BY user_id
        `
    );

    return result.rows.map(function (row) {
        return {
            userId: row.user_id,
            balance: Number(row.balance)
        };
    });
}

async function getConfirmedTotals() {
    if (!pool) {
        let totalDeposits = 0;
        let totalWithdrawals = 0;

        Object.keys(memOrders.orders).forEach(function (orderId) {
            const order = memOrders.orders[orderId];

            if (order.status !== 'confirmed') return;

            if (order.type === 'deposit') {
                totalDeposits += Number(order.amount);
            }

            if (order.type === 'withdraw') {
                totalWithdrawals += Number(order.amount);
            }
        });

        return {
            totalDeposits,
            totalWithdrawals
        };
    }

    const depResult = await pool.query(`
        SELECT COALESCE(SUM(amount), 0) AS total
        FROM orders
        WHERE type = 'deposit'
          AND status = 'confirmed'
    `);

    const wdResult = await pool.query(`
        SELECT COALESCE(SUM(amount), 0) AS total
        FROM orders
        WHERE type = 'withdraw'
          AND status = 'confirmed'
    `);

    return {
        totalDeposits: Number(depResult.rows[0].total),
        totalWithdrawals: Number(wdResult.rows[0].total)
    };
}

/* =========================================================
   ADMIN AUTH
   ========================================================= */

function requireAdmin(req, res, next) {
    if (!ADMIN_SECRET) {
        return res.status(503).json({
            error: 'admin access not configured'
        });
    }

    const provided =
        req.get('x-admin-secret') ||
        req.query.secret ||
        '';

    if (provided !== ADMIN_SECRET) {
        return res.status(401).json({
            error: 'unauthorized'
        });
    }

    next();
}

/* =========================================================
   TELEGRAM INIT DATA
   ========================================================= */

function sortEntries(entries) {
    entries.sort(function (a, b) {
        if (a[0] < b[0]) return -1;
        if (a[0] > b[0]) return 1;
        return 0;
    });

    return entries;
}

function parseUnsafe(initData) {
    try {
        const params = new URLSearchParams(initData);

        const userJson = params.get('user');

        if (!userJson) {
            return null;
        }

        const user = JSON.parse(userJson);

        return {
            id: String(user.id),
            first_name: user.first_name || ''
        };
    } catch (e) {
        return null;
    }
}

function validateInitData(initData) {
    if (!BOT_TOKEN) {
        return parseUnsafe(initData);
    }

    try {
        const params = new URLSearchParams(initData);

        const hash = params.get('hash');

        if (!hash) {
            return null;
        }

        params.delete('hash');

        const entries = sortEntries(
            Array.from(params.entries())
        );

        const parts = [];

        for (let i = 0; i < entries.length; i++) {
            parts.push(
                entries[i][0] +
                '=' +
                entries[i][1]
            );
        }

        const dataCheckString =
            parts.join('\n');

        const secretKey =
            crypto
                .createHmac(
                    'sha256',
                    'WebAppData'
                )
                .update(BOT_TOKEN)
                .digest();

        const computedHash =
            crypto
                .createHmac(
                    'sha256',
                    secretKey
                )
                .update(dataCheckString)
                .digest('hex');

        if (computedHash !== hash) {
            return null;
        }

        const userJson = params.get('user');

        if (!userJson) {
            return null;
        }

        const user = JSON.parse(userJson);

        return {
            id: String(user.id),
            first_name: user.first_name || ''
        };

    } catch (e) {
        return null;
    }
}

/* =========================================================
   ONLINE USERS / ACTIVITY
   ========================================================= */

const ONLINE_WINDOW_MS = 30 * 1000;

const lastSeen = {};

const ACTIVITY_LOG_MAX = 200;

const activityLog = [];

function
