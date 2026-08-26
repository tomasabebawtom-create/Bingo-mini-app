import os
import telebot
from telebot import types
import requests
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
TOKEN = os.environ.get('TELEGRAM_BOT_TOKEN')

bot = telebot.TeleBot(TOKEN)

# የአድሚኖች Telegram user ID ዝርዝር - እነዚህ ብቻ ናቸው ተቀማጭ የሚያጸድቁት
# የራስህን ID ለማወቅ ቦቱ ላይ /myid ብቻ ላክ
ADMIN_IDS = [8706330167]  # <-- ካገኘህ በኋላ እዚህ ተካ
TELEBIRR_NUMBER = '0940501400'

# ✅ ተስተካክሏል፦ ወደ ትክክለኛው production backend (Render) ቀጥታ ይጠቁማል።
# ቀድሞ 'http://localhost:3000/api' ስለነበር ቦቱ ራሱን ብቻ ነበር የሚደውለው
# እና ምላሽ ስለማያገኝ REQUEST_TIMEOUT (15 ሰከንድ) ሙሉ ይጠብቅ ነበር -> ለዚህ ነው የዘገየው።
SERVER_URL = 'https://bingo-mini-app-1.onrender.com/api'

# ✅ ወርዷል፦ 15 -> 8 ሰከንድ። ሰርቨሩ ችግር ካለበት ቦቱ ፈጥኖ error ይመልሳል
# እንጂ ተጠቃሚው ረዥም ጊዜ "typing..." ብቻ አያይም።
REQUEST_TIMEOUT = 8

# Spin Win mini app URL — Render ላይ ቀጥታ (live) የተሰቀለው ገጽ
SPIN_WIN_URL = 'https://bingo-mini-app-1.onrender.com'


def main_menu():
    markup = types.InlineKeyboardMarkup(row_width=2)
    markup.add(
        types.InlineKeyboardButton("🎡 Play / Spin Win", web_app=types.WebAppInfo(SPIN_WIN_URL)),
        types.InlineKeyboardButton("Register 📝", callback_data="register"),
        types.InlineKeyboardButton("Check Balance 💵", callback_data="check_balance"),
        types.InlineKeyboardButton("Deposit 💵", callback_data="deposit"),
        types.InlineKeyboardButton("Contact Support ☎️", callback_data="support"),
        types.InlineKeyboardButton("Instruction 📖", callback_data="instruction"),
        types.InlineKeyboardButton("Transfer 🎁", callback_data="transfer"),
        types.InlineKeyboardButton("Withdraw 🤑", callback_data="withdraw"),
        types.InlineKeyboardButton("Invite 🔗", callback_data="invite"),
        types.InlineKeyboardButton("Convert Bonus 🎫", callback_data="convert_bonus"),
    )
    return markup


def is_admin(user_id):
    return user_id in ADMIN_IDS


@bot.message_handler(commands=['start'])
def send_welcome(message):
    text = "👋 እንኳን ደህና መጡ ወደ 1 Bingo! ከዚህ በታች ካሉት አማራጮች አንዱን ይምረጡ:-"
    bot.send_message(message.chat.id, text, reply_markup=main_menu())


@bot.message_handler(commands=['spin'])
def open_spin_win(message):
    """ልክ እንደ ቢንጎ /app ትዕዛዝ - Spin Win ገጹን በ WebApp ቁልፍ ይከፍታል"""
    markup = types.InlineKeyboardMarkup()
    markup.add(types.InlineKeyboardButton("🎡 Spin Win ክፈት", web_app=types.WebAppInfo(SPIN_WIN_URL)))
    bot.send_message(message.chat.id, "🎡 Spin Win ለመጫወት ከታች ይጫኑ፡", reply_markup=markup)


@bot.message_handler(commands=['myid'])
def send_my_id(message):
    """
    ራስህ የ Telegram user ID ለማወቅ - ADMIN_IDS ውስጥ ለማስገባት ይጠቅማል።
    ውጫዊ bot (@userinfobot) መጠቀም አያስፈልግም, ይህ ቦት ራሱ ያሳይሃል።
    """
    uid = message.from_user.id
    uname = message.from_user.username or "(username የለውም)"
    bot.reply_to(
        message,
        f"🆔 የ Telegram ID ያንተ: `{uid}`\n"
        f"👤 Username: @{uname}\n\n"
        f"ይህን ID bot.py ውስጥ ADMIN_IDS ላይ እና deposit-routes.js ውስጥ ADMIN_IDS ላይ ተካ።",
        parse_mode="Markdown"
    )


