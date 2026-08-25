import telebot
from telebot import types
import requests
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

TOKEN = 'YOUR_TELEGRAM_BOT_TOKEN'
bot = telebot.TeleBot(TOKEN)

# የአድሚኖች Telegram user ID ዝርዝር - እነዚህ ብቻ ናቸው ተቀማጭ የሚያጸድቁት
ADMIN_IDS = [123456789]  # <-- እዚህ የራስዎን ትክክለኛ ID ያስገቡ
TELEBIRR_NUMBER = '0940501400'

SERVER_URL = 'http://localhost:3000/api'
REQUEST_TIMEOUT = 15


def main_menu():
    markup = types.InlineKeyboardMarkup(row_width=2)
    markup.add(
        types.InlineKeyboardButton("Play 🎮", callback_data="play"),
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


@bot.message_handler(commands=['myid'])
def send_my_id(message):
    uid = message.from_user.id
    uname = message.from_user.username or "(username የለውም)"
    bot.reply_to(
        message,
        f"🆔 የ Telegram ID ያንተ: `{uid}`\n"
        f"👤 Username: @{uname}\n\n"
        f"ይህን ID bot.py ውስጥ ADMIN_IDS ላይ ተካ።",
        parse_mode="Markdown"
    )


# ==========================================
# 1. WITHDRAW (ገንዘብ ማውጣት) ትእዛዝ እና አሰራር
# ==========================================
@bot.message_handler(commands=['withdraw'])
def withdraw_command_handler(message):
    """
    ተጠቃሚው: /withdraw <መጠን> <telebirr ቁጥር> ብሎ ሲልክ የሚሰራ
    """
    parts = message.text.split()
    if len(parts) != 3:
        bot.reply_to(
            message,
            "⚠️ አጠቃቀም ስህተት ነው!\n"
            "አጠቃቀም: `/withdraw <መጠን> <telebirr ቁጥር>`\n"
            "ምሳሌ: `/withdraw 100 0912345678`",
            parse_mode="Markdown"
        )
        return

    try:
        amount = float(parts[1])
        phone = parts[2]
        user_id = str(message.from_user.id)
        username = message.from_user.username or message.from_user.first_name

        if amount <= 0:
            bot.reply_to(message, "❌ የማውጣት መጠኑ ከዜሮ በላይ መሆን አለበት።")
            return

        # ሰርቨር ላይ የwithdraw ጥያቄ መላክ (ቀሪ ሂሳብ በቂ መሆኑን ሰርቨሩ ያረጋግጣል)
        response = requests.post(
            f"{SERVER_URL}/withdraw/request",
            json={"userId": user_id, "amount": amount, "phone": phone},
            timeout=REQUEST_TIMEOUT
        )

        if response.status_code == 200:
            data = response.json()
            remaining_balance = data.get('balance')
            bot.reply_to(
                message,
                f"⏱ የገንዘብ ማውጣት (Withdraw) ጥያቄዎ ተመዝግቧል!\n\n"
                f"💸 መጠን: {amount} ብር\n"
                f"📱 ቴሌብር: {phone}\n"
                f"💰 ቀሪ ሒሳብዎ: {remaining_balance} ብር\n\n"
                f"አድሚኑ ሲያረጋግጠው ወደ ስልክዎ ይላካል።"
            )
            # ለድሚኖች ማሳወቂያ መላክ ከፈለጉ እዚህ ጋር ማካተት ይቻላል
        elif response.status_code == 400:
            bot.reply_to(message, "❌ በቂ ሒሳብ የለዎትም ወይም የተሳሳተ መረጃ ነው።")
        else:
            bot.reply_to(message, "❌ ጥያቄውን ማስኬድ አልተቻለም። እባክዎ ቆይተው እንደገና ይሞክሩ።")

    except ValueError:
        bot.reply_to(message, "❌ እባክዎ ትክክለኛ የቁጥር መጠን ያስገቡ (ምሳሌ: /withdraw 100 0912345678)")
    except requests.exceptions.RequestException as e:
        logger.error(f"Withdraw connection failed: {e}")
        bot.reply_to(message, "❌ ከሰርቨሩ ጋር መገናኘት አልተቻለም።")


@bot.message_handler(commands=['confirm', 'reject'])
def confirm_or_reject_command(message):
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

    elif call.data == "withdraw":
        bot.answer_callback_query(call.id)
        bot.send_message(
            call.message.chat.id,
            "💸 ገንዘብ ለማውጣት የሚከተለውን ትእዛዝ ይጠቀሙ፦\n\n"
            "`/withdraw <መጠን> <telebirr ቁጥር>`\n"
            "ምሳሌ፦ `/withdraw 100 0912345678`",
            parse_mode="Markdown"
        )

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

    elif call.data.startswith("approve_"):
        handle_admin_decision(call, approve=True)
    elif call.data.startswith("reject_"):
        handle_admin_decision(call, approve=False)


def process_deposit_amount(message):
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


# ==========================================
# 2. የጨዋታ ውጤት ማስተካከያ (Win / Loss Logic)
# ==========================================
def update_game_score_on_server(user_id, bet_amount, won):
    """
    ተጠቃሚው ሲያሸንፍ (won=True) ሂሳቡ ይጨምራል፣
    ሲሸነፍ (won=False) የተወራረደበት ገንዘብ ከቀሪ ሂሳቡ ይቀነሳል።
    ይህንን ፈንክሽን ሚኒ-ጌሙ (Spin & Win) ውጤት ሲወጣ መጠቀሙ በቂ ነው።
    """
    try:
        response = requests.post(
            f"{SERVER_URL}/game/result",
            json={"userId": str(user_id), "betAmount": bet_amount, "won": won},
            timeout=REQUEST_TIMEOUT
        )
        if response.status_code == 200:
            return response.json()
    except requests.exceptions.RequestException as e:
        logger.error(f"Game result update failed: {e}")
    return None


if __name__ == '__main__':
    logger.info("Bot polling started...")
    bot.polling(none_stop=True)
