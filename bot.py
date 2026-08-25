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
import hmac
import hashlib
import threading
from urllib.parse import parse_qsl
from dataclasses import dataclass, field

import requests
from flask import Flask, request, jsonify

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
    MessageHandler,
    filters,
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
TELEBIRR_NUMBER = "0940501400"  # ገንዘብ የሚላክበት Telebirr ቁጥር


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

# pending withdrawal requests: request_id -> {user_id, name, amount, telebirr}
pending_withdrawals: dict[str, dict] = {}
_next_withdraw_id = 1


def get_balance(user_id: int) -> int:
    return balances.get(user_id, 0)


def change_balance(user_id: int, delta: int):
    balances[user_id] = get_balance(user_id) + delta
    save_balances(balances)


# ---------------------------------------------------------------------------
# Mini App HTTP API — lets bingo-mini-app-5-3.html read/request balances.
# Verifies Telegram's WebApp `initData` so no one can fake another user's ID.
# Runs in a background thread alongside the bot's polling loop.
# ---------------------------------------------------------------------------

BOT_TOKEN_FOR_API = os.environ.get("TELEGRAM_BOT_TOKEN", "")
api_app = Flask(__name__)


@api_app.after_request
def _add_cors_headers(resp):
    # Needed because the mini app is served from GitHub Pages (a different
    # origin) and calls this API directly from the browser.
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return resp


def verify_init_data(init_data: str):
    """Validate Telegram WebApp initData and return its fields, or None if invalid/faked."""
    if not init_data or not BOT_TOKEN_FOR_API:
        return None
    try:
        parsed = dict(parse_qsl(init_data, strict_parsing=True))
    except ValueError:
        return None
    received_hash = parsed.pop("hash", None)
    if not received_hash:
        return None
    data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(parsed.items()))
    secret_key = hmac.new(b"WebAppData", BOT_TOKEN_FOR_API.encode(), hashlib.sha256).digest()
    calculated_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(calculated_hash, received_hash):
        return None
    return parsed


def user_id_from_init_data(init_data: str):
    fields = verify_init_data(init_data)
    if not fields:
        return None
    try:
        user = json.loads(fields.get("user", "{}"))
        return int(user["id"])
    except Exception:
        return None


def notify_admin_of_deposit_request(req_id: str, name: str, user_id: int, amount: int):
    """Same admin approval message as /deposit, sent via plain HTTP (this runs outside the bot's asyncio loop)."""
    keyboard = {
        "inline_keyboard": [[
            {"text": "✅ አጽድቅ", "callback_data": f"dep_ok_{req_id}"},
            {"text": "❌ ውድቅ አድርግ", "callback_data": f"dep_no_{req_id}"},
        ]]
    }
    requests.post(
        f"https://api.telegram.org/bot{BOT_TOKEN_FOR_API}/sendMessage",
        json={
            "chat_id": ADMIN_ID,
            "text": (
                f"🔔 አዲስ የነጥብ ጥያቄ (ከ mini app)\n"
                f"ተጫዋች፦ {name} (id: {user_id})\n"
                f"የተጠየቀ መጠን፦ {amount} ነጥብ"
            ),
            "reply_markup": json.dumps(keyboard),
        },
        timeout=10,
    )


@api_app.route("/api/balance", methods=["GET", "OPTIONS"])
def api_balance():
    if request.method == "OPTIONS":
        return "", 204
    init_data = request.args.get("initData", "")
    user_id = user_id_from_init_data(init_data)
    if user_id is None:
        return jsonify({"error": "invalid initData"}), 401
    return jsonify({"balance": get_balance(user_id)})


