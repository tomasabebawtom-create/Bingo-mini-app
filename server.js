const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/', (req, res) => {
  res.send('Bingo demo server is running');
});

// bingo_audio/ ፎልደር ውስጥ ያሉ b1.mp3, i16.mp3, ... o75.mp3 ፋይሎችን
// ደንበኞች (clients) በቀጥታ እንዲያገኙ በስታቲክ ማድረግ
app.use('/audio', express.static(path.join(__dirname, 'bingo_audio')));
app.use(express.static(path.join(__dirname))); // index.html ን ማገልገል

// =================================================================
// ⚠️  ማስታወሻ፦ ይህ ገንዘብ/wallet ስሌት ለማሳያ (demo) ብቻ ነው።
// በሜሞሪ ውስጥ ብቻ የሚቀመጥ ነው (ሰርቨሩ ሲዘጋ/ሲነሳ ይጠፋል)፣ ማንኛውም እውነተኛ
// ክፍያ (Telebirr, CBE Birr, ወዘተ) ገና አልተገናኘም። እውነተኛ ገንዘብ ሲንቀሳቀስ
// የክፍያ አገልግሎት ማገናኘት፣ database መጠቀም፣ እና ደህንነት (security) ማጠናከር
// የግድ ያስፈልጋል።
// =================================================================

const COUNTDOWN_SECONDS = 30;   // ተጫዋቾች ካርቴላ የሚይዙበት ጊዜ
const CALL_INTERVAL_MS = 5000;  // በየስንት ሰከንድ ቁጥር ይጠራል
const RESTART_DELAY_MS = 8000;  // ዙር ካለቀ በኋላ አዲስ ዙር ከመጀመሩ በፊት የሚቆይበት ጊዜ

const BET_AMOUNT = 10;          // የካርቴላ ዋጋ (ብር) - demo
const START_BALANCE = 200;      // እያንዳንዱ አዲስ ተጫዋች የሚጀምርበት ቀሪ ሂሳብ - demo
const HOUSE_CUT_PERCENT = 20;   // የቤት መቶኛ ከደራሽ ላይ - demo
const CARD_COUNT = 100;         // የካርቴላ ብዛት (1-100)

let remainingNumbers = [];
let calledNumbers = [];
let calledSet = new Set();
let phase = 'waiting';      // 'waiting' | 'playing' | 'finished'
let countdownValue = COUNTDOWN_SECONDS;

let countdownTimer = null;
let callTimer = null;

// socket.id -> ቀሪ ሂሳብ (ብር) — ግንኙነት እስካለ ድረስ ይቆያል
const wallets = new Map();
// cardId -> socket.id (በዚህ ዙር የተያዘ ካርቴላ)
const takenCards = new Map();
// socket.id -> cardId (ይህ ተጫዋች የገዛው ካርቴላ)
const playerCards = new Map();

function makeGameId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}
let GAME_ID = makeGameId();

function letterFor(number) {
  if (number <= 15) return 'B';
  if (number <= 30) return 'I';
  if (number <= 45) return 'N';
  if (number <= 60) return 'G';
  return 'O';
}
function audioFileFor(number) {
  return `${letterFor(number).toLowerCase()}${number}.mp3`;
}

// ---------------------------------------------------------------
// 100 ቋሚ ካርቴላዎች መፍጠር (ቁጥር #42 ሁልጊዜ ተመሳሳይ ይዘት ይኖረዋል)
// ---------------------------------------------------------------
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick5(rand, min, max) {
  const pool = [];
  for (let n = min; n <= max; n++) pool.push(n);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, 5);
}

function generateCard(seed) {
  const rand = mulberry32(seed);
  const B = pick5(rand, 1, 15);
  const I = pick5(rand, 16, 30);
  const N = pick5(rand, 31, 45);
  const G = pick5(rand, 46, 60);
  const O = pick5(rand, 61, 75);
  N[2] = 'FREE'; // የመሃል ነፃ ቦታ
  return { B, I, N, G, O };
}

const CARDS = {};
for (let id = 1; id <= CARD_COUNT; id++) {
  CARDS[id] = generateCard(id * 7919 + 13);
}

