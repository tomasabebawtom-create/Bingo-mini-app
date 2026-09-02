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

const STAKE_OPTIONS = [5, 10, 20, 30, 40, 50, 80, 100];

const MAX_NUMBERS = 8;

const SPIN_PAYOUT_MULTIPLIER = 36;

const ROUND_LENGTH = 50;

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
  if (number === 0) return 'green';
  return RED_NUMBERS.has(number) ? 'red' : 'black';
}

const EVEN_MONEY_MULTIPLIER = 2;
const DOZEN_MULTIPLIER = 3;

const ALL_NUMBERS = Array.from({ length: 37 }, (_, i) => i);

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
      ssl: { rejectUnauthorized: false }
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
    throw new Error('Invalid balance change');
  }

  if (!pool) {
    const current = await getBalance(userId);
    const next = current + delta;

    if (next < 0) {
      throw new Error('Balance cannot become negative');
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
    throw new Error('Balance update rejected');
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
   ORDERS
========================================================= */

async function createOrder(type, userId, amount, extra) {
  extra = extra || {};

  userId = String(userId);
  amount = Number(amount);

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Invalid order amount');
  }

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
    SET status = $2,
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

  if (!provided) {
    return res.status(401).json({
      error: 'unauthorized'
    });
  }

  const providedBuffer = Buffer.from(String(provided));
  const expectedBuffer = Buffer.from(String(ADMIN_SECRET));

  if (
    providedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return res.status(401).json({
      error: 'unauthorized'
    });
  }

  next();
}

/* =========================================================
   TELEGRAM INIT DATA
========================================================= */

function validateInitData(initData) {
  if (!initData || typeof initData !== 'string') {
    return null;
  }

  if (!BOT_TOKEN) {
    console.warn(
      'WARNING: BOT_TOKEN is not set. Telegram initData cannot be securely verified.'
    );

    return parseUnsafe(initData);
  }

  try {
    const params = new URLSearchParams(initData);

    const hash = params.get('hash');

    if (!hash) {
      return null;
    }

    params.delete('hash');

    const entries = Array.from(params.entries()).sort(
      function (a, b) {
        return a[0].localeCompare(b[0]);
      }
    );

    const dataCheckString = entries
      .map(function (entry) {
        return entry[0] + '=' + entry[1];
      })
      .join('\n');

    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(BOT_TOKEN)
      .digest();

    const computedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    const hashA = Buffer.from(computedHash, 'hex');
    const hashB = Buffer.from(hash, 'hex');

    if (
      hashA.length !== hashB.length ||
      !crypto.timingSafeEqual(hashA, hashB)
    ) {
      return null;
    }

    const userJson = params.get('user');

    if (!userJson) {
      return null;
    }

    const user = JSON.parse(userJson);

    if (!user || !user.id) {
      return null;
    }

    return {
      id: String(user.id),
      first_name: user.first_name || ''
    };
  } catch (err) {
    console.error('initData validation error:', err);
    return null;
  }
}

function parseUnsafe(initData) {
  try {
    const params = new URLSearchParams(initData);

    const userJson = params.get('user');

    if (!userJson) {
      return null;
    }

    const user = JSON.parse(userJson);

    if (!user || !user.id) {
      return null;
    }

    return {
      id: String(user.id),
      first_name: user.first_name || ''
    };
  } catch (err) {
    return null;
  }
}

/* =========================================================
   ONLINE USERS / ACTIVITY
========================================================= */

const lastSeen = {};

const activityLog = [];

function touch(userId, name) {
  lastSeen[String(userId)] = {
    ts: Date.now(),
    name: name || null
  };
}

function countOnline() {
  const cutoff = Date.now() - ONLINE_WINDOW_MS;

  let count = 0;

  Object.keys(lastSeen).forEach(function (userId) {
    if (lastSeen[userId].ts >= cutoff) {
      count++;
    }
  });

  return count;
}

function logActivity(entry) {
  entry.time = new Date().toISOString();

  activityLog.unshift(entry);

  if (activityLog.length > ACTIVITY_LOG_MAX) {
    activityLog.length = ACTIVITY_LOG_MAX;
  }
}

/* =========================================================
   ROUND SYSTEM
========================================================= */

const roundLiability = {};

const forcedNextNumber = {
  value: null,
  enabled: false
};

function currentRoundId() {
  return Math.floor(
    Date.now() / 1000 / ROUND_LENGTH
  );
}

function getLiabilityArray(round) {
  if (!roundLiability[round]) {
    roundLiability[round] = new Array(37).fill(0);
  }

  return roundLiability[round];
}

function payoutForOutcome(
  betType,
  numbers,
  stake,
  outcome
) {
  const color = colorFor(outcome);

  if (betType === 'number') {
    return numbers.indexOf(outcome) !== -1
      ? stake * SPIN_PAYOUT_MULTIPLIER
      : 0;
  }

  if (betType === 'red') {
    return color === 'red'
      ? stake * EVEN_MONEY_MULTIPLIER
      : 0;
  }

  if (betType === 'black') {
    return color === 'black'
      ? stake * EVEN_MONEY_MULTIPLIER
      : 0;
  }

  if (betType === 'odd') {
    return outcome !== 0 && outcome % 2 === 1
      ? stake * EVEN_MONEY_MULTIPLIER
      : 0;
  }

  if (betType === 'even') {
    return outcome !== 0 && outcome % 2 === 0
      ? stake * EVEN_MONEY_MULTIPLIER
      : 0;
  }

  if (betType === 'low') {
    return outcome >= 1 && outcome <= 18
      ? stake * EVEN_MONEY_MULTIPLIER
      : 0;
  }

  if (betType === 'high') {
    return outcome >= 19 && outcome <= 36
      ? stake * EVEN_MONEY_MULTIPLIER
      : 0;
  }

  if (betType === 'dozen1') {
    return outcome >= 1 && outcome <= 12
      ? stake * DOZEN_MULTIPLIER
      : 0;
  }

  if (betType === 'dozen2') {
    return outcome >= 13 && outcome <= 24
      ? stake * DOZEN_MULTIPLIER
      : 0;
  }

  if (betType === 'dozen3') {
    return outcome >= 25 && outcome <= 36
      ? stake * DOZEN_MULTIPLIER
      : 0;
  }

  return 0;
}

function wouldExceedCap(
  round,
  betType,
  numbers,
  stake
) {
  const liability = getLiabilityArray(round);

  for (let i = 0; i < ALL_NUMBERS.length; i++) {
    const outcome = ALL_NUMBERS[i];

    const added = payoutForOutcome(
      betType,
      numbers,
      stake,
      outcome
    );

    if (
      liability[outcome] + added >
      MAX_ROUND_LIABILITY
    ) {
      return true;
    }
  }

  return false;
}

function addLiability(
  round,
  betType,
  numbers,
  stake
) {
  const liability = getLiabilityArray(round);

  for (let i = 0; i < ALL_NUMBERS.length; i++) {
    const outcome = ALL_NUMBERS[i];

    liability[outcome] += payoutForOutcome(
      betType,
      numbers,
      stake,
      outcome
    );
  }
}

function removeLiability(
  round,
  betType,
  numbers,
  stake
) {
  const liability = getLiabilityArray(round);

  for (let i = 0; i < ALL_NUMBERS.length; i++) {
    const outcome = ALL_NUMBERS[i];

    liability[outcome] -= payoutForOutcome(
      betType,
      numbers,
      stake,
      outcome
    );

    if (liability[outcome] < 0) {
      liability[outcome] = 0;
    }
  }
}

function cleanupOldLiability(currentRound) {
  const cutoff = currentRound - 5;

  Object.keys(roundLiability).forEach(function (key) {
    if (Number(key) < cutoff) {
      delete roundLiability[key];
    }
  });
}

/* =========================================================
   ROUND RESOLUTION
========================================================= */

async function resolveRound(round) {
  round = Number(round);

  if (pool) {
    const existing = await pool.query(
      `
      SELECT winning_number, winning_color
      FROM rounds
      WHERE round_id = $1
      `,
      [round]
    );

    if (existing.rows.length > 0) {
      return {
        winning_number: Number(
          existing.rows[0].winning_number
        ),
        winning_color:
          existing.rows[0].winning_color
      };
    }

    let winningNumber;

    if (forcedNextNumber.enabled) {
      winningNumber = forcedNextNumber.value;

      forcedNextNumber.enabled = false;
      forcedNextNumber.value = null;
    } else {
      winningNumber =
        WHEEL_ORDER[
          Math.floor(
            Math.random() *
            WHEEL_ORDER.length
          )
        ];
    }

    const winningColor =
      colorFor(winningNumber);

    await pool.query(
      `
      INSERT INTO rounds
        (round_id, winning_number, winning_color)
      VALUES
        ($1, $2, $3)
      ON CONFLICT (round_id) DO NOTHING
      `,
      [
        round,
        winningNumber,
        winningColor
      ]
    );

    const final = await pool.query(
      `
      SELECT winning_number, winning_color
      FROM rounds
      WHERE round_id = $1
      `,
      [round]
    );

    cleanupOldLiability(round);

    return {
      winning_number:
        Number(final.rows[0].winning_number),
      winning_color:
        final.rows[0].winning_color
    };
  }

  if (memRounds[round]) {
    return memRounds[round];
  }

  let winningNumber;

  if (forcedNextNumber.enabled) {
    winningNumber = forcedNextNumber.value;

    forcedNextNumber.enabled = false;
    forcedNextNumber.value = null;
  } else {
    winningNumber =
      WHEEL_ORDER[
        Math.floor(
          Math.random() *
          WHEEL_ORDER.length
        )
      ];
  }

  memRounds[round] = {
    winning_number: winningNumber,
    winning_color: colorFor(winningNumber)
  };

  cleanupOldLiability(round);

  return memRounds[round];
}

/* =========================================================
   TICKETS
========================================================= */

async function getTicket(round, userId) {
  const ticketId =
    String(round) + '-' + String(userId);

  if (!pool) {
    return memTickets[ticketId] || null;
  }

  const result = await pool.query(
    `
    SELECT *
    FROM tickets
    WHERE ticket_id = $1
    `,
    [ticketId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];

  return {
    ticketId: row.ticket_id,
    round: Number(row.round_id),
    userId: row.user_id,
    betType: row.bet_type,
    numbers: Array.isArray(row.numbers)
      ? row.numbers
      : [],
    stake: Number(row.stake),
    perNumberStake:
      Number(row.per_number_stake),
    settled: row.settled,
    won: row.won,
    payout: Number(row.payout || 0),
    winningNumber:
      row.winning_number === null
        ? null
        : Number(row.winning_number)
  };
}

async function createTicket(ticket) {
  if (!pool) {
    memTickets[ticket.ticketId] = ticket;
    return;
  }

  await pool.query(
    `
    INSERT INTO tickets
      (
        ticket_id,
        round_id,
        user_id,
        bet_type,
        numbers,
        stake,
        per_number_stake
      )
    VALUES
      ($1, $2, $3, $4, $5::jsonb, $6, $7)
    ON CONFLICT (ticket_id) DO NOTHING
    `,
    [
      ticket.ticketId,
      ticket.round,
      ticket.userId,
      ticket.betType,
      JSON.stringify(ticket.numbers),
      ticket.stake,
      ticket.perNumberStake
    ]
  );
}

async function settleTicket(
  round,
  userId,
  winningNumber
) {
  const ticket =
    await getTicket(round, userId);

  if (!ticket) {
    return {
      exists: false
    };
  }

  /*
    IMPORTANT:
    If already settled, NEVER pay again.
  */
  if (ticket.settled) {
    return {
      exists: true,
      alreadySettled: true,
      won: !!ticket.won,
      amount: Number(ticket.payout || 0)
    };
  }

  let won = false;
  let amount = 0;

  if (ticket.betType === 'number') {
    won =
      ticket.numbers.indexOf(
        winningNumber
      ) !== -1;

    if (won) {
      amount =
        ticket.perNumberStake *
        SPIN_PAYOUT_MULTIPLIER;
    }
  }

  else if (
    ticket.betType === 'red' ||
    ticket.betType === 'black'
  ) {
    won =
      colorFor(winningNumber) ===
      ticket.betType;

    amount = won
      ? ticket.stake *
        EVEN_MONEY_MULTIPLIER
      : 0;
  }

  else if (ticket.betType === 'odd') {
    won =
      winningNumber !== 0 &&
      winningNumber % 2 === 1;

    amount = won
      ? ticket.stake *
        EVEN_MONEY_MULTIPLIER
      : 0;
  }

  else if (ticket.betType === 'even') {
    won =
      winningNumber !== 0 &&
      winningNumber % 2 === 0;

    amount = won
      ? ticket.stake *
        EVEN_MONEY_MULTIPLIER
      : 0;
  }

  else if (ticket.betType === 'low') {
    won =
      winningNumber >= 1 &&
      winningNumber <= 18;

    amount = won
      ? ticket.stake *
        EVEN_MONEY_MULTIPLIER
      : 0;
  }

  else if (ticket.betType === 'high') {
    won =
      winningNumber >= 19 &&
      winningNumber <= 36;

    amount = won
      ? ticket.stake *
        EVEN_MONEY_MULTIPLIER
      : 0;
  }

  else if (ticket.betType === 'dozen1') {
    won =
      winningNumber >= 1 &&
      winningNumber <= 12;

    amount = won
      ? ticket.stake *
        DOZEN_MULTIPLIER
      : 0;
  }

  else if (ticket.betType === 'dozen2') {
    won =
      winningNumber >= 13 &&
      winningNumber <= 24;

    amount = won
      ? ticket.stake *
        DOZEN_MULTIPLIER
      : 0;
  }

  else if (ticket.betType === 'dozen3') {
    won =
      winningNumber >= 25 &&
      winningNumber <= 36;

    amount = won
      ? ticket.stake *
        DOZEN_MULTIPLIER
      : 0;
  }

  if (pool) {
    /*
      Atomic settlement:
      only the first request can change settled=false
      to settled=true.
    */
    const result = await pool.query(
      `
      UPDATE tickets
      SET
        settled = true,
        won = $2,
        payout = $3,
        winning_number = $4,
        settled_at = now()
      WHERE ticket_id = $1
        AND settled = false
      RETURNING ticket_id
      `,
      [
        ticket.ticketId,
        won,
        amount,
        winningNumber
      ]
    );

    if (result.rowCount !== 1) {
      const already =
        await getTicket(round, userId);

      return {
        exists: true,
        alreadySettled: true,
        won: !!already.won,
        amount: Number(
          already.payout || 0
        )
      };
    }

    if (won && amount > 0) {
      await changeBalance(
        userId,
        amount
      );
    }
  } else {
    /*
      In-memory mode.
    */
    ticket.settled = true;
    ticket.won = won;
    ticket.payout = amount;
    ticket.winningNumber = winningNumber;

    if (won && amount > 0) {
      await changeBalance(
        userId,
        amount
      );
    }
  }

  return {
    exists: true,
    alreadySettled: false,
    won,
    amount
  };
}

/* =========================================================
   ADMIN: SET NEXT NUMBER
========================================================= */

app.post(
  '/api/admin/set-next-number',
  requireAdmin,
  function (req, res) {
    const number = req.body.number;

    if (
      number === null
    ) {
      forcedNextNumber.enabled = false;
      forcedNextNumber.value = null;

      return res.json({
        success: true,
        message:
          'ቀጥሎ የሚወጣው ቁጥር Random ሆኗል'
      });
    }

    if (
      typeof number === 'number' &&
      Number.isInteger(number) &&
      number >= 0 &&
      number <= 36
    ) {
      forcedNextNumber.enabled = true;
      forcedNextNumber.value = number;

      return res.json({
        success: true,
        message:
          'ቀጥሎ የሚወጣው ቁጥር ' +
          number +
          ' ተዘጋጅቷል'
      });
    }

    return res.status(400).json({
      error:
        'ልክ ያልሆነ ቁጥር። 0-36 መሆን አለበት'
    });
  }
);

/* =========================================================
   ADMIN: STATS
========================================================= */

app.get(
  '/api/admin/stats',
  requireAdmin,
  async function (req, res) {
    try {
      const balances =
        await getAllBalances();

      const totals =
        await getConfirmedTotals();

      const totalUserBalance =
        balances.reduce(
          function (sum, user) {
            return sum + user.balance;
          },
          0
        );

      const netProfit =
        totals.totalDeposits -
        totals.totalWithdrawals -
        totalUserBalance;

      res.json({
        total_users:
          balances.length,

        total_deposits:
          totals.totalDeposits,

        total_withdrawals:
          totals.totalWithdrawals,

        net_profit:
          netProfit,

        online_now:
          countOnline()
      });
    } catch (err) {
      console.error(
        'admin/stats error:',
        err
      );

      res.status(500).json({
        error:
          'failed to load stats'
      });
    }
  }
);

/* =========================================================
   ADMIN: USERS REPORT
========================================================= */

app.get(
  '/api/admin/users-report',
  requireAdmin,
  async function (req, res) {
    try {
      const balances =
        await getAllBalances();

      const cutoff =
        Date.now() -
        ONLINE_WINDOW_MS;

      const users =
        balances.map(function (user) {
          const seen =
            lastSeen[user.userId];

          return {
            userId:
              user.userId,

            name:
              seen
                ? seen.name
                : null,

            balance:
              user.balance,

            online:
              !!(
                seen &&
                seen.ts >= cutoff
              )
          };
        });

      res.json({
        users
      });
    } catch (err) {
      console.error(
        'admin/users-report error:',
        err
      );

      res.status(500).json({
        error:
          'failed to load users report'
      });
    }
  }
);

/* =========================================================
   ADMIN: ACTIVITY
========================================================= */

app.get(
  '/api/admin/activity',
  requireAdmin,
  async function (req, res) {
    const requested =
      Number(req.query.limit) || 50;

    const limit = Math.min(
      Math.max(requested, 1),
      ACTIVITY_LOG_MAX
    );

    res.json({
      activity:
        activityLog.slice(
          0,
          limit
        )
    });
  }
);

/* =========================================================
   ADMIN: ROUND RESULT
========================================================= */

app.get(
  '/api/admin/round-result',
  requireAdmin,
  async function (req, res) {
    try {
      const round =
        Number.isInteger(
          Number(req.query.round)
        )
          ? Number(req.query.round)
          : currentRoundId();

      const result =
        await resolveRound(round);

      res.json({
        round,
        winning_number:
          result.winning_number,
        winning_color:
          result.winning_color,
        is_current_round:
          round === currentRoundId()
      });
    } catch (err) {
      console.error(
        'admin/round-result error:',
        err
      );

      res.status(500).json({
        error:
          'failed to resolve round'
      });
    }
  }
);

/* =========================================================
   HOME
========================================================= */

app.get('/', function (req, res) {
  res.send(
    'Spin and Win API server is running'
  );
});

/* =========================================================
   BALANCE
========================================================= */

app.get(
  '/api/balance',
  async function (req, res) {
    try {
      const initData =
        req.query.initData || '';

      const user =
        validateInitData(initData);

      if (!user) {
        return res.status(401).json({
          error:
            'invalid initData'
        });
      }

      touch(
        user.id,
        user.first_name
      );

      res.json({
        balance:
          await getBalance(user.id)
      });
    } catch (err) {
      console.error(
        'balance error:',
        err
      );

      res.status(500).json({
        error:
          'failed to load balance'
      });
    }
  }
);

/*
  Removed public /api/balance/:userId endpoint.
  It exposed arbitrary users' balances.
*/

/* =========================================================
   PLACE TICKET
========================================================= */

app.post(
  '/api/place-ticket',
  async function (req, res) {
    try {
      const initData =
        req.body.initData;

      const round =
        Number(req.body.round);

      const betType =
        req.body.betType;

      const numbers =
        req.body.numbers;

      const requestedStake =
        req.body.stake;

      const user =
        validateInitData(initData);

      if (!user) {
        return res.status(401).json({
          error:
            'invalid initData'
        });
      }

      const currentRound =
        currentRoundId();

      if (
        !Number.isInteger(round) ||
        round !== currentRound
      ) {
        return res.status(400).json({
          error:
            'round closed'
        });
      }

      const VALID_TYPES = [
        'number',
        'red',
        'black',
        'odd',
        'even',
        'dozen1',
        'dozen2',
        'dozen3',
        'low',
        'high'
      ];

      if (
        VALID_TYPES.indexOf(
          betType
        ) === -1
      ) {
        return res.status(400).json({
          error:
            'invalid bet type'
        });
      }

      if (
        STAKE_OPTIONS.indexOf(
          requestedStake
        ) === -1
      ) {
        return res.status(400).json({
          error:
            'invalid stake'
        });
      }

      let cleanNumbers = [];

      let perNumberStake =
        requestedStake;

      let stake =
        requestedStake;

      if (betType === 'number') {
        if (
          !Array.isArray(numbers) ||
          numbers.length === 0
        ) {
          return res.status(400).json({
            error:
              'select a number'
          });
        }

        if (
          numbers.length >
          MAX_NUMBERS
        ) {
          return res.status(400).json({
            error:
              'too many numbers'
          });
        }

        cleanNumbers =
          numbers.map(function (n) {
            return Number(n);
          });

        for (
          let i = 0;
          i < cleanNumbers.length;
          i++
        ) {
          const n =
            cleanNumbers[i];

          if (
            !Number.isInteger(n) ||
            n < 0 ||
            n > 36
          ) {
            return res.status(400).json({
              error:
                'invalid number'
            });
          }
        }

        /*
          Prevent duplicate numbers.
        */
        if (
          new Set(cleanNumbers)
            .size !==
          cleanNumbers.length
        ) {
          return res.status(400).json({
            error:
              'duplicate number'
          });
        }

        stake =
          cleanNumbers.length *
          requestedStake;
      }

      const ticketId =
        round +
        '-' +
        user.id;

      /*
        Check existing ticket first.
      */
      const existing =
        await getTicket(
          round,
          user.id
        );

      if (existing) {
        return res.status(409).json({
          error:
            'በዚህ ዙር ቀድሞውኑ ትኬት ቆርጠዋል'
        });
      }

      /*
        For number bets payout is per-number stake.
        For other bets payout is the total stake.
      */
      const payoutStake =
        betType === 'number'
          ? perNumberStake
          : stake;

      /*
        Reserve liability BEFORE awaiting balance.
        This prevents two simultaneous requests
        from both passing the cap.
      */
      if (
        wouldExceedCap(
          round,
          betType,
          cleanNumbers,
          payoutStake
        )
      ) {
        return res.status(400).json({
          error:
            'ይህ ውርርድ በአሁኑ ጊዜ አይቀበልም። የround liability limit ደርሷል'
        });
      }

      addLiability(
        round,
        betType,
        cleanNumbers,
        payoutStake
      );

      /*
        Deduct balance.
      */
      const deduction =
        await deductIfSufficient(
          user.id,
          stake
        );

      if (!deduction.ok) {
        /*
          Roll back liability.
        */
        removeLiability(
          round,
          betType,
          cleanNumbers,
          payoutStake
        );

        return res.status(400).json({
          error:
            'insufficient balance'
        });
      }

      const ticket = {
        ticketId,
        round,
        userId:
          user.id,
        betType,
        numbers:
          cleanNumbers,
        stake,
        perNumberStake,
        settled: false,
        won: null,
        payout: 0,
        winningNumber: null
      };

      try {
        await createTicket(
          ticket
        );
      } catch (ticketError) {
        /*
          If ticket creation fails,
          refund the deducted amount and
          release liability.
        */
        await changeBalance(
          user.id,
          stake
        );

        removeLiability(
          round,
          betType,
          cleanNumbers,
          payoutStake
        );

        throw ticketError;
      }

      touch(
        user.id,
        user.first_name
      );

      logActivity({
        type: 'bet',
        userId:
          user.id,
        name:
          user.first_name || null,
        betType,
        numbers:
          cleanNumbers,
        stake,
        round
      });

      res.json({
        ticket_id:
          ticketId,
        balance:
          deduction.balance
      });
    } catch (err) {
      console.error(
        'place-ticket error:',
        err
      );

      res.status(500).json({
        error:
          'failed to place ticket'
      });
    }
  }
);

/* =========================================================
   ROUND RESULT
========================================================= */

app.get(
  '/api/round-result',
  async function (req, res) {
    try {
      const initData =
        req.query.initData || '';

      const round =
        Number(req.query.round);

      const ticketId =
        String(
          req.query.ticket_id || ''
        );

      const user =
        validateInitData(initData);

      if (!user) {
        return res.status(401).json({
          error:
            'invalid initData'
        });
      }

      if (
        !Number.isInteger(round)
      ) {
        return res.status(400).json({
          error:
            'invalid round'
        });
      }

      if (
        round >= currentRoundId()
      ) {
        return res.status(425).json({
          error:
            'round not finished yet'
        });
      }

      const expectedTicketId =
        round +
        '-' +
        user.id;

      if (
        ticketId !==
        expectedTicketId
      ) {
        return res.status(403).json({
          error:
            'invalid ticket'
        });
      }

      const ticket =
        await getTicket(
          round,
          user.id
        );

      /*
        No ticket = user did not bet
        in this round.
      */
      if (!ticket) {
        const resolved =
          await resolveRound(
            round
          );

        return res.json({
          winning_number:
            resolved.winning_number,
          winning_color:
            resolved.winning_color,
          won: false,
          amount: 0,
          balance:
            await getBalance(
              user.id
            )
        });
      }

      const resolved =
        await resolveRound(
          round
        );

      const settlement =
        await settleTicket(
          round,
          user.id,
          resolved.winning_number
        );

      const balance =
        await getBalance(
          user.id
        );

      touch(
        user.id,
        user.first_name
      );

      /*
        Log only a new settlement.
      */
      if (
        settlement.exists &&
        !settlement.alreadySettled
      ) {
        logActivity({
          type: 'result',
          userId:
            user.id,
          name:
            user.first_name || null,
          betType:
            ticket.betType,
          stake:
            ticket.stake,
          won:
            settlement.won,
          amount:
            settlement.amount,
          winningNumber:
            resolved.winning_number,
          round
        });
      }

      res.json({
        winning_number:
          resolved.winning_number,

        winning_color:
          resolved.winning_color,

        won:
          settlement.won,

        amount:
          settlement.amount,

        balance
      });
    } catch (err) {
      console.error(
        'round-result error:',
        err
      );

      res.status(500).json({
        error:
          'failed to load round result'
      });
    }
  }
);

/* =========================================================
   DEPOSIT REQUEST
========================================================= */

app.post(
  '/api/deposit/request',
  async function (req, res) {
    try {
      const initData =
        req.body.initData;

      const amount =
        req.body.amount;

      const user =
        validateInitData(initData);

      if (!user) {
        return res.status(401).json({
          error:
            'invalid initData'
        });
      }

      if (
        typeof amount !== 'number' ||
        !Number.isFinite(amount) ||
        amount <= 0
      ) {
        return res.status(400).json({
          error:
            'Invalid amount'
        });
      }

      const orderId =
        await createOrder(
          'deposit',
          user.id,
          amount
        );

      touch(
        user.id,
        user.first_name
      );

      logActivity({
        type: 'deposit_request',
        userId:
          user.id,
        name:
          user.first_name || null,
        amount
      });

      res.json({
        orderId
      });
    } catch (err) {
      console.error(
        'deposit/request error:',
        err
      );

      res.status(500).json({
        error:
          'failed to create deposit request'
      });
    }
  }
);

/* =========================================================
   DEPOSIT CONFIRM
========================================================= */

app.post(
  '/api/deposit/confirm',
  requireAdmin,
  async function (req, res) {
    try {
      const orderId =
        String(
          req.body.orderId || ''
        );

      const adminId =
        String(
          req.body.adminId ||
          'admin'
        );

      const order =
        await getOrder(
          orderId
        );

      if (!order) {
        return res.status(404).json({
          error:
            'Order not found'
        });
      }

      if (
        order.type !==
        'deposit'
      ) {
        return res.status(400).json({
          error:
            'Invalid order type'
        });
      }

      if (
        order.status !==
        'pending'
      ) {
        return res.status(409).json({
          error:
            'Already handled'
        });
      }

      /*
        Mark first.
        If another admin tries at the same time,
        only one gets success.
      */
      const marked =
        await markOrder(
          orderId,
          'confirmed',
          adminId
        );

      if (!marked) {
        return res.status(409).json({
          error:
            'Already handled'
        });
      }

      const newBalance =
        await changeBalance(
          order.userId,
          order.amount
        );

      logActivity({
        type:
          'deposit_confirmed',
        userId:
          order.userId,
        amount:
          order.amount,
        orderId,
        adminId
      });

      res.json({
        userId:
          order.userId,
        balance:
          newBalance
      });
    } catch (err) {
      console.error(
        'deposit/confirm error:',
        err
      );

      res.status(500).json({
        error:
          'failed to confirm deposit'
      });
    }
  }
);

/* =========================================================
   DEPOSIT REJECT
========================================================= */

app.post(
  '/api/deposit/reject',
  requireAdmin,
  async function (req, res) {
    try {
      const orderId =
        String(
          req.body.orderId || ''
        );

      const adminId =
        String(
          req.body.adminId ||
          'admin'
        );

      const order =
        await getOrder(
          orderId
        );

      if (!order) {
        return res.status(404).json({
          error:
            'Order not found'
        });
      }

      if (
        order.type !==
        'deposit'
      ) {
        return res.status(400).json({
          error:
            'Invalid order type'
        });
      }

      if (
        order.status !==
        'pending'
      ) {
        return res.status(409).json({
          error:
            'Already handled'
        });
      }

      const marked =
        await markOrder(
          orderId,
          'rejected',
          adminId
        );

      if (!marked) {
        return res.status(409).json({
          error:
            'Already handled'
        });
      }

      logActivity({
        type:
          'deposit_rejected',
        userId:
          order.userId,
        amount:
          order.amount,
        orderId,
        adminId
      });

      res.json({
        userId:
          order.userId
      });
    } catch (err) {
      console.error(
        'deposit/reject error:',
        err
      );

      res.status(500).json({
        error:
          'failed to reject deposit'
      });
    }
  }
);

/* =========================================================
   WITHDRAW REQUEST
========================================================= */

app.post(
  '/api/withdraw/request',
  async function (req, res) {
    try {
      const initData =
        req.body.initData;

      const amount =
        req.body.amount;

      const phone =
        req.body.phone;

      const user =
        validateInitData(initData);

      if (!user) {
        return res.status(401).json({
          error:
            'invalid initData'
        });
      }

      if (
        typeof amount !== 'number' ||
        !Number.isFinite(amount) ||
        amount <= 0
      ) {
        return res.status(400).json({
          error:
            'Invalid amount'
        });
      }

      if (
        !phone ||
        typeof phone !== 'string' ||
        !phone.trim()
      ) {
        return res.status(400).json({
          error:
            'Phone number required'
        });
      }

      const deduction =
        await deductIfSufficient(
          user.id,
          amount
        );

      if (!deduction.ok) {
        return res.status(400).json({
          error:
            'insufficient balance'
        });
      }

      try {
        const orderId =
          await createOrder(
            'withdraw',
            user.id,
            amount,
            {
              phone:
                phone.trim()
            }
          );

        touch(
          user.id,
          user.first_name
        );

        logActivity({
          type:
            'withdraw_request',
          userId:
            user.id,
          name:
            user.first_name || null,
          amount,
          phone:
            phone.trim(),
          orderId
        });

        res.json({
          orderId,
          balance:
            deduction.balance
        });
      } catch (orderError) {
        /*
          If order creation fails,
          refund the withdrawn amount.
        */
        await changeBalance(
          user.id,
          amount
        );

        throw orderError;
      }
    } catch (err) {
      console.error(
        'withdraw/request error:',
        err
      );

      res.status(500).json({
        error:
          'failed to create withdrawal request'
      });
    }
  }
);

/* =========================================================
   WITHDRAW CONFIRM
========================================================= */

app.post(
  '/api/withdraw/confirm',
  requireAdmin,
  async function (req, res) {
    try {
      const orderId =
        String(
          req.body.orderId || ''
        );

      const adminId =
        String(
          req.body.adminId ||
          'admin'
        );

      const order =
        await getOrder(
          orderId
        );

      if (!order) {
        return res.status(404).json({
          error:
            'Order not found'
        });
      }

      if (
        order.type !==
        'withdraw'
      ) {
        return res.status(400).json({
          error:
            'Invalid order type'
        });
      }

      if (
        order.status !==
        'pending'
      ) {
        return res.status(409).json({
          error:
            'Already handled'
        });
      }

      const marked =
        await markOrder(
          orderId,
          'confirmed',
          adminId
        );

      if (!marked) {
        return res.status(409).json({
          error:
            'Already handled'
        });
      }

      const balance =
        await getBalance(
          order.userId
        );

      logActivity({
        type:
          'withdraw_confirmed',
        userId:
          order.userId,
        amount:
          order.amount,
        orderId,
        adminId
      });

      res.json({
        userId:
          order.userId,
        balance
      });
    } catch (err) {
      console.error(
        'withdraw/confirm error:',
        err
      );

      res.status(500).json({
        error:
          'failed to confirm withdrawal'
      });
    }
  }
);

/* =========================================================
   WITHDRAW REJECT
========================================================= */

app.post(
  '/api/withdraw/reject',
  requireAdmin,
  async function (req, res) {
    try {
      const orderId =
        String(
          req.body.orderId || ''
        );

      const adminId =
        String(
          req.body.adminId ||
          'admin'
        );

      const order =
        await getOrder(
          orderId
        );

      if (!order) {
        return res.status(404).json({
          error:
            'Order not found'
        });
      }

      if (
        order.type !==
        'withdraw'
      ) {
        return res.status(400).json({
          error:
            'Invalid order type'
        });
      }

      if (
        order.status !==
        'pending'
      ) {
        return res.status(409).json({
          error:
            'Already handled'
        });
      }

      /*
        Mark rejected first.
        Only the successful marker gets the refund.
      */
      const marked =
        await markOrder(
          orderId,
          'rejected',
          adminId
        );

      if (!marked) {
        return res.status(409).json({
          error:
            'Already handled'
        });
      }

      const balance =
        await changeBalance(
          order.userId,
          order.amount
        );

      logActivity({
        type:
          'withdraw_rejected',
        userId:
          order.userId,
        amount:
          order.amount,
        orderId,
        adminId
      });

      res.json({
        userId:
          order.userId,
        balance
      });
    } catch (err) {
      console.error(
        'withdraw/reject error:',
        err
      );

      res.status(500).json({
        error:
          'failed to reject withdrawal'
      });
    }
  }
);

/* =========================================================
   START SERVER
========================================================= */

initDb()
  .then(function () {
    app.listen(
      PORT,
      function () {
        console.log(
          'Server listening on port ' +
          PORT
        );
      }
    );
  })
  .catch(function (err) {
    console.error(
      'Failed to initialize database:',
      err
    );

    process.exit(1);
  });