@api_app.route("/api/deposit", methods=["POST", "OPTIONS"])
def api_deposit():
    global _next_request_id
    if request.method == "OPTIONS":
        return "", 204
    body = request.get_json(force=True, silent=True) or {}
    user_id = user_id_from_init_data(body.get("initData", ""))
    if user_id is None:
        return jsonify({"error": "invalid initData"}), 401

    amount = body.get("amount")
    if not isinstance(amount, int) or amount <= 0:
        return jsonify({"error": "invalid amount"}), 400

    try:
        name = json.loads(verify_init_data(body["initData"])["user"]).get("first_name", "ተጫዋች")
    except Exception:
        name = "ተጫዋች"

    req_id = str(_next_request_id)
    _next_request_id += 1
    pending_deposits[req_id] = {"user_id": user_id, "name": name, "amount": amount}

    notify_admin_of_deposit_request(req_id, name, user_id, amount)
    return jsonify({"status": "pending", "telebirr_number": TELEBIRR_NUMBER})


def run_api_server():
    port = int(os.environ.get("PORT", 8080))
    api_app.run(host="0.0.0.0", port=port)


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


SUPPORT_USERNAME = "your_support_username"  # <-- የድጋፍ አካውንትህን ዩዘርኔም እዚህ ቀይር


def build_main_menu() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([
        [
            InlineKeyboardButton("Play 🎮", callback_data="menu_play"),
            InlineKeyboardButton("Register 📝", callback_data="menu_register"),
        ],
        [
            InlineKeyboardButton("Check Balance 💵", callback_data="menu_balance"),
            InlineKeyboardButton("Deposit 💵", callback_data="menu_deposit"),
        ],
        [
            InlineKeyboardButton("Contact Support ☎️", callback_data="menu_support"),
            InlineKeyboardButton("Instruction 📖", callback_data="menu_instruction"),
        ],
        [
            InlineKeyboardButton("Transfer 🎁", callback_data="menu_transfer"),
            InlineKeyboardButton("Withdraw 🤑", callback_data="menu_withdraw"),
        ],
        [
            InlineKeyboardButton("Invite 🔗", callback_data="menu_invite"),
            InlineKeyboardButton("Convert Bonus 🎫", callback_data="menu_convert"),
        ],
    ])


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "👋 እንኳን ወደ 1 Bingo በደህና መጡ! ከታች ካለው ምረጥ፦",
        reply_markup=build_main_menu(),
    )


async def menu_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    action = query.data
    user = query.from_user

    if action == "menu_play":
        keyboard = InlineKeyboardMarkup([[
            InlineKeyboardButton(
                "🎮 ጨዋታ ክፈት",
                web_app=WebAppInfo(
                    url="https://tomasabebawtom-create.github.io/Bingo-mini-app/bingo-mini-app-5-3.html"
                ),
            )
        ]])
        await query.message.reply_text("ከታች ያለውን ተጫን፦", reply_markup=keyboard)

    elif action == "menu_register":
        await query.message.reply_text(
            "✅ ስትጠቀም በራስሰር ተመዝግበሃል — ተጨማሪ ምዝገባ አያስፈልግም።"
        )

    elif action == "menu_balance":
        bal = get_balance(user.id)
        await query.message.reply_text(f"💰 ሂሳብህ፦ {bal} ነጥብ")

    elif action == "menu_deposit":
        context.user_data["awaiting_deposit"] = True
        await query.message.reply_text(
            "💳 እባክህ የምትፈልገውን የነጥብ መጠን (ቁጥር ብቻ) ላክ።\nለምሳሌ፦ 100"
        )

    elif action == "menu_support":
        await query.message.reply_text(
            f"☎️ ድጋፍ ለማግኘት አግኙን፦ @{SUPPORT_USERNAME}"
        )

    elif action == "menu_instruction":
        await query.message.reply_text(
            "📖 አጨዋወት፦\n"
            "1️⃣ /deposit ብለህ ነጥብ ግዛ\n"
            "2️⃣ /newgame ወይም /join ብለህ ወደ ጨዋታ ግባ\n"
            "3️⃣ ቁጥሮች ሲጠሩ ካርድህ ላይ ያለውን አረጋግጥ\n"
            "4️⃣ ስታሸንፍ /bingo በል"
        )

    elif action == "menu_transfer":
        await query.message.reply_text("🎁 Transfer ገና በዝግጅት ላይ ነው — በቅርቡ ይመጣል።")

    elif action == "menu_withdraw":
        await query.message.reply_text(
            "🤑 ገንዘብ ወጪ ለማድረግ፦ `/withdraw <መጠን> <telebirr ቁጥር>` ብለህ ጻፍ።\n"
            "ለምሳሌ፦ `/withdraw 100 0912345678`",
            parse_mode="Markdown",
        )

    elif action == "menu_invite":
        me = await context.bot.get_me()
        await query.message.reply_text(
            f"🔗 ጓደኞችህን ጋብዝ፦ https://t.me/{me.username}"
        )

    elif action == "menu_convert":
        await query.message.reply_text("🎫 Convert Bonus ገና በዝግጅት ላይ ነው — በቅርቡ ይመጣል።")


