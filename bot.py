import os
import telebot
from telebot import types
import requests
import logging
import threading
import time
import schedule

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
TOKEN = os.environ.get('TELEGRAM_BOT_TOKEN')

# ✅ Proxy ማዋቀሪያ — Telegram API traffic ብቻ በዚህ በኩል ያልፋል
# TELEGRAM_PROXY_URL environment variable ካላስቀመጥክ ቦቱ ያለ proxy ይሞክራል
# (እና VPN ካላበራህ Telegram block ሊገጥመው ይችላል)።
PROXY_URL = os.environ.get('TELEGRAM_PROXY_URL')  # ለምሳሌ: socks5://user:pass@1.2.3.4:1080
if PROXY_URL:
    telebot.apihelper.proxy = {'https': PROXY_URL}
    logger.info("Bot using proxy for Telegram API.")
else:
    logger.warning("No TELEGRAM_PROXY_URL set — Telegram API might be blocked without VPN.")

bot = telebot.TeleBot(TOKEN)

# የአድሚኖች Telegram user ID ዝርዝር - እነዚህ ብቻ ናቸው ተቀማጭ የሚያጸድቁት
# የራስህን ID ለማወቅ ቦቱ ላይ /myid ብቻ ላክ
ADMIN_IDS = [8706330167]  # <-- ካገኘህ በኋላ እዚህ ተካ
TELEBIRR_NUMBER = '0999792114'

# ✅ ወደ ትክክለኛው production backend (Render) ቀጥታ ይጠቁማል።
SERVER_URL = 'https://bingo-mini-app-1.onrender.com/api'
# ✅ ተስተካክሏል፦ Render free tier cold start እስከ 30-50 ሰከንድ ሊወስድ ስለሚችል
# REQUEST_TIMEOUT ከ 8 ወደ 30 ሰከንድ ከፍ ብሏል፣ ያለጊዜው timeout እንዳይፈጠር።
REQUEST_TIMEOUT = 30

# Spin Win mini app URL — Render ላይ ቀጥታ (live) የተሰቀለው ገጽ
SPIN_WIN_URL = 'https://bingo-mini-app-1.onrender.com'

# ✅ አዲስ፦ Backend ላይ ካለው ADMIN_SECRET ጋር ተመሳሳይ የሆነ secret።
# ይህ ከሌለ backend ማንኛውንም admin-only ጥያቄ (deposit/withdraw confirm/reject)
# 401/503 ይላል፣ ስለዚህ ይህ environment variable በ Render (ወይም bot ያለበት
# hosting) ላይ መዘጋጀት አለበት — ልክ ከ backend ጋር ተመሳሳይ ዋጋ ይዞ።
ADMIN_SECRET = os.environ.get('ADMIN_SECRET', '')
ADMIN_HEADERS = {"x-admin-secret": ADMIN_SECRET}

if not ADMIN_SECRET:
    logger.warning("ADMIN_SECRET is not set! Admin confirm/reject requests will fail against the backend.")


# ================================================================
# በቀን 3 ጊዜ ማስታወቂያ — @Spinwin03 ቻናል ላይ በራስ-ሰር የሚለጠፍ
# ================================================================
CHANNEL_USERNAME = "@Spinwin03"

MORNING_MESSAGE = (
    "☀️ እንደምን አደራችሁ ጨዋታ ወዳዶች!\n\n"
    "🎡 አዲስ ቀን፣ አዲስ እድል! Spin Win ዛሬም ተከፍቷል፣ ጎማውን አዙረህ ቁጥርህን ምረጥ።\n\n"
    "💰 በትንሽ ብር ጀምር፣ ትልቅ እድል ጠብቅ። ማለዳ ማለዳ የሚጫወቱ ብዙ ጊዜ ቀኑን በጥሩ ስሜት ይጀምራሉ ይባላል! 😄\n\n"
    "👉 አሁኑኑ ግባ እና ጎማውን አዙር: @BingotomBot"
)

AFTERNOON_MESSAGE = (
    "🕧 የቀትር እረፍትህን ከ Spin Win ጋር አሳልፍ!\n\n"
    "🎡 ስራ ላይ ወይም ቤት ሆነህ፣ ከስልክህ ላይ በ2 ደቂቃ ውስጥ መጫወት ትችላለህ።\n\n"
    "🔥 ቁጥር ምረጥ፣ ትኬት ቁረጥ፣ ውጤቱን ጠብቅ - ቀላል፣ ፈጣን፣ አጓጊ!\n\n"
    "👉 አሁኑኑ ተቀላቀል: @BingotomBot"
)