// አሸናፊ መስመሮች (5 አምድ x [አምድ, ረድፍ])
const WIN_LINES = [];
for (let r = 0; r < 5; r++) WIN_LINES.push([0, 1, 2, 3, 4].map(c => [c, r]));
for (let c = 0; c < 5; c++) WIN_LINES.push([0, 1, 2, 3, 4].map(r => [c, r]));
WIN_LINES.push([[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]]);
WIN_LINES.push([[0, 4], [1, 3], [2, 2], [3, 1], [4, 0]]);

const COLS = ['B', 'I', 'N', 'G', 'O'];
function cardValue(grid, col, row) {
  return grid[COLS[col]][row];
}
function checkWin(grid) {
  return WIN_LINES.some(line =>
    line.every(([col, row]) => {
      const v = cardValue(grid, col, row);
      return v === 'FREE' || calledSet.has(v);
    })
  );
}

// ---------------------------------------------------------------
// wallet helpers
// ---------------------------------------------------------------
function getBalance(socketId) {
  if (!wallets.has(socketId)) wallets.set(socketId, START_BALANCE);
  return wallets.get(socketId);
}
function setBalance(socketId, amount) {
  wallets.set(socketId, amount);
  io.to(socketId).emit('wallet_update', { balance: amount });
}

function cardsSold() { return takenCards.size; }
function currentDerash() {
  const pot = cardsSold() * BET_AMOUNT;
  return Math.round(pot * (1 - HOUSE_CUT_PERCENT / 100));
}

function roundStatsPayload() {
  return {
    gameId: GAME_ID,
    playerCount: io.engine.clientsCount,
    cardsSold: cardsSold(),
    bet: BET_AMOUNT,
    derash: currentDerash(),
    phase,
    countdownValue,
    calledNumbers,
  };
}

function broadcastRoundStats() {
  io.emit('game_state', roundStatsPayload());
}

// ---------------------------------------------------------------
// ዙር (round) ቁጥጥር
// ---------------------------------------------------------------
function resetRound() {
  remainingNumbers = Array.from({ length: 75 }, (_, i) => i + 1);
  calledNumbers = [];
  calledSet = new Set();
  countdownValue = COUNTDOWN_SECONDS;
  phase = 'waiting';
  GAME_ID = makeGameId();

  // ካርቴላዎችን ነፃ ማድረግ (ገንዘቡ ግን አይመለስም ካለፈው ዙር - ቀድሞውኑ በ endRound ተስተናግዷል)
  takenCards.clear();
  playerCards.clear();
}

function startCountdown() {
  clearInterval(countdownTimer);
  clearInterval(callTimer);
  resetRound();

  io.emit('round_reset'); // ደንበኞች የራሳቸውን ካርቴላ ምርጫ ዳግም እንዲጀምሩ
  broadcastRoundStats();

  console.log(`🎟️  ካርቴላ ይያዙ! ${COUNTDOWN_SECONDS} ሰከንድ ቀሪ... (Game ${GAME_ID})`);

  countdownTimer = setInterval(() => {
    countdownValue -= 1;
    io.emit('countdown_tick', { secondsLeft: countdownValue, derash: currentDerash(), cardsSold: cardsSold() });

    if (countdownValue <= 0) {
      clearInterval(countdownTimer);
      startGame();
    }
  }, 1000);
}

function startGame() {
  phase = 'playing';
  io.emit('game_started', { derash: currentDerash(), cardsSold: cardsSold() });
  console.log(`▶️  ጨዋታው ጀመረ! ${cardsSold()} ካርቴላ ተሽጧል | ደራሽ: ${currentDerash()} ብር`);

  callTimer = setInterval(callNextNumber, CALL_INTERVAL_MS);
}

function callNextNumber() {
  if (remainingNumbers.length === 0) {
    endRound({ winnerId: null });
    return;
  }

  const randomIndex = Math.floor(Math.random() * remainingNumbers.length);
  const number = remainingNumbers.splice(randomIndex, 1)[0];
  calledNumbers.push(number);
  calledSet.add(number);

  const payload = {
    number,
    letter: letterFor(number),
    audioFile: `/audio/${audioFileFor(number)}`,
    calledNumbers,
  };

  console.log('🔊 ቁጥር ተጠራ:', `${payload.letter}-${number}`);
  io.emit('number_called', payload);
}