# ---------------------------------------------------------------------------
# Balance / deposit commands
# ---------------------------------------------------------------------------

async def balance_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    bal = get_balance(user.id)
    await update.message.reply_text(f"💰 ሂሳብህ፦ {bal} ነጥብ")


async def process_deposit_request(user, amount: int, context: ContextTypes.DEFAULT_TYPE, reply_target):
    """Create a pending deposit request and notify the admin.
    reply_target must have a .reply_text() coroutine (update.message or query.message)."""
    global _next_request_id

    if amount <= 0:
        await reply_target.reply_text("መጠኑ ከ0 በላይ መሆን አለበት።")
        return

    req_id = str(_next_request_id)
    _next_request_id += 1
    pending_deposits[req_id] = {
        "user_id": user.id,
        "name": user.first_name,
        "amount": amount,
    }

    await reply_target.reply_text(
        f"🕓 ጥያቄህ ወደ አድሚን ተልኳል።\n\n"
        f"💳 {amount} ብር ወደዚህ Telebirr ቁጥር ላክ፦\n"
        f"📱 `{TELEBIRR_NUMBER}`\n\n"
        f"ከላክህ በኋላ አድሚን አረጋግጦ ነጥብህን ይጨምርልሃል።",
        parse_mode="Markdown",
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


async def deposit_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user

    if not context.args or not context.args[0].isdigit():
        context.user_data["awaiting_deposit"] = True
        await update.message.reply_text(
            "💳 እባክህ የምትፈልገውን የነጥብ መጠን (ቁጥር ብቻ) ላክ።\nለምሳሌ፦ 100"
        )
        return

    amount = int(context.args[0])
    await process_deposit_request(user, amount, context, update.message)


async def handle_plain_text(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Catches plain replies after a button/command asked the user for input
    (currently: the deposit amount)."""
    if not context.user_data.get("awaiting_deposit"):
        return

    text = (update.message.text or "").strip()
    if text.isdigit() and int(text) > 0:
        context.user_data["awaiting_deposit"] = False
        await process_deposit_request(update.effective_user, int(text), context, update.message)
    else:
        await update.message.reply_text("እባክህ ትክክለኛ ቁጥር ብቻ ላክ (ለምሳሌ፦ 100)።")


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
# Withdraw commands
# ---------------------------------------------------------------------------

async def withdraw_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    global _next_withdraw_id
    user = update.effective_user

    if len(context.args) < 2 or not context.args[0].isdigit():
        await update.message.reply_text(
            "እንዲህ ተጠቀም፦ /withdraw <መጠን> <telebirr ቁጥር>\nለምሳሌ፦ /withdraw 100 0912345678"
        )
        return

    amount = int(context.args[0])
    telebirr = context.args[1]
    if amount <= 0:
        await update.message.reply_text("መጠኑ ከ0 በላይ መሆን አለበት።")
        return

    if get_balance(user.id) < amount:
        await update.message.reply_text(
            f"❌ በቂ ነጥብ የለህም። ሂሳብህ፦ {get_balance(user.id)} ነጥብ"
        )
        return

    # Hold the funds immediately so the user can't request the same points twice.
    change_balance(user.id, -amount)

    req_id = str(_next_withdraw_id)
    _next_withdraw_id += 1
    pending_withdrawals[req_id] = {
        "user_id": user.id,
        "name": user.first_name,
        "amount": amount,
        "telebirr": telebirr,
    }

    await update.message.reply_text(
        f"🕓 የወጪ ጥያቄህ ወደ አድሚን ተልኳል፣ እስኪያረጋግጥ ጠብቅ።\n"
        f"({amount} ነጥብ ከሂሳብህ ላይ ተይዟል)"
    )

    keyboard = InlineKeyboardMarkup(
        [
            [
                InlineKeyboardButton("✅ አጽድቅ", callback_data=f"wd_ok_{req_id}"),
                InlineKeyboardButton("❌ ውድቅ አድርግ", callback_data=f"wd_no_{req_id}"),
            ]
        ]
    )
    await context.bot.send_message(
        ADMIN_ID,
        f"🔔 አዲስ የወጪ ጥያቄ\n"
        f"ተጫዋች፦ {user.first_name} (id: {user.id})\n"
        f"የተጠየቀ መጠን፦ {amount} ነጥብ\n"
        f"Telebirr ቁጥር፦ {telebirr}",
        reply_markup=keyboard,
    )


async def withdraw_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    if query.from_user.id != ADMIN_ID:
        await query.answer("ይህን ማድረግ የምትችለው አድሚን ብቻ ነው።", show_alert=True)
        return

    # data format: wd_ok_<id> or wd_no_<id>
    parts = query.data.split("_", 2)
    action = parts[1]  # "ok" or "no"
    req_id = parts[2]

    request = pending_withdrawals.pop(req_id, None)
    if not request:
        await query.edit_message_text("ይህ ጥያቄ ቀድሞ ተስተናግዷል ወይም አልተገኘም።")
        return

    user_id = request["user_id"]
    name = request["name"]
    amount = request["amount"]
    telebirr = request["telebirr"]

    if action == "ok":
        # Funds were already deducted when the request was made — admin now
        # sends the money manually to the user's Telebirr number.
        await query.edit_message_text(
            f"✅ ጸድቋል፦ {name} — {amount} ነጥብ ({telebirr}) ላይ ገንዘቡን በእጅ ላክ"
        )
        try:
            await context.bot.send_message(
                user_id,
                f"✅ የወጪ ጥያቄህ ጸድቋል! {amount} ነጥብ ወደ {telebirr} ተልኳል።",
            )
        except Exception:
            pass
    else:
        # Refund the held points back to the user.
        change_balance(user_id, amount)
        await query.edit_message_text(f"❌ ውድቅ ተደርጓል፦ {name} ({amount} ነጥብ ተመልሷል)")
        try:
            await context.bot.send_message(
                user_id, f"❌ የወጪ ጥያቄህ ውድቅ ተደርጓል። {amount} ነጥብ ወደ ሂሳብህ ተመልሷል።"
            )
        except Exception:
            pass


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

    threading.Thread(target=run_api_server, daemon=True).start()
    log.info("Mini app API server starting on port %s...", os.environ.get("PORT", 8080))

    app = Application.builder().token(token).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CallbackQueryHandler(menu_callback, pattern=r"^menu_"))
    app.add_handler(CommandHandler("balance", balance_cmd))
    app.add_handler(CommandHandler("deposit", deposit_cmd))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_plain_text))
    app.add_handler(CallbackQueryHandler(deposit_callback, pattern=r"^dep_"))
    app.add_handler(CommandHandler("withdraw", withdraw_cmd))
    app.add_handler(CallbackQueryHandler(withdraw_callback, pattern=r"^wd_"))
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
