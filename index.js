require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

/* ================= DATABASE ================= */

mongoose.connect(process.env.MONGO_URI);

const fileSchema = new mongoose.Schema({
  userId: Number,
  code: String,
  messages: Array,
  createdAt: { type: Date, default: Date.now }
});

const Files = mongoose.model("Files", fileSchema);

/* ================= BOT SETUP ================= */

const bot = new Telegraf(process.env.BOT_TOKEN);
const backupBot = new Telegraf(process.env.BOT_TOKEN_BACKUP);

const FORCE_CHANNEL = process.env.FORCE_CHANNEL;
const STORAGE_CHANNEL = process.env.STORAGE_CHANNEL_ID;

const userUploads = {};
const floodControl = {};

/* ================= SAFE SEND ================= */

async function safeCopy(chatId, messageId) {
  try {
    return await bot.telegram.copyMessage(
      chatId,
      STORAGE_CHANNEL,
      messageId
    );
  } catch (e) {
    console.log("Main bot failed, switching...");
    return await backupBot.telegram.copyMessage(
      chatId,
      STORAGE_CHANNEL,
      messageId
    );
  }
}

/* ================= FORCE JOIN ================= */

async function isJoined(ctx) {
  try {
    const member = await ctx.telegram.getChatMember(
      FORCE_CHANNEL,
      ctx.from.id
    );
    return ["member", "creator", "administrator"].includes(member.status);
  } catch {
    return false;
  }
}

/* ================= START ================= */

async function startHandler(ctx) {
  const code = ctx.startPayload;

  if (code) {
    const data = await Files.findOne({ code });
    if (!data) return ctx.reply("❌ Code tidak ditemukan");

    return sendFiles(ctx, data.messages);
  }

  const joined = await isJoined(ctx);
  if (!joined) {
    return ctx.reply(
      "⚠️ Join channel dulu",
      Markup.inlineKeyboard([
        Markup.button.url(
          "Join Channel",
          `https://t.me/${FORCE_CHANNEL.replace("@", "")}`
        )
      ])
    );
  }

  ctx.reply(
    "📦 Storage Bot ULTRA",
    Markup.keyboard([["Upload"]]).resize()
  );
}

bot.start(startHandler);
backupBot.start(startHandler);

/* ================= FLOOD CONTROL ================= */

function checkFlood(userId) {
  const now = Date.now();

  if (!floodControl[userId]) {
    floodControl[userId] = [];
  }

  floodControl[userId] = floodControl[userId].filter(
    (time) => now - time < 60000
  );

  if (floodControl[userId].length >= 20) return false;

  floodControl[userId].push(now);
  return true;
}

/* ================= UPLOAD ================= */

bot.hears("Upload", (ctx) => {
  userUploads[ctx.from.id] = [];
  ctx.reply("📤 Kirim file sekarang. Max 20 file/menit.");
});

bot.on(["video", "document"], async (ctx) => {
  if (!userUploads[ctx.from.id]) return;

  if (!checkFlood(ctx.from.id)) {
    return ctx.reply("⚠️ Terlalu banyak upload! Tunggu 1 menit.");
  }

  const forward = await ctx.forwardMessage(
    STORAGE_CHANNEL,
    ctx.chat.id,
    ctx.message.message_id
  );

  userUploads[ctx.from.id].push(forward.message_id);

  ctx.reply(
    `✅ File disimpan\nTotal: ${userUploads[ctx.from.id].length}`,
    Markup.inlineKeyboard([
      Markup.button.callback("CREATE", "create_files")
    ])
  );
});

/* ================= CREATE ================= */

bot.action("create_files", async (ctx) => {
  const files = userUploads[ctx.from.id];
  if (!files || files.length === 0)
    return ctx.answerCbQuery("Belum ada file");

  const code = uuidv4().slice(0, 8);

  await Files.create({
    userId: ctx.from.id,
    code,
    messages: files
  });

  delete userUploads[ctx.from.id];

  const link1 = `https://t.me/${bot.botInfo.username}?start=${code}`;
  const link2 = `https://t.me/${backupBot.botInfo.username}?start=${code}`;

  ctx.reply(
`✅ BERHASIL

🔑 Code:
${code}

🔗 Bot 1:
${link1}

🔗 Bot 2:
${link2}`
  );
});

/* ================= SEND FILES ================= */

async function sendFiles(ctx, messages) {
  for (let msgId of messages) {
    await safeCopy(ctx.chat.id, msgId);
  }
}

/* ================= CODE MANUAL ================= */

bot.hears(/^[a-zA-Z0-9]{8}$/, async (ctx) => {
  const data = await Files.findOne({ code: ctx.message.text });
  if (!data) return ctx.reply("❌ Code salah");

  sendFiles(ctx, data.messages);
});

/* ================= LAUNCH ================= */

bot.launch();
backupBot.launch();

console.log("ULTRA BOT RUNNING");
