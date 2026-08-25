"""
Simple Telegram Bingo Bot (75-ball, points-based — no real money).
Run with: python bot.py
Requires: pip install python-telegram-bot --upgrade
Set your bot token as an environment variable: TELEGRAM_BOT_TOKEN
"""

import os
import json
import random
import asyncio
import logging
from dataclasses import dataclass, field

from telegram import (
    Update,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    WebAppInfo,
)
from telegram.ext import (
    Application,
    CommandHandler,
    CallbackQueryHandler,
    ContextTypes,
)

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("bingo")

CALL_INTERVAL_SECONDS = 5  # how often a new number is auto-called
COLUMN_LETTERS = ["B", "I", "N", "G", "O"]
COLUMN_RANGES = {
    "B": range(1, 16),
    "I": range(16, 31),
    "N": range(31, 46),
    "G": range(46, 61),
    "O": range(61, 76),
}

# ---------------------------------------------------------------------------
# Balance / deposit system (internal points only — NOT real money).
# Only the admin below can approve a deposit request; the bot never moves
# real currency on its own.
# ---------------------------------------------------------------------------
ADMIN_ID = 6223621430  # <-- የአንተ Telegram User ID (admin ብቻ)
BALANCE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "balances.json")
CARD_COST = 10  # ጨዋታ ውስጥ ካርድ ለመግዛት የሚያስፈልግ ነጥብ


def load_balances() -> dict:
    if os.path.exists(BALANCE_FILE):
        try:
            with open(BALANCE_FILE, "r") as f:
                return {int(k): v for k, v in json.load(f).items()}
        except Exception:
            return {}
    return {}


def save_balances(balances: dict):
    with open(BALANCE_FILE, "w") as f:
        json.dump(balances, f)


balances: dict[int, int] = load_balances()

# pending deposit requests: request_id -> {user_id, name, amount}
pending_deposits: dict[str, dict] = {}
_next_request_id = 1


def get_balance(user_id: int) -> int:
    return balances.get(user_id, 0)


def change_balance(user_id: int, delta: int):
    balances[user_id] = get_balance(user_id) + delta
    save_balances(balances)


def letter_for_number(n: int) -> str:
    for letter, rng in COLUMN_RANGES.items():
        if n in rng:
            return letter
    return "?"


def generate_card():
    """Generate a standard 5x5 bingo card. Center is FREE."""
    card = []
    for letter in COLUMN_LETTERS:
        nums = random.sample(list(COLUMN_RANGES[letter]), 5)
        card.append(nums)
    # transpose to rows, mark center free
    rows = list(zip(*card))
    rows = [list(r) for r in rows]
    rows[2][2] = "FREE"
    return rows  # 5x5 grid: rows[row][col]


def card_to_text(card, marked: set) -> str:
    header = " | ".join(COLUMN_LETTERS)
    lines = [header, "-" * len(header)]
    for row in card:
        cells = []
        for val in row:
            if val == "FREE":
                cells.append("★")
            elif val in marked:
                cells.append(f"[{val}]")
            else:
                cells.append(str(val))
        lines.append(" | ".join(str(c).center(3) for c in cells))
    return "```\n" + "\n".join(lines) + "\n```"


def check_win(card, marked: set) -> bool:
    """Check rows, columns, and both diagonals."""
    grid = [[True if v == "FREE" else v in marked for v in row] for row in card]

    for row in grid:
        if all(row):
            return True
    for col in range(5):
        if all(grid[row][col] for row in range(5)):
            return True
    if all(grid[i][i] for i in range(5)):
        return True
    if all(grid[i][4 - i] for i in range(5)):
        return True
    return False


@dataclass
class Player:
    user_id: int
    name: str
    card: list = field(default_factory=list)
    marked: set = field(default_factory=set)


@dataclass
class Game:
    chat_id: int
    players: dict = field(default_factory=dict)  # user_id -> Player
    pool: list = field(default_factory=lambda: list(range(1, 76)))
    called: list = field(default_factory=list)
    running: bool = False
    task: object = None
    winner: str = None
    pot: int = 0


games: dict[int, Game] = {}  # chat_id -> Game


def get_game(chat_id: int) -> Game:
    if chat_id not in games:
        games[chat_id] = Game(chat_id=chat_id)
    return games[chat_id]


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = (
        "🎱 *Bingo Bot* (ለመዝናኛ ብቻ)\n\n"
        "/balance — ሂሳብህን አሳይ\n"
        "/deposit <መጠን> — ነጥብ ጠይቅ (admin ማረጋገጥ አለበት)\n\n"
        "/newgame — አዲስ ጨዋታ ጀምር\n"
        "/join — ገባ (ካርድ ትገዛለህ)\n"
        "/card — ካርድህን አሳይ\n"
        "/bingo — ካሸነፍክ ተናገር\n"
        "/stopgame — ጨዋታውን አቁም\n"
    )
    await update.message.reply_text(text, parse_mode="Markdown")