EVENING_MESSAGE = (
    "🌙 ቀኑን በደንብ ልታጠናቅቀው ትፈልጋለህ?\n\n"
    "🎡 Spin Win ምሽት ላይም ክፍት ነው! ከቀኑ ስራ በኋላ ትንሽ ዘና በል፣ ጎማውን አዙር፣ እድልህን ሞክር።\n\n"
    "✨ ዛሬ ካልተጫወትክ፣ ነገ ሌላ እድል አለ - ግን ዛሬ ማታ ለምን አትሞክርም?\n\n"
    "👉 አሁኑኑ ጫወት: @BingotomBot"
)


def post_to_channel(message_text):
    try:
        bot.send_message(CHANNEL_USERNAME, message_text)
        logger.info("Channel announcement posted.")
    except Exception as e:
        logger.error(f"Failed to post channel announcement: {e}")


def run_scheduler():
    """ይሄ በተለየ thread ውስጥ ያለማቋረጥ ይሮጣል፣ bot.polling() ን አያስተጓጉልም።
    ጊዜው የሚሰላው ሰርቨሩ (Render) በሚጠቀመው ሰዓት ነው - Render በ UTC ይሮጣል፣
    ስለዚህ ከታች ያሉት ሰዓቶች ወደ UTC ተቀይረዋል፦
      08:00 አዲስ አበባ → 05:00 UTC
      12:30 አዲስ አበባ → 09:30 UTC
      20:00 አዲስ አበባ → 17:00 UTC
    """
    schedule.every().day.at("05:00").do(post_to_channel, MORNING_MESSAGE)
    schedule.every().day.at("09:30").do(post_to_channel, AFTERNOON_MESSAGE)
    schedule.every().day.at("17:00").do(post_to_channel, EVENING_MESSAGE)

    while True:
        schedule.run_pending()
        time.sleep(30)


def set_bot_commands():
    """
    ✅ አዲስ፦ Telegram's native "Menu" ዝርዝር (☰ Menu ሲነካ የሚታየው) 
    አሁን በ English ብቻ እንዲፃፍ ተደርጓል።
    """
    commands = [
        types.BotCommand("start", "Start"),
        types.BotCommand("register", "Register"),
        types.BotCommand("play", "Play Game"),
        types.BotCommand("deposit", "Deposit"),
        types.BotCommand("balance", "Check Balance"),
        types.BotCommand("withdraw", "Withdraw"),
        types.BotCommand("invite", "Invite"),
        types.BotCommand("support", "Contact Support"),
    ]
    try:
        bot.set_my_commands(commands)
    except Exception as e:
        logger.error(f"Failed to set bot commands: {e}")


def is_admin(user_id):
    return user_id in ADMIN_IDS


def is_command(message):
    """
    ተጠቃሚው በ deposit/withdraw ፍሰት መሃል ላይ ሆኖ '/' በሚጀምር
    ትዕዛዝ (ለምሳሌ /start, /deposit, /newgame) ቢልክ True ይመልሳል።
    ይህ register_next_step_handler ን ለማቋረጥ ይጠቅማል፣
    ስለዚህ ትዕዛዞች እንደ "የገንዘብ መጠን" ወይም "ስልክ ቁጥር" ተደርገው አይያዙም።
    """
    return bool(message.text) and message.text.startswith('/')


def build_main_menu():
    """
    ✅ ወደነበረበት ተመልሷል፦ /start ሲላክ ሙሉ ፍርግርግ (grid) ቁልፎች ይላካሉ።
    "Play / Spin Win" ብቻ web_app ቁልፍ ነው (mini app ስለሆነ)፣
    የቀሩት ደግሞ callback_data ቁልፎች ናቸው።
    """
    markup = types.InlineKeyboardMarkup(row_width=2)
    markup.add(
        types.InlineKeyboardButton("🎡 Play / Spin Win", web_app=types.WebAppInfo(SPIN_WIN_URL)),
        types.InlineKeyboardButton("📝 Register", callback_data="register"),
    )
    markup.add(
        types.InlineKeyboardButton("💵 Check Balance", callback_data="check_balance"),
        types.InlineKeyboardButton("💵 Deposit", callback_data="deposit"),
    )
    markup.add(
        types.InlineKeyboardButton("☎️ Contact Support", callback_data="support"),
    )
    markup.add(
        types.InlineKeyboardButton("🤑 Withdraw", callback_data="withdraw"),
    )
    markup.add(
        types.InlineKeyboardButton("🔗 Invite", callback_data="invite"),
    )
    return markup


