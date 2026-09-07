import { Telegraf, Markup } from "telegraf";
import * as dotenv from "dotenv";
import { userData, userStep } from "./state";

dotenv.config();

const bot = new Telegraf(process.env.BOT_TOKEN!);

const services = [
  "Service 1",
  "Service 2",
  "Service 3",
  "Service 4",
];

// start command 
bot.start(async (ctx) => {
  await ctx.reply(
    "Welcome 👋\n\nPlease choose a service:",
    Markup.keyboard(services.map((s) => [s]))
      .oneTime()
      .resize()
  );
});

// Handle service selection

bot.hears(services, async (ctx) => {
  const userId = ctx.from.id;

  userData.set(userId, {
    service: ctx.message.text,
  });

  userStep.set(userId, "waiting_name");

  await ctx.reply("Please enter your full name:");
});

// Handle name input
bot.on("text", async (ctx, next) => {
  const userId = ctx.from.id;

  if (userStep.get(userId) !== "waiting_name") {
    return next();
  }

  const data = userData.get(userId)!;

  data.name = ctx.message.text;

  userData.set(userId, data);
  userStep.set(userId, "waiting_phone");

  await ctx.reply("Please enter your phone number:");
});

// Handle phone number input
bot.on("text", async (ctx, next) => {
  const userId = ctx.from.id;

  if (userStep.get(userId) !== "waiting_phone") {
    return next();
  }

  const data = userData.get(userId)!;

  data.phone = ctx.message.text;

  userData.set(userId, data);
  userStep.set(userId, "waiting_receipt");

  await ctx.reply(`
💳 Payment Instructions

Bank: CBE
Account: 1000000

After payment, please upload your receipt.
`);
});


// Handle receipt upload
bot.on("photo", async (ctx) => {
  const userId = ctx.from.id;

  if (userStep.get(userId) !== "waiting_receipt") {
    return;
  }

  const data = userData.get(userId);

  const caption = `
🔔 NEW REQUEST

Service: ${data?.service}
Name: ${data?.name}
Phone: ${data?.phone}

Telegram: @${ctx.from.username || "No Username"}
`;

  await ctx.telegram.sendMessage(
    process.env.ADMIN_GROUP_ID!,
    caption
  );

  const photo =
    ctx.message.photo[ctx.message.photo.length - 1];

  await ctx.telegram.sendPhoto(
    process.env.ADMIN_GROUP_ID!,
    photo.file_id
  );

  await ctx.reply(
    "✅ Receipt received. Our team will review it."
  );

  userData.delete(userId);
  userStep.delete(userId);
});

bot.launch();

console.log("Bot started...");