@bot.message_handler(commands=['confirm', 'reject'])
def confirm_or_reject_command(message):
    """
    አድሚን-ብቻ ትዕዛዝ፦ /confirm <order_id> ወይም /reject <order_id>
    አድሚኑ ገንዘቡ በስልኩ (Telebirr) ላይ በእጅ አረጋግጦ ይህን ትዕዛዝ ይልካል።
    ከ Approve/Reject ቁልፎቹ ጋር ተመሳሳይ ውጤት አለው - ተመሳሳይ ኤንድፖይንት ይጠቀማል።
    """
    admin_id = message.from_user.id

    if not is_admin(admin_id):
        bot.reply_to(message, "⛔ ይህን የማድረግ ፍቃድ የለዎትም።")
        return

    parts = message.text.split()
    if len(parts) != 2:
        bot.reply_to(message, "❌ አጠቃቀም: /confirm <order_id>  ወይም  /reject <order_id>")
        return

    order_id = parts[1]
    approve = message.text.startswith('/confirm')
    endpoint = "confirm" if approve else "reject"

    try:
        response = requests.post(
            f"{SERVER_URL}/deposit/{endpoint}",
            json={"orderId": order_id, "adminId": str(admin_id)},
            timeout=REQUEST_TIMEOUT
        )

        if response.status_code == 200:
            data = response.json()
            status_text = "✅ ጸድቋል" if approve else "❌ ውድቅ ተደርጓል"
            bot.reply_to(message, f"{status_text} — Order #{order_id}")

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
        elif response.status_code == 404:
            bot.reply_to(message, f"❌ Order #{order_id} አልተገኘም።")
        elif response.status_code == 409:
            bot.reply_to(message, "ይህ ትዕዛዝ አስቀድሞ ተስተናግዷል።")
        else:
            bot.reply_to(message, "ስህተት ተፈጥሯል።")

    except requests.exceptions.RequestException as e:
        logger.error(f"Admin command decision failed: {e}")
        bot.reply_to(message, "ከሰርቨሩ ጋር መገናኘት አልተቻለም።")