@bot.message_handler(commands=['start'])
def send_welcome(message):
    text = (
        "👋 እንኳን ደህና መጡ ወደ 1 Bingo!\n\n"
        "🎡 ለመጫወት ከታች ካሉት ቁልፎች ይምረጡ፣ ወይም ☰ Menu ውስጥ ካሉት ትዕዛዞች ይጠቀሙ።"
    )
    bot.send_message(message.chat.id, text, reply_markup=build_main_menu())


@bot.message_handler(commands=['play'])
def open_spin_win(message):
    markup = types.InlineKeyboardMarkup()
    markup.add(types.InlineKeyboardButton("🎡 Spin Win ክፈት", web_app=types.WebAppInfo(SPIN_WIN_URL)))
    bot.send_message(message.chat.id, "🎡 Spin Win ለመጫወት ከታች ይጫኑ፡", reply_markup=markup)


@bot.message_handler(commands=['balance'])
def check_balance_command(message):
    user_id = str(message.from_user.id)
    try:
        resp = requests.get(f"{SERVER_URL}/balance/{user_id}", timeout=REQUEST_TIMEOUT)
        if resp.status_code == 200:
            bal = resp.json().get('balance', 0)
            bot.send_message(message.chat.id, f"💰 የኪስ ቦርሳ ሂሳብዎ: {bal} ብር ነው።")
        else:
            logger.error(f"Balance check failed: {resp.status_code} - {resp.text}")
            bot.send_message(message.chat.id, "ሂሳብ ማግኘት አልተቻለም።")
    except requests.exceptions.RequestException as e:
        logger.error(f"Balance check connection failed: {e}")
        bot.send_message(message.chat.id, "ከሰርቨሩ ጋር መገናኘት አልተቻለም።")


@bot.message_handler(commands=['deposit'])
def deposit_command(message):
    msg = bot.send_message(
        message.chat.id,
        "💰 ማስገባት የሚፈልጉትን መጠን ከ10 ብር ጀምሮ ያስገቡ።"
    )
    bot.register_next_step_handler(msg, process_deposit_amount)


@bot.message_handler(commands=['withdraw'])
def withdraw_command(message):
    msg = bot.send_message(
        message.chat.id,
        "💵\nማውጣት የምትፈልገውን ብር መጠን ፃፍ"
    )
    bot.register_next_step_handler(msg, process_withdraw_amount)


@bot.message_handler(commands=['register'])
def register_command(message):
    bot.send_message(message.chat.id, "📝 Register: 📱 ተመዝግበዋል")


@bot.message_handler(commands=['support'])
def support_command(message):
    bot.send_message(message.chat.id, "☎️ Contact Support: 👩‍💻@seeyou1m")


@bot.message_handler(commands=['invite'])
def invite_command(message):
    bot.send_message(message.chat.id, "🔗 Invite: https://t.me/+pX81moWwpUExNGJk")


@bot.message_handler(commands=['myid'])
def send_my_id(message):
    uid = message.from_user.id
    uname = message.from_user.username or "(username የለውም)"
    bot.send_message(
        message.chat.id,
        f"🆔 የ Telegram ID ያንተ: `{uid}`\n"
        f"👤 Username: @{uname}\n\n"
        f"ይህን ID bot.py ውስጥ ADMIN_IDS ላይ እና deposit-routes.js ውስጥ ADMIN_IDS ላይ ተካ።",
        parse_mode="Markdown"
    )