# ---------------------------------------------------------------------------
# Balance / deposit commands
# ---------------------------------------------------------------------------

async def balance_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    bal = get_balance(user.id)
    await update.message.reply_text(f"💰 ሂሳብህ፦ {bal} ነጥብ")


async def deposit_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    global _next_request_id
    user = update.effective_user

    if not context.args or not context.args[0].isdigit():
        await update.message.reply_text("እንዲህ ተጠቀም፦ /deposit 100")
        return

    amount = int(context.args[0])
    if amount <= 0:
        await update.message.reply_text("መጠኑ ከ0 በላይ መሆን አለበት።")
        return

    req_id = str(_next_request_id)
    _next_request_id += 1
    pending_deposits[req_id] = {
        "user_id": user.id,
        "name": user.first_name,
        "amount": amount,
    }

    await update.message.reply_text(
        "🕓 ጥያቄህ ወደ አድሚን ተልኳል፣ እስኪያረጋግጥ ጠብቅ።"
    )

    keyboard = InlineKeyboardMarkup(
        [
            [
                InlineKeyboardButton("✅ አጽድቅ", callback_data=f"dep_ok_{req_id}"),
                InlineKeyboardButton("❌ ውድቅ አድርግ", callback_data=f"dep_no_{req_id}"),
            ]
        ]
    )
    await context.bot.send_message(
        ADMIN_ID,
        f"🔔 አዲስ የነጥብ ጥያቄ\n"
        f"ተጫዋች፦ {user.first_name} (id: {user.id})\n"
        f"የተጠየቀ መጠን፦ {amount} ነጥብ",
        reply_markup=keyboard,
    )


async def deposit_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    if query.from_user.id != ADMIN_ID:
        await query.answer("ይህን ማድረግ የምትችለው አድሚን ብቻ ነው።", show_alert=True)
        return

    # data format: dep_ok_<id> or dep_no_<id>
    parts = query.data.split("_", 2)
    action = parts[1]  # "ok" or "no"
    req_id = parts[2]

    request = pending_deposits.pop(req_id, None)
    if not request:
        await query.edit_message_text("ይህ ጥያቄ ቀድሞ ተስተናግዷል ወይም አልተገኘም።")
        return

    user_id = request["user_id"]
    name = request["name"]
    amount = request["amount"]

    if action == "ok":
        change_balance(user_id, amount)
        await query.edit_message_text(f"✅ ጸድቋል፦ {name} ({amount} ነጥብ ተጨምሯል)")
        try:
            await context.bot.send_message(
                user_id, f"✅ ጥያቄህ ጸድቋል! {amount} ነጥብ ወደ ሂሳብህ ተጨምሯል።"
            )
        except Exception:
            pass
    else:
        await query.edit_message_text(f"❌ ውድቅ ተደርጓል፦ {name} ({amount} ነጥብ)")
        try:
            await context.bot.send_message(user_id, "❌ ጥያቄህ ውድቅ ተደርጓል።")
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Game commands
# ---------------------------------------------------------------------------

async def newgame(update: Update, context: ContextTypes.DEFAULT_TYPE):
    chat_id = update.effective_chat.id
    game = Game(chat_id=chat_id)
    games[chat_id] = game
    await update.message.reply_text(
        f"🆕 አዲስ ጨዋታ ተጀምሯል! ካርድ ዋጋ፦ {CARD_COST} ነጥብ። ለመግባት /join ተጫን።"
    )


async def join(update: Update, context: ContextTypes.DEFAULT_TYPE):
    chat_id = update.effective_chat.id
    user = update.effective_user
    game = get_game(chat_id)

    if game.running:
        await update.message.reply_text("ጨዋታው ተጀምሯል — ቀጣዩን ጨዋታ ጠብቅ።")
        return

    if user.id in game.players:
        await update.message.reply_text("ቀድሞውኑ ገብተሃል! /card ብለህ ካርድህን እይ።")
        return

    if get_balance(user.id) < CARD_COST:
        await update.message.reply_text(
            f"❌ በቂ ነጥብ የለህም (ያስፈልጋል፦ {CARD_COST})። /deposit <መጠን> ተጠቀም።"
        )
        return

    change_balance(user.id, -CARD_COST)
    game.pot += CARD_COST

    player = Player(user_id=user.id, name=user.first_name)
    player.card = generate_card()
    game.players[user.id] = player

    await update.message.reply_text(
        f"✅ ገብተሃል፣ {user.first_name}! ({CARD_COST} ነጥብ ተቀናሽ ተደርጓል)\n"
        f"ካርድህ፦\n{card_to_text(player.card, player.marked)}",
        parse_mode="Markdown",
    )

    if len(game.players) == 1:
        await update.message.reply_text(
            "ሌሎች እንዲገቡ /join እንዲጫኑ ንገራቸው። ጨዋታውን ለመጀመር /startcall ተጠቀም።"
        )