@bot.callback_query_handler(func=lambda call: True)
def callback_query(call):
    if call.data == "deposit":
        msg = bot.send_message(
            call.message.chat.id,
            "💳 የመቀማት (deposit) መጠን ብቻ ላክ (ለምሳሌ: 100)"
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
                bot.answer_callback_query(call.id, "ሂሳብ ማግኘት አልተቻለም።")
        except requests.exceptions.RequestException:
            bot.answer_callback_query(call.id, "ከሰርቨሩ ጋር መገናኘት አልተቻለም።")

    elif call.data == "withdraw":
        bot.answer_callback_query(call.id)
        msg = bot.send_message(
            call.message.chat.id,
            "🤑 የማውጣት (withdraw) መጠን ብቻ ላክ (ለምሳሌ: 100)"
        )
        bot.register_next_step_handler(msg, process_withdraw_amount)

    elif call.data in ("register", "support", "instruction", "transfer", "invite", "convert_bonus"):
        bot.answer_callback_query(call.id)
        labels = {
            "register": "📝 Register",
            "support": "☎️ Contact Support",
            "instruction": "📖 Instruction",
            "transfer": "🎁 Transfer",
            "invite": "🔗 Invite",
            "convert_bonus": "🎫 Convert Bonus",
        }
        bot.send_message(
            call.message.chat.id,
            f"{labels[call.data]}: ይህ ገፅ በቅርቡ ይጠናቀቃል። ለጥያቄ Contact Support ይጠቀሙ።"
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
    """
    መጠኑ ይመዘገባል፣ ቀጥሎ ገንዘብ የሚላክበትን ስልክ ቁጥር (Telebirr) እንዲልክ ተጠቃሚው ይጠየቃል።
    """
    try:
        amount = float(message.text)
        if amount <= 0:
            bot.reply_to(message, "❌ መጠኑ ከዜሮ በላይ መሆን አለበት።")
            return
    except ValueError:
        bot.reply_to(message, "❌ እባክዎ ትክክለኛ የቁጥር መጠን ብቻ ይላኩ (ለምሳሌ: 100)")
        return

    msg = bot.reply_to(
        message,
        "📱 ገንዘቡ የሚላክበትን የቴሌብር ስልክ ቁጥር ላክ (ለምሳሌ: 0912345678)"
    )
    bot.register_next_step_handler(msg, process_withdraw_phone, amount)


def process_withdraw_phone(message, amount):
    """
    ገንዘብ ወዲያውኑ ይቀነሳል (server.js /api/withdraw/request እንደዚያ ይሰራል) እና
    pending ትዕዛዝ ይፈጠራል። አድሚኑ Approve ካደረገ ገንዘቡ በ Telebirr ተልኳል ማለት ብቻ ነው
    (ቀሪ ሂሳብ ቀድሞውኑ ተቀንሷል)። Reject ካደረገ ግን ገንዘቡ ይመለሳል።
    """
    phone = message.text.strip()

    if not phone.isdigit() or len(phone) < 9:
        msg = bot.reply_to(
            message,
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
            err = response.json().get('error', 'ጥያቄ መፍጠር አልተቻለም።')
            bot.reply_to(message, f"❌ {err}")
            return

        data = response.json()
        order_id = data.get('orderId')
        new_balance = data.get('balance')

        bot.reply_to(
            message,
            f"⏱ የማውጣት ጥያቄዎ ተመዝግቧል (#{order_id})።\n"
            f"💰 አዲሱ ቀሪ ሂሳብዎ: {new_balance} ብር\n"
            f"📱 ገንዘቡ ወደ: {phone} ይላካል\n\n"
            f"አድሚን አረጋግጦ ገንዘቡን ወደ Telebirr ቁጥርዎ ይልካል።"
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
        bot.reply_to(message, "❌ ከሰርቨሩ ጋር መገናኘት አልተቻለም። እባክዎ ቆይተው ይሞክሩ።")


def handle_withdraw_decision(call, approve):
    admin_id = call.from_user.id

    if not is_admin(admin_id):
        bot.answer_callback_query(call.id, "⛔ ይህን የማድረግ ፍቃድ የለዎትም።", show_alert=True)
        return

    order_id = call.data.split("_", 1)[1]
    endpoint = "confirm" if approve else "reject"

    try:
        response = requests.post(
            f"{SERVER_URL}/withdraw/{endpoint}",
            json={"orderId": order_id, "adminId": str(admin_id)},
            timeout=REQUEST_TIMEOUT
        )

        if response.status_code == 200:
            data = response.json()
            status_text = "✅ ተልኳል" if approve else "❌ ውድቅ ተደርጓል (ገንዘብ ተመልሷል)"
            bot.answer_callback_query(call.id, status_text)
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
        elif response.status_code == 409:
            bot.answer_callback_query(call.id, "ይህ ትዕዛዝ አስቀድሞ ተስተናግዷል።", show_alert=True)
        else:
            bot.answer_callback_query(call.id, "ስህተት ተፈጥሯል።", show_alert=True)

    except requests.exceptions.RequestException as e:
        logger.error(f"Withdraw decision failed: {e}")
        bot.answer_callback_query(call.id, "ከሰርቨሩ ጋር መገናኘት አልተቻለም።", show_alert=True)


def process_deposit_amount(message):
    """
    ገንዘብ አይጨመርም! "pending" ትዕዛዝ ብቻ ይፈጠራል። ገንዘቡ የሚጨመረው አድሚኑ
    (ከታች handle_admin_decision) Approve ሲጫን ብቻ ነው።
    """
    try:
        amount = float(message.text)
        if amount <= 0:
            bot.reply_to(message, "❌ መጠኑ ከዜሮ በላይ መሆን አለበት።")
            return

        user_id = str(message.from_user.id)
        username = message.from_user.username or message.from_user.first_name

        response = requests.post(
            f"{SERVER_URL}/deposit/request",
            json={"userId": user_id, "amount": amount},
            timeout=REQUEST_TIMEOUT
        )

        if response.status_code != 200:
            bot.reply_to(message, "❌ ጥያቄ መፍጠር አልተቻለም። እባክዎ እንደገና ይሞክሩ።")
            return

        order_id = response.json().get('orderId')

        bot.reply_to(
            message,
            f"⏱ ጥያቄዎ ተመዝግቧል (#{order_id})።\n\n"
            f"💳 {amount} ብር ወደዚህ Telebirr ቁጥር ይላኩ:\n"
            f"📱 {TELEBIRR_NUMBER}\n\n"
            f"ከላኩ በኋላ አድሚን አረጋግጦ ገንዘብዎን ይጨምርልዎታል።"
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
        bot.reply_to(message, "❌ እባክዎ ትክክለኛ የቁጥር መጠን ብቻ ይላኩ (ለምሳሌ: 100)")
    except requests.exceptions.RequestException as e:
        logger.error(f"Server connection failed: {e}")
        bot.reply_to(message, "❌ ከሰርቨሩ ጋር መገናኘት አልተቻለም። እባክዎ ቆይተው ይሞክሩ።")


def handle_admin_decision(call, approve):
    admin_id = call.from_user.id

    if not is_admin(admin_id):
        bot.answer_callback_query(call.id, "⛔ ይህን የማድረግ ፍቃድ የለዎትም።", show_alert=True)
        return

    order_id = call.data.split("_", 1)[1]
    endpoint = "confirm" if approve else "reject"

    try:
        response = requests.post(
            f"{SERVER_URL}/deposit/{endpoint}",
            json={"orderId": order_id, "adminId": str(admin_id)},
            timeout=REQUEST_TIMEOUT
        )

        if response.status_code == 200:
            data = response.json()
            status_text = "✅ ጸድቋል" if approve else "❌ ውድቅ ተደርጓል"
            bot.answer_callback_query(call.id, status_text)
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
        elif response.status_code == 409:
            bot.answer_callback_query(call.id, "ይህ ትዕዛዝ አስቀድሞ ተስተናግዷል።", show_alert=True)
        else:
            bot.answer_callback_query(call.id, "ስህተት ተፈጥሯል።", show_alert=True)

    except requests.exceptions.RequestException as e:
        logger.error(f"Admin decision failed: {e}")
        bot.answer_callback_query(call.id, "ከሰርቨሩ ጋር መገናኘት አልተቻለም።", show_alert=True)


if __name__ == '__main__':
    logger.info("Bot polling started...")
    bot.polling(none_stop=True)
