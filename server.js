const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');

const app = express();

app.use(cors());
app.use(express.json({ limit: '100kb' }));
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

const STARTING_BALANCE = 0;

const STAKE_OPTIONS = [5, 10, 20, 30, 40, 50, 80, 100, 200];

const MAX_NUMBERS = 8;

const SPIN_PAYOUT_MULTIPLIER = 36;

const ROUND_LENGTH = 50;
const BET_LENGTH = 40;

const MAX_ROUND_LIABILITY =
  Number(process.env.MAX_ROUND_LIABILITY || 50000);

const ONLINE_WINDOW_MS = 30 * 1000;

const ACTIVITY_LOG_MAX = 200;

/* =========================================================
   ROULETTE
========================================================= */

const WHEEL_ORDER = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27,
  13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1,
  20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26
];

const RED_NUMBERS = new Set([
  1, 3, 5, 7, 9, 12, 14, 16, 18,
  19, 21, 23, 25, 27, 30, 32, 34, 36
]);

function colorFor(number) {
  number = Number(number);

  if (number === 0) {
    return 'green';
  }

  return RED_NUMBERS.has(number)
    ? 'red'
    : 'black';
}

const EVEN_MONEY_MULTIPLIER = 2;
const DOZEN_MULTIPLIER = 3;

const ALL_NUMBERS =
  Array.from({ length: 37 }, (_, i) => i);

/* =========================================================
   DATABASE
========================================================= */

if (!DATABASE_URL) {
  console.warn('WARNING: DATABASE_URL is not set.');
  console.warn('Server will use in-memory storage.');
}

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: {
        rejectUnauthorized: false
      }
    })
  : null;

const memBalances = {};

const memOrders = {
  nextId: 1,
  orders: {}
};

const memTickets = {};

const memRounds = {};

/* =========================================================
   DATABASE INITIALIZATION
========================================================= */

async function initDb() {
  if (!pool) {
    return;
  }

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
    CREATE TABLE IF NOT EXISTS tickets (
      ticket_id TEXT PRIMARY KEY,
      round_id BIGINT NOT NULL,
      user_id TEXT NOT NULL,
      bet_type TEXT NOT NULL,
      numbers JSONB NOT NULL DEFAULT '[]',
      stake NUMERIC NOT NULL,
      per_number_stake NUMERIC NOT NULL,
      settled BOOLEAN NOT NULL DEFAULT false,
      won BOOLEAN,
      payout NUMERIC NOT NULL DEFAULT 0,
      winning_number INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      settled_at TIMESTAMPTZ
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rounds (
      round_id BIGINT PRIMARY KEY,
      winning_number INTEGER NOT NULL,
      winning_color TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  console.log('Database tables ready');
}

/* =========================================================
   BALANCE
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
    `
    SELECT balance
    FROM balances
    WHERE user_id = $1
    `,
    [userId]
  );

  if (result.rows.length === 0) {
    await pool.query(
      `
      INSERT INTO balances
        (user_id, balance)
      VALUES
        ($1, $2)
      ON CONFLICT (user_id) DO NOTHING
      `,
      [
        userId,
        STARTING_BALANCE
      ]
    );

    const again = await pool.query(
      `
      SELECT balance
      FROM balances
      WHERE user_id = $1
      `,
      [userId]
    );

    return again.rows.length
      ? Number(again.rows[0].balance)
      : STARTING_BALANCE;
  }

  return Number(result.rows[0].balance);
}

async function changeBalance(userId, delta) {
  userId = String(userId);
  delta = Number(delta);

  if (!Number.isFinite(delta)) {
    throw new Error('Invalid balance change');
  }

  if (!pool) {
    const current = await getBalance(userId);
    const next = current + delta;

    if (next < 0) {
      throw new Error('Balance cannot become negative');
    }

    memBalances[userId] = next;

    return Number(next);
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
    [
      userId,
      delta
    ]
  );

  if (result.rows.length === 0) {
    throw new Error('Balance update rejected');
  }

  return Number(result.rows[0].balance);
}

async function deductIfSufficient(userId, amount) {
  userId = String(userId);
  amount = Number(amount);

  if (
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
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
      balance: Number(memBalances[userId])
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
    [
      userId,
      amount
    ]
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
   ORDERS
========================================================= */

async function createOrder(type, userId, amount, extra) {
  extra = extra || {};

  userId = String(userId);
  amount = Number(amount);

  if (
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    throw new Error('Invalid order amount');
  }

  if (!pool) {
    const orderId = String(memOrders.nextId++);

    memOrders.orders[orderId] = {
      orderId,
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
      (
        type,
        user_id,
        amount,
        phone
      )
    VALUES
      ($1, $2, $3, $4)
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
    `
    SELECT *
    FROM orders
    WHERE order_id = $1
    `,
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
    phone: row.phone,
    confirmedBy: row.confirmed_by,
    rejectedBy: row.rejected_by
  };
}

async function markOrder(orderId, status, adminId) {
  orderId = String(orderId);
  adminId = String(adminId || 'admin');

  if (!pool) {
    const order = memOrders.orders[orderId];

    if (!order) {
      return false;
    }

    if (order.status !== 'pending') {
      return false;
    }

    order.status = status;

    if (status === 'confirmed') {
      order.confirmedBy = adminId;
    } else {
      order.rejectedBy = adminId;
    }

    return true;
  }

  const col =
    status === 'confirmed'
      ? 'confirmed_by'
      : 'rejected_by';

  const result = await pool.query(
    `
    UPDATE orders
    SET
      status = $2,
      ${col} = $3
    WHERE order_id = $1
      AND status = 'pending'
    `,
    [
      orderId,
      status,
      adminId
    ]
  );

  return result.rowCount === 1;
}

/* =========================================================
   ADMIN BALANCE REPORT
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
    SELECT
      user_id,
      balance
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

      if (order.status !== 'confirmed') {
        return;
      }

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
  