@bot.message_handler(commands=['confirm', 'reject'])
def confirm_or_reject_command(message):
    admin_id = message.from_user.id

    if not is_admin(admin_id):
        bot.send_message(
        message.chat.id, "⛔ ይህን የማድረግ ፍቃድ የለዎትም።")
        return

    parts = message.text.split()
    if len(parts) != 2:
        bot.send_message(
        message.chat.id, "❌ አጠቃቀም: /confirm <order_id>  ወይም  /reject <order_id>")
        return

    order_id = parts[1]
    approve = message.text.startswith('/confirm')
    endpoint = "confirm" if approve else "reject"

    try:
        response = requests.post(
            f"{SERVER_URL}/deposit/{endpoint}",
            json={"orderId": order_id, "adminId": str(admin_id)},
            headers=ADMIN_HEADERS,
            timeout=REQUEST_TIMEOUT
        )

        if response.status_code == 200:
            data = response.json()
            status_text = "✅ ጸድቋል" if approve else "❌ ውድቅ ተደርጓል"
            bot.send_message(
        message.chat.id, f"{status_text} — Order #{order_id}")

            user_id = data.get('userId')
            if approve:
                new_balance = data.get('balance')
                bot.send_message(
                    int(user_id),
                    f"✅ ተቀማጭዎ ጸድቋል! አዲሱ ሂሳብዎ: {new_balance} ብር ነው።"
                )
            else:
                bot.send_message(
                    int(user_id),
                    "❌ ተቀማጭዎ ውድቅ ተደርጓል። ለበለጠ መረጃ Support ያግኙ።"
                )
        elif response.status_code == 401 or response.status_code == 503:
            logger.error(f"Admin auth failed: {response.status_code} - {response.text}")
            bot.send_message(
        message.chat.id, "⛔ የአድሚን ማረጋገጫ (ADMIN_SECRET) ትክክል አይደለም ወይም አልተዘጋጀም። ከ backend ጋር አረጋግጥ።")
        elif response.status_code == 404:
            bot.send_message(
        message.chat.id, f"❌ Order #{order_id} አልተገኘም።")
        elif response.status_code == 409:
            bot.send_message(
        message.chat.id, "ይህ ትዕዛዝ አስቀድሞ ተስተናግዷል።")
        else:
            logger.error(f"Admin command decision failed: {response.status_code} - {response.text}")
            bot.send_message(
        message.chat.id, f"ስህተት ተፈጥሯል። (Code: {response.status_code})")

    except requests.exceptions.RequestException as e:
        logger.error(f"Admin command decision failed: {e}")
        bot.send_message(
        message.chat.id, "ከሰርቨሩ ጋር መገናኘት አልተቻለም።")


@bot.callback_query_handler(func=lambda call: True)
def callback_query(call):
    if call.data == "deposit":
        bot.answer_callback_query(call.id)
        msg = bot.send_message(
            call.message.chat.id,
            "💰 ማስገባት የሚፈልጉትን መጠን ከ10 ብር ጀምሮ ያስገቡ።"
        )
        bot.register_next_step_handler(msg, process_deposit_amount)

    elif call.data == "check_balance":
        user_id = str(call.from_user.id)
        try:
            resp = requests.get(f"{SERVER_URL}/balance/{user_id}", timeout=REQUEST_TIMEOUT)
            if resp.status_code == 200:
                bal = resp.json().get('balance', 0)
                bot.answer_callback_query(call.id)
                bot.send_message(call.message.chat.id, f"💰 የኪስ ቦርሳ ሂሳብዎ: {bal} ብር ነው።")
            else:
                logger.error(f"Balance check failed: {resp.status_code} - {resp.text}")
                bot.answer_callback_query(call.id, "ሂሳብ ማግኘት አልተቻለም።")
        except requests.exceptions.RequestException as e:
            logger.error(f"Balance check connection failed: {e}")
            bot.answer_callback_query(call.id, "ከሰርቨሩ ጋር መገናኘት አልተቻለም።")

    elif call.data == "withdraw":
        bot.answer_callback_query(call.id)
        msg = bot.send_message(
            call.message.chat.id,
            "💵\nማውጣት የምትፈልገውን ብር መጠን ፃፍ"
        )
        bot.register_next_step_handler(msg, process_withdraw_amount)

    elif call.data == "support":
        bot.answer_callback_query(call.id)
        bot.send_message(call.message.chat.id, "☎️ Contact Support: 👩‍💻@seeyou1m")

    elif call.data == "invite":
        bot.answer_callback_query(call.id)
        bot.send_message(call.message.chat.id, "🔗 Invite: https://t.me/+pX81moWwpUExNGJk")

    elif call.data == "register":
        bot.answer_callback_query(call.id)
        bot.send_message(
            call.message.chat.id,
            "📝 Register: 📱 ተመዝግበዋል"
        )

    elif call.data.startswith("approve_"):
        handle_admin_decision(call, approve=True)
    elif call.data.startswith("reject_"):
        handle_admin_decision(call, approve=False)
    elif call.data.startswith("wapprove_"):
        handle_withdraw_decision(call, approve=True)
    elif call.data.startswith("wreject_"):
        handle_withdraw_decision(call, approve=False)