function endRound({ winnerId, cardId, payout }) {
  clearInterval(callTimer);
  clearInterval(countdownTimer);
  phase = 'finished';

  if (winnerId) {
    io.emit('round_won', { winnerId, cardId, payout, calledNumbers });
    console.log(`🏆 አሸናፊ! ${winnerId} በካርቴላ #${cardId} — ${payout} ብር`);
  } else {
    io.emit('game_over', { calledNumbers });
    console.log('🏁 ሁሉም ቁጥሮች ተጠርተዋል፣ አሸናፊ የለም');
  }

  setTimeout(startCountdown, RESTART_DELAY_MS);
}

// ---------------------------------------------------------------
// ግንኙነት (connections)
// ---------------------------------------------------------------
io.on('connection', (socket) => {
  const balance = getBalance(socket.id);
  console.log('አዲስ ተጫዋች ገባ:', socket.id, '| ጠቅላላ ተጫዋቾች:', io.engine.clientsCount);

  socket.emit('card_catalog', { cards: CARDS, taken: Array.from(takenCards.keys()) });
  socket.emit('wallet_update', { balance });
  socket.emit('game_state', roundStatsPayload());

  io.emit('game_state', roundStatsPayload()); // playerCount ለሁሉም ይዘምን

  socket.on('select_card', ({ cardId }) => {
    cardId = Number(cardId);

    if (phase !== 'waiting') {
      return socket.emit('card_rejected', { reason: 'ጨዋታው ተጀምሯል፡ አሁን ካርቴላ መግዛት አይቻልም።' });
    }
    if (!CARDS[cardId]) {
      return socket.emit('card_rejected', { reason: 'ያልታወቀ ካርቴላ ቁጥር።' });
    }
    if (takenCards.has(cardId)) {
      return socket.emit('card_rejected', { reason: 'ይህ ካርቴላ አስቀድሞ ተይዟል።' });
    }
    if (playerCards.has(socket.id)) {
      return socket.emit('card_rejected', { reason: 'አስቀድመው ካርቴላ ገዝተዋል።' });
    }
    const bal = getBalance(socket.id);
    if (bal < BET_AMOUNT) {
      return socket.emit('card_rejected', { reason: 'በቂ ቀሪ ሂሳብ የለዎትም።' });
    }

    setBalance(socket.id, bal - BET_AMOUNT);
    takenCards.set(cardId, socket.id);
    playerCards.set(socket.id, cardId);

    socket.emit('card_selected', { cardId, grid: CARDS[cardId] });
    io.emit('card_catalog_update', { taken: Array.from(takenCards.keys()) });
    broadcastRoundStats();
  });

  socket.on('claim_bingo', () => {
    const cardId = playerCards.get(socket.id);
    if (!cardId) {
      return socket.emit('bingo_rejected', { reason: 'ካርቴላ አልገዙም።' });
    }
    if (phase !== 'playing') {
      return socket.emit('bingo_rejected', { reason: 'ጨዋታው በአሁኑ ጊዜ ንቁ አይደለም።' });
    }
    const grid = CARDS[cardId];
    if (!checkWin(grid)) {
      return socket.emit('bingo_rejected', { reason: 'ገና ትክክለኛ ቢንጎ የለዎትም።' });
    }

    const payout = currentDerash();
    const bal = getBalance(socket.id);
    setBalance(socket.id, bal + payout);

    endRound({ winnerId: socket.id, cardId, payout });
  });

  socket.on('disconnect', () => {
    const cardId = playerCards.get(socket.id);
    if (cardId && phase === 'waiting') {
      // ጨዋታው ገና ስላልጀመረ ገንዘቡን መመለስ
      const bal = wallets.get(socket.id) ?? 0;
      wallets.set(socket.id, bal + BET_AMOUNT);
      takenCards.delete(cardId);
      playerCards.delete(socket.id);
      io.emit('card_catalog_update', { taken: Array.from(takenCards.keys()) });
    }
    wallets.delete(socket.id); // demo: ሲወጣ ሂሳቡ አይቀመጥም (persistent account የለም)

    const count = Math.max(io.engine.clientsCount - 1, 0);
    console.log('ተጫዋች ወጣ:', socket.id, '| ጠቅላላ ተጫዋቾች:', count);
    io.emit('game_state', roundStatsPayload());
  });
});

startCountdown();

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