async def show_card(update: Update, context: ContextTypes.DEFAULT_TYPE):
    chat_id = update.effective_chat.id
    user = update.effective_user
    game = get_game(chat_id)
    player = game.players.get(user.id)
    if not player:
        await update.message.reply_text("መጀመሪያ /join በል።")
        return
    await update.message.reply_text(
        card_to_text(player.card, player.marked), parse_mode="Markdown"
    )


async def call_loop(chat_id: int, context: ContextTypes.DEFAULT_TYPE):
    game = games[chat_id]
    game.running = True
    while game.running and game.pool and not game.winner:
        await asyncio.sleep(CALL_INTERVAL_SECONDS)
        if not game.running:
            break
        num = random.choice(game.pool)
        game.pool.remove(num)
        game.called.append(num)
        letter = letter_for_number(num)
        for p in game.players.values():
            if num in [v for row in p.card for v in row]:
                p.marked.add(num)
        await context.bot.send_message(
            chat_id, f"📢 {letter}-{num}  (የተጠሩ፦ {len(game.called)})"
        )
    game.running = False


async def startcall(update: Update, context: ContextTypes.DEFAULT_TYPE):
    chat_id = update.effective_chat.id
    game = get_game(chat_id)
    if not game.players:
        await update.message.reply_text("መጀመሪያ ተጫዋቾች /join ማድረግ አለባቸው።")
        return
    if game.running:
        await update.message.reply_text("ጨዋታው አስቀድሞ እየሮጠ ነው።")
        return
    await update.message.reply_text(
        f"▶️ ጥሪ ተጀመረ! ቁጥሮች በየ {CALL_INTERVAL_SECONDS} ሰከንዱ ይጠራሉ። ሽልማት (pot)፦ {game.pot} ነጥብ"
    )
    game.task = asyncio.create_task(call_loop(chat_id, context))


async def stopgame(update: Update, context: ContextTypes.DEFAULT_TYPE):
    chat_id = update.effective_chat.id
    game = games.get(chat_id)
    if game:
        game.running = False
        games.pop(chat_id, None)
    await update.message.reply_text("⏹ ጨዋታው ቆሟል።")


async def bingo(update: Update, context: ContextTypes.DEFAULT_TYPE):
    chat_id = update.effective_chat.id
    user = update.effective_user
    game = get_game(chat_id)
    player = game.players.get(user.id)

    if not player:
        await update.message.reply_text("አልገባህም — /join አድርግ።")
        return

    if check_win(player.card, player.marked):
        game.running = False
        game.winner = player.name
        change_balance(user.id, game.pot)
        await update.message.reply_text(
            f"🎉 BINGO! {player.name} አሸነፈ! 🏆 ({game.pot} ነጥብ ተሸልሟል)"
        )
    else:
        await update.message.reply_text("❌ ገና አላሸነፍክም — ካርድህን አረጋግጥ።")


async def app_command(update, context):
    keyboard = InlineKeyboardMarkup(
        [
            [
                InlineKeyboardButton(
                    "🎮 ጨዋታ ክፈት",
                    web_app=WebAppInfo(
                        url="https://tomasabebawtom-create.github.io/Bingo-mini-app/bingo-mini-app-5-3.html"
                    ),
                )
            ]
        ]
    )
    await update.message.reply_text("ከታች ያለውን ይጫኑ:", reply_markup=keyboard)


def main():
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    if not token:
        raise SystemExit(
            "እባክህ TELEGRAM_BOT_TOKEN environment variable አስቀምጥ።\n"
            "ምሳሌ (Linux/Mac): export TELEGRAM_BOT_TOKEN=123456:ABC-yourtoken\n"
            "ምሳሌ (Windows PowerShell): $env:TELEGRAM_BOT_TOKEN='123456:ABC-yourtoken'"
        )

    app = Application.builder().token(token).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("balance", balance_cmd))
    app.add_handler(CommandHandler("deposit", deposit_cmd))
    app.add_handler(CallbackQueryHandler(deposit_callback, pattern=r"^dep_"))
    app.add_handler(CommandHandler("newgame", newgame))
    app.add_handler(CommandHandler("join", join))
    app.add_handler(CommandHandler("card", show_card))
    app.add_handler(CommandHandler("startcall", startcall))
    app.add_handler(CommandHandler("stopgame", stopgame))
    app.add_handler(CommandHandler("bingo", bingo))
    app.add_handler(CommandHandler("app", app_command))

    log.info("Bot starting (polling)...")
    app.run_polling()


if __name__ == "__main__":
    main()