def process_withdraw_amount(message):
    if is_command(message):
        bot.clear_step_handler_by_chat_id(message.chat.id)
        bot.process_new_messages([message])
        return

    try:
        amount = float(message.text)
        if amount <= 0:
            bot.send_message(
        message.chat.id, "❌ መጠኑ ከዜሮ በላይ መሆን አለበት።")
            return
    except ValueError:
        bot.send_message(
        message.chat.id, "❌ እባክዎ ትክክለኛ የቁጥር መጠን ብቻ ይላኩ (ለምሳሌ: 100)")
        return

    msg = bot.send_message(
        message.chat.id,
        "📱 ገንዘቡ የሚላክበትን የቴሌብር ስልክ ቁጥር ላክ 09"
    )
    bot.register_next_step_handler(msg, process_withdraw_phone, amount)


def process_withdraw_phone(message, amount):
    if is_command(message):
        bot.clear_step_handler_by_chat_id(message.chat.id)
        bot.process_new_messages([message])
        return

    phone = message.text.strip()

    if not phone.isdigit() or len(phone) < 9:
        msg = bot.send_message(
        message.chat.id,
            "❌ ትክክለኛ የስልክ ቁጥር አልላኩም። እባክዎ ቁጥሮች ብቻ ይላኩ (ለምሳሌ: 0912345678)"
        )
        bot.register_next_step_handler(msg, process_withdraw_phone, amount)
        return

    try:
        user_id = str(message.from_user.id)
        username = message.from_user.username or message.from_user.first_name

        response = requests.post(
            f"{SERVER_URL}/withdraw/request",
            json={"userId": user_id, "amount": amount, "phone": phone},
            timeout=REQUEST_TIMEOUT
        )

        if response.status_code != 200:
            # ✅ ተስተካክሏል፦ ትክክለኛው status code እና response body log ውስጥ ይታያል
            logger.error(f"Withdraw request failed: {response.status_code} - {response.text}")
            try:
                err = response.json().get('error', 'ጥያቄ መፍጠር አልተቻለም።')
            except ValueError:
                err = 'ጥያቄ መፍጠር አልተቻለም።'
            bot.send_message(
        message.chat.id, f"❌ {err}")
            return

        data = response.json()
        order_id = data.get('orderId')
        new_balance = data.get('balance')

        bot.send_message(
        message.chat.id,
            f"⏱ የማውጣት ጥያቄዎ ተመዝግቧል (#{order_id})።\n"
            f"💰 አዲሱ ቀሪ ሂሳብዎ: {new_balance} ብር\n"
            f"📱 ገንዘቡ ወደ: {phone} ይላካል"
        )

        admin_markup = types.InlineKeyboardMarkup()
        admin_markup.add(
            types.InlineKeyboardButton("✅ Approve", callback_data=f"wapprove_{order_id}"),
            types.InlineKeyboardButton("❌ Reject", callback_data=f"wreject_{order_id}"),
        )
        for admin_id in ADMIN_IDS:
            try:
                bot.send_message(
                    admin_id,
                    f"🔔 አዲስ የማውጣት ጥያቄ\n\n"
                    f"Order: #{order_id}\n"
                    f"User: @{username} (ID: {user_id})\n"
                    f"Amount: {amount} ብር\n"
                    f"📱 Phone (Telebirr): {phone}\n\n"
                    f"ገንዘቡን በ Telebirr ከላኩ በኋላ Approve ይምረጡ:",
                    reply_markup=admin_markup
                )
            except Exception as e:
                logger.error(f"Failed to notify admin {admin_id}: {e}")

    except requests.exceptions.RequestException as e:
        logger.error(f"Server connection failed: {e}")
        bot.send_message(
        message.chat.id, "❌ ከሰርቨሩ ጋር መገናኘት አልተቻለም። እባክዎ ቆይተው ይሞክሩ።")


