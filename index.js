require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const { v4: uuidv4 } = require("uuid");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const bot = new Telegraf(process.env.BOT_TOKEN);
const backupBot = new Telegraf(process.env.BOT_TOKEN_BACKUP);

const FORCE_CHANNEL = process.env.FORCE_CHANNEL;
const STORAGE_CHANNEL = process.env.STORAGE_CHANNEL_ID;

const userUploads = {};
const floodControl = {};

/* ================== INIT TABLE ================== */
(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS files (
      id SERIAL PRIMARY KEY,
      user_id BIGINT,
      code TEXT,
      messages TEXT,
      total_size BIGINT,
      total_files INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
})();

/* ================== FLOOD CONTROL ================== */
function checkFlood(userId) {
  const now = Date.now();
  if (!floodControl[userId]) floodControl[userId] = [];
  floodControl[userId] = floodControl[userId].filter(t => now - t < 60000);
  if (floodControl[userId].length >= 20) return false;
  floodControl[userId].push(now);
  return true;
}

/* ================== FORCE JOIN ================== */
async function isJoined(ctx) {
  try {
    const member = await ctx.telegram.getChatMember(FORCE_CHANNEL, ctx.from.id);
    return ["member", "administrator", "creator"].includes(member.status);
  } catch {
    return false;
  }
}

/* ================== START ================== */
async function startHandler(ctx) {
  const code = ctx.startPayload;

  if (code) {
    const result = await pool.query("SELECT * FROM files WHERE code=$1", [code]);
    if (!result.rows.length) return ctx.reply("❌ Code tidak ditemukan");

    return sendPagination(ctx, result.rows[0], 0);
  }

  const joined = await isJoined(ctx);
  if (!joined) {
    return ctx.reply(
      "⚠️ Wajib join channel dulu",
      Markup.inlineKeyboard([
        Markup.button.url(
          "Join Channel",
          `https://t.me/${FORCE_CHANNEL.replace("@", "")}`
        )
      ])
    );
  }

  ctx.reply(
    "📦 STORAGE BOT",
    Markup.keyboard([
      ["Upload"],
      ["MyCode", "MyAccount"]
    ]).resize()
  );
}

bot.start(startHandler);
backupBot.start(startHandler);

/* ================== UPLOAD ================== */
bot.hears("Upload", (ctx) => {
  userUploads[ctx.from.id] = {
    messages: [],
    totalSize: 0,
    startTime: Date.now()
  };
  ctx.reply("📤 Kirim semua file/video sekarang.\nTekan CREATE jika sudah selesai.");
});

bot.on(["video", "document"], async (ctx) => {
  if (!userUploads[ctx.from.id]) return;
  if (!checkFlood(ctx.from.id))
    return ctx.reply("⚠️ Terlalu banyak upload! Tunggu 1 menit.");

  const media = ctx.message.video || ctx.message.document;
  const forward = await ctx.forwardMessage(
    STORAGE_CHANNEL,
    ctx.chat.id,
    ctx.message.message_id
  );

  userUploads[ctx.from.id].messages.push(forward.message_id);
  userUploads[ctx.from.id].totalSize += media.file_size || 0;

  const totalFiles = userUploads[ctx.from.id].messages.length;
  const totalSizeMB = (userUploads[ctx.from.id].totalSize / 1024 / 1024).toFixed(2);
  const seconds = Math.floor((Date.now() - userUploads[ctx.from.id].startTime) / 1000);

  ctx.reply(
    `✅ Progress Upload
📁 Total File: ${totalFiles}
💾 Total Size: ${totalSizeMB} MB
⏱ Waktu: ${seconds} detik`,
    Markup.inlineKeyboard([
      Markup.button.callback("CREATE", "create_files")
    ])
  );
});

/* ================== CREATE ================== */
bot.action("create_files", async (ctx) => {
  const data = userUploads[ctx.from.id];
  if (!data || !data.messages.length)
    return ctx.answerCbQuery("Belum ada file");

  const code = uuidv4().slice(0, 8);

  await pool.query(
    "INSERT INTO files (user_id, code, messages, total_size, total_files) VALUES ($1,$2,$3,$4,$5)",
    [
      ctx.from.id,
      code,
      JSON.stringify(data.messages),
      data.totalSize,
      data.messages.length
    ]
  );

  delete userUploads[ctx.from.id];

  const link1 = `https://t.me/${bot.botInfo.username}?start=${code}`;
  const link2 = `https://t.me/${backupBot.botInfo.username}?start=${code}`;

  ctx.reply(
`✅ BERHASIL DIBUAT

🔑 Code: ${code}

🔗 Bot 1:
${link1}

🔗 Bot 2:
${link2}`
  );
});

/* ================== PAGINATION ================== */
async function sendPagination(ctx, row, page) {
  const messages = JSON.parse(row.messages);
  const perPage = 10;
  const totalPages = Math.ceil(messages.length / perPage);
  const start = page * perPage;
  const chunk = messages.slice(start, start + perPage);

  for (let msgId of chunk) {
    await safeCopy(ctx.chat.id, msgId);
  }

  const buttons = [];
  if (page > 0)
    buttons.push(Markup.button.callback("⬅ Prev", `page_${row.code}_${page-1}`));
  if (page < totalPages - 1)
    buttons.push(Markup.button.callback("Next ➡", `page_${row.code}_${page+1}`));

  buttons.push(
    Markup.button.url(
      "Join Channel",
      `https://t.me/${FORCE_CHANNEL.replace("@","")}`
    )
  );

  ctx.reply(
    `📄 Page ${page+1}/${totalPages}`,
    Markup.inlineKeyboard(buttons, { columns: 2 })
  );
}

bot.action(/page_(.+)_(\d+)/, async (ctx) => {
  const code = ctx.match[1];
  const page = parseInt(ctx.match[2]);

  const result = await pool.query("SELECT * FROM files WHERE code=$1",[code]);
  if (!result.rows.length) return;

  sendPagination(ctx, result.rows[0], page);
});

/* ================== SAFE COPY (AUTO SWITCH) ================== */
async function safeCopy(chatId, msgId) {
  try {
    return await bot.telegram.copyMessage(chatId, STORAGE_CHANNEL, msgId);
  } catch {
    return await backupBot.telegram.copyMessage(chatId, STORAGE_CHANNEL, msgId);
  }
}

/* ================== CODE MANUAL ================== */
bot.hears(/^[a-zA-Z0-9]{8}$/, async (ctx) => {
  const result = await pool.query(
    "SELECT * FROM files WHERE code=$1",
    [ctx.message.text]
  );
  if (!result.rows.length) return ctx.reply("❌ Code salah");

  sendPagination(ctx, result.rows[0], 0);
});

bot.launch();
backupBot.launch();

console.log("FINAL STORAGE BOT RUNNING");