def handle_withdraw_decision(call, approve):
    admin_id = call.from_user.id

    if not is_admin(admin_id):
        bot.answer_callback_query(call.id, "⛔ ይህን የማድረግ ፍቃድ የለዎትም።", show_alert=True)
        return

    # ✅ ወዲያውኑ callback ን መልስ (backend request ከመላክ በፊት)፣
    # Render cold-start ቢዘገይ እንኳን "query too old" እንዳይሆን
    bot.answer_callback_query(call.id, "⏳ በመስራት ላይ...")

    order_id = call.data.split("_", 1)[1]
    endpoint = "confirm" if approve else "reject"

    try:
        response = requests.post(
            f"{SERVER_URL}/withdraw/{endpoint}",
            json={"orderId": order_id, "adminId": str(admin_id)},
            headers=ADMIN_HEADERS,
            timeout=REQUEST_TIMEOUT
        )

        if response.status_code == 200:
            data = response.json()
            status_text = "✅ ተልኳል" if approve else "❌ ውድቅ ተደርጓል (ገንዘብ ተመልሷል)"
            bot.edit_message_text(
                chat_id=call.message.chat.id,
                message_id=call.message.message_id,
                text=call.message.text + f"\n\n{status_text} በ @{call.from_user.username}"
            )

            user_id = data.get('userId')
            new_balance = data.get('balance')
            if approve:
                bot.send_message(
                    int(user_id),
                    f"✅ የማውጣት ጥያቄዎ ጸድቋል! ገንዘቡ ወደ Telebirr ተልኳል።"
                )
            else:
                bot.send_message(
                    int(user_id),
                    f"❌ የማውጣት ጥያቄዎ ውድቅ ተደርጓል። ገንዘቡ ወደ ሂሳብዎ ተመልሷል (አዲሱ ቀሪ ሂሳብ: {new_balance} ብር)።"
                )
        elif response.status_code == 401 or response.status_code == 503:
            logger.error(f"Admin auth failed: {response.status_code} - {response.text}")
            bot.send_message(call.message.chat.id, "⛔ የአድሚን ማረጋገጫ (ADMIN_SECRET) ትክክል አይደለም ወይም አልተዘጋጀም።")
        elif response.status_code == 409:
            bot.send_message(call.message.chat.id, "ይህ ትዕዛዝ አስቀድሞ ተስተናግዷል።")
        else:
            logger.error(f"Withdraw decision failed: {response.status_code} - {response.text}")
            bot.send_message(call.message.chat.id, f"ስህተት ተፈጥሯል። (Code: {response.status_code})")

    except requests.exceptions.RequestException as e:
        logger.error(f"Withdraw decision failed: {e}")
        bot.send_message(call.message.chat.id, "ከሰርቨሩ ጋር መገናኘት አልተቻለም።")


def process_deposit_amount(message):
    if is_command(message):
        bot.clear_step_handler_by_chat_id(message.chat.id)
        bot.process_new_messages([message])
        return

    try:
        amount = float(message.text)
        if amount < 10:
            bot.send_message(
        message.chat.id, "❌ ዝቅተኛው የማስገቢያ መጠን 10 ብር ነው። እባክዎ ከ10 ብር በላይ ያስገቡ።")
            return

        user_id = str(message.from_user.id)
        username = message.from_user.username or message.from_user.first_name

        response = requests.post(
            f"{SERVER_URL}/deposit/request",
            json={"userId": user_id, "amount": amount},
            timeout=REQUEST_TIMEOUT
        )

        if response.status_code != 200:
            # ✅ ተስተካክሏል፦ ትክክለኛው status code እና response body log ውስጥ ይታያል
            # (bot_output.log ውስጥ ይመልከቱ)፣ ስለ ስህተቱ ትክክለኛ ምክንያት ለማወቅ
            logger.error(f"Deposit request failed: {response.status_code} - {response.text}")
            bot.send_message(
        message.chat.id, "❌ ጥያቄ መፍጠር አልተቻለም። እባክዎ እንደገና ይሞክሩ።")
            return

        order_id = response.json().get('orderId')

        bot.send_message(
            message.chat.id,
            f"1. ከታች ባለው የቴሌብር አካውንት {amount} ብር ያስገቡ\n\n"
            f"Phone: {TELEBIRR_NUMBER}\n\n"
            f"ከላኩ በኋላ ገንዘብዎ ይጨምርልዎታል።"
        )

        admin_markup = types.InlineKeyboardMarkup()
        admin_markup.add(
            types.InlineKeyboardButton("✅ Approve", callback_data=f"approve_{order_id}"),
            types.InlineKeyboardButton("❌ Reject", callback_data=f"reject_{order_id}"),
        )
        for admin_id in ADMIN_IDS:
            try:
                bot.send_message(
                    admin_id,
                    f"🔔 አዲስ የተቀማጭ ጥያቄ\n\n"
                    f"Order: #{order_id}\n"
                    f"User: @{username} (ID: {user_id})\n"
                    f"Amount: {amount} ብር\n\n"
                    f"ገንዘቡ በ Telebirr ({TELEBIRR_NUMBER}) መግባቱን አረጋግጠው ይምረጡ:",
                    reply_markup=admin_markup
                )
            except Exception as e:
                logger.error(f"Failed to notify admin {admin_id}: {e}")

    except ValueError:
        bot.send_message(
        message.chat.id, "❌ እባክዎ ትክክለኛ የቁጥር መጠን ብቻ ይላኩ (ለምሳሌ: 100)")
    except requests.exceptions.RequestException as e:
        logger.error(f"Server connection failed: {e}")
        bot.send_message(
        message.chat.id, "❌ ከሰርቨሩ ጋር መገናኘት አልተቻለም። እባክዎ ቆይተው ይሞክሩ።")


def handle_admin_decision(call, approve):
    admin_id = call.from_user.id

    if not is_admin(admin_id):
        bot.answer_callback_query(call.id, "⛔ ይህን የማድረግ ፍቃድ የለዎትም።", show_alert=True)
        return

    # ✅ ወዲያውኑ callback ን መልስ (backend request ከመላክ በፊት)፣
    # Render cold-start ቢዘገይ እንኳን "query too old" እንዳይሆን
    bot.answer_callback_query(call.id, "⏳ በመስራት ላይ...")

    order_id = call.data.split("_", 1)[1]
    endpoint = "confirm" if approve else "reject"

    try:
        response = requests.post(
            f"{SERVER_URL}/deposit/{endpoint}",
            json={"orderId": order_id, "adminId": str(admin_id)},
            headers=ADMIN_HEADERS,
            timeout=REQUEST_TIMEOUT
        )

        if response.status_code == 200:
            data = response.json()
            status_text = "✅ ጸድቋል" if approve else "❌ ውድቅ ተደርጓል"
            bot.edit_message_text(
                chat_id=call.message.chat.id,
                message_id=call.message.message_id,
                text=call.message.text + f"\n\n{status_text} በ @{call.from_user.username}"
            )

            user_id = data.get('userId')
            if approve:
                new_balance = data.get('balance')
                bot.send_message(
                    int(user_id),
                    f"✅ ተቀማጭዎ ጸድቋል! አዲሱ ሂሳብዎ: {new_balance} ብር ነው።"
                )
            else:
                bot.send_message(
                    int(user_id),
                    "❌ ተቀማጭዎ ውድቅ ተደርጓል። ለበለጠ መረጃ Support ያግኙ።"
                )
        elif response.status_code == 401 or response.status_code == 503:
            logger.error(f"Admin auth failed: {response.status_code} - {response.text}")
            bot.send_message(call.message.chat.id, "⛔ የአድሚን ማረጋገጫ (ADMIN_SECRET) ትክክል አይደለም ወይም አልተዘጋጀም።")
        elif response.status_code == 409:
            bot.send_message(call.message.chat.id, "ይህ ትዕዛዝ አስቀድሞ ተስተናግዷል።")
        else:
            logger.error(f"Admin decision failed: {response.status_code} - {response.text}")
            bot.send_message(call.message.chat.id, f"ስህተት ተፈጥሯል። (Code: {response.status_code})")

    except requests.exceptions.RequestException as e:
        logger.error(f"Admin decision failed: {e}")
        bot.send_message(call.message.chat.id, "ከሰርቨሩ ጋር መገናኘት አልተቻለም።")


if __name__ == '__main__':
    set_bot_commands()

    scheduler_thread = threading.Thread(target=run_scheduler, daemon=True)
    scheduler_thread.start()

    logger.info("Bot polling started...")
    bot.polling(none_stop=True)
